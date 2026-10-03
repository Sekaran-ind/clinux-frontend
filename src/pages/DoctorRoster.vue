<script setup>
// Doctor roster (/registries/roster), modelled on the Swastik ABDM Connector's Doctor roster: the
// doctors, nurses and pharmacists who sign records at each of the clinic's HFR facilities, each
// checked against the Healthcare Professionals Registry so a record names a clinician anyone on
// the network can verify.
//
// Facilities: the HFR facilities this account submitted (journeys/hfrFacilities.js), those already
// on the clinic's roster, those taking Scan & Share, or any HFR facility id looked up in HFR.
// Adding someone: search HPR by HPR ID or mobile through the gateway (POST /hpr/search), pick the
// match; the gateway's signed attestation is what clinuxflow-api stores as "verified"
// (src/data/roster.js). "Create an HPR ID" / "Complete HPR registration" open the HPR journey.
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { accountRecords } from '../journeys/index.js';
import { addToRoster, fetchHprProfile, fetchRoster, findHfrFacility, knownFacilities, searchHpr, updateRosterEntry, ROLE_LABELS, ROLE_OF_CATEGORY } from '../data/roster.js';
import { fetchScanShareFacilities } from '../data/scanShare.js';

const router = useRouter();
const auth = useAuthStore();
const FACILITY_KEY = 'roster_facility';

// ── Facilities ──
const facilities = ref([]);
const facilityId = ref('');
const facility = computed(() => facilities.value.find((f) => f.facilityId === facilityId.value) || null);
const loadingFacilities = ref(true);
const records = () => (auth.currentUser?.id ? accountRecords(auth.currentUser.id) : null);

async function loadFacilityOptions() {
  loadingFacilities.value = true;
  const scanShare = await fetchScanShareFacilities().then((r) => r.facilities || []).catch(() => []);
  facilities.value = await knownFacilities(records(), { scanShare });
  loadingFacilities.value = false;
  let saved = '';
  try { saved = localStorage.getItem(FACILITY_KEY) || ''; } catch { /* storage blocked */ }
  if (!facility.value) facilityId.value = facilities.value.find((f) => f.facilityId === saved)?.facilityId || facilities.value[0]?.facilityId || '';
}

// Another HFR facility, by id: confirmed with HFR's facility search first.
const lookupOpen = ref(false);
const lookupId = ref('');
const lookupBusy = ref(false);
const lookupError = ref('');
async function lookupFacility() {
  lookupError.value = '';
  lookupBusy.value = true;
  try {
    const f = await findHfrFacility(records(), lookupId.value);
    await loadFacilityOptions();
    facilityId.value = f.facilityId;
    lookupOpen.value = false;
    lookupId.value = '';
  } catch (err) {
    lookupError.value = err.message;
  } finally {
    lookupBusy.value = false;
  }
}

// ── Roster ──
const showLeft = ref(false);
const rows = ref([]);
const canManage = ref(false);
const loading = ref(false);
const error = ref('');

async function loadRoster() {
  if (!facilityId.value) { rows.value = []; return; }
  loading.value = true;
  error.value = '';
  const res = await fetchRoster({ facilityId: facilityId.value, includeLeft: showLeft.value });
  loading.value = false;
  if (res.error) { error.value = res.error; rows.value = []; return; }
  rows.value = res.practitioners;
  canManage.value = !!res.canManage;
}
watch([facilityId, showLeft], () => {
  try { if (facilityId.value) localStorage.setItem(FACILITY_KEY, facilityId.value); } catch { /* storage blocked */ }
  loadRoster();
});
onMounted(async () => { await loadFacilityOptions(); loadRoster(); });

async function setStatus(p, status) {
  if (status === 'left' && !window.confirm(`Mark ${p.name} as having left ${facility.value?.facilityName || 'this facility'}? They stay in the roster’s history.`)) return;
  const res = await updateRosterEntry(p.id, { status });
  if (res.error) { error.value = res.error; return; }
  loadRoster();
}

