<script setup>
// One Questionnaire field, rendered by its widget (questionnaireForm.js's widgetOf): text-like
// inputs (text/email/tel/url/time), number, date, textarea, checkbox, select, radio, and a
// multi-select as toggle chips. Values live in the parent's reactive `values` object.
defineProps({
  field: { type: Object, required: true },
  values: { type: Object, required: true },
  toggle: { type: Function, required: true },
  error: { type: String, default: '' },
});
</script>

<template>
  <label v-if="field.widget === 'checkbox'" class="qf-check">
    <input v-model="values[field.linkId]" type="checkbox" />
    <span>{{ field.label }}</span>
  </label>
  <div v-else class="qf-control">
    <label class="cf-label" :for="`qf-${field.linkId}`">{{ field.label }}<span v-if="field.required" class="qf-req"> *</span></label>
    <select v-if="field.widget === 'select'" :id="`qf-${field.linkId}`" v-model="values[field.linkId]" class="cf-input">
      <option value="">Choose…</option>
      <option v-for="o in field.options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <div v-else-if="field.widget === 'radio'" class="qf-chips" role="radiogroup" :aria-label="field.label">
      <label v-for="o in field.options" :key="o.value" class="qf-chip" :class="{ on: values[field.linkId] === o.value }">
        <input v-model="values[field.linkId]" type="radio" :value="o.value" class="sr-only" />{{ o.label }}
      </label>
    </div>
    <div v-else-if="field.widget === 'multiselect'" class="qf-chips" role="group" :aria-label="field.label">
      <button v-for="o in field.options" :key="o.value" type="button" class="qf-chip" :class="{ on: values[field.linkId].includes(o.value) }" :aria-pressed="values[field.linkId].includes(o.value)" @click="toggle(field, o.value)">{{ o.label }}</button>
    </div>
    <textarea v-else-if="field.widget === 'textarea'" :id="`qf-${field.linkId}`" v-model="values[field.linkId]" class="cf-input" rows="3"></textarea>
    <input v-else :id="`qf-${field.linkId}`" v-model="values[field.linkId]" class="cf-input" :type="field.widget === 'text' ? 'text' : field.widget" :inputmode="field.widget === 'number' ? 'decimal' : undefined" />
    <p v-if="error" class="qf-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.qf-control { display: flex; flex-direction: column; gap: .3rem; }
.qf-req { color: #dc2626; }
.qf-check { display: flex; align-items: center; gap: .5rem; font-size: .85rem; font-weight: 600; color: var(--cf-text-strong); padding-top: 1.4rem; cursor: pointer; }
.qf-check input { width: 16px; height: 16px; }
.qf-chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.qf-chip { font-size: .78rem; font-weight: 600; padding: .3rem .7rem; border-radius: 99px; border: 1px solid var(--cf-border); background: var(--cf-bg-alt); color: var(--cf-text); cursor: pointer; }
.qf-chip.on { background: var(--color-primary-soft, rgba(0,212,178,.12)); border-color: var(--color-primary); color: var(--color-primary-text, var(--color-primary)); }
.qf-error { font-size: .72rem; color: #dc2626; margin: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
