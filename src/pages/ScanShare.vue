<script setup>
// Scan & Share (/registries/scan-share): ABDM M1's "Scan Health Facility QR". The facility shows
// a QR per counter; a patient scans it with the ABHA app (or any ABDM PHR app) and shares their
// verified ABHA profile; ABDM sends it to ClinuxFlow's gateway, which gives them a token number at
// that counter. Today's queue is listed here; "Register" opens the Patient ABHA journey on the
// share, which tells a returning patient from a new one and records it.
//
// A facility takes shares once it is registered here (gateway hip_facilities) — and, on ABDM's
// side, linked to ClinuxFlow's bridge as a HIP service, either from here (HFR's bridge API) or on
// the HFR portal. The gateway's public URL must also be this ABDM client's bridge URL
// (gateway scripts/set-bridge-url.js), or ABDM has nowhere to send the shares.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import QRCode from 'qrcode';
import { useAuthStore } from '../stores/auth.js';
import { accountRecords } from '../journeys/index.js';
import { findHfrFacility, knownFacilities } from '../data/roster.js';
import { ageFrom, dismissShare, fetchQueue, fetchScanShareFacilities, registerScanShareFacility, shareQrUrl, stopScanShareFacility, suggestHipName } from '../data/scanShare.js';

const router = useRouter();
const auth = useAuthStore();
const FACILITY_KEY = 'scan_share_facility';
const COUNTER_KEY = 'scan_share_counter';
const stored = (k, d = '') => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

const records = () => (auth.currentUser?.id ? accountRecords(auth.currentUser.id) : null);
const registered = ref([]); // facilities taking Scan & Share
const phrBaseUrl = ref('');
const options = ref([]);
const facilityId = ref('');
const counter = ref(stored(COUNTER_KEY, '1'));
const loadError = ref('');
const loading = ref(true);

const facility = computed(() => options.value.find((f) => f.facilityId === facilityId.value) || null);
const takesShares = computed(() => registered.value.some((f) => f.facilityId === facilityId.value));
const thisFacility = computed(() => registered.value.find((f) => f.facilityId === facilityId.value) || null);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await fetchScanShareFacilities();
    registered.value = res.facilities || [];
    phrBaseUrl.value = res.phrBaseUrl || '';
  } catch (err) {
    loadError.value = err.message;
  }
  options.value = await knownFacilities(records(), { scanShare: registered.value });
  loading.value = false;
  if (!facility.value) facilityId.value = options.value.find((f) => f.facilityId === stored(FACILITY_KEY))?.facilityId || registered.value[0]?.facilityId || options.value[0]?.facilityId || '';
}

// Another HFR facility, by id (shared with the roster's list).
const lookupOpen = ref(false);
const lookupId = ref('');
const lookupError = ref('');
async function lookupFacility() {
  lookupError.value = '';
  try {
    const f = await findHfrFacility(records(), lookupId.value);
    await load();
    facilityId.value = f.facilityId;
    lookupOpen.value = false;
  } catch (err) {
    lookupError.value = err.message;
  }
}

// ── Register a facility for Scan & Share ──
const hipName = ref('');
const linkWithAbdm = ref(true);
const registering = ref(false);
const registerError = ref('');
watch(facility, (f) => { hipName.value = suggestHipName(f?.facilityName); registerError.value = ''; }, { immediate: true });
async function register() {
  registering.value = true;
  registerError.value = '';
  try {
    await registerScanShareFacility({ facilityId: facilityId.value, facilityName: facility.value?.facilityName, hipName: hipName.value.trim(), linkWithAbdm: linkWithAbdm.value });
    await load();
  } catch (err) {
    registerError.value = linkWithAbdm.value ? `${err.message} — if the facility is already linked to ClinuxFlow on the HFR portal, untick “Link it with ABDM now” and register again.` : err.message;
  } finally {
    registering.value = false;
  }
}
async function stop() {
  if (!window.confirm(`Stop taking Scan & Share for ${facility.value?.facilityName}? Patients who scan its QR will be told it isn’t available.`)) return;
  try { await stopScanShareFacility(facilityId.value); await load(); } catch (err) { loadError.value = err.message; }
}

