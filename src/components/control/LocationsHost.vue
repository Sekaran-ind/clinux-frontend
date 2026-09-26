<script setup>
// A real gap found while proceeding through the remaining ClinicHome sections: service_location_id
// (ServicesHost.vue) and staff_location_ids (ProviderBasicsHost.vue) both reference
// section_location instances, but nothing in this app ever CREATED one — no Host component, no
// Onboarding.vue card. Without this, both those branch dropdowns are permanently empty. Same
// hand-authored Host pattern as ServicesHost.vue (its own closest sibling — a flat, few-field,
// single-panel repeating group, no AdaptiveSectionNav needed), same drop-in extract() contract
// every Host component in this app already uses.
import { computed, reactive, shallowRef, watch } from 'vue';
import { getAnswer, getGroupInstances } from '../../data/useSystemForms.js';

const props = defineProps({
  record: { type: Object, default: null },
});

const GROUP_LINK_ID = 'section_location';

const FIELDS = [
  { linkId: 'location_name', label: 'Branch Name', required: true },
  { linkId: 'location_address', label: 'Address' },
  { linkId: 'location_phone', label: 'Phone' },
];

function blankForm() { return reactive(Object.fromEntries(FIELDS.map((f) => [f.linkId, '']))); }
const form = blankForm();
function resetForm() { Object.assign(form, Object.fromEntries(FIELDS.map((f) => [f.linkId, '']))); }

// shallowRef — same real bug ProviderBasicsHost.vue/ServicesHost.vue's own header comments
// document (ref() deep-wraps array elements in reactive Proxies structuredClone() can't clone).
const instances = shallowRef([]);
function rebuild() {
  instances.value = props.record ? getGroupInstances(props.record, GROUP_LINK_ID) : [];
  resetForm();
}
watch(() => props.record, rebuild, { immediate: true });

const rows = computed(() => instances.value.map((instance, i) => {
  const rec = { data: instance };
  return { index: i, name: getAnswer(rec, 'location_name') || '(unnamed branch)', address: getAnswer(rec, 'location_address') };
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
  if (!form.location_name) return;
  instances.value = [...instances.value, { linkId: GROUP_LINK_ID, item: buildAnswerItems() }];
  resetForm();
}

function commitPendingEntry() {
  if (form.location_name) addInstance();
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
          <span v-if="row.address" class="text-xs ml-2" style="color:var(--cf-text)">{{ row.address }}</span>
        </div>
        <button class="btn-ghost text-xs px-2 py-1" @click="removeInstance(row.index)"><i class="fas fa-times"></i> Remove</button>
      </div>
    </div>
    <p v-else class="text-xs text-center py-2" style="color:var(--cf-text)">No branches added yet.</p>

    <div class="cf-card rounded-2xl p-4">
      <p class="cf-label mb-2">Add a Branch</p>
      <div class="cf-form-field-grid">
        <div v-for="f in FIELDS" :key="f.linkId">
          <label class="cf-label">{{ f.label }}<span v-if="f.required" style="color:#dc2626"> *</span></label>
          <input class="cf-input" v-model="form[f.linkId]" />
        </div>
      </div>
      <button class="btn-outline text-sm mt-3" :disabled="!form.location_name" @click="addInstance()">
        <i class="fas fa-plus"></i> Add This Branch
      </button>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
