// The HPR professional profile (NHA HPR test cases HPR-026..077; "Register Healthcare Professional"
// doc §8, register-professional-new / update-professional-new): what the HPR journey collects
// after an HPR ID is created or linked, kept as a DRAFT on this device until it is submitted.
//
// HPR has no server-side draft for the profile (one call submits it "for verification"), so the
// draft lives in the account's IndexedDB records (accountRecords), one per HPR ID, section by
// section; certificates included. After submission the same record keeps what was sent (with
// submittedAt), so a later update starts from it and goes to update-professional-new.
//
// Pure helpers only (no gateway calls), so they get real tests: masters -> options, the draft
// store, where to resume, and the request body.

export const profileKey = (hprId) => `abdm:hpr:profile:${String(hprId || '').toLowerCase()}`;

/** Sections in order; `resumeAt` returns the first one the draft hasn't finished. */
export const SECTIONS = ['personal', 'address', 'contact', 'registration', 'qualifications', 'work', 'review'];

export async function loadDraft(records, hprId) {
    return (await records.get(profileKey(hprId))) || { sections: {}, qualifications: [] };
}

/** Merges `patch` into the draft and stores it; returns the stored draft. */
export async function saveDraft(records, hprId, patch, now = new Date()) {
    const current = await loadDraft(records, hprId);
    const next = {
        ...current,
        ...patch,
        sections: { ...current.sections, ...(patch.sections || {}) },
        hprId,
        updatedAt: now.toISOString(),
    };
    await records.set(profileKey(hprId), JSON.parse(JSON.stringify(next)));
    return next;
}

export function resumeAt(draft = {}) {
    const done = draft.sections || {};
    return SECTIONS.find((s) => !done[s]?.complete) || 'review';
}

// HPR-026: salutation "from master data" (NHA's master Excel, not published with the API docs).
// Codes as the doc's sample uses them (1 with a doctor's profile); confirm 2 and 3 against the
// Excel before production.
export const SALUTATIONS = [
    { value: '1', label: 'Dr.' },
    { value: '2', label: 'Mr.' },
    { value: '3', label: 'Ms.' },
];
export const GENDERS = [{ value: 'M', label: 'Male' }, { value: 'F', label: 'Female' }, { value: 'O', label: 'Other' }];
export const INDIA = '356';
// purposeOfWork: "nature of work" — "Adminstrative,Teaching,Practice" (doc table; several allowed).
export const PURPOSES = [{ value: 'Administrative', label: 'Administrative' }, { value: 'Teaching', label: 'Teaching' }, { value: 'Practice', label: 'Practice' }];
// chooseWorkStatus: 0 private, 1 government only, 2 both (doc table).
export const WORK_STATUS = [{ value: '0', label: 'Private' }, { value: '1', label: 'Government only' }, { value: '2', label: 'Both government and private' }];
// HPR-073: reason for not working (master sheet + free text).
export const NOT_WORKING_REASONS = ['Higher studies', 'Retired', 'Career break', 'Personal reasons', 'Other'].map((v) => ({ value: v, label: v }));
// personalInformation.category for government work: C central, S state.
export const GOVT_CATEGORY = [{ value: 'C', label: 'Central government' }, { value: 'S', label: 'State government' }];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m) => ({ value: m, label: m }));

// ── Masters (live sandbox shapes, 2026-10-03) -> [{ value, label, ... }] ─────────────────────
const list = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);
const label = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
export const languageOptions = (res) => list(res).filter((e) => e.status !== false).map((e) => ({ value: String(e.id), label: label(e.name) }));
export const countryOptions = (res) => list(res).map((e) => ({ value: String(e.id), label: label(e.enShortName ?? e.name) })).sort((a, b) => (a.value === INDIA ? -1 : b.value === INDIA ? 1 : a.label.localeCompare(b.label)));
export const subDistrictOptions = (res) => list(res).map((e) => ({ value: String(e.isoCode ?? e.id), label: label(e.subDistrictName ?? e.name) }));
/** Medical councils for a state and system of medicine (doctors, pharmacists). */
export const councilOptions = (res, { stateId, systemId }) => list(res)
    .filter((e) => (!stateId || String(e.stateId) === String(stateId)) && (!systemId || String(e.systemOfMedicineId) === String(systemId)))
    .map((e) => ({ value: String(e.id), label: label(e.name) }));
