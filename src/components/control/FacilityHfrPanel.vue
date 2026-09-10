<script setup>
// Real HFR (Health Facility Registry) registration, layered on top of FacilityBasicsHost.vue's
// local FHIR capture — same "small panel next to the new Host component, calling the real
// gateway directly" shape PatientAbhaPanel.vue already established for Patient/ABHA. Ported from
// AbdmOnboarding.vue's own working hfrSearch/hfrBasicInfo/hfrAdditionalInfo/hfrDetailedInfo/
// hfrSubmit sequence (that page was retired once this landed), not reinvented.
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
//     PROFIT-TYPE/NON-PROFIT-TYPE-backed ownershipSubtypeCode2) stay free-text: their real
//     dedicated ABDM endpoints (fetch-facility-type/fetch-facility-Sub-type/get-owner-subtype) are
//     returning real HIS-500 errors on the live sandbox as of this build — no reliable source to
//     bind them to yet. Same reasoning excludes a `specialities` capture section entirely
//     (get-specialities is also down) — Detailed Information's own specialities[] is deliberately
//     not built here, see buildHfrDetailedInfoBody's own header.
//
// Detailed Information's own conditional sections (pharmacy/blood-bank/imaging/diagnostic/
// medical-infrastructure) render only when the matching Additional Information hasX flag is
// YALL/YIN — the real API rejects a section sent for a facility that doesn't offer it, per the
// doc's own error-response sample (see abdmAdapter.js's buildHfrDetailedInfoBody).
import { onMounted, reactive, ref, watch } from 'vue';
import { callAbdmGateway } from '../../data/control/abdmGatewayClient.js';
import {
  buildHprPasswordLoginBody, buildHfrSearchBody, buildHfrBasicInfoBody,
  buildHfrAdditionalInfoBody, buildHfrDetailedInfoBody, buildHfrSubmitBody,
} from '../../data/control/abdmAdapter.js';
import { getAnswer, getAnswers, patchRecordField, patchRecordMultiField } from '../../data/useSystemForms.js';
import { API_BASE, apiFetch } from '../../config.js';

const props = defineProps({
  record: { type: Object, default: null }, // onboarding.getProviderRecord() — the whole Provider composition
});
const emit = defineEmits(['submitted']);

const STEP_LABELS = {
  not_started: 'Not started', searched: 'Searched', basic_submitted: 'Basic info submitted',
  additional_submitted: 'Additional info submitted', detailed_submitted: 'Detailed info submitted', submitted: 'Submitted to HFR',
};

const step = ref('not_started');
const trackingId = ref(null);
const facilityId = ref(null);
const errorMsg = ref('');
const loading = reactive({ search: false, basic: false, additional: false, detailed: false, submit: false, login: false });

// Facility-manager token — the person completing this must already hold their OWN HPR ID
// (see ProviderHprPanel.vue) and log in with it; this gateway can't obtain that on their behalf
// (clinuxflow-abdm-gateway/src/routes/hfr.js's own header comment). Memory only, never persisted.
const managerLogin = reactive({ hprId: '', password: '' });
const managerToken = ref(null);

async function managerPasswordLogin() {
  if (!managerLogin.hprId || !managerLogin.password) { errorMsg.value = 'Enter an HPR ID and password.'; return; }
  errorMsg.value = '';
  loading.login = true;
  const res = await callAbdmGateway('/hpr/auth/password-login', { body: buildHprPasswordLoginBody(managerLogin.hprId, managerLogin.password) });
  loading.login = false;
  managerLogin.password = '';
  if (!res.success) { errorMsg.value = res.error || 'Login failed.'; return; }
  managerToken.value = res.token;
}

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
  boardPhoto: null, buildingPhoto: null, // { name, value(base64) } | null
});
const master = reactive({
  owners: [], profitTypes: [], nonProfitTypes: [], statuses: [], services: [], mediums: [], specialityTypes: [], regions: [],
  generalInfo: [], imaging: [], diagnostic: [], states: [], districts: [], subdistricts: [],
});

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
  trackingId.value = getAnswer(props.record, 'hospital_tracking_id') || null;
  facilityId.value = getAnswer(props.record, 'hospital_facility_id') || null;
  if (facilityId.value) step.value = 'submitted';
  else if (trackingId.value) step.value = 'basic_submitted';
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
    errorMsg.value = e.message || 'Could not read that file.';
  }
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
  // Re-run the dependent watchers now that master data + a persisted record are both in —
  // watch() with immediate:true above already ran before onMounted's async work resolved, so a
  // saved selection needs its dependent dropdown loaded here explicitly, once.
  if (fields.ownershipBucket === 'PROFIT') master.profitTypes = await loadValueSet('PROFIT-TYPE');
  if (fields.ownershipBucket === 'NON-PROFIT') master.nonProfitTypes = await loadValueSet('NON-PROFIT-TYPE');
  if (fields.stateLgdCode) master.districts = await loadDistricts(fields.stateLgdCode);
  if (fields.districtLgdCode) master.subdistricts = await loadSubdistricts(fields.districtLgdCode);
});

