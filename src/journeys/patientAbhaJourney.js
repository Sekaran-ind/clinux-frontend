// Patient ABHA journey (ABDM M1): staff at the clinic find, link or create a patient's ABHA and
// record it on that patient. A JSON journey (specs/abha.journey.json) run by the XState engine
// (engine.js), like the HPR/HFR journeys, and modelled on cubo-diary's own ABHA journey, but from
// the clinic's side: it calls the gateway's staff /abha routes (authorised by the ClinuxFlow
// session), not cubo-diary's citizen /citizen/abha routes.
//
//   pickPatient -> mode --find---> findMobile -> pickMatch -> findOtp ----------------> confirm -> done
//                       --number-> numberLogin -> numberOtp -> profile --------------> confirm
//                       --create-> aadhaar -> aadhaarOtp --mobile matched--------------> address
//                                                        --not matched-> mobileOtp ---> address -> confirm
//
// The gateway calls and bodies are the ones PatientAbhaPanel.vue already makes live (find by
// mobile: doc §7.6.1; login: doc §7; enrolment by Aadhaar: doc §3). An Aadhaar number or OTP
// arrives only as state.answer and is cleared by the node that sends it; nothing secret is
// stored. The per-user ABHA token stays in this run's memory and goes when the run ends.
import spec from './specs/abha.journey.json' with { type: 'json' };
import { afterSend, resendState } from './hprConsent.js';

const now = (d) => (d.now ? d.now() : Date.now());
const post = (gateway, path, body, headers) => gateway(path, { method: 'POST', body, headers });

// Scopes per login variant (gateway src/routes/abha.js's own table).
export const FIND_SCOPE = ['abha-login', 'search-abha', 'mobile-verify'];
export const NUMBER_METHODS = [
    { value: 'aadhaar', label: 'OTP to the mobile linked to their Aadhaar', scope: ['abha-login', 'aadhaar-verify'] },
    { value: 'abdm', label: 'OTP to the mobile linked to their ABHA', scope: ['abha-login', 'mobile-verify'] },
];
const scopeFor = (otpSystem) => NUMBER_METHODS.find((m) => m.value === otpSystem)?.scope ?? NUMBER_METHODS[0].scope;

const ABHA_NUMBER = /^\d{2}-?\d{4}-?\d{4}-?\d{4}$/;
const AADHAAR = /^(\d{12}|\d{16})$/; // 12-digit Aadhaar or 16-digit Virtual ID
export const NEW_PATIENT = '__new';

const GENDER = { M: 'male', F: 'female', O: 'other', T: 'other' };

/** dd-mm-yyyy (enrolment) or separate day/month/year (profile) -> yyyy-mm-dd. */
export function birthDate(p = {}) {
    const pad = (n) => String(n).padStart(2, '0');
    if (p.dob && /^\d{2}-\d{2}-\d{4}$/.test(p.dob)) {
        const [dd, mm, yyyy] = p.dob.split('-');
        return `${yyyy}-${mm}-${dd}`;
    }
    if (p.yearOfBirth && p.monthOfBirth && p.dayOfBirth) return `${p.yearOfBirth}-${pad(p.monthOfBirth)}-${pad(p.dayOfBirth)}`;
    return p.dateOfBirth || undefined;
}

/** ABDM's profile shapes (enrolment ABHAProfile, login account, GET /profile) -> one person. */
export function abhaPerson(raw = {}, extra = {}) {
    const name = raw.name || [raw.firstName, raw.middleName, raw.lastName].filter(Boolean).join(' ');
    const address = raw.preferredAbhaAddress || raw.abhaAddress || (Array.isArray(raw.phrAddress) ? raw.phrAddress[0] : raw.phrAddress);
    return {
        abhaNumber: raw.ABHANumber || raw.abhaNumber || extra.abhaNumber,
        abhaAddress: address || extra.abhaAddress,
        name: name || extra.name || '',
        firstName: raw.firstName || (name ? name.split(' ')[0] : ''),
        lastName: raw.lastName || (name ? name.split(' ').slice(1).join(' ') : ''),
        gender: GENDER[raw.gender] || raw.gender,
        birthDate: birthDate(raw),
        mobile: raw.mobile || extra.mobile,
    };
}

const mask = (v = '') => (String(v).length > 4 ? `••••${String(v).slice(-4)}` : v);

