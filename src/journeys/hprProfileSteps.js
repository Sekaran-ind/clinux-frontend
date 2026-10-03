// The HPR journey's professional-profile steps (specs/hpr.journey.json, profileStart ... profileDone):
// prompts and handlers, spread into hprJourney.js. Each section is saved into the device draft
// (hprProfile.js) as it is answered; "Save draft & finish later" (prompt.draft) saves the form as it
// stands and pauses the journey. Only the final review step calls HPR: register-professional-new,
// or update-professional-new once the profile has been submitted before.
// Only used inside handlers, at run time, so the import cycle with hprJourney.js is harmless.
import { hprDistricts, hprStates, hprSystems } from './hprJourney.js';
import { loadFacilities } from './hfrFacilities.js';
import {
    GENDERS, GOVT_CATEGORY, INDIA, MONTHS, NOT_WORKING_REASONS, PURPOSES, SALUTATIONS, WORK_STATUS,
    buildProfessional, collegeOptions, metaFromAccount, sectionsFromRegistry, councilOptions, countryOptions, courseOptions, languageOptions,
    loadDraft, ministryOptions, missingForSubmit, nurseCouncilOptions, profileKey, psuOptions, resumeAt,
    saveDraft, universityOptions,
} from './hprProfile.js';

const post = (gateway, path, body, headers) => gateway(path, { method: 'POST', body, headers });
const hprIdOf = (s) => s.data.linked?.hprId || s.data.created?.hprId;
const TYPE_OF_CATEGORY = { 1: 'doctor', 2: 'nurse', 6: 'pharmacist' };
const yesNo = [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }];
const sec = (s, name) => s.data.draft?.sections?.[name] || {};
const strip = (a) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== '__draft'));

