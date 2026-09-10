<script setup>
// SPEC-24 §7 step 7 (Tier B) — a hand-authored CustomFormHost replacement for Onboarding.vue's
// Services card (system-provider-composition-v1.yaml's `section_services_matrix` group). No
// StructureDefinition/conformance work here — Services has none in SPEC-24's scope — this is a
// pure rendering swap, same drop-in extract() contract every other Host component in this pass
// uses. No AdaptiveSectionNav: only 4 fields, one flat panel, no sections worth switching between
// (unlike Patient/Provider, which genuinely have several).
import { computed, reactive, shallowRef, watch } from 'vue';
import { getAnswer, getGroupInstances } from '../../data/useSystemForms.js';

const props = defineProps({
  record: { type: Object, default: null }, // { data: { item: [{linkId:'section_services_matrix', item:[...]}, ...] } } | null
});

const GROUP_LINK_ID = 'section_services_matrix';

const SPECIALTY_CHOICES = ['Cardiology', 'Pediatrics', 'Ophthalmology', 'Optometry', 'Diet & Wellness', 'General Medicine'];

const FIELDS = [
  { linkId: 'service_name', label: 'Service Name', kind: 'text', required: true },
  { linkId: 'service_specialty_category', label: 'Core Specialty Category', kind: 'choice', choices: SPECIALTY_CHOICES, required: true },
  { linkId: 'service_program_name', label: 'Target Clinical Program Name', kind: 'text' },
  { linkId: 'service_description', label: 'Description', kind: 'text' },
];
const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.linkId, f]));

function blankForm() { return reactive(Object.fromEntries(FIELDS.map((f) => [f.linkId, '']))); }
const form = blankForm();
function resetForm() { Object.assign(form, Object.fromEntries(FIELDS.map((f) => [f.linkId, '']))); }

// shallowRef — same real bug ProviderBasicsHost.vue's own header documents (ref() deep-wraps
// array elements in reactive Proxies, which structuredClone() inside the merge helpers cannot
// clone, silently aborting the save).
const instances = shallowRef([]);
function rebuild() {
  instances.value = props.record ? getGroupInstances(props.record, GROUP_LINK_ID) : [];
  resetForm();
}
watch(() => props.record, rebuild, { immediate: true });

const rows = computed(() => instances.value.map((instance, i) => {
  const rec = { data: instance };
  return { index: i, name: getAnswer(rec, 'service_name') || '(unnamed)', category: getAnswer(rec, 'service_specialty_category') };
}));

function removeInstance(index) {
  instances.value = instances.value.filter((_, i) => i !== index);
}

function isBlank(v) { return v === '' || v === null || v === undefined; }
function buildAnswerItems() {
  return FIELDS
    .filter((f) => !isBlank(form[f.linkId]))
    .map((f) => ({ linkId: f.linkId, answer: [{ valueString: form[f.linkId] }] }));
}

function addInstance() {
  if (!form.service_name) return; // the one required-at-UI field, matching every other Host's own single-required-field precedent
  instances.value = [...instances.value, { linkId: GROUP_LINK_ID, item: buildAnswerItems() }];
  resetForm();
}

// A currently-typed-but-not-yet-committed entry isn't silently lost on save — same convenience
// ProviderBasicsHost.vue/AffiliateOrganizationHost.vue's own header comments establish.
function commitPendingEntry() {
  if (form.service_name) addInstance();
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
          <span v-if="row.category" class="text-xs ml-2" style="color:var(--cf-text)">{{ row.category }}</span>
        </div>
        <button class="btn-ghost text-xs px-2 py-1" @click="removeInstance(row.index)"><i class="fas fa-times"></i> Remove</button>
      </div>
    </div>
    <p v-else class="text-xs text-center py-2" style="color:var(--cf-text)">No services added yet.</p>

    <div class="cf-card rounded-2xl p-4">
      <p class="cf-label mb-2">Add a Service</p>
      <div class="cf-form-field-grid">
        <div v-for="f in FIELDS" :key="f.linkId">
          <label class="cf-label">{{ f.label }}<span v-if="f.required" style="color:#dc2626"> *</span></label>
          <input v-if="f.kind === 'text'" class="cf-input" v-model="form[f.linkId]" />
          <select v-else class="cf-input" v-model="form[f.linkId]">
            <option value="">Select…</option>
            <option v-for="c in f.choices" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>
      <button class="btn-outline text-sm mt-3" :disabled="!form.service_name" @click="addInstance()">
        <i class="fas fa-plus"></i> Add This Service
      </button>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
