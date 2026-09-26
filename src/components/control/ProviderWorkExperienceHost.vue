<script setup>
// Practitioner's own Work Experience — the 3rd of 3 separate tree elements (explicit instruction).
// A single (non-repeating) declaration, unlike Qualifications — mirrors the real NHPR spec's own
// currentWorkDetails block. Deliberately flat fields directly on section_staff (not a nested
// group): system-provider-composition-v1.yaml's own comment documents that a nested-group version
// of this exact block was tried and reverted — no natural repeating backbone element to nest
// under, and it added real risk for zero benefit over the same proven flat-sibling-field mechanism
// staff_hp_category_code etc. already use.
//
// Search Facility is now real (explicit gap the user named) — reuses the already-built,
// already-verified /hfr/facility/search gateway route (the same one FacilityHfrPanel.vue's own
// "check before self-registering" step already calls, just for a different caller here: a
// practitioner looking up an ALREADY-REGISTERED facility to link their Work Experience to). The
// real search response's own result-list field name isn't independently confirmed yet (this
// gateway route is a thin passthrough of whatever ABDM returns, and nothing in this codebase had
// a picker UI consuming it before now) — shown as inspectable raw JSON below the search box, with
// a plain "paste the Facility ID here" fallback, same honesty this app's other not-yet-live-tested
// HPR/HFR integrations already carry; becomes a real clickable list once a live sandbox response
// confirms the exact field name. No getAllMinistry master data exists either — same honest-gap
// free-text treatment for the Ministry field.
//
// NHPR user manual gap analysis: "Nature of Work" is a real MULTI-select (kept as its own array
// ref, checkbox group — same pattern FacilityHfrPanel.vue's own "System(s) of Medicine" already
// uses, not the generic per-FIELD string loop below), plus Teleconsultation URL, Central/State ->
// PSU nesting, and a mandatory-when-government employment-proof upload — none of which existed
// here before.
import { ref, watch } from 'vue';
import { getAnswer, getAnswers, getGroupInstances, ensureGroupInstance, patchGroupInstanceField } from '../../data/useSystemForms.js';
import { callAbdmGateway } from '../../data/control/abdmGatewayClient.js';
import { buildHfrFacilitySearchByNameBody } from '../../data/control/abdmAdapter.js';

const props = defineProps({
  recordId: { type: String, required: true },
  record: { type: Object, default: null },
});
const emit = defineEmits(['saved']);

const NATURE_OF_WORK_CHOICES = ['Practice', 'Administrative', 'Teaching', 'Teleconsultation'];
const STATUS_CHOICES = ['Private', 'Government', 'Both'];
const GOVT_CATEGORY_CHOICES = ['Central', 'State'];

const FIELDS = [
  'staff_work_currently_working', 'staff_work_status', 'staff_work_reason_not_working', 'staff_work_teleconsultation_url',
  'staff_work_facility_id', 'staff_work_facility_name', 'staff_work_facility_address', 'staff_work_facility_pincode',
  'staff_work_facility_type', 'staff_work_facility_department', 'staff_work_facility_designation', 'staff_work_ministry',
  'staff_work_govt_category', 'staff_work_psu_yesno', 'staff_work_psu_name',
];
function blankFields() { return Object.fromEntries(FIELDS.map((f) => [f, f === 'staff_work_currently_working' ? true : ''])); }
const form = ref(blankFields());
const natureOfWork = ref([]); // real multi-select, separate from the generic string loop above
const govtProofDocument = ref(''); // base64, separate — a file upload, not a plain text field
const govtProofFileName = ref('');

function loadFromRecord() {
  const staffInstance = props.record ? getGroupInstances(props.record, 'section_staff')[0] : null;
  const rec = staffInstance ? { data: staffInstance } : null;
  if (!rec) { form.value = blankFields(); natureOfWork.value = []; govtProofDocument.value = ''; govtProofFileName.value = ''; return; }
  FIELDS.forEach((f) => {
    const raw = getAnswer(rec, f);
    form.value[f] = f === 'staff_work_currently_working' ? (raw === true || raw === 'true' || raw === '') : (raw || '');
  });
  natureOfWork.value = getAnswers(rec, 'staff_work_purpose');
  govtProofDocument.value = getAnswer(rec, 'staff_work_govt_proof_document') || '';
  govtProofFileName.value = govtProofDocument.value ? 'Already uploaded' : '';
}
watch(() => props.record, loadFromRecord, { immediate: true });

