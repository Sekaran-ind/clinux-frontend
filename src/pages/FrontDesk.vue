<script setup>
// Ported from clinixflow's public/front-desk.html — the 4-step Patient → Encounter → Vitals →
// Triage wizard. Same behavior, same SystemForms/clinical-store calls; only the storage layer
// underneath (TanStack DB collections instead of raw localStorage) and the component model
// (Vue instead of Alpine) changed.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Cubo from '../components/Cubo.vue';
import LhcFormHost from '../components/LhcFormHost.vue';
import {
  listDataRecords, recordSummary, activeQuestionnaire, activeVersionNumber,
  saveDataRecord, getGroupInstances,
} from '../data/useSystemForms.js';
import { useClinicalStore } from '../stores/clinical.js';

const PATIENT_FORM_ID = 'system-patient-profile-v1';

const router = useRouter();
const clinical = useClinicalStore();
// Encounter/Vitals/Triage all now edit the SAME merged Encounter-composition record
// (clinical.ENCOUNTER_FORM_ID) rather than three separately-keyed forms — see formData.js's
// getGroupInstances for how repeating Vitals readings are read back out of it.
const ENCOUNTER_FORM_ID = clinical.ENCOUNTER_FORM_ID;

const steps = [
  { id: 'patient', label: 'Patient' },
  { id: 'encounter', label: 'Encounter' },
  { id: 'vitals', label: 'Vitals' },
  { id: 'triage', label: 'Triage' },
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

// Resume an in-flight encounter if one exists (e.g. the page was reloaded mid-visit).
const existing = clinical.getEncounter();
if (existing) {
  encounterRecordId.value = existing.id;
  currentStep.value = 2;
}

function nextStep() {
  if (currentStep.value < steps.length - 1) currentStep.value++;
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
  }
}

// One instance per Vitals reading recorded — LForms' own repeating-group "+ Add another"/remove
// controls (inside the drawer form itself) are what add/remove readings now, not app code.
const vitalsRecords = computed(() => {
  dataVersion.value;
  return getGroupInstances(clinical.getEncounter(), 'section_vitals');
});

function sendToConsultation() {
  router.push('/consultation-desk');
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show">
    <i class="fas fa-check-circle" style="color:var(--color-primary)"></i>
    <span>{{ toast.msg }}</span>
  </div>

  <div class="flex-1 flex overflow-hidden">
    <!-- LEFT: Cübo, threaded to this visit's encounter once one exists (see Cubo.vue's
         watch(encounterId) — it starts on a plain front-desk thread during the Patient step,
         then hands off the moment step 2 creates the encounter). -->
    <div class="w-[380px] shrink-0 flex flex-col border-r" style="border-color:var(--cf-border)">
      <div class="cubo-inline-host flex-1" style="min-height:420px">
        <Cubo category="front-desk" :encounter-id="encounterRecordId" page-context="Front Desk — patient onboarding, encounter intake, vitals and triage." />
      </div>
    </div>

    <!-- RIGHT: wizard steps -->
    <div class="flex-1 overflow-y-auto p-6 space-y-3">
      <div class="flex items-center gap-6 flex-wrap mb-6">
        <div v-for="(s, idx) in steps" :key="s.id" class="flex items-center gap-2 cursor-pointer" @click="currentStep = idx">
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
          <span class="section-eyebrow block mb-1">Step 1 of 4</span>
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
          <div class="cf-card rounded-2xl p-5" v-show="selectedPatientId">
            <p class="cf-label">Selected Patient</p>
            <p class="text-base font-bold" style="color:var(--color-primary)">{{ selectedPatientSummary }}</p>
            <button class="btn-teal mt-4" @click="nextStep()">Continue to Encounter <i class="fas fa-arrow-right ml-2"></i></button>
          </div>
        </div>

        <!-- Step 1: Encounter -->
        <div v-show="currentStep === 1">
          <span class="section-eyebrow block mb-1">Step 2 of 4</span>
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Encounter</h2>
          <div class="cf-card rounded-2xl p-5">
            <p class="text-sm mb-4" style="color:var(--cf-text)">Log the chief complaint to open this visit's encounter record.</p>
            <button class="btn-teal" @click="openStep('encounter')"><i class="fas fa-notes-medical"></i> Open Encounter Form</button>
            <div v-show="encounterRecordId" class="mt-4">
              <span class="badge badge-teal"><i class="fas fa-check mr-1"></i>Encounter Opened</span>
              <button class="btn-teal block mt-4" @click="nextStep()">Continue to Vitals <i class="fas fa-arrow-right ml-2"></i></button>
            </div>
          </div>
        </div>

        <!-- Step 2: Vitals -->
        <div v-show="currentStep === 2">
          <span class="section-eyebrow block mb-1">Step 3 of 4</span>
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Vitals</h2>
          <div class="cf-card rounded-2xl p-5">
            <p class="text-sm mb-4" style="color:var(--cf-text)">Record one or more vitals readings for this visit.</p>
            <button class="btn-teal" @click="openStep('vitals')"><i class="fas fa-heartbeat"></i> Record Vitals</button>
            <p class="text-sm mt-3" style="color:var(--cf-text)">{{ vitalsRecords.length }} reading(s) recorded</p>
            <button class="btn-teal mt-4" v-show="vitalsRecords.length > 0" @click="nextStep()">Continue to Triage <i class="fas fa-arrow-right ml-2"></i></button>
          </div>
        </div>

        <!-- Step 3: Triage -->
        <div v-show="currentStep === 3">
          <span class="section-eyebrow block mb-1">Step 4 of 4</span>
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Triage</h2>
          <div class="cf-card rounded-2xl p-5">
            <p class="text-sm mb-4" style="color:var(--cf-text)">Set the case priority before sending the patient through to consultation.</p>
            <button class="btn-teal" @click="openStep('triage')"><i class="fas fa-stethoscope"></i> Set Triage Priority</button>
            <div v-show="encounterRecordId" class="mt-6 pt-6" style="border-top:1px solid var(--cf-border)">
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
      <h3 class="font-bold text-sm" style="color:var(--cf-text-strong)">
        {{ { patient: 'Register Patient', encounter: 'Encounter Intake', vitals: 'Record Vitals', triage: 'Triage Priority' }[activeStepId] || '' }}
      </h3>
      <button @click="closeDrawer()" class="bg-transparent border-none cursor-pointer" style="color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <LhcFormHost v-if="drawerOpen" ref="lhcFormHost" :questionnaire="drawerQuestionnaire" :record="drawerRecord" container-id="drawerFormContainer" />
    </div>
    <div class="drawer-footer">
      <button class="btn-ghost" @click="closeDrawer()">Cancel</button>
      <button class="btn-teal" @click="saveDrawer()">Save</button>
    </div>
  </div>
</template>