// ── The counter's QR ──
const qrUrl = computed(() => (facilityId.value && counter.value ? shareQrUrl(phrBaseUrl.value, facilityId.value, counter.value.trim()) : ''));
const qrImage = ref('');
watch(qrUrl, async (u) => { qrImage.value = u ? await QRCode.toDataURL(u, { width: 320, margin: 1, errorCorrectionLevel: 'M' }).catch(() => '') : ''; }, { immediate: true });
function printQr() {
  const w = window.open('', '_blank', 'width=480,height=640');
  if (!w) return;
  const title = `${facility.value?.facilityName || ''} — counter ${counter.value}`;
  w.document.write(`<!doctype html><title>${title}</title><body style="font-family:sans-serif;text-align:center;padding:2rem"><h2>${title}</h2><p>Scan with the ABHA app to share your ABHA profile and get a token</p><img src="${qrImage.value}" style="width:320px;height:320px"/><p style="font-size:12px;color:#555">${facilityId.value}</p><script>window.onload=()=>window.print()<\/script></body>`);
  w.document.close();
}

// ── Today's queue, refreshed every few seconds while this page is open ──
const shares = ref([]);
const queueError = ref('');
const onlyCounter = ref(false);
let timer = null;
async function loadQueue() {
  if (!takesShares.value) { shares.value = []; return; }
  try {
    const res = await fetchQueue({ facilityId: facilityId.value, ...(onlyCounter.value ? { context: counter.value.trim() } : {}) });
    shares.value = res.shares || [];
    queueError.value = '';
  } catch (err) {
    queueError.value = err.message;
  }
}
watch([facilityId, takesShares, onlyCounter, counter], () => {
  if (facilityId.value) store(FACILITY_KEY, facilityId.value);
  if (counter.value) store(COUNTER_KEY, counter.value);
  loadQueue();
});
onMounted(async () => { await load(); loadQueue(); timer = setInterval(loadQueue, 5000); });
onBeforeUnmount(() => clearInterval(timer));

