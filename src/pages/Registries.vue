<script setup>
// Registries — the workspace's ABDM registry journeys, run on the same journey JSON and gateway
// APIs as clinux-cubo (HPR, HFR) and cubo-diary (ABHA). See src/journeys/index.js. /registries
// lists them with what this account has registered so far; /registries/:journey runs one (the
// sidebar links straight to each). No role filtering: every account sees all three.
//
// A running journey is loaded inside Cübo: its thread holds the conversation (journeys/sessions.js
// writes it) and its content pane the current step (ui/JourneyPanel.vue). Cübo lays the two out
// itself — side by side when there's room, otherwise behind its Chat / Form switch.
//
// Each registry card says what that registry holds for this account (saved on this device by the
// journey: a linked HPR ID, an HFR draft or facility id) and, when one is going, where the journey's
// run is; Resume / Open thread go back to it on its Cübo thread. Every activity-log entry links back
// the same way. Resume = /registries/:journey, which carries on with a run still going, or starts
// one (an HFR draft then offers "Continue the draft"). Deleting a journey's Cübo thread ends its
// run; what was saved with ABDM (and its record here) stays.
//
// ?patient=<recordId> on /registries/abha starts the ABHA journey for that patient (PatientHome's
// "Set up ABHA" button), skipping the "whose ABHA" question.
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { JOURNEYS, journeyById, accountRecords } from '../journeys/index.js';
import { HPR_RECORD } from '../journeys/hprJourney.js';
import { loadFacilities, forgetDraft as forgetFacilityDraft, isSubmitted, facilityLine } from '../journeys/hfrFacilities.js';
import { useJourneySessionsStore } from '../journeys/sessions.js';
import { useCuboStore } from '../stores/cubo.js';
import { useLiveQuery } from '@tanstack/vue-db';
import { chatThreads } from '../data/collections/chatThreads.js';
import { threadIdFor } from '../journeys/sessions.js';
import { revalidatePending } from '../journeys/revalidate.js';
import Cubo from '../components/Cubo.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const account = computed(() => auth.currentUser);
const journey = computed(() => journeyById(route.params.journey));
const input = computed(() => (route.query.patient ? { patientId: String(route.query.patient) } : {}));

// The journey's Cübo thread: carries on with a run already going (e.g. after a visit to Cübo's
// full workspace), or starts one. Set synchronously so Cübo mounts straight onto it.
const sessions = useJourneySessionsStore();
// Cübo lives in its own pane here, so it opens expanded on the journey's log — same as Front
// Desk / Checkout / Consultation Desk do for their inline Cübo.
const cubo = useCuboStore();
if (cubo.currentLayout === 'FAB') cubo.currentLayout = 'EXPANDED';
const threadId = ref(null);
watch([() => route.params.journey, () => route.query.patient, () => account.value?.id], () => {
  threadId.value = journey.value && account.value ? sessions.open(journey.value.id, { account: account.value, input: input.value }) : null;
}, { immediate: true });

// What each registry already holds for this account (re-read whenever the overview is shown).
const saved = ref({ hpr: null, facilities: [], journal: [] });
async function loadSaved() {
  if (!account.value?.id) return;
  const r = accountRecords(account.value.id);
  saved.value = { hpr: await r.get(HPR_RECORD), facilities: await loadFacilities(r), journal: ((await r.get('journal')) || []).slice(-8).reverse() };
}
watch(() => route.params.journey, (j) => {
  if (j) return;
  loadSaved();
  revalidatePending(account.value?.id); // journey FHIR resources saved while the FHIR API was down
}, { immediate: true });

const STATUS = computed(() => ({
  hpr: saved.value.hpr ? { done: true, text: `Linked: ${saved.value.hpr.hprId}` } : { done: false, text: 'Not linked yet' },
  hfr: (() => {
    const all = saved.value.facilities;
    if (!all.length) return { done: false, text: 'Not registered yet' };
    const registered = all.filter(isSubmitted).length;
    const drafts = all.length - registered;
    return { done: registered > 0, draft: drafts > 0, text: [registered && `${registered} registered`, drafts && `${drafts} draft${drafts === 1 ? '' : 's'}`].filter(Boolean).join(' · ') };
  })(),
  abha: { done: null, text: 'For any patient, any time' },
}));

const when = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ── Where each journey's run is (in memory, ends with its Cübo thread), for its card.
const { data: threads } = useLiveQuery((q) => q.from({ t: chatThreads }));
const RUN = computed(() => Object.fromEntries(JOURNEYS.map((j) => {
  const tid = threadIdFor(j.id);
  const thread = threads.value.find((t) => t.id === tid) || null;
  const run = sessions.sessions[tid];
  const live = !!run && sessions.isLive(tid) && run.accountId === account.value?.id && !run.result;
  const now = live ? run.ledger.find((st) => st.state === 'active') : null;
  return [j.id, { threadId: tid, thread, live, text: live ? `In progress${now ? ` · now: ${now.label}` : ''}` : '' }];
})));
const resumable = (id) => RUN.value[id].live || !!STATUS.value[id].draft;

/** Forgets an HFR draft on this device (HFR keeps it; this only stops offering to continue it). */
async function forgetDraft(f) {
  if (!window.confirm(`Forget draft ${f.trackingId} (${f.facilityName}) on this device? HFR keeps the draft; you won't be offered to continue it here.`)) return;
  await forgetFacilityDraft(accountRecords(account.value.id), f.trackingId);
  loadSaved();
}