function offered(v) { return v === 'YALL' || v === 'YIN'; }

function persistHfrFields() {
  if (!props.record) return;
  patchRecordField(props.record.id, 'hospital_ownership_code', fields.ownershipCode);
  patchRecordField(props.record.id, 'hospital_ownership_subtype_code', fields.ownershipSubtypeCode);
  patchRecordField(props.record.id, 'hospital_ownership_subtype_code_2', fields.ownershipSubtypeCode2);
  patchRecordField(props.record.id, 'hospital_facility_type', fields.facilityTypeCode);
  patchRecordField(props.record.id, 'hospital_facility_subtype', fields.facilitySubtype);
  patchRecordField(props.record.id, 'hospital_type_of_service_code', fields.typeOfServiceCode);
  patchRecordField(props.record.id, 'hospital_speciality_type_code', fields.specialityTypeCode);
  patchRecordField(props.record.id, 'hospital_facility_region', fields.facilityRegion);
  patchRecordField(props.record.id, 'hospital_operational_status_code', fields.operationalStatus);
  patchRecordField(props.record.id, 'hospital_state_lgd_code', fields.stateLgdCode);
  patchRecordField(props.record.id, 'hospital_district_lgd_code', fields.districtLgdCode);
  patchRecordField(props.record.id, 'hospital_subdistrict_lgd_code', fields.subdistrictLgdCode);
  patchRecordField(props.record.id, 'hospital_geo_latitude', fields.geoLatitude);
  patchRecordField(props.record.id, 'hospital_geo_longitude', fields.geoLongitude);
  patchRecordMultiField(props.record.id, 'hospital_system_of_medicine', fields.systemOfMedicine);
  patchRecordField(props.record.id, 'hospital_has_dialysis_center', fields.hasDialysisCenter);
  patchRecordField(props.record.id, 'hospital_has_pharmacy', fields.hasPharmacy);
  patchRecordField(props.record.id, 'hospital_has_blood_bank', fields.hasBloodBank);
  patchRecordField(props.record.id, 'hospital_has_cath_lab', fields.hasCathLab);
  patchRecordField(props.record.id, 'hospital_has_diagnostic_lab', fields.hasDiagnosticLab);
  patchRecordField(props.record.id, 'hospital_has_imaging_center', fields.hasImagingCenter);
}

function persistDetailedFields() {
  if (!props.record) return;
  patchRecordField(props.record.id, 'hospital_pharmacy_jan_aushadhi', fields.pharmacyJanAushadhi);
  patchRecordField(props.record.id, 'hospital_pharmacy_jan_aushadhi_id', fields.pharmacyJanAushadhiId);
  patchRecordField(props.record.id, 'hospital_pharmacy_drug_license', fields.pharmacyDrugLicense);
  patchRecordField(props.record.id, 'hospital_pharmacy_gstin', fields.pharmacyGstin);
  patchRecordField(props.record.id, 'hospital_pharmacist_registration', fields.pharmacistRegistration);
  patchRecordField(props.record.id, 'hospital_bloodbank_eraktkosh', fields.bloodbankERaktkosh);
  patchRecordField(props.record.id, 'hospital_bloodbank_eraktkosh_id', fields.bloodbankERaktkoshId);
  patchRecordField(props.record.id, 'hospital_bloodbank_license', fields.bloodbankLicense);
  patchRecordMultiField(props.record.id, 'hospital_imaging_services', fields.imagingServices);
  patchRecordMultiField(props.record.id, 'hospital_diagnostic_services', fields.diagnosticServices);
  patchRecordField(props.record.id, 'hospital_total_beds', fields.totalBeds);
  patchRecordField(props.record.id, 'hospital_dental_chairs', fields.dentalChairs);
}