// ── Add practitioner (drawer) ──
const addOpen = ref(false);
const searchBy = ref('hprId');
const query = ref('');
const searching = ref(false);
const searchError = ref('');
const matches = ref(null);
const chosen = ref(null);
const form = ref({ role: 'doctor', designation: '', department: '' });
const saving = ref(false);

function openAdd() {
  addOpen.value = true;
  query.value = '';
  matches.value = null;
  chosen.value = null;
  searchError.value = '';
  form.value = { role: 'doctor', designation: '', department: '' };
}
async function runSearch() {
  searchError.value = '';
  matches.value = null;
  chosen.value = null;
  const q = query.value.trim();
  if (!q) return;
  if (searchBy.value === 'mobile' && !/^[6-9]\d{9}$/.test(q)) { searchError.value = 'A mobile number has 10 digits.'; return; }
  searching.value = true;
  try {
    matches.value = await searchHpr(searchBy.value === 'mobile' ? { mobile: q } : { hprId: q });
    if (matches.value.length === 1) choose(matches.value[0]);
  } catch (err) {
    searchError.value = err.message;
  } finally {
    searching.value = false;
  }
}
function choose(m) {
  chosen.value = m;
  form.value.role = ROLE_OF_CATEGORY[m.categoryId] || 'other';
}
const alreadyOn = computed(() => chosen.value && rows.value.some((r) => r.status === 'active' && r.hprIdNumber === chosen.value.hprIdNumber));
async function saveAdd() {
  if (!chosen.value?.attestation) { searchError.value = 'Look the practitioner up in HPR first.'; return; }
  saving.value = true;
  const res = await addToRoster({ facilityId: facilityId.value, facilityName: facility.value?.facilityName, attestation: chosen.value.attestation, ...form.value });
  saving.value = false;
  if (res.error) { searchError.value = res.error; return; }
  addOpen.value = false;
  await loadFacilityOptions();
  loadRoster();
}

// ── HPR registration details (drawer) ──
const detail = ref(null);
const detailData = ref(null);
const detailError = ref('');
async function openDetail(p) {
  detail.value = p;
  detailData.value = null;
  detailError.value = '';
  try {
    detailData.value = await fetchHprProfile(p.hprIdNumber);
    // fetch-professional-info only answers for professionals who consented to public display.
    if (!detailData.value) detailError.value = 'private';
  } catch (err) {
    detailError.value = err.message;
  }
}
const yes = (v) => String(v).toLowerCase() === 'true';

