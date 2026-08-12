<script setup>
// Ported from clinixflow's public/consultation-desk.html — the three-region reference pattern
// (left tools tabs / right data pane / bottom unified audit log) this whole migration models
// new pages on. Same SystemForms/clinical/cubo calls; storage moved to TanStack DB collections,
// component model moved to Vue.
import { computed, ref, watch } from 'vue';
import { jsPDF } from 'jspdf';
import Cubo from '../components/Cubo.vue';
import CornerstoneViewer from '../components/CornerstoneViewer.vue';
import LhcFormHost from '../components/LhcFormHost.vue';
import SessionShareModal from '../components/SessionShareModal.vue';
import { useClinicalStore } from '../stores/clinical.js';
import { useCuboStore } from '../stores/cubo.js';
import { useAuthStore } from '../stores/auth.js';
import { useSlotFillHighlightsStore } from '../stores/slotFillHighlights.js';
import { useOnboardingStore } from '../stores/onboarding.js';
import {
  activeQuestionnaire, activeVersionNumber, saveDataRecord,
  getAnswer, patchRecordField, withGroupFields, getGroupInstances,
  listDataRecords, recordSummary,
} from '../data/useSystemForms.js';
import {
  getEncounterLogs, logEvent, prescriptions as rxCollection,
  getEncounterImages, careTeam as careTeamCollection, getEncounterCustomFormLinks,
  attachCustomFormRecord,
} from '../data/collections/encounterDocs.js';
import { API_BASE, apiFetch } from '../config.js';

// This used to be its own routed page reached via /consultation-desk; now mounted directly
// inside ClinicHome.vue (see clinux-frontdesk-consultation-checkout-as-clinic-home-components
// memory note) — navigating to/from Front Desk or Checkout is an emitted event instead of a
// route push, since there's no longer a route to push to.
const emit = defineEmits(['navigate']);
const clinical = useClinicalStore();
const cubo = useCuboStore();
const auth = useAuthStore();
const slotFillHighlights = useSlotFillHighlightsStore();
// Care team picks staff out of the ONE shared Provider record's section_staff repeating group
// post-merge (see clinux-provider-composition-merge memory note), not its own separate form.
const onboarding = useOnboardingStore();
// Vitals/SOAP/Prescription/Billing all live inside this one merged Encounter-composition
// record now — the right pane below renders the whole thing via LhcFormHost rather than a
// SOAP-only textarea set.
const ENCOUNTER_FORM_ID = clinical.ENCOUNTER_FORM_ID;

// A computed, NOT a one-time snapshot — clinical.getEncounter() itself is reactive (see
// clinical.js's useLiveQuery over formData), but a plain `const encounter = clinical.getEncounter()`
// read once at setup freezes whatever it returned at that exact instant for the component's
// whole lifetime, never re-reading even if the real answer changes a moment later. That's
// exactly the bug behind "No active encounter" appearing right after Front Desk hands off here
// (works fine after F5, which forces a fresh setup/read) — the encounter record can still be a
// beat behind activeEncounterId at the instant this component mounts; a computed self-corrects
// on the very next reactive flush instead of freezing on a possibly-premature null.
const encounter = computed(() => clinical.getEncounter());
const priority = ref('Normal');
// Left pane is just Cübo now, like every other page — Labs & Imaging/Documents moved to the
// right pane's own tab bar alongside Consultation Record.
const rightTab = ref('record');
// Mobile/tablet chat<->forms toggle (see style.css's .chat-forms-shell) — chat is the default
// per the mobile-app spec; a no-op above the breakpoint, where both panes always show anyway.
const mobileView = ref('chat'); // 'chat' | 'forms'
const isGenerating = ref(false);
const isGeneratingRx = ref(false);
const logsExpanded = ref(false);
const dataVersion = ref(0);
const liveRecord = ref(null);

// Runs once immediately (covers the normal case, encounter already present at mount) and again
// any time `encounter` resolves/changes (covers the race above, and switching encounters).
watch(encounter, (enc) => {
  if (!enc) return;
  clinical.recordVisit(enc.id, 'consultation-desk');
  priority.value = getAnswer(enc, 'encounter_priority') || 'Normal';
  liveRecord.value = enc;
}, { immediate: true });

