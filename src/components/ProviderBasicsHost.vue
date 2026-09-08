<script setup>
// SPEC-24 §2/§6/§7 step 6 — the Provider counterpart to FacilityBasicsHost.vue: a hand-authored
// CustomFormHost replacement for Onboarding.vue's Care Team card (system-provider-composition-v1
// .yaml's `section_staff` group), extended for the real thing SPEC-24 §2's own modeling upgrade
// adds — a Practitioner (the person) genuinely split from PractitionerRole (their role at THIS
// facility), captured as two sibling top-level groups (`section_staff` + `section_staff_role`,
// see that YAML's own comment on why they're siblings, not nested) that must always be saved in
// lockstep, one pair per real staff member — local-extractor.js correlates them by matching
// repetition order, not by any explicit key, so THIS component (not LForms' independent per-group
// "+ Add Another") is what guarantees the pairing by only ever adding/removing one whole pair at
// once.
//
// Repeating, unlike FacilityBasicsHost's single Facility: renders the already-added staff as
// simple summary rows (TeamSettingsModal.vue's own record-card style) plus one "Add a Staff
// Member" form, sectioned via AdaptiveSectionNav (Person / ABDM Registration / Role) — one nav
// instance for the ADD FORM, not one per existing row (a repeating AdaptiveSectionNav-per-row
// would fight its own per-instance localStorage mode key; out of scope here).
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { getAnswer, getAnswers, getGroupInstances } from '../data/useSystemForms.js';
import AdaptiveSectionNav from './AdaptiveSectionNav.vue';

const props = defineProps({
  record: { type: Object, default: null }, // the FULL Provider record (not sliced — spans 2 groups)
});

const STAFF_LINK_ID = 'section_staff';
const ROLE_LINK_ID = 'section_staff_role';

const CLINICAL_ROLE_CHOICES = ['Chief of Medicine', 'Doctor', 'Nurse', 'Administrator', 'Receptionist', 'Radiologist'];
const SPECIALTY_CHOICES = ['Cardiology', 'Neurology', 'Radiology', 'Pediatrics', 'Orthopedics', 'Dermatology', 'General Medicine', 'ENT', 'Ophthalmology', 'Psychiatry'];
const HPR_ROLE_CHOICES = ['Healthcare Professional', 'Facility Manager', 'Healthcare Professional and Facility Manager'];

// Practitioner-side fields (linkId -> { label, kind }); 'kind' picks the input control and the
// real FHIR answer type (fhirValueKey below) — mirrors CustomFormHost's own real value[x] mapping.
const PRACTITIONER_FIELDS = [
  { linkId: 'staff_first_name', label: 'First Name (as on Aadhaar)', kind: 'text' },
  { linkId: 'staff_last_name', label: 'Last Name (as on Aadhaar)', kind: 'text' },
  { linkId: 'staff_phone', label: 'Phone', kind: 'text' },
  { linkId: 'staff_email', label: 'Email', kind: 'text' },
  { linkId: 'staff_qualification', label: 'Qualification', kind: 'text' },
  { linkId: 'staff_license', label: 'License / Registration ID', kind: 'text' },
  { linkId: 'staff_status', label: 'Active', kind: 'boolean' },
  { linkId: 'staff_hprid', label: 'HPR ID (assigned after creation)', kind: 'text' },
  { linkId: 'staff_hpr_id_number', label: 'HPR ID Number (assigned after creation)', kind: 'text' },
  { linkId: 'staff_hp_category_code', label: 'HP Category Code (HPR master: system-of-medicine)', kind: 'text' },
  { linkId: 'staff_hp_subcategory_code', label: 'HP Sub-Category Code', kind: 'text' },
  { linkId: 'staff_state_code', label: 'State LGD Code (HPR master: states)', kind: 'text' },
  { linkId: 'staff_district_code', label: 'District LGD Code (HPR master: districts)', kind: 'text' },
  { linkId: 'staff_council', label: 'Registered with a Medical/Nursing Council', kind: 'boolean' },
  { linkId: 'staff_role', label: 'Clinical Role', kind: 'choice', choices: CLINICAL_ROLE_CHOICES },
  { linkId: 'staff_specialty', label: 'Specialty', kind: 'multichoice', choices: SPECIALTY_CHOICES },
];
// Role-side fields (PractitionerRole — a separate FHIR resource, see the header comment).
const ROLE_FIELDS = [
  { linkId: 'staff_role_active', label: 'Currently Active in this Role', kind: 'boolean' },
  { linkId: 'staff_provider_role', label: 'HPR Role (HPR master: role)', kind: 'choice', choices: HPR_ROLE_CHOICES },
];
const ALL_FIELDS = [...PRACTITIONER_FIELDS, ...ROLE_FIELDS];
const FIELD_BY_ID = Object.fromEntries(ALL_FIELDS.map((f) => [f.linkId, f]));

