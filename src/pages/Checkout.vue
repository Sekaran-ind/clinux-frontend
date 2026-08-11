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
import { useSlotFillHighlightsStore } from '../stores/slotFillHighlights.js';

// This used to be its own routed page reached via /checkout; now mounted directly inside
// ClinicHome.vue (see clinux-frontdesk-consultation-checkout-as-clinic-home-components memory
// note) — going back to Front Desk is an emitted event instead of a route push/RouterLink,
// since there's no longer a route to push to.
const emit = defineEmits(['navigate']);
const clinical = useClinicalStore();
const slotFillHighlights = useSlotFillHighlightsStore();
// Prescription/Billing live inside the same merged Encounter-composition record Front Desk and
// Consultation Desk edit — this page opens/saves that one record too, rather than two
// separately-keyed forms.
const ENCOUNTER_FORM_ID = clinical.ENCOUNTER_FORM_ID;

const screen = ref('sessions'); // 'sessions' | 'steps' | 'done'

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

// The shared active-sessions list — Checkout never originates a session (no Add here), it only
// picks up an existing one. dataVersion is the same reactivity trigger used elsewhere in this
// file (bumped on every saveDrawer()/closeEncounter() call).
const activeSessions = computed(() => {
  dataVersion.value;
  return clinical.listActiveSessions();
});

if (clinical.activeEncounterId) clinical.recordVisit(clinical.activeEncounterId, 'checkout');

function resumeSession(session) {
  clinical.setActive(session.id);
  clinical.recordVisit(session.id, 'checkout');
  screen.value = 'steps';
}

const activeStepLabel = computed(() => ({ prescription: 'Add Medication', billing: 'Add Payment' }[activeStepId.value] || ''));

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

  if (activeStepId.value === 'prescription' || activeStepId.value === 'billing') {
    // Stay open — LForms' own "+ Add another" control inside section_prescription/
    // section_billing (both repeating groups now) is how multiple entries get added, not a
    // separate save-per-entry action.
    drawerRecord.value = clinical.getEncounter();
    formKey.value++;
    showToast(activeStepId.value === 'prescription' ? 'Prescription saved.' : 'Payment saved.');
  }
}

// One instance per medication added — LForms' own repeating-group "+ Add another"/remove
// controls (inside the drawer form itself) are what add/remove medications now, not app code.
const prescriptionRecords = computed(() => {
  dataVersion.value;
  return getGroupInstances(clinical.getEncounter(), 'section_prescription');
});