/** dd-mm-yyyy (Aadhaar KYC) or yyyy-mm-dd -> yyyy-mm-dd. */
export function isoDate(v) {
    const t = String(v ?? '').trim();
    let m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function sessionOf(d) {
    const v = d.vault.hpr(d.account.id);
    return v?.token ? v : null;
}

/** Saves one section (merging what's there), and pauses when the answer was "Save draft". */
async function keep(s, d, name, values, { complete = true, extra = {} } = {}) {
    const draft = await saveDraft(d.records, hprIdOf(s), { sections: { [name]: { ...sec(s, name), ...values, complete } }, ...extra });
    return draft;
}
const pausing = (name, run) => async (a, s, d) => {
    if (a.__draft) {
        const draft = await keep(s, d, name, strip(a), { complete: false });
        return { data: { draft, paused: true } };
    }
    return run(a, s, d);
};

/** HPR already has this professional's profile: sending it is an update (decided by the registry, not this device). */
const updating = (s) => !!s.data.draft?.registry?.hasProfile;
/** The register/update body this draft makes, as a downloadable JSON file (no HPR token). */
function requestFile(draft) {
    const m = draft.meta || {};
    const { hprToken, ...body } = buildProfessional(draft, { healthProfessionalType: m.hprType || 'doctor', kycAddress: m.kycAddress || '', profilePhoto: m.photo || '', mobile: m.mobile || '', email: m.email || '' });
    void hprToken;
    const json = JSON.stringify(body, null, 2);
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:application/json;base64,${btoa(bin)}`;
}
const professionalType = (s) => s.data.draft?.meta?.hprType || 'doctor';
const systemsFor = (s) => (s.data.systems || []).filter((o) => o.type === professionalType(s) || (professionalType(s) === 'pharmacist' && /pharm/i.test(o.label)));
// The first qualification is the basic degree; later ones are additional (postgraduate) courses,
// with the basic list too in case a basic degree was skipped.
const coursesFor = (s) => (s.data.qualIndex ? [...(s.data.coursesAdditional || []), ...(s.data.courses || [])] : s.data.courses?.length ? s.data.courses : s.data.coursesAdditional || []);
const stateLgd = (s, id) => s.data.states?.find((o) => o.value === String(id))?.lgd || '';

export const profilePrompts = {
    profileLogin: (s) => ({
        text: 'Your professional profile is sent to HPR with your HPR session. Sign in to HPR.',
        detail: 'Your password goes to ABDM through the ClinuxFlow gateway and is not stored.',
        fields: [
            { name: 'hprId', label: 'HPR ID', value: hprIdOf(s) || '', readonly: !!hprIdOf(s), required: true },
            { name: 'password', label: 'HPR password', type: 'password', secret: true, required: true },
        ],
        submitLabel: 'Sign in',
    }),
    profileResume: (s) => (s.data.draftSubmittedAt
        ? {
            text: `Your profile was submitted to HPR on ${new Date(s.data.draftSubmittedAt).toLocaleDateString()}. What you sent is kept here, so you can change it and send an update.`,
            choices: [{ value: 'continue', label: 'Review and update it' }, { value: 'restart', label: 'Start from a blank profile', detail: 'Clears what is kept on this device' }],
        }
        : {
            text: `You have a draft of your professional profile, last saved ${new Date(s.data.draftUpdatedAt).toLocaleString()}.`,
            choices: [{ value: 'continue', label: 'Continue where I left off' }, { value: 'restart', label: 'Start over', detail: 'Clears the draft on this device' }],
        }),

    personal: (s) => {
        const p = sec(s, 'personal');
        const m = s.data.draft?.meta || {};
        const fromAadhaar = !!m.aadhaarNames;
        const locked = fromAadhaar ? { readonly: true, hint: 'From Aadhaar; cannot be changed here' } : {};
        return {
            text: s.data.draft?.registry?.hasProfile ? `Personal details, as HPR has them (profile ${s.data.draft.registry.status || 'on record'}).` : 'Personal details, as HPR shows them.',
            ...(m.photo ? { image: `data:image/jpeg;base64,${m.photo}`, imageAlt: 'Your photo from Aadhaar (HPR)', detail: 'Your profile photo is the one HPR holds from Aadhaar.' } : {}),
            draft: true,
            fields: [
                // HPR refuses a profile without a photo; HPR's KYC photo is used when it has one.
                ...(m.photo ? [] : [{ name: 'photo', label: 'Profile photo', type: 'image', value: p.photo || null, required: true, hint: 'A clear photo of your face — PNG or JPEG. HPR had none on record.' }]),
                { name: 'salutation', label: 'Salutation', type: 'select', options: SALUTATIONS, value: p.salutation || (professionalType(s) === 'doctor' ? '1' : ''), required: true },
                { name: 'firstName', label: 'First name', value: p.firstName ?? m.firstName ?? '', required: true, ...locked },
                { name: 'middleName', label: 'Middle name', value: p.middleName ?? m.middleName ?? '', ...locked },
                { name: 'lastName', label: 'Last name', value: p.lastName ?? m.lastName ?? '', ...locked },
                { name: 'gender', label: 'Gender', type: 'select', options: GENDERS, value: p.gender || m.gender || '', required: true, ...(fromAadhaar && m.gender ? locked : {}) },
                { name: 'dateOfBirth', label: 'Date of birth', type: 'date', value: p.dateOfBirth || m.dateOfBirth || '', required: true, ...(fromAadhaar && m.dateOfBirth ? locked : {}) },
                { name: 'fatherName', label: 'Father’s name', value: p.fatherName || '' },
                { name: 'motherName', label: 'Mother’s name', value: p.motherName || '' },
                { name: 'spouseName', label: 'Spouse’s name', value: p.spouseName || '' },
                { name: 'nationality', label: 'Nationality', type: 'select', options: s.data.countries || [], value: p.nationality || INDIA, required: true },
                { name: 'languages', label: 'Languages you speak', type: 'multiselect', options: s.data.languages || [], value: p.languages || [], required: true },
                { name: 'public', label: 'Show my profile publicly in HPR (needed for others to verify me)', type: 'checkbox', value: p.public ?? true },
                { name: 'showPhoto', label: 'Show my photo on my public profile', type: 'checkbox', value: p.showPhoto ?? false },
            ],
            submitLabel: 'Save and continue',
        };
    },

    address: (s) => {
        const a = sec(s, 'address');
        const kyc = s.data.draft?.meta?.kycAddress;
        const hide = kyc ? { hiddenWhen: 'sameAsKyc' } : {};
        return {
            text: 'Your communication address.',
            draft: true,
            fields: [
                ...(kyc ? [
                    { name: 'kycAddress', label: 'Address as per KYC', value: kyc, readonly: true, wide: true, hint: 'From Aadhaar' },
                    { name: 'sameAsKyc', label: 'My communication address is the same as my KYC address', type: 'checkbox', value: a.sameAsKyc ?? true },
                ] : []),
                { name: 'name', label: 'Name at this address', value: a.name ?? s.data.draft?.sections?.personal?.firstName ?? '', ...hide },
                { name: 'address', label: 'Address', value: a.address || '', wide: true, ...hide },
                { name: 'country', label: 'Country', type: 'select', options: s.data.countries || [], value: a.country || INDIA, ...hide },
                { name: 'state', label: 'State / Union Territory', type: 'select', options: s.data.states || [], value: a.state || '', ...hide, hint: 'For an address in India' },
                { name: 'city', label: 'City / town / village', value: a.city || '', ...hide },
                { name: 'pincode', label: 'PIN code', inputmode: 'numeric', pattern: '^\\d{6}$', value: a.pincode || '', ...hide },
                // As in HFR: find the typed address on the map and pin it (kept with the draft).
                { name: 'geo', label: 'Pin the address on the map', type: 'geo', value: a.geo || null, ...hide, near: { fields: ['address', 'city', 'pincode', 'state'], context: ['India'] } },
            ],
            submitLabel: 'Save and continue',
        };
    },
    addressDistrict: (s) => ({
        text: 'The district of your communication address.',
        draft: true,
        fields: [{ name: 'district', label: 'District', type: 'select', options: s.data.addressDistricts || [], value: sec(s, 'address').district || '', required: true }],
        submitLabel: 'Save and continue',
    }),
    contact: (s) => {
        const c = sec(s, 'contact');
        const m = s.data.draft?.meta || {};
        return {
            text: 'How HPR and patients can reach you. The official number and email are for HPR; public ones show on your profile.',
            draft: true,
            fields: [
                { name: 'officialMobile', label: 'Official mobile', inputmode: 'tel', pattern: '^[6-9]\\d{9}$', value: c.officialMobile || m.mobile || '', mask: 'last4', required: true },
                { name: 'officialEmail', label: 'Official email', type: 'email', value: c.officialEmail || m.email || '' },
                { name: 'publicMobile', label: 'Public mobile (optional)', inputmode: 'tel', pattern: '^[6-9]\\d{9}$', value: c.publicMobile || '' },
                { name: 'publicEmail', label: 'Public email (optional)', type: 'email', value: c.publicEmail || '' },
                { name: 'landline', label: 'Landline (optional)', inputmode: 'tel', value: c.landline || '' },
            ],
            submitLabel: 'Save and continue',
        };
    },

    registration: (s) => {
        const r = sec(s, 'registration');
        return {
            text: 'Your registration with a medical, dental, AYUSH, nursing or pharmacy council.',
            draft: true,
            fields: [
                { name: 'systemId', label: 'System of medicine', type: 'select', options: systemsFor(s), value: r.systemId || s.data.draft?.meta?.systemId || '', required: true },
                { name: 'councilState', label: 'State of the council', type: 'select', options: s.data.states || [], value: r.councilState || sec(s, 'address').state || '', required: true },
            ],
            submitLabel: 'Continue',
        };
    },
    registrationDetails: (s) => {
        const r = sec(s, 'registration');
        const doctor = professionalType(s) === 'doctor';
        return {
            text: 'Your council registration.',
            ...(s.data.councilsWidened ? { detail: 'No council is listed for that state and system of medicine, so every council for the system is shown.' } : {}),
            draft: true,
            fields: [
                { name: 'councilId', label: 'Council', type: 'select', options: s.data.councils || [], value: r.councilId || '', required: true },
                { name: 'registrationNumber', label: 'Registration number', value: r.registrationNumber || '', required: true },
                { name: 'registrationDate', label: 'Registration date', type: 'date', value: r.registrationDate || '', required: true },
                { name: 'certificate', label: 'Registration certificate', type: 'file', value: r.certificate || null, required: !updating(s), ...(updating(s) ? { hint: 'HPR keeps the one on record unless you attach a new one' } : {}) },
                ...(doctor ? [
                    { name: 'renewable', label: 'My registration is renewable (not permanent)', type: 'checkbox', value: r.renewable ?? false },
                    { name: 'dueDate', label: 'Renewal due date', type: 'date', value: r.dueDate || '', hint: 'Only for a renewable registration' },
                ] : []),
                { name: 'nameDifferent', label: 'My name on the certificate is different', type: 'checkbox', value: r.nameDifferent ?? false },
                { name: 'nameProof', label: 'Proof of name change', type: 'file', value: r.nameProof || null, hint: 'Only if the name differs — PDF, PNG or JPEG, up to 5 MB' },
            ],
            submitLabel: 'Save and continue',
        };
    },

    qualification: (s) => {
        const q = s.data.draft?.qualifications?.[s.data.qualIndex] || {};
        return {
            text: s.data.qualIndex ? `Qualification ${s.data.qualIndex + 1}: the degree or diploma.` : 'Your qualifications, starting with the degree or diploma for this registration.',
            draft: true,
            fields: [
                { name: 'courseId', label: 'Degree or diploma', type: 'select', options: coursesFor(s), value: q.courseId || '', required: true },
                { name: 'country', label: 'Country where awarded', type: 'select', options: s.data.countries || [], value: q.country || INDIA, required: true },
                { name: 'stateId', label: 'State (in India)', type: 'select', options: s.data.states || [], value: q.stateId || sec(s, 'registration').councilState || '' },
            ],
            submitLabel: 'Continue',
        };
    },
    qualificationForeign: (s) => {
        const q = s.data.draft?.qualifications?.[s.data.qualIndex] || {};
        return {
            text: 'A qualification from outside India: enter the institution as on the certificate.',
            draft: true,
            fields: [
                { name: 'collegeName', label: 'College', value: q.collegeName || '', required: true },
                { name: 'universityName', label: 'University', value: q.universityName || '', required: true },
                { name: 'month', label: 'Month awarded', type: 'select', options: MONTHS, value: q.month || '' },
                { name: 'year', label: 'Year awarded', inputmode: 'numeric', pattern: '^(19|20)\\d{2}$', value: q.year || '', required: true },
                { name: 'certificate', label: 'Degree certificate', type: 'file', value: q.certificate || null, required: !updating(s) },
                { name: 'nameDifferent', label: 'My name on the certificate is different', type: 'checkbox', value: q.nameDifferent ?? false },
                { name: 'nameProof', label: 'Proof of name change', type: 'file', value: q.nameProof || null, hint: 'Only if the name differs' },
            ],
            submitLabel: 'Save qualification',
        };
    },
    qualificationCollege: (s) => ({
        text: 'Your college.',
        draft: true,
        fields: [{ name: 'collegeId', label: 'College', type: 'select', options: s.data.colleges || [], value: s.data.draft?.qualifications?.[s.data.qualIndex]?.collegeId || '', required: true }],
        submitLabel: 'Continue',
    }),
    qualificationDetails: (s) => {
        const q = s.data.draft?.qualifications?.[s.data.qualIndex] || {};
        return {
            text: 'The university, when it was awarded, and the certificate.',
            draft: true,
            fields: [
                { name: 'universityId', label: 'University', type: 'select', options: s.data.universities || [], value: q.universityId || '', required: true },
                { name: 'month', label: 'Month awarded', type: 'select', options: MONTHS, value: q.month || '' },
                { name: 'year', label: 'Year awarded', inputmode: 'numeric', pattern: '^(19|20)\\d{2}$', value: q.year || '', required: true },
                { name: 'certificate', label: 'Degree certificate', type: 'file', value: q.certificate || null, required: !updating(s) },
                { name: 'nameDifferent', label: 'My name on the certificate is different', type: 'checkbox', value: q.nameDifferent ?? false },
                { name: 'nameProof', label: 'Proof of name change', type: 'file', value: q.nameProof || null, hint: 'Only if the name differs' },
            ],
            submitLabel: 'Save qualification',
        };
    },
    qualificationMore: (s) => ({
        text: `${(s.data.draft?.qualifications || []).length} qualification${(s.data.draft?.qualifications || []).length === 1 ? '' : 's'} saved.`,
        list: (s.data.draft?.qualifications || []).map((q, i) => ({ name: `${i + 1}. ${q.courseName || 'Degree'}`, detail: [q.collegeName, q.universityName, q.year].filter(Boolean).join(' · ') })),
        choices: [{ value: 'more', label: 'Add another qualification' }, { value: 'done', label: 'Continue to work details' }],
    }),

    work: (s) => {
        const w = sec(s, 'work');
        return {
            text: 'Your current work.',
            draft: true,
            fields: [
                { name: 'currentlyWorking', label: 'Are you currently working?', type: 'select', options: yesNo, value: w.currentlyWorking || '1', required: true },
                { name: 'workStatus', label: 'Where (if working)', type: 'select', options: WORK_STATUS, value: w.workStatus || '' },
                { name: 'purposes', label: 'Nature of work (if working)', type: 'multiselect', options: PURPOSES, value: w.purposes || [] },
                { name: 'reason', label: 'Reason (if not working)', type: 'select', options: NOT_WORKING_REASONS, value: w.reason || '' },
                { name: 'reasonText', label: 'Other reason', value: w.reasonText || '' },
            ],
            submitLabel: 'Continue',
        };
    },
    workGovt: (s) => {
        const w = sec(s, 'work');
        return {
            text: 'Government work needs a proof document (a payslip or recent transfer order) and the ministry.',
            draft: true,
            fields: [
                { name: 'certificate', label: 'Proof of government work', type: 'file', value: w.certificate || null, required: true },
                s.data.ministries?.length
                    ? { name: 'ministry', label: 'Ministry', type: 'select', options: s.data.ministries, value: w.ministry || '', required: true }
                    : { name: 'ministry', label: 'Ministry', value: w.ministry || '', required: true, hint: 'HPR’s ministry list could not be loaded; type it as on your papers' },
                { name: 'govtCategory', label: 'Central or state', type: 'select', options: GOVT_CATEGORY, value: w.govtCategory || '', required: true },
                { name: 'psu', label: 'Public-sector undertaking (if you work for one)', type: 'select', options: [{ value: '', label: 'None' }, ...(s.data.psus || [])], value: w.psu || '' },
            ],
            submitLabel: 'Continue',
        };
    },
    workFacility: (s) => {
        const w = sec(s, 'work');
        const govt = s.data.workGovt;
        return {
            text: govt ? 'The facility you work at (required for government work).' : 'The facility you work at (optional for private practice).',
            draft: true,
            fields: [
                {
                    name: 'facilityChoice', label: 'Facility', type: 'select', required: true,
                    value: w.facilityChoice || '',
                    options: [
                        ...(s.data.hfrFacilities || []).map((f) => ({ value: f.facilityId, label: `${f.facilityName} — ${f.facilityId}` })),
                        { value: 'id', label: 'Another facility registered in HFR (by its id)' },
                        { value: 'notInHfr', label: 'A facility not registered in HFR' },
                        ...(govt ? [] : [{ value: 'none', label: 'I’d rather not say (private practice)' }]),
                    ],
                },
                { name: 'facilityIdTyped', label: 'HFR facility id', value: w.facilityIdTyped || '', hint: 'For “by its id”, e.g. IN3310002300' },
                { name: 'facilityState', label: 'State of the facility', type: 'select', options: s.data.states || [], value: w.facilityStateId || '', hint: 'For a facility not in HFR' },
                { name: 'department', label: 'Department', value: w.department || '' },
                { name: 'designation', label: 'Designation', value: w.designation || '' },
            ],
            submitLabel: 'Continue',
        };
    },
    workFacilityAddress: (s) => {
        const w = sec(s, 'work');
        return {
            text: 'The facility’s details, since it isn’t in HFR.',
            draft: true,
            fields: [
                { name: 'facilityName', label: 'Facility name', value: w.facilityName || '', required: true },
                { name: 'facilityAddress', label: 'Address', value: w.facilityAddress || '', wide: true, required: true },
                { name: 'facilityDistrict', label: 'District', type: 'select', options: s.data.workDistricts || [], value: w.facilityDistrict || '', required: true },
                { name: 'facilityPincode', label: 'PIN code', inputmode: 'numeric', pattern: '^\\d{6}$', value: w.facilityPincode || '', required: true },
                { name: 'facilityType', label: 'Type of facility', value: w.facilityType || '', placeholder: 'e.g. Clinic, Hospital', required: true },
                { name: 'geo', label: 'Pin the facility on the map', type: 'geo', value: w.geo || null, near: { fields: ['facilityAddress', 'facilityPincode'], context: [(s.data.states || []).find((o) => o.value === w.facilityStateId)?.label, 'India'].filter(Boolean) } },
            ],
            submitLabel: 'Continue',
        };
    },

    review: (s) => {
        const draft = s.data.draft || {};
        const missing = missingForSubmit(draft, { ...(s.data.profileCtx || {}), profilePhoto: draft.meta?.photo, updating: updating(s) });
        const sections = draft.sections || {};
        const tick = (ok) => (ok ? '✓' : '—');
        return {
            text: updating(s)
                ? `Review your profile. HPR has it (${draft.registry.status || 'on record'}); sending it updates what HPR has.`
                : 'Review your profile, then submit it to HPR for verification. HPR sends you an SMS and email when it is received.',
            list: [
                { name: `${tick(sections.personal?.complete)} Personal details`, detail: [sections.personal?.firstName, sections.personal?.lastName].filter(Boolean).join(' ') },
                { name: `${tick(sections.address?.complete)} Communication address`, detail: sections.address?.sameAsKyc ? 'Same as KYC' : [sections.address?.city, sections.address?.pincode].filter(Boolean).join(' ') },
                { name: `${tick(sections.contact?.complete)} Contact`, detail: sections.contact?.officialEmail || '' },
                { name: `${tick(sections.registration?.complete)} Registration`, detail: sections.registration?.registrationNumber || '' },
                { name: `${tick((draft.qualifications || []).length)} Qualifications`, detail: (draft.qualifications || []).map((q) => q.courseName).filter(Boolean).join(', ') },
                { name: `${tick(sections.work?.complete)} Work`, detail: sections.work?.currentlyWorking === '0' ? 'Not working' : sections.work?.facilityName || '' },
            ],
            ...(missing.length ? { warning: `Still needed before submitting: ${missing.join('; ')}. Use the progress menu to go back to a section.` } : {}),
            // The exact body (without the token), for diagnosing HPR's refusals
            // (gateway scripts/hpr-profile-probe.js) or for NHA support.
            download: { href: requestFile(draft), filename: 'hpr-profile-request.json', label: 'Download the request (for diagnosis)' },
            choices: [
                { value: 'submit', label: updating(s) ? 'Send the update to HPR' : 'Submit to HPR for verification', detail: missing.length ? 'Not yet — see what is still needed' : 'Sends everything above, with your certificates' },
                { value: 'draft', label: 'Save draft and finish later', detail: 'Nothing is sent to HPR' },
            ],
        };
    },
};

export const profileActions = {
    // profileStart: who, which session, what is already kept.
    startProfile: async (s, d) => {
        const hprId = hprIdOf(s);
        if (!hprId) throw new Error('Link or register an HPR ID first.');
        const draft = await loadDraft(d.records, hprId);
        // What the registration run knows (KYC from Aadhaar) is kept with the draft, so a later
        // visit (signed in, without the Aadhaar step) still has it.
        const dem = s.data.demographics || {};
        const kyc = s.data.kyc || {};
        const form = s.data.form || {};
        const fromRun = {
            ...(form.category ? { hprType: TYPE_OF_CATEGORY[form.category] } : {}),
            ...(form.subCategory ? { systemId: form.subCategory } : {}),
            ...(form.firstName ? { firstName: form.firstName, middleName: form.middleName, lastName: form.lastName, aadhaarNames: true } : {}),
            ...(dem.gender || kyc.gender ? { gender: dem.gender || kyc.gender } : {}),
            ...(kyc.birthdate && isoDate(kyc.birthdate) ? { dateOfBirth: isoDate(kyc.birthdate) } : {}),
            ...(dem.address ? { kycAddress: [dem.address, dem.districtName, dem.stateName, dem.pincode].filter(Boolean).join(', '), kycPincode: dem.pincode } : {}),
            ...(kyc.photo || s.data.kycPhoto ? { photo: kyc.photo || s.data.kycPhoto } : {}),
            ...(s.data.mobile ? { mobile: s.data.mobile } : {}),
            ...(form.email || d.account?.email ? { email: form.email || d.account.email } : {}),
        };
        const meta = { ...(draft.meta || {}), ...fromRun };
        if (!meta.firstName && s.data.linked?.name) {
            const parts = String(s.data.linked.name).trim().split(/\s+/);
            Object.assign(meta, { firstName: parts[0], middleName: parts.slice(1, -1).join(' '), lastName: parts.length > 1 ? parts.at(-1) : '' });
        }
        const kept = await saveDraft(d.records, hprId, { meta, ...(draft.updatedAt ? {} : { sections: {}, qualifications: [] }) });
        return {
            data: {
                draft: kept,
                hprSession: !!sessionOf(d),
                hasDraft: !!draft.updatedAt && Object.keys(draft.sections || {}).length > 0,
                draftUpdatedAt: draft.updatedAt,
                draftSubmittedAt: draft.submittedAt,
                paused: false,
            },
        };
    },
    // profileLogin
    profileSignIn: async (a, s, d) => {
        const hprId = String(a.hprId).trim();
        if (hprIdOf(s) && hprId !== hprIdOf(s)) throw new Error(`Sign in with ${hprIdOf(s)}.`);
        const res = await post(d.gateway, '/hpr/auth/password-login', { hprId, password: a.password });
        d.vault.setHpr(d.account.id, { token: res.token, hprId, expiresIn: res.expiresIn });
        return { data: { hprSession: true } };
    },
    // profileRegistry: what HPR has for this professional — the source for an update. Their own
    // account record (KYC names, date of birth, gender, contact, address, photo, category) and,
    // when HPR has a professional profile, that profile (its status says it exists; the details
    // come only if the profile is public).
    loadRegistry: async (s, d) => {
        const session = sessionOf(d);
        const hprId = hprIdOf(s);
        const account = await post(d.gateway, '/hpr/account/profile', { hprToken: session.token }).catch(() => null);
        const meta = account ? metaFromAccount(account) : {};
        const number = meta.hprIdNumber || s.data.created?.hprIdNumber || s.data.draft?.meta?.hprIdNumber;
        const fetched = number ? await post(d.gateway, '/hpr/professional/fetch', { hprId: number }).catch(() => null) : null;
        const record = (fetched?.practitioners || []).flat().find(Boolean) || null;
        const hasProfile = !!record?.application_status;
        let draft = await saveDraft(d.records, hprId, {
            meta: { ...(s.data.draft?.meta || {}), ...meta },
            registry: { hasProfile, status: record?.application_status || '', public: !record?.remarks, loadedAt: new Date().toISOString(), account: !!account },
        });
        return { data: { draft, registryRecord: hasProfile ? record : null, registryFailed: !account } };
    },
    // profileResume
    chooseResume: async (a, s, d) => {
        if (a.choice !== 'restart') return { data: { goto: s.data.draftSubmittedAt ? 'review' : resumeAt(s.data.draft) } };
        const draft = s.data.draft || {};
        const fresh = { meta: draft.meta, hprId: draft.hprId, sections: {}, qualifications: [] };
        await d.records.set(profileKey(hprIdOf(s)), JSON.parse(JSON.stringify(fresh)));
        return { data: { draft: await loadDraft(d.records, hprIdOf(s)), goto: 'personal', draftSubmittedAt: null } };
    },
    // profileMasters: the lists every section needs, and HPR's category for a signed-in professional.
    loadProfileMasters: async (s, d) => {
        const [languages, countries, states, systems] = await Promise.all([
            d.gateway('/hpr/master/languages').then(languageOptions),
            d.gateway('/hpr/master/countries').then(countryOptions),
            d.gateway('/hpr/master/states').then(hprStates),
            d.gateway('/hpr/master/system-of-medicine').then(hprSystems),
        ]);
        if (!languages.length || !states.length || !systems.length) throw new Error('HPR did not return its master lists. Try again shortly.');
        let draft = s.data.draft;
        if (!draft.meta?.hprType) {
            // Signed in rather than registered here: HPR's search says the category.
            const found = await post(d.gateway, '/hpr/search', { hprId: hprIdOf(s) }).then((r) => r.matches?.[0]).catch(() => null);
            const hprType = TYPE_OF_CATEGORY[found?.categoryId] || 'doctor';
            draft = await saveDraft(d.records, hprIdOf(s), { meta: { ...draft.meta, hprType, ...(found?.subCategoryId && !draft.meta?.systemId ? { systemId: String(found.subCategoryId) } : {}) } });
        }
        if (s.data.registryRecord) {
            // An update starts from HPR's record: names matched against the masters, certificates not
            // returned (HPR keeps the ones it has).
            const r = s.data.registryRecord;
            const doctorish = draft.meta.hprType !== 'nurse';
            const [councils, courses] = await Promise.all([
                d.gateway(doctorish ? '/hpr/master/medical-councils' : '/hpr/master/nurse-councils').then((res) => (doctorish ? councilOptions(res, {}) : nurseCouncilOptions(res, {}))).catch(() => []),
                Promise.all(['basic', 'additional'].map((level) => d.gateway(`/hpr/master/courses?hprType=${encodeURIComponent(draft.meta.hprType || 'doctor')}&level=${level}`).then(courseOptions).catch(() => []))).then((x) => x.flat()),
            ]);
            const fromHpr = sectionsFromRegistry(r, { languages, states, systems, councils, courses });
            draft = await saveDraft(d.records, hprIdOf(s), { sections: fromHpr.sections, qualifications: fromHpr.qualifications });
        }
        // The qualification to work on: the first unfinished one; when all are finished, the first
        // (going back to "Degree or diploma" edits it — "Add another" is the way to add one).
        const quals = draft.qualifications || [];
        const firstOpen = quals.findIndex((q) => !q.complete);
        const qualIndex = firstOpen >= 0 ? firstOpen : 0;
        return {
            data: {
                languages, countries, states, systems, draft, qualIndex,
                goto: s.data.registryRecord ? 'personal' : s.data.goto || resumeAt(draft),
                profileCtx: { healthProfessionalType: draft.meta.hprType, mobile: draft.meta.mobile },
            },
        };
    },

    savePersonal: pausing('personal', async (a, s, d) => {
        const languages = [].concat(a.languages || []).filter(Boolean);
        if (!languages.length) throw new Error('Choose at least one language you speak.');
        const dob = isoDate(a.dateOfBirth);
        if (!dob) throw new Error('Enter your date of birth.');
        const m = s.data.draft?.meta || {};
        // Names (and gender/date of birth) from Aadhaar come from the KYC kept with the draft, never the form.
        const names = m.aadhaarNames ? { firstName: m.firstName, middleName: m.middleName, lastName: m.lastName } : { firstName: a.firstName.trim(), middleName: (a.middleName || '').trim(), lastName: (a.lastName || '').trim() };
        const draft = await keep(s, d, 'personal', { ...strip(a), ...names, languages, dateOfBirth: dob });
        return { data: { draft, paused: false } };
    }),

    saveAddress: pausing('address', async (a, s, d) => {
        const kyc = s.data.draft?.meta?.kycAddress;
        if (kyc && a.sameAsKyc) {
            const draft = await keep(s, d, 'address', { sameAsKyc: true, pincode: s.data.draft.meta.kycPincode || '' });
            return { data: { draft, needsDistrict: false, paused: false } };
        }
        for (const [k, label] of [['name', 'Name'], ['address', 'Address'], ['country', 'Country']]) if (!String(a[k] || '').trim()) throw new Error(`${label} is required.`);
        const india = (a.country || INDIA) === INDIA;
        if (india && !a.state) throw new Error('Choose the state.');
        if (india && !/^\d{6}$/.test(String(a.pincode || ''))) throw new Error('Enter the 6-digit PIN code.');
        const values = { ...strip(a), sameAsKyc: false, stateLgd: india ? stateLgd(s, a.state) : '' };
        const draft = await keep(s, d, 'address', values, { complete: !india });
        return { data: { draft, needsDistrict: india, paused: false } };
    }),
    loadAddressDistricts: async (s, d) => {
        const districts = hprDistricts(await d.gateway(`/hpr/master/districts/${encodeURIComponent(sec(s, 'address').state)}`));
        if (!districts.length) throw new Error('HPR did not return districts for that state.');
        return { data: { addressDistricts: districts } };
    },
    saveAddressDistrict: pausing('address', async (a, s, d) => {
        const draft = await keep(s, d, 'address', { district: a.district });
        return { data: { draft, paused: false } };
    }),
    saveContact: pausing('contact', async (a, s, d) => {
        const draft = await keep(s, d, 'contact', strip(a));
        return { data: { draft, paused: false } };
    }),

    saveRegistrationCouncil: pausing('registration', async (a, s, d) => {
        const draft = await keep(s, d, 'registration', { systemId: a.systemId, councilState: a.councilState }, { complete: false });
        return { data: { draft, paused: false } };
    }),
    // loadCouncils: councils for the state and system (doctors, pharmacists) or the state (nurses),
    // and the degrees for that system (courses).
    loadCouncils: async (s, d) => {
        const r = sec(s, 'registration');
        const type = professionalType(s);
        const system = (s.data.systems || []).find((o) => o.value === String(r.systemId));
        let councils;
        let councilsWidened = false;
        if (type === 'nurse') {
            const all = await d.gateway('/hpr/master/nurse-councils');
            councils = nurseCouncilOptions(all, { stateId: r.councilState });
            if (!councils.length) { councils = nurseCouncilOptions(all, {}); councilsWidened = true; }
        } else {
            const all = await d.gateway('/hpr/master/medical-councils');
            councils = councilOptions(all, { stateId: r.councilState, systemId: r.systemId });
            if (!councils.length) { councils = councilOptions(all, { systemId: r.systemId }); councilsWidened = true; }
        }
        // Basic degrees for the first qualification, additional (postgraduate) ones after it. Nurses'
        // courses come by profession alone (with a system of medicine HPR returns none).
        const courseType = type === 'pharmacist' ? system?.type || 'doctor' : type;
        const filter = `hprType=${encodeURIComponent(courseType)}${type === 'nurse' ? '' : `&systemOfMedicine=${encodeURIComponent(system?.label || '')}`}`;
        const [courses, coursesAdditional] = await Promise.all(['basic', 'additional'].map((level) => d.gateway(`/hpr/master/courses?${filter}&level=${level}`).then(courseOptions).catch(() => [])));
        if (!councils.length) throw new Error('HPR did not return councils for that system of medicine.');
        return { data: { councils, councilsWidened, courses, coursesAdditional } };
    },
    saveRegistrationDetails: pausing('registration', async (a, s, d) => {
        if (!a.certificate?.value && !updating(s)) throw new Error('Attach your registration certificate.');
        if (a.renewable && !a.dueDate) throw new Error('Enter the renewal due date of a renewable registration.');
        if (a.nameDifferent && !a.nameProof?.value) throw new Error('Attach proof of the name change.');
        const draft = await keep(s, d, 'registration', strip(a));
        return { data: { draft, paused: false } };
    }),

    saveQualificationCourse: async (a, s, d) => {
        const quals = [...(s.data.draft?.qualifications || [])];
        const i = s.data.qualIndex ?? quals.length;
        const course = coursesFor(s).find((o) => o.value === a.courseId);
        const country = a.country || INDIA;
        if (!a.__draft && country === INDIA && !a.stateId) throw new Error('Choose the state where the degree was awarded.');
        quals[i] = { ...(quals[i] || {}), courseId: a.courseId, courseName: course?.label || quals[i]?.courseName || '', country, stateId: a.stateId || '', state: country === INDIA ? stateLgd(s, a.stateId) : '', complete: false };
        const draft = await saveDraft(d.records, hprIdOf(s), { qualifications: quals, sections: { qualifications: { complete: false } } });
        if (a.__draft) return { data: { draft, paused: true } };
        return { data: { draft, foreignQualification: country !== INDIA, paused: false } };
    },
    loadColleges: async (s, d) => {
        const q = s.data.draft.qualifications[s.data.qualIndex];
        const colleges = collegeOptions(await d.gateway(`/hpr/master/colleges/${encodeURIComponent(q.stateId)}`).catch(() => ({ data: [] })), { systemId: sec(s, 'registration').systemId });
        return { data: { colleges } };
    },
    saveQualificationCollege: async (a, s, d) => {
        const quals = [...s.data.draft.qualifications];
        const college = (s.data.colleges || []).find((o) => o.value === a.collegeId);
        quals[s.data.qualIndex] = { ...quals[s.data.qualIndex], collegeId: a.collegeId, collegeName: college?.label || '' };
        const draft = await saveDraft(d.records, hprIdOf(s), { qualifications: quals });
        return { data: { draft, paused: !!a.__draft } };
    },
    loadUniversities: async (s, d) => {
        const q = s.data.draft.qualifications[s.data.qualIndex];
        const universities = universityOptions(q.collegeId && q.collegeId !== '0' ? await d.gateway(`/hpr/master/universities/${encodeURIComponent(q.collegeId)}`).catch(() => ({ data: [] })) : { data: [] });
        return { data: { universities } };
    },
    saveQualificationDetails: async (a, s, d) => saveQualification(a, s, d, { universityId: a.universityId, universityName: (s.data.universities || []).find((o) => o.value === a.universityId)?.label || '' }),
    saveQualificationForeign: async (a, s, d) => saveQualification(a, s, d, { collegeName: a.collegeName, universityName: a.universityName, collegeId: undefined, universityId: undefined }),
    chooseQualificationMore: async (a, s) => ({ data: { addQualification: a.choice === 'more', qualIndex: a.choice === 'more' ? (s.data.draft.qualifications || []).length : s.data.qualIndex } }),

    saveWork: pausing('work', async (a, s, d) => {
        const working = a.currentlyWorking === '1';
        if (working && !a.workStatus) throw new Error('Choose where you work: private, government or both.');
        if (working && ![].concat(a.purposes || []).length) throw new Error('Choose the nature of your work.');
        if (!working && !a.reason) throw new Error('Choose why you aren’t working at present.');
        if (!working && a.reason === 'Other' && !String(a.reasonText || '').trim()) throw new Error('Enter the reason.');
        const govt = working && (a.workStatus === '1' || a.workStatus === '2');
        // Not working: nothing more to ask, so the section is complete now.
        const draft = await keep(s, d, 'work', { ...strip(a), purposes: [].concat(a.purposes || []) }, { complete: !working });
        let ministries = s.data.ministries || [];
        let psus = s.data.psus || [];
        if (govt && !ministries.length) {
            const session = sessionOf(d);
            [ministries, psus] = await Promise.all([
                session ? d.gateway('/hpr/master/ministries', { headers: { 'X-HPR-Token': session.token } }).then(ministryOptions).catch(() => []) : [],
                d.gateway('/hpr/master/psus').then(psuOptions).catch(() => []),
            ]);
        }
        const hfrFacilities = working ? (await loadFacilities(d.records).catch(() => [])).filter((f) => f.facilityId) : [];
        return { data: { draft, working, workGovt: govt, ministries, psus, hfrFacilities, paused: false } };
    }),
    saveWorkGovt: pausing('work', async (a, s, d) => {
        if (!a.certificate?.value && !updating(s)) throw new Error('Attach proof of government work.');
        const draft = await keep(s, d, 'work', strip(a), { complete: false });
        return { data: { draft, paused: false } };
    }),
    saveWorkFacility: pausing('work', async (a, s, d) => {
        const govt = s.data.workGovt;
        if (a.facilityChoice === 'none') {
            if (govt) throw new Error('Government work needs the facility you work at.');
            const draft = await keep(s, d, 'work', { facilityChoice: 'none', facilityId: '', facilityName: '' });
            return { data: { draft, needsFacilityAddress: false, paused: false } };
        }
        if (a.facilityChoice === 'notInHfr') {
            if (!a.facilityState) throw new Error('Choose the state of the facility.');
            const draft = await keep(s, d, 'work', { facilityChoice: 'notInHfr', facilityId: '', facilityStateId: a.facilityState, facilityState: stateLgd(s, a.facilityState), department: a.department, designation: a.designation }, { complete: false });
            return { data: { draft, needsFacilityAddress: true, paused: false } };
        }
        // An HFR facility (doc: department and designation are then mandatory).
        const id = String(a.facilityChoice === 'id' ? a.facilityIdTyped : a.facilityChoice).trim().toUpperCase();
        if (!/^IN[A-Z0-9]{10}$/.test(id)) throw new Error('An HFR facility id starts with IN and has 12 characters.');
        if (!String(a.department || '').trim() || !String(a.designation || '').trim()) throw new Error('Enter your department and designation at that facility.');
        const res = await post(d.gateway, '/hfr/facility/search', { facilityId: id, ownershipCode: '', stateLGDCode: '', facilityName: '', page: 1, resultsPerPage: 10 });
        const f = (res.facilities || []).find((x) => x.facilityId === id);
        if (!f) throw new Error('HFR has no facility with that id.');
        const draft = await keep(s, d, 'work', {
            facilityChoice: a.facilityChoice, facilityIdTyped: a.facilityIdTyped || '', facilityId: id, facilityName: f.facilityName, facilityAddress: f.address || '',
            facilityPincode: f.pincode || '', facilityState: f.stateLGDCode || '', facilityDistrict: f.districtLGDCode || '', facilityType: f.facilityType || '',
            department: a.department.trim(), designation: a.designation.trim(),
        });
        return { data: { draft, needsFacilityAddress: false, paused: false } };
    }),
    loadWorkDistricts: async (s, d) => ({ data: { workDistricts: hprDistricts(await d.gateway(`/hpr/master/districts/${encodeURIComponent(sec(s, 'work').facilityStateId)}`)) } }),
    saveWorkFacilityAddress: pausing('work', async (a, s, d) => {
        const draft = await keep(s, d, 'work', strip(a));
        return { data: { draft, paused: false } };
    }),

    // review: submit (or update) with the HPR session, or keep the draft.
    submitProfile: async (a, s, d) => {
        const draft = await loadDraft(d.records, hprIdOf(s));
        if (a.choice === 'draft') return { data: { draft, paused: true } };
        const m = draft.meta || {};
        const ctx = { healthProfessionalType: m.hprType || 'doctor', kycAddress: m.kycAddress || '', profilePhoto: m.photo || '', mobile: m.mobile || '', email: m.email || '' };
        const isUpdate = !!draft.registry?.hasProfile;
        const missing = missingForSubmit(draft, { ...ctx, updating: isUpdate });
        if (missing.length) throw new Error(`Still needed: ${missing.join('; ')}.`);
        const session = sessionOf(d);
        if (!session) throw new Error('Your HPR session has ended. Start this journey again and sign in; your draft is kept.');
        const updatingNow = isUpdate;
        const res = await post(d.gateway, updatingNow ? '/hpr/professional/update' : '/hpr/professional/register', buildProfessional(draft, { ...ctx, hprToken: session.token }));
        const body = res.body || res;
        if (String(body.status) === 'false' || body.error) throw new Error(body.message || body.error?.message || 'HPR did not accept the profile.');
        const kept = await saveDraft(d.records, hprIdOf(s), { submittedAt: new Date().toISOString(), referenceNumber: body.referenceNumber || draft.referenceNumber || '', sections: { review: { complete: true } } });
        await d.journal?.add({ journey: 'hpr', group: 'HPR', title: updatingNow ? 'HPR profile updated' : 'HPR profile submitted', text: body.message || 'Submitted to HPR for verification.', facts: [['HPR ID', hprIdOf(s)], ...(body.referenceNumber ? [['Reference', body.referenceNumber]] : [])] });
        return { data: { draft: kept, paused: false, submitted: { updating: updatingNow, message: body.message, referenceNumber: body.referenceNumber, hprIdNumber: body.hprId } } };
    },
    pausedResult: async (s) => {
        const sections = s.data.draft?.sections || {};
        const done = ['personal', 'address', 'contact', 'registration', 'qualifications', 'work'].filter((k) => sections[k]?.complete || (k === 'qualifications' && (s.data.draft?.qualifications || []).some((q) => q.complete)));
        return {
            result: {
                ok: true,
                title: 'Draft saved',
                text: 'Your professional profile is saved on this device. Nothing was sent to HPR. Open the HPR journey again to continue.',
                facts: [['HPR ID', hprIdOf(s) || '—'], ['Sections done', done.length ? done.join(', ') : 'none yet']],
            },
        };
    },
    profileResult: async (s) => {
        const r = s.data.submitted || {};
        return {
            result: {
                ok: true,
                readonly: true,
                title: r.updating ? 'Profile update sent to HPR' : 'Profile submitted to HPR',
                text: r.message || 'HPR verifies it with your council; you hear by SMS and email.',
                facts: [['HPR ID', hprIdOf(s)], ...(r.hprIdNumber ? [['HPR number', r.hprIdNumber]] : []), ...(r.referenceNumber ? [['Reference', r.referenceNumber]] : [])],
                again: 'Update my profile',
            },
        };
    },
};

async function saveQualification(a, s, d, place) {
    if (!a.__draft) {
        if (!a.certificate?.value && !updating(s)) throw new Error('Attach the degree certificate.');
        if (a.nameDifferent && !a.nameProof?.value) throw new Error('Attach proof of the name change.');
        const year = Number(a.year);
        if (!(year >= 1950 && year <= new Date().getFullYear())) throw new Error('Enter the year it was awarded.');
    }
    const quals = [...s.data.draft.qualifications];
    const i = s.data.qualIndex;
    quals[i] = { ...quals[i], ...place, month: a.month || '', year: a.year, certificate: a.certificate || null, nameDifferent: !!a.nameDifferent, nameProof: a.nameProof || null, complete: !a.__draft };
    const draft = await saveDraft(d.records, hprIdOf(s), { qualifications: quals, sections: { qualifications: { complete: quals.some((q) => q.complete) } } });
    return { data: { draft, paused: !!a.__draft } };
}

