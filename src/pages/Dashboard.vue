<script setup>
// The signed-in landing page, laid out like the Swastik ABDM Connector's console dashboard:
// welcome header with primary actions, a plan banner, a row of stat cards, then a two-column
// body — what's happening now (visits in progress, the organisation graph) on the left and the
// "Getting set up" checklist on the right. Everything shown is real local data; nothing here is
// a placeholder metric.
//
// The organisation graph is the old Onboarding.vue "Review & Publish" content, kept from this
// page's previous version: POST /api/workflow/extract (ComprehensiveLocalExtractor) on the
// Provider record, showing the actual extracted FHIR resources (Organization, Locations,
// HealthcareServices, Practitioners, ...), not the raw form-shaped QuestionnaireResponse.
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import { useClinicalStore } from '../stores/clinical.js';
import { useClinicViewStore } from '../stores/clinicView.js';
import { activeQuestionnaire, getGroupInstances } from '../data/useSystemForms.js';
import { API_BASE, apiFetch } from '../config.js';
import { buildSetupChecklist } from './dashboardChecklist.js';

const onboarding = useOnboardingStore();
const auth = useAuthStore();
const clinical = useClinicalStore();
const clinicView = useClinicViewStore();
const router = useRouter();

const user = computed(() => auth.currentUser || {});
const firstName = computed(() => (user.value.adminName || '').split(/\s+/)[0] || '');
const isPaid = computed(() => user.value.tier === 'paid');

const sectionCounts = computed(() => {
  onboarding.dataVersion; // reactive dependency, same convention every other count in this app uses
  const record = onboarding.getProviderRecord();
  const count = (id) => getGroupInstances(record, id).length;
  return {
    branches: count('section_location'),
    staff: count('section_staff'),
    services: count('section_services_matrix'),
    hours: count('section_hours'),
    consents: count('section_consent'),
    partners: count('section_affiliate_organization'),
  };
});

const activeSessions = computed(() => clinical.listActiveSessions());

const stats = computed(() => [
  { label: 'Visits in progress', icon: 'fa-wave-square', value: activeSessions.value.length, hint: activeSessions.value.filter((s) => s.priority === 'Emergency').length + ' emergency' },
  { label: 'Care team', icon: 'fa-user-doctor', value: sectionCounts.value.staff, hint: sectionCounts.value.branches + ' branch' + (sectionCounts.value.branches === 1 ? '' : 'es') },
  { label: 'Services', icon: 'fa-stethoscope', value: sectionCounts.value.services, hint: sectionCounts.value.hours ? 'Office hours set' : 'No office hours yet' },
  { label: 'Consents', icon: 'fa-file-signature', value: sectionCounts.value.consents, hint: sectionCounts.value.partners + ' partner organisation' + (sectionCounts.value.partners === 1 ? '' : 's') },
]);

const checklist = computed(() => buildSetupChecklist({ stage: onboarding.facilitySetupStage, counts: sectionCounts.value }));

function openSection(section) {
  router.push({ path: '/onboarding', query: { section } });
}

function openClinicView(view) {
  clinicView.arriveAt(view);
  router.push('/clinic-home');
}

function resumeSession(session) {
  clinical.setActive(session.id);
  openClinicView(clinical.getLastVisitedPage(session.id) || 'front-desk');
}

function sessionRef(id) {
  return id.slice(-4).toUpperCase();
}

function timeSince(savedAt) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(savedAt).getTime()) / 60000));
  if (mins < 60) return mins + 'm ago';
  if (mins < 60 * 24) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / (60 * 24)) + 'd ago';
}

const graphLoading = ref(false);
const graphError = ref('');
const resources = ref(null); // FHIR resource[] | null
const graphOpen = ref(false);

async function loadGraph() {
  const questionnaireJson = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  const responseJson = onboarding.getProviderRecord()?.data;
  if (!questionnaireJson || !responseJson) { graphError.value = 'Save your facility details first.'; return; }
  graphLoading.value = true;
  graphError.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/api/workflow/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionnaireJson, responseJson }),
    }).then((r) => r.json());
    if (!res.success) { graphError.value = res.error || 'Could not load the organisation graph.'; return; }
    resources.value = res.resources;
  } catch (e) {
    graphError.value = 'Could not reach clinuxflow-api — ' + e.message;
  } finally {
    graphLoading.value = false;
  }
}
onMounted(loadGraph);

// A per-type breakdown above the raw JSON — the resource TYPES present, at a glance, before
// scrolling a (potentially long) JSON blob to find them.
const resourceTypeCounts = computed(() => {
  if (!resources.value) return [];
  const counts = new Map();
  resources.value.forEach((r) => counts.set(r.resourceType, (counts.get(r.resourceType) || 0) + 1));
  return [...counts.entries()].map(([type, count]) => ({ type, count }));
});

const graphJson = computed(() => (resources.value ? JSON.stringify(resources.value, null, 2) : ''));
const copied = ref(false);
function copyGraphJson() {
  navigator.clipboard.writeText(graphJson.value).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  });
}
</script>

