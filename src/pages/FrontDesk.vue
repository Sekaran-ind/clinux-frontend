<script setup>
// Ported from clinixflow's public/front-desk.html — the 4-step Patient → Encounter → Vitals →
// Triage wizard. Same behavior, same SystemForms/clinical-store calls; only the storage layer
// underneath (TanStack DB collections instead of raw localStorage) and the component model
// (Vue instead of Alpine) changed.
import { computed, ref } from 'vue';
import Cubo from '../components/Cubo.vue';
import LhcFormHost from '../components/LhcFormHost.vue';
import {
  listDataRecords, recordSummary, activeQuestionnaire, activeVersionNumber,
  saveDataRecord, getGroupInstances, formsLibrary,
} from '../data/useSystemForms.js';
import { useClinicalStore } from '../stores/clinical.js';
import { useCuboStore } from '../stores/cubo.js';
import { useSlotFillHighlightsStore } from '../stores/slotFillHighlights.js';
import { getEncounterCustomFormLinks, attachCustomFormRecord } from '../data/collections/encounterDocs.js';

const PATIENT_FORM_ID = 'system-patient-profile-v1';

// This used to be its own routed page reached via /front-desk; now mounted directly inside
// ClinicHome.vue (see clinux-frontdesk-consultation-checkout-as-clinic-home-components memory
// note) — "moving on" to the next stage of a visit is an emitted event instead of a route push,
// since there's no longer a route to push to.
const emit = defineEmits(['navigate']);
const clinical = useClinicalStore();
const cubo = useCuboStore();
const slotFillHighlights = useSlotFillHighlightsStore();
// This tab hosts Cübo full-time in its own confined pane (below), same as Consultation
// Desk/Checkout — start expanded rather than the collapsed FAB badge. Missing here before: a
// session that opened Front Desk first (the normal, expected order) saw the FAB instead of the
// chat window until it happened to visit Consultation Desk, which is the only page that set this.
cubo.currentLayout = 'EXPANDED';
// Encounter/Vitals/Triage all now edit the SAME merged Encounter-composition record
// (clinical.ENCOUNTER_FORM_ID) rather than three separately-keyed forms — see formData.js's
// getGroupInstances for how repeating Vitals readings are read back out of it.
const ENCOUNTER_FORM_ID = clinical.ENCOUNTER_FORM_ID;

const steps = [
  { id: 'patient', label: 'Patient' },
  { id: 'encounter', label: 'Encounter' },
  { id: 'vitals', label: 'Vitals' },
  { id: 'triage', label: 'Triage' },
  // Custom forms tagged journey: patient in Designer (see
  // clinux-custom-forms-in-patient-hospital-journeys memory note) — a final, optional step
  // rather than folded into an existing one, since there's no existing step a form of unknown
  // shape naturally belongs to.
  { id: 'additional', label: 'Additional Forms' },
];
const currentStep = ref(0);

const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3200);
}

const drawerOpen = ref(false);
const activeStepId = ref(null);
const dataVersion = ref(0); // bumped on every collection write so the computeds below re-derive

const patientSearch = ref('');
const selectedPatientId = ref(null);
const encounterRecordId = ref(null);
const lhcFormHost = ref(null);

// Mobile/tablet chat<->forms toggle (see style.css's .chat-forms-shell) — chat is the default
// per the mobile-app spec; a no-op above the breakpoint, where both panes always show anyway.
const mobileView = ref('chat'); // 'chat' | 'forms'

// Landing view: the active-sessions list, not a silent single-encounter auto-resume (there can
// be more than one open visit at once — staff pick which one, or start a new check-in).
const screen = ref('sessions'); // 'sessions' | 'wizard'
const activeSessions = computed(() => {
  dataVersion.value;
  return clinical.listActiveSessions();
});

if (clinical.activeEncounterId) clinical.recordVisit(clinical.activeEncounterId, 'front-desk');

function startNewSession() {
  encounterRecordId.value = null;
  selectedPatientId.value = null;
  clinical.clearActive();
  currentStep.value = 0;
  screen.value = 'wizard';
}

