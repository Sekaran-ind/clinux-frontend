<script setup>
// Shared AG Grid cellRenderer for a single colored status/role badge. `classMap` and
// `fallbackClass`/`fallbackText` come through as extra cellRendererParams (AG Grid merges them
// into this same `params` object) — see each column def's own class-name mapping.
const props = defineProps({ params: { type: Object, required: true } });
const cls = props.params.classMap?.[props.params.value] || props.params.fallbackClass || 'badge-tech';
</script>

<template>
  <span class="badge" :class="cls">{{ params.value || params.fallbackText || '—' }}</span>
</template>
