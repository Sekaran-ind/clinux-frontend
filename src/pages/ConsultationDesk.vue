<script setup>
// Ported from clinixflow's public/consultation-desk.html — the three-region reference pattern
// (left tools tabs / right data pane / bottom unified audit log) this whole migration models
// new pages on. Same SystemForms/clinical/cubo calls; storage moved to TanStack DB collections,
// component model moved to Vue.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { jsPDF } from 'jspdf';
import Cubo from '../components/Cubo.vue';
import CornerstoneViewer from '../components/CornerstoneViewer.vue';
import LhcFormHost from '../components/LhcFormHost.vue';
import { useClinicalStore } from '../stores/clinical.js';
import { useCuboStore } from '../stores/cubo.js';
import { useAuthStore } from '../stores/auth.js';
import { useSlotFillHighlightsStore } from '../stores/slotFillHighlights.js';
import {
  listDataRecords, activeQuestionnaire, activeVersionNumber, saveDataRecord,
  getAnswer, patchRecordField, withGroupFields,
} from '../data/useSystemForms.js';
import {
  getEncounterLogs, logEvent, encounterStage as stageCollection,
  encounterConsent as consentCollection, prescriptions as rxCollection,
  getEncounterImages, careTeam as careTeamCollection,
} from '../data/collections/encounterDocs.js';
import { API_BASE, apiFetch } from '../config.js';

const STAFF_FORM_ID = 'system-staff-profile-v1';

const router = useRouter();
const clinical = useClinicalStore();
const cubo = useCuboStore();
const auth = useAuthStore();
const slotFillHighlights = useSlotFillHighlightsStore();
// Vitals/SOAP/Prescription/Billing all live inside this one merged Encounter-composition
// record now — the right pane below renders the whole thing via LhcFormHost rather than a
// SOAP-only textarea set.
const ENCOUNTER_FORM_ID = clinical.ENCOUNTER_FORM_ID;

const encounter = clinical.getEncounter();
if (encounter) clinical.recordVisit(encounter.id, 'consultation-desk');
const priority = ref(encounter ? getAnswer(encounter, 'encounter_priority') || 'Normal' : 'Normal');
const leftTab = ref('cubo');
const isGenerating = ref(false);
const isGeneratingRx = ref(false);
const logsExpanded = ref(false);
const consentModalOpen = ref(false);
const consentCheckboxChecked = ref(false);
const dataVersion = ref(0);

const consultationQuestionnaire = computed(() => activeQuestionnaire(ENCOUNTER_FORM_ID));
const liveRecord = ref(encounter);
const consultationFormHost = ref(null);

// This tab exists to host Cübo full-time, so start expanded rather than the collapsed FAB badge.
cubo.currentLayout = 'EXPANDED';

const patientName = computed(() => (encounter ? getAnswer(encounter, 'encounter_patient_ref') : ''));
const chiefComplaint = computed(() => (encounter ? getAnswer(encounter, 'encounter_chief_complaint') : ''));

const systemLog = computed(() => {
  dataVersion.value;
  return encounter ? getEncounterLogs(encounter.id) : [];
});

function log(msg, color = 'border-slate-700') {
  if (!encounter) return;
  logEvent(encounter.id, msg, color);
  dataVersion.value++;
}

const encounterStage = computed(() => {
  dataVersion.value;
  if (!encounter) return 'draft';
  return stageCollection.get(encounter.id)?.stage || 'draft';
});

function setEncounterStage(stage) {
  if (!encounter) return;
  if (stageCollection.has(encounter.id)) stageCollection.update(encounter.id, (d) => { d.stage = stage; });
  else stageCollection.insert({ id: encounter.id, stage });
  dataVersion.value++;
  const labels = { draft: 'Draft', review_complete: 'Review Complete', accepted: 'Accepted', rejected: 'Rejected' };
  const colors = { draft: 'border-amber-500', review_complete: 'border-blue-500', accepted: 'border-emerald-500', rejected: 'border-red-500' };
  log(`Encounter stage changed to ${labels[stage]}.`, colors[stage]);
}

const consentStatus = computed(() => {
  dataVersion.value;
  if (!encounter) return 'pending';
  return consentCollection.get(encounter.id)?.status || 'pending';
});

function openConsentModal() {
  consentCheckboxChecked.value = false;
  consentModalOpen.value = true;
}

