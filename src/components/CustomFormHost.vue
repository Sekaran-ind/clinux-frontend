<script setup>
// Real onboarding-UI rebuild — a custom, app-styled, FHIR-compliant replacement for LhcFormHost
// (LForms' generic auto-rendered widget), built because "the hospital setup has many parts,
// entering in a narrow lhcforms is getting difficult" (explicit instruction). Schema-driven, not a
// second hand-maintained field list: every field's label/type/required/choices comes straight off
// the compiled Questionnaire item CustomFormHost.vue is handed — the same compiler output
// LhcFormHost/local-extractor.js/composition-assembler.js already rely on. Same drop-in contract
// as LhcFormHost: `questionnaire` (one or more compiled groups) + `record` props in, a single
// exposed `extract()` returning a real QuestionnaireResponse ({resourceType, status, item:[...]})
// out — so mergeGroupResponseItem(s)/appendGroupResponseItem/local-extractor.js/composition-
// assembler.js all keep working completely unchanged; only the RENDERING swaps out.
import { reactive, ref, watch } from 'vue';
import { getAnswer, getAnswers, getGroupInstances } from '../data/useSystemForms.js';
import FormField from './FormField.vue';

const props = defineProps({
  questionnaire: { type: Object, default: null }, // { item: [group, group, ...] } — one or more compiled Questionnaire groups
  record: { type: Object, default: null }, // { data: { item: [...] } } | null
});

// groupsState[groupLinkId] = Array<{ [leafLinkId]: value }> — value is a plain JS value (string /
// boolean / number / string[] for a repeating choice), never a FHIR answer shape; extract() below
// is the one place that turns a value into a real {valueX}. touched[`${groupLinkId}:${idx}:
// ${leafLinkId}`] = true once a field has been visited (or a blocked save attempt touched
// everything) — same reveal-errors-only-after-interaction UX AbdmFieldForm.vue's own
// touched/errorFor pattern already proved out, generalized to read field metadata from the real
// schema instead of a hand-authored fields list.
const groupsState = reactive({});
const touched = reactive({});

function blankInstance(group) {
  const inst = {};
  (group.item || []).forEach((leaf) => {
    inst[leaf.linkId] = leaf.type === 'choice' && leaf.repeats ? [] : (leaf.type === 'boolean' ? '' : '');
  });
  return inst;
}

function instanceFromRecord(group, rawInstance) {
  const inst = {};
  (group.item || []).forEach((leaf) => {
    if (leaf.type === 'choice' && leaf.repeats) {
      inst[leaf.linkId] = getAnswers({ data: rawInstance }, leaf.linkId);
    } else {
      inst[leaf.linkId] = getAnswer({ data: rawInstance }, leaf.linkId);
    }
  });
  return inst;
}

function rebuild() {
  const groups = props.questionnaire?.item || [];
  // Clear every group this render is responsible for (not the whole reactive object — leaves
  // nothing stale if a future caller ever swapped in a differently-shaped questionnaire prop).
  groups.forEach((group) => {
    const rawInstances = props.record ? getGroupInstances(props.record, group.linkId) : [];
    if (rawInstances.length > 0) {
      groupsState[group.linkId] = rawInstances.map((raw) => instanceFromRecord(group, raw));
    } else {
      groupsState[group.linkId] = [blankInstance(group)];
    }
  });
  Object.keys(touched).forEach((k) => delete touched[k]);
}
watch(() => [props.questionnaire, props.record], rebuild, { immediate: true });

function addInstance(group) {
  groupsState[group.linkId].push(blankInstance(group));
}
function removeInstance(group, idx) {
  groupsState[group.linkId].splice(idx, 1);
}

function touchKey(groupLinkId, idx, leafLinkId) { return `${groupLinkId}:${idx}:${leafLinkId}`; }
function markTouched(groupLinkId, idx, leafLinkId) { touched[touchKey(groupLinkId, idx, leafLinkId)] = true; }

function isBlank(value) {
  return value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}
function instanceIsBlank(inst) {
  return Object.values(inst).every(isBlank);
}

function errorFor(group, idx, leaf) {
  const key = touchKey(group.linkId, idx, leaf.linkId);
  if (!touched[key] || !leaf.required) return '';
  const inst = groupsState[group.linkId][idx];
  if (instanceIsBlank(inst)) return ''; // a fully-untouched extra instance is never an error, just dropped
  return isBlank(inst[leaf.linkId]) ? `${leaf.text} is required.` : '';
}

