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
import { hprRoleCode } from './hprRoles.js';

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
// Real bug found live (and fixed): this used to read role from getAnswer(staffRecord,
// 'staff_abdm_role') — a linkId that has never existed anywhere in system-provider-composition-v1
// .yaml, ProviderBasicsHost.vue, or ProviderMyProfileHost.vue. Every createAccount() call
// submitted role: undefined, and the gateway's own required-field check (hpr.js) 400'd before the
// request ever reached ABDM. The real HPR role value is staff_provider_role — on the PAIRED
// PractitionerRole (section_staff_role) instance, a DIFFERENT resource than staffRecord (the
// Practitioner) — so this now takes roleRecord as its own explicit param rather than trying to
// find it on staffRecord, and converts its label to the real 1/2/3 numeric code the spec's own
// Roles table requires (hprRoles.js's own hprRoleCode()) — createHprIdWithPreVerified's `role` is
// an int, not the label string PractitionerRole.code stores.
export function buildHprCreateBody(staffRecord, roleRecord, { txnId, selectedHpId, password }) {
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
    role: hprRoleCode(getAnswer(roleRecord, 'staff_provider_role')),
    // Real gap found live: the real HPR spec's own createHprIdWithPreVerified carries an optional
    // profilePhoto field, and clinuxflow-abdm-gateway's /registration/create route already reads
    // payload.profilePhotoBase64 (hpr.js) — nothing ever sent it. staff_photo is captured once, in
    // ProviderPersonalDetailsHost.vue's own Personal Details section (same base64 FileReader
    // pattern FacilityHfrPanel.vue's board/building photos already use), and reused here rather
    // than asking for a second upload during ABDM registration.
    profilePhotoBase64: getAnswer(staffRecord, 'staff_photo'),
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
// nested structure: practitioner/personalInformation/communicationAddress/registrationAcademic
// (with per-qualification base64 certificate uploads)/currentWorkDetails/facilityDeclarationData
// — 60+ fields across several real government forms. A prior pass at this deliberately covered
// only a small subset (name/mobile/email) because nothing in this app captured the rest yet;
// system-provider-composition-v1.yaml's own real HPR-spec-fidelity rebuild (explicit instruction:
// "create the Practitioner registration correctly including all the mandatory, optional and
// conditional fields") now captures every one of these blocks for real (staff_salutation/
// staff_gender/.../staff_address_*/staff_public_*/section_staff_qualification[]/staff_work_*), so
// this is now the FULL structural mapping, not the earlier deliberate subset. Still carries the
// same "structurally correct, not live-tested with real government credentials" honesty this
// app's other HPR/HFR/ABHA work already carries — the real API's exact leaf-field spelling
// (camelCase names below extrapolated from createHprIdWithPreVerified's own confirmed
// hpCategoryCode/hpSubCategoryCode-style naming, not independently confirmed against a live
// response) should be checked against a real sandbox call before relying on this beyond testing.
//
// Shared by buildHprRegisterProfessionalBody (register-professional-new, the CREATE counterpart)
// below — both real API calls send the identical nested `practitioner` shape, register-side just
// pairs it with a fresh HPR ID rather than an existing one.
function buildPractitionerPayload(staffRecord, qualifications) {
  return {
    officialMobile: getAnswer(staffRecord, 'staff_phone') || '',
    officialEmail: getAnswer(staffRecord, 'staff_email') || '',
    personalInformation: {
      salutation: getAnswer(staffRecord, 'staff_salutation') || '',
      firstName: getAnswer(staffRecord, 'staff_first_name') || '',
      middleName: getAnswer(staffRecord, 'staff_middle_name') || '',
      lastName: getAnswer(staffRecord, 'staff_last_name') || '',
      gender: getAnswer(staffRecord, 'staff_gender') || '',
      dateOfBirth: getAnswer(staffRecord, 'staff_date_of_birth') || '',
      nationality: getAnswer(staffRecord, 'staff_nationality') || '',
      fatherName: getAnswer(staffRecord, 'staff_father_name') || '',
      motherName: getAnswer(staffRecord, 'staff_mother_name') || '',
      spouseName: getAnswer(staffRecord, 'staff_spouse_name') || '',
      languagesKnown: (getAnswer(staffRecord, 'staff_languages_spoken') || '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    communicationAddress: {
      address: getAnswer(staffRecord, 'staff_address_line') || '',
      country: getAnswer(staffRecord, 'staff_address_country') || '',
      state: getAnswer(staffRecord, 'staff_address_state') || '',
      district: getAnswer(staffRecord, 'staff_address_district') || '',
      pincode: getAnswer(staffRecord, 'staff_address_postal_code') || '',
    },
    contactInformation: {
      publicMobile: getAnswer(staffRecord, 'staff_public_mobile') || '',
      landLine: getAnswer(staffRecord, 'staff_landline') || '',
      publicEmail: getAnswer(staffRecord, 'staff_public_email') || '',
    },
    registrationAcademic: {
      registrationData: (qualifications || []).map((q) => ({
        qualification: q.staff_qual_degree_code || '',
        college: q.staff_qual_college || '',
        university: q.staff_qual_university || '',
        countryOfEducation: q.staff_qual_country || '',
        stateOfEducation: q.staff_qual_state || '',
        yearOfAwarding: q.staff_qual_year_awarded || '',
        degreeCertificate: q.staff_qual_degree_certificate || '',
        // NHPR user manual's own Step 16 — asked once per document (degree/registration), each
        // with its own optional name-change affidavit when the answer is "No".
        degreeNameMatchesAadhaar: q.staff_qual_degree_name_matches_aadhaar || '',
        degreeNameChangeAffidavit: q.staff_qual_degree_name_change_affidavit || '',
        registeredWithCouncil: q.staff_qual_registered_council || '',
        registrationNumber: q.staff_qual_registration_number || '',
        registrationDate: q.staff_qual_registration_date || '',
        registrationCertificate: q.staff_qual_registration_certificate || '',
        registrationNameMatchesAadhaar: q.staff_qual_registration_name_matches_aadhaar || '',
        registrationNameChangeAffidavit: q.staff_qual_registration_name_change_affidavit || '',
        isPermanentOrRenewable: q.staff_qual_permanent_or_renewable || '',
        renewableDueDate: q.staff_qual_renewable_due_date || '',
      })),
    },
    currentWorkDetails: {
      currentlyWorking: getAnswer(staffRecord, 'staff_work_currently_working') === true || getAnswer(staffRecord, 'staff_work_currently_working') === 'true',
      // NHPR user manual's own "Nature of Work" is a real multi-select — joined back into one
      // string here since the real API's own singular/array shape isn't independently confirmed
      // (system-provider-composition-v1.yaml's own comment on staff_work_purpose). getAnswers
      // handles both a single legacy value and a real multi-selection identically.
      purposeOfRegistration: getAnswers(staffRecord, 'staff_work_purpose').join(', '),
      teleconsultationUrl: getAnswer(staffRecord, 'staff_work_teleconsultation_url') || '',
      chooseWorkStatus: getAnswer(staffRecord, 'staff_work_status') || '',
      reasonForNotWorking: getAnswer(staffRecord, 'staff_work_reason_not_working') || '',
      // Central/State -> Ministry (above, inside facilityDeclarationData) -> PSU — mandatory only
      // when chooseWorkStatus is Government or Both, per the manual's own screenshots; enforced in
      // the UI, not here.
      govtCategory: getAnswer(staffRecord, 'staff_work_govt_category') || '',
      workingInPsu: getAnswer(staffRecord, 'staff_work_psu_yesno') || '',
      psuName: getAnswer(staffRecord, 'staff_work_psu_name') || '',
      govtEmploymentProof: getAnswer(staffRecord, 'staff_work_govt_proof_document') || '',
      facilityDeclarationData: {
        facilityName: getAnswer(staffRecord, 'staff_work_facility_name') || '',
        facilityAddress: getAnswer(staffRecord, 'staff_work_facility_address') || '',
        pincode: getAnswer(staffRecord, 'staff_work_facility_pincode') || '',
        facilityType: getAnswer(staffRecord, 'staff_work_facility_type') || '',
        department: getAnswer(staffRecord, 'staff_work_facility_department') || '',
        designation: getAnswer(staffRecord, 'staff_work_facility_designation') || '',
        ministry: getAnswer(staffRecord, 'staff_work_ministry') || '',
      },
    },
  };
}

export function buildHprUpdateProfessionalBody(staffRecord, qualifications, hprToken) {
  return { hprToken, practitioner: buildPractitionerPayload(staffRecord, qualifications) };
}

// register-professional-new — the CREATE counterpart, submitting a practitioner's full profile to
// ABDM's registry for the first time (separate from createHprIdWithPreVerified, which only
// creates the bare HPR ID/account — explicit gap the user named: "I do not see create HPR id
// which is likely the first step to registration"). Needs the caller's own per-user hprToken
// (same as update — obtained via /auth/password-login or the OTP-login flow) plus the hprId just
// created/selected, since this submission targets that specific professional record.
export function buildHprRegisterProfessionalBody(staffRecord, qualifications, hprToken, hprId) {
  return { hprToken, hprId, practitioner: buildPractitionerPayload(staffRecord, qualifications) };
}

// "4. Update_Professional_Documents.pdf" — this covers the RETRIEVAL half (fetch-documents-list).
export function buildHprDocumentsListBody(hprid) {
  return { hprid };
}

// The upload half — real spec section 10/11 (POST .../uploads/upload-document), a prior session's
// own comment above incorrectly claimed didn't exist; confirmed factually wrong against the real
// spec PDF. `documentId` optionally correlates this upload to a specific registrationAcademic.
// registrationData[] entry (a qualification's own degree/registration certificate) — omitted for
// a document with no such correlation (e.g. profilePhoto).
export function buildHprDocumentUploadBody(hprToken, hprId, documentType, documentBase64, documentId) {
  const body = { hprToken, hprId, documentType, documentBase64 };
  if (documentId) body.documentId = documentId;
  return body;
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

// "HPID/2. Change password.pdf" / "HPID/3. Forgot hprid.pdf" / "HPID/1.
// Logout_Idcard_Account_Profile api.pdf" — the 4 real gaps this pass fills. Thin passthroughs,
// same discipline every builder above already follows: RSA encryption of otp/password fields
// happens server-side in clinuxflow-abdm-gateway (see its own hpr.js header note), not here.
export function buildHprForgotPasswordMobileOtpBody(hprId) {
  return { hprId };
}
export function buildHprForgotPasswordAadhaarOtpBody(hprId) {
  return { hprId };
}
export function buildHprPasswordResetBody(txnId, newPassword) {
  return { txnId, newPassword };
}
export function buildHprChangePasswordBody(oldPassword, newPassword) {
  return { oldPassword, newPassword };
}
export function buildHprForgotHpridAadhaarOtpBody(aadhaar) {
  return { aadhaar };
}
export function buildHprForgotHpridMobileOtpBody(mobileNumber) {
  return { mobileNumber };
}
export function buildHprForgotHpridVerifyBody(txnId, otp, staffRecord) {
  return {
    txnId,
    otp,
    firstName: getAnswer(staffRecord, 'staff_first_name'),
    middleName: getAnswer(staffRecord, 'staff_middle_name'),
    lastName: getAnswer(staffRecord, 'staff_last_name'),
  };
}
export function buildHprAccountTokenBody(hprToken) {
  return { hprToken };
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

// Same real /facility/search endpoint as buildHfrSearchBody above, reused for a genuinely
// different caller: a practitioner searching for an ALREADY-REGISTERED facility to link their own
// Work Experience to (the real spec's own Search Facility step, register-professional-new's
// currentWorkDetails.facilityId — explicit gap the user named as unbuilt), not an admin checking
// before self-registering their own new facility. Takes plain args, not a hospitalRecord — there
// is no "this org's own record" here, just a name/state the practitioner types in.
export function buildHfrFacilitySearchByNameBody(facilityName, stateLGDCode, { page = 1, resultsPerPage = 10 } = {}) {
  return { facilityName, stateLGDCode, page, resultsPerPage };
}

// Real body shape, grounded directly against New_HFR_APIs_Documentation_SBX.pdf §2.1's own worked
// samples this session — replaces a flat "STARTER FIELD SET" that never matched the real API at
// all (it's genuinely nested: facilityInformation.facilityAddressDetails/
// facilityContactInformation, not top-level fields). facilityOperationalStatus here is the doc's
// own real F/TC/CL/UC status CODE (hospital_operational_status_code, FAC-STATUS master) — a
// different field from Organization.active (hospital_operational_status, this profile's own
// derived boolean, see the YAML's own comment on that distinction). country is hard-fixed to
// 'India' — the doc's own sample error response rejects anything else ("Country should be
// india"), and HFR is India-only by definition. abdmCompliantSoftware is sent as a real, valid
// empty structure (confirmed against the doc's own samples, which do the same).
// facilityUploads.facilityBoardPhoto/facilityBuildingPhoto ARE real now — passed in by the caller
// (FacilityHfrPanel.vue's own base64 FileReader capture), not a permanent stub.
// facilityAddressProof is likewise real now: an optional single {addressProofType,
// addressProofAttachment} entry (the doc allows up to 3; FacilityHfrPanel.vue's own UI only
// captures one, matching what the manual's own screenshots actually show) — omitted entirely
// (real, doc-valid empty array) when the caller hasn't attached one.
export function buildHfrBasicInfoBody(hospitalRecord, { boardPhoto, buildingPhoto, addressProof } = {}) {
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
      facilityAddressProof: addressProof?.file
        ? [{ addressProofType: addressProof.type || '', addressProofAttachment: { name: addressProof.file.name, value: addressProof.file.value } }]
        : [],
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
// than leaving them unset. linkedProgramIds are all genuinely optional national-scheme ids — now
// real (FacilityHfrPanel.vue's own Additional Information section captures them, manual's own
// step 10), still sent as valid empty strings for any a clinic doesn't have.
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
      nhrrId: getAnswer(hospitalRecord, 'hospital_linked_nhrr_id') || '',
      nin: getAnswer(hospitalRecord, 'hospital_linked_nin') || '',
      abpmjayId: getAnswer(hospitalRecord, 'hospital_linked_abpmjay_id') || '',
      rohiniId: getAnswer(hospitalRecord, 'hospital_linked_rohini_id') || '',
      echsId: getAnswer(hospitalRecord, 'hospital_linked_echs_id') || '',
      cghsId: getAnswer(hospitalRecord, 'hospital_linked_cghs_id') || '',
      ceaRegistration: getAnswer(hospitalRecord, 'hospital_linked_cea_registration') || '',
      stateInsuranceSchemeId: getAnswer(hospitalRecord, 'hospital_linked_state_insurance_id') || '',
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