<template>
  <div class="page page-wide">
    <div class="page-header">
      <div>
        <h1 class="page-title">Welcome back{{ firstName ? ', ' + firstName : '' }}</h1>
        <p class="page-subtitle">
          {{ user.clinicName || 'Your clinic' }} · {{ onboarding.facilitySetupStageLabel || 'Getting started' }}
        </p>
      </div>
      <div class="page-actions">
        <RouterLink to="/patient-home" class="ui-btn">Patients</RouterLink>
        <button class="ui-btn ui-btn-primary" @click="openClinicView('front-desk')"><i class="fas fa-plus"></i> New visit</button>
      </div>
    </div>

    <div class="ui-banner">
      <div class="ui-banner-icon"><i class="fas" :class="isPaid ? 'fa-cloud' : 'fa-house-laptop'"></i></div>
      <div style="flex:1;min-width:0">
        <div class="ui-banner-title">{{ isPaid ? 'Cloud plan' : 'Free plan: local-first' }}</div>
        <div class="ui-banner-text">
          <template v-if="isPaid">Encounters sync to the cloud, patient search works across devices, and AI SOAP drafting is on.</template>
          <template v-else>Clinical data stays on this device, or on your clinic's network in Live Server mode. The cloud plan adds sync across devices, cross-device patient search and AI SOAP drafting.</template>
        </div>
      </div>
    </div>

    <div class="stat-grid">
      <div v-for="s in stats" :key="s.label" class="stat-card">
        <div class="stat-card-head"><span>{{ s.label }}</span><i class="fas" :class="s.icon"></i></div>
        <div class="stat-card-value">{{ s.value }}</div>
        <div class="stat-card-hint">{{ s.hint }}</div>
      </div>
    </div>

    <div class="dash-grid">
      <div>
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">Visits in progress</div>
              <div class="panel-sub">Open encounters, from check-in until checkout</div>
            </div>
            <button class="ui-link" @click="openClinicView('front-desk')">Front Desk</button>
          </div>
          <div v-if="activeSessions.length === 0" class="empty-state">
            <div class="empty-state-icon"><i class="fas fa-clipboard-user"></i></div>
            <div class="empty-state-title">No visits in progress</div>
            <p class="empty-state-text">A visit starts at Front Desk when a patient checks in, and stays here until checkout.</p>
            <div class="empty-state-actions">
              <button class="ui-btn ui-btn-primary" @click="openClinicView('front-desk')">Start a visit</button>
            </div>
          </div>
          <div v-else>
            <div v-for="s in activeSessions" :key="s.id" class="panel-row">
              <div style="display:flex;align-items:center;gap:.75rem;min-width:0">
                <span class="app-nav-badge" style="margin:0">#{{ sessionRef(s.id) }}</span>
                <span style="font-weight:600">{{ s.status || 'Open' }}</span>
                <span v-if="s.priority === 'Emergency'" class="badge" style="background:#fee2e2;color:#b91c1c">Emergency</span>
              </div>
              <div style="display:flex;align-items:center;gap:1rem;flex-shrink:0">
                <span class="panel-row-muted">{{ timeSince(s.savedAt) }}</span>
                <button class="ui-btn" style="padding:.3rem .65rem" @click="resumeSession(s)">Resume</button>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">Organisation graph</div>
              <div class="panel-sub">The FHIR resources extracted from your profile: Organization, Locations, staff, services and more, exactly as they'd be stored.</div>
            </div>
            <div style="display:flex;gap:.5rem;flex-shrink:0">
              <button class="ui-btn" style="padding:.3rem .65rem" :disabled="graphLoading" @click="loadGraph()">
                <i class="fas" :class="graphLoading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> Refresh
              </button>
              <button v-if="resources" class="ui-btn" style="padding:.3rem .65rem" @click="copyGraphJson()">
                <i class="fas" :class="copied ? 'fa-check' : 'fa-copy'"></i> {{ copied ? 'Copied' : 'Copy JSON' }}
              </button>
            </div>
          </div>
          <div class="panel-body">
            <p v-if="graphError" style="font-size:.8rem;color:#b91c1c">{{ graphError }}</p>
            <p v-else-if="graphLoading && !resources" class="panel-row-muted">Loading…</p>
            <template v-else-if="resources">
              <div style="display:flex;flex-wrap:wrap;gap:.4rem">
                <span v-for="rt in resourceTypeCounts" :key="rt.type" class="tag-chip">{{ rt.type }} ({{ rt.count }})</span>
              </div>
              <button class="ui-link" style="margin-top:.75rem" @click="graphOpen = !graphOpen">{{ graphOpen ? 'Hide JSON' : 'View JSON' }}</button>
              <pre v-if="graphOpen" style="margin-top:.75rem;font-family:'JetBrains Mono',monospace;font-size:.72rem;color:var(--shell-text-strong);background:var(--shell-bg);border:1px solid var(--shell-border);border-radius:.5rem;padding:1rem;overflow-x:auto;max-height:440px;white-space:pre-wrap">{{ graphJson }}</pre>
            </template>
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">Getting set up</div>
            <div class="panel-sub">{{ checklist.doneCount }} of {{ checklist.total }} steps done</div>
          </div>
        </div>
        <div v-for="step in checklist.steps" :key="step.key" class="checklist-item" :class="{ done: step.done }">
          <div class="checklist-dot"><i v-if="step.done" class="fas fa-check"></i></div>
          <div style="min-width:0">
            <div class="checklist-title">{{ step.title }}</div>
            <template v-if="!step.done">
              <p class="checklist-text">{{ step.text }}</p>
              <button v-if="step.section" class="ui-link" @click="openSection(step.section)">Set it up →</button>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