// One instance per payment entry — section_billing is now a repeating group (was singular),
// mirroring prescriptionRecords/vitalsRecords. getGroupInstances returns bare {linkId, item}
// group instances rather than full records; getAnswer(record, linkId) only ever reads
// record.data.item, so wrapping one as { data: instance } reads it correctly with no changes
// needed to formData.js.
const billingRecords = computed(() => {
  dataVersion.value;
  return getGroupInstances(clinical.getEncounter(), 'section_billing');
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
      <div class="preview-panel">
        <LhcFormHost v-if="drawerOpen && drawerQuestionnaire" :key="formKey" ref="lhcFormHost" :questionnaire="drawerQuestionnaire" :record="drawerRecord" container-id="drawerFormContainer" :highlight-link-ids="slotFillHighlights.recentlyFilled.map((f) => f.linkId)" />
        <p v-else-if="drawerOpen" class="text-sm" style="color:var(--cf-text)">
          This form isn't available yet — clinuxflow-api may not be reachable to seed it.
          Confirm it's running, then reopen this drawer.
        </p>
      </div>
    </div>
    <div class="drawer-footer">
      <button class="btn-teal" @click="saveDrawer()" style="display:flex;align-items:center;gap:.4rem">
        <i class="fas fa-plus"></i>
        <span>Add</span>
      </button>
    </div>
  </div>

  <div class="flex-1 flex overflow-hidden">
    <!-- LEFT: Cübo, same confined-pane pattern as Front Desk/Consultation Desk. Stays mounted
         across every screen (sessions/steps/done), not just while a session is open. -->
    <div class="w-[380px] shrink-0 flex flex-col border-r" style="border-color:var(--cf-border)">
      <div class="cubo-inline-host flex-1" style="min-height:420px">
        <Cubo category="billing" :encounter-id="encounterId" page-context="Checkout — prescription, billing, payment and visit close-out." />
      </div>
    </div>

    <!-- RIGHT: sessions list, or this session's own view once one's picked -->
    <main class="flex-1 overflow-y-auto p-6">
      <div class="max-w-[900px]">

        <div v-if="screen === 'sessions'">
          <h2 class="text-2xl font-bold mb-4" style="color:var(--cf-text-strong)">Active Sessions</h2>
          <div v-if="activeSessions.length === 0" class="cf-card" style="border-radius:1rem;padding:2rem;text-align:center">
            <i class="fas fa-user-clock" style="font-size:2rem;color:var(--cf-border);display:block;margin-bottom:.75rem"></i>
            <p style="font-weight:700;color:var(--cf-text-strong);margin-bottom:.3rem">No active encounter</p>
            <p style="font-size:.85rem;color:var(--cf-text);margin-bottom:1rem">Start a visit at the Front Desk before checking out.</p>
            <button class="btn-primary" @click="emit('navigate', 'front-desk')">Go to Front Desk</button>
          </div>
          <div v-else class="flex flex-col gap-2">
            <div v-for="s in activeSessions" :key="s.id" class="record-card flex items-center justify-between p-3 cursor-pointer" @click="resumeSession(s)">
              <div>
                <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ s.patientRef || 'Unknown patient' }}</span>
                <span class="text-xs ml-2" style="color:var(--cf-text)">{{ s.chiefComplaint }}</span>
                <div class="text-xs mt-0.5"><span class="badge badge-teal">{{ s.status }}</span></div>
              </div>
              <button class="btn-outline text-xs px-3 py-1.5" @click.stop="resumeSession(s)">Checkout</button>
            </div>
          </div>
        </div>

        <div v-if="screen === 'steps'">
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-2xl font-bold" style="color:var(--cf-text-strong)">Checkout</h2>
            <button class="btn-primary" @click="closeEncounter()"><i class="fas fa-flag-checkered"></i> Close Encounter & Checkout</button>
          </div>

          <div class="cf-card rounded-2xl p-5 mb-5">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-bold" style="color:var(--cf-text-strong)">Prescriptions</h3>
              <button class="btn-teal text-xs px-3 py-1.5" @click="openStep('prescription')"><i class="fas fa-pills"></i> Add Medication</button>
            </div>
            <p v-if="prescriptionRecords.length === 0" class="text-sm" style="color:var(--cf-text)">No medications added yet.</p>
            <p v-else class="text-sm" style="color:var(--cf-text)">{{ prescriptionRecords.length }} medication(s) added</p>
          </div>

          <div class="cf-card rounded-2xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-bold" style="color:var(--cf-text-strong)">Payments</h3>
              <button class="btn-teal text-xs px-3 py-1.5" @click="openStep('billing')"><i class="fas fa-receipt"></i> Add Payment</button>
            </div>
            <p v-if="billingRecords.length === 0" class="text-sm" style="color:var(--cf-text)">No payments recorded yet.</p>
            <div v-else class="flex flex-col gap-2">
              <div v-for="(b, idx) in billingRecords" :key="idx" class="record-card flex items-center justify-between p-3">
                <div>
                  <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ getAnswer({ data: b }, 'billing_total') || '—' }}</span>
                  <span class="badge badge-teal ml-2">{{ getAnswer({ data: b }, 'billing_status') }}</span>
                </div>
                <span class="text-xs" style="color:var(--cf-text)">{{ getAnswer({ data: b }, 'billing_payment_method') }}</span>
              </div>
            </div>
          </div>
        </div>

        <div v-show="screen === 'done'" style="text-align:center;padding:3rem 1rem">
          <div class="completion-ring"><i class="fas fa-check" style="color:var(--color-primary);font-size:2.5rem"></i></div>
          <h2 style="font-size:1.75rem;font-weight:800;color:var(--cf-text-strong);margin-bottom:.625rem">Visit Complete</h2>
          <p style="color:var(--cf-text);font-size:.95rem;margin-bottom:2rem">The encounter has been closed and logged.</p>
          <button class="btn-teal inline-flex items-center gap-2" @click="emit('navigate', 'front-desk')"><i class="fas fa-plus"></i>Start Next Patient</button>
        </div>
      </div>
    </main>
  </div>
</template>

<style>
.completion-ring { width:100px;height:100px;border-radius:50%;background:rgba(0,212,178,.12);border:3px solid var(--color-primary);display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem; }
</style>
