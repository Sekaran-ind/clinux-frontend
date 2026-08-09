<script setup>
// Ported from clinixflow's public/checkout.html — the 3-step Prescription → Billing & Payment →
// Checkout wizard that closes out a visit. Same drawer/SystemForms pattern as Front Desk.
import { computed, ref } from 'vue';
import Cubo from '../components/Cubo.vue';
import LhcFormHost from '../components/LhcFormHost.vue';
import {
  activeQuestionnaire, activeVersionNumber,
  saveDataRecord, getAnswer, getGroupInstances,
} from '../data/useSystemForms.js';
import { useClinicalStore } from '../stores/clinical.js';

const clinical = useClinicalStore();
// Prescription/Billing live inside the same merged Encounter-composition record Front Desk and
// Consultation Desk edit — this page opens/saves that one record too, rather than two
// separately-keyed forms.
const ENCOUNTER_FORM_ID = clinical.ENCOUNTER_FORM_ID;

const screen = ref('steps'); // 'steps' | 'done'
const currentStep = ref(0);
const steps = [
  { id: 'prescription', label: 'Prescription' },
  { id: 'billing', label: 'Billing & Payment' },
  { id: 'checkout', label: 'Checkout' },
];

const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3200);
}

const drawerOpen = ref(false);
const activeStepId = ref(null);
const dataVersion = ref(0);
const lhcFormHost = ref(null);
const drawerQuestionnaire = ref(null);
const drawerRecord = ref(null);
const formKey = ref(0);

const encounterId = computed(() => clinical.activeEncounterId);

const activeStepLabel = computed(() => ({ prescription: 'Add Medication', billing: 'Billing & Payment' }[activeStepId.value] || ''));

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

// Prescription/Billing both open the SAME merged Encounter-composition document — same
// accepted tradeoff as Front Desk (whole document everywhere, not a page-scoped slice).
function openStep(stepId) {
  activeStepId.value = stepId;
  drawerOpen.value = true;
  drawerQuestionnaire.value = activeQuestionnaire(ENCOUNTER_FORM_ID);
  const existing = encounterId.value ? clinical.getEncounter() : null;
  drawerRecord.value = existing || buildSeed(ENCOUNTER_FORM_ID, 'encounter_patient_ref', '');
}

function closeDrawer() {
  drawerOpen.value = false;
}

function saveDrawer() {
  const qr = lhcFormHost.value?.extract();
  if (!qr) { showToast('Could not read the entered data.'); return; }

  saveDataRecord(ENCOUNTER_FORM_ID, activeVersionNumber(ENCOUNTER_FORM_ID), qr, encounterId.value);
  dataVersion.value++;

  if (activeStepId.value === 'prescription') {
    // Stay open — LForms' own "+ Add another" control inside section_prescription is how
    // multiple medications get added now, not a separate save-per-medication action.
    drawerRecord.value = clinical.getEncounter();
    formKey.value++;
    showToast('Prescription saved.');
    return;
  }
  if (activeStepId.value === 'billing') {
    closeDrawer();
    showToast('Billing saved.');
  }
}

// One instance per medication added — LForms' own repeating-group "+ Add another"/remove
// controls (inside the drawer form itself) are what add/remove medications now, not app code.
const prescriptionRecords = computed(() => {
  dataVersion.value;
  return getGroupInstances(clinical.getEncounter(), 'section_prescription');
});

const billingTotal = computed(() => {
  dataVersion.value;
  return getAnswer(clinical.getEncounter(), 'billing_total');
});

