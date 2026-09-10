// Adapter layer between ClinixFlow's FHIR-native records (section_hospital = Organization,
// section_staff = Practitioner, both groups inside the single system-provider-composition-v1
// record post-merge — see clinux-provider-composition-merge memory note) and the bespoke,
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
// Every function here still just calls getAnswer(record, linkId) on whatever full-record-shaped
// object the caller passes in — unaffected by the Provider-composition merge; callers are
// responsible for wrapping bare repeating-group instances as { data: instance } first (see
// AbdmOnboarding.vue's staffRecord()).
//
// Aadhaar/OTP/password are never read from a persisted record here — they are NOT fields on
// section_staff and are always passed in as plain arguments from the caller's transient page
// state.
import { getAnswer, getAnswers } from '../collections/formData.js';

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

// staffRecord = one section_staff group instance, wrapped as { data: instance } by the caller.
// txnId/selectedHpId/password are transient, supplied by the caller — password is typed by the
// user in the moment and must never be stored back onto the record.
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

// "3. Update healthcare professional API.pdf" — the real update-professional-new body is a huge
// nested structure (practitioner/personalInformation/communicationAddress/registrationAcademic
// with per-qualification base64 certificate uploads/currentWorkDetails/facilityDeclarationData —
// 60+ fields across several real government forms). Building full capture UI for all of it is a
// genuinely separate, large profile-management feature, out of proportion for "finish the
// pending onboarding items" — this deliberately covers only the subset already captured
// elsewhere in this app (name/mobile/email, all already on section_staff), sent as a real,
// minimal, valid update rather than either skipping the endpoint or attempting the full form.
// Untested against whether the real API accepts a genuinely partial update vs. requiring the
// whole nested structure on every call — same "structurally correct, not live-tested with real
// government credentials" honesty this app's other HPR/HFR/ABHA work already carries.
export function buildHprUpdateProfessionalBody(staffRecord, hprToken) {
  return {
    hprToken,
    practitioner: {
      officialMobile: getAnswer(staffRecord, 'staff_phone') || '',
      officialEmail: getAnswer(staffRecord, 'staff_email') || '',
      personalInformation: {
        firstName: getAnswer(staffRecord, 'staff_first_name') || '',
        lastName: getAnswer(staffRecord, 'staff_last_name') || '',
      },
    },
  };
}

// "4. Update_Professional_Documents.pdf" — despite the filename, the doc only documents
// RETRIEVAL (fetch-documents-list), no separate upload endpoint exists (confirmed by reading the
// whole doc, not assumed missing).
export function buildHprDocumentsListBody(hprid) {
  return { hprid };
}

