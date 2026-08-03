// Adapter layer between ClinixFlow's FHIR-native records (system-hospital-profile-v1 =
// Organization, system-staff-profile-v1 = Practitioner/PractitionerRole) and the bespoke,
// non-FHIR request/response shapes the clinuxflow-abdm-gateway Worker's HPR/HFR routes expect.
//
// Plain functions, ported verbatim from clinixflow's public/js/abdm-adapter.js — only the
// getAnswer import changed (TanStack DB-backed formData.js instead of window.SystemForms).
// Every body shape here was verified directly against clinuxflow-abdm-gateway/src/routes/hpr.js
// and hfr.js source — the gateway is intentionally inconsistent about field names between
// endpoints (e.g. demographic-auth-mobile wants `mobileNumber`, mobile-otp wants `mobile`) and
// this file follows that exactly rather than "cleaning it up," since the gateway is what
// actually receives these.
//
// Aadhaar/OTP/password are never read from a persisted record here — they are NOT fields on
// system-staff-profile-v1 and are always passed in as plain arguments from the caller's
// transient page state.
import { getAnswer } from './collections/formData.js';

// ─────────────────────────────── HPR (Health Professional Registry) ───────────────────────

export function buildHprAadhaarOtpBody(aadhaar) {
  return { aadhaar };
}

export function buildHprVerifyAadhaarOtpBody(txnId, otp) {
  return { txnId, otp };
}

export function buildHprCheckAccountBody(txnId) {
  return { txnId };
}

// Note: this endpoint's field is `mobileNumber`, not `mobile` — see file header.
export function buildHprDemographicAuthBody(txnId, mobileNumber) {
  return { txnId, mobileNumber };
}

// Fallback path (Aadhaar-linked mobile didn't match) — this endpoint's field is `mobile`,
// not `mobileNumber`. Sent plaintext per the gateway's own doc-fidelity note.
export function buildHprMobileOtpBody(txnId, mobile) {
  return { txnId, mobile };
}

export function buildHprVerifyMobileOtpBody(txnId, otp) {
  return { txnId, otp };
}

// staffRecord = a system-staff-profile-v1 record. txnId/selectedHpId/password are transient,
// supplied by the caller — password is typed by the user in the moment and must never be
// stored back onto the record.
export function buildHprCreateBody(staffRecord, { txnId, selectedHpId, password }) {
  return {
    txnId,
    email: getAnswer(staffRecord, 'staff_email'),
    password,
    firstName: getAnswer(staffRecord, 'staff_first_name'),
    middleName: getAnswer(staffRecord, 'staff_middle_name'),
    lastName: getAnswer(staffRecord, 'staff_last_name'),
    hprId: selectedHpId,
    sourceType: 'AADHAAR',
    hpCategoryCode: getAnswer(staffRecord, 'staff_hp_category_code'),
    hpSubCategoryCode: getAnswer(staffRecord, 'staff_hp_subcategory_code'),
    stateCode: getAnswer(staffRecord, 'staff_state_code'),
    districtCode: getAnswer(staffRecord, 'staff_district_code'),
    council: getAnswer(staffRecord, 'staff_council') === 'true' || getAnswer(staffRecord, 'staff_council') === true,
    role: getAnswer(staffRecord, 'staff_abdm_role'),
  };
}

export function buildHprPasswordLoginBody(hprId, password) {
  return { hprId, password };
}

export function buildHprProfessionalFetchBody(staffRecord) {
  return {
    hprId: getAnswer(staffRecord, 'staff_hprid') || '',
    name: getAnswer(staffRecord, 'staff_name') || '',
    contactNumber: getAnswer(staffRecord, 'staff_phone') || '',
    state: getAnswer(staffRecord, 'staff_state_code') || '',
    registrationNumber: getAnswer(staffRecord, 'staff_license') || '',
  };
}

// ─────────────────────────────── HFR (Health Facility Registry) ───────────────────────────

export function buildHfrSearchBody(hospitalRecord, { page = 1, resultsPerPage = 10 } = {}) {
  return {
    ownershipCode: getAnswer(hospitalRecord, 'hospital_ownership_code'),
    stateLGDCode: getAnswer(hospitalRecord, 'hospital_state_lgd_code'),
    districtLGDCode: getAnswer(hospitalRecord, 'hospital_district_lgd_code') || undefined,
    subdistrictLGDCode: getAnswer(hospitalRecord, 'hospital_subdistrict_lgd_code') || undefined,
    pincode: getAnswer(hospitalRecord, 'hospital_pin') || undefined,
    facilityName: getAnswer(hospitalRecord, 'hospital_name'),
    facilityId: getAnswer(hospitalRecord, 'hospital_facility_id') || undefined,
    page,
    resultsPerPage,
  };
}

// STARTER FIELD SET — only the fields already confirmed from the gateway/approach doc are
// mapped; extend once the HFR PDF is extracted (same known-gap note as the original file).
export function buildHfrBasicInfoBody(hospitalRecord) {
  return {
    facilityName: getAnswer(hospitalRecord, 'hospital_name'),
    ownershipCode: getAnswer(hospitalRecord, 'hospital_ownership_code'),
    facilityType: getAnswer(hospitalRecord, 'hospital_facility_type'),
    facilitySubType: getAnswer(hospitalRecord, 'hospital_facility_subtype') || undefined,
    facilityOperationalStatus: getAnswer(hospitalRecord, 'hospital_operational_status'),
    stateLGDCode: getAnswer(hospitalRecord, 'hospital_state_lgd_code'),
    districtLGDCode: getAnswer(hospitalRecord, 'hospital_district_lgd_code'),
    subdistrictLGDCode: getAnswer(hospitalRecord, 'hospital_subdistrict_lgd_code') || undefined,
    pincode: getAnswer(hospitalRecord, 'hospital_pin'),
    address: getAnswer(hospitalRecord, 'hospital_address'),
  };
}

export function buildHfrAdditionalInfoBody(hospitalRecord, trackingId) {
  return { trackingId };
}

export function buildHfrDetailedInfoBody(hospitalRecord, trackingId) {
  return { trackingId };
}

export function buildHfrSubmitBody(hospitalRecord, trackingId) {
  return {
    trackingId,
    sourceOfInformation: getAnswer(hospitalRecord, 'hospital_source_of_information') || 'ClinixFlow',
    sourceUniqueID: getAnswer(hospitalRecord, 'hospital_source_unique_id'),
  };
}