function resendRefusal(st, t) {
    if (st.blockedUntil) return `The OTP was resent too often. Try again after ${new Date(st.blockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    return `You can ask for a new OTP ${Math.max(1, Math.ceil((st.availableAt - t) / 1000))} s after the last one.`;
}

const otpField = { name: 'otp', label: 'OTP', inputmode: 'numeric', pattern: '^\\d{6}$', secret: true, required: true };

// The journey: its JSON (steps and transitions) plus the named handlers below, run by engine.js
// on XState. id/title/summary/icon come from the JSON.
export const patientAbhaJourney = {
    spec,
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    icon: spec.icon,

    prompts: {
        pickPatient: (s) => ({
            text: 'Whose ABHA is this for?',
            fields: [{
                name: 'patientId', label: 'Patient', type: 'select', required: true, value: s.data.patientId || '',
                options: [{ value: NEW_PATIENT, label: '+ A new patient (create the record from their ABHA)' }, ...(s.data.patients || [])],
            }],
            submitLabel: 'Continue',
        }),
        mode: (s) => ({
            text: `How would you like to set up ${s.data.patientName ? s.data.patientName + '’s' : 'the patient’s'} ABHA?`,
            choices: [
                { value: 'find', label: 'Find their ABHA by mobile', detail: 'They may already have one. ABDM sends an OTP to that mobile.' },
                { value: 'number', label: 'They know their ABHA number', detail: 'Verify it with an OTP' },
                { value: 'create', label: 'Create a new ABHA with Aadhaar', detail: 'Aadhaar OTP, then their mobile and ABHA address' },
            ],
        }),
        findMobile: () => ({
            text: 'Which mobile number might their ABHA be registered with?',
            fields: [
                { name: 'mobile', label: 'Mobile number', inputmode: 'tel', pattern: '^[6-9]\\d{9}$', hint: '10 digits', mask: 'last4', required: true },
                { name: 'consent', label: 'The patient agrees to search ABDM for their ABHA with this number.', type: 'checkbox', required: true },
            ],
            submitLabel: 'Search',
        }),
        pickMatch: (s) => ({
            text: `ABDM found ${s.data.matches.length} ABHA account${s.data.matches.length === 1 ? '' : 's'} for that number. Which one is the patient’s?`,
            detail: 'ABDM shows only part of each account. Picking one sends an OTP to the mobile.',
            choices: s.data.matches.map((m) => ({ value: String(m.index), label: m.name || 'ABHA account', detail: [m.abhaNumber, m.gender, m.kycVerified ? 'KYC verified' : null].filter(Boolean).join(' · ') })),
        }),
        findOtp: (s, d) => ({
            text: s.data.message || 'Enter the OTP ABDM sent to that mobile.',
            ...(s.data.resent ? { detail: 'A new OTP has been sent.' } : {}),
            fields: [otpField],
            resend: resendState(s.data.sends, now(d)),
            submitLabel: 'Verify',
        }),
        numberLogin: () => ({
            text: 'Enter the patient’s ABHA number. ABDM sends an OTP to verify it.',
            fields: [
                { name: 'abhaNumber', label: 'ABHA number', hint: '14 digits, e.g. 91-1234-5678-9012', pattern: ABHA_NUMBER.source, required: true },
                { name: 'otpSystem', label: 'Send the OTP to', type: 'select', options: NUMBER_METHODS.map(({ value, label }) => ({ value, label })), value: 'aadhaar', required: true },
                { name: 'consent', label: 'The patient agrees to send their ABHA number to ABDM to verify it.', type: 'checkbox', required: true },
            ],
            submitLabel: 'Send OTP',
        }),
        numberOtp: (s, d) => ({
            text: s.data.message || 'Enter the OTP ABDM sent.',
            ...(s.data.resent ? { detail: 'A new OTP has been sent.' } : {}),
            fields: [otpField],
            resend: resendState(s.data.sends, now(d)),
            submitLabel: 'Verify',
        }),
        aadhaar: () => ({
            text: 'Creating an ABHA starts with the patient’s Aadhaar. UIDAI sends an OTP to the mobile linked to it.',
            detail: 'The Aadhaar number goes to ABDM through ClinuxFlow’s gateway and is not stored.',
            fields: [
                { name: 'aadhaar', label: 'Aadhaar number or Virtual ID', inputmode: 'numeric', pattern: AADHAAR.source, hint: '12 digits (or 16-digit VID)', secret: true, required: true },
                { name: 'consent', label: 'The patient consents to create an ABHA with their Aadhaar (ABDM enrolment consent v1.4).', type: 'checkbox', required: true },
            ],
            submitLabel: 'Send Aadhaar OTP',
        }),
        aadhaarOtp: (s) => ({
            text: s.data.message || 'Enter the OTP from UIDAI, and the mobile number the ABHA should use.',
            detail: 'If that mobile isn’t the one on their Aadhaar, ABDM verifies it with its own OTP next.',
            fields: [
                otpField,
                { name: 'mobile', label: 'Mobile for the ABHA', inputmode: 'tel', pattern: '^[6-9]\\d{9}$', hint: '10 digits', mask: 'last4', value: s.data.patientMobile || '', required: true },
            ],
            submitLabel: 'Create ABHA',
        }),
        mobileOtp: (s, d) => ({
            text: `That mobile isn’t the one on their Aadhaar, so ABDM sent ${mask(s.data.mobile)} an OTP.`,
            ...(s.data.resent ? { detail: 'A new OTP has been sent.' } : {}),
            fields: [otpField],
            resend: resendState(s.data.sends, now(d)),
            submitLabel: 'Verify mobile',
        }),
        address: (s) => ({
            text: `ABHA ${s.data.person.abhaNumber} is created. Choose the patient’s ABHA address, or keep ${s.data.person.abhaAddress || 'the default'}.`,
            fields: [
                ...(s.data.suggestions?.length ? [{ name: 'suggestion', label: 'Suggested addresses', type: 'select', options: s.data.suggestions.map((a) => ({ value: a, label: `${a}@sbx` })), value: '' }] : []),
                { name: 'custom', label: 'Or type one', placeholder: 'e.g. asha.rao', hint: 'Letters, digits, dot or underscore; @sbx is added' },
                { name: 'keep', label: `Keep ${s.data.person.abhaAddress || 'the default address'}`, type: 'checkbox' },
            ],
            submitLabel: 'Continue',
        }),
        confirm: (s) => {
            const p = s.data.person;
            return {
                text: s.data.patientId === NEW_PATIENT
                    ? `Create a patient record for ${p.name || 'this person'} with ABHA ${p.abhaNumber || p.abhaAddress}?`
                    : `Record ABHA ${p.abhaNumber || p.abhaAddress} (${p.name}) on ${s.data.patientName}’s record?`,
                ...(s.data.nameMismatch ? { warning: `The name on this ABHA (${p.name}) doesn’t look like ${s.data.patientName}. Only record it if it really is theirs.` } : {}),
                list: [
                    ...(p.abhaNumber ? [{ name: 'ABHA number', detail: p.abhaNumber }] : []),
                    ...(p.abhaAddress ? [{ name: 'ABHA address', detail: p.abhaAddress }] : []),
                    ...(p.gender ? [{ name: 'Gender', detail: p.gender }] : []),
                    ...(p.birthDate ? [{ name: 'Date of birth', detail: p.birthDate }] : []),
                ],
                choices: [
                    { value: 'save', label: s.data.patientId === NEW_PATIENT ? 'Create the patient record' : 'Record it on the patient', detail: 'Fills in ABHA number and address, and any blank name, gender, date of birth or mobile' },
                    { value: 'no', label: 'Don’t record it' },
                ],
            };
        },
    },

    // The step handlers the journey JSON names (specs/<id>.journey.json). Same bodies as the
    // LangGraph nodes they replace: an ask's (answer, state, deps), an auto/final's (state, deps).
    actions: {
        // begin
        loadPatients: async (s, d) => {
                const patients = await d.patients.list();
                const preset = s.data.patientId && patients.find((p) => p.value === s.data.patientId);
                return { data: { patients, ...(preset ? { patientName: preset.label, patientMobile: preset.mobile } : {}) } };
            },
        // pickPatient
        choosePatient: async (a, s) => {
                const p = s.data.patients.find((x) => x.value === a.patientId);
                return { data: { patientId: a.patientId, patientName: p?.label || '', patientMobile: p?.mobile || '' } };
            },
        // mode
        chooseMode: async (a) => ({ data: { mode: a.choice } }),
        // findMobile
        searchByMobile: async (a, s, d) => {
                if (!a.consent) throw new Error('The patient’s agreement is needed to search ABDM.');
                const res = await post(d.gateway, '/abha/find/search', { mobile: a.mobile });
                if (!res.matches?.length) throw new Error('ABDM found no ABHA for that mobile. Try another number, or create a new ABHA.');
                return { data: { matches: res.matches, mobile: a.mobile } };
            },
        // pickMatch
        requestMatchOtp: async (a, s, d) => {
                const login = { scope: FIND_SCOPE, loginHint: 'index', loginId: String(a.choice), otpSystem: 'abdm' };
                const res = await post(d.gateway, '/abha/login/request-otp', login);
                const match = s.data.matches.find((m) => String(m.index) === String(a.choice));
                return { data: { txnId: res.txnId, message: res.message, login, scope: FIND_SCOPE, match, sends: afterSend(null, now(d), false), resent: false } };
            },
        // findOtp
        verifyMatchOtp: async (a, s, d) => {
                if (a.resend) return resend(s, d);
                const res = await post(d.gateway, '/abha/login/verify-otp', { txnId: s.data.txnId, otp: a.otp, scope: s.data.scope });
                const account = (res.accounts || [])[0] || {};
                return { data: { resent: false, login: null, abhaToken: res.abhaToken, person: abhaPerson(account, { abhaNumber: s.data.match?.abhaNumber, name: s.data.match?.name, mobile: s.data.mobile }) } };
            },
        // numberLogin
        requestNumberOtp: async (a, s, d) => {
                if (!a.consent) throw new Error('The patient’s agreement is needed to verify the ABHA number.');
                const abhaNumber = String(a.abhaNumber).replace(/\D/g, '');
                const scope = scopeFor(a.otpSystem);
                const login = { scope, loginHint: 'abha-number', loginId: abhaNumber, otpSystem: a.otpSystem };
                const res = await post(d.gateway, '/abha/login/request-otp', login);
                return { data: { txnId: res.txnId, message: res.message, login, scope, abhaNumber, sends: afterSend(null, now(d), false), resent: false } };
            },
        // numberOtp
        verifyNumberOtp: async (a, s, d) => {
                if (a.resend) return resend(s, d);
                const res = await post(d.gateway, '/abha/login/verify-otp', { txnId: s.data.txnId, otp: a.otp, scope: s.data.scope });
                const account = (res.accounts || [])[0] || {};
                return { data: { resent: false, login: null, abhaToken: res.abhaToken, account } };
            },
        // profile
        loadProfile: async (s, d) => {
                // The fuller profile (gender, date of birth) when the token allows it; the login's own account otherwise.
                let raw = s.data.account || {};
                if (s.data.abhaToken) {
                    try {
                        raw = { ...raw, ...(await d.gateway('/abha/profile', { headers: { 'X-ABHA-Token': s.data.abhaToken } })) };
                    } catch { /* keep what the login returned */ }
                }
                return { data: { person: abhaPerson(raw, { abhaNumber: s.data.abhaNumber }) } };
            },
        // aadhaar
        sendAadhaarOtp: async (a, s, d) => {
                if (!a.consent) throw new Error('The patient’s consent is needed to create an ABHA.');
                const aadhaar = String(a.aadhaar).replace(/\s/g, '');
                if (!AADHAAR.test(aadhaar)) throw new Error('An Aadhaar number has 12 digits (a Virtual ID has 16).');
                const res = await post(d.gateway, '/abha/enrollment/aadhaar-otp', { aadhaar });
                return { data: { txnId: res.txnId, message: res.message } };
            },
        // aadhaarOtp
        createWithAadhaar: async (a, s, d) => {
                const res = await post(d.gateway, '/abha/enrollment/verify-aadhaar-otp', { txnId: s.data.txnId, otp: a.otp, mobile: a.mobile });
                // profile.mobile present = the typed mobile matched Aadhaar's; absent = ABDM still has to verify it.
                const needsMobileOtp = !res.profile?.mobile;
                let sends = null;
                if (needsMobileOtp) {
                    await post(d.gateway, '/abha/enrollment/mobile-otp', { txnId: res.txnId || s.data.txnId, mobile: a.mobile });
                    sends = afterSend(null, now(d), false);
                }
                return { data: { txnId: res.txnId || s.data.txnId, abhaToken: res.abhaToken, isNew: res.isNew, mobile: a.mobile, needsMobileOtp, sends, resent: false, person: abhaPerson(res.profile, { mobile: a.mobile }) } };
            },
        // mobileOtp
        verifyEnrolMobile: async (a, s, d) => {
                if (a.resend) {
                    const st = resendState(s.data.sends, now(d));
                    if (!st.ok) throw new Error(resendRefusal(st, now(d)));
                    await post(d.gateway, '/abha/enrollment/mobile-otp', { txnId: s.data.txnId, mobile: s.data.mobile });
                    return { data: { sends: afterSend(s.data.sends, now(d), true), resent: true } };
                }
                await post(d.gateway, '/abha/enrollment/verify-mobile-otp', { txnId: s.data.txnId, otp: a.otp });
                return { data: { needsMobileOtp: false, resent: false } };
            },
        // suggest
        suggestAddresses: async (s, d) => {
                try {
                    const res = await d.gateway(`/abha/enrollment/address-suggestions?txnId=${encodeURIComponent(s.data.txnId)}`);
                    return { data: { suggestions: res.suggestions || [] } };
                } catch {
                    return { data: { suggestions: [] } }; // optional: the default address stands
                }
            },
        // address
        chooseAddress: async (a, s, d) => {
                const chosen = a.keep ? '' : String(a.suggestion || a.custom || '').trim().replace(/@(sbx|abdm)$/i, '');
                if (!chosen) return {};
                if (!/^[A-Za-z0-9._]{4,}$/.test(chosen)) throw new Error('An ABHA address has at least 4 letters, digits, dots or underscores.');
                await post(d.gateway, '/abha/enrollment/address', { txnId: s.data.txnId, abhaAddress: chosen });
                return { data: { person: { ...s.data.person, abhaAddress: `${chosen}@sbx` } } };
            },
        // check
        checkName: async (s) => {
                const p = s.data.person || {};
                const known = s.data.patientId !== NEW_PATIENT && s.data.patientName;
                return { data: { nameMismatch: !!(known && p.name && !namesMatch(p.name, s.data.patientName)) } };
            },
        // confirm
        recordOnPatient: async (a, s, d) => {
                if (a.choice !== 'save') return { data: { saved: false } };
                const target = s.data.patientId === NEW_PATIENT ? null : s.data.patientId;
                const recordId = await d.patients.saveAbha(target, s.data.person);
                await d.journal?.add({ journey: 'abha', group: 'ABHA', recordId, title: target ? 'ABHA recorded on a patient' : 'Patient created from ABHA', facts: [['ABHA number', s.data.person.abhaNumber || '—'], ['ABHA address', s.data.person.abhaAddress || '—']] });
                return { data: { saved: true, recordId } };
            },
        // done
        result: async (s) => {
                const p = s.data.person || {};
                if (!s.data.saved) return { result: { ok: true, title: 'Nothing was recorded', text: 'The ABHA was verified but not written to any patient record.' } };
                return {
                    result: {
                        ok: true,
                        title: s.data.mode === 'create' ? 'ABHA created and recorded' : 'ABHA verified and recorded',
                        text: s.data.patientId === NEW_PATIENT ? 'A new patient record was created from the ABHA.' : `Saved on ${s.data.patientName}’s record.`,
                        facts: [
                            ...(p.abhaNumber ? [['ABHA number', p.abhaNumber]] : []),
                            ...(p.abhaAddress ? [['ABHA address', p.abhaAddress]] : []),
                            ...(p.name ? [['Name', p.name]] : []),
                        ],
                    },
                };
            },
    },
};

// Login resend (find and ABHA-number lanes): same policy as HPR (NHA HPR-008), via hprConsent.js.
async function resend(s, d) {
    const st = resendState(s.data.sends, now(d));
    if (!st.ok) throw new Error(resendRefusal(st, now(d)));
    const res = await post(d.gateway, '/abha/login/request-otp', s.data.login);
    return { data: { txnId: res.txnId, message: res.message || s.data.message, sends: afterSend(s.data.sends, now(d), true), resent: true } };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, ' ').split(/\s+/).filter(Boolean);
/** Do two names plausibly belong to one person? (Any shared name part of 3+ letters — cubo-diary's rule.) */
export function namesMatch(a, b) {
    const A = new Set(norm(a).filter((w) => w.length >= 3));
    return norm(b).some((w) => A.has(w));
}