// "5. Generate, regenerate & verify Email link API-1.pdf" — real 3-step flow, parallel to the
// existing mobile-OTP one above. Every step needs hprToken (the caller's own per-user token from
// password-login/Aadhaar-OTP/mobile-OTP login), not the facility-manager x-hprid-auth header HFR
// uses — a genuinely different auth convention for this API family.
export function buildHprEmailGenerateOtpBody(hprToken, emailAddress) {
  return { hpr_token: hprToken, emailAddress, otp_type: 'official' };
}
export function buildHprEmailResendOtpBody(hprToken, emailAddress) {
  return { hpr_token: hprToken, emailAddress, otp_type: 'official' };
}
export function buildHprEmailVerifyOtpBody(hprToken, hprId, officialEmail, emailOtp) {
  return { hpr_token: hprToken, hprId, officialEmail, emailOtp };
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

// Real body shape, grounded directly against New_HFR_APIs_Documentation_SBX.pdf §2.1's own worked
// samples this session — replaces a flat "STARTER FIELD SET" that never matched the real API at
// all (it's genuinely nested: facilityInformation.facilityAddressDetails/
// facilityContactInformation, not top-level fields). facilityOperationalStatus here is the doc's
// own real F/TC/CL/UC status CODE (hospital_operational_status_code, FAC-STATUS master) — a
// different field from Organization.active (hospital_operational_status, this profile's own
// derived boolean, see the YAML's own comment on that distinction). country is hard-fixed to
// 'India' — the doc's own sample error response rejects anything else ("Country should be
// india"), and HFR is India-only by definition. facilityAddressProof/abdmCompliantSoftware are
// sent as real, valid empty structures (confirmed against the doc's own samples, which do the
// same) — address-proof document capture is a real, separate scope (out of this pass, same
// "extend when a real caller needs it" discipline as detailed-information's specialities
// section). facilityUploads.facilityBoardPhoto/facilityBuildingPhoto ARE real now — passed in by
// the caller (FacilityHfrPanel.vue's own base64 FileReader capture), not a permanent stub.
export function buildHfrBasicInfoBody(hospitalRecord, { boardPhoto, buildingPhoto } = {}) {
  // MultiSelect (hospital_system_of_medicine) writes one array slot per selection on the SAME
  // item — getAnswer() (singular) only ever reads answer[0], so a real multi-selection needs
  // getAnswers() (plural) here, same distinction this app's own MultiSelect fix already
  // established elsewhere (see the YAML's own comment on hospital_system_of_medicine).
  const systemsOfMedicine = getAnswers(hospitalRecord, 'hospital_system_of_medicine');
  return {
    facilityInformation: {
      facilityName: getAnswer(hospitalRecord, 'hospital_name'),
      facilityAddressDetails: {
        country: 'India',
        stateLGDCode: getAnswer(hospitalRecord, 'hospital_state_lgd_code'),
        districtLGDCode: getAnswer(hospitalRecord, 'hospital_district_lgd_code'),
        subDistrictLGDCode: getAnswer(hospitalRecord, 'hospital_subdistrict_lgd_code'),
        facilityRegion: getAnswer(hospitalRecord, 'hospital_facility_region') || 'U',
        villageCityTownLGDCode: '',
        addressLine1: getAnswer(hospitalRecord, 'hospital_address'),
        addressLine2: getAnswer(hospitalRecord, 'hospital_city') || '',
        pincode: getAnswer(hospitalRecord, 'hospital_pin'),
        latitude: getAnswer(hospitalRecord, 'hospital_geo_latitude'),
        longitude: getAnswer(hospitalRecord, 'hospital_geo_longitude'),
      },
      facilityContactInformation: {
        facilityEmailId: getAnswer(hospitalRecord, 'hospital_email') || '',
        facilityContactNumber: getAnswer(hospitalRecord, 'hospital_phone') || '',
        websiteLink: getAnswer(hospitalRecord, 'hospital_website') || '',
        facilityLandlineNumber: '',
        facilityStdCode: '',
      },
      ownershipCode: getAnswer(hospitalRecord, 'hospital_ownership_code'),
      ownershipSubTypeCode: getAnswer(hospitalRecord, 'hospital_ownership_subtype_code'),
      ownershipSubTypeCode2: getAnswer(hospitalRecord, 'hospital_ownership_subtype_code_2') || undefined,
      typeOfServiceCode: getAnswer(hospitalRecord, 'hospital_type_of_service_code') || undefined,
      specialityTypeCode: getAnswer(hospitalRecord, 'hospital_speciality_type_code') || 'SINGLE',
      // Real HFR wire format wants one comma-joined string (doc's own sample: "M,D") — this
      // profile models it as a real repeating extension instead (ClinuxFlowFacility.json's own
      // comment); join at the adapter boundary, same reasoning the hasX Y/N conversion above uses.
      systemOfMedicineCode: systemsOfMedicine.join(','),
      facilityTypeCode: getAnswer(hospitalRecord, 'hospital_facility_type'),
      facilityUploads: {
        facilityBoardPhoto: boardPhoto ? { name: boardPhoto.name, value: boardPhoto.value } : { name: '', value: '' },
        facilityBuildingPhoto: buildingPhoto ? { name: buildingPhoto.name, value: buildingPhoto.value } : { name: '', value: '' },
      },
      facilityAddressProof: [],
      facilitySubType: getAnswer(hospitalRecord, 'hospital_facility_subtype') || undefined,
      facilityOperationalStatus: getAnswer(hospitalRecord, 'hospital_operational_status_code') || 'F',
      timingsOfFacility: [],
      abdmCompliantSoftware: [{ existingSoftwares: [], anyOther: getAnswer(hospitalRecord, 'hospital_abdm_software_code') || '' }],
    },
  };
}

// Real body, grounded against New_HFR_APIs_Documentation_SBX.pdf §2.2 (read directly, not
// guessed) — replaces the old "known-gap" stub (SPEC-09 §7). hasX flags default 'N' (the correct,
// valid value for a typical small clinic offering none of these — confirmed via the doc's own
// error-response sample, which rejects an omitted/invalid flag the same as a wrong one) rather
// than leaving them unset; linkedProgramIds are all genuinely optional national-scheme ids no
// clinic has at onboarding time, sent empty.
export function buildHfrAdditionalInfoBody(hospitalRecord, trackingId) {
  // Real bug found and fixed: these are NOT plain Y/N booleans — get-master-data
  // type='GENERAL-INFO-OPTIONS' has 3 real codes (YALL/YIN/N), confirmed against the doc's own
  // worked sample ("hasDialysisCenter": "YALL"). hospital_has_* now capture the real code
  // directly (TextInput, driven by a real dropdown in FacilityHfrPanel.vue), so this is a
  // straight passthrough with an 'N' default, not a boolean-to-string conversion anymore.
  const flag = (linkId) => getAnswer(hospitalRecord, linkId) || 'N';
  // Real, doc-confirmed quirk: Additional Information's own generalInformation carries a SECOND,
  // separate imaging-services list (servicesByImagingCenter, {service,count} pairs) alongside
  // Detailed Information's own imagingServices below — genuinely two different fields across the
  // two APIs per the doc's own parameter table, not a duplication error on this app's part.
  // Reuses the SAME captured field (hospital_imaging_services) for both rather than asking the
  // user to enter the same list twice.
  const imagingCodes = getAnswers(hospitalRecord, 'hospital_imaging_services');
  return {
    trackingId,
    generalInformation: {
      hasDialysisCenter: flag('hospital_has_dialysis_center'),
      hasPharmacy: flag('hospital_has_pharmacy'),
      hasBloodBank: flag('hospital_has_blood_bank'),
      hasCathLab: flag('hospital_has_cath_lab'),
      hasDiagnosticLab: flag('hospital_has_diagnostic_lab'),
      hasImagingCenter: flag('hospital_has_imaging_center'),
      servicesByImagingCenter: imagingCodes.map((service) => ({ service, count: 1 })),
    },
    linkedProgramIds: {
      nhrrId: '', nin: '', abpmjayId: '', rohiniId: '', echsId: '', cghsId: '', ceaRegistration: '', stateInsuranceSchemeId: '',
    },
  };
}

// Real body, grounded against the same doc §2.3 — every conditional section (pharmacy/blood-bank/
// imaging/diagnostic/medical-infrastructure) is "Yes, if facility type/service is X" per the
// doc's own parameter table, and the doc's own error-response sample confirms sending a section
// a facility doesn't need is REJECTED, not just ignored ("X are not required for this facility
// type"). Each section below is included only when the matching Additional Information hasX flag
// is YALL/YIN — `{trackingId}` alone (no sections) is still the real, correct, doc-valid body for
// a facility that declared none of them (the common small-clinic case this app targets per
// SPEC-10), not a stub.
//
// Deliberately NOT included: `specialities` (requires HFR's real get-specialities master
// endpoint, which is returning real HIS-500 errors on the sandbox as of this build — no reliable
// source to build this section from yet, same reasoning facilityTypeCode/facilitySubType/
// ownershipSubTypeCode stay free-text in buildHfrBasicInfoBody).
function offered(hospitalRecord, hasLinkId) {
  const v = getAnswer(hospitalRecord, hasLinkId);
  return v === 'YALL' || v === 'YIN';
}

export function buildHfrDetailedInfoBody(hospitalRecord, trackingId) {
  const body = { trackingId };

  if (offered(hospitalRecord, 'hospital_has_pharmacy')) {
    body.pharmacyDetails = {
      isJanAushadhiKendra: getAnswer(hospitalRecord, 'hospital_pharmacy_jan_aushadhi') || 'N',
      janAushadhiKendraId: getAnswer(hospitalRecord, 'hospital_pharmacy_jan_aushadhi_id') || '',
      drugLicenseNumber: getAnswer(hospitalRecord, 'hospital_pharmacy_drug_license') || '',
      pharmacyGstinNumber: getAnswer(hospitalRecord, 'hospital_pharmacy_gstin') || '',
      pharmacistRegistrationNumber: getAnswer(hospitalRecord, 'hospital_pharmacist_registration') || '',
    };
  }

  if (offered(hospitalRecord, 'hospital_has_blood_bank')) {
    body.bloodBankDetails = {
      isFacilityRegisteredInERaktkosh: getAnswer(hospitalRecord, 'hospital_bloodbank_eraktkosh') || 'N',
      eRaktoshId: getAnswer(hospitalRecord, 'hospital_bloodbank_eraktkosh_id') || '',
      bloodBankLicenseNumber: getAnswer(hospitalRecord, 'hospital_bloodbank_license') || '',
      bloodStorageCenters: 'N',
      storageCentersCount: 0,
      bloodCollectedPerAnnum: '',
      bloodRequiredPerAnnum: '',
    };
  }

  if (offered(hospitalRecord, 'hospital_has_imaging_center')) {
    body.imagingServices = getAnswers(hospitalRecord, 'hospital_imaging_services').map((service) => ({ service, count: 1 }));
  }

  if (offered(hospitalRecord, 'hospital_has_diagnostic_lab')) {
    body.diagnosticServices = getAnswers(hospitalRecord, 'hospital_diagnostic_services');
  }

  // medicalInfrastructure: real doc note is "mandatory for Dentistry" (part of systemOfMedicine)
  // and otherwise tied to typeOfServiceCode — included whenever a bed/chair count was actually
  // captured, rather than trying to replicate that full conditional matrix here.
  const totalBeds = getAnswer(hospitalRecord, 'hospital_total_beds');
  const dentalChairs = getAnswer(hospitalRecord, 'hospital_dental_chairs');
  if (totalBeds || dentalChairs) {
    body.medicalInfrastructure = {
      countHDUBedsWithFunctionalVentilators: 0, countIPDBedsWithoutOxygen: 0, countIPDBedsWithOxygen: 0,
      countICUBedsWithVentilators: 0, countICUBedsWithoutVentilators: 0, countHDUBedsWithVentilators: 0,
      countHDUBedsWithoutVentilators: 0, totalNumberOfVentilators: 0, countDayCareBedsWithoutOxygen: 0,
      countDayCareBedsWithOxygen: 0,
      countDentalChairs: Number(dentalChairs) || 0,
      totalNumberOfBeds: Number(totalBeds) || 0,
    };
  }

  return body;
}

// A real bug found and fixed while grounding this against the doc's own real submit-facility
// parameter table: sourceOfInformation defaulted to the literal string 'ClinixFlow', which isn't
// a real HFR SOURCE code at all (the real master-data type='SOURCE' list is a closed set of
// specific national-scheme identifiers — STHMISID/COWIN/AB-PMJAY/NHRR/... — for bulk-migrated
// facility records, not a free-text software-vendor name). The doc's own description is explicit
// that leaving this field EMPTY is the correct, expected case for a facility submitting itself
// ("If you leave this field empty, then your facility will be considered as Submitted entity"),
// so a genuinely-unset value now stays unset here instead of being coerced into an invalid code.
export function buildHfrSubmitBody(hospitalRecord, trackingId) {
  return {
    trackingId,
    sourceOfInformation: getAnswer(hospitalRecord, 'hospital_source_of_information') || undefined,
    sourceUniqueID: getAnswer(hospitalRecord, 'hospital_source_unique_id') || undefined,
  };
}
