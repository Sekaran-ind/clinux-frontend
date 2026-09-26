<script setup>
// Real HFR (Health Facility Registry) registration, layered on top of FacilityBasicsHost.vue's
// local FHIR capture — same "small panel next to the new Host component, calling the real
// gateway directly" shape PatientAbhaPanel.vue already established for Patient/ABHA. Ported from
// AbdmOnboarding.vue's own working hfrSearch/hfrBasicInfo/hfrAdditionalInfo/hfrDetailedInfo/
// hfrSubmit sequence (that page was retired once this landed), not reinvented.
//
// UX built around RegistrationLedger.vue + AttestationCard.vue, revised after a real bug a live
// user hit: the first version gated every stage on the one immediately before it in the manual's
// own screen order, treating that as a technical dependency chain. It wasn't — Search's own body
// needs ownershipCode/stateLGDCode/facilityName, fields that were locked behind Search succeeding
// first (a genuine deadlock, confirmed live via a real HIS-1070 "Required OwnershipCode Field is
// empty" error with nowhere to fix it). Now: Search is folded into Basic Information as an
// optional "check for duplicates" action using whatever's already typed on that same screen, and
// every OTHER stage's lock reflects a real ABDM technical requirement only (see
// facilityHfrJourney.js's own header for the exact contract) — never an invented screen order.
// Additional Information and Detailed Information are genuine siblings (each needs only a
// trackingId, per clinuxflow-abdm-gateway/src/routes/hfr.js's own contract), not a sequence.
//
// Master-data sourcing — two real, distinct sources, chosen per field, not uniform:
//   - ownershipCode/operationalStatus/typeOfService/systemOfMedicine/profit-non-profit sub-type/
//     specialityType/facilityRegion/generalInfoOptions/imaging/diagnostic are all small, stable
//     HFR master-data types — served from clinuxflow-api's own GET /api/valuesets/hfr-master/:type,
//     a real bundled FHIR ValueSet (scripts/build-hfr-master-valuesets.js, sourced from a live
//     pull of this exact gateway), matching ClinuxFlowFacility.json's own `binding.valueSet`
//     declarations for these fields — not a live gateway call on every render.
//   - State/District/Sub-district LGD codes stay a REAL live cascading call to
//     clinuxflow-abdm-gateway (GET /hfr/master/lgd/...) — a live, hierarchical, India-wide lookup,
//     not bundled as a static ValueSet (see the build script's own header for the full reasoning).
//   - facilityTypeCode/facilitySubtype/ownershipSubtypeCode (the FIRST one, not the
//     PROFIT-TYPE/NON-PROFIT-TYPE-backed ownershipSubtypeCode2) AND the new addressProof.type
//     stay free-text: their real dedicated ABDM endpoints (fetch-facility-type/fetch-facility-
//     Sub-type/get-owner-subtype/ADDRESS-PROOF) are returning real HIS-500 errors on the live
//     sandbox as of this build — no reliable source to bind them to yet. Same reasoning excludes a
//     `specialities` capture section entirely (get-specialities is also down) — Detailed
//     Information's own specialities[] is deliberately not built here, see
//     buildHfrDetailedInfoBody's own header.
//
// Detailed Information's own conditional sections (pharmacy/blood-bank/imaging/diagnostic/
// medical-infrastructure) render only when the matching Additional Information hasX flag is
// YALL/YIN — the real API rejects a section sent for a facility that doesn't offer it, per the
// doc's own error-response sample (see abdmAdapter.js's buildHfrDetailedInfoBody).
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { callAbdmGateway } from '../../data/control/abdmGatewayClient.js';
import {
  buildHprPasswordLoginBody, buildHfrSearchBody, buildHfrBasicInfoBody,
  buildHfrAdditionalInfoBody, buildHfrDetailedInfoBody, buildHfrSubmitBody,
} from '../../data/control/abdmAdapter.js';
import { getAnswer, getAnswers, patchOrCreateGroupField, patchOrCreateGroupMultiField } from '../../data/useSystemForms.js';
import { API_BASE, apiFetch } from '../../config.js';
import RegistrationLedger from '../RegistrationLedger.vue';
import AttestationCard from '../AttestationCard.vue';
import { deriveLedgerStages, nextStageAfter, currentStageFor, parseAbdmErrorDetails } from './facilityHfrJourney.js';

const props = defineProps({
  record: { type: Object, default: null }, // onboarding.getProviderRecord() — the whole Provider composition
});
const emit = defineEmits(['submitted']);

const trackingId = ref(null);
const facilityId = ref(null);
// Additional/Detailed Information each need their own independent "did this real API call
// succeed" signal now — they're siblings, not a single linear progression, so a plain step string
// can't represent "detailed done, additional not" (see facilityHfrJourney.js's own header).
// Persisted via hospital_additional_info_submitted/hospital_detailed_info_submitted so a reload
// restores the real state rather than resetting it.
const additionalInfoDone = ref(false);
const detailedInfoDone = ref(false);
const overallStatusLabel = computed(() => (facilityId.value ? 'Submitted to HFR' : trackingId.value ? 'In progress' : 'Not started'));

// One shared error surface for every real API failure in this panel — [{message, stageId?,
// label?}], stageId/label present only when parseAbdmErrorDetails() finds a real field match
// (see its own header on why that's best-effort, never assumed complete). A plain local message
// (e.g. "log in first") is just [{message}], same shape, no jump link.
const errorDetails = ref([]);
function setLocalError(message) { errorDetails.value = [{ message }]; }
function setAbdmError(res, fallback) {
  const parsed = parseAbdmErrorDetails(res);
  errorDetails.value = parsed.length ? parsed : [{ message: fallback }];
}
function clearError() { errorDetails.value = []; }
function goToErrorStage(stageId) { activeStageId.value = stageId; }

const loading = reactive({ search: false, basic: false, additional: false, detailed: false, submit: false, login: false });

// Facility-manager token — the person completing this must already hold their OWN HPR ID
// (see ProviderHprPanel.vue) and log in with it; this gateway can't obtain that on their behalf
// (clinuxflow-abdm-gateway/src/routes/hfr.js's own header comment). Memory only, never persisted.
const managerLogin = reactive({ hprId: '', password: '' });
const managerToken = ref(null);

async function managerPasswordLogin() {
  if (!managerLogin.hprId || !managerLogin.password) { setLocalError('Enter an HPR ID and password.'); return; }
  clearError();
  loading.login = true;
  const res = await callAbdmGateway('/hpr/auth/password-login', { body: buildHprPasswordLoginBody(managerLogin.hprId, managerLogin.password) });
  loading.login = false;
  managerLogin.password = '';
  if (!res.success) { setAbdmError(res, res.error || 'Login failed.'); return; }
  managerToken.value = res.token;
}

// ─── The registration ledger: which of the 6 real stages is open, and each one's done/active/
// blocked state (facilityHfrJourney.js's own pure classifier — see its header for why each gate
// checks what it does; every lock now reflects a genuine ABDM technical requirement, never an
// invented screen order). ───
const activeStageId = ref('basic');
const publicDisplayConfirmed = ref(false);
const attestationConsented = ref(false);
const ledgerStages = computed(() => deriveLedgerStages({
  managerToken: managerToken.value, trackingId: trackingId.value,
  additionalInfoDone: additionalInfoDone.value, detailedInfoDone: detailedInfoDone.value,
  facilityId: facilityId.value, publicDisplayConfirmed: publicDisplayConfirmed.value,
}).map((s) => ({
  id: s.id,
  label: s.label,
  icon: s.icon,
  state: s.state,
  lockedReason: s.lockedReason,
})));

