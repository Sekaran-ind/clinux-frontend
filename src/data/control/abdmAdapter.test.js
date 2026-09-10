import { describe, it, expect } from 'vitest';
import {
    buildHprAadhaarOtpBody, buildHprVerifyAadhaarOtpBody, buildHprCheckAccountBody,
    buildHprDemographicAuthBody, buildHprMobileOtpBody, buildHprVerifyMobileOtpBody,
    buildHprCreateBody, buildHprPasswordLoginBody, buildHprProfessionalFetchBody,
    buildHprUpdateProfessionalBody, buildHprDocumentsListBody,
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

    it('buildHprCreateBody reads staff fields off the record and merges in the transient args, never persisting the password', () => {
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
            staff_abdm_role: 'Doctor',
        });
        const body = buildHprCreateBody(staff, { txnId: 'txn-9', selectedHpId: 'hp-123', password: 'sekret' });
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
            role: 'Doctor',
        });
    });

    it('buildHprPasswordLoginBody passes hprId/password straight through', () => {
        expect(buildHprPasswordLoginBody('hp-123', 'sekret')).toEqual({ hprId: 'hp-123', password: 'sekret' });
    });

    it('buildHprProfessionalFetchBody defaults missing fields to ""', () => {
        expect(buildHprProfessionalFetchBody(staffRecord({}))).toEqual({
            hprId: '', name: '', contactNumber: '', state: '', registrationNumber: '',
        });
    });

    it('buildHprUpdateProfessionalBody sends the real minimal subset this app already captures, with the caller\'s hprToken', () => {
        const staff = staffRecord({ staff_first_name: 'Ada', staff_last_name: 'Lovelace', staff_phone: '9876543210', staff_email: 'ada@example.com' });
        expect(buildHprUpdateProfessionalBody(staff, 'token-xyz')).toEqual({
            hprToken: 'token-xyz',
            practitioner: {
                officialMobile: '9876543210', officialEmail: 'ada@example.com',
                personalInformation: { firstName: 'Ada', lastName: 'Lovelace' },
            },
        });
    });

    it('buildHprDocumentsListBody passes hprid straight through', () => {
        expect(buildHprDocumentsListBody('71-9999-9999-1358')).toEqual({ hprid: '71-9999-9999-1358' });
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
