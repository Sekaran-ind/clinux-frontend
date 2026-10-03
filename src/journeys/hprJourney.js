// HPR (Healthcare Professional Registry) journey: link an existing HPR ID, or register a new one
// through Aadhaar. Every call goes through clinuxflow-abdm-gateway's /hpr routes.
//
//   begin -> mode --link------> login -> profile -> linked
//                 --register--> aadhaar -> aadhaarLink -> checkAccount --exists--> exists
//                               (NHA consent) (NHA's Aadhaar page; "new link" loops back)
//                                  -> mobile --matched--------------> loadMasters
//                                            --not matched-> sendMobileOtp -> mobileOtp -> loadMasters
//                                  -> identity -> jurisdiction -> loadDistricts -> finish -> registered
//
// Aadhaar is verified on NHA's own page (HPR registration doc v2.0, 22-06-2026): the gateway gets
// a 5-minute link, the person enters their Aadhaar and OTP there, and Cübo never sees either.
// When they come back, the gateway confirms it with ABDM and fetches the verified details.
//
// ABDM checks the mobile number against Aadhaar first (demographic auth). When it doesn't match,
// ABDM verifies that number with its own OTP instead, which is the documented fallback.
import spec from './specs/hpr.journey.json' with { type: 'json' };
import { PROFILE, keepResource, providerResource } from './fhir.js';
import { HPR_AADHAAR_CONSENT, HPR_AADHAAR_CONSENT_VERSION, afterSend, resendState } from './hprConsent.js';
import { loadDraft } from './hprProfile.js';
import { profilePrompts, profileActions } from './hprProfileSteps.js';

export const HPR_RECORD = 'abdm:hpr';
export const PROVIDER_RESOURCE = 'fhir:provider';
// The record of the person's Aadhaar consent (HPR-003): which text, which language, when. Never the number.
export const AADHAAR_CONSENT_RECORD = 'abdm:hpr-aadhaar-consent';

const now = (d) => (d.now ? d.now() : Date.now());

// createHprIdWithPreVerified's `role`: 1 Healthcare Professional, 2 Facility Manager, 3 both.
// createHprIdWithPreVerified's hpCategoryCode (HPR API doc, "Category code used to create HPR Id").
// Doc v2.0 adds Pharmacist (6).
export const HPR_CATEGORIES = [
    { value: '1', label: 'Doctor', type: 'doctor' },
    { value: '2', label: 'Nurse', type: 'nurse' },
    { value: '6', label: 'Pharmacist', type: 'pharmacist' },
];

// The HPR masters, checked against the live sandbox (2026-09-30):
//   system-of-medicine  [{ id, medicalSystem, hprType: doctor|nurse|pharmacist, code: 'modern_medicine' }]
//                       hpSubCategoryCode is the numeric `id` (the API doc's sub-category table),
//                       not the slug `code`. The live ids differ from the doc's older table, so the
//                       live master is used, filtered by hprType to the chosen category.
//   states              [{ id, name, isoCode }]  districts are fetched by `id`; createHprId's
//                       stateCode is the LGD `isoCode` (doc sample: "27" for Maharashtra).
//   districts/:stateId  [{ id, districtName, isoCode }]  districtCode is the LGD `isoCode`.
const listOf = (res) => (Array.isArray(res?.data) ? res.data : []);
export const hprSystems = (res) => listOf(res).map((e) => ({ value: String(e.id), label: String(e.medicalSystem ?? e.name ?? e.id).trim(), type: e.hprType }));
export const hprStates = (res) => listOf(res).map((e) => ({ value: String(e.id), label: String(e.name ?? e.stateName ?? e.id).trim(), lgd: String(e.isoCode ?? e.code ?? e.id) }));
export const hprDistricts = (res) => listOf(res).map((e) => ({ value: String(e.isoCode ?? e.code ?? e.id), label: String(e.districtName ?? e.name ?? e.id).trim() }));