function resumeSession(session) {
  encounterRecordId.value = session.id;
  clinical.setActive(session.id);
  clinical.recordVisit(session.id, 'front-desk');
  currentStep.value = 1; // Encounter step — a predictable resume point regardless of progress.
  screen.value = 'wizard';
}

// Single entry point for EVERY step transition — the breadcrumb's own click and every
// "Continue to X" button both call this now, instead of a bare `currentStep = idx` assignment.
// Step navigation itself is never gated on prior steps' data anymore (no more "0 readings
// recorded" blocking Vitals -> Triage) — landing on a step instead auto-opens its drawer, so the
// fields are always put in front of the user to review; they can close without changing anything
// and still move on freely. Patient/Additional Forms keep their own search/dropdown-driven UI
// (there's no single "the" record to auto-open for either), so only encounter/vitals/triage
// trigger an auto-open here.
function goToStep(idx) {
  currentStep.value = idx;
  const stepId = steps[idx]?.id;
  if (stepId === 'encounter' || stepId === 'vitals' || stepId === 'triage') openStep(stepId);
}

const patientSearchResults = computed(() => {
  dataVersion.value;
  const q = patientSearch.value.trim().toLowerCase();
  const all = listDataRecords(PATIENT_FORM_ID);
  if (!q) return all.slice(0, 8);
  return all.filter((r) => recordSummary(r).toLowerCase().includes(q)).slice(0, 8);
});

const selectedPatientSummary = computed(() => {
  dataVersion.value;
  const rec = listDataRecords(PATIENT_FORM_ID).find((r) => r.id === selectedPatientId.value);
  return rec ? recordSummary(rec) : '';
});

function selectPatient(id) {
  // Switching to a different patient abandons any encounter already in progress for the
  // previous one — otherwise Encounter/Vitals/Triage keep editing the old encounter.
  if (id !== selectedPatientId.value) {
    encounterRecordId.value = null;
    clinical.clearActive();
  }
  selectedPatientId.value = id;
  showToast('Patient selected.');
}

// A synthetic "existing record" carrying just one pre-filled answer, so a blank form opens with
// a cross-reference (e.g. which encounter/patient) already populated. The wrapper group's
// linkId must match the real compiled form's top-level group exactly — mergeFHIRDataIntoLForms
// matches by linkId at every level.
function buildSeed(formId, linkId, value) {
  if (!value) return null;
  const q = activeQuestionnaire(formId);
  const groupLinkId = q && q.item && q.item[0] ? q.item[0].linkId : linkId;
  return {
    id: 'seed', formId, version: null,
    data: { resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [{ linkId: groupLinkId, item: [{ linkId, answer: [{ valueString: String(value) }] }] }] },
    savedAt: new Date().toISOString(),
  };
}

const drawerQuestionnaire = ref(null);
const drawerRecord = ref(null);
// Which custom form the drawer is currently editing, only meaningful while
// activeStepId === 'additional' — the 4 core steps each have exactly one fixed form/record
// target, but "Additional Forms" hosts an arbitrary number of different custom forms.
const activeCustomFormId = ref(null);

// No restriction on which forms can be added here — any form in the library (system or
// custom, whatever the user wants), not just ones tagged for the Patient journey. Sorted by
// title purely for a predictable dropdown order.
const availableForms = computed(() => {
  dataVersion.value;
  return formsLibrary.toArray
    .map((r) => ({ formId: r.formId, title: activeQuestionnaire(r.formId)?.title || r.formId }))
    .sort((a, b) => a.title.localeCompare(b.title));
});
const selectedAdditionalFormId = ref('');

// Every form record attached to this encounter (see encounterDocs.js's
// getEncounterCustomFormLinks — same "documents attached to an encounter" pattern
// prescriptions/images already use), with the audit trail (who/when) it was added.
const attachedRecords = computed(() => {
  dataVersion.value;
  if (!encounterRecordId.value) return [];
  return getEncounterCustomFormLinks(encounterRecordId.value).map((link) => {
    const rec = listDataRecords(link.formId).find((r) => r.id === link.recordId);
    return {
      id: link.id, formId: link.formId, recordId: link.recordId,
      title: activeQuestionnaire(link.formId)?.title || link.formId,
      summary: rec ? recordSummary(rec) : link.recordId,
      attachedBy: link.attachedBy, attachedAt: link.attachedAt,
    };
  });
});

