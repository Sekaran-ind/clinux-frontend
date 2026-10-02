<script setup>
// One generic renderer for a group of the compiled FHIR Questionnaire — the replacement for the
// hand-written Host components. What it shows (fields, types, choices, required, sections,
// widgets, show/hide rules) comes from the Questionnaire (see questionnaireForm.js), so a form
// changes by editing its YAML in clinuxflow-api. Same drop-in contract the Hosts had:
//   props  record — the stored record ({ data: QuestionnaireResponse }) to prefill from
//   expose extract() — a QuestionnaireResponse with this group's item(s), or null if a required
//          field is empty (Onboarding.vue's saveActiveSection() merges it, unchanged)
// A non-repeating group renders as one form, split into AdaptiveSectionNav sections when the
// group declares them. A repeating group (Hours, Services, ...) renders its saved entries as rows
// plus an "add an entry" form, as HoursHost.vue did.
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import AdaptiveSectionNav from '../components/AdaptiveSectionNav.vue';
import QuestionnaireField from './QuestionnaireField.vue';
import { getGroupInstances } from '../data/useSystemForms.js';
import {
  blankValues, fieldsBySection, fieldsOf, groupItemFromValues, isEnabled, missingRequired, refOptions, sectionsOf, summarise, valuesFromGroupItem,
} from './questionnaireForm.js';

const props = defineProps({
  questionnaire: { type: Object, required: true },
  groupLinkId: { type: String, required: true },
  record: { type: Object, default: null },
});

const group = computed(() => (props.questionnaire?.item || []).find((i) => i.linkId === props.groupLinkId) || { item: [] });
// Reference fields (refTo) get their choices from the referenced group's saved instances.
const fields = computed(() => fieldsOf(group.value).map((f) => (f.refTo
  ? { ...f, options: refOptions(props.questionnaire, (id) => (props.record ? getGroupInstances(props.record, id) : []), f.refTo) }
  : f)));
const sections = computed(() => sectionsOf(group.value));
const bySection = computed(() => fieldsBySection(sections.value, fields.value));
const repeating = computed(() => !!group.value.repeats);

const values = reactive({});
const touched = reactive({});
const instances = shallowRef([]); // repeating groups: saved QuestionnaireResponse group items
const activeSection = ref(null);

function reset(to) {
  for (const k of Object.keys(values)) delete values[k];
  Object.assign(values, to);
  for (const k of Object.keys(touched)) delete touched[k];
}

function rebuild() {
  const saved = props.record ? getGroupInstances(props.record, props.groupLinkId) : [];
  if (repeating.value) {
    instances.value = saved;
    reset(blankValues(fields.value));
  } else {
    reset(valuesFromGroupItem(fields.value, saved[0]));
  }
}
watch(() => [props.record, props.questionnaire, props.groupLinkId], rebuild, { immediate: true });

const missing = computed(() => missingRequired(fields.value, values));
const errorFor = (f) => (touched[f.linkId] && missing.value.includes(f.linkId) ? `${f.label} is required.` : '');
const hasContent = () => fields.value.some((f) => {
  const v = values[f.linkId];
  return !(v === '' || v === false || v === null || v === undefined || (Array.isArray(v) && !v.length));
});

function toggle(f, value) {
  const set = new Set(values[f.linkId]);
  set.has(value) ? set.delete(value) : set.add(value);
  values[f.linkId] = [...set];
  touched[f.linkId] = true;
}

// ── Repeating groups ──
const rows = computed(() => instances.value.map((inst, index) => ({ index, summary: summarise(fields.value, valuesFromGroupItem(fields.value, inst)) })));
function addEntry() {
  if (!hasContent()) return false;
  if (missing.value.length) { missing.value.forEach((id) => (touched[id] = true)); return false; }
  instances.value = [...instances.value, groupItemFromValues(props.groupLinkId, fields.value, values)];
  reset(blankValues(fields.value));
  return true;
}
function removeEntry(index) {
  instances.value = instances.value.filter((_, i) => i !== index);
}