/** Nurse councils for a state. */
export const nurseCouncilOptions = (res, { stateId }) => list(res).filter((e) => e.visibleStatus !== false && (!stateId || String(e.stateId) === String(stateId))).map((e) => ({ value: String(e.id), label: label(e.name) }));
export const courseOptions = (res) => list(res).filter((e) => e.visibleStatus !== false && e.status !== false).map((e) => ({ value: String(e.id), label: label(e.name) }));
/** Colleges in a state, for a system of medicine; "Any other" is HPR's 0. */
export const collegeOptions = (res, { systemId }) => [
    ...list(res).filter((e) => e.visibleStatus !== false && (!systemId || !e.systemOfMedicineId || String(e.systemOfMedicineId) === String(systemId))).map((e) => ({ value: String(e.id), label: label(e.name) })),
    { value: '0', label: 'Any other (not listed)' },
];
export const universityOptions = (res) => [...list(res).map((e) => ({ value: String(e.id), label: label(e.name) })), { value: '0', label: 'Any other (not listed)' }];
export const ministryOptions = (res) => list(res).map((e) => label(e.ministry ?? e.name)).filter(Boolean).map((m) => ({ value: m, label: m }));
export const psuOptions = (res) => list(res).map((e) => ({ value: String(e.value ?? e.name), label: label(e.value ?? e.name) }));

// ── The request body ─────────────────────────────────────────────────────────────────────────
/** A picked file ({ name, type, value }) as HPR's { fileType, data }; the doc's samples send "pdf" for a PDF. */
export function hprFile(f) {
    if (!f?.value) return undefined;
    return { fileType: f.type === 'application/pdf' ? 'pdf' : f.type, data: f.value };
}
const yesNo = (v) => (v ? '1' : '0');
const s = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * The register-professional-new / update-professional-new body (they share one schema) from the
 * draft. `ctx`: { hprToken, healthProfessionalType, kycAddress, profilePhoto, mobile, email }.
 * Rules from the doc's field table and notes:
 *  - communication address fields only when not "as per KYC";
 *  - isPermanentOrRenewable for doctors only, renewableDueDate when Renewable;
 *  - facilityDeclarationData required for government/both, sent for private only when given;
 *  - personalInformation.category always: C/S for government/both work, '' for private (HPR
 *    refuses the profile without the field); the ministry only for government/both;
 *  - profilePhoto is mandatory: HPR's KYC photo (ctx.profilePhoto) or the one taken here;
 *  - reasonForNotWorking only when not working.
 */
