<script setup>
// Controlled-input replacement for LForms in the Provider/Staff/Facility registration flow —
// SPEC-09 (docs/SPEC-09-ABDM-ANCHORED-ONBOARDING-REBUILD.md). Built specifically because LForms'
// coded/autocomplete fields silently discard a typed value unless a dropdown suggestion is
// explicitly clicked (see clinux-lforms-coded-field-data-loss-bug memory note, confirmed live by
// reading a real saved record back out of localStorage). Plain <select>/<input> elements have no
// such extraction step to fail at — whatever v-model holds IS what gets saved, always.
//
// Sections + help text + inline validation added as the concrete fix for the separately-raised
// "is this actually a very user friendly journey" gap — grouping related fields under a plain-
// language heading, explaining jargon (e.g. "HP Category") inline, and flagging a missing field
// the moment you leave it (not just as one bulk message after Save is clicked) is the difference
// between "the bug is fixed" and "the journey is pleasant to fill out."
import { reactive, watch } from 'vue';
import { getAnswer } from '../data/useSystemForms.js';
import { groupFieldsBySection } from '../data/abdmSchema.js';

const props = defineProps({
  fields: { type: Array, required: true }, // HOSPITAL_FIELDS | STAFF_FIELDS from abdmSchema.js
  record: { type: Object, default: null }, // { data: instance } shape — null pre-fills everything blank
});
const emit = defineEmits(['change']);

const values = reactive({});
const touched = reactive({}); // linkId -> true once the user has left that field (or a save was attempted)

function resetFromRecord() {
  props.fields.forEach((f) => {
    const existing = props.record ? getAnswer(props.record, f.linkId) : '';
    values[f.linkId] = existing || (f.type === 'checkbox' ? 'false' : '');
    touched[f.linkId] = false;
  });
}
resetFromRecord();
watch(() => props.record, resetFromRecord);
watch(values, () => emit('change', { ...values }), { deep: true });

function missingRequired() {
  return props.fields.filter((f) => f.required && !values[f.linkId]);
}

// Reveals every unmet inline error at once — called by the parent when a Save attempt is
// blocked, so a field the user never visited still surfaces its error instead of staying silent.
function touchAll() {
  props.fields.forEach((f) => { touched[f.linkId] = true; });
}

function errorFor(f) {
  if (!touched[f.linkId] || !f.required || values[f.linkId]) return '';
  return `${f.label} is required.`;
}

const sections = groupFieldsBySection(props.fields);

defineExpose({ values, missingRequired, touchAll });
</script>

<template>
  <div style="display:flex;flex-direction:column;gap:1.25rem">
    <div v-for="group in sections" :key="group.section">
      <h4 style="font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--cf-muted,#6b7280);margin:0 0 .55rem;font-weight:600">{{ group.section }}</h4>
      <div style="display:flex;flex-direction:column;gap:.85rem">
        <div v-for="f in group.fields" :key="f.linkId">
          <template v-if="f.type === 'checkbox'">
            <label style="display:flex;align-items:center;gap:.5rem;font-size:.85rem;color:var(--cf-text)">
              <input type="checkbox" true-value="true" false-value="false" v-model="values[f.linkId]" @blur="touched[f.linkId] = true" />
              {{ f.label }}
            </label>
            <p v-if="f.help" style="font-size:.72rem;color:var(--cf-muted,#6b7280);margin:.2rem 0 0 1.6rem">{{ f.help }}</p>
          </template>
          <template v-else>
            <label class="cf-label">{{ f.label }}<span v-if="f.required" style="color:#dc2626"> *</span></label>
            <select
              v-if="f.type === 'select'"
              v-model="values[f.linkId]"
              class="cf-input"
              @blur="touched[f.linkId] = true"
            >
              <option value="">Select one</option>
              <option v-for="opt in f.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <input
              v-else
              type="text"
              v-model="values[f.linkId]"
              class="cf-input"
              :placeholder="f.label"
              @blur="touched[f.linkId] = true"
            />
            <p v-if="f.help && !errorFor(f)" style="font-size:.72rem;color:var(--cf-muted,#6b7280);margin:.3rem 0 0">{{ f.help }}</p>
            <p v-if="errorFor(f)" style="font-size:.72rem;color:#dc2626;margin:.3rem 0 0"><i class="fas fa-circle-exclamation"></i> {{ errorFor(f) }}</p>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