const waiting = computed(() => shares.value.filter((s) => s.status === 'waiting').length);
const open = (s) => router.push({ path: '/registries/abha', query: { share: s.id } });
async function dismiss(s) {
  try { await dismissShare(s.id); loadQueue(); } catch (err) { queueError.value = err.message; }
}
const time = (at) => new Date(at.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const GENDER = { M: 'Male', F: 'Female', O: 'Other', T: 'Other' };
</script>

<template>
  <div class="page page-wide">
    <nav class="page-crumbs"><RouterLink to="/registries">Registries</RouterLink><i class="fas fa-chevron-right" style="font-size:.55rem"></i><span>Scan &amp; Share</span></nav>
    <div class="page-header">
      <div>
        <h1 class="page-title">Scan &amp; Share</h1>
        <p class="page-subtitle">Patients scan your counter’s QR with the ABHA app to share their verified ABHA profile and get a token. Register each share as a new or returning patient — no OTP needed, ABDM has already verified it.</p>
      </div>
      <div class="page-actions">
        <select v-model="facilityId" class="cf-input" style="min-width:16rem" :disabled="!options.length" aria-label="Facility" data-testid="scan-share-facility">
          <option v-if="!options.length" value="">{{ loading ? 'Loading facilities…' : 'No HFR facility yet' }}</option>
          <option v-for="f in options" :key="f.facilityId" :value="f.facilityId">{{ f.facilityName || 'Facility' }} — {{ f.facilityId }}</option>
        </select>
        <button type="button" class="ui-btn" style="padding:.4rem .7rem" @click="lookupOpen = !lookupOpen"><i class="fas fa-magnifying-glass"></i> Another facility</button>
      </div>
    </div>
    <form v-if="lookupOpen" class="lookup" @submit.prevent="lookupFacility">
      <input v-model="lookupId" class="cf-input" placeholder="HFR facility id, e.g. IN3310002300" aria-label="HFR facility id" />
      <button class="ui-btn ui-btn-primary" type="submit"><i class="fas fa-check"></i> Find in HFR</button>
      <span v-if="lookupError" class="err">{{ lookupError }}</span>
    </form>

    <p v-if="loadError" class="ui-banner" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c"><i class="fas fa-circle-exclamation"></i> {{ loadError }}</p>

    <section v-if="!loading && !options.length" class="panel">
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-qrcode"></i></div>
        <div class="empty-state-title">Register a facility first</div>
        <p class="empty-state-text">Scan &amp; Share belongs to an HFR facility: its HFR id is in the QR. Register yours with HFR, or find one by its HFR id (“Another facility”).</p>
        <RouterLink to="/registries/hfr" class="ui-btn ui-btn-primary" style="margin-top:.75rem"><i class="fas fa-hospital-user"></i> Facility registration</RouterLink>
      </div>
    </section>

    <!-- Not taking shares yet -->
    <section v-else-if="facility && !takesShares" class="panel">
      <div class="panel-head"><div><div class="panel-title">Take Scan &amp; Share at {{ facility.facilityName }}</div><div class="panel-sub">ABDM sends shared profiles for {{ facility.facilityId }} to ClinuxFlow once the facility is linked to ClinuxFlow’s ABDM bridge.</div></div></div>
      <form class="setup" @submit.prevent="register">
        <label class="field"><span>Name patients see in the ABHA app</span>
          <input v-model="hipName" class="cf-input" maxlength="15" placeholder="At most 15 letters, digits or spaces" data-testid="scan-share-hipname" />
        </label>
        <label class="check"><input v-model="linkWithAbdm" type="checkbox" /> Link it with ABDM now <span class="cell-muted">(HFR’s bridge API; untick if it is already linked on the HFR portal)</span></label>
        <p v-if="registerError" class="err" role="alert">{{ registerError }}</p>
        <div><button class="ui-btn ui-btn-primary" type="submit" :disabled="registering || (linkWithAbdm && !/^[A-Za-z0-9 ]{1,15}$/.test(hipName.trim()))" data-testid="scan-share-register"><i class="fas" :class="registering ? 'fa-spinner fa-spin' : 'fa-link'"></i> Start taking shares</button></div>
      </form>
    </section>

    <template v-else-if="takesShares">
      <div class="grid">
        <section class="panel">
          <div class="panel-head">
            <div><div class="panel-title">Counter QR</div><div class="panel-sub">{{ thisFacility.hipName || facility?.facilityName }}{{ thisFacility.linkedWithAbdm ? ' · linked with ABDM' : '' }}</div></div>
          </div>
          <div class="qr-box">
            <label class="field" style="max-width:10rem"><span>Counter</span><input v-model="counter" class="cf-input" maxlength="12" placeholder="1" data-testid="scan-share-counter" /></label>
            <img v-if="qrImage" :src="qrImage" alt="Scan & Share QR for this counter" class="qr" data-testid="scan-share-qr" />
            <a :href="qrUrl" target="_blank" rel="noopener noreferrer" class="cell-code" style="word-break:break-all">{{ qrUrl }}</a>
            <div style="display:flex;gap:.5rem;flex-wrap:wrap">
              <button type="button" class="ui-btn" :disabled="!qrImage" @click="printQr"><i class="fas fa-print"></i> Print</button>
              <button type="button" class="ui-btn" @click="stop"><i class="fas fa-ban"></i> Stop taking shares</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div><div class="panel-title">Today’s queue <span v-if="waiting" class="count">{{ waiting }} waiting</span></div><div class="panel-sub">Refreshes every few seconds. Shared details are kept until someone registers the patient, or for a day.</div></div>
            <label class="check" style="font-size:.78rem"><input v-model="onlyCounter" type="checkbox" /> Counter {{ counter || '—' }} only</label>
          </div>
          <p v-if="queueError" class="err" style="padding:0 1rem">{{ queueError }}</p>
          <div v-if="!shares.length" class="empty-state" style="padding:2rem 1rem">
            <div class="empty-state-icon"><i class="fas fa-mobile-screen"></i></div>
            <div class="empty-state-title">No shares yet today</div>
            <p class="empty-state-text">When a patient scans the QR, they appear here with their token.</p>
          </div>
          <div v-else class="table-wrap">
            <table class="q-table" data-testid="scan-share-queue">
              <thead><tr><th>Token</th><th>Patient</th><th>ABHA</th><th>Time</th><th></th></tr></thead>
              <tbody>
                <tr v-for="s in shares" :key="s.id" :class="s.status">
                  <td><span class="token">{{ s.tokenNumber }}</span><div class="cell-muted">counter {{ s.context || '—' }}</div></td>
                  <td>
                    <div class="cell-strong">{{ s.name || '—' }}</div>
                    <div class="cell-muted">{{ [GENDER[s.gender] || s.gender, ageFrom(s.yearOfBirth) !== null ? `${ageFrom(s.yearOfBirth)} y` : null, s.phone].filter(Boolean).join(' · ') }}</div>
                  </td>
                  <td><div class="cell-code">{{ s.abhaAddress }}</div><div class="cell-code">{{ s.abhaNumber }}</div></td>
                  <td class="cell-muted">{{ time(s.at) }}<div v-if="!s.acknowledged" class="warn" :title="s.ackError || ''">token not confirmed to ABDM</div></td>
                  <td class="actions">
                    <template v-if="s.status === 'waiting'">
                      <button type="button" class="ui-btn ui-btn-primary" style="padding:.3rem .65rem" data-testid="scan-share-open" @click="open(s)"><i class="fas fa-user-check"></i> Register</button>
                      <button type="button" class="ui-btn" style="padding:.3rem .55rem" title="Dismiss" @click="dismiss(s)"><i class="fas fa-xmark"></i></button>
                    </template>
                    <span v-else class="cell-muted">{{ s.status === 'claimed' ? 'registered' : 'dismissed' }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; padding: .9rem 1rem; border-bottom: 1px solid var(--shell-border); }
.panel-title { font-weight: 700; font-size: .9rem; color: var(--shell-text-strong); }
.panel-sub { font-size: .75rem; color: var(--shell-text-muted); margin-top: .15rem; }
.grid { display: grid; grid-template-columns: minmax(260px, 340px) 1fr; gap: 1.25rem; align-items: start; }
.grid .panel + .panel { margin-top: 0; }
.lookup { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: -.5rem 0 1rem; }
.lookup .cf-input { max-width: 18rem; }
.setup { padding: 1rem; display: flex; flex-direction: column; gap: .75rem; max-width: 34rem; }
.field { display: flex; flex-direction: column; gap: .3rem; font-size: .75rem; font-weight: 600; color: var(--shell-text-strong); }
.check { display: flex; align-items: center; gap: .45rem; font-size: .8rem; color: var(--shell-text-strong); }
.err { margin: 0; font-size: .78rem; color: #b91c1c; }
.qr-box { padding: 1rem; display: flex; flex-direction: column; gap: .75rem; align-items: flex-start; }
.qr { width: 240px; height: 240px; background: #fff; padding: .5rem; border-radius: .5rem; border: 1px solid var(--shell-border); }
.count { margin-left: .4rem; font-size: .7rem; font-weight: 700; padding: .1rem .5rem; border-radius: 99px; background: var(--color-primary-soft); color: var(--color-primary-text); }
.table-wrap { overflow-x: auto; }
.q-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
.q-table th { text-align: left; font-size: .64rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--shell-text-muted); padding: .6rem 1rem; border-bottom: 1px solid var(--shell-border); }
.q-table td { padding: .7rem 1rem; border-bottom: 1px solid var(--shell-border); vertical-align: top; color: var(--shell-text-strong); }
.q-table tr:not(.waiting) td { opacity: .6; }
.token { font-size: 1.1rem; font-weight: 800; color: var(--color-primary-text); }
.cell-strong { font-weight: 600; }
.cell-code { font-family: 'JetBrains Mono', monospace; font-size: .7rem; color: var(--shell-text-muted); }
.cell-muted { color: var(--shell-text-muted); font-size: .75rem; }
.warn { color: #b45309; font-size: .7rem; }
.actions { white-space: nowrap; text-align: right; }
.actions .ui-btn + .ui-btn { margin-left: .35rem; }
@media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
</style>
