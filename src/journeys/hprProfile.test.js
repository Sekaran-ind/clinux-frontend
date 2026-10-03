// The HPR professional profile: payload rules (register/update-professional-new), resuming a
// draft, and a full run of the HPR journey's profile stages with a fake gateway.
import { beforeEach, describe, expect, it } from 'vitest';
import { createRunner } from './runtime.js';
import { HPR_RECORD, hprJourney } from './hprJourney.js';
import { vault } from './vault.js';
import { GatewayError } from './gateway.js';
import { ledgerOf, stagesOf } from './engine.js';
import { buildProfessional, collegeOptions, councilOptions, hprFile, missingForSubmit, profileKey, resumeAt } from './hprProfile.js';
import { isoDate } from './hprProfileSteps.js';

const account = { id: 'acc-1', clinicId: 'clinic-1', email: 'asha@example.in', role: 'admin_and_health_professional' };
const PDF = { name: 'reg.pdf', type: 'application/pdf', size: 10, value: 'JVBERi0x' };
const PNG = { name: 'deg.png', type: 'image/png', size: 10, value: 'iVBOR' };

function fakeGateway(routes) {
    const calls = [];
    const gateway = async (path, { method = 'GET', body, headers } = {}) => {
        calls.push({ method, path, body, headers });
        const key = `${method} ${path.split('?')[0]}`;
        const route = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
        if (route === undefined) throw new GatewayError(`no fake for ${key}`, { status: 404 });
        return typeof route === 'function' ? route({ path, body, headers }) : route;
    };
    return { gateway, calls };
}
const deps = (gateway, records = new Map()) => {
    const journal = [];
    return { account, gateway, vault, journal: { add: async (e) => journal.push(e) }, _journal: journal, api: async () => ({ ok: true, data: { issue: [] } }), records: { get: async (k) => records.get(k), set: async (k, v) => records.set(k, v) }, _records: records };
};

// Live sandbox shapes (2026-10-03).
const MASTERS = {
    'GET /hpr/master/languages': { data: [{ id: 1, name: ' English ', status: true }, { id: 2, name: 'Hindi', status: true }] },
    'GET /hpr/master/countries': { data: [{ id: 4, enShortName: 'Afghanistan' }, { id: 356, enShortName: 'India' }] },
    'GET /hpr/master/states': { data: [{ id: 20, name: 'Maharashtra', isoCode: '27' }, { id: 17, name: 'Karnataka', isoCode: '29' }] },
    'GET /hpr/master/system-of-medicine': { data: [{ id: 1, medicalSystem: 'Modern Medicine', hprType: 'doctor' }, { id: 9, medicalSystem: 'registered nurse (RN)', hprType: 'nurse' }] },
    'GET /hpr/master/districts/*': { data: [{ id: 500, districtName: 'Pune', isoCode: '521' }] },
    'GET /hpr/master/medical-councils': { data: [{ id: 14, name: 'Maharashtra Medical Council', stateId: '20', systemOfMedicineId: 1 }, { id: 1, name: 'Andhra Pradesh Medical Council', stateId: '2', systemOfMedicineId: 1 }] },
    'GET /hpr/master/courses': ({ path }) => (path.includes('level=additional') ? { data: [{ id: 5001, name: 'MD - General Medicine', visibleStatus: true }] } : { data: [{ id: 4060, name: 'MBBS - Bachelor of Medicine and Bachelor of Surgery', visibleStatus: true, status: true }] }),
    'GET /hpr/master/colleges/*': { data: [{ id: 35, name: 'Bharati Vidyapeeth Medical College', systemOfMedicineId: 1 }, { id: 99, name: 'An Ayurveda College', systemOfMedicineId: 4 }] },
    'GET /hpr/master/universities/*': { data: [{ id: 10, name: 'Maharashtra University of Health Sciences' }] },
    'POST /hpr/search': { success: true, matches: [{ hprIdNumber: '71-0285-6047-2578', hprId: 'asha@hpr.abdm', categoryId: '1', subCategoryId: '1' }] },
};

