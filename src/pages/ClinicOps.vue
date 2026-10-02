<script setup>
// Clinic operations — Front Desk, Consultation and Checkout as journeys (src/journeys/clinic/),
// built like Registries: /clinic lists the journeys and the clinic's visits; /clinic/:journey runs
// one journey for one visit (?encounter=<id>) inside Cübo, on that visit's own thread
// (journey-<id>--<encounterId>). Without a visit, the page lists the ones to pick from (Front Desk
// can also start a new check-in, whose encounter id is chosen here up front).
//
// A closed visit is complete: every journey opens it read-only.
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useClinicalStore } from '../stores/clinical.js';
import { useCuboStore } from '../stores/cubo.js';
import { CLINIC_JOURNEYS, journeyById } from '../journeys/index.js';
import { useJourneySessionsStore } from '../journeys/sessions.js';
import { newEncounterId } from '../journeys/clinic/clinicDeps.js';
import Cubo from '../components/Cubo.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const clinical = useClinicalStore();
const sessions = useJourneySessionsStore();
const cubo = useCuboStore();
if (cubo.currentLayout === 'FAB') cubo.currentLayout = 'EXPANDED';

const account = computed(() => auth.currentUser);
const journey = computed(() => (route.params.journey ? journeyById(route.params.journey) : null));
const encounterId = computed(() => (route.query.encounter ? String(route.query.encounter) : null));

const STAGES = [
  { key: 'onboarding', label: 'Check-in', journey: 'front-desk' },
  { key: 'consultation', label: 'Consultation', journey: 'consultation' },
  { key: 'checkout', label: 'Checkout', journey: 'checkout' },
];
const CLOSED = ['finished', 'cancelled'];
const visits = computed(() => clinical.listAllSessions().map((v) => {
  const closed = CLOSED.includes(String(v.status || '').toLowerCase());
  const next = closed ? null : STAGES.find((st) => !v.stages?.[st.key]) || STAGES[2];
  return { ...v, closed, next };
}));
const openVisits = computed(() => visits.value.filter((v) => !v.closed));
const atStage = (journeyId) => openVisits.value.filter((v) => v.next?.journey === journeyId).length;

// A visit run inside Cübo: its own thread, titled with the patient.
const threadId = ref(null);
watch([journey, encounterId, () => account.value?.id], () => {
  if (!journey.value || !encounterId.value || !account.value) { threadId.value = null; return; }
  const v = visits.value.find((x) => x.id === encounterId.value);
  threadId.value = sessions.open(journey.value.id, {
    account: account.value,
    input: { encounterId: encounterId.value },
    key: encounterId.value,
    title: `${journey.value.title} · ${v?.patientRef || 'New check-in'}`,
  });
}, { immediate: true });

function openVisit(journeyId, id) {
  router.push({ path: `/clinic/${journeyId}`, query: { encounter: id } });
}
function newCheckIn() {
  openVisit('front-desk', newEncounterId());
}
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const priorityTone = (p) => ({ emergency: 'bad', urgent: 'warn' }[String(p || '').toLowerCase()] || '');
</script>