const drawerTitle = computed(() => {
  if (activeStepId.value === 'additional') {
    return availableForms.value.find((f) => f.formId === activeCustomFormId.value)?.title || 'Additional Form';
  }
  return { patient: 'Register Patient', encounter: 'Encounter Intake', vitals: 'Record Vitals', triage: 'Triage Priority' }[activeStepId.value] || '';
});

// Encounter/Vitals/Triage all share ONE drawer over the same whole merged document (see
// openStep() below) — without this, "Record Vitals" opens the drawer scrolled to the very top
// (Encounter Details), with the actual Vitals fields pushed below the fold. Easy to miss, fill
// the already-filled Encounter fields again instead, and see "0 reading(s) recorded" even
// though something WAS just saved. Scroll straight to the step's own first field instead.
const drawerScrollToLinkId = computed(() => ({ vitals: 'vitals_systolic', triage: 'encounter_priority' }[activeStepId.value] || null));

// recordId only when editing an existing entry — omitted (null), this opens a blank instance,
// matching Designer's Data Explorer's own openNewDataEntry()/viewDataRecord() split.
function openCustomFormDrawer(formId, recordId = null) {
  activeStepId.value = 'additional';
  activeCustomFormId.value = formId;
  drawerOpen.value = true;
  drawerQuestionnaire.value = activeQuestionnaire(formId);
  drawerRecord.value = recordId ? listDataRecords(formId).find((r) => r.id === recordId) : null;
}

function openStep(stepId) {
  activeStepId.value = stepId;
  drawerOpen.value = true;
  //alert(stepId);
  if (stepId === 'patient') {
    drawerQuestionnaire.value = activeQuestionnaire(PATIENT_FORM_ID);
    drawerRecord.value = null;
    return;
  }
  // Encounter/Vitals/Triage all open the SAME merged Encounter-composition document now —
  // whichever step you're on, you see (and can fill in) the whole accumulating record, not just
  // that step's slice. Accepted tradeoff: simpler than building page-scoped subset rendering.
  if (stepId === 'encounter' || stepId === 'vitals' || stepId === 'triage') {
    drawerQuestionnaire.value = activeQuestionnaire(ENCOUNTER_FORM_ID);
    const rec = encounterRecordId.value ? listDataRecords(ENCOUNTER_FORM_ID).find((r) => r.id === encounterRecordId.value) : null;
    drawerRecord.value = rec || buildSeed(ENCOUNTER_FORM_ID, 'encounter_patient_ref', selectedPatientSummary.value);
  }
}

function closeDrawer() {
  drawerOpen.value = false;
}

function saveDrawer() {
  const qr = lhcFormHost.value?.extract();
  if (!qr) { showToast('Could not read the entered data.'); return; }

  if (activeStepId.value === 'patient') {
    const id = saveDataRecord(PATIENT_FORM_ID, activeVersionNumber(PATIENT_FORM_ID), qr);
    dataVersion.value++;
    if (id !== selectedPatientId.value) {
      encounterRecordId.value = null;
      clinical.clearActive();
    }
    selectedPatientId.value = id;
    closeDrawer();
    showToast('Patient registered.');
    return;
  }
  if (activeStepId.value === 'encounter' || activeStepId.value === 'vitals' || activeStepId.value === 'triage') {
    encounterRecordId.value = saveDataRecord(ENCOUNTER_FORM_ID, activeVersionNumber(ENCOUNTER_FORM_ID), qr, encounterRecordId.value);
    clinical.setActive(encounterRecordId.value);
    dataVersion.value++;
    closeDrawer();
    showToast('Encounter updated.');
    return;
  }
  if (activeStepId.value === 'additional') {
    const formId = activeCustomFormId.value;
    const recordId = saveDataRecord(formId, activeVersionNumber(formId), qr, drawerRecord.value?.id || null);
    if (encounterRecordId.value) attachCustomFormRecord(encounterRecordId.value, formId, recordId);
    dataVersion.value++;
    closeDrawer();
    showToast('Saved.');
  }
}