beforeEach(() => vault.clear());

describe('the professional profile body', () => {
    const draft = {
        meta: { hprType: 'doctor' },
        sections: {
            personal: { salutation: '1', firstName: 'Asha', lastName: 'Rao', gender: 'F', dateOfBirth: '1990-04-09', languages: ['1', '2'], nationality: '356', public: true, complete: true },
            address: { sameAsKyc: false, name: 'Asha Rao', address: '1 MG Road', country: '356', stateLgd: '27', district: '521', city: 'Pune', pincode: '411001', complete: true },
            contact: { officialMobile: '9876543210', officialEmail: 'asha@example.in', complete: true },
            registration: { systemId: '1', councilId: '14', registrationNumber: 'MMC123', registrationDate: '2015-06-01', certificate: PDF, renewable: true, dueDate: '2030-06-01', complete: true },
            work: { currentlyWorking: '1', workStatus: '0', purposes: ['Practice', 'Teaching'], facilityId: 'IN3310002300', facilityName: 'Asha Clinic', department: 'OPD', designation: 'Consultant', complete: true },
        },
        qualifications: [{ courseId: '4060', country: '356', state: '27', collegeId: '35', universityId: '10', year: '2014', certificate: PNG, complete: true }],
    };

    it('follows the doc’s field rules for a private-practice doctor', () => {
        const body = buildProfessional(draft, { hprToken: 'T', healthProfessionalType: 'doctor', mobile: '9000000000' });
        const p = body.practitioner;
        expect(body.hprToken).toBe('T');
        expect(p).toMatchObject({ healthProfessionalType: 'doctor', officialMobile: '9876543210', profileVisibleToPublic: '1' });
        expect(p.personalInformation).toMatchObject({ salutation: '1', firstName: 'Asha', gender: 'F', dateOfBirth: '1990-04-09', languagesSpoken: '1,2', nationality: '356' });
        expect(p.personalInformation.category).toBe(''); // always sent; empty for private work (HPR: "Category field is mandatory")
        expect(p.profilePhoto).toBe('');
        expect(p.communicationAddress).toMatchObject({ isCommunicationAddressAsPerKYC: '0', state: '27', district: '521', pincode: '411001' });
        const reg = p.registrationAcademic.registrationData[0];
        expect(p.registrationAcademic.category).toBe('1');
        expect(reg).toMatchObject({ registeredWithCouncil: '14', registrationNumber: 'MMC123', categoryId: '1', isPermanentOrRenewable: 'Renewable', renewableDueDate: '2030-06-01', isNameDifferentInCertificate: '0' });
        expect(reg.registrationCertificate).toEqual({ fileType: 'pdf', data: 'JVBERi0x' });
        expect(reg.qualifications[0]).toMatchObject({ nameOfDegreeOrDiplomaObtained: '4060', college: '35', university: '10', yearOfAwardingDegreeDiploma: '2014', degreeCertificate: { fileType: 'image/png', data: 'iVBOR' } });
        expect(p.currentWorkDetails).toMatchObject({ currentlyWorking: '1', purposeOfWork: 'Practice,Teaching', chooseWorkStatus: '0', reasonForNotWorking: '', certificateAttachment: '' });
        expect(p.currentWorkDetails.facilityDeclarationData).toMatchObject({ facilityId: 'IN3310002300', facilityDepartment: 'OPD', facilityDesignation: 'Consultant' });
        expect(p.currentWorkDetails.facilityDeclarationData.ministry).toBeUndefined();
        expect(missingForSubmit(draft, { mobile: '9', healthProfessionalType: 'doctor' })).toEqual(['Personal details: profile photo']);
        expect(missingForSubmit(draft, { mobile: '9', healthProfessionalType: 'doctor', profilePhoto: 'KYC' })).toEqual([]);
        expect(buildProfessional(draft, { healthProfessionalType: 'doctor', profilePhoto: 'KYC' }).practitioner.profilePhoto).toBe('KYC');
    });

    it('government work adds the ministry, the C/S category and the proof; nurses send no permanence', () => {
        const govt = { ...draft, sections: { ...draft.sections, work: { ...draft.sections.work, workStatus: '1', ministry: 'MinistryMOR ( Mo Railways )', govtCategory: 'C', certificate: PDF } } };
        const p = buildProfessional(govt, { healthProfessionalType: 'nurse' }).practitioner;
        expect(p.personalInformation.category).toBe('C');
        expect(p.currentWorkDetails.certificateAttachment).toBe('JVBERi0x');
        expect(p.currentWorkDetails.facilityDeclarationData.ministry).toEqual({ ministry: 'MinistryMOR ( Mo Railways )' });
        expect(p.registrationAcademic.registrationData[0].isPermanentOrRenewable).toBeUndefined();
    });

    it('not working: a reason and no facility; KYC address: just the flag', () => {
        const off = { ...draft, sections: { ...draft.sections, address: { sameAsKyc: true, pincode: '411001', complete: true }, work: { currentlyWorking: '0', reason: 'Other', reasonText: 'Caring for family', complete: true } } };
        const p = buildProfessional(off, { healthProfessionalType: 'doctor', kycAddress: 'Pune' }).practitioner;
        expect(p.currentWorkDetails).toEqual({ currentlyWorking: '0', purposeOfWork: '', chooseWorkStatus: '', reasonForNotWorking: 'Caring for family', certificateAttachment: '' });
        expect(p.communicationAddress).toMatchObject({ isCommunicationAddressAsPerKYC: '1', address: '', pincode: '411001' });
        expect(p.addressAsPerKYC).toBe('Pune');
    });

    it('says what is missing, and where to resume', () => {
        expect(missingForSubmit({ sections: {}, qualifications: [] }, {})).toEqual(expect.arrayContaining(['Personal details: salutation', 'Qualifications: at least one degree or diploma', 'Work details']));
        expect(resumeAt({ sections: { personal: { complete: true }, address: { complete: true } } })).toBe('contact');
        expect(resumeAt({})).toBe('personal');
        expect(hprFile(null)).toBeUndefined();
        expect(isoDate('09-04-1990')).toBe('1990-04-09');
        expect(isoDate('1990-04-09')).toBe('1990-04-09');
    });

    it('filters councils and colleges by state and system, with HPR’s "any other"', () => {
        const councils = { data: [{ id: 14, name: 'MMC', stateId: '20', systemOfMedicineId: 1 }, { id: 15, name: 'MCIM', stateId: '20', systemOfMedicineId: 4 }] };
        expect(councilOptions(councils, { stateId: '20', systemId: '1' })).toEqual([{ value: '14', label: 'MMC' }]);
        expect(collegeOptions({ data: [{ id: 1, name: 'A', systemOfMedicineId: 1 }, { id: 2, name: 'B', systemOfMedicineId: 4 }] }, { systemId: '1' }).map((o) => o.value)).toEqual(['1', '0']);
    });
});

