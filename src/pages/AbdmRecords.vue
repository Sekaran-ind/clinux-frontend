<script setup>
// ABDM records (/registries/abdm): the clinic on ABDM's health information exchange.
//   Shared (M2, HIP)    visits shared to patients' ABHA from Checkout, their linking, patients'
//                       own link requests from the ABHA app, and every consent and transfer.
//   Request (M3, HIU)   ask a patient, by ABHA address, for their records held elsewhere; they
//                       approve in their ABHA app; what arrives is readable here until the
//                       consent's "keep until" date (or until they revoke it).
//   Settings            per facility: receive records (HIU), Scan & Pay, the UPI id patients pay to.
// Everything goes through clinuxflow-abdm-gateway (src/data/hie.js).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { accountRecords } from '../journeys/index.js';
import { HPR_RECORD } from '../journeys/hprJourney.js';
import { fetchScanShareFacilities } from '../data/scanShare.js';
import {
  HI_TYPE_LABELS, LINK_STATUS, fetchConsentData, listCareContexts, listConsentRequests, listHipConsents, listLinkRequests,
  listReceivedRecords, readDocument, refreshConsentStatus, relinkCareContext, requestConsent, updateFacilitySettings,
} from '../data/hie.js';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const TABS = [
  { id: 'shared', label: 'Shared records', icon: 'fa-share-nodes', badge: 'M2' },
  { id: 'request', label: 'Request records', icon: 'fa-file-import', badge: 'M3' },
  { id: 'settings', label: 'Settings', icon: 'fa-gear' },
];
const tab = ref(TABS.some((t) => t.id === route.query.tab) ? route.query.tab : 'shared');
watch(tab, (t) => router.replace({ query: { ...route.query, tab: t } }));

const facilities = ref([]);
const error = ref('');
const fmt = (d) => (d ? new Date(String(d).includes('T') ? d : `${d.replace(' ', 'T')}Z`).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—');

async function loadFacilities() {
  try { facilities.value = (await fetchScanShareFacilities()).facilities || []; } catch (err) { error.value = err.message; }
}

// ── Shared (M2) ──
const careContexts = ref([]);
const linkRequests = ref([]);
const consents = ref([]);
const transfers = ref([]);
async function loadShared() {
  try {
    const [cc, lr, cs] = await Promise.all([listCareContexts(), listLinkRequests(), listHipConsents()]);
    careContexts.value = cc.careContexts || [];
    linkRequests.value = lr.linkRequests || [];
    consents.value = cs.consents || [];
    transfers.value = cs.transfers || [];
    error.value = '';
  } catch (err) { error.value = err.message; }
}
async function relink(cc) {
  try { await relinkCareContext(cc.id); await loadShared(); } catch (err) { error.value = err.message; }
}
const linkBadge = (s) => ({ linked: 'badge-teal', failed: 'badge-red', unlinked: 'badge-muted' }[s] || 'badge-amber');

// ── Request (M3) ──
const purposes = ref({ CAREMGT: 'Care Management' });
const hiTypes = ref(Object.keys(HI_TYPE_LABELS));
const requests = ref([]);
const today = new Date().toISOString().slice(0, 10);
const form = ref({
  facilityId: '', abhaAddress: String(route.query.abha || ''), purposeCode: 'CAREMGT', hiTypes: Object.keys(HI_TYPE_LABELS),
  from: new Date(Date.now() - 5 * 365 * 86400000).toISOString().slice(0, 10), to: today,
  eraseAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), requesterName: '', requesterId: '',
});
const hiuFacilities = computed(() => facilities.value.filter((f) => f.hiuEnabled));
const sending = ref(false);
const sendError = ref('');
async function loadRequests() {
  try {
    const res = await listConsentRequests();
    requests.value = res.consentRequests || [];
    if (res.purposes) purposes.value = res.purposes;
    if (res.hiTypes) hiTypes.value = res.hiTypes;
  } catch (err) { error.value = err.message; }
}
async function sendRequest() {
  sending.value = true;
  sendError.value = '';
  try {
    const f = form.value;
    await requestConsent({
      facilityId: f.facilityId, abhaAddress: f.abhaAddress.trim(), purposeCode: f.purposeCode, hiTypes: f.hiTypes,
      from: new Date(f.from).toISOString(), to: new Date(`${f.to}T23:59:59`).toISOString(), eraseAt: new Date(`${f.eraseAt}T23:59:59`).toISOString(),
      requester: { name: f.requesterName.trim(), identifier: { type: 'REGNO', value: f.requesterId.trim() || 'NA', system: 'https://www.mciindia.org' } },
    });
    await loadRequests();
  } catch (err) { sendError.value = err.message; } finally { sending.value = false; }
}
const statusBadge = (s) => ({ GRANTED: 'badge-teal', DENIED: 'badge-red', REVOKED: 'badge-red', EXPIRED: 'badge-muted', failed: 'badge-red' }[s] || 'badge-amber');
async function refresh(r) { try { await refreshConsentStatus(r.id); setTimeout(loadRequests, 1500); } catch (err) { error.value = err.message; } }
async function fetchAgain(a) { try { await fetchConsentData(a.consentId); } catch (err) { error.value = err.message; } }