function extract() {
  if (repeating.value) {
    if (hasContent() && !addEntry()) return null; // a half-filled entry with a required field empty
    return { resourceType: 'QuestionnaireResponse', status: 'completed', item: [...instances.value] };
  }
  if (missing.value.length) {
    missing.value.forEach((id) => (touched[id] = true));
    // Jump to the first section with a missing field, so the person sees why nothing saved.
    const first = bySection.value.find((s) => s.fields.some((f) => missing.value.includes(f.linkId)));
    if (first && first.id !== 'all') activeSection.value = first.id;
    return null;
  }
  return { resourceType: 'QuestionnaireResponse', status: 'completed', item: [groupItemFromValues(props.groupLinkId, fields.value, values)] };
}

defineExpose({ extract });
</script>

<template>
  <div class="qf">
    <!-- Repeating group: saved entries, then the form for a new one -->
    <template v-if="repeating">
      <div v-if="rows.length" class="qf-rows">
        <div v-for="row in rows" :key="row.index" class="qf-row">
          <span>{{ row.summary }}</span>
          <button type="button" class="ui-btn" style="padding:.25rem .6rem;font-size:.75rem" @click="removeEntry(row.index)"><i class="fas fa-times"></i> Remove</button>
        </div>
      </div>
      <p v-else class="qf-empty">No entries yet.</p>
      <div class="qf-add">
        <p class="qf-add-title">New entry: {{ group.text }}</p>
        <div class="qf-grid">
          <template v-for="f in fields" :key="f.linkId">
            <div v-if="!f.hidden && isEnabled(f, values)" class="qf-field" :class="{ wide: f.widget === 'textarea' || f.widget === 'multiselect' }">
              <QuestionnaireField :field="f" :values="values" :toggle="toggle" :error="errorFor(f)" />
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- Single group, in sections when it declares them -->
    <AdaptiveSectionNav v-else-if="sections.length" v-model:active-id="activeSection" :sections="bySection.map(({ id, label, icon }) => ({ id, label, icon }))" mode="tabs" :storage-key="`qf-${groupLinkId}`">
      <template v-for="s in bySection" :key="s.id" #[s.id]>
        <div class="qf-grid">
          <template v-for="f in s.fields" :key="f.linkId">
            <div v-if="isEnabled(f, values)" class="qf-field" :class="{ wide: f.widget === 'textarea' || f.widget === 'multiselect' }">
              <QuestionnaireField :field="f" :values="values" :toggle="toggle" :error="errorFor(f)" />
            </div>
          </template>
        </div>
      </template>
    </AdaptiveSectionNav>
    <div v-else class="qf-grid">
      <template v-for="f in bySection[0].fields" :key="f.linkId">
        <div v-if="isEnabled(f, values)" class="qf-field" :class="{ wide: f.widget === 'textarea' || f.widget === 'multiselect' }">
          <QuestionnaireField :field="f" :values="values" :toggle="toggle" :error="errorFor(f)" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.qf { display: flex; flex-direction: column; gap: .75rem; }
.qf-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem 1rem; }
@media (max-width: 640px) { .qf-grid { grid-template-columns: 1fr; } }
.qf-field.wide { grid-column: 1 / -1; }
.qf-rows { display: flex; flex-direction: column; gap: .4rem; }
.qf-row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .55rem .75rem; border: 1px solid var(--cf-border); border-radius: .5rem; font-size: .84rem; font-weight: 600; color: var(--cf-text-strong); background: var(--cf-bg-alt); }
.qf-empty { font-size: .78rem; color: var(--cf-text); text-align: center; margin: .25rem 0; }
.qf-add { border: 1px dashed var(--cf-border); border-radius: .625rem; padding: .875rem; }
.qf-add-title { font-size: .78rem; font-weight: 700; color: var(--cf-text-strong); margin: 0 0 .6rem; }
</style>