describe('HPR journey: updates start from the registry', () => {
    // HPR's answers (doc samples), as the gateway passes them on.
    const ACCOUNT = { hprIdNumber: '71-0285-6047-2578', hprId: 'asha@hpr.abdm', firstName: 'Asha', middleName: '', lastName: 'Rao', yearOfBirth: '1990', monthOfBirth: '4', dayOfBirth: '9', gender: 'F', mobile: '9876543210', email: 'asha@example.in', address: 'Flat 1 MG Road', districtName: 'Pune', stateName: 'Maharashtra', pincode: '411001', profilePhoto: 'KYCPHOTO', kycVerified: true, categoryId: 1, categorySubId: 1 };
    const PRACTITIONER = { hpr_id: '71-0285-6047-2578', application_status: 'Pending', name: 'Asha Rao', gender: 'Female', salutation: 'Dr.', email: 'asha@example.in', communicationLanguage: 'English,Hindi',
        registrations: [{ category: 'Modern Medicine', councilName: 'Maharashtra Medical Council', registeredAt: 'Maharashtra', registrationNumber: 'MMC123', registrationDate: '2015-06-01', isRenewable: 'Permanent',
            qualifications: [{ courseName: 'MBBS - Bachelor of Medicine and Bachelor of Surgery', collegeName: 'Bharati Vidyapeeth Medical College', universityName: 'MUHS', qualificationYear: '2014' }] }],
        communication_address: { addressLine1: '1 MG Road', city: 'Pune', state: 'MAHARASHTRA', stateCode: '27', district: 'PUNE', districtCode: '521', pincode: '411001' },
        workDetails: { current_working_status: '1', nature_of_work: 'Practice', choose_work_type: 'Private only', 0: { designation_with_organisation: 'Consultant', facility: { id: 'IN3310002300', name: 'Asha Clinic', department: 'OPD' } } } };

    it('prefills from HPR’s record, keeps HPR’s photo and certificates, and sends an update', async () => {
        const { gateway, calls } = fakeGateway({
            ...MASTERS,
            'POST /hpr/account/profile': { success: true, ...ACCOUNT },
            'POST /hpr/professional/fetch': { success: true, practitioners: [[PRACTITIONER]] },
            'POST /hpr/professional/update': { success: true, body: { status: 'true', message: 'Profile updated' } },
        });
        vault.setHpr(account.id, { token: 'hpr-tok', hprId: 'asha@hpr.abdm' });
        const records = new Map([[HPR_RECORD, { hprId: 'asha@hpr.abdm', via: 'sign-in' }]]);
        // A stale local copy must not win over the registry.
        records.set(profileKey('asha@hpr.abdm'), { updatedAt: '2026-01-01T00:00:00Z', sections: { personal: { firstName: 'OLD', complete: true } }, qualifications: [] });
        const run = createRunner(hprJourney, deps(gateway, records));
        await run.start();
        const personal = await run.answer({ choice: 'profile' });
        expect(personal.prompt.step).toBe('personal'); // straight to HPR's record, no "resume the local draft"
        expect(personal.prompt.image).toBe('data:image/jpeg;base64,KYCPHOTO');
        expect(personal.prompt.fields.some((f) => f.name === 'photo')).toBe(false);
        expect(personal.prompt.fields.find((f) => f.name === 'firstName')).toMatchObject({ value: 'Asha', readonly: true });
        expect(personal.prompt.fields.find((f) => f.name === 'languages').value).toEqual(['1', '2']);
        expect(personal.prompt.fields.find((f) => f.name === 'dateOfBirth').value).toBe('1990-04-09');
        expect(calls.find((c) => c.path === '/hpr/account/profile').body).toEqual({ hprToken: 'hpr-tok' });
        expect(calls.find((c) => c.path === '/hpr/professional/fetch').body).toEqual({ hprId: '71-0285-6047-2578' });
        const kept = records.get(profileKey('asha@hpr.abdm'));
        expect(kept.sections.registration).toMatchObject({ systemId: '1', councilId: '14', registrationNumber: 'MMC123', councilState: '20' });
        expect(kept.sections.address).toMatchObject({ stateLgd: '27', district: '521', pincode: '411001', complete: true });
        expect(kept.sections.work).toMatchObject({ currentlyWorking: '1', workStatus: '0', facilityId: 'IN3310002300', designation: 'Consultant' });
        expect(kept.qualifications[0]).toMatchObject({ courseId: '4060', collegeName: 'Bharati Vidyapeeth Medical College', year: '2014' });

        // Walk on: certificates are optional (HPR keeps its own).
        await run.answer({ salutation: '1', firstName: 'x', lastName: 'x', gender: 'F', dateOfBirth: '1990-04-09', nationality: '356', languages: ['1', '2'], public: true });
        expect((await run.answer({ name: 'Asha Rao', address: '1 MG Road', country: '356', state: '20', city: 'Pune', pincode: '411001' })).prompt.step).toBe('addressDistrict');
        await run.answer({ district: '521' });
        await run.answer({ officialMobile: '9876543210', officialEmail: 'asha@example.in' });
        const regDetails = await run.answer({ systemId: '1', councilState: '20' });
        expect(regDetails.prompt.fields.find((f) => f.name === 'certificate')).toMatchObject({ required: false, hint: expect.stringMatching(/keeps the one on record/) });
        await run.answer({ councilId: '14', registrationNumber: 'MMC123', registrationDate: '2015-06-01', certificate: null, renewable: false });
        await run.answer({ courseId: '4060', country: '356', stateId: '20' });
        await run.answer({ collegeId: '35' });
        await run.answer({ universityId: '10', year: '2014', certificate: null });
        await run.answer({ choice: 'done' });
        await run.answer({ currentlyWorking: '1', workStatus: '0', purposes: ['Practice'] });
        const review = await run.answer({ facilityChoice: 'none' });
        expect(review.prompt.text).toMatch(/HPR has it \(Pending\)/);
        expect(review.prompt.warning).toBeUndefined();
        const done = await run.answer({ choice: 'submit' });
        expect(done.result.title).toBe('Profile update sent to HPR');
        const sent = calls.find((c) => c.path === '/hpr/professional/update').body;
        expect(sent.practitioner.profilePhoto).toBe('KYCPHOTO');
        expect(sent.practitioner.registrationAcademic.registrationData[0].registrationCertificate).toBeUndefined();
        expect(calls.some((c) => c.path === '/hpr/professional/register')).toBe(false);
    });
});