function touchAllNonBlank() {
  const groups = props.questionnaire?.item || [];
  groups.forEach((group) => {
    (groupsState[group.linkId] || []).forEach((inst, idx) => {
      if (instanceIsBlank(inst)) return;
      (group.item || []).forEach((leaf) => markTouched(group.linkId, idx, leaf.linkId));
    });
  });
}

function hasMissingRequired() {
  const groups = props.questionnaire?.item || [];
  return groups.some((group) =>
    (groupsState[group.linkId] || []).some((inst) => {
      if (instanceIsBlank(inst)) return false;
      return (group.item || []).some((leaf) => leaf.required && isBlank(inst[leaf.linkId]));
    })
  );
}

// Mirrors local-extractor.js's own _fhirValueKey — same real FHIR value[x] mapping, client-side,
// so a hand-built answer here is indistinguishable from one LForms would have produced.
function fhirValueKey(leaf) {
  if (leaf.type === 'boolean') return 'valueBoolean';
  if (leaf.type === 'date') return 'valueDate';
  if (leaf.type === 'integer') return 'valueInteger';
  if (leaf.type === 'decimal') return 'valueDecimal';
  return 'valueString'; // string / choice / open-choice — matches the compiler's own plain-string answerOption shape
}

function buildAnswer(leaf, value) {
  const key = fhirValueKey(leaf);
  if (leaf.type === 'choice' && leaf.repeats) {
    return (Array.isArray(value) ? value : []).map((v) => ({ [key]: v }));
  }
  return [{ [key]: value }];
}

function extract() {
  if (hasMissingRequired()) {
    touchAllNonBlank();
    return null; // same failure contract extractResponse() already has — callers already check `!response`
  }
  const groups = props.questionnaire?.item || [];
  const item = [];
  groups.forEach((group) => {
    (groupsState[group.linkId] || []).forEach((inst) => {
      if (instanceIsBlank(inst)) return; // omit blank instances entirely — matches appendGroupInstance's own established convention
      const leafItems = (group.item || [])
        .filter((leaf) => !isBlank(inst[leaf.linkId]))
        .map((leaf) => ({ linkId: leaf.linkId, answer: buildAnswer(leaf, inst[leaf.linkId]) }));
      item.push({ linkId: group.linkId, item: leafItems });
    });
  });
  return { resourceType: 'QuestionnaireResponse', status: 'completed', item };
}

defineExpose({ extract });
</script>

<template>
  <div class="cf-custom-form-host">
    <div v-for="group in (questionnaire?.item || [])" :key="group.linkId" class="cf-card cf-form-group-card">
      <h4 class="cf-form-group-title">{{ group.text }}</h4>

      <div
        v-for="(inst, idx) in (groupsState[group.linkId] || [])" :key="idx"
        class="cf-form-instance" :class="group.repeats ? 'repeating' : ''"
      >
        <div v-if="group.repeats && (groupsState[group.linkId] || []).length > 1" class="cf-form-instance-header">
          <span>{{ group.text }} #{{ idx + 1 }}</span>
          <button type="button" class="cf-form-remove-btn" @click="removeInstance(group, idx)"><i class="fas fa-trash"></i> Remove</button>
        </div>
        <div class="cf-form-field-grid">
          <FormField
            v-for="leaf in (group.item || [])" :key="leaf.linkId"
            :field="leaf" v-model="inst[leaf.linkId]" :error="errorFor(group, idx, leaf)"
            @blur="markTouched(group.linkId, idx, leaf.linkId)"
          />
        </div>
      </div>

      <button v-if="group.repeats" type="button" class="btn-outline text-sm" @click="addInstance(group)">
        <i class="fas fa-plus"></i> Add Another {{ group.text }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.cf-custom-form-host { display: flex; flex-direction: column; gap: 1.25rem; }
.cf-form-group-card { border-radius: 1rem; padding: 1.25rem; }
.cf-form-group-title {
  font-size: .85rem; font-weight: 700; color: var(--cf-text-strong); font-family: 'Poppins', sans-serif;
  margin-bottom: .875rem; padding-bottom: .625rem; border-bottom: 1px solid var(--cf-border);
}
.cf-form-instance + .cf-form-instance { margin-top: 1rem; padding-top: 1rem; border-top: 1px dashed var(--cf-border); }
.cf-form-instance-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: .625rem;
  font-size: .75rem; font-weight: 600; color: var(--cf-text);
}
.cf-form-remove-btn { background: transparent; border: none; color: #dc2626; font-size: .72rem; cursor: pointer; display: flex; align-items: center; gap: .3rem; }
.cf-form-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 1.25rem; }
</style>
