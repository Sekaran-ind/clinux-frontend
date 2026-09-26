import { describe, it, expect } from 'vitest';
import {
    buildHprAadhaarOtpBody, buildHprVerifyAadhaarOtpBody, buildHprCheckAccountBody,
    buildHprDemographicAuthBody, buildHprMobileOtpBody, buildHprVerifyMobileOtpBody,
    buildHprCreateBody, buildHprPasswordLoginBody, buildHprProfessionalFetchBody,
    buildHprUpdateProfessionalBody, buildHprRegisterProfessionalBody, buildHprDocumentsListBody, buildHprDocumentUploadBody,
    buildHprEmailGenerateOtpBody, buildHprEmailResendOtpBody, buildHprEmailVerifyOtpBody,
    buildHfrSearchBody, buildHfrBasicInfoBody, buildHfrAdditionalInfoBody, buildHfrDetailedInfoBody, buildHfrSubmitBody,
} from './abdmAdapter.js';

function staffRecord(answers) {
    return { id: 'staff-1', data: { item: Object.entries(answers).map(([linkId, valueString]) => ({ linkId, answer: [{ valueString }] })) } };
}

describe('HPR body builders', () => {
    it('buildHprAadhaarOtpBody/buildHprVerifyAadhaarOtpBody/buildHprCheckAccountBody pass their args straight through', () => {
        expect(buildHprAadhaarOtpBody('999941234567')).toEqual({ aadhaar: '999941234567' });
        expect(buildHprVerifyAadhaarOtpBody('txn-1', '123456')).toEqual({ txnId: 'txn-1', otp: '123456' });
        expect(buildHprCheckAccountBody('txn-1')).toEqual({ txnId: 'txn-1' });
    });

    // The gateway is genuinely inconsistent about this field name between the two endpoints —
    // pinning both explicitly so a future "cleanup" can't silently break either call.
    it('uses "mobileNumber" for demographic-auth but "mobile" for the mobile-OTP fallback', () => {
        expect(buildHprDemographicAuthBody('txn-1', '9876543210')).toEqual({ txnId: 'txn-1', mobileNumber: '9876543210' });
        expect(buildHprMobileOtpBody('txn-1', '9876543210')).toEqual({ txnId: 'txn-1', mobile: '9876543210' });
        expect(buildHprVerifyMobileOtpBody('txn-1', '654321')).toEqual({ txnId: 'txn-1', otp: '654321' });
    });

    it('buildHprCreateBody reads staff fields off the record, resolves role from the PAIRED PractitionerRole record, and merges in the transient args, never persisting the password', () => {
        const staff = staffRecord({
            staff_email: 'doc@example.com',
            staff_first_name: 'Ada',
            staff_middle_name: '',
            staff_last_name: 'Lovelace',
            staff_hp_category_code: 'A',
            staff_hp_subcategory_code: 'A1',
            staff_state_code: '29',
            staff_district_code: '110',
            staff_council: 'true',
        });
        const role = staffRecord({ staff_provider_role: 'Healthcare Professional' });
        const body = buildHprCreateBody(staff, role, { txnId: 'txn-9', selectedHpId: 'hp-123', password: 'sekret' });
        expect(body).toEqual({
            txnId: 'txn-9',
            email: 'doc@example.com',
            password: 'sekret',
            firstName: 'Ada',
            middleName: '',
            lastName: 'Lovelace',
            hprId: 'hp-123',
            sourceType: 'AADHAAR',
            hpCategoryCode: 'A',
            hpSubCategoryCode: 'A1',
            stateCode: '29',
            districtCode: '110',
            council: true,
            role: 1,
            profilePhotoBase64: '',
        });
    });

    it('buildHprCreateBody reuses a captured staff_photo as profilePhotoBase64, unchanged, never asking for a second upload', () => {
        const staff = staffRecord({ staff_first_name: 'Ada', staff_photo: 'base64jpegdata' });
        const role = staffRecord({ staff_provider_role: 'Facility Manager' });
        const body = buildHprCreateBody(staff, role, { txnId: 'txn-1', selectedHpId: 'hp-1', password: 'sekret' });
        expect(body.profilePhotoBase64).toBe('base64jpegdata');
        expect(body.role).toBe(2);
    });

    it('buildHprPasswordLoginBody passes hprId/password straight through', () => {
        expect(buildHprPasswordLoginBody('hp-123', 'sekret')).toEqual({ hprId: 'hp-123', password: 'sekret' });
    });

    it('buildHprProfessionalFetchBody defaults missing fields to ""', () => {
        expect(buildHprProfessionalFetchBody(staffRecord({}))).toEqual({
            hprId: '', name: '', contactNumber: '', state: '', registrationNumber: '',
        });
    });

    it('buildHprUpdateProfessionalBody maps the full practitioner profile (personal/contact/registrationAcademic/currentWorkDetails), with the caller\'s hprToken', () => {
        const staff = staffRecord({
            staff_first_name: 'Ada', staff_last_name: 'Lovelace', staff_phone: '9876543210', staff_email: 'ada@example.com',
            staff_salutation: 'Dr.', staff_gender: 'female', staff_date_of_birth: '1990-01-01', staff_languages_spoken: 'English, Hindi',
            staff_address_line: 'MG Road', staff_address_state: '27', staff_public_mobile: '9000000000',
            staff_work_currently_working: true, staff_work_purpose: 'Practice', staff_work_status: 'Private', staff_work_facility_name: 'Ruby Hall',
        });
        const qualifications = [{ staff_qual_degree_code: '4060 - MBBS (Modern Medicine)', staff_qual_college: 'Grant Medical College', staff_qual_registration_number: 'REG-1' }];
        const body = buildHprUpdateProfessionalBody(staff, qualifications, 'token-xyz');
        expect(body.hprToken).toBe('token-xyz');
        expect(body.practitioner.officialMobile).toBe('9876543210');
        expect(body.practitioner.officialEmail).toBe('ada@example.com');
        expect(body.practitioner.personalInformation).toEqual({
            salutation: 'Dr.', firstName: 'Ada', middleName: '', lastName: 'Lovelace', gender: 'female', dateOfBirth: '1990-01-01',
            nationality: '', fatherName: '', motherName: '', spouseName: '', languagesKnown: ['English', 'Hindi'],
        });
        expect(body.practitioner.communicationAddress).toEqual({ address: 'MG Road', country: '', state: '27', district: '', pincode: '' });
        expect(body.practitioner.contactInformation.publicMobile).toBe('9000000000');
        expect(body.practitioner.registrationAcademic.registrationData).toEqual([
            {
                qualification: '4060 - MBBS (Modern Medicine)', college: 'Grant Medical College', university: '', countryOfEducation: '', stateOfEducation: '', yearOfAwarding: '',
                degreeCertificate: '', degreeNameMatchesAadhaar: '', degreeNameChangeAffidavit: '',
                registeredWithCouncil: '', registrationNumber: 'REG-1', registrationDate: '', registrationCertificate: '',
                registrationNameMatchesAadhaar: '', registrationNameChangeAffidavit: '', isPermanentOrRenewable: '', renewableDueDate: '',
            },
        ]);
        expect(body.practitioner.currentWorkDetails).toEqual({
            currentlyWorking: true, purposeOfRegistration: 'Practice', teleconsultationUrl: '', chooseWorkStatus: 'Private', reasonForNotWorking: '',
            govtCategory: '', workingInPsu: '', psuName: '', govtEmploymentProof: '',
            facilityDeclarationData: { facilityName: 'Ruby Hall', facilityAddress: '', pincode: '', facilityType: '', department: '', designation: '', ministry: '' },
        });
    });

    it('buildHprUpdateProfessionalBody joins a real multi-select Nature of Work into one string, and carries the govt/PSU/teleconsultation fields', () => {
        const staff = {
            id: 'staff-1',
            data: { item: [
                { linkId: 'staff_work_purpose', answer: [{ valueString: 'Practice' }, { valueString: 'Teleconsultation' }] },
                { linkId: 'staff_work_teleconsultation_url', answer: [{ valueString: 'https://clinic.example/tc' }] },
                { linkId: 'staff_work_status', answer: [{ valueString: 'Government' }] },
                { linkId: 'staff_work_govt_category', answer: [{ valueString: 'Central' }] },
                { linkId: 'staff_work_psu_yesno', answer: [{ valueString: 'Yes' }] },
                { linkId: 'staff_work_psu_name', answer: [{ valueString: 'SAIL' }] },
                { linkId: 'staff_work_govt_proof_document', answer: [{ valueString: 'base64proof' }] },
            ] },
        };
        const body = buildHprUpdateProfessionalBody(staff, [], 'token-xyz');
        expect(body.practitioner.currentWorkDetails).toMatchObject({
            purposeOfRegistration: 'Practice, Teleconsultation', teleconsultationUrl: 'https://clinic.example/tc',
            chooseWorkStatus: 'Government', govtCategory: 'Central', workingInPsu: 'Yes', psuName: 'SAIL', govtEmploymentProof: 'base64proof',
        });
    });

    it('buildHprUpdateProfessionalBody carries each qualification\'s own name-match/affidavit answers', () => {
        const staff = staffRecord({ staff_first_name: 'Ada' });
        const qualifications = [{
            staff_qual_degree_code: '4060 - MBBS (Modern Medicine)',
            staff_qual_degree_name_matches_aadhaar: 'No', staff_qual_degree_name_change_affidavit: 'base64affidavit1',
            staff_qual_registration_name_matches_aadhaar: 'Yes', staff_qual_registration_name_change_affidavit: '',
        }];
        const body = buildHprUpdateProfessionalBody(staff, qualifications, 'token-xyz');
        expect(body.practitioner.registrationAcademic.registrationData[0]).toMatchObject({
            degreeNameMatchesAadhaar: 'No', degreeNameChangeAffidavit: 'base64affidavit1',
            registrationNameMatchesAadhaar: 'Yes', registrationNameChangeAffidavit: '',
        });
    });

    it('buildHprRegisterProfessionalBody sends the same practitioner shape as update, plus the target hprId', () => {
        const staff = staffRecord({ staff_first_name: 'Ada', staff_last_name: 'Lovelace' });
        const body = buildHprRegisterProfessionalBody(staff, [], 'token-xyz', 'hp-123');
        expect(body.hprToken).toBe('token-xyz');
        expect(body.hprId).toBe('hp-123');
        expect(body.practitioner.personalInformation.firstName).toBe('Ada');
        expect(body.practitioner.registrationAcademic.registrationData).toEqual([]);
    });

    it('buildHprDocumentsListBody passes hprid straight through', () => {
        expect(buildHprDocumentsListBody('71-9999-9999-1358')).toEqual({ hprid: '71-9999-9999-1358' });
    });

    it('buildHprDocumentUploadBody omits documentId when not given, includes it when given', () => {
        expect(buildHprDocumentUploadBody('token-xyz', 'hp-123', 'profilePhoto', 'base64data')).toEqual({
            hprToken: 'token-xyz', hprId: 'hp-123', documentType: 'profilePhoto', documentBase64: 'base64data',
        });
        expect(buildHprDocumentUploadBody('token-xyz', 'hp-123', 'degreeCertificate', 'base64data', 'doc-42')).toEqual({
            hprToken: 'token-xyz', hprId: 'hp-123', documentType: 'degreeCertificate', documentBase64: 'base64data', documentId: 'doc-42',
        });
    });

    it('buildHprEmailGenerateOtpBody/ResendOtpBody/VerifyOtpBody use the real hpr_token field name and otp_type', () => {
        expect(buildHprEmailGenerateOtpBody('tok-1', 'a@b.com')).toEqual({ hpr_token: 'tok-1', emailAddress: 'a@b.com', otp_type: 'official' });
        expect(buildHprEmailResendOtpBody('tok-1', 'a@b.com')).toEqual({ hpr_token: 'tok-1', emailAddress: 'a@b.com', otp_type: 'official' });
        expect(buildHprEmailVerifyOtpBody('tok-1', 'hp-1', 'a@b.com', '123456')).toEqual({ hpr_token: 'tok-1', hprId: 'hp-1', officialEmail: 'a@b.com', emailOtp: '123456' });
    });
});