describe('HPR journey: professional profile', () => {
    const linked = () => new Map([[HPR_RECORD, { hprId: 'asha@hpr.abdm', name: 'Asha Rao', via: 'sign-in' }]]);
    const answerPersonal = { photo: PNG, salutation: '1', firstName: 'Asha', middleName: '', lastName: 'Rao', gender: 'F', dateOfBirth: '1990-04-09', nationality: '356', languages: ['1'], public: true, showPhoto: false };

    it('runs in stages, pauses as a draft, resumes there, and submits', async () => {
        const { gateway, calls } = fakeGateway({
            ...MASTERS,
            'POST /hpr/auth/password-login': { success: true, token: 'hpr-tok', expiresIn: 600 },
            'POST /hpr/professional/register': { success: true, body: { status: 'true', message: 'Congratulations! Your profile has been submitted successfully for verification.', referenceNumber: 'REF-1', hprId: '71-0285-6047-2578' } },
            'POST /hfr/facility/search': { success: true, facilities: [{ facilityId: 'IN3310002300', facilityName: 'Asha Clinic', address: '1 MG Road', pincode: '411001', stateLGDCode: '27', districtLGDCode: '521', facilityType: 'Clinic' }] },
        });
        const records = linked();
        const d = deps(gateway, records);
        let run = createRunner(hprJourney, d);
        const mode = await run.start();
        expect(mode.prompt.choices[0]).toMatchObject({ value: 'profile', label: 'Complete my professional profile' });
        const login = await run.answer({ choice: 'profile' });
        expect(login.prompt.step).toBe('profileLogin'); // the profile goes to HPR with the HPR session
        const personal = await run.answer({ hprId: 'asha@hpr.abdm', password: 'p' });
        expect(personal.prompt).toMatchObject({ step: 'personal', draft: true });
        expect(personal.prompt.fields.find((f) => f.name === 'firstName').value).toBe('Asha');
        // Stages in the progress menu.
        expect(stagesOf(personal.ledger).map((g) => g.stage)).toEqual(['Personal details', 'Address & contact', 'Registration', 'Qualifications', 'Work', 'Review & submit']);

        await run.answer(answerPersonal);
        // Save a draft on the address step: nothing goes to HPR, the run ends.
        const paused = await run.answer({ name: 'Asha Rao', address: '1 MG', country: '356', state: '', city: '', pincode: '', __draft: true });
        expect(paused.result).toMatchObject({ ok: true, title: 'Draft saved' });
        expect(calls.some((c) => c.path.startsWith('/hpr/professional/'))).toBe(false);
        expect(records.get(profileKey('asha@hpr.abdm')).sections.address).toMatchObject({ address: '1 MG', complete: false });

        // Later: the session is still there; the draft resumes at the address.
        run = createRunner(hprJourney, d);
        expect((await run.start()).prompt.choices[0].label).toBe('Continue my professional profile');
        const resume = await run.answer({ choice: 'profile' });
        expect(resume.prompt.step).toBe('profileResume');
        const address = await run.answer({ choice: 'continue' });
        expect(address.prompt.step).toBe('address');
        expect(address.prompt.fields.find((f) => f.name === 'address').value).toBe('1 MG');
        // The section finished on the first visit still shows (done) and can be gone back to.
        expect(address.ledger[0]).toMatchObject({ id: 'personal', state: 'done', revisit: true, stage: 'Personal details' });
        expect(stagesOf(address.ledger)).toHaveLength(6);
        const back = await run.back('personal');
        expect(back.prompt.step).toBe('personal');
        expect(back.prompt.fields.find((f) => f.name === 'dateOfBirth').value).toBe('1990-04-09');
        await run.answer(answerPersonal);
        expect((await run.answer({ name: 'Asha Rao', address: '1 MG Road', country: '356', state: '20', city: 'Pune', pincode: '411001' })).prompt.step).toBe('addressDistrict');
        expect((await run.answer({ district: '521' })).prompt.step).toBe('contact');
        expect((await run.answer({ officialMobile: '9876543210', officialEmail: 'asha@example.in', publicMobile: '', publicEmail: '', landline: '' })).prompt.step).toBe('registration');
        const details = await run.answer({ systemId: '1', councilState: '20' });
        expect(details.prompt.fields[0].options).toEqual([{ value: '14', label: 'Maharashtra Medical Council' }]);
        expect((await run.answer({ councilId: '14', registrationNumber: 'MMC123', registrationDate: '2015-06-01', certificate: null, renewable: false })).prompt.error).toMatch(/registration certificate/);
        const qual = await run.answer({ councilId: '14', registrationNumber: 'MMC123', registrationDate: '2015-06-01', certificate: PDF, renewable: false, nameDifferent: false });
        expect(qual.prompt.fields[0].options[0].label).toMatch(/MBBS/);
        const college = await run.answer({ courseId: '4060', country: '356', stateId: '20' });
        expect(college.prompt.fields[0].options.map((o) => o.value)).toEqual(['35', '0']); // Modern Medicine colleges + "any other"
        await run.answer({ collegeId: '35' });
        const more = await run.answer({ universityId: '10', month: '', year: '2014', certificate: PNG, nameDifferent: false });
        expect(more.prompt.list[0].name).toMatch(/MBBS/);
        // A second qualification offers the postgraduate courses first.
        const second = await run.answer({ choice: 'more' });
        expect(second.prompt.fields[0].options.map((o) => o.label)).toEqual(['MD - General Medicine', 'MBBS - Bachelor of Medicine and Bachelor of Surgery']);
        await run.answer({ courseId: '5001', country: '4', stateId: '' });
        expect((await run.answer({ collegeName: 'Kabul Medical University', universityName: 'Kabul University', month: '', year: '2016', certificate: PNG, nameDifferent: false })).prompt.list).toHaveLength(2);
        expect((await run.answer({ choice: 'done' })).prompt.step).toBe('work');
        const facility = await run.answer({ currentlyWorking: '1', workStatus: '0', purposes: ['Practice'], reason: '', reasonText: '' });
        expect(facility.prompt.fields[0].options.map((o) => o.value)).toEqual(['id', 'notInHfr', 'none']);
        const review = await run.answer({ facilityChoice: 'id', facilityIdTyped: 'IN3310002300', department: 'OPD', designation: 'Consultant' });
        expect(review.prompt.step).toBe('review');
        expect(review.prompt.warning).toBeUndefined();
        const done = await run.answer({ choice: 'submit' });
        expect(done.result).toMatchObject({ ok: true, readonly: true, title: 'Profile submitted to HPR', facts: expect.arrayContaining([['Reference', 'REF-1']]) });

        const sent = calls.find((c) => c.path === '/hpr/professional/register').body;
        expect(sent.hprToken).toBe('hpr-tok');
        expect(sent.practitioner.registrationAcademic.registrationData[0]).toMatchObject({ registeredWithCouncil: '14', registrationCertificate: { fileType: 'pdf', data: 'JVBERi0x' } });
        expect(sent.practitioner.currentWorkDetails.facilityDeclarationData).toMatchObject({ facilityId: 'IN3310002300', facilityName: 'Asha Clinic', facilityDepartment: 'OPD' });
        expect(records.get(profileKey('asha@hpr.abdm'))).toMatchObject({ submittedAt: expect.any(String), referenceNumber: 'REF-1' });

        expect(sent.practitioner.profilePhoto).toBe('iVBOR'); // the photo taken in Personal details
        expect(sent.practitioner.personalInformation.category).toBe('');
    });

    it('right after registering, the profile starts from the Aadhaar details (names locked, KYC address offered)', async () => {
        const { gateway } = fakeGateway({ ...MASTERS });
        vault.setHpr(account.id, { token: 't', hprId: 'asha@hpr.abdm' });
        const run = createRunner(hprJourney, deps(gateway, linked()));
        // Simulate the state a registration run reaches at afterId.
        const startAt = await run.start();
        expect(startAt.prompt.step).toBe('mode');
        const profileActions = hprJourney.actions;
        const state = { data: { linked: { hprId: 'asha@hpr.abdm' }, form: { category: '1', subCategory: '1', firstName: 'Asha', middleName: 'K', lastName: 'Rao', email: 'a@x.in' }, demographics: { address: 'Flat 1', districtName: 'Pune', stateName: 'Maharashtra', pincode: '411001', gender: 'F' }, kyc: { birthdate: '09-04-1990', photo: 'PHOTO' }, mobile: '9876543210' } };
        const d = deps(gateway, linked());
        const out = await profileActions.startProfile(state, d);
        expect(out.data.draft.meta).toMatchObject({ hprType: 'doctor', systemId: '1', aadhaarNames: true, gender: 'F', dateOfBirth: '1990-04-09', kycAddress: 'Flat 1, Pune, Maharashtra, 411001', photo: 'PHOTO', mobile: '9876543210' });
        const p = hprJourney.prompts.personal({ data: { ...state.data, draft: out.data.draft, countries: [], languages: [] } });
        expect(p.fields.find((f) => f.name === 'firstName')).toMatchObject({ value: 'Asha', readonly: true });
        const a = hprJourney.prompts.address({ data: { draft: out.data.draft } });
        expect(a.fields.find((f) => f.name === 'sameAsKyc').value).toBe(true);
    });

    it('a signed-in professional’s category comes from HPR; review lists what is still missing', async () => {
        const { gateway } = fakeGateway({ ...MASTERS, 'POST /hpr/search': { success: true, matches: [{ hprIdNumber: '71-1', categoryId: '2', subCategoryId: '9' }] } });
        vault.setHpr(account.id, { token: 't', hprId: 'asha@hpr.abdm' });
        const records = linked();
        records.set(profileKey('asha@hpr.abdm'), { updatedAt: '2026-10-03T00:00:00Z', sections: { personal: { complete: true } }, qualifications: [] });
        const run = createRunner(hprJourney, deps(gateway, records));
        await run.start();
        await run.answer({ choice: 'profile' });
        const address = await run.answer({ choice: 'continue' });
        expect(address.prompt.step).toBe('address');
        expect(records.get(profileKey('asha@hpr.abdm')).meta).toMatchObject({ hprType: 'nurse', systemId: '9' });
        // Jump to review via the ledger: it is reachable only through the steps, so check the prompt directly.
        const review = hprJourney.prompts.review({ data: { draft: records.get(profileKey('asha@hpr.abdm')), profileCtx: { healthProfessionalType: 'nurse' } } });
        expect(review.warning).toMatch(/Still needed before submitting: .*Registration/);
        expect(ledgerOf(hprJourney.spec, { visited: ['personal', 'address'], current: 'address' }).find((s) => s.id === 'address').stage).toBe('Address & contact');
    });
});

