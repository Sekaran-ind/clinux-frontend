<script setup>
// SPEC-24 §7 step 6 (Affiliate Organization) — the third hand-authored CustomFormHost replacement,
// simpler than ProviderBasicsHost.vue's own two-resource lockstep pairing: ONE resourceType
// (OrganizationAffiliation, system-provider-composition-v1.yaml's own `section_affiliate_
// organization` group), repeating, same record-card-list + one add-form shape FacilityBasicsHost/
// ProviderBasicsHost already established.
//
// Genuinely new capture surface (see that YAML group's own header comment for the real modeling
// reasoning) — an organization-to-organization relationship (a partner imaging centre/lab/billing
// service), distinct from the Affiliates tab's own practitioner-level linking in
// TeamSettingsModal.vue (a different FHIR resource entirely, see clinux-spec24-... memory note).
// `.organization` (this facility) is auto-linked by local-extractor.js, never a field here.
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { getAnswer, getGroupInstances } from '../../data/useSystemForms.js';
import AdaptiveSectionNav from '../AdaptiveSectionNav.vue';

const props = defineProps({
  record: { type: Object, default: null }, // { data: { item: [{linkId:'section_affiliate_organization', item:[...]}, ...] } } | null
});

const GROUP_LINK_ID = 'section_affiliate_organization';

const RELATIONSHIP_CHOICES = ['Provider', 'Diagnostics', 'Billing', 'Shared Imaging Service', 'Laboratory', 'Pharmacy'];
const SPECIALTY_CHOICES = ['Cardiology', 'Neurology', 'Radiology', 'Pediatrics', 'Orthopedics', 'Dermatology', 'General Medicine', 'ENT', 'Ophthalmology', 'Psychiatry'];

const FIELDS = [
  { linkId: 'affiliate_org_name', label: 'Partner Organization Name', kind: 'text', required: true },
  { linkId: 'affiliate_org_active', label: 'Active', kind: 'boolean' },
  { linkId: 'affiliate_org_relationship', label: 'Relationship', kind: 'multichoice', choices: RELATIONSHIP_CHOICES, required: true },
  { linkId: 'affiliate_org_specialty', label: 'Specialty (if clinical)', kind: 'multichoice', choices: SPECIALTY_CHOICES },
  { linkId: 'affiliate_org_phone', label: 'Phone', kind: 'text' },
  { linkId: 'affiliate_org_email', label: 'Email', kind: 'text' },
];
const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.linkId, f]));

const SECTIONS = [
  { id: 'organization', label: 'Organization', icon: 'fa-building', fields: ['affiliate_org_name', 'affiliate_org_active'] },
  { id: 'relationship', label: 'Relationship', icon: 'fa-handshake', fields: ['affiliate_org_relationship', 'affiliate_org_specialty'] },
  { id: 'contact', label: 'Contact', icon: 'fa-phone', fields: ['affiliate_org_phone', 'affiliate_org_email'] },
];
const activeSectionId = ref(SECTIONS[0].id);

function blankForm() {
  return reactive(Object.fromEntries(FIELDS.map((f) => [f.linkId, f.kind === 'multichoice' ? [] : (f.kind === 'boolean' ? false : '')])));
}
const form = blankForm();
function resetForm() { Object.assign(form, Object.fromEntries(FIELDS.map((f) => [f.linkId, f.kind === 'multichoice' ? [] : (f.kind === 'boolean' ? false : '')]))); }

// shallowRef, not ref — same real bug ProviderBasicsHost.vue's own header documents (ref() deep-
// wraps array elements in reactive Proxies, which structuredClone() inside the merge helpers
// cannot clone, silently aborting the save).
const instances = shallowRef([]);
function rebuild() {
  instances.value = props.record ? getGroupInstances(props.record, GROUP_LINK_ID) : [];
  resetForm();
}
watch(() => props.record, rebuild, { immediate: true });

const rows = computed(() => instances.value.map((instance, i) => {
  const rec = { data: instance };
  return { index: i, name: getAnswer(rec, 'affiliate_org_name') || '(unnamed)', relationship: getAnswer(rec, 'affiliate_org_relationship') };
}));

function removeInstance(index) {
  instances.value = instances.value.filter((_, i) => i !== index);
}

function fhirValueKey(field) {
  if (field.kind === 'boolean') return 'valueBoolean';
  return 'valueString';
}
function isBlank(v) { return v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0); }
function buildAnswerItems() {
  return FIELDS
    .filter((f) => !isBlank(form[f.linkId]) && form[f.linkId] !== false)
    .map((f) => {
      const key = fhirValueKey(f);
      const answer = f.kind === 'multichoice' ? form[f.linkId].map((v) => ({ [key]: v })) : [{ [key]: form[f.linkId] }];
      return { linkId: f.linkId, answer };
    });
}

function addInstance() {
  if (!form.affiliate_org_name) return; // the one required-at-UI field, matching Facility/Provider's own single-required-field precedent
  instances.value = [...instances.value, { linkId: GROUP_LINK_ID, item: buildAnswerItems() }];
  resetForm();
}

// Same "a currently-typed-but-not-yet-committed entry isn't silently lost on save" convenience
// ProviderBasicsHost.vue's own header comment establishes.
function commitPendingEntry() {
  if (form.affiliate_org_name) addInstance();
}

function extract() {
  commitPendingEntry();
  return { resourceType: 'QuestionnaireResponse', status: 'completed', item: [...instances.value] };
}
defineExpose({ extract });
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="rows.length" class="flex flex-col gap-2">
      <div v-for="row in rows" :key="row.index" class="record-card flex items-center justify-between p-2.5">
        <div>
          <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ row.name }}</span>
          <span v-if="row.relationship" class="text-xs ml-2" style="color:var(--cf-text)">{{ row.relationship }}</span>
        </div>
        <button class="btn-ghost text-xs px-2 py-1" @click="removeInstance(row.index)"><i class="fas fa-times"></i> Remove</button>
      </div>
    </div>
    <p v-else class="text-xs text-center py-2" style="color:var(--cf-text)">No affiliate organizations added yet.</p>

    <div class="cf-card rounded-2xl p-4">
      <p class="cf-label mb-2">Add an Affiliate Organization</p>
      <AdaptiveSectionNav :sections="SECTIONS" mode="tabs" storage-key="affiliate-organization-basics" v-model:active-id="activeSectionId">
        <template v-for="section in SECTIONS" :key="section.id" #[section.id]>
          <div class="cf-form-field-grid">
            <div v-for="linkId in section.fields" :key="linkId">
              <label v-if="FIELD_BY_ID[linkId].kind !== 'boolean'" class="cf-label">
                {{ FIELD_BY_ID[linkId].label }}<span v-if="FIELD_BY_ID[linkId].required" style="color:#dc2626"> *</span>
              </label>
              <input v-if="FIELD_BY_ID[linkId].kind === 'text'" class="cf-input" v-model="form[linkId]" />
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
      <button class="btn-outline text-sm mt-3" :disabled="!form.affiliate_org_name" @click="addInstance()">
        <i class="fas fa-plus"></i> Add This Affiliate Organization
      </button>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
