<script setup>
// SPEC-24 §7 step 6 (Patient) — hand-authored replacement for FrontDesk.vue's own `LhcFormHost`
// (LForms), not `CustomFormHost.vue` (Patient was never on that engine — see this file's own
// note in the SPEC-24 memory). Same drop-in extract() contract every other Host component in this
// pass already uses. Single-instance, like FacilityBasicsHost.vue (a patient record, like a
// facility, is one resource per record — never repeating within one QuestionnaireResponse).
//
// The ABHA section hosts PatientAbhaPanel.vue — a real find-or-create ABHA flow layered on top of
// this local capture (see that component's own header). A successful link prefills Demographics/
// Contact from the real ABHA profile rather than leaving the patient to retype it; going through
// ABHA is always optional — Demographics/Contact stay fully fillable on their own, same
// "most clinics won't need this to go green" tone Facility's own conformance panel already sets.
import { reactive, ref, watch } from 'vue';
import { getAnswer } from '../../data/useSystemForms.js';
import AdaptiveSectionNav from '../AdaptiveSectionNav.vue';
import PatientAbhaPanel from './PatientAbhaPanel.vue';

const props = defineProps({
  record: { type: Object, default: null }, // { data: { item: [{linkId:'section_patient', item:[...]}] } } | null
});

const GROUP_LINK_ID = 'section_patient';

const FIELDS = [
  { linkId: 'patient_first_name', label: 'First Name', kind: 'text', required: true },
  { linkId: 'patient_last_name', label: 'Last Name', kind: 'text' },
  { linkId: 'patient_active', label: 'Active', kind: 'boolean' },
  { linkId: 'patient_gender', label: 'Gender', kind: 'choice', choices: ['male', 'female', 'other', 'unknown'] },
  { linkId: 'patient_birthdate', label: 'Date of Birth', kind: 'date' },
  { linkId: 'patient_mobile', label: 'Mobile Number', kind: 'text' },
  { linkId: 'patient_emergency_contact_name', label: 'Emergency Contact Name', kind: 'text' },
  { linkId: 'patient_emergency_contact_phone', label: 'Emergency Contact Phone', kind: 'text' },
  { linkId: 'patient_abha_number', label: 'ABHA Number', kind: 'text' },
  { linkId: 'patient_abha_address', label: 'ABHA Address', kind: 'text' },
];
const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.linkId, f]));

const SECTIONS = [
  { id: 'demographics', label: 'Demographics', icon: 'fa-user', fields: ['patient_first_name', 'patient_last_name', 'patient_active', 'patient_gender', 'patient_birthdate'] },
  { id: 'contact', label: 'Contact', icon: 'fa-phone', fields: ['patient_mobile', 'patient_emergency_contact_name', 'patient_emergency_contact_phone'] },
  { id: 'abha', label: 'ABHA', icon: 'fa-id-card', fields: ['patient_abha_number', 'patient_abha_address'] },
];
const activeSectionId = ref(SECTIONS[0].id);

const form = reactive(Object.fromEntries(FIELDS.map((f) => [f.linkId, f.kind === 'boolean' ? false : ''])));
const touched = reactive({});

function rebuild() {
  FIELDS.forEach((f) => {
    form[f.linkId] = props.record ? (getAnswer(props.record, f.linkId) ?? (f.kind === 'boolean' ? false : '')) : (f.kind === 'boolean' ? false : '');
  });
  Object.keys(touched).forEach((k) => delete touched[k]);
}
watch(() => props.record, rebuild, { immediate: true });

function onAbhaLinked(profile) {
  if (profile.firstName) form.patient_first_name = profile.firstName;
  if (profile.lastName) form.patient_last_name = profile.lastName;
  if (!form.patient_first_name && profile.name) form.patient_first_name = profile.name.split(' ')[0];
  if (!form.patient_last_name && profile.name) form.patient_last_name = profile.name.split(' ').slice(1).join(' ');
  if (profile.gender) form.patient_gender = String(profile.gender).toLowerCase().startsWith('m') ? 'male' : String(profile.gender).toLowerCase().startsWith('f') ? 'female' : profile.gender;
  if (profile.dob) form.patient_birthdate = profile.dob;
  if (profile.mobile) form.patient_mobile = profile.mobile;
  if (profile.abhaNumber) form.patient_abha_number = profile.abhaNumber;
  if (profile.abhaAddress) form.patient_abha_address = profile.abhaAddress;
}