function toggleNatureOfWork(choice, checked) {
  natureOfWork.value = checked ? [...natureOfWork.value, choice] : natureOfWork.value.filter((c) => c !== choice);
}

// Same base64 FileReader pattern FacilityHfrPanel.vue's own board/building photos and
// ProviderQualificationsHost.vue's own certificate uploads already use.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const uploadError = ref('');
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_UPLOAD_BYTES) { reject(new Error('File is too large (max 2MB).')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function onGovtProofSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  uploadError.value = '';
  try { govtProofDocument.value = await readFileAsBase64(file); govtProofFileName.value = file.name; }
  catch (e) { uploadError.value = e.message || 'Could not read that file.'; }
}

function save() {
  ensureGroupInstance(props.recordId, 'section_staff');
  patchGroupInstanceField(props.recordId, 'section_staff', 0, {
    ...form.value, staff_work_purpose: natureOfWork.value, staff_work_govt_proof_document: govtProofDocument.value,
  });
  emit('saved');
}
defineExpose({ save });

// ─── Search Facility (see this file's own header for the honest-gap note on the response shape) ───
const search = ref({ name: '', stateLgdCode: '', loading: false, result: null, error: '' });
async function searchFacility() {
  if (!search.value.name) { search.value.error = 'Enter a facility name to search.'; return; }
  search.value.error = '';
  search.value.loading = true;
  search.value.result = null;
  const res = await callAbdmGateway('/hfr/facility/search', {
    body: buildHfrFacilitySearchByNameBody(search.value.name, search.value.stateLgdCode || undefined),
  });
  search.value.loading = false;
  if (!res.success) { search.value.error = res.error || 'Search failed.'; return; }
  search.value.result = res;
}
function useFacilityId() {
  if (!search.value.facilityIdInput) return;
  form.value.staff_work_facility_id = search.value.facilityIdInput;
  if (!form.value.staff_work_facility_name) form.value.staff_work_facility_name = search.value.name;
}
</script>

<template>
  <div class="cf-card rounded-2xl p-4 mb-3">
    <p class="cf-label mb-2">Search Facility</p>
    <p class="text-sm mb-3" style="color:var(--cf-text)">Look up an ABDM-registered facility to link your Work Experience to a real Facility ID.</p>
    <div class="flex items-center gap-2 flex-wrap">
      <input class="cf-input flex-1 min-w-[160px]" v-model="search.name" placeholder="Facility name" />
      <input class="cf-input" style="max-width:140px" v-model="search.stateLgdCode" placeholder="State LGD code" />
      <button class="btn-outline text-sm" :disabled="search.loading" @click="searchFacility()">
        <i class="fas" :class="search.loading ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> Search
      </button>
    </div>
    <p v-if="search.error" style="font-size:.75rem;color:#dc2626;margin-top:.5rem"><i class="fas fa-circle-exclamation"></i> {{ search.error }}</p>
    <div v-if="search.result" class="record-card p-2 mt-3 text-xs">
      <div style="max-height:160px;overflow-y:auto"><pre style="white-space:pre-wrap;font-size:10px">{{ search.result }}</pre></div>
      <div class="flex items-center gap-2 mt-2">
        <input class="cf-input flex-1" v-model="search.facilityIdInput" placeholder="Paste the Facility ID from above" />
        <button class="btn-outline text-xs" @click="useFacilityId()"><i class="fas fa-link"></i> Use This Facility</button>
      </div>
    </div>
    <p v-if="form.staff_work_facility_id" class="text-sm mt-2" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Linked to Facility ID {{ form.staff_work_facility_id }}</p>
  </div>

  <div class="cf-card rounded-2xl p-4 mb-3">
    <div class="cf-form-field-grid">
      <div><label class="flex items-center gap-2 text-sm" style="color:var(--cf-text)"><input type="checkbox" v-model="form.staff_work_currently_working" />Currently Working</label></div>
      <div>
        <label class="cf-label">Work Status</label>
        <select class="cf-input" v-model="form.staff_work_status">
          <option value="">Select…</option>
          <option v-for="c in STATUS_CHOICES" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div v-if="!form.staff_work_currently_working">
        <label class="cf-label">Reason for Not Working<span style="color:#dc2626"> *</span></label>
        <input class="cf-input" v-model="form.staff_work_reason_not_working" />
      </div>
    </div>

    <p class="cf-label mb-1 mt-3">Nature of Work</p>
    <div class="flex flex-wrap gap-3 mb-3 text-sm" style="color:var(--cf-text)">
      <label v-for="c in NATURE_OF_WORK_CHOICES" :key="c" class="flex items-center gap-1">
        <input type="checkbox" :checked="natureOfWork.includes(c)" @change="toggleNatureOfWork(c, $event.target.checked)" /> {{ c }}
      </label>
    </div>
    <div v-if="natureOfWork.includes('Teleconsultation')">
      <label class="cf-label">Teleconsultation URL</label>
      <input class="cf-input mb-3" v-model="form.staff_work_teleconsultation_url" placeholder="https://…" />
    </div>

    <div v-if="form.staff_work_status === 'Government' || form.staff_work_status === 'Both'" class="cf-card p-3 mb-3">
      <p class="cf-label mb-2">Government Employment Details</p>
      <div class="flex gap-3 mb-3 text-sm" style="color:var(--cf-text)">
        <label v-for="c in GOVT_CATEGORY_CHOICES" :key="c" class="flex items-center gap-1">
          <input type="radio" :value="c" v-model="form.staff_work_govt_category" /> {{ c }}
        </label>
      </div>
      <div v-if="form.staff_work_govt_category === 'Central'">
        <label class="cf-label">Ministry<span style="color:#dc2626"> *</span></label>
        <input class="cf-input mb-3" v-model="form.staff_work_ministry" />
        <p class="cf-label mb-1">Are you working in a PSU?</p>
        <div class="flex gap-3 mb-3 text-sm" style="color:var(--cf-text)">
          <label class="flex items-center gap-1"><input type="radio" value="Yes" v-model="form.staff_work_psu_yesno" /> Yes</label>
          <label class="flex items-center gap-1"><input type="radio" value="No" v-model="form.staff_work_psu_yesno" /> No</label>
        </div>
        <div v-if="form.staff_work_psu_yesno === 'Yes'">
          <label class="cf-label">PSU Name</label>
          <input class="cf-input mb-3" v-model="form.staff_work_psu_name" />
        </div>
      </div>
      <div v-if="form.staff_work_govt_category === 'State'">
        <label class="cf-label">Ministry / Department<span style="color:#dc2626"> *</span></label>
        <input class="cf-input mb-3" v-model="form.staff_work_ministry" />
      </div>
      <label class="cf-label">Employment Proof (Appointment Letter, Pay-slip, Transfer Order, etc.)<span style="color:#dc2626"> *</span></label>
      <input type="file" @change="onGovtProofSelected" />
      <p v-if="govtProofFileName" class="text-sm mt-1" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> {{ govtProofFileName }}</p>
      <p v-if="uploadError" style="font-size:.75rem;color:#dc2626;margin-top:.4rem"><i class="fas fa-circle-exclamation"></i> {{ uploadError }}</p>
    </div>

    <div class="cf-form-field-grid">
      <div><label class="cf-label">Facility Name</label><input class="cf-input" v-model="form.staff_work_facility_name" /></div>
      <div><label class="cf-label">Facility Address</label><input class="cf-input" v-model="form.staff_work_facility_address" /></div>
      <div><label class="cf-label">Facility Pincode</label><input class="cf-input" v-model="form.staff_work_facility_pincode" /></div>
      <div><label class="cf-label">Facility Type</label><input class="cf-input" v-model="form.staff_work_facility_type" /></div>
      <div><label class="cf-label">Facility Department</label><input class="cf-input" v-model="form.staff_work_facility_department" /></div>
      <div><label class="cf-label">Facility Designation</label><input class="cf-input" v-model="form.staff_work_facility_designation" /></div>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