// ─── HFR-specific fields not on FacilityBasicsHost.vue ───
const fields = reactive({
  ownershipCode: '', ownershipSubtypeCode: '', ownershipBucket: '', ownershipSubtypeCode2: '',
  facilityTypeCode: '', facilitySubtype: '', typeOfServiceCode: '', specialityTypeCode: '',
  facilityRegion: '', operationalStatus: '', stateLgdCode: '', districtLgdCode: '', subdistrictLgdCode: '',
  geoLatitude: '', geoLongitude: '', systemOfMedicine: [],
  hasDialysisCenter: '', hasPharmacy: '', hasBloodBank: '', hasCathLab: '', hasDiagnosticLab: '', hasImagingCenter: '',
  pharmacyJanAushadhi: '', pharmacyJanAushadhiId: '', pharmacyDrugLicense: '', pharmacyGstin: '', pharmacistRegistration: '',
  bloodbankERaktkosh: '', bloodbankERaktkoshId: '', bloodbankLicense: '',
  imagingServices: [], diagnosticServices: [], totalBeds: '', dentalChairs: '',
  specialities: [], // flat speciality codes across all selected systems (e.g. ["M-S1","M-S35"])
  boardPhoto: null, buildingPhoto: null, // { name, value(base64) } | null
});
const master = reactive({
  owners: [], profitTypes: [], nonProfitTypes: [], statuses: [], services: [], mediums: [], specialityTypes: [], regions: [],
  generalInfo: [], imaging: [], diagnostic: [], states: [], districts: [], subdistricts: [],
  facilityTypes: [], facilitySubtypes: [], ownerSubtypes: [], specialitiesBySystem: {}, // {[systemCode]: [{code,value}]}
});

// ─── Address proof (Basic Information's own facilityAddressProof) — local-only reactive state,
// mirroring how boardPhoto/buildingPhoto already work: base64 blobs don't round-trip through the
// QuestionnaireResponse item tree, so — same limitation the existing photo fields already carry —
// this isn't restorable across a reload. The real API allows up to 3 proofs; this panel captures
// one, matching what the manual's own screenshots actually show. ───
const addressProof = reactive({ type: '', file: null }); // file: {name,value}|null

// ─── Linked Program IDs (manual's own step 10) + source-of-information — captured together here
// for the user's own mental model ("which national systems already know about this facility"),
// even though they're sent through two different real API calls: the first 8 via Additional
// Information's linkedProgramIds, the last 2 via Submit's sourceOfInformation/sourceUniqueID (see
// abdmAdapter.js's own buildHfrAdditionalInfoBody/buildHfrSubmitBody). ───
const linkedProgram = reactive({
  nhrrId: '', nin: '', rohiniId: '', abpmjayId: '', cghsId: '', echsId: '', ceaRegistration: '', stateInsuranceSchemeId: '',
  sourceOfInformation: '', sourceUniqueId: '',
});

// ─── Public Display settings (manual's own step 12) — mandatory fields need no capture (already
// real fields elsewhere in this composition, shown read-only below); only the optional-field
// opt-in/opt-out and the About text are genuinely new preference data. Optional fields default to
// shown (true) until the manager explicitly turns one off — matches the manual's own screenshot,
// where every optional field starts checked. ───
const publicDisplay = reactive({
  optOut: false, mobile: true, email: true, landline: true, website: true, photo: true, beds: true, about: '',
});
// Real bug caught live: getAnswer() never returns undefined for a not-found linkId — its own
// not-found sentinel is '' (see formData.js's own `let found = ''`). Comparing against undefined
// here always evaluated true, so this silently always fell to the boolean branch instead of ever
// hitting the "not yet answered" default.
function readBooleanDefaultTrue(record, linkId) {
  const raw = getAnswer(record, linkId);
  return raw === '' ? true : raw === true;
}

function rebuildFromRecord() {
  if (!props.record) return;
  fields.ownershipCode = getAnswer(props.record, 'hospital_ownership_code') || '';
  fields.ownershipSubtypeCode = getAnswer(props.record, 'hospital_ownership_subtype_code') || '';
  fields.ownershipSubtypeCode2 = getAnswer(props.record, 'hospital_ownership_subtype_code_2') || '';
  fields.facilityTypeCode = getAnswer(props.record, 'hospital_facility_type') || '';
  fields.facilitySubtype = getAnswer(props.record, 'hospital_facility_subtype') || '';
  fields.typeOfServiceCode = getAnswer(props.record, 'hospital_type_of_service_code') || '';
  fields.specialityTypeCode = getAnswer(props.record, 'hospital_speciality_type_code') || '';
  fields.facilityRegion = getAnswer(props.record, 'hospital_facility_region') || '';
  fields.operationalStatus = getAnswer(props.record, 'hospital_operational_status_code') || '';
  fields.stateLgdCode = getAnswer(props.record, 'hospital_state_lgd_code') || '';
  fields.districtLgdCode = getAnswer(props.record, 'hospital_district_lgd_code') || '';
  fields.subdistrictLgdCode = getAnswer(props.record, 'hospital_subdistrict_lgd_code') || '';
  fields.geoLatitude = getAnswer(props.record, 'hospital_geo_latitude') || '';
  fields.geoLongitude = getAnswer(props.record, 'hospital_geo_longitude') || '';
  fields.systemOfMedicine = getAnswers(props.record, 'hospital_system_of_medicine');
  fields.hasDialysisCenter = getAnswer(props.record, 'hospital_has_dialysis_center') || '';
  fields.hasPharmacy = getAnswer(props.record, 'hospital_has_pharmacy') || '';
  fields.hasBloodBank = getAnswer(props.record, 'hospital_has_blood_bank') || '';
  fields.hasCathLab = getAnswer(props.record, 'hospital_has_cath_lab') || '';
  fields.hasDiagnosticLab = getAnswer(props.record, 'hospital_has_diagnostic_lab') || '';
  fields.hasImagingCenter = getAnswer(props.record, 'hospital_has_imaging_center') || '';
  fields.pharmacyJanAushadhi = getAnswer(props.record, 'hospital_pharmacy_jan_aushadhi') || '';
  fields.pharmacyJanAushadhiId = getAnswer(props.record, 'hospital_pharmacy_jan_aushadhi_id') || '';
  fields.pharmacyDrugLicense = getAnswer(props.record, 'hospital_pharmacy_drug_license') || '';
  fields.pharmacyGstin = getAnswer(props.record, 'hospital_pharmacy_gstin') || '';
  fields.pharmacistRegistration = getAnswer(props.record, 'hospital_pharmacist_registration') || '';
  fields.bloodbankERaktkosh = getAnswer(props.record, 'hospital_bloodbank_eraktkosh') || '';
  fields.bloodbankERaktkoshId = getAnswer(props.record, 'hospital_bloodbank_eraktkosh_id') || '';
  fields.bloodbankLicense = getAnswer(props.record, 'hospital_bloodbank_license') || '';
  fields.imagingServices = getAnswers(props.record, 'hospital_imaging_services');
  fields.diagnosticServices = getAnswers(props.record, 'hospital_diagnostic_services');
  fields.totalBeds = getAnswer(props.record, 'hospital_total_beds') || '';
  fields.dentalChairs = getAnswer(props.record, 'hospital_dental_chairs') || '';
  fields.specialities = getAnswers(props.record, 'hospital_specialities');

  linkedProgram.nhrrId = getAnswer(props.record, 'hospital_linked_nhrr_id') || '';
  linkedProgram.nin = getAnswer(props.record, 'hospital_linked_nin') || '';
  linkedProgram.rohiniId = getAnswer(props.record, 'hospital_linked_rohini_id') || '';
  linkedProgram.abpmjayId = getAnswer(props.record, 'hospital_linked_abpmjay_id') || '';
  linkedProgram.cghsId = getAnswer(props.record, 'hospital_linked_cghs_id') || '';
  linkedProgram.echsId = getAnswer(props.record, 'hospital_linked_echs_id') || '';
  linkedProgram.ceaRegistration = getAnswer(props.record, 'hospital_linked_cea_registration') || '';
  linkedProgram.stateInsuranceSchemeId = getAnswer(props.record, 'hospital_linked_state_insurance_id') || '';
  linkedProgram.sourceOfInformation = getAnswer(props.record, 'hospital_source_of_information') || '';
  linkedProgram.sourceUniqueId = getAnswer(props.record, 'hospital_source_unique_id') || '';

  publicDisplay.optOut = getAnswer(props.record, 'hospital_public_display_optout') === true;
  publicDisplay.mobile = readBooleanDefaultTrue(props.record, 'hospital_public_display_mobile');
  publicDisplay.email = readBooleanDefaultTrue(props.record, 'hospital_public_display_email');
  publicDisplay.landline = readBooleanDefaultTrue(props.record, 'hospital_public_display_landline');
  publicDisplay.website = readBooleanDefaultTrue(props.record, 'hospital_public_display_website');
  publicDisplay.photo = readBooleanDefaultTrue(props.record, 'hospital_public_display_photo');
  publicDisplay.beds = readBooleanDefaultTrue(props.record, 'hospital_public_display_beds');
  publicDisplay.about = getAnswer(props.record, 'hospital_public_about') || '';
  // Confirmation itself is local-only (Public Display has no ABDM API of its own to persist a
  // "confirmed" flag against) — re-derived from whether the preference fields carry any real,
  // previously-saved signal, so a returning session that already confirmed doesn't get re-blocked
  // on the Attestation stage.
  publicDisplayConfirmed.value = getAnswer(props.record, 'hospital_public_display_optout') !== ''
    || getAnswer(props.record, 'hospital_public_display_mobile') !== '';

  trackingId.value = getAnswer(props.record, 'hospital_tracking_id') || null;
  facilityId.value = getAnswer(props.record, 'hospital_facility_id') || null;
  additionalInfoDone.value = getAnswer(props.record, 'hospital_additional_info_submitted') === true;
  detailedInfoDone.value = getAnswer(props.record, 'hospital_detailed_info_submitted') === true;

  activeStageId.value = currentStageFor({
    trackingId: trackingId.value, additionalInfoDone: additionalInfoDone.value, detailedInfoDone: detailedInfoDone.value,
    facilityId: facilityId.value, publicDisplayConfirmed: publicDisplayConfirmed.value,
  });
}
watch(() => props.record, rebuildFromRecord, { immediate: true });

