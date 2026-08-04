import { describe, it, expect } from 'vitest';
import {
    buildHprAadhaarOtpBody, buildHprVerifyAadhaarOtpBody, buildHprCheckAccountBody,
    buildHprDemographicAuthBody, buildHprMobileOtpBody, buildHprVerifyMobileOtpBody,
    buildHprCreateBody, buildHprPasswordLoginBody, buildHprProfessionalFetchBody,
    buildHfrSearchBody, buildHfrBasicInfoBody, buildHfrSubmitBody,
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
});

describe('HFR body builders', () => {
    function hospitalRecord(answers) {
        return { id: 'hosp-1', data: { item: Object.entries(answers).map(([linkId, valueString]) => ({ linkId, answer: [{ valueString }] })) } };
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

    it('buildHfrBasicInfoBody maps the starter field set', () => {
        const hospital = hospitalRecord({
            hospital_name: 'City Clinic', hospital_ownership_code: 'PUB', hospital_facility_type: 'Clinic',
            hospital_operational_status: 'Active', hospital_state_lgd_code: '29', hospital_district_lgd_code: '110', hospital_pin: '560001', hospital_address: '1 Main St',
        });
        expect(buildHfrBasicInfoBody(hospital)).toMatchObject({
            facilityName: 'City Clinic', ownershipCode: 'PUB', facilityType: 'Clinic', pincode: '560001', address: '1 Main St',
        });
    });

    it('buildHfrSubmitBody defaults sourceOfInformation to "ClinixFlow" when unset', () => {
        expect(buildHfrSubmitBody(hospitalRecord({}), 'track-1')).toEqual({
            trackingId: 'track-1', sourceOfInformation: 'ClinixFlow', sourceUniqueID: '',
        });
    });
});
