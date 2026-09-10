<script setup>
// SPEC-24 §7 step 7 (Tier B) — a hand-authored CustomFormHost replacement for Onboarding.vue's
// Legal Consents card (system-provider-composition-v1.yaml's `section_consent` group). Same shape
// as ServicesHost.vue/HoursHost.vue's own header — no conformance work, no AdaptiveSectionNav.
import { computed, reactive, shallowRef, watch } from 'vue';
import { getAnswer, getGroupInstances } from '../../data/useSystemForms.js';

const props = defineProps({
  record: { type: Object, default: null }, // { data: { item: [{linkId:'section_consent', item:[...]}, ...] } } | null
});

const GROUP_LINK_ID = 'section_consent';

const CATEGORY_CHOICES = ['HIPAA Privacy Notice', 'Informed Consent for Treatment', 'Financial Responsibility', 'Telemedicine Consent', 'Photography / Research', 'Minor Treatment Consent'];
const STATUS_CHOICES = ['draft', 'active', 'inactive', 'entered-in-error', 'rejected'];

const FIELDS = [
  { linkId: 'consent_title', label: 'Title', kind: 'text' },
  { linkId: 'consent_category', label: 'Consent Type', kind: 'choice', choices: CATEGORY_CHOICES, required: true },
  { linkId: 'consent_status', label: 'Status', kind: 'choice', choices: STATUS_CHOICES },
  { linkId: 'consent_datetime', label: 'Date Signed', kind: 'date' },
  { linkId: 'consent_expiry', label: 'Expiry Date', kind: 'date' },
];
const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.linkId, f]));

function blankForm() { return reactive(Object.fromEntries(FIELDS.map((f) => [f.linkId, '']))); }
const form = blankForm();
function resetForm() { Object.assign(form, Object.fromEntries(FIELDS.map((f) => [f.linkId, '']))); }

// shallowRef — same real bug ProviderBasicsHost.vue's own header documents.
const instances = shallowRef([]);
function rebuild() {
  instances.value = props.record ? getGroupInstances(props.record, GROUP_LINK_ID) : [];
  resetForm();
}
watch(() => props.record, rebuild, { immediate: true });

const rows = computed(() => instances.value.map((instance, i) => {
  const rec = { data: instance };
  const category = getAnswer(rec, 'consent_category');
  const title = getAnswer(rec, 'consent_title');
  return { index: i, name: category || title || '(unnamed)', title: category ? title : '' };
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
  if (!form.consent_category) return; // the one required-at-UI field, matching every other Host's own single-required-field precedent
  instances.value = [...instances.value, { linkId: GROUP_LINK_ID, item: buildAnswerItems() }];
  resetForm();
}

function commitPendingEntry() {
  if (form.consent_category) addInstance();
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
          <span v-if="row.title" class="text-xs ml-2" style="color:var(--cf-text)">{{ row.title }}</span>
        </div>
        <button class="btn-ghost text-xs px-2 py-1" @click="removeInstance(row.index)"><i class="fas fa-times"></i> Remove</button>
      </div>
    </div>
    <p v-else class="text-xs text-center py-2" style="color:var(--cf-text)">No consents added yet.</p>

    <div class="cf-card rounded-2xl p-4">
      <p class="cf-label mb-2">Add a Consent Type</p>
      <div class="cf-form-field-grid">
        <div v-for="f in FIELDS" :key="f.linkId">
          <label class="cf-label">{{ f.label }}<span v-if="f.required" style="color:#dc2626"> *</span></label>
          <input v-if="f.kind === 'text'" class="cf-input" v-model="form[f.linkId]" />
          <input v-else-if="f.kind === 'date'" type="date" class="cf-input" v-model="form[f.linkId]" />
          <select v-else class="cf-input" v-model="form[f.linkId]">
            <option value="">Select…</option>
            <option v-for="c in f.choices" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>
      <button class="btn-outline text-sm mt-3" :disabled="!form.consent_category" @click="addInstance()">
        <i class="fas fa-plus"></i> Add This Consent
      </button>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