// The real bundled FHIR ValueSet (clinuxflow-api), not the live gateway — see this file's own
// header for why. expansion.contains is the real FHIR shape (system/code/display); mapped to the
// same {code, value} pair loadDistricts/loadSubdistricts already use so the template doesn't need
// two different option-rendering shapes.
async function loadValueSet(type) {
  const res = await apiFetch(`${API_BASE}/api/valuesets/hfr-master/${encodeURIComponent(type)}`).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await res.json().catch(() => null);
  return (body?.expansion?.contains || []).map((c) => ({ code: c.code, value: c.display }));
}

async function loadDistricts(stateCode) {
  const res = await callAbdmGateway(`/hfr/master/lgd/districts?stateCode=${encodeURIComponent(stateCode)}`, { method: 'GET' });
  return res.success ? (res.data || []) : [];
}
async function loadSubdistricts(districtCode) {
  const res = await callAbdmGateway(`/hfr/master/lgd/subdistricts?districtCode=${encodeURIComponent(districtCode)}`, { method: 'GET' });
  return res.success ? (res.data || []) : [];
}

// Real bug found live: fetch-facility-type/fetch-facility-Sub-type/get-owner-subtype/
// get-specialities are dependent, parameterized lookups (New_HFR_APIs_Documentation_SBX.pdf
// §3.6-3.8), same shape as LGD districts/subdistricts above — not static bundled ValueSets, so
// they're live gateway calls, cascading off the fields they actually depend on (an earlier pass
// called the gateway's own routes for these as bodyless GETs, which always failed regardless of
// sandbox health — fixed gateway-side in clinuxflow-abdm-gateway/src/routes/hfr.js).
async function loadFacilityTypes(ownershipCode, systemOfMedicineCode) {
  const res = await callAbdmGateway(`/hfr/master/facility-types?ownershipCode=${encodeURIComponent(ownershipCode)}&systemOfMedicineCode=${encodeURIComponent(systemOfMedicineCode)}`, { method: 'GET' });
  return res.success ? (res.data?.data || []).map((d) => ({ code: d.code, value: d.value })) : [];
}
async function loadFacilitySubtypes(facilityTypeCode) {
  const res = await callAbdmGateway(`/hfr/master/facility-sub-types?facilityTypeCode=${encodeURIComponent(facilityTypeCode)}`, { method: 'GET' });
  return res.success ? (res.data?.data || []).map((d) => ({ code: d.code, value: d.value })) : [];
}
async function loadOwnerSubtypes(ownershipCode) {
  const res = await callAbdmGateway(`/hfr/master/owner-subtypes?ownershipCode=${encodeURIComponent(ownershipCode)}`, { method: 'GET' });
  return res.success ? (res.data?.data || []).map((d) => ({ code: d.code, value: d.value })) : [];
}
async function loadSpecialities(systemOfMedicineCode) {
  const res = await callAbdmGateway(`/hfr/master/specialities?systemOfMedicineCode=${encodeURIComponent(systemOfMedicineCode)}`, { method: 'GET' });
  return res.success ? (res.data?.data || []).map((d) => ({ code: d.code, value: d.value })) : [];
}

watch(() => fields.ownershipBucket, async (bucket) => {
  fields.ownershipSubtypeCode2 = '';
  if (bucket === 'PROFIT' && master.profitTypes.length === 0) master.profitTypes = await loadValueSet('PROFIT-TYPE');
  if (bucket === 'NON-PROFIT' && master.nonProfitTypes.length === 0) master.nonProfitTypes = await loadValueSet('NON-PROFIT-TYPE');
});
watch(() => fields.stateLgdCode, async (code) => {
  fields.districtLgdCode = ''; fields.subdistrictLgdCode = '';
  master.districts = code ? await loadDistricts(code) : [];
});
watch(() => fields.districtLgdCode, async (code) => {
  fields.subdistrictLgdCode = '';
  master.subdistricts = code ? await loadSubdistricts(code) : [];
});

