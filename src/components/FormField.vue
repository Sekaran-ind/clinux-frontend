<script setup>
// One leaf field's widget — the real onboarding-UI rebuild's custom, FHIR-compliant replacement
// for LHC-Forms' generic (and, per direct feedback, too-narrow-for-a-form-this-dense) auto-
// rendered widget. Deliberately dumb/reusable: reads its own shape (label/required/type/choices)
// straight off the compiled FHIR Questionnaire item CustomFormHost.vue hands it — never a second,
// hand-maintained field list (the exact mistake that made the old AbdmFieldForm.vue/STAFF_FIELDS
// drift out of sync with the real schema). `modelValue` is a plain JS value (string / boolean /
// number / string[] for a repeating choice) — CustomFormHost.vue owns turning that into a real
// FHIR answer ({valueString}/{valueBoolean}/...), not this component; keeps the FHIR-shape
// knowledge in one place instead of duplicated per widget.
const props = defineProps({
  field: { type: Object, required: true }, // compiled Questionnaire leaf item: {linkId, text, type, required, repeats, answerOption}
  modelValue: { default: '' },
  error: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'blur']);

function onInput(value) {
  emit('update:modelValue', value);
}
function toggleMultiSelect(choice) {
  const current = Array.isArray(props.modelValue) ? props.modelValue : [];
  const next = current.includes(choice) ? current.filter((c) => c !== choice) : [...current, choice];
  emit('update:modelValue', next);
}
</script>

<template>
  <div class="cf-form-field">
    <label class="cf-label">{{ field.text }}<span v-if="field.required" style="color:#dc2626"> *</span></label>

    <!-- boolean — a real Yes/No toggle, unset until touched (FHIR's own "not answered yet" state
         is simply no answer[] entry at all, not a third explicit value) -->
    <div v-if="field.type === 'boolean'" style="display:flex;gap:.5rem">
      <button
        type="button" class="cf-bool-btn" :class="modelValue === true ? 'active' : ''"
        @click="onInput(true); $emit('blur')"
      ><i class="fas fa-check"></i> Yes</button>
      <button
        type="button" class="cf-bool-btn" :class="modelValue === false ? 'active' : ''"
        @click="onInput(false); $emit('blur')"
      ><i class="fas fa-xmark"></i> No</button>
    </div>

    <!-- choice, single-select -->
    <select
      v-else-if="field.type === 'choice' && !field.repeats"
      class="cf-input" :value="modelValue" @change="onInput($event.target.value)" @blur="$emit('blur')"
    >
      <option value="">Select one</option>
      <option v-for="opt in field.answerOption || []" :key="opt.valueString" :value="opt.valueString">{{ opt.valueString }}</option>
    </select>

    <!-- choice, multi-select — a real checkbox list, not a typeahead: nothing here can silently
         discard a selection the way LForms' coded-autocomplete widget could -->
    <div v-else-if="field.type === 'choice' && field.repeats" class="cf-multiselect" @focusout="$emit('blur')">
      <label v-for="opt in field.answerOption || []" :key="opt.valueString" class="cf-multiselect-option">
        <input
          type="checkbox" :checked="(modelValue || []).includes(opt.valueString)"
          @change="toggleMultiSelect(opt.valueString)"
        />
        <span>{{ opt.valueString }}</span>
      </label>
    </div>

    <!-- date -->
    <input
      v-else-if="field.type === 'date'"
      type="date" class="cf-input" :value="modelValue" @input="onInput($event.target.value)" @blur="$emit('blur')"
    />

    <!-- decimal / integer -->
    <input
      v-else-if="field.type === 'decimal' || field.type === 'integer'"
      type="number" step="any" class="cf-input" :value="modelValue" :placeholder="field.text"
      @input="onInput($event.target.value === '' ? '' : Number($event.target.value))" @blur="$emit('blur')"
    />

    <!-- open-choice (Autocomplete) — a real <datalist> suggests values but, unlike a typeahead
         widget requiring an explicit confirm click, can never silently discard a typed value that
         doesn't match one of them (the real, live-confirmed bug this whole rebuild avoids). -->
    <template v-else-if="field.type === 'open-choice'">
      <input
        type="text" class="cf-input" :list="`${field.linkId}-options`" :value="modelValue" :placeholder="field.text"
        @input="onInput($event.target.value)" @blur="$emit('blur')"
      />
      <datalist :id="`${field.linkId}-options`">
        <option v-for="opt in field.answerOption || []" :key="opt.valueString" :value="opt.valueString" />
      </datalist>
    </template>

    <!-- string / default -->
    <input
      v-else
      type="text" class="cf-input" :value="modelValue" :placeholder="field.text"
      @input="onInput($event.target.value)" @blur="$emit('blur')"
    />

    <p v-if="field.description" style="font-size:.72rem;color:var(--cf-muted,#6b7280);margin:.3rem 0 0">{{ field.description }}</p>
    <p v-if="error" style="font-size:.72rem;color:#dc2626;margin:.3rem 0 0"><i class="fas fa-circle-exclamation"></i> {{ error }}</p>
  </div>
</template>

<style scoped>
.cf-form-field { margin-bottom: .85rem; }
.cf-bool-btn {
  flex: 1; padding: .5rem .75rem; border-radius: .5rem; border: 1px solid var(--cf-border);
  background: var(--cf-bg, transparent); color: var(--cf-text); font-size: .82rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: .4rem;
}
.cf-bool-btn.active { border-color: var(--color-primary); color: var(--color-primary); background: rgba(0,212,178,.08); font-weight: 600; }
.cf-multiselect {
  display: flex; flex-direction: column; gap: .35rem; border: 1px solid var(--cf-border);
  border-radius: .5rem; padding: .5rem .65rem; max-height: 180px; overflow-y: auto;
}
.cf-multiselect-option { display: flex; align-items: center; gap: .5rem; font-size: .82rem; color: var(--cf-text); cursor: pointer; }
</style>
