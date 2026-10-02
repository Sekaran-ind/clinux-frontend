<script setup>
// Registries — the workspace's ABDM registry journeys, run as Cübo conversations on the same
// LangGraph journeys and gateway APIs as clinux-cubo (HPR, HFR) and cubo-diary (ABHA). See
// src/journeys/index.js. /registries lists them with what this account has registered so far;
// /registries/:journey runs one (the sidebar links straight to each). No role filtering: every
// account sees all three.
//
// ?patient=<recordId> on /registries/abha starts the ABHA journey for that patient (PatientHome's
// "Set up ABHA" button), skipping the "whose ABHA" question.
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { JOURNEYS, journeyById, accountRecords } from '../journeys/index.js';
import { HPR_RECORD } from '../journeys/hprJourney.js';
import { HFR_RECORD } from '../journeys/hfrJourney.js';
import JourneyThread from '../journeys/ui/JourneyThread.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const account = computed(() => auth.currentUser);
const journey = computed(() => journeyById(route.params.journey));
const input = computed(() => (route.query.patient ? { patientId: String(route.query.patient) } : {}));

// What each registry already holds for this account (re-read whenever the overview is shown).
const saved = ref({ hpr: null, hfr: null, journal: [] });
async function loadSaved() {
  if (!account.value?.id) return;
  const r = accountRecords(account.value.id);
  saved.value = { hpr: await r.get(HPR_RECORD), hfr: await r.get(HFR_RECORD), journal: ((await r.get('journal')) || []).slice(-8).reverse() };
}
watch(() => route.params.journey, (j) => { if (!j) loadSaved(); }, { immediate: true });

const STATUS = computed(() => ({
  hpr: saved.value.hpr ? { done: true, text: `Linked: ${saved.value.hpr.hprId}` } : { done: false, text: 'Not linked yet' },
  hfr: saved.value.hfr?.facilityId
    ? { done: true, text: `Facility ID ${saved.value.hfr.facilityId}${saved.value.hfr.status ? ` · ${saved.value.hfr.status}` : ''}` }
    : saved.value.hfr?.trackingId ? { done: false, text: `Draft saved (tracking ${saved.value.hfr.trackingId}); not submitted` } : { done: false, text: 'Not registered yet' },
  abha: { done: null, text: 'For any patient, any time' },
}));

const when = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <div class="page">
    <template v-if="journey">
      <nav class="page-crumbs"><RouterLink to="/registries">Registries</RouterLink><i class="fas fa-chevron-right" style="font-size:.55rem"></i><span>{{ journey.title }}</span></nav>
      <div class="page-header">
        <div>
          <h1 class="page-title">{{ journey.title }}</h1>
          <p class="page-subtitle">{{ journey.summary }}. Cübo asks one step at a time; each answer goes to ABDM through ClinuxFlow’s gateway.</p>
        </div>
        <div class="page-actions">
          <button class="ui-btn" @click="router.push('/registries')"><i class="fas fa-arrow-left"></i> All registries</button>
        </div>
      </div>
      <!-- keyed so switching journeys (or patients) starts a fresh run -->
      <JourneyThread v-if="account" :key="route.fullPath" :account="account" :journey="journey" :input="input" />
    </template>

    <template v-else>
      <div class="page-header">
        <div>
          <h1 class="page-title">Registries</h1>
          <p class="page-subtitle">Register with ABDM’s registries: your Healthcare Professional ID (HPR), your facility (HFR), and your patients’ Ayushman Bharat Health Accounts (ABHA).</p>
        </div>
      </div>

      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
        <RouterLink v-for="j in JOURNEYS" :key="j.id" :to="`/registries/${j.id}`" class="stat-card registry-card">
          <div class="stat-card-head"><span>{{ { hpr: 'HPR', hfr: 'HFR', abha: 'ABHA' }[j.id] }}</span><i class="fas" :class="j.icon"></i></div>
          <div class="registry-title">{{ j.title }}</div>
          <div class="stat-card-hint">{{ j.summary }}</div>
          <div class="registry-status" :class="{ done: STATUS[j.id].done === true }">
            <i class="fas" :class="STATUS[j.id].done === true ? 'fa-circle-check' : STATUS[j.id].done === false ? 'fa-circle' : 'fa-users'"></i>
            {{ STATUS[j.id].text }}
          </div>
        </RouterLink>
      </div>

      <section class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">Recent registry activity</div>
            <div class="panel-sub">What the journeys completed on this device</div>
          </div>
        </div>
        <div v-if="!saved.journal.length" class="empty-state">
          <div class="empty-state-icon"><i class="fas fa-clock-rotate-left"></i></div>
          <div class="empty-state-title">Nothing yet</div>
          <p class="empty-state-text">Linking an HPR ID, submitting a facility to HFR or recording a patient’s ABHA shows up here.</p>
        </div>
        <div v-for="e in saved.journal" :key="e.id" class="panel-row">
          <div style="min-width:0">
            <div style="font-weight:600">{{ e.title }}</div>
            <div class="panel-row-muted">{{ (e.facts || []).map(([k, v]) => `${k}: ${v}`).join(' · ') }}</div>
          </div>
          <span class="panel-row-muted" style="flex-shrink:0">{{ when(e.at) }}</span>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.registry-card { text-decoration: none; display: flex; flex-direction: column; gap: .2rem; transition: border-color .12s; }
.registry-card:hover { border-color: var(--color-primary); }
.registry-title { font-size: 1rem; font-weight: 700; color: var(--shell-text-strong); margin-top: .35rem; }
.registry-status { margin-top: .6rem; font-size: .76rem; color: var(--shell-text-muted); display: flex; align-items: center; gap: .4rem; }
.registry-status.done { color: #15803d; }
</style>