// facilityTypeCode/facilitySubtype depend on BOTH ownershipCode and the joined systemOfMedicine —
// re-fetch whenever either input changes, clearing whatever downstream selection no longer
// applies (same cascade-invalidation discipline the LGD watchers above already use).
watch([() => fields.ownershipCode, () => fields.systemOfMedicine.join(',')], async ([ownershipCode, systemOfMedicineJoined]) => {
  fields.facilityTypeCode = ''; fields.facilitySubtype = '';
  master.facilityTypes = (ownershipCode && systemOfMedicineJoined) ? await loadFacilityTypes(ownershipCode, systemOfMedicineJoined) : [];
});
watch(() => fields.facilityTypeCode, async (code) => {
  fields.facilitySubtype = '';
  master.facilitySubtypes = code ? await loadFacilitySubtypes(code) : [];
});
watch(() => fields.ownershipCode, async (code) => {
  fields.ownershipSubtypeCode = '';
  master.ownerSubtypes = code ? await loadOwnerSubtypes(code) : [];
});
// One fetch per selected system of medicine (get-specialities only accepts a single code per
// call, per the doc), merged into a map keyed by system code for the Detailed Information stage's
// own grouped checkboxes. Already-fetched systems aren't re-fetched — same "only load what
// changed" discipline as fields.ownershipBucket's PROFIT/NON-PROFIT watcher above.
watch(() => fields.systemOfMedicine.slice(), async (codes) => {
  const missing = codes.filter((c) => !master.specialitiesBySystem[c]);
  if (!missing.length) return;
  const fetched = await Promise.all(missing.map((c) => loadSpecialities(c)));
  missing.forEach((c, i) => { master.specialitiesBySystem[c] = fetched[i]; });
}, { deep: true });

function toggleInArray(field, code, checked) {
  fields[field] = checked ? [...fields[field], code] : fields[field].filter((c) => c !== code);
}

// Real government facilityUploads/facilityAddressProof are base64-encoded file payloads (per the
// doc's own sample) — a plain FileReader round-trip, capped generously (2MB) so a real photo
// doesn't silently hang the tab turning it into a data URL.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_UPLOAD_BYTES) { reject(new Error('File is too large (max 2MB).')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); // strip the data: URL prefix, HFR wants raw base64
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function onPhotoSelected(field, event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const value = await readFileAsBase64(file);
    fields[field] = { name: file.name, value };
  } catch (e) {
    setLocalError(e.message || 'Could not read that file.');
  }
}
async function onAddressProofSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const value = await readFileAsBase64(file);
    addressProof.file = { name: file.name, value };
  } catch (e) {
    setLocalError(e.message || 'Could not read that file.');
  }
}

// Recommended-name assist (manual's own p.12 example: facility name "ABC" + facility type "PHC"
// -> "Primary Health Centre ABC"). facilityTypeCode stays free-text (its real master endpoint is
// down, see this file's own header), so matched by keyword rather than a real ABDM code.
const FACILITY_TYPE_NAME_PREFIXES = [
  { match: /\bchc\b|community health/i, prefix: 'Community Health Centre' },
  { match: /\bphc\b|primary health/i, prefix: 'Primary Health Centre' },
  { match: /sub.?cent(re|er)/i, prefix: 'Sub Centre' },
  { match: /\bhwc\b|health and wellness/i, prefix: 'Health and Wellness Centre' },
];
const recommendedName = computed(() => {
  if (!props.record) return '';
  const typeCode = fields.facilityTypeCode.trim();
  const baseName = getAnswer(props.record, 'hospital_name') || '';
  if (!typeCode || !baseName) return '';
  const match = FACILITY_TYPE_NAME_PREFIXES.find((m) => m.match.test(typeCode));
  if (!match) return '';
  const recommended = `${match.prefix} ${baseName}`;
  return baseName.startsWith(match.prefix) ? '' : recommended;
});
function applyRecommendedName() {
  if (!recommendedName.value || !props.record) return;
  patchOrCreateGroupField(props.record.id, 'section_hospital', 'hospital_name', recommendedName.value);
}

onMounted(async () => {
  const [owners, statuses, services, mediums, specialityTypes, regions, generalInfo, imaging, diagnostic, states] = await Promise.all([
    loadValueSet('OWNER'), loadValueSet('FAC-STATUS'), loadValueSet('TYPE-SERVICE'), loadValueSet('MEDICINE'),
    loadValueSet('SPECIALITY-TYPE'), loadValueSet('FACILITY-REGION'), loadValueSet('GENERAL-INFO-OPTIONS'),
    loadValueSet('IMAGING'), loadValueSet('DIAGNOSTIC'),
    callAbdmGateway('/hfr/master/lgd/states', { method: 'GET' }),
  ]);
  master.owners = owners;
  master.statuses = statuses;
  master.services = services;
  master.mediums = mediums;
  master.specialityTypes = specialityTypes;
  master.regions = regions;
  master.generalInfo = generalInfo;
  master.imaging = imaging;
  master.diagnostic = diagnostic;
  master.states = states.success ? (states.data || []) : [];
  // Real bug found live: on failure this silently left the State (LGD) dropdown with zero
  // options and no explanation — indistinguishable from "the feature is broken" when the actual
  // cause is almost always the local ABDM gateway (or the real sandbox behind it) being
  // unreachable. Surfaces through the same shared errorDetails banner every other action in this
  // panel already uses, rather than a bespoke one — this fetch just failed the same way a submit
  // failing already does.
  if (!states.success) setLocalError(states.error || 'Could not load the State (LGD) list — check that the ABDM gateway is reachable.');
  // Re-run the dependent watchers now that master data + a persisted record are both in —
  // watch() with immediate:true above already ran before onMounted's async work resolved, so a
  // saved selection needs its dependent dropdown loaded here explicitly, once.
  if (fields.ownershipBucket === 'PROFIT') master.profitTypes = await loadValueSet('PROFIT-TYPE');
  if (fields.ownershipBucket === 'NON-PROFIT') master.nonProfitTypes = await loadValueSet('NON-PROFIT-TYPE');
  if (fields.stateLgdCode) master.districts = await loadDistricts(fields.stateLgdCode);
  if (fields.districtLgdCode) master.subdistricts = await loadSubdistricts(fields.districtLgdCode);
  if (fields.ownershipCode && fields.systemOfMedicine.length) master.facilityTypes = await loadFacilityTypes(fields.ownershipCode, fields.systemOfMedicine.join(','));
  if (fields.facilityTypeCode) master.facilitySubtypes = await loadFacilitySubtypes(fields.facilityTypeCode);
  if (fields.ownershipCode) master.ownerSubtypes = await loadOwnerSubtypes(fields.ownershipCode);
  if (fields.systemOfMedicine.length) {
    const fetched = await Promise.all(fields.systemOfMedicine.map((c) => loadSpecialities(c)));
    fields.systemOfMedicine.forEach((c, i) => { master.specialitiesBySystem[c] = fetched[i]; });
  }
});

function offered(v) { return v === 'YALL' || v === 'YIN'; }

// Every patchOrCreateGroupField/patchOrCreateGroupMultiField call below names the field's REAL
// owning composition block (system-provider-composition-v1.yaml) explicitly — required now that
// these groups are never pre-seeded any other way (see patchOrCreateGroupField's own header in
// formData.js for the bug this fixes). Group names are load-bearing, not decorative: getAnswer()
// still finds a field anywhere in the tree regardless of which group it's under, but a field's
// FIRST write, on a genuinely fresh record, has to land in its real group so extraction sees the
// same shape a hand-authored record always would.
const FACILITY_TYPE_GROUP = 'section_hospital_abdm_facility_type';
const LOCATION_GROUP = 'section_hospital_abdm_location';
const REGISTRATION_GROUP = 'section_hospital_abdm_registration';
const PUBLIC_DISPLAY_GROUP = 'section_hospital_public_display';