// Custom-form drawer — view/edit an already-attached document's own form, prefilled with its
// data. Mirrors Front Desk's own openCustomFormDrawer()/saveDrawer() 'additional' branch exactly
// (same drawer-panel/backdrop CSS, same LhcFormHost usage), since that's the one other place a
// custom form's own drawer is opened in this app.
const customFormDrawerOpen = ref(false);
const customFormDrawerFormId = ref(null);
const customFormDrawerRecord = ref(null);
const customFormDrawerQuestionnaire = ref(null);
const customFormDrawerHost = ref(null);

function openCustomFormDrawer(formId, recordId) {
  customFormDrawerFormId.value = formId;
  customFormDrawerQuestionnaire.value = activeQuestionnaire(formId);
  customFormDrawerRecord.value = recordId ? listDataRecords(formId).find((r) => r.id === recordId) : null;
  customFormDrawerOpen.value = true;
}

function closeCustomFormDrawer() {
  customFormDrawerOpen.value = false;
}

function saveCustomFormDrawer() {
  const qr = customFormDrawerHost.value?.extract();
  if (!qr) { log('Could not read the entered data.', 'border-red-500'); return; }
  const formId = customFormDrawerFormId.value;
  const recordId = saveDataRecord(formId, activeVersionNumber(formId), qr, customFormDrawerRecord.value?.id || null);
  if (encounter.value) attachCustomFormRecord(encounter.value.id, formId, recordId);
  dataVersion.value++;
  closeCustomFormDrawer();
  log('Saved: ' + (activeQuestionnaire(formId)?.title || formId) + '.');
}

const customFormDrawerTitle = computed(() => activeQuestionnaire(customFormDrawerFormId.value)?.title || 'Document');

const consultationQuestionnaire = computed(() => activeQuestionnaire(ENCOUNTER_FORM_ID));
const consultationFormHost = ref(null);

// This tab exists to host Cübo full-time, so start expanded rather than the collapsed FAB badge.
cubo.currentLayout = 'EXPANDED';

const patientName = computed(() => (encounter.value ? getAnswer(encounter.value, 'encounter_patient_ref') : ''));
const chiefComplaint = computed(() => (encounter.value ? getAnswer(encounter.value, 'encounter_chief_complaint') : ''));

// Phase C: QR/text-key session transfer — see sessionShare.js. Consultation Desk only ever
// shows an already-active encounter (the v-if="!encounter" branch above handles the empty
// case), so it only needs the Share side, not Import.
const shareModalOpen = ref(false);

const systemLog = computed(() => {
  dataVersion.value;
  return encounter.value ? getEncounterLogs(encounter.value.id) : [];
});

function log(msg, color = 'border-slate-700') {
  if (!encounter.value) return;
  logEvent(encounter.value.id, msg, color);
  dataVersion.value++;
}

function savePriority() {
  if (!encounter.value) return;
  patchRecordField(encounter.value.id, 'encounter_priority', priority.value);
  log(`Triage priority set to ${priority.value}.`, priority.value === 'Emergency' ? 'border-red-500' : 'border-emerald-500');
}

// Transcript comes from the Cübo chat thread instead of a dedicated dictation textarea, since
// that textarea's slot is now the embedded chat.
function chatTranscript() {
  const messages = cubo.getActiveThread()?.messages || [];
  return messages.filter((m) => m.role === 'user' && m.text).map((m) => m.text).join('. ');
}