const SECTIONS = [
  { id: 'person', label: 'Person', icon: 'fa-user', fields: ['staff_first_name', 'staff_last_name', 'staff_phone', 'staff_email', 'staff_qualification', 'staff_license', 'staff_status'] },
  { id: 'abdm', label: 'ABDM Registration', icon: 'fa-id-card', fields: ['staff_hprid', 'staff_hpr_id_number', 'staff_hp_category_code', 'staff_hp_subcategory_code', 'staff_state_code', 'staff_district_code', 'staff_council'] },
  { id: 'role', label: 'Role', icon: 'fa-user-doctor', fields: ['staff_role', 'staff_specialty', 'staff_role_active', 'staff_provider_role'] },
];
const activeSectionId = ref(SECTIONS[0].id);

function blankForm() {
  const f = reactive(Object.fromEntries(ALL_FIELDS.map((field) => [field.linkId, field.kind === 'multichoice' ? [] : (field.kind === 'boolean' ? false : '')])));
  return f;
}
const form = blankForm();
function resetForm() { Object.assign(form, Object.fromEntries(ALL_FIELDS.map((f) => [f.linkId, f.kind === 'multichoice' ? [] : (f.kind === 'boolean' ? false : '')]))); }

// Already-added staff — each entry pairs a Practitioner instance with its PractitionerRole
// instance at the SAME array index (see header comment on why lockstep order is what correlates
// them; getGroupInstances returns both groups' raw instances in save order already).
//
// shallowRef, not ref — a real bug found live (Playwright-driven), not hypothetical: ref() deep-
// wraps an assigned array's own elements in reactive Proxies too, and those survive into
// extract()'s returned item array untouched (this component only ever REASSIGNS `.value`, never
// mutates in place, so shallowRef's shallow reactivity is all that's needed). Downstream,
// mergeGroupResponseItems/mergeGroupResponseItem call structuredClone() on the merged record —
// which cannot clone a Proxy at all — and threw, silently aborting the save entirely: the record-
// card list (this component's own local state) kept showing the just-added staff member, making
// it LOOK saved, while the underlying Provider record was never actually persisted.
const staffInstances = shallowRef([]);
const roleInstances = shallowRef([]);
function rebuild() {
  staffInstances.value = props.record ? getGroupInstances(props.record, STAFF_LINK_ID) : [];
  roleInstances.value = props.record ? getGroupInstances(props.record, ROLE_LINK_ID) : [];
  resetForm();
}
watch(() => props.record, rebuild, { immediate: true });

const staffRows = computed(() => staffInstances.value.map((instance, i) => {
  const rec = { data: instance };
  const roleRec = roleInstances.value[i] ? { data: roleInstances.value[i] } : null;
  const name = [getAnswer(rec, 'staff_first_name'), getAnswer(rec, 'staff_last_name')].filter(Boolean).join(' ') || '(unnamed)';
  return { index: i, name, role: roleRec ? getAnswer(roleRec, 'staff_provider_role') : '', clinicalRole: getAnswer(rec, 'staff_role') };
}));

function removeStaff(index) {
  staffInstances.value = staffInstances.value.filter((_, i) => i !== index);
  roleInstances.value = roleInstances.value.filter((_, i) => i !== index);
}

function addStaff() {
  if (!form.staff_first_name) return; // the one required field — mirrors staff_name's own YAML `required: true`
  const practitionerInstance = { linkId: STAFF_LINK_ID, item: buildAnswerItems(PRACTITIONER_FIELDS) };
  const roleInstance = { linkId: ROLE_LINK_ID, item: buildAnswerItems(ROLE_FIELDS) };
  staffInstances.value = [...staffInstances.value, practitionerInstance];
  roleInstances.value = [...roleInstances.value, roleInstance];
  resetForm();
}