function persistHfrFields() {
  if (!props.record) return;
  const id = props.record.id;
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_ownership_code', fields.ownershipCode);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_ownership_subtype_code', fields.ownershipSubtypeCode);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_ownership_subtype_code_2', fields.ownershipSubtypeCode2);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_facility_type', fields.facilityTypeCode);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_facility_subtype', fields.facilitySubtype);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_type_of_service_code', fields.typeOfServiceCode);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_speciality_type_code', fields.specialityTypeCode);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_facility_region', fields.facilityRegion);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_operational_status_code', fields.operationalStatus);
  patchOrCreateGroupField(id, LOCATION_GROUP, 'hospital_state_lgd_code', fields.stateLgdCode);
  patchOrCreateGroupField(id, LOCATION_GROUP, 'hospital_district_lgd_code', fields.districtLgdCode);
  patchOrCreateGroupField(id, LOCATION_GROUP, 'hospital_subdistrict_lgd_code', fields.subdistrictLgdCode);
  patchOrCreateGroupField(id, LOCATION_GROUP, 'hospital_geo_latitude', fields.geoLatitude);
  patchOrCreateGroupField(id, LOCATION_GROUP, 'hospital_geo_longitude', fields.geoLongitude);
  patchOrCreateGroupMultiField(id, FACILITY_TYPE_GROUP, 'hospital_system_of_medicine', fields.systemOfMedicine);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_has_dialysis_center', fields.hasDialysisCenter);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_has_pharmacy', fields.hasPharmacy);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_has_blood_bank', fields.hasBloodBank);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_has_cath_lab', fields.hasCathLab);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_has_diagnostic_lab', fields.hasDiagnosticLab);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_has_imaging_center', fields.hasImagingCenter);
}

function persistDetailedFields() {
  if (!props.record) return;
  const id = props.record.id;
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_pharmacy_jan_aushadhi', fields.pharmacyJanAushadhi);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_pharmacy_jan_aushadhi_id', fields.pharmacyJanAushadhiId);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_pharmacy_drug_license', fields.pharmacyDrugLicense);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_pharmacy_gstin', fields.pharmacyGstin);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_pharmacist_registration', fields.pharmacistRegistration);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_bloodbank_eraktkosh', fields.bloodbankERaktkosh);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_bloodbank_eraktkosh_id', fields.bloodbankERaktkoshId);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_bloodbank_license', fields.bloodbankLicense);
  patchOrCreateGroupMultiField(id, FACILITY_TYPE_GROUP, 'hospital_imaging_services', fields.imagingServices);
  patchOrCreateGroupMultiField(id, FACILITY_TYPE_GROUP, 'hospital_diagnostic_services', fields.diagnosticServices);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_total_beds', fields.totalBeds);
  patchOrCreateGroupField(id, FACILITY_TYPE_GROUP, 'hospital_dental_chairs', fields.dentalChairs);
  patchOrCreateGroupMultiField(id, FACILITY_TYPE_GROUP, 'hospital_specialities', fields.specialities);
}

function toggleSpeciality(code, checked) {
  fields.specialities = checked ? [...fields.specialities, code] : fields.specialities.filter((c) => c !== code);
}

function persistLinkedProgramFields() {
  if (!props.record) return;
  const id = props.record.id;
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_linked_nhrr_id', linkedProgram.nhrrId);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_linked_nin', linkedProgram.nin);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_linked_rohini_id', linkedProgram.rohiniId);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_linked_abpmjay_id', linkedProgram.abpmjayId);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_linked_cghs_id', linkedProgram.cghsId);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_linked_echs_id', linkedProgram.echsId);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_linked_cea_registration', linkedProgram.ceaRegistration);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_linked_state_insurance_id', linkedProgram.stateInsuranceSchemeId);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_source_of_information', linkedProgram.sourceOfInformation);
  patchOrCreateGroupField(id, REGISTRATION_GROUP, 'hospital_source_unique_id', linkedProgram.sourceUniqueId);
}

function persistPublicDisplayFields() {
  if (!props.record) return;
  const id = props.record.id;
  patchOrCreateGroupField(id, PUBLIC_DISPLAY_GROUP, 'hospital_public_display_optout', publicDisplay.optOut);
  patchOrCreateGroupField(id, PUBLIC_DISPLAY_GROUP, 'hospital_public_display_mobile', publicDisplay.mobile);
  patchOrCreateGroupField(id, PUBLIC_DISPLAY_GROUP, 'hospital_public_display_email', publicDisplay.email);
  patchOrCreateGroupField(id, PUBLIC_DISPLAY_GROUP, 'hospital_public_display_landline', publicDisplay.landline);
  patchOrCreateGroupField(id, PUBLIC_DISPLAY_GROUP, 'hospital_public_display_website', publicDisplay.website);
  patchOrCreateGroupField(id, PUBLIC_DISPLAY_GROUP, 'hospital_public_display_photo', publicDisplay.photo);
  patchOrCreateGroupField(id, PUBLIC_DISPLAY_GROUP, 'hospital_public_display_beds', publicDisplay.beds);
  patchOrCreateGroupField(id, PUBLIC_DISPLAY_GROUP, 'hospital_public_about', publicDisplay.about);
}

function confirmPublicDisplay() {
  persistPublicDisplayFields();
  publicDisplayConfirmed.value = true;
  activeStageId.value = nextStageAfter('public_display');
}

// Search is now an optional, non-blocking "check for duplicates" action inside Basic
// Information itself (see this file's own header for the deadlock it used to be) — it neither
// gates nor advances any stage, so its own feedback stays local to the button rather than going
// through the shared errorDetails banner (a "no existing match" result isn't an error, and a real
// failure here — e.g. the exact OwnershipCode-empty case that motivated this change — is now
// immediately actionable: the field it's complaining about is right there on the same screen).
const searchFeedback = ref([]); // [{message}] — reuses parseAbdmErrorDetails' shape for one render path
async function doSearch() {
  if (!props.record) { searchFeedback.value = [{ message: 'Save the Hospital Profile first.' }]; return; }
  searchFeedback.value = [];
  persistHfrFields();
  loading.search = true;
  const res = await callAbdmGateway('/hfr/facility/search', { body: buildHfrSearchBody(props.record) });
  loading.search = false;
  if (!res.success) { searchFeedback.value = parseAbdmErrorDetails(res); return; }
  const matches = res.facilities?.length ?? res.data?.facilities?.length ?? 0;
  searchFeedback.value = [{ message: matches ? `Found ${matches} possible match(es) already in HFR — check before continuing.` : 'No matching facility found in HFR.' }];
}

async function doBasicInfo() {
  if (!managerToken.value) { setLocalError('Log in with the Facility Manager’s HPR ID first.'); return; }
  clearError();
  persistHfrFields();
  loading.basic = true;
  const res = await callAbdmGateway('/hfr/facility/basic-information', {
    body: buildHfrBasicInfoBody(props.record, { boardPhoto: fields.boardPhoto, buildingPhoto: fields.buildingPhoto, addressProof }),
    extraHeaders: { 'X-HPRID-Auth-Token': managerToken.value },
  });
  loading.basic = false;
  if (!res.success) { setAbdmError(res, 'Basic information submission failed.'); return; }
  trackingId.value = res.trackingId;
  patchOrCreateGroupField(props.record.id, REGISTRATION_GROUP, 'hospital_tracking_id', res.trackingId);
  activeStageId.value = nextStageAfter('basic');
}

async function doAdditionalInfo() {
  clearError();
  persistHfrFields();
  persistLinkedProgramFields();
  loading.additional = true;
  const res = await callAbdmGateway('/hfr/facility/additional-information', { body: buildHfrAdditionalInfoBody(props.record, trackingId.value) });
  loading.additional = false;
  if (!res.success) { setAbdmError(res, 'Additional information submission failed.'); return; }
  additionalInfoDone.value = true;
  patchOrCreateGroupField(props.record.id, REGISTRATION_GROUP, 'hospital_additional_info_submitted', true);
  activeStageId.value = nextStageAfter('additional');
}