async function doSearch() {
  if (!props.record) { errorMsg.value = 'Save the Hospital Profile first.'; return; }
  errorMsg.value = '';
  persistHfrFields();
  loading.search = true;
  const res = await callAbdmGateway('/hfr/facility/search', { body: buildHfrSearchBody(props.record) });
  loading.search = false;
  if (!res.success) { errorMsg.value = res.error || 'Search failed.'; return; }
  step.value = 'searched';
}

async function doBasicInfo() {
  if (!managerToken.value) { errorMsg.value = 'Log in with the Facility Manager’s HPR ID first.'; return; }
  errorMsg.value = '';
  persistHfrFields();
  loading.basic = true;
  const res = await callAbdmGateway('/hfr/facility/basic-information', {
    body: buildHfrBasicInfoBody(props.record, { boardPhoto: fields.boardPhoto, buildingPhoto: fields.buildingPhoto }),
    extraHeaders: { 'X-HPRID-Auth-Token': managerToken.value },
  });
  loading.basic = false;
  if (!res.success) { errorMsg.value = res.error || 'Basic information submission failed.'; return; }
  trackingId.value = res.trackingId;
  step.value = 'basic_submitted';
  patchRecordField(props.record.id, 'hospital_tracking_id', res.trackingId);
}

async function doAdditionalInfo() {
  errorMsg.value = '';
  persistHfrFields();
  loading.additional = true;
  const res = await callAbdmGateway('/hfr/facility/additional-information', { body: buildHfrAdditionalInfoBody(props.record, trackingId.value) });
  loading.additional = false;
  if (!res.success) { errorMsg.value = res.error || 'Additional information submission failed.'; return; }
  step.value = 'additional_submitted';
}

async function doDetailedInfo() {
  errorMsg.value = '';
  persistDetailedFields();
  loading.detailed = true;
  const res = await callAbdmGateway('/hfr/facility/detailed-information', { body: buildHfrDetailedInfoBody(props.record, trackingId.value) });
  loading.detailed = false;
  if (!res.success) { errorMsg.value = res.error || 'Detailed information submission failed.'; return; }
  step.value = 'detailed_submitted';
}

async function doSubmit() {
  if (!managerToken.value) { errorMsg.value = 'Log in with the Facility Manager’s HPR ID first.'; return; }
  errorMsg.value = '';
  loading.submit = true;
  const res = await callAbdmGateway('/hfr/facility/submit', {
    body: buildHfrSubmitBody(props.record, trackingId.value), extraHeaders: { 'X-HPRID-Auth-Token': managerToken.value },
  });
  loading.submit = false;
  if (!res.success) { errorMsg.value = res.error || 'Submission failed.'; return; }
  facilityId.value = res.facilityId;
  step.value = 'submitted';
  patchRecordField(props.record.id, 'hospital_facility_id', res.facilityId);
  emit('submitted', { facilityId: res.facilityId, trackingId: trackingId.value });
}
</script>