async function generateSoapDraft() {
  if (auth.currentUser?.tier !== 'paid') {
    log('AI SOAP drafting requires a paid subscription.', 'border-amber-500');
    return;
  }
  const transcript = chatTranscript();
  if (!transcript.trim()) { log('Nothing dictated in the chat yet.', 'border-amber-500'); return; }
  isGenerating.value = true;
  log('Sending chat transcript to scribe engine…');
  try {
    // Send just the section_soap slice of the merged Questionnaire as the blueprint — the
    // standalone SOAP-only form this used to reference no longer exists, but the server contract
    // (POST /api/workflow/test-scribe) is unchanged: it just needs a Questionnaire whose item[]
    // covers the fields being drafted.
    const merged = consultationQuestionnaire.value;
    const soapGroup = merged?.item?.find((i) => i.linkId === 'section_soap');
    const blueprint = merged && soapGroup ? { ...merged, item: [soapGroup] } : null;
    if (!blueprint) { log('SOAP form is not available.', 'border-red-500'); return; }

    // context is the virtual-room role .md content selected via Cübo's Profile panel — applied
    // server-side (clinuxflow-api) to the scribe LLM's system prompt.
    const res = await apiFetch(`${API_BASE}/api/workflow/test-scribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, activeBlueprint: blueprint, context: cubo.virtualRoom?.markdown || '' }),
    }).then((r) => r.json());

    if (!res.success) { log('Scribe error: ' + res.error, 'border-red-500'); return; }

    const envelope = { data: res.questionnaireResponseEnvelope };
    const s = getAnswer(envelope, 'soap_subjective');
    const o = getAnswer(envelope, 'soap_objective');
    const a = getAnswer(envelope, 'soap_assessment');
    const p = getAnswer(envelope, 'soap_plan');

    // Extract whatever's currently in the live form first (so in-progress edits elsewhere in
    // the merged document — Vitals, Prescription, Billing — survive the re-render below rather
    // than being lost to a stale liveRecord snapshot), then patch just the SOAP group on top.
    const currentQr = consultationFormHost.value?.extract();
    const baseData = currentQr || liveRecord.value?.data || { item: [] };
    const fieldValues = {};
    if (s) fieldValues.soap_subjective = s;
    if (o) fieldValues.soap_objective = o;
    if (a) fieldValues.soap_assessment = a;
    if (p) fieldValues.soap_plan = p;
    liveRecord.value = { ...(liveRecord.value || { id: encounter.value.id }), data: withGroupFields(baseData, 'section_soap', fieldValues) };
    log('SOAP draft populated from dictation.', 'border-emerald-500');
  } catch (err) {
    log('Scribe request failed: ' + err.message, 'border-red-500');
  } finally {
    isGenerating.value = false;
  }
}

function saveConsultation() {
  if (!encounter.value) return;
  const qr = consultationFormHost.value?.extract();
  if (!qr) { log('Could not read the entered data.', 'border-red-500'); return; }
  saveDataRecord(ENCOUNTER_FORM_ID, activeVersionNumber(ENCOUNTER_FORM_ID), qr, encounter.value.id);
  // Deliberately NOT reassigning liveRecord.value here (unlike generateSoapDraft() above, which
  // has to — it's pushing in content the form doesn't have yet). qr was just extracted FROM the
  // on-screen form, so the form already shows exactly this; reassigning liveRecord would only
  // re-trigger LhcFormHost's watcher into a full destroy-and-rebuild of the LForms widget for
  // data that hasn't actually changed on screen — the visible cause of the field-shift glitch
  // right after clicking Save.
  dataVersion.value++;
  log('Consultation record saved.', 'border-emerald-500');
}

function clinicProfile() {
  try { return JSON.parse(localStorage.getItem('cf_clinic_profile') || '{}') || {}; } catch (e) { return {}; }
}

const prescriptions = computed(() => {
  dataVersion.value;
  if (!encounter.value) return [];
  return rxCollection.toArray.filter((r) => r.encounterId === encounter.value.id);
});

function generatePrescriptionPdf() {
  if (!encounter.value) return;
  // Read the freshest SOAP values straight out of the live form (not just liveRecord's last
  // save), so a plan typed but not yet saved still makes it onto the generated PDF.
  const currentQr = consultationFormHost.value?.extract();
  const soapAssessment = getAnswer(currentQr ? { data: currentQr } : liveRecord.value, 'soap_assessment');
  const soapPlan = getAnswer(currentQr ? { data: currentQr } : liveRecord.value, 'soap_plan');
  if (!soapPlan || !soapPlan.trim()) { log('Add a Plan before generating a prescription.', 'border-amber-500'); return; }
  isGeneratingRx.value = true;
  try {
    const clinic = clinicProfile();
    const rxId = 'rx-' + Date.now();
    const doc = new jsPDF({ unit: 'mm', format: 'a5' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 10;
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    const ensureSpace = (lineHeight) => { if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; } };
    const writeWrapped = (text, size, lineHeight, bold) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.splitTextToSize(String(text), contentWidth).forEach((line) => {
        ensureSpace(lineHeight);
        doc.text(line, margin, y);
        y += lineHeight;
      });
    };

    writeWrapped(clinic.name || 'ClinixFlow Clinic', 14, 6, true);
    const addressLine = [clinic.address, clinic.city, clinic.state, clinic.pin].filter(Boolean).join(', ');
    if (addressLine) writeWrapped(addressLine, 9, 4.2, false);
    const contactLine = [clinic.phone, clinic.email].filter(Boolean).join('   |   ');
    if (contactLine) writeWrapped(contactLine, 9, 4.2, false);

    y += 2;
    doc.setDrawColor(0, 212, 178); doc.setLineWidth(0.6); doc.line(margin, y, pageWidth - margin, y);
    y += 6;

    writeWrapped('Patient: ' + (patientName.value || 'Unknown'), 10, 4.6, false);
    if (chiefComplaint.value) writeWrapped('Chief Complaint: ' + chiefComplaint.value, 9, 4.4, false);
    writeWrapped('Date: ' + new Date().toLocaleDateString(), 9, 4.4, false);

    y += 2;
    doc.setDrawColor(203, 213, 225); doc.setLineWidth(0.3); doc.line(margin, y, pageWidth - margin, y);
    y += 6;

    writeWrapped('Diagnosis', 9, 4.5, true);
    writeWrapped(soapAssessment && soapAssessment.trim() ? soapAssessment : '—', 9.5, 4.6, false);

    y += 3;
    writeWrapped('Rx / Plan (Treatment)', 9, 4.5, true);
    writeWrapped(soapPlan, 10, 5, false);

    y += 8;
    ensureSpace(10);
    doc.setDrawColor(100, 116, 139); doc.setLineWidth(0.3);
    doc.line(pageWidth - margin - 45, y, pageWidth - margin, y);
    y += 4;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text("Doctor's Signature", pageWidth - margin - 45, y);

    doc.setFontSize(7); doc.setTextColor(148, 163, 184);
    doc.text(rxId, margin, pageHeight - 6);
    doc.setTextColor(0, 0, 0);

    const blob = doc.output('blob');
    const reader = new FileReader();
    reader.onload = () => {
      rxCollection.insert({ id: rxId, encounterId: encounter.value.id, createdAt: new Date().toISOString(), dataUrl: reader.result });
      dataVersion.value++;
      isGeneratingRx.value = false;
      log('Prescription PDF generated and attached to encounter.', 'border-emerald-500');
    };
    reader.onerror = () => {
      isGeneratingRx.value = false;
      log('Could not generate the prescription PDF.', 'border-red-500');
    };
    reader.readAsDataURL(blob);
  } catch (err) {
    isGeneratingRx.value = false;
    log('Could not generate the prescription PDF: ' + err.message, 'border-red-500');
  }
}

async function viewPrescription(id) {
  const rx = prescriptions.value.find((r) => r.id === id);
  if (!rx) return;
  // rx.dataUrl is a base64 data: URL — kept that way in storage since it's what
  // FileReader.readAsDataURL() produces and it's plain-JSON-serializable for the localStorage-
  // backed rxCollection. Opening it directly (window.open(dataUrl)) puts the ENTIRE base64-
  // encoded PDF in the browser's address bar. Convert to a short-lived blob: URL just for
  // viewing instead — fetch() can decode a data: URL straight into a real Blob.
  try {
    const blob = await fetch(rx.dataUrl).then((r) => r.blob());
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (err) {
    log('Could not open the prescription PDF: ' + err.message, 'border-red-500');
    return;
  }
  log('Viewed prescription PDF.');
}

// Aggregates lab images + prescriptions + custom-form entries (added from Front Desk's
// "Additional Forms" step — see clinux-custom-forms-in-patient-hospital-journeys memory note)
// into one encounter-scoped Documents list.
const allDocuments = computed(() => {
  dataVersion.value;
  const imgs = (encounter.value ? getEncounterImages(encounter.value.id) : []).map((d) => ({ id: d.id, kind: 'image', label: d.filename, timestamp: d.addedAt, ref: d.id, thumb: d.dataUrl, source: d.source || 'imaging' }));
  const rx = prescriptions.value.map((d) => ({ id: d.id, kind: 'prescription', label: 'Prescription — ' + new Date(d.createdAt).toLocaleDateString(), timestamp: d.createdAt, ref: d.id }));
  const custom = (encounter.value ? getEncounterCustomFormLinks(encounter.value.id) : []).map((link) => {
    const rec = listDataRecords(link.formId).find((r) => r.id === link.recordId);
    return {
      id: link.id, kind: 'customForm', ref: link.recordId, formId: link.formId,
      label: (activeQuestionnaire(link.formId)?.title || link.formId) + ' — ' + (rec ? recordSummary(rec) : link.recordId),
      timestamp: link.attachedAt,
    };
  });
  return [...imgs, ...rx, ...custom].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
});

// Custom-form entries open the same drawer/form Front Desk's "Additional Forms" step uses,
// prefilled with the already-saved record, so a click here can both view AND edit it in place.
function openDocument(doc) {
  if (doc.kind === 'image') rightTab.value = 'imaging';
  else if (doc.kind === 'prescription') viewPrescription(doc.ref);
  else if (doc.kind === 'customForm') openCustomFormDrawer(doc.formId, doc.ref);
}

// Staff has no id of its own now (see getGroupInstances doc comment) — array position is the
// identity, same as every other post-merge staff reference in this migration (AbdmOnboarding.vue).
// careTeamCollection's staffIds now hold staff INDEXES, not record ids.
const staffOptions = computed(() => {
  dataVersion.value; onboarding.dataVersion;
  return getGroupInstances(onboarding.getProviderRecord(), 'section_staff').map((instance, index) => {
    const rec = { data: instance };
    return { id: index, label: getAnswer(rec, 'staff_name') + (getAnswer(rec, 'staff_role') ? ' — ' + getAnswer(rec, 'staff_role') : '') };
  });
});

const careTeamMembers = computed(() => {
  dataVersion.value; onboarding.dataVersion;
  if (!encounter.value) return [];
  const ids = careTeamCollection.get(encounter.value.id)?.staffIds ?? [];
  const staffInstances = getGroupInstances(onboarding.getProviderRecord(), 'section_staff');
  return ids.map((id) => {
    const instance = staffInstances[id];
    return { id, name: instance ? getAnswer({ data: instance }, 'staff_name') : id };
  });
});

function addTeamMember(staffId) {
  if (!staffId || !encounter.value) return;
  clinical.addCareTeamMember(encounter.value.id, staffId);
  dataVersion.value++;
  log('Staff member added to care team.');
}

function removeTeamMember(staffId) {
  if (!encounter.value) return;
  clinical.removeCareTeamMember(encounter.value.id, staffId);
  dataVersion.value++;
}

// Was no way to reach Checkout from anywhere in the app (no nav entry, no button here) — Front
// Desk's own sendToConsultation() is the pattern this mirrors.
function sendToCheckout() {
  emit('navigate', 'checkout');
}
</script>

<template>
  <div v-if="!encounter" class="w-full border rounded-xl p-8 text-center m-6" style="border-color:var(--cf-border)">
    <p class="font-bold mb-1" style="color:var(--cf-text-strong)">No active encounter</p>
    <p class="text-sm" style="color:var(--cf-text)">Start a visit from Front Desk first.</p>
    <button class="btn-teal inline-block mt-4" @click="emit('navigate', 'front-desk')">Go to Front Desk</button>
  </div>

  <template v-else>
    <button class="mobile-toggle-fab" @click="mobileView = mobileView === 'chat' ? 'forms' : 'chat'" :title="mobileView === 'chat' ? 'Switch to forms' : 'Switch to chat'">
      <i :class="mobileView === 'chat' ? 'fas fa-table-list' : 'fas fa-comment'"></i>
    </button>

    <!-- Top bar -->
    <div class="flex items-center justify-between px-4 py-3 border-b" style="border-color:var(--cf-border)">
      <div>
        <div class="font-bold" style="color:var(--cf-text-strong)">{{ patientName }}</div>
        <div class="text-xs" style="color:var(--cf-text)">{{ chiefComplaint }}</div>
      </div>
      <div class="flex items-center gap-2">
        <select v-model="priority" @change="savePriority()" class="cf-input text-xs w-32">
          <option>Normal</option>
          <option>Urgent</option>
          <option>Emergency</option>
        </select>
        <button class="btn-outline text-xs inline-flex items-center gap-1.5" @click="shareModalOpen = true"><i class="fas fa-share-nodes"></i>Share / Sync</button>
        <button class="btn-primary text-xs inline-flex items-center gap-1.5" @click="sendToCheckout()"><i class="fas fa-arrow-right"></i>Send to Checkout</button>
      </div>
    </div>

    <SessionShareModal :open="shareModalOpen" :record="encounter" @close="shareModalOpen = false" />

    <div class="flex-1 flex overflow-hidden chat-forms-shell" :class="mobileView === 'chat' ? 'mobile-mode-chat' : 'mobile-mode-forms'">
      <!-- LEFT: Cübo, same confined-pane pattern as Front Desk/Checkout — no tabs here anymore. -->
      <div class="w-[380px] shrink-0 flex flex-col border-r chat-pane" style="border-color:var(--cf-border)">
        <div class="cubo-inline-host flex-1" style="min-height:420px">
          <Cubo category="encounter" :encounter-id="encounter.id" :encounter-title="`${patientName} — ${chiefComplaint}`" page-context="Current Page: ClinixFlow Consultation Desk." />
        </div>
      </div>

      <!-- RIGHT: Consultation Record / Labs & Imaging / Documents, as tabs. -->
      <div class="flex-1 flex flex-col overflow-hidden content-pane">
        <div class="flex border-b" style="border-color:var(--cf-border)">
          <button class="flex-1 text-xs font-bold py-2.5" :class="rightTab === 'record' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="rightTab = 'record'">Consultation Record</button>
          <button class="flex-1 text-xs font-bold py-2.5" :class="rightTab === 'imaging' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="rightTab = 'imaging'">Labs &amp; Imaging</button>
          <button class="flex-1 text-xs font-bold py-2.5" :class="rightTab === 'documents' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="rightTab = 'documents'">Documents</button>
        </div>

        <!-- Consultation Record: the whole Encounter/Vitals/SOAP/Billing document — accepted
             tradeoff: every page shows the whole accumulating document, not just its own slice,
             in exchange for not needing page-scoped subset rendering. Care Team lives here now
             (was in the old Documents tab) instead of the removed Prescriptions list. -->
        <div v-show="rightTab === 'record'" class="flex-1 overflow-y-auto p-4 space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="font-bold text-lg" style="color:var(--cf-text-strong)">Consultation Record</h2>
            <button v-if="auth.currentUser?.tier === 'paid'" class="text-xs px-2 py-1 rounded bg-(--color-primary)/10 text-(--color-primary) font-bold flex items-center gap-1.5" :disabled="isGenerating" @click="generateSoapDraft()">
              <i class="fas fa-magic" :class="isGenerating ? 'fa-spin fa-spinner' : ''"></i>{{ isGenerating ? 'Parsing chat…' : 'Generate SOAP Draft from Chat' }}
            </button>
            <span v-else class="text-xs cf-text">AI SOAP drafting is a paid-tier feature.</span>
          </div>
          <LhcFormHost v-if="consultationQuestionnaire" ref="consultationFormHost" :questionnaire="consultationQuestionnaire" :record="liveRecord" container-id="consultationFormContainer" :highlight-link-ids="slotFillHighlights.recentlyFilled.map((f) => f.linkId)" />
          <p v-else class="text-sm" style="color:var(--cf-text)">
            This form isn't available yet — clinuxflow-api may not be reachable to seed it.
            Confirm it's running, then reload this page.
          </p>
          <div class="flex items-center gap-2">
            <button class="btn-teal" @click="saveConsultation()">Save Consultation Record</button>
            <button class="btn-outline" :disabled="isGeneratingRx" @click="generatePrescriptionPdf()">{{ isGeneratingRx ? 'Generating…' : 'Generate Prescription PDF' }}</button>
          </div>
          <div class="pt-2">
            <div class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--cf-text)">Care Team</div>
            <select class="cf-input text-xs mb-2" @change="addTeamMember($event.target.value); $event.target.value = ''">
              <option value="">+ Add staff member…</option>
              <option v-for="s in staffOptions" :key="s.id" :value="s.id">{{ s.label }}</option>
            </select>
            <div v-for="m in careTeamMembers" :key="m.id" class="flex items-center justify-between p-1.5 text-xs">
              <span style="color:var(--cf-text-strong)">{{ m.name }}</span>
              <button class="text-gray-400 hover:text-red-500" @click="removeTeamMember(m.id)"><i class="fas fa-times"></i></button>
            </div>
          </div>
        </div>

        <div v-show="rightTab === 'imaging'" class="flex-1 overflow-y-auto">
          <CornerstoneViewer :encounter-id="encounter.id" />
        </div>

        <div v-show="rightTab === 'documents'" class="flex-1 overflow-y-auto p-4 space-y-3">
          <div class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--cf-text)">All Documents</div>
          <div v-for="doc in allDocuments" :key="doc.id" class="record-card flex items-center justify-between p-2 mb-1.5 cursor-pointer" @click="openDocument(doc)">
            <span class="text-xs" style="color:var(--cf-text-strong)">{{ doc.label }}</span>
            <i :class="doc.kind === 'image' ? 'fas fa-image' : 'fas fa-file-pdf'" class="text-gray-400"></i>
          </div>
          <p v-if="allDocuments.length === 0" class="text-sm" style="color:var(--cf-text)">No documents attached to this visit yet.</p>
        </div>
      </div>
    </div>

    <!-- BOTTOM: unified system logs -->
    <div class="border-t" style="border-color:var(--cf-border)">
      <button class="w-full flex items-center justify-between px-4 py-2 text-xs font-bold" style="color:var(--cf-text)" @click="logsExpanded = !logsExpanded">
        <span>SYSTEM LOGS ({{ systemLog.length }})</span>
        <i class="fas fa-chevron-up transition-transform" :class="logsExpanded ? '' : 'rotate-180'"></i>
      </button>
      <div v-show="logsExpanded" class="max-h-40 overflow-y-auto px-4 pb-3 space-y-1">
        <div v-for="entry in systemLog" :key="entry.id" class="text-xs border-l-2 pl-2" :class="entry.color">
          [{{ new Date(entry.time).toLocaleTimeString() }}] {{ entry.user }}: {{ entry.action }}
        </div>
      </div>
    </div>

    <!-- Custom-form document drawer — opened from the Documents tab, same drawer-panel/backdrop
         pattern Front Desk/Checkout/Onboarding already use. -->
    <div class="drawer-backdrop" :class="customFormDrawerOpen ? 'open' : ''" @click="closeCustomFormDrawer()"></div>
    <div class="drawer-panel" :class="customFormDrawerOpen ? 'open' : ''">
      <div class="drawer-header">
        <h3 class="font-bold text-sm" style="color:var(--cf-text-strong)">{{ customFormDrawerTitle }}</h3>
        <button @click="closeCustomFormDrawer()" class="bg-transparent border-none cursor-pointer" style="color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
      </div>
      <div class="drawer-body">
        <LhcFormHost v-if="customFormDrawerOpen && customFormDrawerQuestionnaire" ref="customFormDrawerHost" :questionnaire="customFormDrawerQuestionnaire" :record="customFormDrawerRecord" container-id="consultationCustomFormDrawerContainer" :highlight-link-ids="slotFillHighlights.recentlyFilled.map((f) => f.linkId)" />
        <p v-else-if="customFormDrawerOpen" class="text-sm" style="color:var(--cf-text)">
          This form isn't available yet — clinuxflow-api may not be reachable to seed it.
          Confirm it's running, then reopen this drawer.
        </p>
      </div>
      <div class="drawer-footer">
        <button class="btn-ghost" @click="closeCustomFormDrawer()">Cancel</button>
        <button class="btn-teal" @click="saveCustomFormDrawer()">Save</button>
      </div>
    </div>
  </template>
</template>
