<script setup>
// Ported from clinixflow's public/onboarding-abdm.html — HFR (facility) and HPR
// (doctor/nurse) registration against the local clinuxflow-abdm-gateway Worker, layered on top
// of the same Hospital Profile / Care Team FHIR records onboarding.html's drawer edits. Unlike
// onboarding.html, the original page kept ALL of this state (gateway connectivity, HFR step
// machine, per-staff HPR step machines, Facility Manager token) inline in its own Alpine
// component rather than a shared Alpine.store — ported the same way, as page-local state, since
// nothing here is needed by any other page.
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import LhcFormHost from '../components/LhcFormHost.vue';
import Cubo from '../components/Cubo.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import { useCuboStore } from '../stores/cubo.js';
import {
  formData, recordSummary, activeQuestionnaire, seedSystemForms,
  getAnswer, patchRecordField, patchGroupInstanceField, getGroupInstances,
} from '../data/useSystemForms.js';
import {
  buildHprAadhaarOtpBody, buildHprVerifyAadhaarOtpBody, buildHprCheckAccountBody,
  buildHprDemographicAuthBody, buildHprMobileOtpBody, buildHprVerifyMobileOtpBody,
  buildHprCreateBody, buildHprPasswordLoginBody,
  buildHfrSearchBody, buildHfrBasicInfoBody, buildHfrAdditionalInfoBody, buildHfrDetailedInfoBody, buildHfrSubmitBody,
} from '../data/abdmAdapter.js';
import { API_BASE, ABDM_GATEWAY_BASE, apiFetch } from '../config.js';

const router = useRouter();
const onboarding = useOnboardingStore();
const auth = useAuthStore();
const cubo = useCuboStore();

// This tab exists to host Cübo full-time, so start expanded rather than showing the collapsed
// FAB badge inside the tab — same page-level choice as consultation-desk.html.
cubo.currentLayout = 'EXPANDED';

const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3200);
}

const drawerOpen = ref(false);
const activeForm = ref(null);
const drawerQuestionnaire = ref(null);
const drawerRecord = ref(null);
const formKey = ref(0);
const lhcFormHost = ref(null);

const leftTab = ref('cubo');
const logsExpanded = ref(false);
// Bumped by every mutation this page makes directly to the Provider record (HFR/HPR
// patchRecordField/patchGroupInstanceField calls). The drawer's own save path goes through
// onboarding.saveProviderRecord() instead, which bumps onboarding.dataVersion — groupInstances()
// below registers both, so either path refreshes the cards/lists.
const dataVersion = ref(0);
// ALSO bumped by any formData change from ANY origin -- see onboarding.js's identical wiring for
// the full story (shared-server sync merges happen in the background on their own timer).
formData.subscribeChanges(() => { dataVersion.value++; });

// Holds the ACTIVE STAFF INSTANCE'S ARRAY INDEX now, not a record id — section_staff is a
// repeating group inside the one shared Provider record post-merge (see
// clinux-provider-composition-merge memory note), and repeating instances have no id of their
// own (getGroupInstances is addressed only by position).
const abdmActiveStaffId = ref(null);

// Every card now points at one groupLinkId inside the single, shared Provider-composition
// record instead of its own separate formId — same change as Onboarding.vue's own journeyCards.
const journeyCards = [
  { groupLinkId: 'section_hospital', mode: 'single', icon: 'fas fa-hospital', color: '#3B82F6', bg: 'rgba(59,130,246,.1)', title: 'Hospital Profile', desc: 'Your clinic profile as a FHIR Organization resource, now including HFR fields.' },
  { groupLinkId: 'section_staff', mode: 'repeatable', icon: 'fas fa-user-md', color: '#00D4B2', bg: 'rgba(0,212,178,.1)', title: 'Care Team', desc: 'Add physicians, nurses and staff as FHIR Practitioner records, now with HPR registration.' },
  { groupLinkId: 'section_services_matrix', mode: 'repeatable', icon: 'fas fa-stethoscope', color: '#8B5CF6', bg: 'rgba(139,92,246,.1)', title: 'Services', desc: 'List the services your clinic offers.' },
  { groupLinkId: 'section_hours', mode: 'repeatable', icon: 'fas fa-clock', color: '#F59E0B', bg: 'rgba(245,158,11,.1)', title: 'Office Hours', desc: 'Add operating hours, one day-range at a time.' },
  { groupLinkId: 'section_consent', mode: 'repeatable', icon: 'fas fa-file-signature', color: '#EF4444', bg: 'rgba(239,68,68,.1)', title: 'Legal Consents', desc: 'Add the consent types your clinic collects from patients.' },
  { action: 'designer', icon: 'fas fa-layer-group', color: '#06B6D4', bg: 'rgba(6,182,212,.1)', title: 'Open Designer', desc: 'Manage versions, training and the full data grid for every form.' },
];

seedSystemForms(API_BASE).catch(() => {});

// ─── Gateway ───
// clinuxflow-abdm-gateway is a separate Worker from clinuxflow-api (see its own package.json:
// "clinuxflow-api and clinuxflow-web call this service instead of talking to ABDM directly").
// Defaults to ABDM_GATEWAY_BASE (deployed gateway in production builds, localhost:8788 in dev)
// but stays user-editable/persisted, since a visitor may need to point it at a different gateway.
const gatewayUrl = ref(localStorage.getItem('cf_abdm_gateway_url') || ABDM_GATEWAY_BASE);
const gatewayStatus = ref('offline');

// ─── HFR (single hospital record) ───
const hfr = reactive({
  step: 'not_started', trackingId: null, facilityId: null, searchResults: [],
  loading: { search: false, basic: false, additional: false, detailed: false, submit: false },
  // Deferred registration -- see the panel's own comment. Defaults false (register now),
  // unchanged from before this existed.
  deferred: false,
});