const addBlocked = computed(() => (!facilityId.value ? 'Choose a facility first' : !canManage.value ? 'Your role can’t change the roster' : ''));
const when = (at) => (at ? new Date(at.replace(' ', 'T') + (/[zZ+]/.test(at.slice(10)) ? '' : 'Z')).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
</script>

<template>
  <div class="page page-wide">
    <nav class="page-crumbs"><RouterLink to="/registries">Registries</RouterLink><i class="fas fa-chevron-right" style="font-size:.55rem"></i><span>Doctor roster</span></nav>
    <div class="page-header">
      <div>
        <h1 class="page-title">Doctor roster</h1>
        <p class="page-subtitle">The doctors and nurses who sign records at a facility. Each is checked against the Healthcare Professionals Registry (HPR), so a record names a clinician anyone on the network can verify.</p>
      </div>
      <div class="page-actions">
        <button class="ui-btn" data-testid="roster-create-hpr" @click="router.push('/registries/hpr')"><i class="fas fa-id-card"></i> Create an HPR ID</button>
        <button class="ui-btn" data-testid="roster-complete-hpr" @click="router.push('/registries/hpr')"><i class="fas fa-clipboard-check"></i> Complete HPR registration</button>
        <button class="ui-btn ui-btn-primary" :disabled="!!addBlocked" :title="addBlocked" data-testid="roster-add" @click="openAdd"><i class="fas fa-user-plus"></i> Add practitioner</button>
      </div>
    </div>

    <div class="roster-bar">
      <select v-model="facilityId" class="cf-input roster-facility" :disabled="loadingFacilities || !facilities.length" aria-label="Facility" data-testid="roster-facility">
        <option v-if="!facilities.length" value="">{{ loadingFacilities ? 'Loading facilities…' : 'No HFR facility yet' }}</option>
        <option v-for="f in facilities" :key="f.facilityId" :value="f.facilityId">{{ f.facilityName || 'Facility' }} — {{ f.facilityId }}</option>
      </select>
      <button type="button" class="ui-btn" style="padding:.4rem .7rem" @click="lookupOpen = !lookupOpen"><i class="fas fa-magnifying-glass"></i> Another facility</button>
      <label class="roster-left"><input v-model="showLeft" type="checkbox" data-testid="roster-show-left" /> Show practitioners who have left</label>
    </div>
    <form v-if="lookupOpen" class="roster-lookup" @submit.prevent="lookupFacility">
      <input v-model="lookupId" class="cf-input" placeholder="HFR facility id, e.g. IN3310002300" aria-label="HFR facility id" />
      <button class="ui-btn ui-btn-primary" type="submit" :disabled="lookupBusy"><i class="fas" :class="lookupBusy ? 'fa-spinner fa-spin' : 'fa-check'"></i> Find in HFR</button>
      <span v-if="lookupError" class="roster-error">{{ lookupError }}</span>
    </form>

    <p v-if="error" class="ui-banner" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c"><i class="fas fa-circle-exclamation"></i> {{ error }}</p>

    <section class="panel">
      <div v-if="!loadingFacilities && !facilities.length" class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-hospital"></i></div>
        <div class="empty-state-title">Register a facility first</div>
        <p class="empty-state-text">A roster belongs to an HFR facility. Register yours with HFR, or find one by its HFR id.</p>
        <RouterLink to="/registries/hfr" class="ui-btn ui-btn-primary" style="margin-top:.75rem"><i class="fas fa-hospital-user"></i> Facility registration</RouterLink>
      </div>
      <div v-else-if="!loading && !rows.length" class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-user-doctor"></i></div>
        <div class="empty-state-title">No practitioners {{ showLeft ? '' : 'yet' }}</div>
        <p class="empty-state-text">Add the doctors and nurses who work at {{ facility?.facilityName || 'this facility' }} by their HPR ID.</p>
      </div>
      <div v-else class="table-wrap">
        <table class="roster-table" data-testid="roster-table">
          <thead><tr><th>Practitioner</th><th>Role</th><th>HPR</th><th>Status</th><th></th></tr></thead>
          <tbody>
            <tr v-for="p in rows" :key="p.id" :class="{ left: p.status === 'left' }">
              <td>
                <div class="cell-strong">{{ p.name }}</div>
                <div class="cell-code">{{ p.hprIdNumber }}<template v-if="p.hprAddress"> · {{ p.hprAddress }}</template></div>
                <div v-if="p.designation || p.department" class="cell-muted">{{ [p.designation, p.department].filter(Boolean).join(' · ') }}</div>
              </td>
              <td>{{ ROLE_LABELS[p.role] || p.role }}</td>
              <td>
                <span v-if="p.hprVerified" class="pill ok" :title="`Checked in HPR ${when(p.hprVerifiedAt)}`"><span class="dot"></span>verified</span>
                <span v-else class="pill">not verified</span>
              </td>
              <td><span class="pill" :class="p.status === 'active' ? 'muted' : 'gone'">{{ p.status === 'active' ? 'active' : `left ${when(p.leftAt)}` }}</span></td>
              <td class="row-actions">
                <button type="button" class="link-btn" @click="openDetail(p)">HPR registration</button>
                <template v-if="canManage">
                  <button v-if="p.status === 'active'" type="button" class="link-btn" data-testid="roster-deactivate" @click="setStatus(p, 'left')">Deactivate</button>
                  <button v-else type="button" class="link-btn" @click="setStatus(p, 'active')">Reactivate</button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="loading" class="cell-muted" style="padding:1rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p>
    </section>

    <!-- Add practitioner. Classes are rd-*: style.css's global .drawer-backdrop is hidden unless .open. -->
    <Teleport to="body">
    <div v-if="addOpen" class="rd-backdrop" @click.self="addOpen = false">
      <aside class="rd-panel" role="dialog" aria-label="Add practitioner" data-testid="roster-drawer">
        <div class="rd-head">
          <div>
            <div class="rd-title">Add practitioner</div>
            <div class="cell-muted">{{ facility?.facilityName }} — {{ facilityId }}</div>
          </div>
          <button type="button" class="ui-btn" style="padding:.3rem .55rem" aria-label="Close" @click="addOpen = false"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="rd-body">
          <div class="rd-seg" role="group" aria-label="Search by">
            <button type="button" :class="{ on: searchBy === 'hprId' }" @click="searchBy = 'hprId'; matches = null">HPR ID</button>
            <button type="button" :class="{ on: searchBy === 'mobile' }" @click="searchBy = 'mobile'; matches = null">Mobile number</button>
          </div>
          <form class="search-row" @submit.prevent="runSearch">
            <input v-model="query" class="cf-input" :placeholder="searchBy === 'mobile' ? '10-digit mobile' : '71-xxxx-xxxx-xxxx or name@hpr.abdm'" :inputmode="searchBy === 'mobile' ? 'tel' : 'text'" aria-label="Search HPR" data-testid="roster-search" />
            <button class="ui-btn ui-btn-primary" type="submit" :disabled="searching"><i class="fas" :class="searching ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> Look up in HPR</button>
          </form>
          <p v-if="searchError" class="roster-error" role="alert">{{ searchError }}</p>
          <p v-if="matches && !matches.length" class="cell-muted">HPR has no practitioner for that. They may need to <RouterLink to="/registries/hpr">create an HPR ID</RouterLink> first.</p>
          <div v-if="matches?.length" class="matches">
            <button v-for="m in matches" :key="m.hprIdNumber" type="button" class="match" :class="{ on: chosen?.hprIdNumber === m.hprIdNumber }" @click="choose(m)">
              <span class="cell-strong">{{ m.name || 'Practitioner' }}</span>
              <span class="cell-code">{{ m.hprIdNumber }}<template v-if="m.hprId"> · {{ m.hprId }}</template></span>
              <span class="cell-muted">{{ ROLE_LABELS[ROLE_OF_CATEGORY[m.categoryId]] || 'HPR category ' + (m.categoryId || '—') }}<template v-if="m.applicationStatus"> · HPR application {{ m.applicationStatus }}</template></span>
            </button>
          </div>
          <template v-if="chosen">
            <p v-if="alreadyOn" class="roster-error">{{ chosen.name }} is already on this facility’s roster.</p>
            <label class="field"><span>Role at this facility</span>
              <select v-model="form.role" class="cf-input"><option v-for="(label, v) in ROLE_LABELS" :key="v" :value="v">{{ label }}</option></select>
            </label>
            <label class="field"><span>Designation <em>(optional)</em></span><input v-model="form.designation" class="cf-input" placeholder="e.g. Consultant physician" /></label>
            <label class="field"><span>Department <em>(optional)</em></span><input v-model="form.department" class="cf-input" placeholder="e.g. General medicine" /></label>
          </template>
        </div>
        <div class="rd-foot">
          <button type="button" class="ui-btn" @click="addOpen = false">Cancel</button>
          <button type="button" class="ui-btn ui-btn-primary" :disabled="!chosen || alreadyOn || saving" data-testid="roster-save" @click="saveAdd"><i class="fas" :class="saving ? 'fa-spinner fa-spin' : 'fa-user-plus'"></i> Add to roster</button>
        </div>
      </aside>
    </div>
    </Teleport>

    <!-- HPR registration details -->
    <Teleport to="body">
    <div v-if="detail" class="rd-backdrop" @click.self="detail = null">
      <aside class="rd-panel" role="dialog" aria-label="HPR registration">
        <div class="rd-head">
          <div>
            <div class="rd-title">{{ detail.name }}</div>
            <div class="cell-code">{{ detail.hprIdNumber }}<template v-if="detail.hprAddress"> · {{ detail.hprAddress }}</template></div>
          </div>
          <button type="button" class="ui-btn" style="padding:.3rem .55rem" aria-label="Close" @click="detail = null"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="rd-body">
          <template v-if="detailError === 'private'">
            <p class="cell-muted">HPR shares registration details (council and work verification, qualifications) only for professionals who have agreed to show their profile publicly, and {{ detail.name }} hasn’t. Their HPR ID itself was found in HPR<template v-if="detail.hprVerifiedAt"> on {{ when(detail.hprVerifiedAt) }}</template>.</p>
            <dl class="facts">
              <dt>HPR number</dt><dd>{{ detail.hprIdNumber }}</dd>
              <dt>HPR address</dt><dd>{{ detail.hprAddress || '—' }}</dd>
              <dt>HPR category</dt><dd>{{ ROLE_LABELS[ROLE_OF_CATEGORY[detail.hprCategoryId]] || detail.hprCategoryId || '—' }}</dd>
            </dl>
            <p class="cell-muted">They can complete their profile and its public-display consent in the <RouterLink to="/registries/hpr">HPR journey</RouterLink>.</p>
          </template>
          <p v-else-if="detailError" class="roster-error">{{ detailError }}</p>
          <p v-else-if="!detailData" class="cell-muted"><i class="fas fa-spinner fa-spin"></i> Asking HPR…</p>
          <template v-else>
            <dl class="facts">
              <dt>HPR application</dt><dd>{{ detailData.application_status || '—' }}</dd>
              <dt>Council verification</dt><dd>{{ detailData.is_council_verified || '—' }}</dd>
              <dt>Work verification</dt><dd>{{ detailData.is_work_verified || '—' }}</dd>
              <dt>Active in HPR</dt><dd>{{ detailData.active === undefined ? '—' : yes(detailData.active) ? 'Yes' : 'No' }}</dd>
              <dt>Category</dt><dd>{{ detailData.hpr_category || '—' }}</dd>
            </dl>
            <p v-if="detailData.remarks" class="cell-muted" style="margin-top:.75rem">{{ detailData.remarks }}</p>
            <div v-for="(r, i) in detailData.registrations || []" :key="i" class="reg">
              <div class="cell-strong">{{ r.councilName || 'Registration' }}</div>
              <div class="cell-muted">{{ r.category }} · {{ r.registrationNumber }}<template v-if="r.registrationDate"> · {{ r.registrationDate }}</template></div>
            </div>
            <p v-if="String(detailData.application_status || '').toLowerCase() !== 'approved'" class="cell-muted" style="margin-top:.75rem">
              HPR hasn’t approved this registration yet. The practitioner can finish it in the <RouterLink to="/registries/hpr">HPR journey</RouterLink>.
            </p>
          </template>
        </div>
      </aside>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.roster-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-bottom: 1rem; }