// One instance per Vitals reading recorded — LForms' own repeating-group "+ Add another"/remove
// controls (inside the drawer form itself) are what add/remove readings now, not app code.
const vitalsRecords = computed(() => {
  dataVersion.value;
  return getGroupInstances(clinical.getEncounter(), 'section_vitals');
});

function sendToConsultation() {
  emit('navigate', 'consultation-desk');
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show">
    <i class="fas fa-check-circle" style="color:var(--color-primary)"></i>
    <span>{{ toast.msg }}</span>
  </div>

  <button class="mobile-toggle-fab" @click="mobileView = mobileView === 'chat' ? 'forms' : 'chat'" :title="mobileView === 'chat' ? 'Switch to forms' : 'Switch to chat'">
    <i :class="mobileView === 'chat' ? 'fas fa-table-list' : 'fas fa-comment'"></i>
  </button>

  <div class="flex-1 flex overflow-hidden chat-forms-shell" :class="mobileView === 'chat' ? 'mobile-mode-chat' : 'mobile-mode-forms'">
    <!-- LEFT: Cübo, threaded to this visit's encounter once one exists (see Cubo.vue's
         watch(encounterId) — it starts on a plain front-desk thread during the Patient step,
         then hands off the moment step 2 creates the encounter). -->
    <div class="w-[380px] shrink-0 flex flex-col border-r chat-pane" style="border-color:var(--cf-border)">
      <div class="cubo-inline-host flex-1" style="min-height:420px">
        <Cubo category="front-desk" :encounter-id="encounterRecordId" page-context="Front Desk — patient onboarding, encounter intake, vitals and triage." />
      </div>
    </div>

    <!-- RIGHT: sessions list, or the wizard once a session's picked/started -->
    <div class="flex-1 overflow-y-auto p-6 space-y-3 content-pane">
      <div v-if="screen === 'sessions'" class="max-w-[720px]">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-2xl font-bold" style="color:var(--cf-text-strong)">Active Sessions</h2>
          <button class="btn-teal whitespace-nowrap" @click="startNewSession()"><i class="fas fa-plus"></i> New Check-In</button>
        </div>
        <div v-if="activeSessions.length === 0" class="cf-card rounded-2xl p-5 text-sm" style="color:var(--cf-text)">
          No active sessions right now. Start a new check-in above.
        </div>
        <div v-else class="flex flex-col gap-2">
          <div v-for="s in activeSessions" :key="s.id" class="record-card flex items-center justify-between p-3">
            <div>
              <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ s.patientRef || 'Unknown patient' }}</span>
              <span class="text-xs ml-2" style="color:var(--cf-text)">{{ s.chiefComplaint }}</span>
              <div class="text-xs mt-0.5" style="color:var(--cf-text)">
                <span class="badge badge-teal">{{ s.status }}</span>
                <span v-if="s.priority === 'Emergency'" class="badge ml-1" style="background:#fee2e2;color:#b91c1c">Emergency</span>
              </div>
            </div>
            <button class="btn-outline text-xs px-3 py-1.5" @click="resumeSession(s)">Resume</button>
          </div>
        </div>
      </div>

      <div v-else>
      <div class="flex items-center gap-6 flex-wrap mb-6">
        <button class="btn-ghost text-xs" @click="screen = 'sessions'"><i class="fas fa-arrow-left"></i> Sessions</button>
        <div v-for="(s, idx) in steps" :key="s.id" class="flex items-center gap-2 cursor-pointer" @click="goToStep(idx)">
          <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0"
               :class="idx < currentStep ? 'bg-(--color-primary) text-(--color-secondary)' : idx === currentStep ? 'bg-(--color-secondary) text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-500'">
            <i v-if="idx < currentStep" class="fas fa-check text-xs"></i>
            <span v-else>{{ idx + 1 }}</span>
          </div>
          <span class="text-sm" :class="idx === currentStep ? 'font-bold' : ''" style="color:var(--cf-text)">{{ s.label }}</span>
        </div>
      </div>

      <div class="max-w-[720px]">
        <!-- Step 0: Patient -->
        <div v-show="currentStep === 0">
          <span class="section-eyebrow block mb-1">{{ 'Step 1 of ' + steps.length }}</span>
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Patient</h2>
          <div class="cf-card rounded-2xl p-5 mb-5">
            <div class="flex gap-2.5 mb-4">
              <input class="cf-input" v-model="patientSearch" placeholder="Search existing patients by name..." />
              <button class="btn-teal whitespace-nowrap" @click="openStep('patient')"><i class="fas fa-plus"></i> New Patient</button>
            </div>
            <div v-show="patientSearchResults.length === 0" class="text-sm py-2" style="color:var(--cf-text)">No matching patients. Search above or register a new one.</div>
            <div class="flex flex-col gap-2">
              <div v-for="rec in patientSearchResults" :key="rec.id" class="record-card flex items-center justify-between p-2">
                <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ recordSummary(rec) }}</span>
                <button class="btn-outline text-xs px-3 py-1.5" @click="selectPatient(rec.id)">Select</button>
              </div>
            </div>
          </div>
          <div class="cf-card rounded-2xl p-5">
            <div v-show="selectedPatientId" class="mb-4">
              <p class="cf-label">Selected Patient</p>
              <p class="text-base font-bold" style="color:var(--color-primary)">{{ selectedPatientSummary }}</p>
            </div>
            <p v-show="!selectedPatientId" class="text-sm mb-4" style="color:var(--cf-text)">No patient selected yet — you can still continue; the Patient field on the Encounter form will just start blank.</p>
            <button class="btn-teal" @click="goToStep(1)">Continue to Encounter <i class="fas fa-arrow-right ml-2"></i></button>
          </div>
        </div>

        <!-- Step 1: Encounter -->
        <div v-show="currentStep === 1">
          <span class="section-eyebrow block mb-1">{{ 'Step 2 of ' + steps.length }}</span>
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Encounter</h2>
          <div class="cf-card rounded-2xl p-5">
            <p class="text-sm mb-4" style="color:var(--cf-text)">Log the chief complaint to open this visit's encounter record.</p>
            <button class="btn-teal" @click="openStep('encounter')"><i class="fas fa-notes-medical"></i> Open Encounter Form</button>
            <div class="mt-4">
              <span v-show="encounterRecordId" class="badge badge-teal"><i class="fas fa-check mr-1"></i>Encounter Opened</span>
              <button class="btn-teal block mt-4" @click="goToStep(2)">Continue to Vitals <i class="fas fa-arrow-right ml-2"></i></button>
            </div>
          </div>
        </div>

        <!-- Step 2: Vitals -->
        <div v-show="currentStep === 2">
          <span class="section-eyebrow block mb-1">{{ 'Step 3 of ' + steps.length }}</span>
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Vitals</h2>
          <div class="cf-card rounded-2xl p-5">
            <p class="text-sm mb-4" style="color:var(--cf-text)">Record one or more vitals readings for this visit.</p>
            <button class="btn-teal" @click="openStep('vitals')"><i class="fas fa-heartbeat"></i> Record Vitals</button>
            <p class="text-sm mt-3" style="color:var(--cf-text)">{{ vitalsRecords.length }} reading(s) recorded</p>
            <button class="btn-teal mt-4" @click="goToStep(3)">Continue to Triage <i class="fas fa-arrow-right ml-2"></i></button>
          </div>
        </div>

        <!-- Step 3: Triage -->
        <div v-show="currentStep === 3">
          <span class="section-eyebrow block mb-1">{{ 'Step 4 of ' + steps.length }}</span>
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Triage</h2>
          <div class="cf-card rounded-2xl p-5">
            <p class="text-sm mb-4" style="color:var(--cf-text)">Set the case priority before sending the patient through to consultation.</p>
            <button class="btn-teal" @click="openStep('triage')"><i class="fas fa-stethoscope"></i> Set Triage Priority</button>
            <div class="mt-6 pt-6" style="border-top:1px solid var(--cf-border)">
              <button class="btn-teal" @click="goToStep(4)">Continue to Additional Forms <i class="fas fa-arrow-right ml-2"></i></button>
            </div>
          </div>
        </div>

        <!-- Step 4: Additional Forms — any form in the library, not just ones tagged for the
             Patient journey (no restriction on what can be added here — see
             clinux-custom-forms-in-patient-hospital-journeys memory note). Optional/
             supplementary, so this is where "Send to Consultation Desk" now lives — the wrap-up
             step regardless of whether anything's actually added. -->
        <div v-show="currentStep === 4">
          <span class="section-eyebrow block mb-1">{{ 'Step 5 of ' + steps.length }}</span>
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Additional Forms</h2>
          <div class="cf-card rounded-2xl p-5 mb-5">
            <p class="text-sm mb-4" style="color:var(--cf-text)">Add any form from the library to this visit.</p>
            <div class="flex gap-2.5">
              <select class="cf-input" v-model="selectedAdditionalFormId">
                <option value="">Select a form…</option>
                <option v-for="f in availableForms" :key="f.formId" :value="f.formId">{{ f.title }}</option>
              </select>
              <button class="btn-teal whitespace-nowrap" :disabled="!selectedAdditionalFormId" @click="openCustomFormDrawer(selectedAdditionalFormId)"><i class="fas fa-plus"></i> Add</button>
            </div>
          </div>

          <div class="cf-card rounded-2xl p-5 mb-5">
            <p class="text-sm font-bold mb-3" style="color:var(--cf-text-strong)">Added to this visit</p>
            <p v-if="attachedRecords.length === 0" class="text-sm" style="color:var(--cf-text)">Nothing added yet for this visit.</p>
            <div v-else class="flex flex-col gap-2">
              <div v-for="entry in attachedRecords" :key="entry.id" class="record-card flex items-center justify-between p-2 cursor-pointer" @click="openCustomFormDrawer(entry.formId, entry.recordId)">
                <div>
                  <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ entry.title }} — {{ entry.summary }}</span>
                  <div class="text-xs mt-0.5" style="color:var(--cf-text)">Added by {{ entry.attachedBy }} · {{ new Date(entry.attachedAt).toLocaleString() }}</div>
                </div>
                <button class="btn-outline text-xs px-3 py-1.5" @click.stop="openCustomFormDrawer(entry.formId, entry.recordId)">View / Edit</button>
              </div>
            </div>
          </div>

          <div class="cf-card rounded-2xl p-5" v-show="encounterRecordId">
            <button class="btn-primary inline-flex items-center gap-2" @click="sendToConsultation()"><i class="fas fa-arrow-right"></i>Send to Consultation Desk</button>
          </div>
        </div>
      </div>
      </div>
    </div>
  </div>

  <!-- Drawer -->
  <div class="drawer-backdrop" :class="drawerOpen ? 'open' : ''" @click="closeDrawer()"></div>
  <div class="drawer-panel" :class="drawerOpen ? 'open' : ''">
    <div class="drawer-header">
      <h3 class="font-bold text-sm" style="color:var(--cf-text-strong)">{{ drawerTitle }}</h3>
      <button @click="closeDrawer()" class="bg-transparent border-none cursor-pointer" style="color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <LhcFormHost v-if="drawerOpen && drawerQuestionnaire" ref="lhcFormHost" :questionnaire="drawerQuestionnaire" :record="drawerRecord" container-id="drawerFormContainer" :highlight-link-ids="slotFillHighlights.recentlyFilled.map((f) => f.linkId)" :scroll-to-link-id="drawerScrollToLinkId" />
      <p v-else-if="drawerOpen" class="text-sm" style="color:var(--cf-text)">
        This form isn't available yet — clinuxflow-api may not be reachable to seed it.
        Confirm it's running, then reopen this drawer.
      </p>
    </div>
    <div class="drawer-footer">
      <button class="btn-ghost" @click="closeDrawer()">Cancel</button>
      <button class="btn-teal" @click="saveDrawer()">Save</button>
    </div>
  </div>
</template>