const hfrStageLabel = computed(() => ({
  not_started: 'Not Started', searched: 'Searched', basic_submitted: 'Basic Info Submitted',
  additional_submitted: 'Additional Info Submitted', detailed_submitted: 'Detailed Info Submitted', submitted: 'Submitted',
}[hfr.step] || hfr.step));

// ─── HPR, keyed by staff record id ───
const hprState = reactive({});

const HPR_STAGE_LABELS = {
  not_started: 'Not Started', otp_sent: 'OTP Sent', aadhaar_verified: 'Aadhaar Verified',
  account_checked: 'Account Checked', mobile_otp_sent: 'Mobile OTP Sent', mobile_confirmed: 'Mobile Confirmed',
  mobile_verified: 'Mobile Verified', suggestions_ready: 'HPID Suggestions Ready', account_created: 'Account Created',
};
function hprStageLabel(step) {
  return HPR_STAGE_LABELS[step] || step;
}

function hprStateFor(staffIndex) {
  if (!hprState[staffIndex]) {
    hprState[staffIndex] = {
      step: 'not_started', txnId: null, maskedMobile: null, hpidExists: null,
      hpidSuggestions: [], selectedHpId: null, createdHprId: null,
      aadhaar: '', otp: '', mobile: '', mobileOtp: '', password: '', loading: false,
    };
  }
  return hprState[staffIndex];
}

// ─── Administrator Profile / Facility Manager token (memory only, never persisted) ───
const activeAdminId = ref(null);
const adminLoginForm = reactive({ hprId: '', password: '' });
const adminLoginLoading = ref(false);
const facilityManagerToken = ref(null);

/* ─── Shared card/drawer mechanism, same pattern as Onboarding.vue ─── */
function groupInstances(groupLinkId) {
  dataVersion.value; onboarding.dataVersion; // register both reactive dependencies
  return getGroupInstances(onboarding.getProviderRecord(), groupLinkId);
}

// recordSummary() expects a full { id, data: { item } } record — group instances are bare
// { linkId, item } objects with no id of their own, so wrap one the same way every other
// bare-instance read in this migration does (see formData.js's getGroupInstances doc comment).
function instanceSummary(instance, index) {
  return recordSummary({ data: instance, id: String(index) });
}

function cardStatus(card) {
  if (card.mode === 'single') return getAnswer(onboarding.getProviderRecord(), 'hospital_name') ? 'Saved' : 'Not started';
  const n = groupInstances(card.groupLinkId).length;
  return n > 0 ? `${n} added` : 'Not started';
}

// The drawer always renders the WHOLE Provider questionnaire regardless of which card was
// clicked — same "whole accumulating document everywhere" tradeoff already accepted for Front
// Desk/Checkout/Consultation Desk's Encounter composition.
function openDrawer(card) {
  activeForm.value = card;
  drawerOpen.value = true;

  const q = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  drawerQuestionnaire.value = q;
  if (!q) { drawerRecord.value = null; return; }

  drawerRecord.value = onboarding.getProviderRecord() || onboarding.buildSeedFromRegistration();
}

function openCard(card) {
  if (card.action === 'designer') router.push('/designer');
  else openDrawer(card);
}

function closeDrawer() { drawerOpen.value = false; }

function saveDrawerRecord() {
  if (!activeForm.value) return;
  const ok = onboarding.saveProviderRecord('drawerFormContainer');
  if (!ok) { showToast('Could not read the entered data. Please try again.'); return; }

  if (activeForm.value.mode === 'repeatable') {
    // Stay open — LForms' own "+ Add another" control is how multiple entries get added, not a
    // separate save-per-entry action (same pattern Front Desk/Checkout already use).
    drawerRecord.value = onboarding.getProviderRecord();
    formKey.value++;
    showToast('Added.');
    log((activeForm.value.title || activeForm.value.groupLinkId) + ' record added.', 'border-emerald-500');
  } else {
    showToast('Saved.');
    log('Hospital Profile saved.', 'border-emerald-500');
    closeDrawer();
  }
}

/* ─── System Logs — page-scoped (not per-encounter), plain localStorage, same as the original
     Alpine page's own _log()/systemLog() pair, ported to a reactive ref instead of a
     re-parse-on-every-read loop since Vue gives us real reactivity for free here. ─── */
const LOG_KEY = 'cf_abdm_onboarding_log';
function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
}
const logEntries = ref(loadLog());
function currentUserLabel() {
  const u = auth.currentUser;
  return (u && (u.adminName || u.email)) || 'Unknown user';
}
function log(msg, color = 'border-slate-700') {
  logEntries.value = [...logEntries.value, {
    id: 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    time: new Date().toISOString(), user: currentUserLabel(), action: msg, color,
  }];
  localStorage.setItem(LOG_KEY, JSON.stringify(logEntries.value));
}
function clearSystemLog() {
  logEntries.value = [];
  localStorage.setItem(LOG_KEY, JSON.stringify([]));
}

/* ─── Gateway connectivity + generic call helper ─── */
async function pingGateway() {
  gatewayStatus.value = 'pending';
  localStorage.setItem('cf_abdm_gateway_url', gatewayUrl.value);
  try {
    const res = await apiFetch(gatewayUrl.value + '/hpr/master/states');
    gatewayStatus.value = res.ok ? 'online' : 'offline';
  } catch (e) {
    gatewayStatus.value = 'offline';
  }
}

async function callGateway(method, path, body, extraHeaders) {
  try {
    const res = await apiFetch(gatewayUrl.value + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json;
    try { json = await res.json(); } catch (e) { json = { success: false, error: 'Invalid response from gateway (' + res.status + ')' }; }
    return json;
  } catch (err) {
    return { success: false, error: 'Network error contacting gateway: ' + err.message };
  }
}

/* ─── Administrator Profile ─── */
// Repeating instances have no id of their own — array position is the identity, so this returns
// { index, item } wrapper objects (same shape used throughout this file post-merge) rather than
// bare records.
function adminStaff() {
  return groupInstances('section_staff')
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => getAnswer({ data: item }, 'staff_role') === 'Administrator');
}