export function buildProfessional(draft, ctx) {
    const p = draft.sections?.personal || {};
    const a = draft.sections?.address || {};
    const c = draft.sections?.contact || {};
    const r = draft.sections?.registration || {};
    const w = draft.sections?.work || {};
    const doctor = ctx.healthProfessionalType === 'doctor';
    const govt = w.currentlyWorking === '1' && (w.workStatus === '1' || w.workStatus === '2');
    const working = w.currentlyWorking === '1';
    const sameAsKyc = !!a.sameAsKyc && !!ctx.kycAddress;

    const facility = w.facilityId || w.facilityName
        ? {
            facilityId: s(w.facilityId),
            facilityName: s(w.facilityName),
            facilityAddress: s(w.facilityAddress),
            facilityPincode: s(w.facilityPincode),
            state: s(w.facilityState),
            district: s(w.facilityDistrict),
            facilityType: s(w.facilityType),
            facilityDepartment: s(w.department),
            facilityDesignation: s(w.designation),
            ...(govt ? { ministry: { ministry: s(w.ministry) }, areYouWorkingForPsu: w.psu ? '1' : '0', psuName: s(w.psu) } : {}),
        }
        : null;

    return {
        hprToken: ctx.hprToken,
        practitioner: {
            healthProfessionalType: ctx.healthProfessionalType,
            apiClientId: '',
            // Mandatory (live 2026-10-03: "ProfilePhoto is mandatory"): HPR's own KYC photo, else the
            // one taken in Personal details.
            profilePhoto: s(ctx.profilePhoto || p.photo?.value),
            officialMobileCode: '',
            officialMobile: s(c.officialMobile || ctx.mobile),
            officialMobileStatus: '',
            officialEmail: s(c.officialEmail || ctx.email),
            officialEmailStatus: '',
            visibleProfilePicture: p.showPhoto ? '1' : '0',
            profileVisibleToPublic: p.public === false ? '0' : '1',
            personalInformation: {
                salutation: s(p.salutation),
                firstName: s(p.firstName),
                middleName: s(p.middleName),
                lastName: s(p.lastName),
                nationality: s(p.nationality || INDIA),
                fatherName: s(p.fatherName),
                motherName: s(p.motherName),
                spouseName: s(p.spouseName),
                gender: s(p.gender),
                dateOfBirth: s(p.dateOfBirth),
                placeOfBirthState: '',
                district: '',
                subDistrict: '',
                city: '',
                languagesSpoken: [].concat(p.languages || []).join(','),
                // Always sent (live 2026-10-03: "Category field is mandatory"): C/S for government
                // or both, empty for private.
                category: govt ? s(w.govtCategory) : '',
            },
            addressAsPerKYC: s(ctx.kycAddress),
            communicationAddress: sameAsKyc
                ? { isCommunicationAddressAsPerKYC: '1', address: '', name: '', country: '', state: '', district: '', subDistrict: '', city: '', pincode: s(a.pincode) }
                : {
                    isCommunicationAddressAsPerKYC: '0',
                    address: s(a.address),
                    name: s(a.name),
                    country: s(a.country || INDIA),
                    state: s(a.stateLgd),
                    district: s(a.district),
                    subDistrict: s(a.subDistrict),
                    city: s(a.city),
                    pincode: s(a.pincode),
                },
            contactInformation: {
                publicMobileNumber: s(c.publicMobile),
                publicMobileNumberCode: '',
                publicMobileNumberStatus: '',
                landLineNumber: s(c.landline),
                landLineNumberCode: '',
                publicEmail: s(c.publicEmail),
                publicEmailStatus: '',
            },
            registrationAcademic: {
                category: s(r.systemId),
                registrationData: [
                    {
                        registeredWithCouncil: s(r.councilId),
                        registrationNumber: s(r.registrationNumber),
                        registrationDate: s(r.registrationDate),
                        ...(hprFile(r.certificate) ? { registrationCertificate: hprFile(r.certificate) } : {}),
                        ...(doctor ? { isPermanentOrRenewable: r.renewable ? 'Renewable' : 'Permanent', renewableDueDate: r.renewable ? s(r.dueDate) : '' } : {}),
                        categoryId: s(r.systemId),
                        isNameDifferentInCertificate: yesNo(r.nameDifferent),
                        proofOfNameChangeCertificate: r.nameDifferent ? s(r.nameProof?.value) : '',
                        qualifications: (draft.qualifications || []).map((q) => ({
                            nameOfDegreeOrDiplomaObtained: s(q.courseId || q.courseName),
                            country: s(q.country || INDIA),
                            state: s(q.state),
                            college: s(q.collegeId ?? q.collegeName),
                            university: s(q.universityId ?? q.universityName),
                            yearOfAwardingDegreeDiploma: s(q.year),
                            monthOfAwardingDegreeDiploma: s(q.month),
                            ...(hprFile(q.certificate) ? { degreeCertificate: hprFile(q.certificate) } : {}),
                            isNameDifferentInCertificate: yesNo(q.nameDifferent),
                            proofOfNameChangeCertificate: q.nameDifferent ? s(q.nameProof?.value) : '',
                        })),
                    },
                ],
            },
            specialities: null,
            currentWorkDetails: {
                currentlyWorking: working ? '1' : '0',
                purposeOfWork: working ? [].concat(w.purposes || []).join(',') : '',
                chooseWorkStatus: working ? s(w.workStatus) : '',
                reasonForNotWorking: working ? '' : s(w.reason === 'Other' ? w.reasonText : w.reason),
                certificateAttachment: govt ? s(w.certificate?.value) : '',
                ...(facility && working ? { facilityDeclarationData: facility } : {}),
            },
        },
    };
}

