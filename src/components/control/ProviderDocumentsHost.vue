<script setup>
// A practitioner's own Professional Documents section — a real gap: everything else (Personal
// Details, ABDM Registration) had a home, but there was no place to keep the actual certificates/
// IDs themselves. Deliberately its own section, not folded into the ABDM (HPR) tab — HPR's own
// document panel is read-only retrieval from ABDM's registry, this is the practitioner's own
// upload/manage surface, unrelated to whether they've ever registered with ABDM at all.
//
// Local-first, same FileReader -> base64 dataUrl -> TanStack DB row pattern CornerstoneViewer.vue
// already established for encounter images — see practitionerDocs.js's own header for why this
// is a new collection rather than reusing that one (different owner shape: accountId, not
// encounterId).
import { ref, useTemplateRef } from 'vue';
import { useLiveQuery } from '@tanstack/vue-db';
import { practitionerDocuments, DOC_TYPES } from '../../data/collections/practitionerDocs.js';

const props = defineProps({
  accountId: { type: String, required: true },
});

const { data: allDocs } = useLiveQuery((q) => q.from({ d: practitionerDocuments }));
const myDocs = () => allDocs.value
  .filter((d) => d.accountId === props.accountId)
  .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

const fileInputEl = useTemplateRef('fileInput');
const pendingDocType = ref(DOC_TYPES[0]);
const uploadError = ref('');

const MAX_BYTES = 5 * 1024 * 1024; // 5MB — generous enough for a scanned certificate/PDF, small enough to keep localStorage-backed collections sane (same order of magnitude FacilityHfrPanel.vue's own 2MB photo cap uses).

function triggerUpload() {
  uploadError.value = '';
  fileInputEl.value?.click();
}

function handleFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > MAX_BYTES) {
    uploadError.value = `"${file.name}" is too large (max 5MB).`;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    practitionerDocuments.insert({
      id: 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      accountId: props.accountId,
      filename: file.name,
      docType: pendingDocType.value,
      dataUrl: reader.result,
      uploadedAt: new Date().toISOString(),
    });
  };
  reader.onerror = () => { uploadError.value = `Could not read "${file.name}".`; };
  reader.readAsDataURL(file);
}

function removeDoc(id) {
  if (practitionerDocuments.has(id)) practitionerDocuments.delete(id);
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
</script>

<template>
  <div class="cf-card rounded-2xl p-4">
    <p class="cf-label mb-2">Upload a Document</p>
    <div class="flex items-center gap-2 flex-wrap">
      <select class="cf-input" style="max-width:280px" v-model="pendingDocType">
        <option v-for="t in DOC_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
      <button class="btn-outline text-sm" @click="triggerUpload()"><i class="fas fa-upload"></i> Choose File</button>
      <input ref="fileInput" type="file" accept="image/*,.pdf" style="display:none" @change="handleFileSelected" />
    </div>
    <p v-if="uploadError" style="font-size:.75rem;color:#dc2626;margin-top:.5rem"><i class="fas fa-circle-exclamation"></i> {{ uploadError }}</p>
    <p class="text-xs mt-2" style="color:var(--cf-text)">Kept on this device (and synced to your LAN server if one's connected) — not uploaded anywhere else.</p>
  </div>

  <div class="cf-card rounded-2xl p-4 mt-3">
    <p class="cf-label mb-2">Your Documents</p>
    <div v-if="myDocs().length" class="flex flex-col gap-2">
      <div v-for="doc in myDocs()" :key="doc.id" class="record-card flex items-center justify-between p-2.5">
        <div class="flex items-center gap-2 min-w-0">
          <i class="fas fa-file-lines" style="color:var(--cf-text)"></i>
          <div class="min-w-0">
            <div class="text-sm font-semibold truncate" style="color:var(--cf-text-strong)">{{ doc.filename }}</div>
            <div class="text-xs" style="color:var(--cf-text)">{{ doc.docType }} · {{ formatDate(doc.uploadedAt) }}</div>
          </div>
        </div>
        <div class="flex items-center gap-1 flex-shrink-0">
          <a :href="doc.dataUrl" :download="doc.filename" class="btn-ghost text-xs px-2 py-1" title="View / Download"><i class="fas fa-eye"></i></a>
          <button class="btn-ghost text-xs px-2 py-1" title="Remove" @click="removeDoc(doc.id)"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    </div>
    <p v-else class="text-xs text-center py-2" style="color:var(--cf-text)">No documents uploaded yet.</p>
  </div>
</template>
