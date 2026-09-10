<script setup>
// SPEC-24 §7 step 7 (Tier B) — a hand-authored CustomFormHost replacement for Onboarding.vue's
// Office Hours card (system-provider-composition-v1.yaml's `section_hours` group). Same shape as
// ServicesHost.vue's own header — no conformance work, no AdaptiveSectionNav (4 fields, one panel).
import { computed, reactive, shallowRef, watch } from 'vue';
import { getAnswer, getGroupInstances } from '../../data/useSystemForms.js';

const props = defineProps({
  record: { type: Object, default: null }, // { data: { item: [{linkId:'section_hours', item:[...]}, ...] } } | null
});

const GROUP_LINK_ID = 'section_hours';

const DAY_CHOICES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const FIELDS = [
  { linkId: 'hours_days', label: 'Days of Week', kind: 'multichoice', choices: DAY_CHOICES },
  { linkId: 'hours_open', label: 'Opening Time', kind: 'text' },
  { linkId: 'hours_close', label: 'Closing Time', kind: 'text' },
  { linkId: 'hours_allday', label: 'Open All Day', kind: 'boolean' },
];
const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.linkId, f]));

function blankValues() { return Object.fromEntries(FIELDS.map((f) => [f.linkId, f.kind === 'multichoice' ? [] : (f.kind === 'boolean' ? false : '')])); }
const form = reactive(blankValues());
function resetForm() { Object.assign(form, blankValues()); }

// shallowRef — same real bug ProviderBasicsHost.vue's own header documents.
const instances = shallowRef([]);
function rebuild() {
  instances.value = props.record ? getGroupInstances(props.record, GROUP_LINK_ID) : [];
  resetForm();
}
watch(() => props.record, rebuild, { immediate: true });

const rows = computed(() => instances.value.map((instance, i) => {
  const rec = { data: instance };
  const days = getAnswer(rec, 'hours_days');
  const open = getAnswer(rec, 'hours_open');
  const close = getAnswer(rec, 'hours_close');
  return { index: i, summary: [days, open && close ? `${open}–${close}` : ''].filter(Boolean).join(' · ') || '(entry)' };
}));

function removeInstance(index) {
  instances.value = instances.value.filter((_, i) => i !== index);
}

function fhirValueKey(field) { return field.kind === 'boolean' ? 'valueBoolean' : 'valueString'; }
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

function hasContent() { return !isBlank(form.hours_days) || !isBlank(form.hours_open) || !isBlank(form.hours_close) || form.hours_allday; }

function addInstance() {
  if (!hasContent()) return;
  instances.value = [...instances.value, { linkId: GROUP_LINK_ID, item: buildAnswerItems() }];
  resetForm();
}

function commitPendingEntry() {
  if (hasContent()) addInstance();
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
        <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ row.summary }}</span>
        <button class="btn-ghost text-xs px-2 py-1" @click="removeInstance(row.index)"><i class="fas fa-times"></i> Remove</button>
      </div>
    </div>
    <p v-else class="text-xs text-center py-2" style="color:var(--cf-text)">No hours added yet.</p>

    <div class="cf-card rounded-2xl p-4">
      <p class="cf-label mb-2">Add an Hours Entry</p>
      <div class="cf-form-field-grid">
        <div>
          <label class="cf-label">{{ FIELD_BY_ID.hours_days.label }}</label>
          <select class="cf-input" multiple v-model="form.hours_days">
            <option v-for="c in FIELD_BY_ID.hours_days.choices" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div>
          <label class="cf-label">{{ FIELD_BY_ID.hours_open.label }}</label>
          <input class="cf-input" v-model="form.hours_open" placeholder="09:00" />
        </div>
        <div>
          <label class="cf-label">{{ FIELD_BY_ID.hours_close.label }}</label>
          <input class="cf-input" v-model="form.hours_close" placeholder="18:00" />
        </div>
        <div>
          <label class="flex items-center gap-2 text-sm" style="color:var(--cf-text)">
            <input type="checkbox" v-model="form.hours_allday" />{{ FIELD_BY_ID.hours_allday.label }}
          </label>
        </div>
      </div>
      <button class="btn-outline text-sm mt-3" :disabled="!hasContent()" @click="addInstance()">
        <i class="fas fa-plus"></i> Add This Hours Entry
      </button>
    </div>
  </div>
</template>

<style scoped>
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
</style>