function setConsent(status) {
  if (!encounter) return;
  const rec = { id: encounter.id, status, decidedAt: new Date().toISOString() };
  if (consentCollection.has(encounter.id)) consentCollection.update(encounter.id, (d) => Object.assign(d, rec));
  else consentCollection.insert(rec);
  dataVersion.value++;
  consentModalOpen.value = false;
}

function agreeConsent() {
  if (!consentCheckboxChecked.value) return;
  setConsent('obtained');
  log('Data sharing consent obtained from patient.', 'border-emerald-500');
}

function declineConsent() {
  setConsent('declined');
  log('Data sharing consent declined by patient.', 'border-red-500');
}

function savePriority() {
  if (!encounter) return;
  patchRecordField(encounter.id, 'encounter_priority', priority.value);
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
    liveRecord.value = { ...(liveRecord.value || { id: encounter.id }), data: withGroupFields(baseData, 'section_soap', fieldValues) };
    log('SOAP draft populated from dictation.', 'border-emerald-500');
  } catch (err) {
    log('Scribe request failed: ' + err.message, 'border-red-500');
  } finally {
    isGenerating.value = false;
  }
}

function saveConsultation() {
  if (!encounter) return;
  const qr = consultationFormHost.value?.extract();
  if (!qr) { log('Could not read the entered data.', 'border-red-500'); return; }
  saveDataRecord(ENCOUNTER_FORM_ID, activeVersionNumber(ENCOUNTER_FORM_ID), qr, encounter.id);
  liveRecord.value = { ...liveRecord.value, data: qr };
  dataVersion.value++;
  log('Consultation record saved.', 'border-emerald-500');
}

function clinicProfile() {
  try { return JSON.parse(localStorage.getItem('cf_clinic_profile') || '{}') || {}; } catch (e) { return {}; }
}

const prescriptions = computed(() => {
  dataVersion.value;
  if (!encounter) return [];
  return rxCollection.toArray.filter((r) => r.encounterId === encounter.id);
});