/** What is missing before the profile can be submitted (HPR's mandatory fields), as sentences. */
export function missingForSubmit(draft, ctx) {
    const p = draft.sections?.personal || {};
    const r = draft.sections?.registration || {};
    const w = draft.sections?.work || {};
    const quals = draft.qualifications || [];
    const out = [];
    if (!p.salutation) out.push('Personal details: salutation');
    if (!ctx.profilePhoto && !p.photo?.value) out.push('Personal details: profile photo');
    if (!p.firstName) out.push('Personal details: first name');
    if (!p.gender || !p.dateOfBirth) out.push('Personal details: gender and date of birth');
    if (![].concat(p.languages || []).length) out.push('Personal details: languages spoken');
    if (!draft.sections?.address?.complete) out.push('Communication address');
    if (!(draft.sections?.contact?.officialMobile || ctx.mobile)) out.push('Contact: official mobile number');
    if (!r.systemId || !r.councilId || !r.registrationNumber || !r.registrationDate) out.push('Registration: system of medicine, council, number and date');
    // An update of a profile HPR already has keeps the certificates HPR holds unless new ones are attached.
    if (!r.certificate && !ctx.updating) out.push('Registration: registration certificate');
    if (ctx.healthProfessionalType === 'doctor' && r.renewable && !r.dueDate) out.push('Registration: renewal due date');
    if (!quals.length) out.push('Qualifications: at least one degree or diploma');
    for (const [i, q] of quals.entries()) if (!q.year || !(q.courseId || q.courseName) || (!q.certificate && !ctx.updating)) out.push(`Qualification ${i + 1}: degree, year${ctx.updating ? '' : ' and certificate'}`);
    if (!w.complete) out.push('Work details');
    else if (w.currentlyWorking === '1' && (w.workStatus === '1' || w.workStatus === '2')) {
        if (!w.certificate && !ctx.updating) out.push('Work: proof of government work (payslip, transfer order…)');
        if (!w.facilityId && !w.facilityName) out.push('Work: the facility you work at');
        if (!w.department || !w.designation) out.push('Work: department and designation');
    }
    return out;
}

// ── From the registry (updates start from what HPR has, never from this device) ─────────────────
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const byLabel = (options = [], label) => options.find((o) => norm(o.label) === norm(label))?.value || '';
const GENDER_OF = { male: 'M', female: 'F', other: 'O', m: 'M', f: 'F', o: 'O' };
const pad = (n) => String(n).padStart(2, '0');

/** HPR's account/information (the professional's own KYC record) -> the draft's `meta`. */
export function metaFromAccount(acc = {}) {
    const photo = acc.profilePhoto || acc.photo || acc.kycPhoto || '';
    const dob = acc.yearOfBirth && acc.monthOfBirth && acc.dayOfBirth ? `${acc.yearOfBirth}-${pad(acc.monthOfBirth)}-${pad(acc.dayOfBirth)}` : '';
    const address = [acc.address, acc.villageName || acc.townName, acc.districtName, acc.stateName, acc.pincode].map((x) => String(x ?? '').trim()).filter(Boolean);
    return {
        ...(acc.hprIdNumber ? { hprIdNumber: acc.hprIdNumber } : {}),
        ...(acc.firstName || acc.lastName ? { firstName: acc.firstName || '', middleName: acc.middleName || '', lastName: acc.lastName || '', aadhaarNames: !!acc.kycVerified } : {}),
        ...(acc.gender ? { gender: GENDER_OF[norm(acc.gender)] || acc.gender } : {}),
        ...(dob ? { dateOfBirth: dob } : {}),
        ...(acc.mobile && !/x|\*/i.test(acc.mobile) ? { mobile: acc.mobile } : {}),
        ...(acc.email && !/x{3}|\*/i.test(acc.email) ? { email: acc.email } : {}),
        ...(address.length ? { kycAddress: [...new Set(address)].join(', '), kycPincode: String(acc.pincode || '') } : {}),
        ...(photo ? { photo } : {}),
        ...(acc.categoryId ? { hprType: { 1: 'doctor', 2: 'nurse', 6: 'pharmacist' }[acc.categoryId] || undefined } : {}),
        ...(acc.categorySubId ? { systemId: String(acc.categorySubId) } : {}),
    };
}