// A currently-typed-but-not-yet-"Add This Staff Member"'d entry would otherwise be silently lost
// on Save — CustomFormHost's own repeating-group ergonomics never require a separate per-instance
// commit click (its "+ Add Another" just opens a new blank block; whatever's visible, including
// the one being actively edited, is what extract() reads). Matching that here: a non-blank form
// gets folded in as one more instance automatically at save time, so "Add This Staff Member" is
// an explicit convenience for starting the NEXT entry while keeping this one, never a required
// step for the only entry being added.
function commitPendingEntry() {
  if (form.staff_first_name) addStaff();
}

function fhirValueKey(field) {
  if (field.kind === 'boolean') return 'valueBoolean';
  return 'valueString'; // text / choice / multichoice — matches the compiler's own plain-string answerOption shape
}
function isBlank(v) { return v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0); }
function buildAnswerItems(fields) {
  return fields
    .filter((f) => !isBlank(form[f.linkId]) && form[f.linkId] !== false)
    .map((f) => {
      const key = fhirValueKey(f);
      const answer = f.kind === 'multichoice' ? form[f.linkId].map((v) => ({ [key]: v })) : [{ [key]: form[f.linkId] }];
      return { linkId: f.linkId, answer };
    });
}

// The real drop-in extract() contract (see FacilityBasicsHost.vue's own header) — extended for
// TWO real group linkIds instead of one; Onboarding.vue's saveDrawerRecord() groups response.item
// by its own linkId and merges each group separately, so this needs no special-casing there
// beyond that grouping.
function extract() {
  commitPendingEntry();
  const item = [];
  staffInstances.value.forEach((instance) => item.push(instance));
  roleInstances.value.forEach((instance) => item.push(instance));
  return { resourceType: 'QuestionnaireResponse', status: 'completed', item };
}
defineExpose({ extract });
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="staffRows.length" class="flex flex-col gap-2">
      <div v-for="row in staffRows" :key="row.index" class="record-card flex items-center justify-between p-2.5">
        <div>
          <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ row.name }}</span>
          <span v-if="row.clinicalRole" class="text-xs ml-2" style="color:var(--cf-text)">{{ row.clinicalRole }}</span>
          <div v-if="row.role" class="text-xs" style="color:var(--cf-text)">{{ row.role }}</div>
        </div>
        <button class="btn-ghost text-xs px-2 py-1" @click="removeStaff(row.index)"><i class="fas fa-times"></i> Remove</button>
      </div>
    </div>
    <p v-else class="text-xs text-center py-2" style="color:var(--cf-text)">No staff added yet.</p>

    <div class="cf-card rounded-2xl p-4">
      <p class="cf-label mb-2">Add a Staff Member</p>
      <AdaptiveSectionNav :sections="SECTIONS" mode="tabs" storage-key="provider-basics" v-model:active-id="activeSectionId">
        <template v-for="section in SECTIONS" :key="section.id" #[section.id]>
          <div class="cf-form-field-grid">
            <div v-for="linkId in section.fields" :key="linkId">
              <label v-if="FIELD_BY_ID[linkId].kind !== 'boolean'" class="cf-label">
                {{ FIELD_BY_ID[linkId].label }}<span v-if="linkId === 'staff_first_name'" style="color:#dc2626"> *</span>
              </label>
              <input v-if="FIELD_BY_ID[linkId].kind === 'text'" class="cf-input" v-model="form[linkId]" />
              <select v-else-if="FIELD_BY_ID[linkId].kind === 'choice'" class="cf-input" v-model="form[linkId]">
                <option value="">Select…</option>
                <option v-for="c in FIELD_BY_ID[linkId].choices" :key="c" :value="c">{{ c }}</option>
              </select>
              <select v-else-if="FIELD_BY_ID[linkId].kind === 'multichoice'" class="cf-input" multiple v-model="form[linkId]">
                <option v-for="c in FIELD_BY_ID[linkId].choices" :key="c" :value="c">{{ c }}</option>
              </select>
              <label v-else class="flex items-center gap-2 text-sm" style="color:var(--cf-text)">
                <input type="checkbox" v-model="form[linkId]" />{{ FIELD_BY_ID[linkId].label }}
              </label>
            </div>
          </div>
        </template>
      </AdaptiveSectionNav>
      <button class="btn-outline text-sm mt-3" :disabled="!form.staff_first_name" @click="addStaff()">
        <i class="fas fa-plus"></i> Add This Staff Member
      </button>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