async function doDetailedInfo() {
  clearError();
  persistDetailedFields();
  loading.detailed = true;
  const res = await callAbdmGateway('/hfr/facility/detailed-information', { body: buildHfrDetailedInfoBody(props.record, trackingId.value) });
  loading.detailed = false;
  if (!res.success) { setAbdmError(res, 'Detailed information submission failed.'); return; }
  detailedInfoDone.value = true;
  patchOrCreateGroupField(props.record.id, REGISTRATION_GROUP, 'hospital_detailed_info_submitted', true);
  activeStageId.value = nextStageAfter('detailed');
}

// The attestation summary AttestationCard.vue shows — what's actually being attested, pulled
// straight from the already-captured record.
const attestationSummary = computed(() => {
  if (!props.record) return [];
  const ownerLabel = master.owners.find((o) => o.code === fields.ownershipCode)?.value || fields.ownershipCode;
  return [
    { label: 'Facility Name', value: getAnswer(props.record, 'hospital_name') },
    { label: 'Ownership', value: ownerLabel },
    { label: 'Address', value: [getAnswer(props.record, 'hospital_address'), getAnswer(props.record, 'hospital_city'), fields.stateLgdCode && master.states.find((s) => s.code === fields.stateLgdCode)?.name].filter(Boolean).join(', ') },
    { label: 'Facility Type', value: fields.facilityTypeCode },
  ];
});
const signingAsLabel = computed(() => (managerToken.value && managerLogin.hprId ? `Signing as: ${managerLogin.hprId}` : ''));

// Non-blocking heads-up for the Attestation stage — Additional/Detailed/Public Display are all
// real technical siblings, not prerequisites (see this file's own header), so submitting without
// them is genuinely allowed; this only makes sure the manager notices before signing, matching
// "checklist that helps, never a dead end" over a hard gate that would just recreate the original
// deadlock in a new place.
const incompleteBeforeSubmit = computed(() => {
  const missing = [];
  if (!additionalInfoDone.value) missing.push('Additional Information');
  if (!detailedInfoDone.value) missing.push('Detailed Information');
  if (!publicDisplayConfirmed.value) missing.push('Public Display Settings');
  return missing;
});

async function doSubmit() {
  if (!managerToken.value) { setLocalError('Log in with the Facility Manager’s HPR ID first.'); return; }
  clearError();
  loading.submit = true;
  const res = await callAbdmGateway('/hfr/facility/submit', {
    body: buildHfrSubmitBody(props.record, trackingId.value), extraHeaders: { 'X-HPRID-Auth-Token': managerToken.value },
  });
  loading.submit = false;
  if (!res.success) { setAbdmError(res, 'Submission failed.'); return; }
  facilityId.value = res.facilityId;
  patchOrCreateGroupField(props.record.id, REGISTRATION_GROUP, 'hospital_facility_id', res.facilityId);
  activeStageId.value = 'submitted';
  emit('submitted', { facilityId: res.facilityId, trackingId: trackingId.value });
}
</script>

