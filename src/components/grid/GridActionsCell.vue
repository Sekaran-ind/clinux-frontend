<script setup>
// Shared AG Grid cellRenderer for the edit/delete row-action buttons used across every table in
// this app. onEdit/onDelete are plain callbacks passed in via the column def's
// cellRendererParams (AG Grid merges them into this same `params` object) — called with the
// row's own data object, exactly like the click handlers this replaced (@click="openXModal(row)").
const props = defineProps({ params: { type: Object, required: true } });
</script>

<template>
  <div class="row-actions">
    <button v-if="params.onEdit" class="btn-row btn-edit" @click="params.onEdit(params.data)"><i class="fas fa-pen"></i></button>
    <button v-if="params.onDelete" class="btn-row btn-del" @click="params.onDelete(params.data)"><i class="fas fa-trash"></i></button>
    <button v-if="params.onView" class="btn-outline" style="font-size:.72rem;padding:.35rem .75rem" @click="params.onView(params.data)"><i class="fas fa-eye"></i> View</button>
  </div>
</template>
