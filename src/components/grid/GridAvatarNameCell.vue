<script setup>
// Shared AG Grid cellRenderer for the "colored-initial avatar + name" column pattern used across
// AiEngineSandbox.vue's Patients/Staff tables. AG Grid Vue3 cellRenderers are real Vue components
// receiving a single `params` prop (the cell's params object, .value/.data/.colDef etc.) — this
// is the column-def-driven equivalent of what PrimeVue's #body template slots did inline before.
const props = defineProps({ params: { type: Object, required: true } });
const color = props.params.data?.color || '#94A3B8';
const initial = (props.params.value || '?').charAt(0).toUpperCase();
</script>

<template>
  <div class="flex items-center gap-2 h-full">
    <div class="avatar" :style="`background:${color}22;color:${color}`">{{ initial }}</div>
    <span class="td-name">{{ params.value }}</span>
  </div>
</template>