<template>
  <div class="page" :class="{ 'page-wide': journey && encounterId }">
    <!-- One journey for one visit, inside Cübo -->
    <template v-if="journey && encounterId">
      <nav class="page-crumbs"><RouterLink to="/clinic">Clinic operations</RouterLink><i class="fas fa-chevron-right" style="font-size:.55rem"></i><span>{{ journey.title }}</span></nav>
      <div class="page-header">
        <div>
          <h1 class="page-title">{{ journey.title }}</h1>
          <p class="page-subtitle">{{ journey.summary }}. Cübo keeps this visit’s conversation in its own thread; the current step is in the form.</p>
        </div>
        <div class="page-actions">
          <button class="ui-btn" @click="router.push('/clinic')"><i class="fas fa-arrow-left"></i> All visits</button>
        </div>
      </div>
      <div v-if="threadId" class="journey-cubo cubo-inline-host">
        <Cubo category="encounter" :thread-id="threadId" :page-context="`Clinic operations — ${journey.title}`" />
      </div>
    </template>

    <!-- Overview, or a journey's visit picker -->
    <template v-else>
      <nav v-if="journey" class="page-crumbs"><RouterLink to="/clinic">Clinic operations</RouterLink><i class="fas fa-chevron-right" style="font-size:.55rem"></i><span>{{ journey.title }}</span></nav>
      <div class="page-header">
        <div>
          <h1 class="page-title">{{ journey ? journey.title : 'Clinic operations' }}</h1>
          <p class="page-subtitle">{{ journey ? `Pick a visit to open in ${journey.title}.` : 'Each visit goes Front Desk → Consultation → Checkout, one guided journey per stage, run inside Cübo. A closed visit is read-only.' }}</p>
        </div>
        <div class="page-actions">
          <button v-if="!journey || journey.id === 'front-desk'" class="ui-btn ui-btn-primary" data-testid="new-check-in" @click="newCheckIn"><i class="fas fa-plus"></i> New check-in</button>
        </div>
      </div>

      <div v-if="!journey" class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
        <RouterLink v-for="j in CLINIC_JOURNEYS" :key="j.id" :to="`/clinic/${j.id}`" class="stat-card ops-card" :data-testid="`clinic-card-${j.id}`">
          <div class="stat-card-head"><span>{{ j.title }}</span><i class="fas" :class="j.icon"></i></div>
          <div class="stat-card-value">{{ atStage(j.id) }}</div>
          <div class="stat-card-hint">{{ atStage(j.id) === 1 ? 'visit waiting' : 'visits waiting' }} · {{ j.summary }}</div>
        </RouterLink>
      </div>

      <section class="panel" data-testid="clinic-visits">
        <div class="panel-head">
          <div>
            <div class="panel-title">{{ journey ? 'Open visits' : 'Visits' }}</div>
            <div class="panel-sub">{{ journey ? 'Visits not yet closed' : 'Newest first · closed visits are read-only' }}</div>
          </div>
        </div>
        <div v-if="!(journey ? openVisits : visits).length" class="empty-state">
          <div class="empty-state-icon"><i class="fas fa-clipboard-user"></i></div>
          <div class="empty-state-title">No visits yet</div>
          <p class="empty-state-text">Start one with “New check-in”.</p>
        </div>
        <div v-for="v in (journey ? openVisits : visits).slice(0, 50)" :key="v.id" class="panel-row" :data-testid="`visit-${v.id}`">
          <div style="min-width:0">
            <div style="font-weight:600;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
              {{ v.patientRef || 'Unnamed patient' }}
              <span v-if="v.priority" class="visit-tag" :class="priorityTone(v.priority)">{{ v.priority }}</span>
              <span v-if="v.closed" class="visit-tag"><i class="fas fa-lock"></i> Closed</span>
            </div>
            <div class="panel-row-muted">{{ [v.chiefComplaint, when(v.savedAt)].filter(Boolean).join(' · ') }}</div>
            <div class="visit-stages">
              <span v-for="st in STAGES" :key="st.key" :class="{ done: v.stages?.[st.key] }"><i class="fas" :class="v.stages?.[st.key] ? 'fa-circle-check' : 'fa-circle'"></i>{{ st.label }}</span>
            </div>
          </div>
          <div style="display:flex;gap:.4rem;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
            <button v-if="v.closed" class="ui-btn" style="padding:.3rem .65rem" @click="openVisit('checkout', v.id)"><i class="fas fa-eye"></i> View</button>
            <template v-else-if="journey">
              <button class="ui-btn ui-btn-primary" style="padding:.3rem .65rem" @click="openVisit(journey.id, v.id)"><i class="fas fa-play"></i> Open</button>
            </template>
            <template v-else>
              <button v-for="st in STAGES" :key="st.key" class="ui-btn" :class="{ 'ui-btn-primary': v.next?.key === st.key }" style="padding:.3rem .65rem" @click="openVisit(st.journey, v.id)">{{ st.label }}</button>
            </template>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.journey-cubo { height: calc(100dvh - var(--shell-topbar-h) - 12rem); min-height: 520px; }
.ops-card { text-decoration: none; transition: border-color .12s; }
.ops-card:hover { border-color: var(--color-primary); }
.visit-tag { font-size: .66rem; font-weight: 600; padding: .05rem .45rem; border-radius: 99px; border: 1px solid var(--shell-border); color: var(--shell-text-muted); display: inline-flex; align-items: center; gap: .25rem; }
.visit-tag.bad { color: #b91c1c; border-color: #fecaca; }
.visit-tag.warn { color: #b45309; border-color: #fde68a; }
.visit-stages { display: flex; flex-wrap: wrap; gap: .25rem .75rem; margin-top: .3rem; font-size: .72rem; color: var(--shell-text-muted); }
.visit-stages span { display: inline-flex; align-items: center; gap: .3rem; }
.visit-stages span.done { color: #15803d; }
.visit-stages i { font-size: .62rem; }
</style>
