// Patient ABHA journey (ABDM M1, the "Private Application" column of NHA's Milestone 1 table):
// staff at the clinic create or verify a patient's ABHA, tell a returning patient from a new one,
// record it on the patient and hand over the ABHA card. A JSON journey (specs/abha.journey.json)
// run by the XState engine (engine.js), calling the gateway's staff /abha routes (authorised by
// the ClinuxFlow session), not cubo-diary's citizen routes.
//
//   M1 item                              lane here
//   Creation using Aadhaar OTP           aadhaar -> aadhaarOtp [-> mobileOtp] -> suggest -> address
//   Creation using Aadhaar biometrics    faceStart -> faceWait -> faceAadhaar (face authentication
//                                        on the patient's phone: ABHA app scans our QR; no device)
//   Creation using driving licence       dlMobile -> dlOtp -> dlDocument
//   Create ABHA address                  address (after either Aadhaar lane)
//   Download ABHA card                   card -> after (the card ABDM issues, kept per patient)
//   Profile update                       after -> updMobile / updEmail
//   Verify: scan health facility QR      claimShare (Scan & Share queue; pages/ScanShare.vue)
//   Verify: scan user ABHA QR            scanQr -> numberLogin / addressLogin (then OTP)
//   Verify: by OTP                       findMobile / numberLogin / addressLogin + OTP
//   New vs returning patients            match -> confirm (by ABHA number or address)
//
// An Aadhaar number or OTP arrives only as state.answer and is cleared by the node that sends it;
// nothing secret is stored. The per-user ABHA token stays in this run's memory and goes when the
// run ends; only the card image is kept, on this device, under the patient's ABHA.
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
const ABHA_ADDRESS = /^[A-Za-z0-9._]{3,}@(sbx|abdm)$/i;
const AADHAAR = /^(\d{12}|\d{16})$/; // 12-digit Aadhaar or 16-digit Virtual ID
const MOBILE = '^[6-9]\\d{9}$';
export const NEW_PATIENT = '__new';

const GENDER = { M: 'male', F: 'female', O: 'other', T: 'other' };