<template>
  <div class="cf-card rounded-2xl p-4 mt-3">
    <div class="flex items-center justify-between mb-2">
      <p class="cf-label mb-0"><i class="fas fa-satellite-dish mr-1.5"></i>ABDM Facility Registration (HFR)</p>
      <span class="text-xs font-semibold" style="color:var(--color-primary)">{{ overallStatusLabel }}</span>
    </div>
    <div v-if="errorDetails.length" class="mb-2 p-2 rounded-lg" style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25)">
      <p v-for="(d, i) in errorDetails" :key="i" class="text-xs font-medium flex items-center gap-2 flex-wrap" style="color:#b91c1c">
        <span>{{ d.message }}</span>
        <button v-if="d.stageId" class="btn-ghost text-[11px] px-2 py-0.5" @click="goToErrorStage(d.stageId)">
          <i class="fas fa-arrow-right"></i> Fix in {{ d.label }}
        </button>
      </p>
    </div>

    <RegistrationLedger :stages="ledgerStages" v-model:active-id="activeStageId">
      <template #basic>
        <div v-if="!managerToken" class="mb-3 pb-3" style="border-bottom:1px dashed var(--cf-border)">
          <div class="flex gap-2 items-end flex-wrap">
            <input class="cf-input flex-1 min-w-[140px]" v-model="managerLogin.hprId" placeholder="Facility Manager's HPR ID" />
            <input class="cf-input flex-1 min-w-[120px]" v-model="managerLogin.password" type="password" placeholder="Password" />
            <button class="btn-outline text-xs" :disabled="loading.login" @click="managerPasswordLogin()">
              <i class="fas" :class="loading.login ? 'fa-spinner fa-spin' : 'fa-right-to-bracket'"></i> Log in
            </button>
          </div>
          <p class="text-[11px] mt-1" style="color:var(--cf-text)">Must be a person with their own HPR ID — see the Care Team card's HPR registration.</p>
        </div>

        <div class="grid grid-cols-2 gap-2 mb-2">
          <select class="cf-input" v-model="fields.ownershipCode">
            <option value="">Ownership…</option>
            <option v-for="o in master.owners" :key="o.code" :value="o.code">{{ o.value }}</option>
          </select>
          <select class="cf-input" v-model="fields.operationalStatus">
            <option value="">Operational status…</option>
            <option v-for="s in master.statuses" :key="s.code" :value="s.code">{{ s.value }}</option>
          </select>
          <select class="cf-input" v-model="fields.ownershipBucket">
            <option value="">Ownership sub-type category…</option>
            <option value="PROFIT">Profit</option>
            <option value="NON-PROFIT">Non-Profit</option>
          </select>
          <select class="cf-input" v-model="fields.ownershipSubtypeCode2" :disabled="!fields.ownershipBucket">
            <option value="">Ownership sub-type…</option>
            <option v-for="s in (fields.ownershipBucket === 'PROFIT' ? master.profitTypes : master.nonProfitTypes)" :key="s.code" :value="s.code">{{ s.value }}</option>
          </select>
          <!-- facilityTypeCode/facilitySubtype/ownershipSubtypeCode: real live cascading lookups
               now (fetch-facility-type/fetch-facility-Sub-type/get-owner-subtype) — a real bug
               found live: the gateway's own routes for these called a required-body POST as a
               bodyless GET, which always failed regardless of sandbox health (fixed in
               clinuxflow-abdm-gateway/src/routes/hfr.js). Facility Type depends on BOTH Ownership
               above and System(s) of Medicine below — disabled with a hint until both are set. -->
          <select class="cf-input" v-model="fields.facilityTypeCode" :disabled="!master.facilityTypes.length">
            <option value="">{{ master.facilityTypes.length ? 'Facility type…' : 'Facility type… (needs Ownership + System of Medicine below)' }}</option>
            <option v-for="s in master.facilityTypes" :key="s.code" :value="s.code">{{ s.value }}</option>
          </select>
          <select class="cf-input" v-model="fields.facilitySubtype" :disabled="!fields.facilityTypeCode">
            <option value="">Facility sub-type…</option>
            <option v-for="s in master.facilitySubtypes" :key="s.code" :value="s.code">{{ s.value }}</option>
          </select>
          <select class="cf-input" v-model="fields.ownershipSubtypeCode" :disabled="!fields.ownershipCode">
            <option value="">Ownership sub-type…</option>
            <option v-for="s in master.ownerSubtypes" :key="s.code" :value="s.code">{{ s.value }}</option>
          </select>
          <select class="cf-input" v-model="fields.typeOfServiceCode">
            <option value="">Type of service…</option>
            <option v-for="s in master.services" :key="s.code" :value="s.code">{{ s.value }}</option>
          </select>
          <select class="cf-input" v-model="fields.specialityTypeCode">
            <option value="">Speciality type…</option>
            <option v-for="s in master.specialityTypes" :key="s.code" :value="s.code">{{ s.value }}</option>
          </select>
          <select class="cf-input" v-model="fields.facilityRegion">
            <option value="">Region…</option>
            <option v-for="s in master.regions" :key="s.code" :value="s.code">{{ s.value }}</option>
          </select>
          <select class="cf-input" v-model="fields.stateLgdCode">
            <option value="">State (LGD)…</option>
            <option v-for="s in master.states" :key="s.code" :value="s.code">{{ s.name }}</option>
          </select>
          <select class="cf-input" v-model="fields.districtLgdCode" :disabled="!fields.stateLgdCode">
            <option value="">District (LGD)…</option>
            <option v-for="d in master.districts" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
          <select class="cf-input" v-model="fields.subdistrictLgdCode" :disabled="!fields.districtLgdCode">
            <option value="">Sub-district (LGD)…</option>
            <option v-for="d in master.subdistricts" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
          <input class="cf-input" v-model="fields.geoLatitude" placeholder="Latitude (-90.000000 to 90.000000)" />
          <input class="cf-input" v-model="fields.geoLongitude" placeholder="Longitude (-180.000000 to 180.000000)" />
        </div>

        <!-- Search, folded in here (not its own gated stage) — it needs exactly the fields just
             above (ownership/state/facility name), so checking for duplicates is one click away
             from filling them in, never blocked behind itself. Optional: nothing below requires
             running this first. -->
        <div class="mb-2">
          <button class="btn-outline text-xs" :disabled="loading.search" @click="doSearch()">
            <i class="fas" :class="loading.search ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> Check for duplicates in HFR
          </button>
          <p v-for="(f, i) in searchFeedback" :key="i" class="text-xs mt-1" style="color:var(--cf-text)">{{ f.message }}</p>
        </div>

        <div v-if="recommendedName" class="record-card p-2 mb-2 text-xs" style="justify-content:flex-start;gap:.75rem">
          <i class="fas fa-wand-magic-sparkles" style="color:var(--color-primary)"></i>
          <span style="flex:1">Recommended name for this facility type: <strong>{{ recommendedName }}</strong></span>
          <button class="btn-ghost text-xs px-2 py-1" @click="applyRecommendedName()">Use this name</button>
        </div>

        <!-- System(s) of Medicine — real multi-value field (Organization.extension:systemOfMedicine,
             FHIR cardinality 1..*), HFR master type='MEDICINE'. -->
        <p class="text-xs font-semibold mb-1" style="color:var(--cf-text-strong)">System(s) of Medicine</p>
        <div class="flex flex-wrap gap-3 mb-3 text-xs" style="color:var(--cf-text)">
          <label v-for="m in master.mediums" :key="m.code" class="flex items-center gap-1">
            <input type="checkbox" :checked="fields.systemOfMedicine.includes(m.code)" @change="toggleInArray('systemOfMedicine', m.code, $event.target.checked)" /> {{ m.value }}
          </label>
        </div>

        <!-- Facility photos — real base64-encoded uploads (HFR: facilityUploads.facilityBoardPhoto/
             facilityBuildingPhoto), both optional. -->
        <div class="grid grid-cols-2 gap-2 mb-3 text-xs">
          <div>
            <label class="cf-label">Board Photo</label>
            <input type="file" accept="image/*" @change="onPhotoSelected('boardPhoto', $event)" />
            <p v-if="fields.boardPhoto" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> {{ fields.boardPhoto.name }}</p>
          </div>
          <div>
            <label class="cf-label">Building Photo</label>
            <input type="file" accept="image/*" @change="onPhotoSelected('buildingPhoto', $event)" />
            <p v-if="fields.buildingPhoto" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> {{ fields.buildingPhoto.name }}</p>
          </div>
        </div>

        <!-- Address proof — facilityAddressProof, optional, a real doc-supported field
             previously captured nowhere in this panel. -->
        <div class="grid grid-cols-2 gap-2 mb-3 text-xs">
          <input class="cf-input" v-model="addressProof.type" placeholder="Address proof type (HFR master: ADDRESS-PROOF)" />
          <div>
            <input type="file" @change="onAddressProofSelected($event)" />
            <p v-if="addressProof.file" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> {{ addressProof.file.name }}</p>
          </div>
        </div>

        <!-- Additional Information's own hasX general-information flags — real 3-way codes
             (YALL/YIN/N), not a plain Y/N boolean (a real bug found and fixed). Captured here
             (Basic Info stage) since Additional Information's own request body needs them the
             moment that stage runs. -->
        <div class="grid grid-cols-2 gap-2 mb-3">
          <div v-for="[field, label] in [
            ['hasDialysisCenter', 'Dialysis Center'], ['hasPharmacy', 'Pharmacy'], ['hasBloodBank', 'Blood Bank'],
            ['hasCathLab', 'Cath Lab'], ['hasDiagnosticLab', 'Diagnostic Lab'], ['hasImagingCenter', 'Imaging Center'],
          ]" :key="field">
            <label class="cf-label">{{ label }}</label>
            <select class="cf-input" v-model="fields[field]">
              <option value="">Select…</option>
              <option v-for="g in master.generalInfo" :key="g.code" :value="g.code">{{ g.value }}</option>
            </select>
          </div>
        </div>

        <button class="btn-teal text-xs" :disabled="loading.basic || !managerToken" @click="doBasicInfo()">
          <i class="fas" :class="loading.basic ? 'fa-spinner fa-spin' : 'fa-file'"></i> Save &amp; Continue
        </button>
      </template>

      <template #additional>
        <p class="text-xs mb-2" style="color:var(--cf-text)">General facility information, plus any national programs already linked to this facility.</p>

        <p class="text-xs font-semibold mb-1 mt-2" style="color:var(--cf-text-strong)">Linked Program IDs (optional)</p>
        <div class="grid grid-cols-2 gap-2 mb-2 text-xs">
          <input class="cf-input" v-model="linkedProgram.nhrrId" placeholder="NHRR ID" />
          <input class="cf-input" v-model="linkedProgram.nin" placeholder="National Identification Number (NIN)" />
          <input class="cf-input" v-model="linkedProgram.rohiniId" placeholder="ROHINI ID (IIB)" />
          <input class="cf-input" v-model="linkedProgram.abpmjayId" placeholder="AB PMJAY Hospital ID" />
          <input class="cf-input" v-model="linkedProgram.cghsId" placeholder="CGHS Hospital ID" />
          <input class="cf-input" v-model="linkedProgram.echsId" placeholder="ECHS Hospital ID" />
          <input class="cf-input" v-model="linkedProgram.ceaRegistration" placeholder="CEA Registration No." />
          <input class="cf-input" v-model="linkedProgram.stateInsuranceSchemeId" placeholder="State Insurance Scheme Hospital ID" />
        </div>

        <p class="text-xs font-semibold mb-1" style="color:var(--cf-text-strong)">Source of information (only if this facility record was migrated from another system)</p>
        <div class="grid grid-cols-2 gap-2 mb-3 text-xs">
          <input class="cf-input" v-model="linkedProgram.sourceOfInformation" placeholder="Source (e.g. STHMISID, NHRR — leave blank for a self-registered facility)" />
          <input class="cf-input" v-model="linkedProgram.sourceUniqueId" placeholder="Source Unique ID" />
        </div>

        <button class="btn-teal text-xs" :disabled="loading.additional" @click="doAdditionalInfo()">
          <i class="fas" :class="loading.additional ? 'fa-spinner fa-spin' : 'fa-file-circle-plus'"></i> Save &amp; Continue
        </button>
      </template>

      <template #detailed>
        <div v-if="offered(fields.hasPharmacy)" class="cf-card p-2.5 mb-2">
          <p class="text-xs font-semibold mb-1" style="color:var(--cf-text-strong)">Pharmacy Details</p>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <select class="cf-input" v-model="fields.pharmacyJanAushadhi">
              <option value="">Jan Aushadhi Kendra?…</option>
              <option v-for="g in master.generalInfo" :key="g.code" :value="g.code">{{ g.value }}</option>
            </select>
            <input class="cf-input" v-model="fields.pharmacyJanAushadhiId" placeholder="Jan Aushadhi Kendra ID" />
            <input class="cf-input" v-model="fields.pharmacyDrugLicense" placeholder="Drug License Number" />
            <input class="cf-input" v-model="fields.pharmacyGstin" placeholder="Pharmacy GSTIN Number" />
            <input class="cf-input" v-model="fields.pharmacistRegistration" placeholder="Pharmacist Registration Number" />
          </div>
        </div>

        <div v-if="offered(fields.hasBloodBank)" class="cf-card p-2.5 mb-2">
          <p class="text-xs font-semibold mb-1" style="color:var(--cf-text-strong)">Blood Bank Details</p>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <select class="cf-input" v-model="fields.bloodbankERaktkosh">
              <option value="">Registered in e-Raktkosh?…</option>
              <option v-for="g in master.generalInfo" :key="g.code" :value="g.code">{{ g.value }}</option>
            </select>
            <input class="cf-input" v-model="fields.bloodbankERaktkoshId" placeholder="e-Raktkosh ID" />
            <input class="cf-input" v-model="fields.bloodbankLicense" placeholder="Blood Bank License Number" />
          </div>
        </div>

        <div v-if="offered(fields.hasImagingCenter)" class="cf-card p-2.5 mb-2">
          <p class="text-xs font-semibold mb-1" style="color:var(--cf-text-strong)">Imaging Services</p>
          <div class="flex flex-wrap gap-3 text-xs" style="color:var(--cf-text)">
            <label v-for="m in master.imaging" :key="m.code" class="flex items-center gap-1">
              <input type="checkbox" :checked="fields.imagingServices.includes(m.code)" @change="toggleInArray('imagingServices', m.code, $event.target.checked)" /> {{ m.value }}
            </label>
          </div>
        </div>

        <div v-if="offered(fields.hasDiagnosticLab)" class="cf-card p-2.5 mb-2">
          <p class="text-xs font-semibold mb-1" style="color:var(--cf-text-strong)">Diagnostic Lab Services</p>
          <div class="flex flex-wrap gap-3 text-xs" style="color:var(--cf-text)">
            <label v-for="m in master.diagnostic" :key="m.code" class="flex items-center gap-1">
              <input type="checkbox" :checked="fields.diagnosticServices.includes(m.code)" @change="toggleInArray('diagnosticServices', m.code, $event.target.checked)" /> {{ m.value }}
            </label>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2 mb-3 text-xs">
          <input class="cf-input" v-model="fields.totalBeds" placeholder="Total number of beds" />
          <input class="cf-input" v-model="fields.dentalChairs" placeholder="Number of dental chairs (if Dentistry)" />
        </div>

        <button class="btn-teal text-xs" :disabled="loading.detailed" @click="doDetailedInfo()">
          <i class="fas" :class="loading.detailed ? 'fa-spinner fa-spin' : 'fa-list-check'"></i> Save &amp; Continue
        </button>
      </template>

      <template #public_display>
        <p class="text-xs mb-3" style="color:var(--cf-text)">
          These fields are always shown on your public facility page: name, ownership, system of medicine, facility
          type, state, timing, address, and operational status. Everything below is your choice.
        </p>

        <label class="flex items-start gap-2 mb-3 text-xs" style="color:var(--cf-text-strong);font-weight:600">
          <input type="checkbox" v-model="publicDisplay.optOut" style="margin-top:.15rem" />
          <span>Don't show my facility's details to the public at all</span>
        </label>

        <div v-if="!publicDisplay.optOut">
          <div class="grid grid-cols-2 gap-2 mb-3 text-xs" style="color:var(--cf-text)">
            <label class="flex items-center gap-2"><input type="checkbox" v-model="publicDisplay.mobile" /> Mobile number</label>
            <label class="flex items-center gap-2"><input type="checkbox" v-model="publicDisplay.email" /> Email</label>
            <label class="flex items-center gap-2"><input type="checkbox" v-model="publicDisplay.landline" /> Landline</label>
            <label class="flex items-center gap-2"><input type="checkbox" v-model="publicDisplay.website" /> Website</label>
            <label class="flex items-center gap-2"><input type="checkbox" v-model="publicDisplay.photo" /> Facility photo</label>
            <label class="flex items-center gap-2"><input type="checkbox" v-model="publicDisplay.beds" /> Total beds / ventilators</label>
          </div>
          <label class="cf-label">About (shown on your public facility page)</label>
          <textarea class="cf-input mb-3" rows="3" v-model="publicDisplay.about" placeholder="A short description of your facility…" maxlength="500"></textarea>
        </div>

        <button class="btn-teal text-xs" @click="confirmPublicDisplay()">
          <i class="fas fa-eye"></i> Confirm &amp; Continue
        </button>
      </template>

      <template #attestation>
        <p v-if="incompleteBeforeSubmit.length" class="text-xs mb-3 p-2 rounded-lg" style="color:#92400e;background:rgba(217,119,6,.1);border:1px solid rgba(217,119,6,.25)">
          <i class="fas fa-triangle-exclamation"></i> You haven't completed {{ incompleteBeforeSubmit.join(', ') }} yet. You can still sign and submit —
          they're optional/independent — but ABDM may ask for them if this facility offers services that need them.
        </p>
        <AttestationCard
          v-model:consented="attestationConsented"
          title="Facility Registration Declaration"
          :summary="attestationSummary"
          declaration-text="I am the applicant of the above facility, and do hereby verify that the details as submitted on the portal pertaining to the above facility are true to my personal knowledge and nothing material has been concealed or falsely stated. I request that the facility be verified so it can be approved for existence on the portal."
          :can-sign="!!managerToken"
          cannot-sign-reason="Log in with the Facility Manager's HPR ID first."
          :signing-as-label="signingAsLabel"
          :loading="loading.submit"
          @sign="doSubmit()"
        />
        <div v-if="!managerToken" class="mt-3">
          <div class="flex gap-2 items-end flex-wrap">
            <input class="cf-input flex-1 min-w-[140px]" v-model="managerLogin.hprId" placeholder="Facility Manager's HPR ID" />
            <input class="cf-input flex-1 min-w-[120px]" v-model="managerLogin.password" type="password" placeholder="Password" />
            <button class="btn-outline text-xs" :disabled="loading.login" @click="managerPasswordLogin()">
              <i class="fas" :class="loading.login ? 'fa-spinner fa-spin' : 'fa-right-to-bracket'"></i> Log in
            </button>
          </div>
        </div>
      </template>

      <template #submitted>
        <div class="record-card p-2.5">
          <p class="text-sm font-semibold" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Registered with HFR</p>
          <p class="text-xs" style="color:var(--cf-text)">Facility ID: {{ facilityId }}</p>
        </div>
      </template>
    </RegistrationLedger>

    <p v-if="trackingId" class="text-[11px] mt-2" style="color:var(--cf-text)">Tracking ID: <strong>{{ trackingId }}</strong></p>
  </div>
</template>