// Records received for one patient.
const viewing = ref('');
const records = ref([]);
const recordsError = ref('');
async function openRecords(abha) {
  viewing.value = abha;
  recordsError.value = '';
  try { records.value = ((await listReceivedRecords(abha)).records || []).map((r) => ({ ...r, doc: readDocument(r.bundle) })); } catch (err) { recordsError.value = err.message; records.value = []; }
}

// ── Settings ──
const saving = ref('');
const settingsError = ref('');
const drafts = ref({});
watch(facilities, (list) => { drafts.value = Object.fromEntries(list.map((f) => [f.facilityId, { hiuEnabled: f.hiuEnabled, scanPayEnabled: f.scanPayEnabled, upiVpa: f.upiVpa, payeeName: f.payeeName, linkWithAbdm: true }])); }, { immediate: true });
async function saveSettings(f) {
  saving.value = f.facilityId;
  settingsError.value = '';
  try { await updateFacilitySettings(f.facilityId, drafts.value[f.facilityId]); await loadFacilities(); } catch (err) { settingsError.value = `${f.facilityName}: ${err.message}`; } finally { saving.value = ''; }
}

let timer = null;
function loadTab() {
  if (tab.value === 'shared') loadShared();
  if (tab.value === 'request') loadRequests();
}
watch(tab, loadTab);
onMounted(async () => {
  await loadFacilities();
  form.value.facilityId = hiuFacilities.value[0]?.facilityId || '';
  const me = auth.currentUser;
  const hpr = me?.id ? await accountRecords(me.id).get(HPR_RECORD).catch(() => null) : null;
  form.value.requesterName = hpr?.name || me?.adminName || '';
  form.value.requesterId = hpr?.hprId || '';
  loadTab();
  if (route.query.abha) openRecords(String(route.query.abha));
  timer = setInterval(loadTab, 10000); // linking and consents complete by ABDM callback
});
onBeforeUnmount(() => clearInterval(timer));
watch(hiuFacilities, (l) => { if (!form.value.facilityId) form.value.facilityId = l[0]?.facilityId || ''; });
</script>