async function hprPasswordLogin() {
  if (!adminLoginForm.hprId || !adminLoginForm.password) { showToast('Enter an HPR ID and password.'); return; }
  adminLoginLoading.value = true;
  const body = buildHprPasswordLoginBody(adminLoginForm.hprId, adminLoginForm.password);
  const res = await callGateway('POST', '/hpr/auth/password-login', body);
  adminLoginLoading.value = false;
  adminLoginForm.password = '';
  if (res.success) {
    facilityManagerToken.value = res.token; // memory only, never persisted
    log('POST /hpr/auth/password-login → success (Facility Manager token acquired).', 'border-emerald-500');
    showToast('Logged in — Facility Manager token held.');
  } else {
    log('POST /hpr/auth/password-login → failed: ' + (res.error || 'unknown error'), 'border-red-500');
    showToast('Login failed.');
  }
}

/* ─── HFR steps ─── */
// section_hospital never repeats, so onboarding.getProviderRecord() itself is already the
// "Hospital record" — no separate lookup needed post-merge.
async function hfrSearch() {
  const hospitalRec = onboarding.getProviderRecord();
  if (!hospitalRec) { showToast('Save the Hospital Profile first.'); return; }
  hfr.loading.search = true;
  const res = await callGateway('POST', '/hfr/facility/search', buildHfrSearchBody(hospitalRec));
  hfr.loading.search = false;
  if (res.success) {
    hfr.searchResults = res.facilities || res.data || [];
    hfr.step = 'searched';
    log('POST /hfr/facility/search → success (' + hfr.searchResults.length + ' result(s)).', 'border-emerald-500');
  } else {
    log('POST /hfr/facility/search → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  }
  persistAbdmState();
}

async function hfrBasicInfo() {
  const hospitalRec = onboarding.getProviderRecord();
  if (!hospitalRec || !facilityManagerToken.value) return;
  hfr.loading.basic = true;
  const res = await callGateway('POST', '/hfr/facility/basic-information', buildHfrBasicInfoBody(hospitalRec), { 'X-HPRID-Auth-Token': facilityManagerToken.value });
  hfr.loading.basic = false;
  if (res.success) {
    hfr.trackingId = res.trackingId;
    hfr.step = 'basic_submitted';
    patchRecordField(hospitalRec.id, 'hospital_tracking_id', res.trackingId);
    dataVersion.value++;
    log('POST /hfr/facility/basic-information → success (trackingId ' + res.trackingId + ').', 'border-emerald-500');
  } else {
    log('POST /hfr/facility/basic-information → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  }
  persistAbdmState();
}

async function hfrAdditionalInfo() {
  const hospitalRec = onboarding.getProviderRecord();
  if (!hospitalRec || !hfr.trackingId) return;
  hfr.loading.additional = true;
  const res = await callGateway('POST', '/hfr/facility/additional-information', buildHfrAdditionalInfoBody(hospitalRec, hfr.trackingId));
  hfr.loading.additional = false;
  if (res.success) { hfr.step = 'additional_submitted'; log('POST /hfr/facility/additional-information → success.', 'border-emerald-500'); }
  else log('POST /hfr/facility/additional-information → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hfrDetailedInfo() {
  const hospitalRec = onboarding.getProviderRecord();
  if (!hospitalRec || !hfr.trackingId) return;
  hfr.loading.detailed = true;
  const res = await callGateway('POST', '/hfr/facility/detailed-information', buildHfrDetailedInfoBody(hospitalRec, hfr.trackingId));
  hfr.loading.detailed = false;
  if (res.success) { hfr.step = 'detailed_submitted'; log('POST /hfr/facility/detailed-information → success.', 'border-emerald-500'); }
  else log('POST /hfr/facility/detailed-information → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hfrSubmit() {
  const hospitalRec = onboarding.getProviderRecord();
  if (!hospitalRec || !hfr.trackingId || !facilityManagerToken.value) return;
  hfr.loading.submit = true;
  const res = await callGateway('POST', '/hfr/facility/submit', buildHfrSubmitBody(hospitalRec, hfr.trackingId), { 'X-HPRID-Auth-Token': facilityManagerToken.value });
  hfr.loading.submit = false;
  if (res.success) {
    hfr.facilityId = res.facilityId;
    hfr.step = 'submitted';
    patchRecordField(hospitalRec.id, 'hospital_facility_id', res.facilityId);
    dataVersion.value++;
    log('POST /hfr/facility/submit → success (facilityId ' + res.facilityId + ').', 'border-emerald-500');
    showToast('Facility submitted to HFR.');
  } else {
    log('POST /hfr/facility/submit → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  }
  persistAbdmState();
}

/* ─── HPR per-staff steps ─── */
// The adapter builders (buildHprCreateBody etc.) call getAnswer(record, linkId), which expects a
// full { data: { item } } shape — wrap the bare group instance the same way every other
// bare-instance read in this migration does.
function staffRecord(staffIndex) {
  const instance = groupInstances('section_staff')[staffIndex];
  return instance ? { data: instance } : null;
}

async function hprSendAadhaarOtp(staffIndex) {
  const st = hprStateFor(staffIndex);
  if (!st.aadhaar) { showToast('Enter an Aadhaar number.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/aadhaar-otp', buildHprAadhaarOtpBody(st.aadhaar));
  st.loading = false;
  st.aadhaar = ''; // never held longer than the single outgoing request
  if (res.success) {
    st.txnId = res.txnId; st.maskedMobile = res.maskedMobile; st.step = 'otp_sent';
    log('POST /hpr/registration/aadhaar-otp → success (masked mobile ' + res.maskedMobile + ').', 'border-emerald-500');
  } else {
    log('POST /hpr/registration/aadhaar-otp → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  }
  persistAbdmState();
}

async function hprVerifyAadhaarOtp(staffIndex) {
  const st = hprStateFor(staffIndex);
  if (!st.otp) { showToast('Enter the OTP.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/verify-aadhaar-otp', buildHprVerifyAadhaarOtpBody(st.txnId, st.otp));
  st.loading = false;
  st.otp = '';
  if (res.success) { st.step = 'aadhaar_verified'; log('POST /hpr/registration/verify-aadhaar-otp → success.', 'border-emerald-500'); }
  else log('POST /hpr/registration/verify-aadhaar-otp → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprCheckAccountExists(staffIndex) {
  const st = hprStateFor(staffIndex);
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/check-account-exists', buildHprCheckAccountBody(st.txnId));
  st.loading = false;
  if (res.success) { st.hpidExists = res.hpidExists; st.step = 'account_checked'; log('POST /hpr/registration/check-account-exists → success (hpidExists=' + res.hpidExists + ').', 'border-emerald-500'); }
  else log('POST /hpr/registration/check-account-exists → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprDemographicAuthMobile(staffIndex) {
  const st = hprStateFor(staffIndex);
  if (!st.mobile) { showToast('Enter a mobile number.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/demographic-auth-mobile', buildHprDemographicAuthBody(st.txnId, st.mobile));
  st.loading = false;
  if (res.success) { st.step = 'mobile_confirmed'; log('POST /hpr/registration/demographic-auth-mobile → success.', 'border-emerald-500'); }
  else log('POST /hpr/registration/demographic-auth-mobile → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprSendMobileOtp(staffIndex) {
  const st = hprStateFor(staffIndex);
  if (!st.mobile) { showToast('Enter a mobile number.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/mobile-otp', buildHprMobileOtpBody(st.txnId, st.mobile));
  st.loading = false;
  if (res.success) { st.step = 'mobile_otp_sent'; log('POST /hpr/registration/mobile-otp → success.', 'border-emerald-500'); }
  else log('POST /hpr/registration/mobile-otp → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprVerifyMobileOtp(staffIndex) {
  const st = hprStateFor(staffIndex);
  if (!st.mobileOtp) { showToast('Enter the mobile OTP.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/verify-mobile-otp', buildHprVerifyMobileOtpBody(st.txnId, st.mobileOtp));
  st.loading = false;
  st.mobileOtp = '';
  if (res.success) { st.step = 'mobile_verified'; log('POST /hpr/registration/verify-mobile-otp → success.', 'border-emerald-500'); }
  else log('POST /hpr/registration/verify-mobile-otp → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprFetchHpidSuggestions(staffIndex) {
  const st = hprStateFor(staffIndex);
  st.loading = true;
  const res = await callGateway('GET', '/hpr/registration/hpid-suggestions?txnId=' + encodeURIComponent(st.txnId));
  st.loading = false;
  if (res.success) {
    st.hpidSuggestions = res.suggestions?.hpIdSuggestion || res.suggestions || [];
    st.step = 'suggestions_ready';
    log('GET /hpr/registration/hpid-suggestions → success (' + st.hpidSuggestions.length + ' suggestion(s)).', 'border-emerald-500');
  } else {
    log('GET /hpr/registration/hpid-suggestions → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  }
  persistAbdmState();
}

async function hprCreateAccount(staffIndex) {
  const st = hprStateFor(staffIndex);
  const staffRec = staffRecord(staffIndex);
  if (!staffRec || !st.selectedHpId || !st.password) { showToast('Select an HPID and set a password.'); return; }
  st.loading = true;
  const body = buildHprCreateBody(staffRec, { txnId: st.txnId, selectedHpId: st.selectedHpId, password: st.password });
  const res = await callGateway('POST', '/hpr/registration/create', body);
  st.loading = false;
  st.password = '';
  if (res.success) {
    st.step = 'account_created';
    st.createdHprId = res.hprId;
    // Scoped to exactly this one repeating instance — patchRecordField's global walk would
    // otherwise write staff_hprid onto every staff member sharing that linkId (see
    // clinux-provider-composition-merge memory note).
    patchGroupInstanceField(onboarding.getProviderRecord().id, 'section_staff', staffIndex, {
      staff_hprid: res.hprId,
      staff_hpr_id_number: res.hprIdNumber,
    });
    dataVersion.value++;
    log('POST /hpr/registration/create → success (hprId ' + res.hprId + ').', 'border-emerald-500');
    showToast('HPR account created.');
  } else {
    log('POST /hpr/registration/create → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  }
  persistAbdmState();
}

/* ─── Resumable, PII-free session persistence ───
     Only derived/safe fields are written here — never aadhaar/otp/mobile/password, and never
     the Facility Manager token. */
function persistAbdmState() {
  const safeHprState = {};
  Object.keys(hprState).forEach((id) => {
    const st = hprState[id];
    safeHprState[id] = { step: st.step, txnId: st.txnId, maskedMobile: st.maskedMobile, hpidExists: st.hpidExists, hpidSuggestions: st.hpidSuggestions, selectedHpId: st.selectedHpId, createdHprId: st.createdHprId };
  });
  localStorage.setItem('cf_abdm_onboarding_session', JSON.stringify({
    hfr: { step: hfr.step, trackingId: hfr.trackingId, facilityId: hfr.facilityId, deferred: hfr.deferred },
    hprState: safeHprState,
  }));
}

function loadPersistedAbdmState() {
  try {
    const saved = JSON.parse(localStorage.getItem('cf_abdm_onboarding_session') || 'null');
    if (!saved) return;
    if (saved.hfr) Object.assign(hfr, saved.hfr, { loading: { search: false, basic: false, additional: false, detailed: false, submit: false } });
    if (saved.hprState) {
      Object.keys(saved.hprState).forEach((id) => {
        Object.assign(hprStateFor(id), saved.hprState[id], { aadhaar: '', otp: '', mobile: '', mobileOtp: '', password: '', loading: false });
      });
    }
  } catch (e) { /* corrupt/old session data — start fresh */ }
}

onMounted(() => {
  loadPersistedAbdmState();
  pingGateway();
});
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i><span>{{ toast.msg }}</span></div>

  <!-- ─── Quick-Entry Drawer ─── -->
  <div class="drawer-backdrop" :class="drawerOpen ? 'open' : ''" @click="closeDrawer()"></div>
  <div class="drawer-panel" :class="drawerOpen ? 'open' : ''">
    <div class="drawer-header">
      <div>
        <h3 style="font-size:.95rem;font-weight:700;color:var(--cf-text-strong);display:flex;align-items:center;gap:.5rem">
          <i :class="activeForm ? activeForm.icon : 'fas fa-file-lines'" :style="activeForm ? `color:${activeForm.color}` : ''"></i>
          <span>{{ activeForm ? activeForm.title : '' }}</span>
        </h3>
        <p style="font-size:.72rem;color:var(--cf-text);margin-top:.15rem">{{ activeForm ? activeForm.desc : '' }}</p>
      </div>
      <button @click="closeDrawer()" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <div class="preview-panel">
        <LhcFormHost v-if="drawerOpen" :key="formKey" ref="lhcFormHost" :questionnaire="drawerQuestionnaire" :record="drawerRecord" container-id="drawerFormContainer" />
      </div>

      <!-- Hospital (single mode): ABDM Facility Registration sub-panel, always shown below the
           form once a Hospital record exists. Hidden entirely for a standalone individual
           practitioner (facilityType === 'individual', see Register form's own fork +
           migrations/0005) -- there's no facility to register with HFR at all; they go straight
           to their own HPR registration under the Care Team panel below instead. -->
      <div v-if="activeForm && activeForm.groupLinkId === 'section_hospital' && auth.currentUser?.facilityType !== 'individual'" class="abdm-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
          <p class="cf-label" style="margin:0"><i class="fas fa-satellite-dish mr-1.5"></i>ABDM Facility Registration (HFR)</p>
          <span class="abdm-stage-badge" :class="'abdm-stage-' + hfr.step">{{ hfr.deferred ? 'Deferred' : hfrStageLabel }}</span>
        </div>

        <!-- Deferred registration: the Hospital Profile fields above are collected exactly the
             same either way (same drawer/record as Onboarding.vue) -- this toggle only decides
             whether the ACTUAL ABDM network calls happen now or get put off until someone
             explicitly comes back and flips it off. Nothing here is submitted while deferred. -->
        <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;cursor:pointer;font-size:.78rem;color:var(--cf-text)">
          <input type="checkbox" v-model="hfr.deferred" @change="persistAbdmState()" />
          Register with ABDM later — just save these details for now
        </label>

        <template v-if="hfr.deferred">
          <p style="font-size:.78rem;color:var(--cf-text);padding:.6rem;background:var(--cf-bg);border-radius:.5rem">
            <i class="fas fa-clock mr-1.5" style="color:var(--color-primary)"></i>ABDM facility registration is deferred. Hospital Profile details are saved — come back here and untick the box above whenever you're ready to submit to HFR.
          </p>
        </template>
        <template v-else>
          <p v-show="!facilityManagerToken" style="font-size:.72rem;color:var(--cf-text);margin-bottom:.75rem">
            <i class="fas fa-circle-exclamation mr-1" style="color:#F59E0B"></i>Log in as the acting Facility Manager on the <strong>Administrator Profile</strong> tab first — Basic Information and Submit need that token.
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:.5rem">
            <button class="abdm-step-btn" :disabled="hfr.loading.search" @click="hfrSearch()"><i class="fas" :class="hfr.loading.search ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i>Search Facility</button>
            <button class="abdm-step-btn" :disabled="hfr.loading.basic || !facilityManagerToken" @click="hfrBasicInfo()"><i class="fas" :class="hfr.loading.basic ? 'fa-spinner fa-spin' : 'fa-file'"></i>Basic Information</button>
            <button class="abdm-step-btn" :disabled="hfr.loading.additional || !hfr.trackingId" @click="hfrAdditionalInfo()"><i class="fas" :class="hfr.loading.additional ? 'fa-spinner fa-spin' : 'fa-file-circle-plus'"></i>Additional Information</button>
            <button class="abdm-step-btn" :disabled="hfr.loading.detailed || !hfr.trackingId" @click="hfrDetailedInfo()"><i class="fas" :class="hfr.loading.detailed ? 'fa-spinner fa-spin' : 'fa-list-check'"></i>Detailed Information</button>
            <button class="abdm-step-btn" :disabled="hfr.loading.submit || !hfr.trackingId || !facilityManagerToken" @click="hfrSubmit()"><i class="fas" :class="hfr.loading.submit ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i>Submit</button>
          </div>
          <div style="margin-top:.75rem;font-size:.75rem;color:var(--cf-text);display:flex;flex-direction:column;gap:.25rem">
            <span v-show="hfr.trackingId">Tracking ID: <strong>{{ hfr.trackingId }}</strong></span>
            <span v-show="hfr.facilityId">Facility ID: <strong>{{ hfr.facilityId }}</strong></span>
          </div>
        </template>
      </div>

      <!-- Care Team only: a selection list so a specific staff member's HPR sub-panel can be
           opened — add/remove itself is LForms' native "+ Add another" control now (same as
           Onboarding.vue), but this file's per-instance HPR registration flow still needs a way
           to pick WHICH instance. Repeating instances have no id of their own, so array position
           (idx) is the identity throughout. -->
      <div v-if="activeForm && activeForm.groupLinkId === 'section_staff'" style="margin-top:1.25rem">
        <p class="cf-label" style="margin-bottom:.6rem">Care Team ({{ groupInstances('section_staff').length }}) — select a staff member to manage HPR registration</p>
        <div v-show="groupInstances('section_staff').length === 0" style="font-size:.82rem;color:var(--cf-text);padding:.5rem 0">Nothing added yet.</div>
        <div style="display:flex;flex-direction:column;gap:.5rem">
          <div v-for="(instance, idx) in groupInstances('section_staff')" :key="idx">
            <div class="record-card">
              <span style="font-size:.85rem;color:var(--cf-text-strong);font-weight:600">{{ instanceSummary(instance, idx) }}</span>
              <div style="display:flex;align-items:center;gap:.6rem;flex-shrink:0">
                <button @click="abdmActiveStaffId = (abdmActiveStaffId === idx ? null : idx)" class="abdm-step-btn" style="padding:.25rem .6rem">
                  <i class="fas fa-satellite-dish"></i><span>{{ abdmActiveStaffId === idx ? 'Hide HPR' : 'HPR' }}</span>
                </button>
              </div>
            </div>

            <!-- Per-staff-member ABDM Professional Registration sub-panel -->
            <div v-if="abdmActiveStaffId === idx" class="abdm-panel">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
                <p class="cf-label" style="margin:0"><i class="fas fa-satellite-dish mr-1.5"></i>ABDM Professional Registration (HPR)</p>
                <span class="abdm-stage-badge" :class="'abdm-stage-' + hprStateFor(idx).step">{{ hprStageLabel(hprStateFor(idx).step) }}</span>
              </div>

              <div v-if="hprStateFor(idx).step === 'not_started'" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                <div style="flex:1;min-width:180px">
                  <label class="cf-label" style="font-size:.7rem">Aadhaar Number</label>
                  <input class="cf-input" v-model="hprStateFor(idx).aadhaar" placeholder="12-digit Aadhaar" maxlength="12" />
                </div>
                <button class="abdm-step-btn" :disabled="hprStateFor(idx).loading" @click="hprSendAadhaarOtp(idx)"><i class="fas" :class="hprStateFor(idx).loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i>Send OTP</button>
              </div>

              <div v-if="hprStateFor(idx).step === 'otp_sent'" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                <p style="font-size:.72rem;color:var(--cf-text);width:100%">OTP sent to <strong>{{ hprStateFor(idx).maskedMobile }}</strong></p>
                <div style="flex:1;min-width:120px">
                  <label class="cf-label" style="font-size:.7rem">OTP</label>
                  <input class="cf-input" v-model="hprStateFor(idx).otp" placeholder="6-digit OTP" maxlength="6" />
                </div>
                <button class="abdm-step-btn" :disabled="hprStateFor(idx).loading" @click="hprVerifyAadhaarOtp(idx)"><i class="fas" :class="hprStateFor(idx).loading ? 'fa-spinner fa-spin' : 'fa-check'"></i>Verify</button>
              </div>

              <div v-if="hprStateFor(idx).step === 'aadhaar_verified'" style="display:flex;gap:.5rem;flex-wrap:wrap">
                <button class="abdm-step-btn" :disabled="hprStateFor(idx).loading" @click="hprCheckAccountExists(idx)"><i class="fas" :class="hprStateFor(idx).loading ? 'fa-spinner fa-spin' : 'fa-user-check'"></i>Check Existing Account</button>
              </div>

              <div v-if="hprStateFor(idx).step === 'account_checked'">
                <p style="font-size:.72rem;color:var(--cf-text);margin-bottom:.5rem">{{ hprStateFor(idx).hpidExists ? 'An HPID already exists for this Aadhaar.' : 'No existing HPID found — confirm mobile to continue.' }}</p>
                <div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                  <div style="flex:1;min-width:160px">
                    <label class="cf-label" style="font-size:.7rem">Mobile Number</label>
                    <input class="cf-input" v-model="hprStateFor(idx).mobile" placeholder="10-digit mobile" maxlength="10" />
                  </div>
                  <button class="abdm-step-btn" :disabled="hprStateFor(idx).loading" @click="hprDemographicAuthMobile(idx)"><i class="fas" :class="hprStateFor(idx).loading ? 'fa-spinner fa-spin' : 'fa-mobile-screen'"></i>Confirm (Aadhaar-linked)</button>
                  <button class="abdm-step-btn" :disabled="hprStateFor(idx).loading" @click="hprSendMobileOtp(idx)"><i class="fas" :class="hprStateFor(idx).loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i>Send OTP instead</button>
                </div>
              </div>

              <div v-if="hprStateFor(idx).step === 'mobile_otp_sent'" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                <div style="flex:1;min-width:120px">
                  <label class="cf-label" style="font-size:.7rem">Mobile OTP</label>
                  <input class="cf-input" v-model="hprStateFor(idx).mobileOtp" placeholder="6-digit OTP" maxlength="6" />
                </div>
                <button class="abdm-step-btn" :disabled="hprStateFor(idx).loading" @click="hprVerifyMobileOtp(idx)"><i class="fas" :class="hprStateFor(idx).loading ? 'fa-spinner fa-spin' : 'fa-check'"></i>Verify Mobile OTP</button>
              </div>

              <div v-if="['mobile_confirmed', 'mobile_verified'].includes(hprStateFor(idx).step)" style="display:flex;gap:.5rem;flex-wrap:wrap">
                <button class="abdm-step-btn" :disabled="hprStateFor(idx).loading" @click="hprFetchHpidSuggestions(idx)"><i class="fas" :class="hprStateFor(idx).loading ? 'fa-spinner fa-spin' : 'fa-list'"></i>Fetch HPID Suggestions</button>
              </div>

              <div v-if="hprStateFor(idx).step === 'suggestions_ready'">
                <p style="font-size:.72rem;color:var(--cf-text);margin-bottom:.5rem">Pick an HPID, then set a password to create the account. First/Last name, category, state/district and role come from this record's <strong>ABDM Professional Registration</strong> fields above.</p>
                <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.6rem">
                  <button v-for="hpid in hprStateFor(idx).hpidSuggestions" :key="hpid" class="tag-chip" :style="hprStateFor(idx).selectedHpId === hpid ? 'outline:2px solid var(--color-primary)' : ''" @click="hprStateFor(idx).selectedHpId = hpid">{{ hpid }}</button>
                </div>
                <div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                  <div style="flex:1;min-width:160px">
                    <label class="cf-label" style="font-size:.7rem">Set Account Password</label>
                    <input class="cf-input" type="password" v-model="hprStateFor(idx).password" placeholder="Min 8 characters" />
                  </div>
                  <button class="abdm-step-btn" :disabled="hprStateFor(idx).loading || !hprStateFor(idx).selectedHpId" @click="hprCreateAccount(idx)"><i class="fas" :class="hprStateFor(idx).loading ? 'fa-spinner fa-spin' : 'fa-user-plus'"></i>Create HPR Account</button>
                </div>
              </div>

              <p v-if="hprStateFor(idx).step === 'account_created'" style="font-size:.8rem;color:#10B981"><i class="fas fa-circle-check mr-1"></i>HPR ID <strong>{{ hprStateFor(idx).createdHprId }}</strong> created and saved to this staff record.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="drawer-footer">
      <button v-if="activeForm && activeForm.mode === 'single'" class="btn-teal" @click="saveDrawerRecord()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-save"></i>Save</button>
      <button v-if="activeForm && activeForm.mode === 'repeatable'" class="btn-teal" @click="saveDrawerRecord()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i>Add</button>
    </div>
  </div>

  <main style="flex:1;overflow-y:auto">
  <div style="max-width:1400px;margin:0 auto;padding:1.5rem 1.5rem 3rem">

    <!-- Header row: Gateway connectivity -->
    <div class="cf-card" style="border-radius:1rem;padding:1rem 1.25rem;margin-bottom:1.25rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem">
      <div>
        <p class="cf-label" style="margin-bottom:.2rem">ABDM Sandbox Onboarding</p>
        <p style="font-size:.75rem;color:var(--cf-text)">HPR (doctors/nurses) and HFR (facility) registration, via the local <code>clinuxflow-abdm-gateway</code> Worker.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <label style="text-transform:uppercase;font-size:.65rem;font-weight:700;color:var(--cf-text)">Gateway Connection</label>
        <div style="display:flex;align-items:center;gap:.5rem">
          <span class="abdm-stage-badge" :class="'abdm-stage-' + gatewayStatus">{{ gatewayStatus }}</span>
          <input class="cf-input" style="width:220px;font-size:.75rem;padding:.4rem .6rem" v-model="gatewayUrl" placeholder="http://localhost:8788" />
          <button class="abdm-step-btn" @click="pingGateway()"><i class="fas fa-plug"></i>Ping</button>
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:380px 1fr;gap:1.25rem;align-items:start">

      <!-- LEFT PANE: tools -->
      <div class="cf-card" style="border-radius:1rem;overflow:hidden;display:flex;flex-direction:column;min-height:520px">
        <div class="flex border-b border-gray-100 dark:border-slate-800">
          <button @click="leftTab = 'cubo'" class="flex-1 text-xs font-bold py-2.5 flex items-center justify-center gap-1.5" :class="leftTab === 'cubo' ? 'text-[#00D4B2] border-b-2 border-[#00D4B2]' : 'text-gray-500 dark:text-slate-400'">
            <i class="fas fa-shield-alt"></i>Cübo Assistant
          </button>
          <button @click="leftTab = 'admin'" class="flex-1 text-xs font-bold py-2.5 flex items-center justify-center gap-1.5" :class="leftTab === 'admin' ? 'text-[#00D4B2] border-b-2 border-[#00D4B2]' : 'text-gray-500 dark:text-slate-400'">
            <i class="fas fa-user-shield"></i>Administrator Profile
          </button>
        </div>

        <!-- Tab 1: Cübo — real, unmodified component, embedded inline (same trick as
             consultation-desk.html; not a fork of the shared component). -->
        <div v-show="leftTab === 'cubo'" class="cubo-inline-host flex-1" style="min-height:420px">
          <Cubo category="abdm-facility" page-context="Current Page: ClinixFlow ABDM Onboarding." />
        </div>

        <!-- Tab 2: Administrator Profile -->
        <div v-show="leftTab === 'admin'" class="flex-1 flex flex-col p-3" style="gap:.75rem">
          <p class="cf-label" style="margin-bottom:.4rem">Administrators ({{ adminStaff().length }})</p>
          <div style="display:flex;flex-direction:column;gap:.5rem">
            <div v-for="admin in adminStaff()" :key="admin.index" class="record-card" :style="activeAdminId === admin.index ? 'border-color:var(--color-primary)' : ''">
              <span style="font-size:.82rem;color:var(--cf-text-strong);font-weight:600">{{ instanceSummary(admin.item, admin.index) }}</span>
              <button class="abdm-step-btn" style="padding:.25rem .6rem" @click="activeAdminId = admin.index">{{ activeAdminId === admin.index ? 'Selected' : 'Select' }}</button>
            </div>
            <p v-show="adminStaff().length === 0" style="font-size:.78rem;color:var(--cf-text)">No staff with role "Administrator" yet — add one via the Care Team card.</p>
          </div>

          <div class="abdm-panel" style="margin-top:.5rem">
            <p class="cf-label" style="margin-bottom:.5rem"><i class="fas fa-key mr-1.5"></i>Facility Manager Login (HPR)</p>
            <p style="font-size:.7rem;color:var(--cf-text);margin-bottom:.6rem">Obtains the per-user token HFR's write calls need. Held in memory only for this session — never saved to localStorage.</p>
            <div style="display:flex;flex-direction:column;gap:.5rem">
              <input class="cf-input" v-model="adminLoginForm.hprId" placeholder="HPR ID" />
              <input class="cf-input" type="password" v-model="adminLoginForm.password" placeholder="Password" />
              <button class="abdm-step-btn" :disabled="adminLoginLoading" @click="hprPasswordLogin()"><i class="fas" :class="adminLoginLoading ? 'fa-spinner fa-spin' : 'fa-right-to-bracket'"></i>Log In</button>
            </div>
            <p style="margin-top:.6rem;font-size:.75rem" :style="facilityManagerToken ? 'color:#10B981' : 'color:var(--cf-text)'">
              <i class="fas" :class="facilityManagerToken ? 'fa-circle-check' : 'fa-circle-info'"></i>
              <span>{{ facilityManagerToken ? 'Token held — Hospital HFR actions are enabled.' : 'No token held yet.' }}</span>
            </p>
          </div>
        </div>
      </div>

      <!-- RIGHT PANE: data — same 6-card grid as Onboarding.vue -->
      <div class="cf-card" style="border-radius:1rem;padding:1.25rem">
        <p class="cf-label" style="margin-bottom:1rem">Clinic & ABDM Profile</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
          <button v-for="card in journeyCards" :key="card.groupLinkId || card.title" class="entry-card" @click="openCard(card)">
            <div style="width:36px;height:36px;border-radius:.625rem;display:flex;align-items:center;justify-content:center;margin-bottom:.75rem" :style="`background:${card.bg}`">
              <i :class="card.icon" :style="`color:${card.color};font-size:.9rem`"></i>
            </div>
            <p style="font-weight:700;font-size:.85rem;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ card.title }}</p>
            <p style="font-size:.75rem;color:var(--cf-text);line-height:1.45;margin-bottom:.5rem">{{ card.desc }}</p>
            <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <span v-show="card.action === 'designer'" style="font-size:.72rem;color:var(--color-primary);font-weight:600;font-family:'Poppins',sans-serif"><i class="fas fa-arrow-right" style="margin-right:.3rem"></i>Open Designer</span>
              <span v-show="card.groupLinkId" class="badge" :class="cardStatus(card) !== 'Not started' ? 'badge-teal' : 'badge-muted'">{{ cardStatus(card) }}</span>
              <span v-show="card.groupLinkId === 'section_hospital'" class="abdm-stage-badge" :class="'abdm-stage-' + hfr.step">{{ 'HFR: ' + hfrStageLabel }}</span>
            </div>
          </button>
        </div>
      </div>

    </div>

    <!-- System Logs -->
    <div class="bg-slate-900 rounded-xl text-slate-300 border border-slate-800 shadow-sm overflow-hidden mt-4">
      <button @click="logsExpanded = !logsExpanded" class="w-full flex justify-between items-center px-4 py-2.5 cursor-pointer">
        <span class="text-[10px] font-mono tracking-wider font-bold text-emerald-400 flex items-center gap-2">
          <i class="fas fa-chevron-right transition-transform" :class="logsExpanded ? 'rotate-90' : ''"></i>
          SYSTEM LOGS
          <span class="text-gray-500 font-normal" v-show="logEntries.length > 0">({{ logEntries.length }})</span>
        </span>
        <span @click.stop="clearSystemLog()" class="text-[10px] hover:text-red-400">CLEAR</span>
      </button>
      <div v-show="logsExpanded" class="border-t border-slate-800 px-4 py-3">
        <div class="overflow-y-auto text-[11px] font-mono space-y-2 max-h-52 pr-2">
          <div v-for="entry in logEntries" :key="entry.id" class="p-1.5 rounded bg-slate-950/50 border-l-2" :class="entry.color || 'border-slate-700'">
            <span class="text-gray-500 text-[9px] mr-2">{{ new Date(entry.time).toLocaleTimeString() }}</span>
            <span class="font-semibold text-gray-400 mr-1">{{ entry.user + ':' }}</span>
            <span>{{ entry.action }}</span>
          </div>
          <p v-show="logEntries.length === 0" class="text-gray-600 text-[10px]">No activity yet.</p>
        </div>
      </div>
    </div>

  </div>
  </main>
</template>

<style>
/* ─── ABDM registration sub-panel + stage badges — specific to this page only ─── */
.abdm-panel { margin-top:1rem;padding:1rem;border:1px dashed var(--cf-border);border-radius:.75rem;background:var(--cf-bg); }
.abdm-stage-badge { padding:.18rem .6rem;border-radius:99px;font-size:.68rem;font-weight:700;font-family:'Poppins',sans-serif;white-space:nowrap; }
.abdm-stage-not_started, .abdm-stage-offline { background:var(--cf-bg-alt);color:var(--cf-text);border:1px solid var(--cf-border); }
.abdm-stage-pending, .abdm-stage-otp_sent, .abdm-stage-searched, .abdm-stage-basic_submitted, .abdm-stage-additional_submitted, .abdm-stage-detailed_submitted {
  background:rgba(59,130,246,.12);color:#3B82F6;border:1px solid rgba(59,130,246,.3);
}
.abdm-stage-account_created, .abdm-stage-submitted, .abdm-stage-online {
  background:rgba(16,185,129,.12);color:#10B981;border:1px solid rgba(16,185,129,.3);
}
.abdm-step-btn { font-size:.72rem;font-weight:600;font-family:'Poppins',sans-serif;padding:.4rem .75rem;border-radius:.5rem;border:1px solid var(--color-primary);color:var(--color-primary);background:transparent;cursor:pointer;display:inline-flex;align-items:center;gap:.35rem;transition:all .15s; }
.abdm-step-btn:hover:not(:disabled) { background:var(--color-primary);color:var(--color-secondary); }
.abdm-step-btn:disabled { opacity:.45;cursor:not-allowed; }
</style>