/**
 * HPR's fetch-professional-info record -> draft sections, matched against the masters by name
 * where HPR answers with names (council, system of medicine, course, language). What HPR doesn't
 * return (certificates, ids it gives only as names) stays empty, and the review says so.
 * `m`: { languages, states, systems, councils, courses }.
 */
export function sectionsFromRegistry(pr = {}, m = {}) {
    const reg = (pr.registrations || [])[0] || {};
    const addr = pr.communication_address || {};
    const work = pr.workDetails || {};
    const job = work['0'] || (Array.isArray(work.list) ? work.list[0] : null) || {};
    const fac = job.facility || {};
    const working = String(work.current_working_status ?? '') === '1';
    const status = { 'private only': '0', private: '0', 'government only': '1', government: '1', both: '2' }[norm(work.choose_work_type)] ?? '';
    const state = (m.states || []).find((o) => String(o.lgd) === String(addr.stateCode));
    const languages = String(pr.communicationLanguage || '').split(',').map((l) => byLabel(m.languages, l)).filter(Boolean);
    const systemId = byLabel(m.systems, reg.category) || '';
    const names = String(pr.name || '').split(/\s+/);
    return {
        sections: {
            personal: {
                salutation: byLabel(SALUTATIONS, pr.salutation) || '',
                ...(pr.name && !String(pr.name).includes('*') ? { firstName: names[0], lastName: names.slice(1).join(' ') } : {}),
                gender: GENDER_OF[norm(pr.gender)] || '',
                languages,
                public: String(pr.profileVisibleToPublic ?? '1') !== '0',
                complete: false,
            },
            address: addr.pincode ? { sameAsKyc: false, name: pr.name || '', address: [addr.addressLine1, addr.addressLine2].filter(Boolean).join(', '), country: INDIA, state: state?.value || '', stateLgd: String(addr.stateCode || ''), district: String(addr.districtCode || ''), city: addr.city || '', pincode: String(addr.pincode), complete: !!(state && addr.districtCode) } : { complete: false },
            contact: { officialEmail: pr.email && !pr.email.includes('*') ? pr.email : '', complete: false },
            registration: reg.registrationNumber ? {
                systemId,
                councilId: byLabel(m.councils, reg.councilName),
                councilState: (m.states || []).find((o) => norm(o.label) === norm(reg.registeredAt))?.value || '',
                registrationNumber: reg.registrationNumber,
                registrationDate: String(reg.registrationDate || '').slice(0, 10),
                renewable: norm(reg.isRenewable) === 'renewable',
                dueDate: String(reg.dueDate || '').slice(0, 10),
                complete: false,
            } : { complete: false },
            work: work.current_working_status !== undefined ? {
                currentlyWorking: working ? '1' : '0',
                workStatus: status,
                purposes: String(work.nature_of_work || '').split(',').map((x) => PURPOSES.find((p) => norm(p.value) === norm(x))?.value).filter(Boolean),
                ...(fac.id ? { facilityChoice: 'id', facilityIdTyped: fac.id, facilityId: fac.id, facilityName: fac.name || '', facilityAddress: fac.facility_address || fac.address || '', facilityPincode: String(fac.facility_pincode || ''), facilityType: fac.type || '', department: fac.department || '', designation: job.designation_with_organisation || '' } : {}),
                complete: false,
            } : { complete: false },
        },
        qualifications: (reg.qualifications || pr.qualifications || []).map((q) => ({
            courseId: byLabel(m.courses, q.courseName), courseName: q.courseName || '', country: INDIA,
            collegeId: '0', collegeName: q.collegeName || '', universityId: '0', universityName: q.universityName || '',
            year: String(q.qualificationYear || ''), month: q.qualificationMonth || '', complete: false,
        })),
    };
}