function closeEncounter() {
  const encounter = clinical.getEncounter();
  if (!encounter) { showToast('No active encounter to close.'); return; }
  const qr = encounter.data;
  const item = qr.item[0].item.find((i) => i.linkId === 'encounter_status');
  if (item) item.answer = [{ valueCoding: { display: 'finished' } }];
  else qr.item[0].item.push({ linkId: 'encounter_status', answer: [{ valueCoding: { display: 'finished' } }] });
  saveDataRecord(ENCOUNTER_FORM_ID, encounter.version, qr, encounter.id);
  clinical.clearActive();
  screen.value = 'done';
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i><span>{{ toast.msg }}</span></div>

  <div class="drawer-backdrop" :class="drawerOpen ? 'open' : ''" @click="closeDrawer()"></div>
  <div class="drawer-panel" :class="drawerOpen ? 'open' : ''">
    <div class="drawer-header">
      <h3 style="font-size:.95rem;font-weight:700;color:var(--cf-text-strong)">{{ activeStepLabel }}</h3>
      <button @click="closeDrawer()" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <div class="preview-panel"><LhcFormHost v-if="drawerOpen" :key="formKey" ref="lhcFormHost" :questionnaire="drawerQuestionnaire" :record="drawerRecord" container-id="drawerFormContainer" /></div>
    </div>
    <div class="drawer-footer">
      <button class="btn-teal" @click="saveDrawer()" style="display:flex;align-items:center;gap:.4rem">
        <i class="fas" :class="activeStepId === 'prescription' ? 'fa-plus' : 'fa-save'"></i>
        <span>{{ activeStepId === 'prescription' ? 'Add' : 'Save' }}</span>
      </button>
    </div>
  </div>

  <main class="flex-1 overflow-y-auto">
    <div class="journey-layout max-w-[1300px] mx-auto px-6 py-8 pb-16 flex gap-8">
      <div class="flex-1 min-w-0">

        <div v-show="!encounterId" class="cf-card" style="border-radius:1rem;padding:2rem;text-align:center">
          <i class="fas fa-user-clock" style="font-size:2rem;color:var(--cf-border);display:block;margin-bottom:.75rem"></i>
          <p style="font-weight:700;color:var(--cf-text-strong);margin-bottom:.3rem">No active encounter</p>
          <p style="font-size:.85rem;color:var(--cf-text);margin-bottom:1rem">Start a visit at the Front Desk before checking out.</p>
          <RouterLink to="/front-desk" class="btn-primary">Go to Front Desk</RouterLink>
        </div>

        <div v-if="encounterId && screen === 'steps'">
          <div v-show="currentStep === 0">
            <span class="section-eyebrow block mb-1">Step 1 of 3</span>
            <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Prescription</h2>
            <div class="cf-card rounded-2xl p-5">
              <p class="text-sm mb-4" style="color:var(--cf-text)">Add one or more medications for this visit.</p>
              <button class="btn-teal" @click="openStep('prescription')"><i class="fas fa-pills"></i> Add Medication</button>
              <p class="text-sm mt-3" style="color:var(--cf-text)">{{ prescriptionRecords.length }} medication(s) added</p>
              <button class="btn-teal mt-4" @click="currentStep = 1">Continue to Billing <i class="fas fa-arrow-right ml-2"></i></button>
            </div>
          </div>

          <div v-show="currentStep === 1">
            <span class="section-eyebrow block mb-1">Step 2 of 3</span>
            <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Billing & Payment</h2>
            <div class="cf-card rounded-2xl p-5">
              <p class="text-sm mb-4" style="color:var(--cf-text)">Enter the visit total and payment method.</p>
              <button class="btn-teal" @click="openStep('billing')"><i class="fas fa-receipt"></i> Open Billing Form</button>
              <div v-show="billingTotal" class="mt-4">
                <span class="badge badge-teal"><i class="fas fa-check mr-1"></i>Billing Saved</span>
                <button class="btn-teal block mt-4" @click="currentStep = 2">Continue to Checkout <i class="fas fa-arrow-right ml-2"></i></button>
              </div>
            </div>
          </div>

          <div v-show="currentStep === 2">
            <span class="section-eyebrow block mb-1">Step 3 of 3</span>
            <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Checkout</h2>
            <div class="cf-card rounded-2xl p-5">
              <div class="flex flex-col gap-2 mb-5">
                <div class="flex justify-between text-sm"><span style="color:var(--cf-text)">Medications</span><span class="font-bold" style="color:var(--cf-text-strong)">{{ prescriptionRecords.length }}</span></div>
                <div class="flex justify-between text-sm"><span style="color:var(--cf-text)">Billing Total</span><span class="font-bold" style="color:var(--cf-text-strong)">{{ billingTotal || '—' }}</span></div>
              </div>
              <button class="btn-primary" @click="closeEncounter()"><i class="fas fa-flag-checkered"></i> Close Encounter & Checkout</button>
            </div>
          </div>
        </div>

        <div v-show="screen === 'done'" style="text-align:center;padding:3rem 1rem">
          <div class="completion-ring"><i class="fas fa-check" style="color:var(--color-primary);font-size:2.5rem"></i></div>
          <h2 style="font-size:1.75rem;font-weight:800;color:var(--cf-text-strong);margin-bottom:.625rem">Visit Complete</h2>
          <p style="color:var(--cf-text);font-size:.95rem;margin-bottom:2rem">The encounter has been closed and logged.</p>
          <RouterLink to="/front-desk" class="btn-teal inline-flex items-center gap-2"><i class="fas fa-plus"></i>Start Next Patient</RouterLink>
        </div>
      </div>

      <aside class="journey-rail" v-show="encounterId && screen === 'steps'">
        <div v-for="(s, idx) in steps" :key="s.id" class="rail-step" :class="idx === currentStep ? 'active' : ''" @click="currentStep = idx">
          <div class="step-dot" :class="idx < currentStep ? 'done' : idx === currentStep ? 'active' : 'pending'">
            <i v-if="idx < currentStep" class="fas fa-check text-xs"></i>
            <span v-else>{{ idx + 1 }}</span>
          </div>
          <span class="rail-step-label">{{ s.label }}</span>
        </div>
      </aside>
    </div>
  </main>

  <Cubo category="billing" page-context="Checkout — prescription, billing, payment and visit close-out." />
</template>

<style>
.journey-layout { display:flex;gap:2rem;align-items:flex-start; }
.journey-rail { width:210px;flex-shrink:0;display:flex;flex-direction:column;gap:.5rem;position:sticky;top:80px;align-self:flex-start; }
@media (max-width: 860px) {
  .journey-layout { flex-direction: column; }
  .journey-rail { width:100%;flex-direction:row;overflow-x:auto;position:static;gap:.5rem; }
  .rail-step { flex-shrink:0; }
}
.rail-step { display:flex;align-items:center;gap:.75rem;padding:.75rem;border-radius:.75rem;cursor:pointer;transition:all .15s;border:1px solid transparent; }
.rail-step:hover { background:var(--cf-bg-alt); }
.rail-step.active { background:var(--cf-bg-alt);border-color:var(--color-primary); }
.step-dot { width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-family:'Poppins',sans-serif;font-weight:700;font-size:.8rem;transition:all .25s;border:2px solid var(--cf-border); }
.step-dot.active { background:var(--color-secondary);color:#fff;border-color:var(--color-secondary); }
.dark .step-dot.active { background:var(--color-primary);color:var(--color-secondary);border-color:var(--color-primary); }
.step-dot.done { background:var(--color-primary);color:var(--color-secondary);border-color:var(--color-primary); }
.step-dot.pending { background:var(--cf-bg-alt);color:var(--cf-text); }
.rail-step-label { font-size:.82rem;font-weight:600;color:var(--cf-text-strong);font-family:'Poppins',sans-serif; }
.completion-ring { width:100px;height:100px;border-radius:50%;background:rgba(0,212,178,.12);border:3px solid var(--color-primary);display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem; }
</style>
