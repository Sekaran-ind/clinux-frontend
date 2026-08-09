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
  listDataRecords, recordSummary, activeQuestionnaire, deleteDataRecord, seedSystemForms,
  saveDataRecord, activeVersionNumber, getAnswer, patchRecordField,
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

const confirmDel = reactive({ show: false, msg: '', action: () => {} });

const drawerOpen = ref(false);
const activeForm = ref(null);
const drawerQuestionnaire = ref(null);
const drawerRecord = ref(null);
const formKey = ref(0);
const lhcFormHost = ref(null);

const leftTab = ref('cubo');
const logsExpanded = ref(false);
// Bumped by every mutation this page makes directly to a record (HFR/HPR patchRecordField
// calls, repeatable add/remove). The Hospital single-record save path goes through
// onboarding.saveHospitalRecord() instead, which bumps onboarding.dataVersion — listRecords()
// below registers both, so either path refreshes the cards/lists.
const dataVersion = ref(0);

const abdmActiveStaffId = ref(null);

const journeyCards = [
  { formId: 'system-hospital-profile-v1', mode: 'single', icon: 'fas fa-hospital', color: '#3B82F6', bg: 'rgba(59,130,246,.1)', title: 'Hospital Profile', desc: 'Your clinic profile as a FHIR Organization resource, now including HFR fields.' },
  { formId: 'system-staff-profile-v1', mode: 'repeatable', icon: 'fas fa-user-md', color: '#00D4B2', bg: 'rgba(0,212,178,.1)', title: 'Care Team', desc: 'Add physicians, nurses and staff as FHIR Practitioner records, now with HPR registration.' },
  { formId: 'system-services-profile-v1', mode: 'repeatable', icon: 'fas fa-stethoscope', color: '#8B5CF6', bg: 'rgba(139,92,246,.1)', title: 'Services', desc: 'List the services your clinic offers.' },
  { formId: 'system-office-hours-profile-v1', mode: 'repeatable', icon: 'fas fa-clock', color: '#F59E0B', bg: 'rgba(245,158,11,.1)', title: 'Office Hours', desc: 'Add operating hours, one day-range at a time.' },
  { formId: 'system-consents-profile-v1', mode: 'repeatable', icon: 'fas fa-file-signature', color: '#EF4444', bg: 'rgba(239,68,68,.1)', title: 'Legal Consents', desc: 'Add the consent types your clinic collects from patients.' },
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

function hprStateFor(staffId) {
  if (!hprState[staffId]) {
    hprState[staffId] = {
      step: 'not_started', txnId: null, maskedMobile: null, hpidExists: null,
      hpidSuggestions: [], selectedHpId: null, createdHprId: null,
      aadhaar: '', otp: '', mobile: '', mobileOtp: '', password: '', loading: false,
    };
  }
  return hprState[staffId];
}

// ─── Administrator Profile / Facility Manager token (memory only, never persisted) ───
const activeAdminId = ref(null);
const adminLoginForm = reactive({ hprId: '', password: '' });
const adminLoginLoading = ref(false);
const facilityManagerToken = ref(null);

/* ─── Shared card/drawer mechanism, same pattern as Onboarding.vue ─── */
function listRecords(formId) {
  dataVersion.value; onboarding.dataVersion; // register both reactive dependencies
  return listDataRecords(formId);
}

function cardStatus(card) {
  if (card.mode === 'single') return listRecords(card.formId).length > 0 ? 'Saved' : 'Not started';
  const n = listRecords(card.formId).length;
  return n > 0 ? `${n} added` : 'Not started';
}

function openDrawer(formId) {
  const card = journeyCards.find((c) => c.formId === formId);
  if (!card) return;
  activeForm.value = card;
  drawerOpen.value = true;

  const q = activeQuestionnaire(formId);
  drawerQuestionnaire.value = q;
  if (!q) { drawerRecord.value = null; return; }

  if (card.mode === 'single') {
    const existing = listDataRecords(formId)[0]
      || (formId === onboarding.HOSPITAL_FORM_ID ? onboarding.buildSeedFromRegistration() : null);
    drawerRecord.value = existing;
  } else {
    drawerRecord.value = null;
  }
}

function openCard(card) {
  if (card.action === 'designer') router.push('/designer');
  else openDrawer(card.formId);
}

function closeDrawer() { drawerOpen.value = false; }

function saveDrawerRecord() {
  if (!activeForm.value) return;
  const formId = activeForm.value.formId;

  if (activeForm.value.mode === 'single') {
    const ok = onboarding.saveHospitalRecord('drawerFormContainer');
    if (ok) { showToast('Saved.'); log('Hospital Profile saved.', 'border-emerald-500'); closeDrawer(); }
    else showToast('Could not read the entered data. Please try again.');
    return;
  }

  const qr = lhcFormHost.value?.extract();
  if (!qr) { showToast('Could not read the entered data. Please try again.'); return; }
  saveDataRecord(formId, activeVersionNumber(formId), qr);
  dataVersion.value++;
  drawerRecord.value = null;
  formKey.value++;
  showToast('Added.');
  log((activeForm.value.title || formId) + ' record added.', 'border-emerald-500');
}

function askRemoveDrawerRecord(recordId, label) {
  const formId = activeForm.value.formId;
  confirmDel.show = true;
  confirmDel.msg = `Remove "${label}"?`;
  confirmDel.action = () => {
    deleteDataRecord(recordId);
    dataVersion.value++;
    if (abdmActiveStaffId.value === recordId) abdmActiveStaffId.value = null;
    showToast('Removed.');
  };
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
function adminStaff() {
  dataVersion.value; onboarding.dataVersion;
  return listDataRecords(onboarding.STAFF_FORM_ID).filter((r) => getAnswer(r, 'staff_role') === 'Administrator');
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
function hospitalRecord() {
  return listDataRecords(onboarding.HOSPITAL_FORM_ID)[0] || null;
}

async function hfrSearch() {
  const hospitalRec = hospitalRecord();
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
  const hospitalRec = hospitalRecord();
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
  const hospitalRec = hospitalRecord();
  if (!hospitalRec || !hfr.trackingId) return;
  hfr.loading.additional = true;
  const res = await callGateway('POST', '/hfr/facility/additional-information', buildHfrAdditionalInfoBody(hospitalRec, hfr.trackingId));
  hfr.loading.additional = false;
  if (res.success) { hfr.step = 'additional_submitted'; log('POST /hfr/facility/additional-information → success.', 'border-emerald-500'); }
  else log('POST /hfr/facility/additional-information → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hfrDetailedInfo() {
  const hospitalRec = hospitalRecord();
  if (!hospitalRec || !hfr.trackingId) return;
  hfr.loading.detailed = true;
  const res = await callGateway('POST', '/hfr/facility/detailed-information', buildHfrDetailedInfoBody(hospitalRec, hfr.trackingId));
  hfr.loading.detailed = false;
  if (res.success) { hfr.step = 'detailed_submitted'; log('POST /hfr/facility/detailed-information → success.', 'border-emerald-500'); }
  else log('POST /hfr/facility/detailed-information → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hfrSubmit() {
  const hospitalRec = hospitalRecord();
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
function staffRecord(staffId) {
  return listDataRecords(onboarding.STAFF_FORM_ID).find((r) => r.id === staffId) || null;
}

async function hprSendAadhaarOtp(staffId) {
  const st = hprStateFor(staffId);
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

async function hprVerifyAadhaarOtp(staffId) {
  const st = hprStateFor(staffId);
  if (!st.otp) { showToast('Enter the OTP.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/verify-aadhaar-otp', buildHprVerifyAadhaarOtpBody(st.txnId, st.otp));
  st.loading = false;
  st.otp = '';
  if (res.success) { st.step = 'aadhaar_verified'; log('POST /hpr/registration/verify-aadhaar-otp → success.', 'border-emerald-500'); }
  else log('POST /hpr/registration/verify-aadhaar-otp → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprCheckAccountExists(staffId) {
  const st = hprStateFor(staffId);
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/check-account-exists', buildHprCheckAccountBody(st.txnId));
  st.loading = false;
  if (res.success) { st.hpidExists = res.hpidExists; st.step = 'account_checked'; log('POST /hpr/registration/check-account-exists → success (hpidExists=' + res.hpidExists + ').', 'border-emerald-500'); }
  else log('POST /hpr/registration/check-account-exists → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprDemographicAuthMobile(staffId) {
  const st = hprStateFor(staffId);
  if (!st.mobile) { showToast('Enter a mobile number.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/demographic-auth-mobile', buildHprDemographicAuthBody(st.txnId, st.mobile));
  st.loading = false;
  if (res.success) { st.step = 'mobile_confirmed'; log('POST /hpr/registration/demographic-auth-mobile → success.', 'border-emerald-500'); }
  else log('POST /hpr/registration/demographic-auth-mobile → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprSendMobileOtp(staffId) {
  const st = hprStateFor(staffId);
  if (!st.mobile) { showToast('Enter a mobile number.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/mobile-otp', buildHprMobileOtpBody(st.txnId, st.mobile));
  st.loading = false;
  if (res.success) { st.step = 'mobile_otp_sent'; log('POST /hpr/registration/mobile-otp → success.', 'border-emerald-500'); }
  else log('POST /hpr/registration/mobile-otp → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprVerifyMobileOtp(staffId) {
  const st = hprStateFor(staffId);
  if (!st.mobileOtp) { showToast('Enter the mobile OTP.'); return; }
  st.loading = true;
  const res = await callGateway('POST', '/hpr/registration/verify-mobile-otp', buildHprVerifyMobileOtpBody(st.txnId, st.mobileOtp));
  st.loading = false;
  st.mobileOtp = '';
  if (res.success) { st.step = 'mobile_verified'; log('POST /hpr/registration/verify-mobile-otp → success.', 'border-emerald-500'); }
  else log('POST /hpr/registration/verify-mobile-otp → failed: ' + (res.error || 'unknown error'), 'border-red-500');
  persistAbdmState();
}

async function hprFetchHpidSuggestions(staffId) {
  const st = hprStateFor(staffId);
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

async function hprCreateAccount(staffId) {
  const st = hprStateFor(staffId);
  const staffRec = staffRecord(staffId);
  if (!staffRec || !st.selectedHpId || !st.password) { showToast('Select an HPID and set a password.'); return; }
  st.loading = true;
  const body = buildHprCreateBody(staffRec, { txnId: st.txnId, selectedHpId: st.selectedHpId, password: st.password });
  const res = await callGateway('POST', '/hpr/registration/create', body);
  st.loading = false;
  st.password = '';
  if (res.success) {
    st.step = 'account_created';
    st.createdHprId = res.hprId;
    patchRecordField(staffId, 'staff_hprid', res.hprId);
    patchRecordField(staffId, 'staff_hpr_id_number', res.hprIdNumber);
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
    hfr: { step: hfr.step, trackingId: hfr.trackingId, facilityId: hfr.facilityId },
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

  <div class="modal-backdrop" v-show="confirmDel.show" @click.self="confirmDel.show = false">
    <div class="modal-box" style="max-width:380px" @click.stop>
      <div style="text-align:center;padding-bottom:1rem">
        <div style="width:52px;height:52px;border-radius:50%;background:rgba(239,68,68,.1);display:flex;align-items:center;justify-content:center;margin:0 auto .875rem"><i class="fas fa-trash text-red-500 text-lg"></i></div>
        <h3 style="font-family:'Poppins',sans-serif;font-weight:700;color:var(--cf-text-strong);margin-bottom:.5rem">Remove Record?</h3>
        <p style="font-size:.85rem;color:var(--cf-text)">{{ confirmDel.msg }}</p>
      </div>
      <div style="display:flex;gap:.625rem;justify-content:flex-end;margin-top:1.25rem">
        <button class="btn-ghost" @click="confirmDel.show = false">Cancel</button>
        <button style="background:#EF4444;color:#fff;font-family:'Poppins',sans-serif;font-weight:700;padding:.5rem 1.25rem;border-radius:.5rem;border:none;cursor:pointer;font-size:.85rem" @click="confirmDel.action(); confirmDel.show = false">Delete</button>
      </div>
    </div>
  </div>

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
           form once a Hospital record exists -->
      <div v-if="activeForm && activeForm.formId === 'system-hospital-profile-v1'" class="abdm-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
          <p class="cf-label" style="margin:0"><i class="fas fa-satellite-dish mr-1.5"></i>ABDM Facility Registration (HFR)</p>
          <span class="abdm-stage-badge" :class="'abdm-stage-' + hfr.step">{{ hfrStageLabel }}</span>
        </div>
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
      </div>

      <!-- Repeatable forms (Care Team, Services, Office Hours, Legal Consents) show a running
           list of what's already been added, right below the form. -->
      <div v-if="activeForm && activeForm.mode === 'repeatable'" style="margin-top:1.25rem">
        <p class="cf-label" style="margin-bottom:.6rem">Added so far ({{ listRecords(activeForm.formId).length }})</p>
        <div v-show="listRecords(activeForm.formId).length === 0" style="font-size:.82rem;color:var(--cf-text);padding:.5rem 0">Nothing added yet.</div>
        <div style="display:flex;flex-direction:column;gap:.5rem">
          <div v-for="rec in listRecords(activeForm.formId)" :key="rec.id">
            <div class="record-card">
              <span style="font-size:.85rem;color:var(--cf-text-strong);font-weight:600">{{ recordSummary(rec) }}</span>
              <div style="display:flex;align-items:center;gap:.6rem;flex-shrink:0">
                <button v-show="activeForm.formId === 'system-staff-profile-v1'" @click="abdmActiveStaffId = (abdmActiveStaffId === rec.id ? null : rec.id)" class="abdm-step-btn" style="padding:.25rem .6rem">
                  <i class="fas fa-satellite-dish"></i><span>{{ abdmActiveStaffId === rec.id ? 'Hide HPR' : 'HPR' }}</span>
                </button>
                <button @click="askRemoveDrawerRecord(rec.id, recordSummary(rec))" style="background:transparent;border:none;cursor:pointer;color:#EF4444;font-size:.85rem"><i class="fas fa-trash"></i></button>
              </div>
            </div>

            <!-- Per-staff-member ABDM Professional Registration sub-panel -->
            <div v-if="activeForm.formId === 'system-staff-profile-v1' && abdmActiveStaffId === rec.id" class="abdm-panel">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
                <p class="cf-label" style="margin:0"><i class="fas fa-satellite-dish mr-1.5"></i>ABDM Professional Registration (HPR)</p>
                <span class="abdm-stage-badge" :class="'abdm-stage-' + hprStateFor(rec.id).step">{{ hprStageLabel(hprStateFor(rec.id).step) }}</span>
              </div>

              <div v-if="hprStateFor(rec.id).step === 'not_started'" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                <div style="flex:1;min-width:180px">
                  <label class="cf-label" style="font-size:.7rem">Aadhaar Number</label>
                  <input class="cf-input" v-model="hprStateFor(rec.id).aadhaar" placeholder="12-digit Aadhaar" maxlength="12" />
                </div>
                <button class="abdm-step-btn" :disabled="hprStateFor(rec.id).loading" @click="hprSendAadhaarOtp(rec.id)"><i class="fas" :class="hprStateFor(rec.id).loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i>Send OTP</button>
              </div>

              <div v-if="hprStateFor(rec.id).step === 'otp_sent'" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                <p style="font-size:.72rem;color:var(--cf-text);width:100%">OTP sent to <strong>{{ hprStateFor(rec.id).maskedMobile }}</strong></p>
                <div style="flex:1;min-width:120px">
                  <label class="cf-label" style="font-size:.7rem">OTP</label>
                  <input class="cf-input" v-model="hprStateFor(rec.id).otp" placeholder="6-digit OTP" maxlength="6" />
                </div>
                <button class="abdm-step-btn" :disabled="hprStateFor(rec.id).loading" @click="hprVerifyAadhaarOtp(rec.id)"><i class="fas" :class="hprStateFor(rec.id).loading ? 'fa-spinner fa-spin' : 'fa-check'"></i>Verify</button>
              </div>

              <div v-if="hprStateFor(rec.id).step === 'aadhaar_verified'" style="display:flex;gap:.5rem;flex-wrap:wrap">
                <button class="abdm-step-btn" :disabled="hprStateFor(rec.id).loading" @click="hprCheckAccountExists(rec.id)"><i class="fas" :class="hprStateFor(rec.id).loading ? 'fa-spinner fa-spin' : 'fa-user-check'"></i>Check Existing Account</button>
              </div>

              <div v-if="hprStateFor(rec.id).step === 'account_checked'">
                <p style="font-size:.72rem;color:var(--cf-text);margin-bottom:.5rem">{{ hprStateFor(rec.id).hpidExists ? 'An HPID already exists for this Aadhaar.' : 'No existing HPID found — confirm mobile to continue.' }}</p>
                <div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                  <div style="flex:1;min-width:160px">
                    <label class="cf-label" style="font-size:.7rem">Mobile Number</label>
                    <input class="cf-input" v-model="hprStateFor(rec.id).mobile" placeholder="10-digit mobile" maxlength="10" />
                  </div>
                  <button class="abdm-step-btn" :disabled="hprStateFor(rec.id).loading" @click="hprDemographicAuthMobile(rec.id)"><i class="fas" :class="hprStateFor(rec.id).loading ? 'fa-spinner fa-spin' : 'fa-mobile-screen'"></i>Confirm (Aadhaar-linked)</button>
                  <button class="abdm-step-btn" :disabled="hprStateFor(rec.id).loading" @click="hprSendMobileOtp(rec.id)"><i class="fas" :class="hprStateFor(rec.id).loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i>Send OTP instead</button>
                </div>
              </div>

              <div v-if="hprStateFor(rec.id).step === 'mobile_otp_sent'" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                <div style="flex:1;min-width:120px">
                  <label class="cf-label" style="font-size:.7rem">Mobile OTP</label>
                  <input class="cf-input" v-model="hprStateFor(rec.id).mobileOtp" placeholder="6-digit OTP" maxlength="6" />
                </div>
                <button class="abdm-step-btn" :disabled="hprStateFor(rec.id).loading" @click="hprVerifyMobileOtp(rec.id)"><i class="fas" :class="hprStateFor(rec.id).loading ? 'fa-spinner fa-spin' : 'fa-check'"></i>Verify Mobile OTP</button>
              </div>

              <div v-if="['mobile_confirmed', 'mobile_verified'].includes(hprStateFor(rec.id).step)" style="display:flex;gap:.5rem;flex-wrap:wrap">
                <button class="abdm-step-btn" :disabled="hprStateFor(rec.id).loading" @click="hprFetchHpidSuggestions(rec.id)"><i class="fas" :class="hprStateFor(rec.id).loading ? 'fa-spinner fa-spin' : 'fa-list'"></i>Fetch HPID Suggestions</button>
              </div>

              <div v-if="hprStateFor(rec.id).step === 'suggestions_ready'">
                <p style="font-size:.72rem;color:var(--cf-text);margin-bottom:.5rem">Pick an HPID, then set a password to create the account. First/Last name, category, state/district and role come from this record's <strong>ABDM Professional Registration</strong> fields above.</p>
                <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.6rem">
                  <button v-for="hpid in hprStateFor(rec.id).hpidSuggestions" :key="hpid" class="tag-chip" :style="hprStateFor(rec.id).selectedHpId === hpid ? 'outline:2px solid var(--color-primary)' : ''" @click="hprStateFor(rec.id).selectedHpId = hpid">{{ hpid }}</button>
                </div>
                <div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
                  <div style="flex:1;min-width:160px">
                    <label class="cf-label" style="font-size:.7rem">Set Account Password</label>
                    <input class="cf-input" type="password" v-model="hprStateFor(rec.id).password" placeholder="Min 8 characters" />
                  </div>
                  <button class="abdm-step-btn" :disabled="hprStateFor(rec.id).loading || !hprStateFor(rec.id).selectedHpId" @click="hprCreateAccount(rec.id)"><i class="fas" :class="hprStateFor(rec.id).loading ? 'fa-spinner fa-spin' : 'fa-user-plus'"></i>Create HPR Account</button>
                </div>
              </div>

              <p v-if="hprStateFor(rec.id).step === 'account_created'" style="font-size:.8rem;color:#10B981"><i class="fas fa-circle-check mr-1"></i>HPR ID <strong>{{ hprStateFor(rec.id).createdHprId }}</strong> created and saved to this staff record.</p>
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
            <div v-for="admin in adminStaff()" :key="admin.id" class="record-card" :style="activeAdminId === admin.id ? 'border-color:var(--color-primary)' : ''">
              <span style="font-size:.82rem;color:var(--cf-text-strong);font-weight:600">{{ recordSummary(admin) }}</span>
              <button class="abdm-step-btn" style="padding:.25rem .6rem" @click="activeAdminId = admin.id">{{ activeAdminId === admin.id ? 'Selected' : 'Select' }}</button>
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
          <button v-for="card in journeyCards" :key="card.formId || card.title" class="entry-card" @click="openCard(card)">
            <div style="width:36px;height:36px;border-radius:.625rem;display:flex;align-items:center;justify-content:center;margin-bottom:.75rem" :style="`background:${card.bg}`">
              <i :class="card.icon" :style="`color:${card.color};font-size:.9rem`"></i>
            </div>
            <p style="font-weight:700;font-size:.85rem;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ card.title }}</p>
            <p style="font-size:.75rem;color:var(--cf-text);line-height:1.45;margin-bottom:.5rem">{{ card.desc }}</p>
            <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <span v-show="card.action === 'designer'" style="font-size:.72rem;color:var(--color-primary);font-weight:600;font-family:'Poppins',sans-serif"><i class="fas fa-arrow-right" style="margin-right:.3rem"></i>Open Designer</span>
              <span v-show="card.formId" class="badge" :class="card.formId && listRecords(card.formId).length > 0 ? 'badge-teal' : 'badge-muted'">{{ cardStatus(card) }}</span>
              <span v-show="card.formId === 'system-hospital-profile-v1'" class="abdm-stage-badge" :class="'abdm-stage-' + hfr.step">{{ 'HFR: ' + hfrStageLabel }}</span>
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