/** Back to a journey on its Cübo thread (carries on, or starts again). */
function resume(journeyId, patientId) {
  router.push({ path: `/registries/${journeyId}`, query: patientId ? { patient: patientId } : {} });
}
/** The journey's thread in Cübo's full workspace (its form in the Content tab). */
function openThread(threadId) {
  cubo.switchThread(threadId);
  router.push('/ai-engine');
}
const JOURNEY_NAMES = Object.fromEntries(JOURNEYS.map((j) => [j.id, j.title]));
</script>

<template>
  <div class="page" :class="{ 'page-wide': journey }">
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
      <div v-if="threadId" class="journey-cubo cubo-inline-host">
        <Cubo category="registry" :thread-id="threadId" :page-context="`Registries — ${journey.title}: ${journey.summary}`" />
      </div>
    </template>

    <template v-else>
      <div class="page-header">
        <div>
          <h1 class="page-title">Registries</h1>
          <p class="page-subtitle">Register with ABDM’s registries: your Healthcare Professional ID (HPR), your facility (HFR), and your patients’ Ayushman Bharat Health Accounts (ABHA).</p>
        </div>
      </div>

      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
        <div v-for="j in JOURNEYS" :key="j.id" class="stat-card registry-card" :data-testid="`registry-card-${j.id}`">
          <div class="stat-card-head"><span>{{ { hpr: 'HPR', hfr: 'HFR', abha: 'ABHA' }[j.id] }}</span><i class="fas" :class="j.icon"></i></div>
          <div class="registry-title">{{ j.title }}</div>
          <div class="stat-card-hint">{{ j.summary }}</div>
          <!-- What the registry holds for this account (the journey's record on this device). -->
          <div class="registry-status" :class="{ done: STATUS[j.id].done === true, draft: STATUS[j.id].draft }">
            <i class="fas" :class="STATUS[j.id].done === true ? 'fa-circle-check' : STATUS[j.id].draft ? 'fa-file-pen' : STATUS[j.id].done === false ? 'fa-circle' : 'fa-users'"></i>
            {{ STATUS[j.id].text }}
          </div>
          <!-- HFR: every facility, each registered separately (submitted ones are read-only). -->
          <ul v-if="j.id === 'hfr' && saved.facilities.length" class="registry-facilities" data-testid="hfr-facilities">
            <li v-for="f in saved.facilities.slice(0, 4)" :key="f.trackingId">
              <i class="fas" :class="isSubmitted(f) ? 'fa-lock' : 'fa-file-pen'" :title="isSubmitted(f) ? 'Registered — read-only' : 'Draft'"></i>
              <span>{{ facilityLine(f) }}</span>
              <button v-if="!isSubmitted(f)" class="registry-link" title="HFR keeps the draft; this device stops offering to continue it" @click="forgetDraft(f)"><i class="fas fa-xmark"></i></button>
            </li>
            <li v-if="saved.facilities.length > 4" class="panel-row-muted">and {{ saved.facilities.length - 4 }} more</li>
          </ul>
          <!-- The journey's run, while one is going (ends with its Cübo thread). -->
          <div v-if="RUN[j.id].live" class="registry-status live"><i class="fas fa-circle-play"></i>{{ RUN[j.id].text }}</div>
          <div class="registry-actions">
            <button class="ui-btn" :class="{ 'ui-btn-primary': resumable(j.id) }" style="padding:.3rem .7rem" data-testid="journey-resume" @click="resume(j.id)">
              <i class="fas" :class="resumable(j.id) ? 'fa-play' : 'fa-arrow-right'"></i> {{ resumable(j.id) ? 'Resume' : 'Open' }}
            </button>
            <button v-if="RUN[j.id].thread" class="ui-btn" style="padding:.3rem .7rem" title="This journey's conversation in Cübo's workspace" @click="openThread(RUN[j.id].threadId)"><i class="fas fa-comments"></i> Thread</button>

          </div>
        </div>
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
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.2rem;flex-shrink:0">
            <span class="panel-row-muted">{{ when(e.at) }}</span>
            <!-- Back to the journey that did this, on its Cübo thread (ABHA: for the same patient). -->
            <button v-if="JOURNEY_NAMES[e.journey]" class="jr-link" data-testid="activity-resume" @click="resume(e.journey, e.journey === 'abha' ? e.recordId : null)">
              <i class="fas fa-comments"></i> {{ JOURNEY_NAMES[e.journey] }} in Cübo
            </button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.jr-link { border: none; background: none; padding: 0; font-size: .74rem; font-weight: 600; color: var(--color-primary-text); cursor: pointer; display: inline-flex; align-items: center; gap: .3rem; }
.jr-link:hover { text-decoration: underline; }
.journey-cubo { height: calc(100dvh - var(--shell-topbar-h) - 12rem); min-height: 520px; }
.registry-card { text-decoration: none; display: flex; flex-direction: column; gap: .2rem; transition: border-color .12s; }
.registry-card:hover { border-color: var(--color-primary); }
.registry-title { font-size: 1rem; font-weight: 700; color: var(--shell-text-strong); margin-top: .35rem; }
.registry-status { margin-top: .6rem; font-size: .76rem; color: var(--shell-text-muted); display: flex; align-items: center; gap: .4rem; }
.registry-status.done { color: #15803d; }
.registry-status.draft { color: #b45309; }
.registry-status.live { color: var(--color-primary-text); margin-top: .25rem; }
.registry-facilities { list-style: none; margin: .5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; font-size: .74rem; color: var(--shell-text); }
.registry-facilities li { display: flex; align-items: center; gap: .4rem; }
.registry-facilities li i { color: var(--shell-text-muted); width: .9rem; }
.registry-facilities li span { flex: 1; min-width: 0; }
.registry-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: .85rem; }
.registry-link { border: none; background: none; padding: 0; font-size: .74rem; color: var(--shell-text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: .3rem; }
.registry-link:hover { color: #b91c1c; }
</style>