<template>
  <div class="page page-wide">
    <nav class="page-crumbs"><RouterLink to="/registries">Registries</RouterLink><i class="fas fa-chevron-right" style="font-size:.55rem"></i><span>ABDM records</span></nav>
    <div class="page-header">
      <div>
        <h1 class="page-title">ABDM records</h1>
        <p class="page-subtitle">Visits you share to patients’ ABHA (ABDM M2), and records you ask patients for from other facilities (M3). Every exchange needs the patient’s consent in their ABHA app.</p>
      </div>
    </div>
    <div class="tabs" role="tablist">
      <button v-for="t in TABS" :key="t.id" role="tab" :class="{ on: tab === t.id }" :data-testid="`abdm-tab-${t.id}`" @click="tab = t.id">
        <i class="fas" :class="t.icon"></i> {{ t.label }} <span v-if="t.badge" class="badge badge-muted">{{ t.badge }}</span>
      </button>
    </div>
    <p v-if="error" class="ui-banner" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c"><i class="fas fa-circle-exclamation"></i> {{ error }}</p>
    <section v-if="!facilities.length" class="panel">
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-hospital"></i></div>
        <div class="empty-state-title">Register a facility for ABDM first</div>
        <p class="empty-state-text">Records are exchanged as an HFR facility linked to ClinuxFlow’s ABDM bridge. Start from Scan &amp; Share → “Start taking shares”.</p>
        <RouterLink to="/registries/scan-share" class="ui-btn ui-btn-primary" style="margin-top:.75rem"><i class="fas fa-qrcode"></i> Scan &amp; Share</RouterLink>
      </div>
    </section>

    <!-- M2 -->
    <template v-else-if="tab === 'shared'">
      <section class="panel">
        <div class="panel-head"><div><div class="panel-title">Shared visits</div><div class="panel-sub">Shared from Checkout. A linked visit shows in the patient’s ABHA app; any facility they consent to can then receive it, encrypted.</div></div></div>
        <div v-if="!careContexts.length" class="empty-state" style="padding:1.5rem"><p class="empty-state-text">Nothing shared yet. At Checkout, “Share through ABDM” shares the visit.</p></div>
        <div v-else class="table-wrap">
          <table class="q-table" data-testid="abdm-care-contexts">
            <thead><tr><th>Record</th><th>Patient</th><th>Status</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              <tr v-for="c in careContexts" :key="c.id">
                <td><div class="cell-strong">{{ c.display }}</div><div class="cell-muted">{{ HI_TYPE_LABELS[c.hiType] || c.hiType }} · {{ c.facilityId }}</div></td>
                <td><div class="cell-code">{{ c.abhaAddress || 'no ABHA' }}</div><div class="cell-muted">{{ c.patientReference }}</div></td>
                <td><span class="badge" :class="linkBadge(c.linkStatus)">{{ LINK_STATUS[c.linkStatus] || c.linkStatus }}</span><div v-if="c.linkStatus === 'failed'" class="cell-muted err-text">{{ c.linkError }}</div><div v-if="c.linkedVia === 'patient'" class="cell-muted">linked by the patient</div></td>
                <td class="cell-muted">{{ fmt(c.updatedAt) }}</td>
                <td><button v-if="c.linkStatus === 'failed' && c.abhaAddress" class="ui-btn" style="padding:.3rem .6rem" @click="relink(c)"><i class="fas fa-rotate"></i> Link again</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><div class="panel-title">Patients linking from their ABHA app</div><div class="panel-sub">A patient finds their visits here (by ABHA or verified mobile) and confirms with an OTP sent to their mobile.</div></div></div>
        <div v-if="!linkRequests.length" class="empty-state" style="padding:1.5rem"><p class="empty-state-text">No requests yet.</p></div>
        <table v-else class="q-table">
          <thead><tr><th>Patient</th><th>Found by</th><th>Status</th><th>When</th></tr></thead>
          <tbody>
            <tr v-for="r in linkRequests" :key="r.transactionId">
              <td class="cell-code">{{ r.abhaAddress || '—' }}</td>
              <td class="cell-muted">{{ r.matchedBy?.toLowerCase().replace('_', ' ') }} · {{ r.offered }} record(s)</td>
              <td>
                <span class="badge" :class="{ linked: 'badge-teal', failed: 'badge-red' }[r.status] || 'badge-amber'">{{ { discovered: 'records found', otp_sent: 'OTP sent', linked: 'linked', failed: 'failed' }[r.status] }}</span>
                <div v-if="r.sandboxOtp" class="sandbox-otp" data-testid="sandbox-otp"><i class="fas fa-flask"></i> Sandbox, no SMS provider: OTP <strong>{{ r.sandboxOtp }}</strong></div>
                <div v-if="r.error" class="cell-muted err-text">{{ r.error }}</div>
              </td>
              <td class="cell-muted">{{ fmt(r.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="panel">
        <div class="panel-head"><div><div class="panel-title">Consents and transfers</div><div class="panel-sub">What patients allowed other facilities to receive from you, and every time it was sent.</div></div></div>
        <div v-if="!consents.length" class="empty-state" style="padding:1.5rem"><p class="empty-state-text">No consents yet.</p></div>
        <table v-else class="q-table">
          <thead><tr><th>Patient</th><th>Requested by</th><th>Allows</th><th>Status</th><th>Sent</th></tr></thead>
          <tbody>
            <tr v-for="c in consents" :key="c.consentId">
              <td class="cell-code">{{ c.patientAbha }}</td>
              <td><div>{{ c.requester || '—' }}</div><div class="cell-muted">{{ c.hiuId }} · {{ c.purpose }}</div></td>
              <td class="cell-muted">{{ c.careContexts }} record(s) · {{ day(c.from) }} – {{ day(c.to) }}<div>until {{ day(c.eraseAt) }}</div></td>
              <td><span class="badge" :class="statusBadge(c.status)">{{ c.status.toLowerCase() }}</span></td>
              <td class="cell-muted">
                <div v-for="t in transfers.filter((x) => x.consentId === c.consentId)" :key="t.transactionId">{{ fmt(t.at) }} · {{ t.status }}<span v-if="t.error"> ({{ t.error }})</span></div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- M3 -->
    <template v-else-if="tab === 'request'">
      <section class="panel">
        <div class="panel-head"><div><div class="panel-title">Ask a patient for their records</div><div class="panel-sub">ABDM sends the request to the patient’s ABHA app. Records from the facilities they approve arrive here.</div></div></div>
        <p v-if="!hiuFacilities.length" class="panel-body cell-muted">Turn on “Receive records” for a facility in Settings first.</p>
        <form v-else class="req-form" @submit.prevent="sendRequest">
          <label class="field"><span>Patient’s ABHA address</span><input v-model="form.abhaAddress" class="cf-input" placeholder="name@sbx" required data-testid="hiu-abha" /></label>
          <label class="field"><span>Receiving facility</span><select v-model="form.facilityId" class="cf-input"><option v-for="f in hiuFacilities" :key="f.facilityId" :value="f.facilityId">{{ f.facilityName }} — {{ f.facilityId }}</option></select></label>
          <label class="field"><span>Purpose</span><select v-model="form.purposeCode" class="cf-input"><option v-for="(label, code) in purposes" :key="code" :value="code">{{ label }}</option></select></label>
          <label class="field"><span>Requested by</span><input v-model="form.requesterName" class="cf-input" placeholder="Doctor’s name" required /></label>
          <label class="field"><span>Registration / HPR number</span><input v-model="form.requesterId" class="cf-input" placeholder="Optional" /></label>
          <label class="field"><span>Records from</span><input v-model="form.from" type="date" class="cf-input" :max="form.to" /></label>
          <label class="field"><span>to</span><input v-model="form.to" type="date" class="cf-input" :max="today" /></label>
          <label class="field"><span>Keep them until</span><input v-model="form.eraseAt" type="date" class="cf-input" :min="today" /></label>
          <fieldset class="types"><legend>Record types</legend>
            <label v-for="t in hiTypes" :key="t" class="check"><input v-model="form.hiTypes" type="checkbox" :value="t" /> {{ HI_TYPE_LABELS[t] || t }}</label>
          </fieldset>
          <p v-if="sendError" class="err-text" role="alert">{{ sendError }}</p>
          <div><button class="ui-btn ui-btn-primary" type="submit" :disabled="sending || !form.hiTypes.length" data-testid="hiu-send"><i class="fas" :class="sending ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i> Send the request</button></div>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head"><div><div class="panel-title">Requests</div><div class="panel-sub">Updates by itself as patients respond.</div></div></div>
        <div v-if="!requests.length" class="empty-state" style="padding:1.5rem"><p class="empty-state-text">No requests yet.</p></div>
        <table v-else class="q-table" data-testid="hiu-requests">
          <thead><tr><th>Patient</th><th>Asked for</th><th>Status</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in requests" :key="r.id">
              <td><div class="cell-code">{{ r.abhaAddress }}</div><div class="cell-muted">{{ fmt(r.createdAt) }}</div></td>
              <td class="cell-muted">{{ r.purpose }} · {{ r.hiTypes.map((t) => HI_TYPE_LABELS[t] || t).join(', ') }}<div>{{ day(r.from) }} – {{ day(r.to) }}, kept until {{ day(r.eraseAt) }}</div></td>
              <td>
                <span class="badge" :class="statusBadge(r.status)">{{ r.status === 'requesting' ? 'sending' : r.status.toLowerCase() }}</span>
                <div v-if="r.error" class="cell-muted err-text">{{ r.error }}</div>
                <div v-for="a in r.artefacts" :key="a.consentId" class="cell-muted">{{ a.hipId || 'facility' }}: {{ a.status.toLowerCase() }}
                  <button v-if="a.status === 'GRANTED'" class="ui-link" type="button" @click="fetchAgain(a)">fetch again</button></div>
              </td>
              <td class="actions">
                <button v-if="r.status === 'GRANTED'" class="ui-btn ui-btn-primary" style="padding:.3rem .6rem" @click="openRecords(r.abhaAddress)"><i class="fas fa-folder-open"></i> Records</button>
                <button v-else-if="r.consentRequestId" class="ui-btn" style="padding:.3rem .6rem" @click="refresh(r)"><i class="fas fa-rotate"></i></button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="viewing" class="panel" data-testid="hiu-records">
        <div class="panel-head"><div><div class="panel-title">Records received for {{ viewing }}</div><div class="panel-sub">Read-only, and deleted when the consent ends.</div></div><button class="ui-btn" @click="viewing = ''"><i class="fas fa-xmark"></i></button></div>
        <p v-if="recordsError" class="panel-body err-text">{{ recordsError }}</p>
        <div v-else-if="!records.length" class="empty-state" style="padding:1.5rem"><p class="empty-state-text">Nothing has arrived yet. Facilities send records a little after the patient approves.</p></div>
        <article v-for="r in records" :key="r.id" class="doc">
          <header><strong>{{ r.doc.title }}</strong> <span class="cell-muted">{{ day(r.doc.date) }}{{ r.doc.custodian ? ` · ${r.doc.custodian}` : '' }}{{ r.doc.author ? ` · ${r.doc.author}` : '' }}</span></header>
          <div v-for="s in r.doc.sections" :key="s.title" class="doc-section"><div class="cell-muted">{{ s.title }}</div><ul><li v-for="(l, n) in s.lines" :key="n">{{ l }}</li></ul></div>
          <footer class="cell-muted">From {{ r.hipId }} · received {{ fmt(r.receivedAt) }} · kept until {{ day(r.eraseAt) }}</footer>
        </article>
      </section>
    </template>

    <!-- Settings -->
    <template v-else>
      <p v-if="settingsError" class="ui-banner" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c">{{ settingsError }}</p>
      <section v-for="f in facilities" :key="f.facilityId" class="panel">
        <div class="panel-head"><div><div class="panel-title">{{ f.facilityName }}</div><div class="panel-sub">{{ f.facilityId }} · shown in ABHA apps as “{{ f.hipName }}”{{ f.linkedWithAbdm ? ' · linked with ABDM' : '' }}</div></div></div>
        <form v-if="drafts[f.facilityId]" class="settings" @submit.prevent="saveSettings(f)">
          <label class="check"><input v-model="drafts[f.facilityId].hiuEnabled" type="checkbox" :data-testid="`hiu-${f.facilityId}`" /> Receive records from other facilities (HIU, ABDM M3)</label>
          <label class="check"><input v-model="drafts[f.facilityId].scanPayEnabled" type="checkbox" /> Scan &amp; Pay — patients pay their bills from the ABHA app</label>
          <div class="settings-row">
            <label class="field"><span>UPI id patients pay to</span><input v-model="drafts[f.facilityId].upiVpa" class="cf-input" placeholder="clinic@okbank" /></label>
            <label class="field"><span>Payee name on the pay page</span><input v-model="drafts[f.facilityId].payeeName" class="cf-input" :placeholder="f.facilityName" /></label>
          </div>
          <label class="check cell-muted"><input v-model="drafts[f.facilityId].linkWithAbdm" type="checkbox" /> Turn these on with ABDM now (untick if already done on the HFR portal)</label>
          <div><button class="ui-btn ui-btn-primary" type="submit" :disabled="saving === f.facilityId"><i class="fas" :class="saving === f.facilityId ? 'fa-spinner fa-spin' : 'fa-check'"></i> Save</button></div>
        </form>
      </section>
    </template>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--shell-border); margin-bottom: 1rem; overflow-x: auto; }
.tabs button { background: none; border: none; border-bottom: 2px solid transparent; padding: .55rem .8rem; font-size: .82rem; color: var(--shell-text-muted); cursor: pointer; white-space: nowrap; display: inline-flex; gap: .4rem; align-items: center; }
.tabs button.on { color: var(--shell-text-strong); border-bottom-color: var(--color-primary); font-weight: 600; }
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; padding: .9rem 1rem; border-bottom: 1px solid var(--shell-border); }
.panel + .panel { margin-top: 1.25rem; }
.table-wrap { overflow-x: auto; }
.q-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
.q-table th { text-align: left; font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: var(--shell-text-muted); padding: .55rem 1rem; border-bottom: 1px solid var(--shell-border); }
.q-table td { padding: .6rem 1rem; border-bottom: 1px solid var(--shell-border); vertical-align: top; }
.cell-strong { font-weight: 600; color: var(--shell-text-strong); }
.cell-muted { color: var(--shell-text-muted); font-size: .74rem; }
.cell-code { font-family: ui-monospace, monospace; font-size: .76rem; }
.err-text { color: #b91c1c; }
.sandbox-otp { margin-top: .3rem; font-size: .74rem; color: #92400e; background: #fef3c7; border-radius: 6px; padding: .2rem .45rem; display: inline-block; }
.req-form { padding: 1rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .75rem; }
.req-form > div, .req-form > p, .types { grid-column: 1 / -1; }
.field { display: flex; flex-direction: column; gap: .3rem; font-size: .75rem; font-weight: 600; color: var(--shell-text-strong); }
.types { border: 1px solid var(--shell-border); border-radius: 8px; padding: .5rem .75rem; display: flex; flex-wrap: wrap; gap: .4rem 1rem; }
.types legend { font-size: .72rem; font-weight: 600; padding: 0 .3rem; }
.check { display: flex; gap: .4rem; align-items: center; font-size: .8rem; }
.actions { text-align: right; white-space: nowrap; }
.doc { margin: 1rem; padding: .85rem 1rem; border: 1px solid var(--shell-border); border-radius: 8px; }
.doc header { margin-bottom: .5rem; }
.doc-section { margin-top: .45rem; }
.doc-section ul { margin: .15rem 0 0; padding-left: 1.1rem; font-size: .82rem; }
.doc footer { margin-top: .6rem; }
.settings { padding: 1rem; display: flex; flex-direction: column; gap: .7rem; max-width: 40rem; }
.settings-row { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
@media (max-width: 640px) { .settings-row { grid-template-columns: 1fr; } .q-table th, .q-table td { padding: .5rem .6rem; } }
</style>