function errorFor(linkId) {
  const field = FIELD_BY_ID[linkId];
  if (!field?.required || !touched[linkId]) return '';
  return form[linkId] ? '' : `${field.label} is required.`;
}

function hasMissingRequired() {
  return FIELDS.some((f) => f.required && !form[f.linkId]);
}

function fhirValueKey(field) {
  if (field.kind === 'boolean') return 'valueBoolean';
  if (field.kind === 'date') return 'valueDate';
  return 'valueString';
}
function isBlank(v) { return v === '' || v === null || v === undefined; }

function extract() {
  if (hasMissingRequired()) {
    FIELDS.forEach((f) => { touched[f.linkId] = true; });
    return null; // same failure contract every other Host component in this pass uses
  }
  const item = FIELDS
    .filter((f) => !isBlank(form[f.linkId]) && form[f.linkId] !== false)
    .map((f) => ({ linkId: f.linkId, answer: [{ [fhirValueKey(f)]: form[f.linkId] }] }));
  // patient_name is a SEPARATE, legacy linkId AiEngine.vue's own patient grid/modal still reads
  // directly (see the YAML's own comment) — derived here so a patient is only ever typed once.
  const fullName = [form.patient_first_name, form.patient_last_name].filter(Boolean).join(' ');
  if (fullName) item.push({ linkId: 'patient_name', answer: [{ valueString: fullName }] });
  return { resourceType: 'QuestionnaireResponse', status: 'completed', item: [{ linkId: GROUP_LINK_ID, item }] };
}

defineExpose({ extract });
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="cf-card rounded-2xl p-4">
      <AdaptiveSectionNav :sections="SECTIONS" mode="tabs" storage-key="patient-basics" v-model:active-id="activeSectionId">
        <template v-for="section in SECTIONS" :key="section.id" #[section.id]>
          <template v-if="section.id === 'abha'">
            <PatientAbhaPanel @linked="onAbhaLinked" />
            <div class="cf-form-field-grid mt-3">
              <div v-for="linkId in section.fields" :key="linkId">
                <label class="cf-label">{{ FIELD_BY_ID[linkId].label }}</label>
                <input class="cf-input" v-model="form[linkId]" />
              </div>
            </div>
          </template>
          <div v-else class="cf-form-field-grid">
            <div v-for="linkId in section.fields" :key="linkId">
              <label v-if="FIELD_BY_ID[linkId].kind !== 'boolean'" class="cf-label">
                {{ FIELD_BY_ID[linkId].label }}<span v-if="FIELD_BY_ID[linkId].required" style="color:#dc2626"> *</span>
              </label>
              <input v-if="FIELD_BY_ID[linkId].kind === 'text'" class="cf-input" v-model="form[linkId]" @blur="touched[linkId] = true" />
              <input v-else-if="FIELD_BY_ID[linkId].kind === 'date'" type="date" class="cf-input" v-model="form[linkId]" />
              <select v-else-if="FIELD_BY_ID[linkId].kind === 'choice'" class="cf-input" v-model="form[linkId]">
                <option value="">Select…</option>
                <option v-for="c in FIELD_BY_ID[linkId].choices" :key="c" :value="c">{{ c }}</option>
              </select>
              <label v-else class="flex items-center gap-2 text-sm" style="color:var(--cf-text)">
                <input type="checkbox" v-model="form[linkId]" />{{ FIELD_BY_ID[linkId].label }}
              </label>
              <p v-show="errorFor(linkId)" class="text-red-500 text-xs font-medium mt-1">{{ errorFor(linkId) }}</p>
            </div>
          </div>
        </template>
      </AdaptiveSectionNav>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