describe('HFR body builders', () => {
    // Boolean-valued answers (hospital_has_*, Checkbox uiComponent) need valueBoolean, not
    // valueString (see formData.js's own extractAnswerValue) — a plain object value opts a field
    // into that instead of the default string wrapping.
    function hospitalRecord(answers) {
        return {
            id: 'hosp-1',
            data: {
                item: Object.entries(answers).map(([linkId, value]) => (
                    typeof value === 'boolean'
                        ? { linkId, answer: [{ valueBoolean: value }] }
                        : { linkId, answer: [{ valueString: value }] }
                )),
            },
        };
    }

    it('buildHfrSearchBody defaults page/resultsPerPage and drops optional fields to undefined when blank', () => {
        const hospital = hospitalRecord({ hospital_ownership_code: 'PUB', hospital_state_lgd_code: '29', hospital_name: 'City Clinic' });
        expect(buildHfrSearchBody(hospital)).toEqual({
            ownershipCode: 'PUB',
            stateLGDCode: '29',
            districtLGDCode: undefined,
            subdistrictLGDCode: undefined,
            pincode: undefined,
            facilityName: 'City Clinic',
            facilityId: undefined,
            page: 1,
            resultsPerPage: 10,
        });
    });

    it('buildHfrSearchBody honors explicit page/resultsPerPage overrides', () => {
        const body = buildHfrSearchBody(hospitalRecord({}), { page: 3, resultsPerPage: 25 });
        expect(body.page).toBe(3);
        expect(body.resultsPerPage).toBe(25);
    });

    // Real nested shape, grounded against New_HFR_APIs_Documentation_SBX.pdf §2.1's own sample —
    // pins the structural fix (facilityInformation.facilityAddressDetails/
    // facilityContactInformation), not just individual field values.
    it('buildHfrBasicInfoBody builds the real nested facilityInformation shape', () => {
        const hospital = hospitalRecord({
            hospital_name: 'City Clinic', hospital_ownership_code: 'PUB', hospital_facility_type: 'Clinic',
            hospital_state_lgd_code: '29', hospital_district_lgd_code: '110', hospital_pin: '560001', hospital_address: '1 Main St',
            hospital_system_of_medicine: 'M',
        });
        const body = buildHfrBasicInfoBody(hospital);
        expect(body.facilityInformation.facilityName).toBe('City Clinic');
        expect(body.facilityInformation.facilityAddressDetails).toMatchObject({
            country: 'India', stateLGDCode: '29', districtLGDCode: '110', pincode: '560001', addressLine1: '1 Main St',
        });
        expect(body.facilityInformation.ownershipCode).toBe('PUB');
        expect(body.facilityInformation.facilityTypeCode).toBe('Clinic');
        expect(body.facilityInformation.systemOfMedicineCode).toBe('M');
        expect(body.facilityInformation.facilityOperationalStatus).toBe('F'); // default, unset
        expect(body.facilityInformation.specialityTypeCode).toBe('SINGLE'); // default
    });

    it('buildHfrBasicInfoBody joins a real MultiSelect systemOfMedicine (multiple answer entries on one item) into one comma string', () => {
        const hospital = { id: 'hosp-1', data: { item: [{ linkId: 'hospital_system_of_medicine', answer: [{ valueString: 'M' }, { valueString: 'D' }] }] } };
        expect(buildHfrBasicInfoBody(hospital).facilityInformation.systemOfMedicineCode).toBe('M,D');
    });

    it('buildHfrBasicInfoBody sends an empty facilityAddressProof array when no proof was attached', () => {
        expect(buildHfrBasicInfoBody(hospitalRecord({})).facilityInformation.facilityAddressProof).toEqual([]);
    });

    it('buildHfrBasicInfoBody includes the real single-entry facilityAddressProof shape once a proof is attached', () => {
        const addressProof = { type: 'PAN', file: { name: 'proof.pdf', value: 'base64data' } };
        const body = buildHfrBasicInfoBody(hospitalRecord({}), { addressProof });
        expect(body.facilityInformation.facilityAddressProof).toEqual([
            { addressProofType: 'PAN', addressProofAttachment: { name: 'proof.pdf', value: 'base64data' } },
        ]);
    });

    it('buildHfrAdditionalInfoBody defaults every hasX flag to N — the real, valid body for a typical small clinic', () => {
        expect(buildHfrAdditionalInfoBody(hospitalRecord({}), 'track-1')).toMatchObject({
            trackingId: 'track-1',
            generalInformation: {
                hasDialysisCenter: 'N', hasPharmacy: 'N', hasBloodBank: 'N', hasCathLab: 'N', hasDiagnosticLab: 'N', hasImagingCenter: 'N',
            },
        });
    });

    // Real bug found and fixed: these are NOT plain Y/N booleans — get-master-data
    // type='GENERAL-INFO-OPTIONS' has 3 real codes (YALL/YIN/N), confirmed against the doc's own
    // worked sample ("hasDialysisCenter": "YALL").
    it('buildHfrAdditionalInfoBody passes through a real captured GENERAL-INFO-OPTIONS code as-is', () => {
        const hospital = hospitalRecord({ hospital_has_pharmacy: 'YALL', hospital_has_blood_bank: 'N' });
        const body = buildHfrAdditionalInfoBody(hospital, 'track-1');
        expect(body.generalInformation.hasPharmacy).toBe('YALL');
        expect(body.generalInformation.hasBloodBank).toBe('N');
    });

    it('buildHfrAdditionalInfoBody mirrors captured imaging services into servicesByImagingCenter', () => {
        const hospital = { id: 'hosp-1', data: { item: [{ linkId: 'hospital_imaging_services', answer: [{ valueString: 'S136' }, { valueString: 'S137' }] }] } };
        const body = buildHfrAdditionalInfoBody(hospital, 'track-1');
        expect(body.generalInformation.servicesByImagingCenter).toEqual([{ service: 'S136', count: 1 }, { service: 'S137', count: 1 }]);
    });

    it('buildHfrAdditionalInfoBody reads real linkedProgramIds off the record instead of always-empty stubs', () => {
        const hospital = hospitalRecord({
            hospital_linked_nhrr_id: 'NHRR-1', hospital_linked_nin: 'NIN-1', hospital_linked_abpmjay_id: 'PMJAY-1',
            hospital_linked_rohini_id: 'ROH-1', hospital_linked_cghs_id: 'CGHS-1', hospital_linked_echs_id: 'ECHS-1',
            hospital_linked_cea_registration: 'CEA-1', hospital_linked_state_insurance_id: 'SIS-1',
        });
        expect(buildHfrAdditionalInfoBody(hospital, 'track-1').linkedProgramIds).toEqual({
            nhrrId: 'NHRR-1', nin: 'NIN-1', abpmjayId: 'PMJAY-1', rohiniId: 'ROH-1',
            echsId: 'ECHS-1', cghsId: 'CGHS-1', ceaRegistration: 'CEA-1', stateInsuranceSchemeId: 'SIS-1',
        });
    });

    // Real, doc-confirmed behavior: sending a conditional section for a facility that doesn't
    // offer that service is REJECTED by the real API, not ignored — so each section here is
    // genuinely conditional on the matching hasX flag, not always-included.
    it('buildHfrDetailedInfoBody sends only {trackingId} when no hasX service is offered', () => {
        expect(buildHfrDetailedInfoBody(hospitalRecord({}), 'track-1')).toEqual({ trackingId: 'track-1' });
    });

    it('buildHfrDetailedInfoBody includes pharmacyDetails only when hasPharmacy is YALL/YIN', () => {
        const offering = hospitalRecord({ hospital_has_pharmacy: 'YALL', hospital_pharmacy_drug_license: 'DL-123' });
        expect(buildHfrDetailedInfoBody(offering, 'track-1').pharmacyDetails).toMatchObject({ drugLicenseNumber: 'DL-123' });

        const notOffering = hospitalRecord({ hospital_has_pharmacy: 'N', hospital_pharmacy_drug_license: 'DL-123' });
        expect(buildHfrDetailedInfoBody(notOffering, 'track-1').pharmacyDetails).toBeUndefined();
    });

    it('buildHfrDetailedInfoBody includes imagingServices/diagnosticServices only when their hasX flag is offered', () => {
        const hospital = {
            id: 'hosp-1',
            data: {
                item: [
                    { linkId: 'hospital_has_imaging_center', answer: [{ valueString: 'YALL' }] },
                    { linkId: 'hospital_imaging_services', answer: [{ valueString: 'S136' }, { valueString: 'S137' }] },
                    { linkId: 'hospital_has_diagnostic_lab', answer: [{ valueString: 'N' }] },
                    { linkId: 'hospital_diagnostic_services', answer: [{ valueString: 'S212' }] },
                ],
            },
        };
        const body = buildHfrDetailedInfoBody(hospital, 'track-1');
        expect(body.imagingServices).toEqual([{ service: 'S136', count: 1 }, { service: 'S137', count: 1 }]);
        expect(body.diagnosticServices).toBeUndefined(); // hasDiagnosticLab is 'N' — not offered
    });

    it('buildHfrDetailedInfoBody includes medicalInfrastructure only when a real bed/chair count was captured', () => {
        expect(buildHfrDetailedInfoBody(hospitalRecord({}), 'track-1').medicalInfrastructure).toBeUndefined();
        const withBeds = hospitalRecord({ hospital_total_beds: '20', hospital_dental_chairs: '2' });
        expect(buildHfrDetailedInfoBody(withBeds, 'track-1').medicalInfrastructure).toMatchObject({ totalNumberOfBeds: 20, countDentalChairs: 2 });
    });

    // Real bug found and fixed: sourceOfInformation used to default to the literal string
    // 'ClinixFlow', not a real HFR SOURCE code at all — the doc's own real semantics say an EMPTY
    // value here is correct for a self-registering facility ("considered as Submitted entity").
    it('buildHfrSubmitBody leaves sourceOfInformation/sourceUniqueID genuinely unset when the record has no value, never a made-up default', () => {
        expect(buildHfrSubmitBody(hospitalRecord({}), 'track-1')).toEqual({
            trackingId: 'track-1', sourceOfInformation: undefined, sourceUniqueID: undefined,
        });
    });

    it('buildHfrSubmitBody passes through a real captured sourceOfInformation/sourceUniqueID', () => {
        const hospital = hospitalRecord({ hospital_source_of_information: 'NHRR', hospital_source_unique_id: 'NHRR-123' });
        expect(buildHfrSubmitBody(hospital, 'track-1')).toEqual({
            trackingId: 'track-1', sourceOfInformation: 'NHRR', sourceUniqueID: 'NHRR-123',
        });
    });
});