.roster-facility { min-width: 18rem; max-width: 100%; flex: 0 1 26rem; }
.roster-left { display: inline-flex; align-items: center; gap: .45rem; font-size: .82rem; color: var(--shell-text-strong); }
.roster-lookup { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: -.25rem 0 1rem; }
.roster-lookup .cf-input { max-width: 18rem; }
.roster-error { margin: 0; font-size: .78rem; color: #b91c1c; }
.table-wrap { overflow-x: auto; }
.roster-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
.roster-table th { text-align: left; font-size: .64rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--shell-text-muted); padding: .7rem 1.1rem; border-bottom: 1px solid var(--shell-border); background: var(--shell-bg); white-space: nowrap; }
.roster-table td { padding: .85rem 1.1rem; border-bottom: 1px solid var(--shell-border); vertical-align: middle; color: var(--shell-text-strong); }
.roster-table tbody tr:last-child td { border-bottom: none; }
.roster-table tr.left td { opacity: .65; }
.cell-strong { font-weight: 600; }
.cell-code { font-family: 'JetBrains Mono', monospace; font-size: .7rem; color: var(--shell-text-muted); }
.cell-muted { color: var(--shell-text-muted); font-size: .75rem; }
.pill { display: inline-flex; align-items: center; gap: .35rem; font-size: .72rem; font-weight: 600; padding: .12rem .55rem; border-radius: 99px; border: 1px solid var(--shell-border); color: var(--shell-text-muted); white-space: nowrap; }
.pill.ok { background: #dcfce7; border-color: #bbf7d0; color: #166534; }
.pill.ok .dot { width: 6px; height: 6px; border-radius: 50%; background: #16a34a; }
.pill.muted { background: var(--shell-bg); }
.pill.gone { background: #fef3c7; border-color: #fde68a; color: #92400e; }
.row-actions { text-align: right; white-space: nowrap; }
.link-btn { border: none; background: none; padding: .2rem .45rem; font: inherit; font-size: .8rem; color: var(--shell-text-strong); cursor: pointer; border-radius: .35rem; }
.link-btn:hover { background: var(--shell-hover); }
.rd-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(15, 23, 42, .35); display: flex; justify-content: flex-end; }
.rd-panel { width: min(440px, 100vw); height: 100%; background: var(--shell-surface); border-left: 1px solid var(--shell-border); display: flex; flex-direction: column; box-shadow: -12px 0 32px -12px rgba(0, 0, 0, .3); }
.rd-head { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; padding: 1rem 1.1rem; border-bottom: 1px solid var(--shell-border); }
.rd-title { font-weight: 700; font-size: .95rem; color: var(--shell-text-strong); }
.rd-body { flex: 1; overflow-y: auto; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .8rem; }
.rd-foot { display: flex; justify-content: flex-end; gap: .5rem; padding: .8rem 1.1rem; border-top: 1px solid var(--shell-border); }
.rd-seg { display: inline-flex; border: 1px solid var(--shell-border-strong); border-radius: .5rem; overflow: hidden; align-self: flex-start; }
.rd-seg button { white-space: nowrap; border: none; background: var(--shell-surface); padding: .4rem .8rem; font-size: .78rem; font-weight: 600; color: var(--shell-text); cursor: pointer; }
.rd-seg button.on { background: var(--color-primary); color: var(--color-on-primary); }
.search-row { display: flex; gap: .5rem; }
.search-row .cf-input { flex: 1; min-width: 0; }
.matches { display: flex; flex-direction: column; gap: .4rem; }
.match { display: flex; flex-direction: column; align-items: flex-start; gap: .1rem; text-align: left; padding: .6rem .75rem; border: 1px solid var(--shell-border-strong); border-radius: .5rem; background: var(--shell-surface); cursor: pointer; }
.match.on { border-color: var(--color-primary); background: var(--color-primary-soft); }
.field { display: flex; flex-direction: column; gap: .3rem; font-size: .75rem; font-weight: 600; color: var(--shell-text-strong); }
.field em { font-weight: 400; color: var(--shell-text-muted); font-style: normal; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; font-size: .8rem; margin: 0; }
.facts dt { color: var(--shell-text-muted); }
.facts dd { margin: 0; color: var(--shell-text-strong); }
.reg { margin-top: .6rem; padding-top: .6rem; border-top: 1px solid var(--shell-border); }
:global(.dark) .pill.ok { background: rgba(22, 163, 74, .18); border-color: transparent; color: #86efac; }
:global(.dark) .pill.gone { background: rgba(217, 119, 6, .18); border-color: transparent; color: #fcd34d; }
@media (max-width: 640px) { .roster-facility { flex-basis: 100%; min-width: 0; } .row-actions { white-space: normal; } }
</style>