function generatePrescriptionPdf() {
  if (!encounter) return;
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
      rxCollection.insert({ id: rxId, encounterId: encounter.id, createdAt: new Date().toISOString(), dataUrl: reader.result });
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

// Aggregates lab images + prescriptions into one encounter-scoped Documents list.
const allDocuments = computed(() => {
  dataVersion.value;
  const imgs = (encounter ? getEncounterImages(encounter.id) : []).map((d) => ({ id: d.id, kind: 'image', label: d.filename, timestamp: d.addedAt, ref: d.id, thumb: d.dataUrl, source: d.source || 'imaging' }));
  const rx = prescriptions.value.map((d) => ({ id: d.id, kind: 'prescription', label: 'Prescription — ' + new Date(d.createdAt).toLocaleDateString(), timestamp: d.createdAt, ref: d.id }));
  return [...imgs, ...rx].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
});

function openDocument(doc) {
  if (doc.kind === 'image') leftTab.value = 'imaging';
  else if (doc.kind === 'prescription') viewPrescription(doc.ref);
}

const staffOptions = computed(() => {
  dataVersion.value;
  return listDataRecords(STAFF_FORM_ID).map((rec) => ({ id: rec.id, label: getAnswer(rec, 'staff_name') + (getAnswer(rec, 'staff_role') ? ' — ' + getAnswer(rec, 'staff_role') : '') }));
});

const careTeamMembers = computed(() => {
  dataVersion.value;
  if (!encounter) return [];
  const ids = careTeamCollection.get(encounter.id)?.staffIds ?? [];
  const staffRecs = listDataRecords(STAFF_FORM_ID);
  return ids.map((id) => {
    const rec = staffRecs.find((r) => r.id === id);
    return { id, name: rec ? getAnswer(rec, 'staff_name') : id };
  });
});

function addTeamMember(staffId) {
  if (!staffId || !encounter) return;
  clinical.addCareTeamMember(encounter.id, staffId);
  dataVersion.value++;
  log('Staff member added to care team.');
}

function removeTeamMember(staffId) {
  if (!encounter) return;
  clinical.removeCareTeamMember(encounter.id, staffId);
  dataVersion.value++;
}

// Was no way to reach Checkout from anywhere in the app (no nav entry, no button here) — Front
// Desk's own sendToConsultation() is the pattern this mirrors.
function sendToCheckout() {
  router.push('/checkout');
}
</script>

<template>
  <div v-if="!encounter" class="w-full border rounded-xl p-8 text-center m-6" style="border-color:var(--cf-border)">
    <p class="font-bold mb-1" style="color:var(--cf-text-strong)">No active encounter</p>
    <p class="text-sm" style="color:var(--cf-text)">Start a visit from Front Desk first.</p>
    <RouterLink to="/front-desk" class="btn-teal inline-block mt-4">Go to Front Desk</RouterLink>
  </div>

  <template v-else>
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
        <button class="btn-ghost text-xs" @click="setEncounterStage('review_complete')">Review Complete</button>
        <button class="btn-ghost text-xs" @click="setEncounterStage('accepted')">Accept</button>
        <button class="btn-ghost text-xs" @click="setEncounterStage('rejected')">Reject</button>
        <button class="btn-ghost text-xs" @click="openConsentModal()">Consent: {{ consentStatus }}</button>
        <button class="btn-primary text-xs inline-flex items-center gap-1.5" @click="sendToCheckout()"><i class="fas fa-arrow-right"></i>Send to Checkout</button>
      </div>
    </div>

    <div class="flex-1 flex overflow-hidden">
      <!-- LEFT: tools -->
      <div class="w-[380px] shrink-0 flex flex-col border-r" style="border-color:var(--cf-border)">
        <div class="flex border-b" style="border-color:var(--cf-border)">
          <button class="flex-1 text-xs font-bold py-2.5" :class="leftTab === 'cubo' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="leftTab = 'cubo'">Cübo Assistant</button>
          <button class="flex-1 text-xs font-bold py-2.5" :class="leftTab === 'imaging' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="leftTab = 'imaging'">Labs &amp; Imaging</button>
          <button class="flex-1 text-xs font-bold py-2.5" :class="leftTab === 'documents' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="leftTab = 'documents'">Documents</button>
        </div>

        <div v-show="leftTab === 'cubo'" class="cubo-inline-host flex-1" style="min-height:420px">
          <Cubo category="encounter" :encounter-id="encounter.id" :encounter-title="`${patientName} — ${chiefComplaint}`" page-context="Current Page: ClinixFlow Consultation Desk." />
        </div>

        <div v-show="leftTab === 'imaging'" class="flex-1 overflow-y-auto">
          <CornerstoneViewer :encounter-id="encounter.id" />
        </div>

        <div v-show="leftTab === 'documents'" class="flex-1 overflow-y-auto p-3 space-y-3">
          <div>
            <div class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--cf-text)">All Documents</div>
            <div v-for="doc in allDocuments" :key="doc.id" class="record-card flex items-center justify-between p-2 mb-1.5 cursor-pointer" @click="openDocument(doc)">
              <span class="text-xs" style="color:var(--cf-text-strong)">{{ doc.label }}</span>
              <i :class="doc.kind === 'image' ? 'fas fa-image' : 'fas fa-file-pdf'" class="text-gray-400"></i>
            </div>
          </div>
          <div>
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
      </div>

      <!-- RIGHT: the whole Consultation record (Encounter/Vitals/SOAP/Prescription/Billing) —
           accepted tradeoff: every page shows the whole accumulating document, not just its own
           slice, in exchange for not needing page-scoped subset rendering. -->
      <div class="flex-1 overflow-y-auto p-4 space-y-3">
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
        <div v-if="prescriptions.length" class="pt-2">
          <div class="text-xs font-bold uppercase tracking-wide mb-1" style="color:var(--cf-text)">Prescriptions</div>
          <div v-for="rx in prescriptions" :key="rx.id" class="record-card flex items-center justify-between p-2 mb-1 cursor-pointer" @click="viewPrescription(rx.id)">
            <span class="text-xs">{{ new Date(rx.createdAt).toLocaleString() }}</span>
            <i class="fas fa-file-pdf text-gray-400"></i>
          </div>
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

    <!-- Consent modal -->
    <div class="modal-backdrop" v-show="consentModalOpen" @click.self="consentModalOpen = false">
      <div class="modal-box">
        <h3 class="font-bold mb-3" style="color:var(--cf-text-strong)">Data Sharing Consent</h3>
        <label class="flex items-center gap-2 text-sm mb-4" style="color:var(--cf-text)">
          <input type="checkbox" v-model="consentCheckboxChecked" />
          Patient agrees to share encounter data between app users.
        </label>
        <div class="flex justify-end gap-2">
          <button class="btn-ghost" @click="declineConsent()">Decline</button>
          <button class="btn-teal" :disabled="!consentCheckboxChecked" @click="agreeConsent()">Agree</button>
        </div>
      </div>
    </div>
  </template>
</template>