/** 14 digits in ABDM's 2-4-4-4 form; anything else unchanged. */
export function dashedAbhaNumber(v) {
    const d = String(v ?? '').replace(/\D/g, '');
    return d.length === 14 ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}-${d.slice(10)}` : (v ? String(v) : v);
}

/** dd-mm-yyyy (enrolment) or separate day/month/year (profile) -> yyyy-mm-dd. */
export function birthDate(p = {}) {
    const pad = (n) => String(n).padStart(2, '0');
    if (p.dob && /^\d{1,2}-\d{1,2}-\d{4}$/.test(p.dob)) {
        const [dd, mm, yyyy] = p.dob.split('-');
        return `${yyyy}-${pad(mm)}-${pad(dd)}`;
    }
    if (p.dob && /^\d{4}-\d{1,2}-\d{1,2}$/.test(p.dob)) {
        const [yyyy, mm, dd] = p.dob.split('-');
        return `${yyyy}-${pad(mm)}-${pad(dd)}`;
    }
    if (p.yearOfBirth && p.monthOfBirth && p.dayOfBirth) return `${p.yearOfBirth}-${pad(p.monthOfBirth)}-${pad(p.dayOfBirth)}`;
    return p.dateOfBirth || p.birthDate || undefined;
}

/** ABDM's profile shapes (enrolment ABHAProfile/EnrolProfile, login account, profile, Scan & Share patient) -> one person. */
export function abhaPerson(raw = {}, extra = {}) {
    const name = raw.name || raw.fullName || [raw.firstName, raw.middleName, raw.lastName].filter(Boolean).join(' ');
    const address = raw.preferredAbhaAddress || raw.abhaAddress || (Array.isArray(raw.phrAddress) ? raw.phrAddress[0] : raw.phrAddress);
    return {
        abhaNumber: dashedAbhaNumber(raw.ABHANumber || raw.abhaNumber || raw.enrolmentNumber || extra.abhaNumber),
        abhaAddress: address || extra.abhaAddress,
        name: name || extra.name || '',
        firstName: raw.firstName || (name ? name.split(' ')[0] : ''),
        lastName: raw.lastName || (name ? name.split(' ').slice(1).join(' ') : ''),
        gender: GENDER[raw.gender] || raw.gender,
        birthDate: birthDate(raw),
        mobile: (raw.mobile && !/\*/.test(raw.mobile) ? raw.mobile : '') || (raw.phoneNumber && !/\*/.test(raw.phoneNumber) ? raw.phoneNumber : '') || extra.mobile,
    };
}

/**
 * What an ABHA card's QR code holds. ABDM's QR is JSON (hidn = ABHA number, hid = ABHA address,
 * name, gender, dob, mobile, …; older cards use other key spellings), so this is lenient: any
 * JSON keys that look right, or else a 14-digit number / name@sbx found in the text.
 */
export function parseAbhaQr(text) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    let o = null;
    try { o = JSON.parse(t); } catch { /* not JSON */ }
    const pick = (...keys) => {
        if (!o || typeof o !== 'object') return undefined;
        const lower = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[\s_]/g, ''), v]));
        for (const k of keys) if (lower[k] !== undefined && lower[k] !== '') return String(lower[k]);
        return undefined;
    };
    const number = pick('hidn', 'abhanumber', 'healthidnumber') || t.match(/\b\d{2}-?\d{4}-?\d{4}-?\d{4}\b/)?.[0];
    const address = pick('hid', 'abhaaddress', 'phraddress', 'healthid') || t.match(/[A-Za-z0-9._]{3,}@(sbx|abdm)\b/i)?.[0];
    const digits = String(number ?? '').replace(/\D/g, '');
    const out = {
        abhaNumber: digits.length === 14 ? dashedAbhaNumber(digits) : undefined,
        abhaAddress: address && ABHA_ADDRESS.test(address) ? address.toLowerCase() : undefined,
        name: pick('name', 'fullname'),
        gender: pick('gender'),
        dob: pick('dob', 'dateofbirth'),
        mobile: pick('mobile', 'phonenumber'),
    };
    return out.abhaNumber || out.abhaAddress ? out : null;
}

const mask = (v = '') => (String(v).length > 4 ? `••••${String(v).slice(-4)}` : v);
const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

/** The clinic's patient this ABHA already belongs to (same ABHA number, or same ABHA address). */
export function findReturning(patients, person) {
    const n = digitsOf(person.abhaNumber);
    const a = String(person.abhaAddress ?? '').toLowerCase();
    return patients.find((p) => (n.length === 14 && digitsOf(p.abhaNumber) === n) || (a && String(p.abhaAddress ?? '').toLowerCase() === a)) || null;
}

function resendRefusal(st, t) {
    if (st.blockedUntil) return `The OTP was resent too often. Try again after ${new Date(st.blockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    return `You can ask for a new OTP ${Math.max(1, Math.ceil((st.availableAt - t) / 1000))} s after the last one.`;
}

const otpField = { name: 'otp', label: 'OTP', inputmode: 'numeric', pattern: '^\\d{6}$', secret: true, required: true };
const mobileField = (value = '') => ({ name: 'mobile', label: 'Mobile number', inputmode: 'tel', pattern: MOBILE, hint: '10 digits', mask: 'last4', value, required: true });
const otpPrompt = (s, d, text) => ({
    text: s.data.message || text,
    ...(s.data.resent ? { detail: 'A new OTP has been sent.' } : {}),
    fields: [otpField],
    resend: resendState(s.data.sends, now(d)),
    submitLabel: 'Verify',
});

/** Where an ABHA card is kept on this device (per account): by ABHA number, else address. */
export const cardKey = (p = {}) => `abha-card:${digitsOf(p.abhaNumber) || String(p.abhaAddress || '').toLowerCase()}`;
const cardDownload = (card, p) => card?.data
    ? { href: `data:${card.contentType};base64,${card.data}`, filename: `ABHA-${digitsOf(p.abhaNumber) || p.abhaAddress || 'card'}.${/pdf/.test(card.contentType) ? 'pdf' : /jpe?g/.test(card.contentType) ? 'jpg' : 'png'}`, label: 'Download ABHA card' }
    : null;

const MODES = [
    { value: 'find', label: 'Find their ABHA by mobile', detail: 'They may already have one. ABDM sends an OTP to that mobile.' },
    { value: 'number', label: 'They know their ABHA number', detail: 'Verify it with an OTP' },
    { value: 'address', label: 'They know their ABHA address', detail: 'name@sbx — verify it with an OTP to its mobile' },
    { value: 'qr', label: 'Scan the QR on their ABHA card', detail: 'Camera or a photo of the card, then an OTP' },
    { value: 'create', label: 'Create a new ABHA with Aadhaar OTP', detail: 'Aadhaar OTP, then their mobile and ABHA address' },
    { value: 'face', label: 'Create with Aadhaar face authentication', detail: 'They scan a QR with the ABHA app on their phone and take a selfie' },
    { value: 'dl', label: 'Create with a driving licence', detail: 'Mobile OTP, then the licence and photos of both sides' },
];

// The journey: its JSON (steps and transitions) plus the named handlers below, run by engine.js
// on XState. id/title/summary/icon come from the JSON.
export const patientAbhaJourney = {
    spec,
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    icon: spec.icon,

    prompts: {
        mode: (s) => ({
            text: s.data.patientName ? `How would you like to set up ${s.data.patientName}’s ABHA?` : 'How would you like to set up the patient’s ABHA?',
            detail: 'Once the ABHA is verified, ClinuxFlow checks whether they are already one of your patients.',
            choices: MODES,
        }),
        findMobile: () => ({
            text: 'Which mobile number might their ABHA be registered with?',
            fields: [
                mobileField(),
                { name: 'consent', label: 'The patient agrees to search ABDM for their ABHA with this number.', type: 'checkbox', required: true },
            ],
            submitLabel: 'Search',
        }),
        pickMatch: (s) => ({
            text: `ABDM found ${s.data.matches.length} ABHA account${s.data.matches.length === 1 ? '' : 's'} for that number. Which one is the patient’s?`,
            detail: 'ABDM shows only part of each account. Picking one sends an OTP to the mobile.',
            choices: s.data.matches.map((m) => ({ value: String(m.index), label: m.name || 'ABHA account', detail: [m.abhaNumber, m.gender, m.kycVerified ? 'KYC verified' : null].filter(Boolean).join(' · ') })),
        }),
        findOtp: (s, d) => otpPrompt(s, d, 'Enter the OTP ABDM sent to that mobile.'),
        scanQr: () => ({
            text: 'Scan the QR code on the patient’s ABHA card (or the ABHA app), or upload a photo of it.',
            detail: 'The QR only tells us which ABHA it is. ABDM still sends an OTP to verify it.',
            fields: [{ name: 'qr', label: 'ABHA QR code', type: 'qrscan', required: true, wide: true }],
            submitLabel: 'Continue',
        }),
        numberLogin: (s) => ({
            text: s.data.qr ? `The QR is ${s.data.qr.name ? `${s.data.qr.name}’s` : 'an'} ABHA. Verify it with an OTP.` : 'Enter the patient’s ABHA number. ABDM sends an OTP to verify it.',
            fields: [
                { name: 'abhaNumber', label: 'ABHA number', hint: '14 digits, e.g. 91-1234-5678-9012', pattern: ABHA_NUMBER.source, value: s.data.qr?.abhaNumber || '', required: true },
                { name: 'otpSystem', label: 'Send the OTP to', type: 'select', options: NUMBER_METHODS.map(({ value, label }) => ({ value, label })), value: 'abdm', required: true },
                { name: 'consent', label: 'The patient agrees to send their ABHA number to ABDM to verify it.', type: 'checkbox', required: true },
            ],
            submitLabel: 'Send OTP',
        }),
        numberOtp: (s, d) => otpPrompt(s, d, 'Enter the OTP ABDM sent.'),
        addressLogin: (s) => ({
            text: 'Enter the patient’s ABHA address. ABDM sends an OTP to the mobile linked to it.',
            fields: [
                { name: 'abhaAddress', label: 'ABHA address', placeholder: 'name@sbx', pattern: ABHA_ADDRESS.source, hint: 'name@sbx in the sandbox, name@abdm in production', value: s.data.qr?.abhaAddress || '', required: true },
                { name: 'consent', label: 'The patient agrees to send their ABHA address to ABDM to verify it.', type: 'checkbox', required: true },
            ],
            submitLabel: 'Send OTP',
        }),
        addressOtp: (s, d) => otpPrompt(s, d, 'Enter the OTP ABDM sent to the mobile linked to that ABHA address.'),
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
            fields: [otpField, { ...mobileField(s.data.patientMobile || ''), label: 'Mobile for the ABHA' }],
            submitLabel: 'Create ABHA',
        }),
        faceStart: (s) => ({
            text: 'Face authentication: the patient verifies their Aadhaar with a selfie in the ABHA app on their own phone. No fingerprint device is needed.',
            detail: 'Next you’ll see a QR code for them to scan with the ABHA app.',
            fields: [
                { ...mobileField(s.data.patientMobile || ''), label: 'Mobile for the ABHA' },
                { name: 'consent', label: 'The patient consents to create an ABHA with their Aadhaar by face authentication (ABDM enrolment consent v1.4).', type: 'checkbox', required: true },
            ],
            submitLabel: 'Show the QR code',
        }),
        faceWait: (s) => ({
            text: 'Ask the patient to open the ABHA app, scan this QR code and finish the face capture. Then check here.',
            detail: s.data.faceStatus ? `ABDM says: ${s.data.faceStatus}` : 'The capture usually takes under a minute.',
            qr: s.data.faceQrUrl,
            choices: [
                { value: 'check', label: 'Check whether it’s done' },
                { value: 'restart', label: 'Show a new QR code', detail: 'If the capture failed or the QR expired' },
            ],
        }),
        faceAadhaar: () => ({
            text: 'Face capture complete. Enter the patient’s Aadhaar number to create the ABHA.',
            detail: 'The Aadhaar number goes to ABDM through ClinuxFlow’s gateway and is not stored.',
            fields: [{ name: 'aadhaar', label: 'Aadhaar number or Virtual ID', inputmode: 'numeric', pattern: AADHAAR.source, hint: '12 digits (or 16-digit VID)', secret: true, required: true }],
            submitLabel: 'Create ABHA',
        }),
        mobileOtp: (s, d) => ({ ...otpPrompt(s, d, ''), text: `That mobile isn’t the one on their Aadhaar, so ABDM sent ${mask(s.data.mobile)} an OTP.`, submitLabel: 'Verify mobile' }),
        address: (s) => ({
            text: `ABHA ${s.data.person.abhaNumber} is created. Choose the patient’s ABHA address, or keep ${s.data.person.abhaAddress || 'the default'}.`,
            fields: [
                ...(s.data.suggestions?.length ? [{ name: 'suggestion', label: 'Suggested addresses', type: 'select', options: s.data.suggestions.map((a) => ({ value: a, label: `${a}@sbx` })), value: '' }] : []),
                { name: 'custom', label: 'Or type one', placeholder: 'e.g. asha.rao', hint: 'Letters, digits, dot or underscore; @sbx is added' },
                { name: 'keep', label: `Keep ${s.data.person.abhaAddress || 'the default address'}`, type: 'checkbox' },
            ],
            submitLabel: 'Continue',
        }),
        dlMobile: (s) => ({
            text: 'Creating an ABHA with a driving licence starts with the patient’s mobile number. ABDM sends it an OTP.',
            detail: 'ABDM then checks the licence with the transport department’s records.',
            fields: [
                mobileField(s.data.patientMobile || ''),
                { name: 'consent', label: 'The patient consents to create an ABHA with their driving licence (ABDM enrolment consent v1.4).', type: 'checkbox', required: true },
            ],
            submitLabel: 'Send OTP',
        }),
        dlOtp: (s, d) => otpPrompt(s, d, 'Enter the OTP ABDM sent to that mobile.'),
        dlDocument: () => ({
            text: 'Enter the driving licence exactly as printed, with a photo of each side.',
            fields: [
                { name: 'documentId', label: 'Driving licence number', placeholder: 'MH1320140019054', pattern: '^[A-Za-z0-9 -]{8,20}$', required: true },
                { name: 'dob', label: 'Date of birth', type: 'date', required: true },
                { name: 'firstName', label: 'First name', required: true },
                { name: 'middleName', label: 'Middle name' },
                { name: 'lastName', label: 'Last name' },
                { name: 'gender', label: 'Gender', type: 'select', options: [{ value: 'M', label: 'Male' }, { value: 'F', label: 'Female' }, { value: 'O', label: 'Other' }], required: true },
                { name: 'address', label: 'Address', wide: true, required: true },
                { name: 'district', label: 'District', required: true },
                { name: 'state', label: 'State', required: true },
                { name: 'pinCode', label: 'PIN code', inputmode: 'numeric', pattern: '^\\d{6}$', required: true },
                { name: 'frontSidePhoto', label: 'Front of the licence', type: 'image', hint: 'JPEG or PNG photo', required: true },
                { name: 'backSidePhoto', label: 'Back of the licence', type: 'image', hint: 'JPEG or PNG photo', required: true },
            ],
            submitLabel: 'Create ABHA',
        }),
        confirm: (s) => {
            const p = s.data.person;
            const id = p.abhaNumber || p.abhaAddress;
            const facts = [
                ...(p.abhaNumber ? [{ name: s.data.mode === 'dl' ? 'Enrolment number' : 'ABHA number', detail: p.abhaNumber }] : []),
                ...(p.abhaAddress ? [{ name: 'ABHA address', detail: p.abhaAddress }] : []),
                ...(p.name ? [{ name: 'Name', detail: p.name }] : []),
                ...(p.gender ? [{ name: 'Gender', detail: p.gender }] : []),
                ...(p.birthDate ? [{ name: 'Date of birth', detail: p.birthDate }] : []),
                ...(s.data.tokenNumber ? [{ name: 'Token', detail: `${s.data.tokenNumber} (counter ${s.data.counter || '—'})` }] : []),
            ];
            const verified = s.data.verifiedBy ? ` ${s.data.verifiedBy}.` : '';
            if (s.data.targetId) {
                return {
                    text: `Record ABHA ${id} (${p.name}) on ${s.data.patientName}’s record?${verified}`,
                    ...(s.data.nameMismatch ? { warning: `The name on this ABHA (${p.name}) doesn’t look like ${s.data.patientName}. Only record it if it really is theirs.` } : {}),
                    ...(s.data.returningId && s.data.returningId !== s.data.targetId ? { warning: `This ABHA is already recorded on ${s.data.returningName}. Recording it here too would make two records for one person.` } : {}),
                    list: facts,
                    choices: [
                        { value: 'save', label: 'Record it on the patient', detail: 'Fills in ABHA number and address, and any blank name, gender, date of birth or mobile' },
                        { value: 'no', label: 'Don’t record it' },
                    ],
                };
            }
            if (s.data.returningId) {
                return {
                    text: `Returning patient: ${s.data.returningName}. This ABHA is already on their record.${verified}`,
                    list: facts,
                    choices: [
                        { value: 'save', label: `Continue with ${s.data.returningName}’s record`, detail: 'Their record keeps what the clinic typed; blank fields are filled from the ABHA' },
                        { value: 'no', label: 'Don’t change anything' },
                    ],
                };
            }
            return {
                text: `New patient: no record in this clinic has ABHA ${id}.${verified}`,
                list: facts,
                choices: [
                    { value: 'new', label: 'Create a new patient record', detail: 'From the ABHA’s name, gender, date of birth and mobile' },
                    { value: 'attach', label: 'Add it to an existing patient', detail: 'Someone registered here before they had this ABHA' },
                    { value: 'no', label: 'Don’t record it' },
                ],
            };
        },
        pickPatient: (s) => ({
            text: `Which patient is ${s.data.person?.name || 'this'}?`,
            detail: 'Only patients without an ABHA are listed.',
            fields: [{
                name: 'patientId', label: 'Patient', type: 'select', required: true, value: '',
                options: (s.data.patients || []).filter((p) => !p.abhaNumber && !p.abhaAddress),
            }],
            submitLabel: 'Record it on this patient',
        }),
        after: (s) => ({
            text: s.data.updated ? s.data.updated : `${s.data.person?.name || 'The patient'}’s ABHA is recorded. Hand them their ABHA card, or update their ABHA profile.`,
            ...(s.data.cardError ? { warning: `The ABHA card couldn’t be downloaded: ${s.data.cardError}` } : {}),
            ...(s.data.card ? { download: cardDownload(s.data.card, s.data.person) } : {}),
            choices: [
                { value: 'done', label: 'Finish' },
                { value: 'mobile', label: 'Change the mobile on their ABHA', detail: 'ABDM verifies the new number with an OTP' },
                { value: 'email', label: 'Add an email to their ABHA', detail: 'ABDM emails them a verification link' },
            ],
        }),
        updMobile: (s) => ({ text: 'The new mobile number for their ABHA:', fields: [mobileField(s.data.person?.mobile || '')], submitLabel: 'Send OTP' }),
        updMobileOtp: (s, d) => otpPrompt(s, d, 'Enter the OTP ABDM sent to the new mobile.'),
        updEmail: () => ({
            text: 'The email address for their ABHA. ABDM sends a link there; the patient opens it to verify.',
            fields: [{ name: 'email', label: 'Email', type: 'email', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', required: true }],
            submitLabel: 'Send verification link',
        }),
    },

    // The step handlers the journey JSON names (specs/<id>.journey.json): an ask's
    // (answer, state, deps), an auto/final's (state, deps).
    actions: {
        // begin
        loadPatients: async (s, d) => {
            const patients = await d.patients.list();
            const preset = s.data.patientId && patients.find((p) => p.value === s.data.patientId);
            return { data: { patients, ...(preset ? { targetId: preset.value, patientName: preset.name || preset.label, patientMobile: preset.mobile, hasAbha: !!(preset.abhaNumber || preset.abhaAddress) } : {}) } };
        },
        // viewAbha: a patient whose ABHA is already recorded — read-only, with the card if kept.
        viewAbha: async (s, d) => {
            const p = s.data.patients.find((x) => x.value === s.data.patientId) || {};
            const card = d.records ? await d.records.get(cardKey(p)).catch(() => null) : null;
            return {
                result: {
                    ok: true,
                    readonly: true,
                    title: `${s.data.patientName || 'This patient'} has an ABHA`,
                    text: card ? 'Recorded on the patient. Their ABHA card is kept on this device.' : 'Recorded on the patient. It can’t be changed here.',
                    facts: [['ABHA number', p.abhaNumber || '—'], ...(p.abhaAddress ? [['ABHA address', p.abhaAddress]] : []), ['Patient', s.data.patientName || '—']],
                    ...(card ? { download: cardDownload(card, p) } : {}),
                    again: 'Set up ABHA for another patient',
                    againFresh: true,
                },
            };
        },
        // claimShare: the patient scanned the facility's QR (Scan & Share); the profile was
        // verified by ABDM's HIE-CM before it reached us, so no OTP is needed.
        claimShare: async (s, d) => {
            const res = await post(d.gateway, `/abha/scan-share/queue/${encodeURIComponent(s.data.shareId)}/claim`, {});
            const share = res.share;
            return {
                data: {
                    mode: 'scan-share', person: abhaPerson(share.patient), tokenNumber: share.tokenNumber, counter: share.context, facilityId: share.facilityId,
                    verifiedBy: 'Verified by ABDM: they shared it by scanning the facility QR',
                },
            };
        },
        // mode
        chooseMode: async (a) => ({ data: { mode: a.choice, qr: null } }),
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
            return { data: { txnId: res.txnId, message: res.message, login, loginPath: '/abha/login/request-otp', scope: FIND_SCOPE, match, sends: afterSend(null, now(d), false), resent: false } };
        },
        // findOtp
        verifyMatchOtp: async (a, s, d) => {
            if (a.resend) return resend(s, d);
            const res = await post(d.gateway, '/abha/login/verify-otp', { txnId: s.data.txnId, otp: a.otp, scope: s.data.scope });
            return { data: { resent: false, login: null, abhaToken: res.abhaToken, tokenKind: 'abha', account: (res.accounts || [])[0] || {}, known: { abhaNumber: s.data.match?.abhaNumber, name: s.data.match?.name, mobile: s.data.mobile }, verifiedBy: 'Verified by OTP to their mobile' } };
        },
        // scanQr
        readQr: async (a) => {
            const qr = parseAbhaQr(a.qr);
            if (!qr) throw new Error('That QR code isn’t an ABHA card’s. Try again, or enter the ABHA number instead.');
            return { data: { qr, qrHasNumber: !!qr.abhaNumber } };
        },
        // numberLogin
        requestNumberOtp: async (a, s, d) => {
            if (!a.consent) throw new Error('The patient’s agreement is needed to verify the ABHA number.');
            const abhaNumber = String(a.abhaNumber).replace(/\D/g, '');
            const scope = scopeFor(a.otpSystem);
            const login = { scope, loginHint: 'abha-number', loginId: abhaNumber, otpSystem: a.otpSystem };
            const res = await post(d.gateway, '/abha/login/request-otp', login);
            return { data: { txnId: res.txnId, message: res.message, login, loginPath: '/abha/login/request-otp', scope, abhaNumber, sends: afterSend(null, now(d), false), resent: false } };
        },
        // numberOtp
        verifyNumberOtp: async (a, s, d) => {
            if (a.resend) return resend(s, d);
            const res = await post(d.gateway, '/abha/login/verify-otp', { txnId: s.data.txnId, otp: a.otp, scope: s.data.scope });
            return { data: { resent: false, login: null, abhaToken: res.abhaToken, tokenKind: 'abha', account: (res.accounts || [])[0] || {}, known: { abhaNumber: s.data.abhaNumber }, verifiedBy: s.data.qr ? 'Scanned from their ABHA QR and verified by OTP' : 'Verified by OTP' } };
        },
        // addressLogin
        requestAddressOtp: async (a, s, d) => {
            if (!a.consent) throw new Error('The patient’s agreement is needed to verify the ABHA address.');
            const login = { abhaAddress: String(a.abhaAddress).trim().toLowerCase() };
            const res = await post(d.gateway, '/abha/login/address/request-otp', login);
            return { data: { txnId: res.txnId, message: res.message, login, loginPath: '/abha/login/address/request-otp', abhaAddress: login.abhaAddress, sends: afterSend(null, now(d), false), resent: false } };
        },
        // addressOtp
        verifyAddressOtp: async (a, s, d) => {
            if (a.resend) return resend(s, d);
            const res = await post(d.gateway, '/abha/login/address/verify-otp', { txnId: s.data.txnId, otp: a.otp });
            return { data: { resent: false, login: null, abhaToken: res.abhaToken, tokenKind: 'phr', account: res.account || {}, known: { abhaAddress: s.data.abhaAddress }, verifiedBy: s.data.qr ? 'Scanned from their ABHA QR and verified by OTP' : 'Verified by OTP to the mobile on that ABHA address' } };
        },
        // profile: the fuller profile when the session allows it; the login's own account otherwise.
        loadProfile: async (s, d) => {
            let raw = s.data.account || {};
            if (s.data.abhaToken) {
                try {
                    const res = await d.gateway('/abha/session/profile', { headers: { 'X-ABHA-Token': s.data.abhaToken, 'X-ABHA-Kind': s.data.tokenKind || 'abha' } });
                    raw = { ...raw, ...Object.fromEntries(Object.entries(res.profile || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
                } catch { /* keep what the login returned */ }
            }
            return { data: { person: abhaPerson(raw, s.data.known || {}) } };
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
            return enrolledWith(res, a.mobile, s, d, 'Created with Aadhaar OTP');
        },
        // faceStart
        startFace: async (a, s, d) => {
            if (!a.consent) throw new Error('The patient’s consent is needed to create an ABHA.');
            const res = await post(d.gateway, '/abha/enrollment/face/init', {});
            return { data: { txnId: res.txnId, faceQrUrl: res.qrUrl, mobile: a.mobile, faceStatus: '', faceDone: false } };
        },
        // faceWait
        checkFace: async (a, s, d) => {
            if (a.choice === 'restart') {
                const res = await post(d.gateway, '/abha/enrollment/face/init', {});
                return { data: { txnId: res.txnId, faceQrUrl: res.qrUrl, faceStatus: 'A new QR code is ready.', faceDone: false } };
            }
            const res = await post(d.gateway, '/abha/enrollment/face/status', { txnId: s.data.txnId });
            if (res.status === 'FAILED') return { data: { faceStatus: 'the face capture failed. Show a new QR code and try again.', faceDone: false } };
            if (res.status !== 'COMPLETE') return { data: { faceStatus: res.status === 'VERIFIED' ? 'the QR was scanned; waiting for the face capture.' : 'still waiting for the ABHA app.', faceDone: false } };
            return { data: { txnId: res.txnId || s.data.txnId, faceDone: true } };
        },
        // faceAadhaar
        createWithFace: async (a, s, d) => {
            const aadhaar = String(a.aadhaar).replace(/\s/g, '');
            if (!AADHAAR.test(aadhaar)) throw new Error('An Aadhaar number has 12 digits (a Virtual ID has 16).');
            const res = await post(d.gateway, '/abha/enrollment/face/enrol', { txnId: s.data.txnId, aadhaar, mobile: s.data.mobile });
            return enrolledWith(res, s.data.mobile, s, d, 'Created with Aadhaar face authentication');
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
        // address (Create ABHA address)
        chooseAddress: async (a, s, d) => {
            const chosen = a.keep ? '' : String(a.suggestion || a.custom || '').trim().replace(/@(sbx|abdm)$/i, '');
            if (!chosen) return {};
            if (!/^[A-Za-z0-9._]{4,}$/.test(chosen)) throw new Error('An ABHA address has at least 4 letters, digits, dots or underscores.');
            await post(d.gateway, '/abha/enrollment/address', { txnId: s.data.txnId, abhaAddress: chosen });
            return { data: { person: { ...s.data.person, abhaAddress: `${chosen}@sbx` } } };
        },
        // dlMobile
        sendDlOtp: async (a, s, d) => {
            if (!a.consent) throw new Error('The patient’s consent is needed to create an ABHA.');
            const login = { mobile: a.mobile };
            const res = await post(d.gateway, '/abha/enrollment/dl/mobile-otp', login);
            return { data: { txnId: res.txnId, message: res.message, mobile: a.mobile, login, loginPath: '/abha/enrollment/dl/mobile-otp', sends: afterSend(null, now(d), false), resent: false } };
        },
        // dlOtp
        verifyDlOtp: async (a, s, d) => {
            if (a.resend) return resend(s, d);
            const res = await post(d.gateway, '/abha/enrollment/dl/verify-mobile-otp', { txnId: s.data.txnId, otp: a.otp });
            return { data: { txnId: res.txnId || s.data.txnId, resent: false, login: null } };
        },
        // dlDocument
        submitDl: async (a, s, d) => {
            const res = await post(d.gateway, '/abha/enrollment/dl/document', {
                txnId: s.data.txnId, documentId: String(a.documentId).replace(/\s/g, '').toUpperCase(),
                firstName: a.firstName, middleName: a.middleName || '', lastName: a.lastName || '', dob: a.dob, gender: a.gender,
                frontSidePhoto: a.frontSidePhoto?.value, backSidePhoto: a.backSidePhoto?.value,
                address: a.address, state: a.state, district: a.district, pinCode: a.pinCode,
            });
            const e = res.enrolment || {};
            const person = abhaPerson({ ...e, mobile: s.data.mobile }, { mobile: s.data.mobile });
            return { data: { person, enrolmentState: e.enrolmentState, verifiedBy: `Created with a driving licence${e.enrolmentState ? ` (${String(e.enrolmentState).toLowerCase()})` : ''}` } };
        },
        // match: new or returning?
        matchPatient: async (s) => {
            const p = s.data.person || {};
            const returning = findReturning(s.data.patients || [], p);
            const target = s.data.targetId;
            return {
                data: {
                    returningId: returning?.value || null,
                    returningName: returning?.name || returning?.label || '',
                    nameMismatch: !!(target && s.data.patientName && p.name && !namesMatch(p.name, s.data.patientName)),
                },
            };
        },
        // confirm
        recordOnPatient: async (a, s, d) => {
            if (a.choice === 'no') return { data: { saved: false, choosePatient: false } };
            if (a.choice === 'attach') return { data: { choosePatient: true } };
            const target = a.choice === 'new' ? null : s.data.targetId || s.data.returningId;
            return save(target, s, d);
        },
        // pickPatient (attach to an existing patient)
        recordOnChosen: async (a, s, d) => {
            const p = (s.data.patients || []).find((x) => x.value === a.patientId);
            if (!p) throw new Error('Choose a patient.');
            return save(p.value, { ...s, data: { ...s.data, patientName: p.name || p.label } }, d);
        },
        // card: the ABHA card, with the patient's session (none after a driving-licence enrolment
        // or Scan & Share). Kept on this device under the patient's ABHA.
        fetchCard: async (s, d) => {
            const canUpdate = !!s.data.abhaToken;
            if (!s.data.abhaToken) return { data: { canUpdate } };
            try {
                const card = await d.gateway('/abha/session/card', { headers: { 'X-ABHA-Token': s.data.abhaToken, 'X-ABHA-Kind': s.data.tokenKind || 'abha' } });
                const kept = { contentType: card.contentType, data: card.data, at: new Date(now(d)).toISOString() };
                await d.records?.set(cardKey(s.data.person), kept);
                return { data: { canUpdate, card: kept, cardError: '' } };
            } catch (err) {
                return { data: { canUpdate, cardError: err.message } };
            }
        },
        // after
        chooseAfter: async (a, s) => {
            if (a.choice !== 'done' && s.data.tokenKind === 'phr') throw new Error('Signed in with an ABHA address, the ABHA profile can’t be changed here. Verify with the ABHA number to change it.');
            return { data: { after: a.choice, updated: '' } };
        },
        // updMobile
        sendUpdateMobileOtp: async (a, s, d) => {
            const res = await post(d.gateway, '/abha/profile/mobile/request-otp', { mobile: a.mobile }, { 'X-ABHA-Token': s.data.abhaToken });
            return { data: { txnId: res.txnId, message: res.message, newMobile: a.mobile, login: { mobile: a.mobile }, loginPath: '/abha/profile/mobile/request-otp', sends: afterSend(null, now(d), false), resent: false } };
        },
        // updMobileOtp
        verifyUpdateMobile: async (a, s, d) => {
            if (a.resend) return resend(s, d, { 'X-ABHA-Token': s.data.abhaToken });
            await post(d.gateway, '/abha/profile/mobile/verify-otp', { txnId: s.data.txnId, otp: a.otp }, { 'X-ABHA-Token': s.data.abhaToken });
            return { data: { resent: false, login: null, person: { ...s.data.person, mobile: s.data.newMobile }, updated: `Their ABHA now uses mobile ${mask(s.data.newMobile)}.` } };
        },
        // updEmail
        sendEmailLink: async (a, s, d) => {
            await post(d.gateway, '/abha/enrollment/email-verification-link', { email: a.email }, { 'X-ABHA-Token': s.data.abhaToken });
            return { data: { updated: `ABDM sent a verification link to ${a.email}. The patient opens it to finish.` } };
        },
        // done
        result: async (s) => {
            const p = s.data.person || {};
            if (!s.data.saved) return { result: { ok: true, title: 'Nothing was recorded', text: 'The ABHA was verified but not written to any patient record.' } };
            const created = ['create', 'face', 'dl'].includes(s.data.mode);
            return {
                result: {
                    ok: true,
                    readonly: true,
                    again: 'Set up ABHA for another patient',
                    againFresh: true,
                    title: `${created ? 'ABHA created' : 'ABHA verified'} · ${s.data.wasReturning ? 'returning patient' : 'new patient'}`,
                    text: s.data.createdRecord ? 'A new patient record was created from the ABHA.' : `Saved on ${s.data.savedName}’s record.`,
                    facts: [
                        ...(p.abhaNumber ? [[s.data.mode === 'dl' ? 'Enrolment number' : 'ABHA number', p.abhaNumber]] : []),
                        ...(p.abhaAddress ? [['ABHA address', p.abhaAddress]] : []),
                        ...(p.name ? [['Name', p.name]] : []),
                        ...(s.data.tokenNumber ? [['Token', String(s.data.tokenNumber)]] : []),
                    ],
                    ...(s.data.card ? { download: cardDownload(s.data.card, p) } : {}),
                    next: { label: 'Open Patients', to: '/patient-home' },
                },
            };
        },
    },
};

/** After an enrolment that created an account (Aadhaar OTP or face): the person and the next step. */
async function enrolledWith(res, mobile, s, d, verifiedBy) {
    // profile.mobile present = the typed mobile matched Aadhaar's; absent = ABDM still has to verify it.
    const needsMobileOtp = !res.profile?.mobile;
    let sends = null;
    if (needsMobileOtp) {
        await post(d.gateway, '/abha/enrollment/mobile-otp', { txnId: res.txnId || s.data.txnId, mobile });
        sends = afterSend(null, now(d), false);
    }
    return { data: { txnId: res.txnId || s.data.txnId, abhaToken: res.abhaToken, tokenKind: 'abha', isNew: res.isNew, mobile, needsMobileOtp, sends, resent: false, person: abhaPerson(res.profile, { mobile }), verifiedBy } };
}

async function save(target, s, d) {
    const person = s.data.person;
    const recordId = await d.patients.saveAbha(target, person);
    const wasReturning = !!(target && target === s.data.returningId);
    await d.journal?.add({
        journey: 'abha', group: 'ABHA', recordId,
        title: target ? 'ABHA recorded on a patient' : 'Patient created from ABHA',
        facts: [['ABHA number', person.abhaNumber || '—'], ['ABHA address', person.abhaAddress || '—'], ['Patient', wasReturning ? 'returning' : 'new'], ['Via', s.data.mode || '—']],
    });
    return { data: { saved: true, choosePatient: false, recordId, createdRecord: !target, wasReturning, savedName: target ? (s.data.patientName || s.data.returningName || person.name) : person.name } };
}

// Login resend (find, ABHA number, ABHA address, driving licence, mobile update): same policy as
// HPR (NHA HPR-008), via hprConsent.js. Each lane keeps its own request body and path.
async function resend(s, d, headers) {
    const st = resendState(s.data.sends, now(d));
    if (!st.ok) throw new Error(resendRefusal(st, now(d)));
    const res = await post(d.gateway, s.data.loginPath || '/abha/login/request-otp', s.data.login, headers);
    return { data: { txnId: res.txnId, message: res.message || s.data.message, sends: afterSend(s.data.sends, now(d), true), resent: true } };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, ' ').split(/\s+/).filter(Boolean);
/** Do two names plausibly belong to one person? (Any shared name part of 3+ letters — cubo-diary's rule.) */
export function namesMatch(a, b) {
    const A = new Set(norm(a).filter((w) => w.length >= 3));
    return norm(b).some((w) => A.has(w));
}
