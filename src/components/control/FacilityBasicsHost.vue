<script setup>
// SPEC-24 §1/§6/§7 step 5 — the first real "CustomFormHost is a duplicate of lhcforms" fix in
// place: a HAND-AUTHORED replacement for CustomFormHost, scoped to exactly the one group it
// replaces here (system-provider-composition-v1.yaml's `section_hospital` — the Hospital/Practice
// Profile card). Same drop-in extract() contract CustomFormHost.vue already established (a real
// QuestionnaireResponse, {resourceType, status, item:[{linkId:'section_hospital', item:[...]}]})
// so mergeGroupResponseItem/local-extractor.js/composition-assembler.js all keep working
// completely unchanged (§6) — only the rendering swaps out, from schema-iterating generic fields
// to real, named inputs grouped into panels via AdaptiveSectionNav, the same "hand-authored
// panels, like TeamSettingsModal.vue already does" style the spec asks for.
//
// This was a staged migration — every other onboarding card followed the same pattern in later
// passes (ProviderBasicsHost/ServicesHost/HoursHost/ConsentsHost/AffiliateOrganizationHost), and
// CustomFormHost.vue/FormField.vue were deleted once nothing referenced them anymore (spec §7
// step 7 / Tier B).
import { reactive, ref, watch } from 'vue';
import { getAnswer } from '../../data/useSystemForms.js';
import AdaptiveSectionNav from '../AdaptiveSectionNav.vue';

const props = defineProps({
  record: { type: Object, default: null }, // { data: { item: [{linkId:'section_hospital', item:[...]}] } } | null
});

const GROUP_LINK_ID = 'section_hospital';

// One entry per real field this group has always captured (system-provider-composition-v1.yaml's
// own `section_hospital` block) — label/required/FHIR value type hand-declared here instead of
// read off a compiled schema, which is the actual point (SPEC-24 §1).
const FIELDS = [
  { linkId: 'hospital_name', label: 'Hospital Name', required: true },
  { linkId: 'hospital_legalname', label: 'Legal / Trade Name' },
  { linkId: 'hospital_type', label: 'Facility Type' },
  { linkId: 'hospital_npi', label: 'NPI / Registration No.' },
  { linkId: 'hospital_address', label: 'Street Address' },
  { linkId: 'hospital_city', label: 'City' },
  { linkId: 'hospital_state', label: 'State' },
  { linkId: 'hospital_pin', label: 'PIN Code' },
  { linkId: 'hospital_country', label: 'Country' },
  { linkId: 'hospital_phone', label: 'Primary Phone' },
  { linkId: 'hospital_whatsapp', label: 'WhatsApp Number' },
  { linkId: 'hospital_email', label: 'Email Address' },
  { linkId: 'hospital_website', label: 'Website URL' },
  // Real gap found live (Hospital/Provider/Affiliate journey audit): Organization.active
  // (min:1, Required per ClinuxFlowFacility.json) had NO capture field anywhere after the old
  // LForms-rendered page was retired — silently unfillable. kind:'boolean' is the one exception
  // to this component's otherwise-uniform text-input fields (see extract()'s own handling below),
  // same minimal-targeted-addition reasoning as touching one field rather than porting
  // ProviderBasicsHost.vue's fuller kind-system here for a component that's otherwise all-text.
  { linkId: 'hospital_operational_status', label: 'Currently Operational', kind: 'boolean' },
];
const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.linkId, f]));

const SECTIONS = [
  { id: 'basics', label: 'Basics', icon: 'fa-hospital', fields: ['hospital_name', 'hospital_legalname', 'hospital_type', 'hospital_npi', 'hospital_operational_status'] },
  { id: 'address', label: 'Address', icon: 'fa-location-dot', fields: ['hospital_address', 'hospital_city', 'hospital_state', 'hospital_pin', 'hospital_country'] },
  { id: 'contact', label: 'Contact', icon: 'fa-phone', fields: ['hospital_phone', 'hospital_whatsapp', 'hospital_email', 'hospital_website'] },
];
const activeSectionId = ref(SECTIONS[0].id);

const form = reactive(Object.fromEntries(FIELDS.map((f) => [f.linkId, ''])));
const touched = reactive({});

function rebuild() {
  FIELDS.forEach((f) => {
    const raw = props.record ? getAnswer(props.record, f.linkId) : undefined;
    form[f.linkId] = f.kind === 'boolean' ? raw === true : (raw ?? '');
  });
  Object.keys(touched).forEach((k) => delete touched[k]);
}
watch(() => props.record, rebuild, { immediate: true });

function errorFor(linkId) {
  const field = FIELD_BY_ID[linkId];
  if (!field?.required || !touched[linkId]) return '';
  return form[linkId] ? '' : `${field.label} is required.`;
}

function hasMissingRequired() {
  return FIELDS.some((f) => f.required && !form[f.linkId]);
}

function extract() {
  if (hasMissingRequired()) {
    FIELDS.forEach((f) => { touched[f.linkId] = true; });
    return null; // same failure contract CustomFormHost/extractResponse() already use
  }
  const item = FIELDS
    .filter((f) => f.kind === 'boolean' || (form[f.linkId] !== '' && form[f.linkId] !== null && form[f.linkId] !== undefined))
    .map((f) => ({ linkId: f.linkId, answer: [f.kind === 'boolean' ? { valueBoolean: !!form[f.linkId] } : { valueString: form[f.linkId] }] }));
  return { resourceType: 'QuestionnaireResponse', status: 'completed', item: [{ linkId: GROUP_LINK_ID, item }] };
}

defineExpose({ extract });
</script>

<template>
  <div class="cf-card rounded-2xl p-4">
    <AdaptiveSectionNav :sections="SECTIONS" mode="tabs" storage-key="facility-basics" v-model:active-id="activeSectionId">
      <template v-for="section in SECTIONS" :key="section.id" #[section.id]>
        <div class="cf-form-field-grid">
          <div v-for="linkId in section.fields" :key="linkId">
            <label v-if="FIELD_BY_ID[linkId].kind === 'boolean'" class="cf-label flex items-center gap-2">
              <input type="checkbox" v-model="form[linkId]" />
              {{ FIELD_BY_ID[linkId].label }}
            </label>
            <template v-else>
              <label class="cf-label">{{ FIELD_BY_ID[linkId].label }}<span v-if="FIELD_BY_ID[linkId].required" style="color:#dc2626"> *</span></label>
              <input
                class="cf-input"
                v-model="form[linkId]"
                @blur="touched[linkId] = true"
              />
              <p v-show="errorFor(linkId)" class="text-red-500 text-xs font-medium mt-1">{{ errorFor(linkId) }}</p>
            </template>
          </div>
        </div>
      </template>
    </AdaptiveSectionNav>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