<template>
  <div class="cf-card rounded-2xl p-4 mt-3">
    <div class="flex items-center justify-between mb-2">
      <p class="cf-label mb-0"><i class="fas fa-satellite-dish mr-1.5"></i>ABDM Facility Registration (HFR)</p>
      <span class="text-xs font-semibold" style="color:var(--color-primary)">{{ STEP_LABELS[step] }}</span>
    </div>
    <p v-show="errorMsg" class="text-red-500 text-xs font-medium mb-2">{{ errorMsg }}</p>

    <div v-if="step === 'submitted'" class="record-card p-2.5">
      <p class="text-sm font-semibold" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Registered with HFR</p>
      <p class="text-xs" style="color:var(--cf-text)">Facility ID: {{ facilityId }}</p>
    </div>

    <template v-else>
      <!-- Facility Manager login — required for basic-information and submit -->
      <div class="mb-3 pb-3" style="border-bottom:1px dashed var(--cf-border)">
        <p v-if="managerToken" class="text-xs" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Facility Manager token held.</p>
        <div v-else class="flex gap-2 items-end flex-wrap">
          <input class="cf-input flex-1 min-w-[140px]" v-model="managerLogin.hprId" placeholder="Facility Manager's HPR ID" />
          <input class="cf-input flex-1 min-w-[120px]" v-model="managerLogin.password" type="password" placeholder="Password" />
          <button class="btn-outline text-xs" :disabled="loading.login" @click="managerPasswordLogin()">
            <i class="fas" :class="loading.login ? 'fa-spinner fa-spin' : 'fa-right-to-bracket'"></i> Log in
          </button>
        </div>
        <p class="text-[11px] mt-1" style="color:var(--cf-text)">Must be a person with their own HPR ID — see the Care Team card's HPR registration.</p>
      </div>

      <!-- HFR-specific fields -->
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
        <!-- facilityTypeCode/facilitySubtype/ownershipSubtypeCode: HFR's own dedicated master
             endpoints for these are down on the sandbox as of this build (see this file's own
             header) — real text-input codes, same as the YAML's own TextInput choice for them. -->
        <input class="cf-input" v-model="fields.facilityTypeCode" placeholder="Facility type code (HFR master: facility-types)" />
        <input class="cf-input" v-model="fields.facilitySubtype" placeholder="Facility sub-type code (HFR master: facility-sub-types)" />
        <input class="cf-input" v-model="fields.ownershipSubtypeCode" placeholder="Ownership sub-type code (HFR master: get-owner-subtype)" />
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

      <!-- Additional Information's own hasX general-information flags — real 3-way codes
           (YALL/YIN/N), not a plain Y/N boolean (a real bug found and fixed). -->
      <div class="grid grid-cols-2 gap-2 mb-2">
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

      <!-- Detailed Information's own conditional sections — shown only when the matching hasX
           flag is YALL/YIN (matches buildHfrDetailedInfoBody's own conditional inclusion). -->
      <div v-if="offered(fields.hasPharmacy)" class="cf-card p-2.5 mb-2" style="background:var(--cf-bg-subtle,transparent)">
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

      <div v-if="offered(fields.hasBloodBank)" class="cf-card p-2.5 mb-2" style="background:var(--cf-bg-subtle,transparent)">
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

      <div v-if="offered(fields.hasImagingCenter)" class="cf-card p-2.5 mb-2" style="background:var(--cf-bg-subtle,transparent)">
        <p class="text-xs font-semibold mb-1" style="color:var(--cf-text-strong)">Imaging Services</p>
        <div class="flex flex-wrap gap-3 text-xs" style="color:var(--cf-text)">
          <label v-for="m in master.imaging" :key="m.code" class="flex items-center gap-1">
            <input type="checkbox" :checked="fields.imagingServices.includes(m.code)" @change="toggleInArray('imagingServices', m.code, $event.target.checked)" /> {{ m.value }}
          </label>
        </div>
      </div>

      <div v-if="offered(fields.hasDiagnosticLab)" class="cf-card p-2.5 mb-2" style="background:var(--cf-bg-subtle,transparent)">
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

      <div class="flex gap-2 flex-wrap">
        <button class="btn-outline text-xs" :disabled="loading.search" @click="doSearch()">
          <i class="fas" :class="loading.search ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> Search
        </button>
        <button class="btn-outline text-xs" :disabled="loading.basic || !managerToken" @click="doBasicInfo()">
          <i class="fas" :class="loading.basic ? 'fa-spinner fa-spin' : 'fa-file'"></i> Basic Information
        </button>
        <button class="btn-outline text-xs" :disabled="loading.additional || !trackingId" @click="doAdditionalInfo()">
          <i class="fas" :class="loading.additional ? 'fa-spinner fa-spin' : 'fa-file-circle-plus'"></i> Additional Information
        </button>
        <button class="btn-outline text-xs" :disabled="loading.detailed || !trackingId" @click="doDetailedInfo()">
          <i class="fas" :class="loading.detailed ? 'fa-spinner fa-spin' : 'fa-list-check'"></i> Detailed Information
        </button>
        <button class="btn-teal text-xs" :disabled="loading.submit || !trackingId || !managerToken" @click="doSubmit()">
          <i class="fas" :class="loading.submit ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i> Submit
        </button>
      </div>
      <p v-if="trackingId" class="text-[11px] mt-2" style="color:var(--cf-text)">Tracking ID: <strong>{{ trackingId }}</strong></p>
    </template>
  </div>
</template>