describe('HPR profile: changing a finished section', () => {
    it('going back to "Degree or diploma" edits the first qualification instead of adding one', async () => {
        const { gateway } = fakeGateway({ ...MASTERS, 'POST /hpr/account/profile': { success: true, profilePhoto: 'P', categoryId: 1, categorySubId: 1 } });
        vault.setHpr(account.id, { token: 't', hprId: 'asha@hpr.abdm' });
        const records = new Map([[HPR_RECORD, { hprId: 'asha@hpr.abdm', via: 'sign-in' }]]);
        records.set(profileKey('asha@hpr.abdm'), { updatedAt: '2026-10-03T00:00:00Z', meta: { hprType: 'doctor' }, sections: { personal: { complete: true }, address: { complete: true }, contact: { complete: true }, registration: { systemId: '1', councilState: '20', complete: true }, qualifications: { complete: true }, work: { currentlyWorking: '0', reason: 'Retired', complete: true } }, qualifications: [{ courseId: '4060', courseName: 'MBBS', stateId: '20', collegeId: '35', universityId: '10', year: '2014', certificate: PNG, complete: true }] });
        const run = createRunner(hprJourney, deps(gateway, records));
        await run.start();
        await run.answer({ choice: 'profile' });
        expect((await run.answer({ choice: 'continue' })).prompt.step).toBe('review');
        await run.back('registration');
        await run.answer({ systemId: '1', councilState: '20' });
        const qual = await run.answer({ councilId: '14', registrationNumber: 'R', registrationDate: '2015-01-01', certificate: PDF });
        expect(qual.prompt.step).toBe('qualification');
        expect(qual.prompt.fields.find((f) => f.name === 'courseId').value).toBe('4060'); // the existing degree, being edited
        await run.answer({ courseId: '4060', country: '356', stateId: '20' });
        await run.answer({ collegeId: '35' });
        const more = await run.answer({ universityId: '10', year: '2013', certificate: PNG });
        expect(more.prompt.list).toHaveLength(1);
        expect(records.get(profileKey('asha@hpr.abdm')).qualifications).toEqual([expect.objectContaining({ courseId: '4060', year: '2013', complete: true })]);
    });
});