function resendRefusal(st, t) {
    if (st.blockedUntil) return `You have asked for the OTP to be resent too often. Try again after ${new Date(st.blockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    return `You can ask for a new OTP ${Math.max(1, Math.ceil((st.availableAt - t) / 1000))} s after the last one.`;
}

export const HPR_ROLE_OPTIONS = [
    { value: '1', label: 'Healthcare Professional' },
    { value: '2', label: 'Facility Manager' },
    { value: '3', label: 'Healthcare Professional and Facility Manager' },
];
const ROLE_FOR_ACCOUNT = { health_professional: '1', hospital_admin: '2', admin_and_health_professional: '3' };

// ABDM's HPR password rule, checked here so a weak password fails before the last call.
export const HPR_PASSWORD = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

const post = (gateway, path, body) => gateway(path, { method: 'POST', body });

function splitName(demographics = {}) {
    if (demographics.firstName || demographics.lastName) {
        return { firstName: demographics.firstName || '', middleName: demographics.middleName || '', lastName: demographics.lastName || '' };
    }
    const parts = String(demographics.name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { firstName: parts[0] || '', middleName: '', lastName: '' };
    return { firstName: parts[0], middleName: parts.slice(1, -1).join(' '), lastName: parts.at(-1) };
}

/** The KYC address ABDM returns after Aadhaar verification, as one line. */
function kycAddress(demographics = {}) {
    const parts = [demographics.address, demographics.districtName, demographics.stateName, demographics.pincode].map((x) => String(x ?? '').trim()).filter(Boolean);
    return parts.join(', ');
}

function suggestionsOf(res) {
    const raw = res?.suggestions?.hpIdSuggestion ?? res?.suggestions ?? [];
    return (Array.isArray(raw) ? raw : []).map(String);
}

// The journey: its JSON (steps and transitions) plus the named handlers below, run by engine.js
// on XState. id/title/summary/icon come from the JSON.
export const hprJourney = {
    spec,
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    icon: spec.icon,
    // Facility managers need an HPR ID too: HFR registration signs in with it.
    roles: ['health_professional', 'hospital_admin', 'admin_and_health_professional'],

    prompts: {
        // Once an HPR ID is linked or registered, it's read-only here: view it, or sign in to it for
        // this session (what HFR registration needs) — not link or register a different one.
        mode: (s) => (s.data.linked
            ? {
                text: `Your account is linked to HPR ID ${s.data.linked.hprId}.`,
                detail: 'A linked HPR ID is read-only here.',
                choices: [
                    { value: 'profile', label: s.data.profileSubmitted ? 'Update my professional profile' : s.data.profileDraft ? 'Continue my professional profile' : 'Complete my professional profile', detail: s.data.profileSubmitted ? 'Changes go to HPR as an update' : 'Personal details, registration, qualifications and work — HPR verifies you from these' },
                    { value: 'view', label: 'View my HPR ID' },
                    { value: 'link', label: 'Sign in to HPR for this session', detail: 'Needed to register a facility with HFR' },
                ],
            }
            : {
                text: 'Do you already have an HPR ID?',
                choices: [
                    { value: 'link', label: 'Yes, link my HPR ID', detail: 'Sign in with your HPR ID and password' },
                    { value: 'register', label: 'Register a new HPR ID', detail: 'Verify with Aadhaar, then enter your professional details' },
                ],
            }),
        login: (s) => ({
            text: 'Sign in to the Healthcare Professional Registry.',
            detail: 'Your password goes to ABDM through the ClinuxFlow gateway and is not stored.',
            fields: [
                // The linked HPR ID can't be swapped for another here (read-only once linked).
                { name: 'hprId', label: 'HPR ID', placeholder: 'name@hpr.abdm', value: s.data.linked?.hprId || '', readonly: !!s.data.linked, required: true },
                { name: 'password', label: 'HPR password', type: 'password', secret: true, required: true },
            ],
            submitLabel: 'Sign in',
        }),
        aadhaar: () => ({
            text: 'Registration starts by verifying you with Aadhaar on NHA’s own page. You enter your Aadhaar and the OTP there; Cübo never sees them. Please read NHA’s consent below.',
            fields: [
                // HPR-003/004: NHA's standard consent language, verbatim, in English or Hindi.
                { name: 'consent', type: 'consent', texts: HPR_AADHAAR_CONSENT, required: true },
            ],
            submitLabel: 'Continue to Aadhaar verification',
        }),
        aadhaarLink: (s) => ({
            text: 'Open NHA’s Aadhaar page, enter your Aadhaar number (or Virtual ID) and the OTP there, then come back here.',
            detail: `The link works until ${new Date(s.data.linkExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${s.data.renewed ? ' A new link has been made.' : ''}`,
            link: { href: s.data.linkUrl, label: 'Open Aadhaar verification (NHA)' },
            choices: [
                { value: 'done', label: 'I’ve verified on the NHA page', detail: 'Cübo checks with ABDM' },
                { value: 'renew', label: 'Get a new link', detail: 'If it expired or didn’t open' },
            ],
        }),
        mobile: () => ({
            text: 'Which mobile number should HPR use to contact you?',
            detail: 'If it is the number linked to your Aadhaar, it is confirmed at once. Otherwise ABDM sends it an OTP.',
            fields: [{ name: 'mobile', label: 'Mobile number', inputmode: 'tel', pattern: '^[6-9]\\d{9}$', hint: '10 digits', mask: 'last4', required: true }],
            submitLabel: 'Continue',
        }),
        mobileOtp: (s, d) => ({
            text: 'That number is not the one on your Aadhaar, so ABDM sent it an OTP.',
            ...(s.data.mobileResent ? { detail: 'A new OTP has been sent.' } : {}),
            fields: [{ name: 'otp', label: 'OTP', inputmode: 'numeric', pattern: '^\\d{6}$', secret: true, required: true }],
            resend: resendState(s.data.mobileSends, now(d)),
            submitLabel: 'Verify',
        }),
        identity: (s) => {
            const name = splitName(s.data.demographics);
            // HPR-027/028/029/037: name and address come from Aadhaar and cannot be edited.
            const fromAadhaar = !!(name.firstName || name.lastName);
            const kyc = kycAddress(s.data.demographics);
            const locked = { readonly: true, hint: 'From Aadhaar; cannot be changed here' };
            return {
                text: fromAadhaar ? 'Choose your HPR ID. Your name and address are taken from Aadhaar.' : 'Choose your HPR ID and enter your name as it appears on Aadhaar.',
                fields: [
                    s.data.suggestions?.length
                        ? { name: 'hprId', label: 'HPR ID', type: 'select', options: s.data.suggestions.map((v) => ({ value: v, label: `${v}@hpr.abdm` })), required: true }
                        : { name: 'hprId', label: 'HPR ID', hint: 'Letters, digits, dots and underscores', pattern: '^[A-Za-z0-9._]{4,}$', required: true },
                    { name: 'firstName', label: 'First name', value: name.firstName, required: true, ...(fromAadhaar ? locked : {}) },
                    { name: 'middleName', label: 'Middle name', value: name.middleName, ...(fromAadhaar ? locked : {}) },
                    { name: 'lastName', label: 'Last name', value: name.lastName, required: !fromAadhaar || !!name.lastName, ...(fromAadhaar ? locked : {}) },
                    ...(kyc ? [{ name: 'kycAddress', label: 'Address as per KYC', value: kyc, ...locked, wide: true }] : []),
                    { name: 'email', label: 'Email', type: 'email', value: s.data.email || '', required: true },
                    { name: 'category', label: 'You are registering as', type: 'select', options: HPR_CATEGORIES, required: true },
                ],
                submitLabel: 'Continue',
            };
        },
        jurisdiction: (s) => ({
            text: 'Your sub-category and the state you practise in.',
            fields: [
                { name: 'subCategory', label: 'System of medicine', type: 'select', options: s.data.systems.filter((o) => o.type === HPR_CATEGORIES.find((c) => c.value === s.data.form.category)?.type), required: true },
                { name: 'state', label: 'State', type: 'select', options: s.data.states, required: true },
            ],
            submitLabel: 'Continue',
        }),
        afterId: (s) => ({
            text: `${s.data.idResult?.title || 'Done'}. HPR verifies a professional from their profile: personal details, council registration, qualifications and work.`,
            detail: 'You can fill it in now, save a draft at any step, and finish later.',
            choices: [
                { value: 'profile', label: 'Complete my professional profile now' },
                { value: 'later', label: 'Later' },
            ],
        }),
        ...profilePrompts,
        finish: (s, d) => ({
            text: 'Last step: your district, your HPR role, and a password for your HPR account.',
            fields: [
                { name: 'district', label: 'District', type: 'select', options: s.data.districts, required: true },
                { name: 'role', label: 'HPR role', type: 'select', options: HPR_ROLE_OPTIONS, value: ROLE_FOR_ACCOUNT[d.account?.role] || '1', required: true },
                { name: 'council', label: 'I am registered with a medical council', type: 'checkbox' },
                { name: 'password', label: 'HPR password', type: 'password', secret: true, hint: '8+ characters with upper and lower case, a digit and a symbol', required: true },
                { name: 'confirm', label: 'Confirm password', type: 'password', secret: true, required: true },
            ],
            submitLabel: 'Create HPR ID',
        }),
    },

    // The step handlers the journey JSON names (specs/<id>.journey.json). Same bodies as the
    // LangGraph nodes they replace: an ask's (answer, state, deps), an auto/final's (state, deps).
    actions: {
        // begin
        loadLinked: async (s, d) => {
                const linked = (await d.records.get(HPR_RECORD)) || null;
                const draft = linked ? await loadDraft(d.records, linked.hprId) : null;
                return { data: { linked, email: d.account?.email, profileDraft: !!draft?.updatedAt, profileSubmitted: !!draft?.submittedAt } };
            },
        // mode
        chooseMode: async (a, s) => {
                if (a.choice === 'register' && s.data.linked) throw new Error('This account already has an HPR ID.');
                if (a.choice === 'profile' && !s.data.linked) throw new Error('Link or register an HPR ID first.');
                return { data: { mode: a.choice } };
            },
        // viewLinked: the linked HPR ID, read-only.
        viewLinked: async (s, d) => {
                const l = s.data.linked;
                const session = d.vault.hpr(d.account.id);
                return {
                    result: {
                        ok: true,
                        readonly: true,
                        title: `HPR ID ${l.hprId}`,
                        text: 'Linked to your account. It can’t be changed here.',
                        facts: [
                            ['HPR ID', l.hprId],
                            ...(l.hprIdNumber ? [['HPR number', l.hprIdNumber]] : []),
                            ...(l.name ? [['Name', l.name]] : []),
                            ['Linked', `${new Date(l.linkedAt || l.createdAt || Date.now()).toLocaleString()} (${l.via === 'registration' ? 'registered here' : 'signed in'})`],
                            ['HPR session', session ? 'Signed in for this session' : 'Not signed in'],
                        ],
                    },
                };
            },
        // login
        passwordLogin: async (a, s, d) => {
                if (s.data.linked && a.hprId.trim() !== s.data.linked.hprId) throw new Error(`This account is linked to ${s.data.linked.hprId}; sign in with that HPR ID.`);
                const res = await post(d.gateway, '/hpr/auth/password-login', { hprId: a.hprId.trim(), password: a.password });
                d.vault.setHpr(d.account.id, { token: res.token, hprId: a.hprId.trim(), expiresIn: res.expiresIn });
                return { data: { hprId: a.hprId.trim() } };
            },
        // profile
        fetchProfile: async (s, d) => {
                // A failed profile lookup doesn't undo a successful sign-in.
                try {
                    const res = await post(d.gateway, '/hpr/professional/fetch', { hprId: s.data.hprId });
                    const p = res.practitioner || res.professional || res;
                    return { data: { profileName: p?.name || p?.fullName || null } };
                } catch {
                    return { data: { profileName: null } };
                }
            },
        // linked
        saveLinked: async (s, d) => {
                const record = { hprId: s.data.hprId, name: s.data.profileName, linkedAt: new Date().toISOString(), via: 'sign-in' };
                await d.records.set(HPR_RECORD, record);
                // Sign-in alone doesn't tell us the HPR category, so this Practitioner is usually
                // incomplete for the profile; the fact line says what is missing.
                const fhir = await keepResource(d, PROVIDER_RESOURCE, providerResource({ hprId: record.hprId, name: record.name || d.account.adminName, email: d.account.email }), PROFILE.provider);
                await d.journal?.add({ journey: 'hpr', group: 'HPR', title: 'HPR ID linked', text: 'Signed in to the Healthcare Professional Registry.', facts: [['HPR ID', record.hprId]] });
                return {
                    data: {
                        linked: record,
                        idResult: {
                            ok: true,
                            readonly: true,
                            title: 'HPR ID linked',
                            text: 'You are signed in to HPR for this session, so facility registration can use it.',
                            facts: [['HPR ID', record.hprId], ...(record.name ? [['Name', record.name]] : []), fhir],
                        },
                    },
                };
            },
        // aadhaar
        startAadhaarLink: async (a, s, d) => {
                if (!a.consent?.agreed) throw new Error('Please read and agree to the consent to continue with Aadhaar.');
                const language = a.consent.language === 'hi' ? 'hi' : 'en';
                await d.records.set(AADHAAR_CONSENT_RECORD, { version: HPR_AADHAAR_CONSENT_VERSION, language, at: new Date(now(d)).toISOString() });
                const link = await post(d.gateway, '/hpr/registration/aadhaar-link', {});
                return { data: { txnId: link.txnId, linkUrl: link.url, linkExpiresAt: link.expiresAt, renewed: false } };
            },
        // aadhaarLink
        checkAadhaarLink: async (a, s, d) => {
                if (a.choice === 'renew') {
                    const link = await post(d.gateway, '/hpr/registration/aadhaar-link', {});
                    return { data: { txnId: link.txnId, linkUrl: link.url, linkExpiresAt: link.expiresAt, renewed: true } };
                }
                const status = await post(d.gateway, '/hpr/registration/aadhaar-link/status', { txnId: s.data.txnId });
                if (!status.authenticated) {
                    const expired = now(d) > new Date(s.data.linkExpiresAt).getTime();
                    throw new Error(expired ? 'The link has expired. Get a new link and verify again.' : 'NHA hasn’t confirmed your Aadhaar yet. Finish on the NHA page, then try again.');
                }
                const k = await post(d.gateway, '/hpr/registration/aadhaar-link/details', { txnId: s.data.txnId });
                return { data: { txnId: k.txnId || s.data.txnId, renewed: false, linkUrl: null, maskedMobile: k.maskedMobile, kyc: { name: k.name, gender: k.gender, birthdate: k.birthdate, address: k.address, district: k.district, state: k.state, pincode: k.pincode, photo: k.photo } } };
            },
        // checkAccount
        checkAccount: async (s, d) => {
                const res = await post(d.gateway, '/hpr/registration/check-account-exists', { txnId: s.data.txnId, preverifiedCheck: true });
                // ABDM's demographics, completed from the Aadhaar page's verified details where it is silent.
                const k = s.data.kyc || {};
                const dem = res.demographics || {};
                return { data: { hpidExists: !!res.hpidExists, kycPhoto: res.photo || null, demographics: { ...dem, name: dem.name || k.name, address: dem.address || k.address, districtName: dem.districtName || k.district, stateName: dem.stateName || k.state, pincode: dem.pincode || k.pincode } } };
            },
        // exists
        existsResult: async (s) => ({
                result: {
                    ok: false,
                    title: 'You already have an HPR ID',
                    text: 'ABDM found an HPR ID for this Aadhaar, so a new one cannot be created. Start this journey again and choose to link it.',
                    facts: s.data.demographics?.hprId ? [['HPR ID', s.data.demographics.hprId]] : [],
                },
            }),
        // mobile
        checkMobile: async (a, s, d) => {
                const mobile = String(a.mobile).trim();
                try {
                    const res = await post(d.gateway, '/hpr/registration/demographic-auth-mobile', { txnId: s.data.txnId, mobileNumber: mobile });
                    // v2 says { verified }: false means the number isn't Aadhaar's, so ABDM's OTP
                    // must verify it (HPR doc v2.0, section 2.1).
                    return { data: { mobile, mobileMatched: res.verified !== false, txnId: res.txnId || s.data.txnId } };
                } catch (e) {
                    // 502 is ABDM saying no (the number doesn't match); anything else is a real failure.
                    if (e.status !== 502) throw e;
                    return { data: { mobile, mobileMatched: false } };
                }
            },
        // sendMobileOtp
        sendMobileOtp: async (s, d) => {
                const res = await post(d.gateway, '/hpr/registration/mobile-otp', { txnId: s.data.txnId, mobile: s.data.mobile });
                return { data: { txnId: res.txnId || s.data.txnId, mobileSends: afterSend(null, now(d), false), mobileResent: false } };
            },
        // mobileOtp
        verifyMobileOtp: async (a, s, d) => {
                if (a.resend) {
                    // NHA: "Use the same api for regenerate Mobile OTP."
                    const st = resendState(s.data.mobileSends, now(d));
                    if (!st.ok) throw new Error(resendRefusal(st, now(d)));
                    const res = await post(d.gateway, '/hpr/registration/mobile-otp', { txnId: s.data.txnId, mobile: s.data.mobile });
                    return { data: { txnId: res.txnId || s.data.txnId, mobileSends: afterSend(s.data.mobileSends, now(d), true), mobileResent: true } };
                }
                const res = await post(d.gateway, '/hpr/registration/verify-mobile-otp', { txnId: s.data.txnId, otp: a.otp });
                return { data: { txnId: res.txnId || s.data.txnId, mobileResent: false } };
            },
        // loadMasters
        loadMasters: async (s, d) => {
                const [suggestions, systems, states] = await Promise.all([
                    d.gateway(`/hpr/registration/hpid-suggestions?txnId=${encodeURIComponent(s.data.txnId)}`).then(suggestionsOf).catch(() => []),
                    d.gateway('/hpr/master/system-of-medicine').then(hprSystems),
                    d.gateway('/hpr/master/states').then(hprStates),
                ]);
                if (!systems.length || !states.length) throw new Error('ABDM did not return its system-of-medicine or state lists. Try again shortly.');
                return { data: { suggestions, systems, states } };
            },
        // identity
        chooseIdentity: async (a, s) => {
                // Names from Aadhaar are taken from ABDM's response, never from the submitted form,
                // so an edited request can't change them.
                const aadhaarName = splitName(s.data.demographics);
                const name = aadhaarName.firstName || aadhaarName.lastName ? aadhaarName : { firstName: a.firstName.trim(), middleName: (a.middleName || '').trim(), lastName: (a.lastName || '').trim() };
                if (!name.firstName) throw new Error('Enter your first name as it appears on Aadhaar.');
                return { data: { form: { hprId: a.hprId, ...name, email: a.email.trim(), category: a.category } } };
            },
        // jurisdiction
        chooseJurisdiction: async (a, s) => ({ data: { form: { ...s.data.form, subCategory: a.subCategory, state: a.state } } }),
        // loadDistricts
        loadDistricts: async (s, d) => {
                const res = await d.gateway(`/hpr/master/districts/${encodeURIComponent(s.data.form.state)}`);
                const districts = hprDistricts(res);
                if (!districts.length) throw new Error('ABDM did not return districts for that state.');
                return { data: { districts } };
            },
        // finish
        createHprId: async (a, s, d) => {
                if (!HPR_PASSWORD.test(a.password)) throw new Error('The password needs 8+ characters with upper and lower case letters, a digit and a symbol.');
                if (a.password !== a.confirm) throw new Error('The passwords do not match.');
                const f = s.data.form;
                const res = await post(d.gateway, '/hpr/registration/create', {
                    txnId: s.data.txnId,
                    email: f.email,
                    password: a.password,
                    firstName: f.firstName,
                    middleName: f.middleName,
                    lastName: f.lastName,
                    hprId: f.hprId,
                    sourceType: 'AADHAAR',
                    hpCategoryCode: f.category,
                    hpSubCategoryCode: f.subCategory,
                    stateCode: (s.data.states || []).find((o) => o.value === f.state)?.lgd ?? f.state,
                    districtCode: a.district,
                    council: !!a.council,
                    // HPR-019: the photo comes from Aadhaar (the verified KYC details).
                    // profilePhoto is mandatory in doc v2.0: from the Aadhaar page, else the account check.
                    ...(s.data.kyc?.photo || s.data.kycPhoto ? { profilePhotoBase64: s.data.kyc?.photo || s.data.kycPhoto } : {}),
                    role: Number(a.role),
                });
                if (res.token) d.vault.setHpr(d.account.id, { token: res.token, hprId: res.hprId || f.hprId });
                return {
                    data: {
                        form: { ...f, district: a.district, council: !!a.council },
                        created: { hprId: res.hprId || `${f.hprId}@hpr.abdm`, hprIdNumber: res.hprIdNumber, name: res.name || `${f.firstName} ${f.lastName}` },
                    },
                };
            },
        // afterId / idDone
        chooseAfterId: async (a) => ({ data: { toProfile: a.choice === 'profile' } }),
        idResult: async (s) => ({ result: s.data.idResult }),
        ...profileActions,
        // registered
        saveRegistered: async (s, d) => {
                const c = s.data.created;
                await d.records.set(HPR_RECORD, { ...c, linkedAt: new Date().toISOString(), via: 'registration' });
                const f = s.data.form;
                const fhir = await keepResource(
                    d,
                    PROVIDER_RESOURCE,
                    providerResource({
                        ...f,
                        ...c,
                        sourceType: 'AADHAAR',
                        mobile: s.data.mobile,
                        stateCode: (s.data.states || []).find((o) => o.value === f.state)?.lgd,
                        districtCode: f.district,
                    }),
                    PROFILE.provider,
                );
                await d.journal?.add({ journey: 'hpr', group: 'HPR', title: 'HPR ID created', text: 'Registered with the Healthcare Professional Registry.', facts: [['HPR ID', c.hprId], ...(c.hprIdNumber ? [['HPR number', c.hprIdNumber]] : [])] });
                return {
                    data: {
                        linked: { ...c, via: 'registration' },
                        idResult: {
                            ok: true,
                            readonly: true,
                            title: 'HPR ID created',
                            text: 'Your HPR ID is registered. HPR verifies you once your professional profile (registration, qualifications, work) is submitted.',
                            facts: [['HPR ID', c.hprId], ...(c.hprIdNumber ? [['HPR number', c.hprIdNumber]] : []), ['Name', c.name], fhir],
                        },
                    },
                };
            },
    },
};