describe('diagnosing HPR refusals', () => {
    it('the review step offers the exact request as a file, without the HPR token', async () => {
        const draft = { meta: { hprType: 'doctor', photo: 'KYC' }, sections: { personal: { firstName: 'Asha', dateOfBirth: '1990-04-09', languages: ['1'] }, work: { currentlyWorking: '0', reason: 'Retired' } }, qualifications: [] };
        const p = hprJourney.prompts.review({ data: { draft, profileCtx: {} } });
        expect(p.download).toMatchObject({ filename: 'hpr-profile-request.json' });
        const body = JSON.parse(Buffer.from(p.download.href.split(',')[1], 'base64').toString('utf8'));
        expect(body.hprToken).toBeUndefined();
        expect(body.practitioner).toMatchObject({ profilePhoto: 'KYC', personalInformation: { firstName: 'Asha', dateOfBirth: '1990-04-09', category: '' } });
    });

    it('gateway errors carry ABDM’s REQUEST-ID', async () => {
        const { gatewayErrorText } = await import('./gateway.js');
        expect(gatewayErrorText({ status: 502, data: { abdmBody: { code: 'HIS-500', message: 'An unexpected error has occurred.' }, abdmRequestId: '8f881f5d' } })).toBe('An unexpected error has occurred. (ABDM REQUEST-ID 8f881f5d)');
    });
});
