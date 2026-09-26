<script setup>
// Real HPR (Health Professional Registry) registration for ONE Care Team member, layered on top
// of ProviderBasicsHost.vue's local FHIR capture — same shape as FacilityHfrPanel.vue/
// PatientAbhaPanel.vue. Ported from AbdmOnboarding.vue's own per-staff hprSendAadhaarOtp/
// hprVerifyAadhaarOtp/hprCheckAccountExists/hprDemographicAuthMobile/hprSendMobileOtp/
// hprVerifyMobileOtp/hprFetchHpidSuggestions/hprCreateAccount sequence, not reinvented —
// abdmAdapter.js's buildHpr* builders are unchanged, already grounded against the real gateway.
//
// UX rebuild (NHPR user manual gap analysis + explicit instruction): the flat `identityStep` ref
// this panel used to render directly, with no ledger, no locked-reason visibility, and — most
// importantly — NO attestation/e-sign moment at all (createAccount() just POSTed a password with
// a bare button; the manual's own Step 19-21 Preview-then-declare-then-sign sequence had zero UI
// counterpart). Now built around RegistrationLedger.vue + AttestationCard.vue — the exact same
// two components FacilityHfrPanel.vue's own header comment anticipated this redesign would reuse.
// Stage gating logic lives in hprRegistrationJourney.js (mirrors facilityHfrJourney.js's own
// "genuine technical prerequisite, never an invented screen order" discipline) — see that file's
// header for exactly why each stage gates on what it does.
//
// Deliberately does NOT duplicate Personal Details/Qualifications/Work Experience capture inside
// this ledger — those stay on their own StaffOnboarding.vue nav tabs (ProviderPersonalDetailsHost/
// ProviderQualificationsHost/ProviderWorkExperienceHost), exactly how FacilityHfrPanel.vue's own
// ledger never re-implements FacilityBasicsHost.vue's fields either. The Preview stage here only
// READS that already-saved data back (getAnswer, never a second capture surface) plus the two
// real manual-only fields nothing else captures: "About" and "Anyone assisted you to register?".
//
// Post-registration actions (Update Professional, Documents, Email verification, ID Card, Change
// Password) are UNCHANGED in logic, just moved out of the old undifferentiated button soup into a
// clearly-separated "Manage Your HPR Profile" block below the ledger — they're ongoing profile
// management, not registration steps, so they don't compete with the ledger's own stage sequence.
// Forgot Password / Forgot HPR ID stay always-visible at the very bottom, same as before — real
// recovery paths for someone who isn't logged in at all yet.
import { computed, reactive, ref, watch } from 'vue';
import { callAbdmGateway } from '../../data/control/abdmGatewayClient.js';
import {
  buildHprAadhaarOtpBody, buildHprVerifyAadhaarOtpBody, buildHprCheckAccountBody,
  buildHprDemographicAuthBody, buildHprMobileOtpBody, buildHprVerifyMobileOtpBody, buildHprCreateBody,
  buildHprPasswordLoginBody, buildHprProfessionalFetchBody, buildHprUpdateProfessionalBody, buildHprRegisterProfessionalBody, buildHprDocumentsListBody,
  buildHprDocumentUploadBody,
  buildHprEmailGenerateOtpBody, buildHprEmailResendOtpBody, buildHprEmailVerifyOtpBody,
  buildHprForgotPasswordMobileOtpBody, buildHprForgotPasswordAadhaarOtpBody, buildHprPasswordResetBody,
  buildHprChangePasswordBody, buildHprForgotHpridAadhaarOtpBody, buildHprForgotHpridMobileOtpBody,
  buildHprForgotHpridVerifyBody, buildHprAccountTokenBody,
} from '../../data/control/abdmAdapter.js';
import { getGroupInstances, getNestedGroupInstances, getAnswer, patchGroupInstanceField } from '../../data/useSystemForms.js';
import { DOC_TYPES, docTypeCode } from '../../data/collections/practitionerDocs.js';
import RegistrationLedger from '../RegistrationLedger.vue';
import AttestationCard from '../AttestationCard.vue';
import { deriveLedgerStages, nextStageAfter, currentStageFor, parseAbdmErrorDetails } from './hprRegistrationJourney.js';

const props = defineProps({
  record: { type: Object, default: null }, // onboarding.getProviderRecord()
  staffIndex: { type: Number, required: true },
});
const emit = defineEmits(['registered']);

// Internal micro-step progress for the Identity Verification / Create HPR Account stages' own
// slot content — several real ABDM API calls chained together (OTP -> account-check -> mobile
// confirm/OTP -> HPID suggestions -> create), same "one ledger stage, several internal actions"
// shape FacilityHfrPanel.vue's own Basic Information stage already uses for its multi-field form.
const IDENTITY_STEP_LABELS = {
  not_started: 'Not started', otp_sent: 'OTP sent', aadhaar_verified: 'Aadhaar verified',
  account_checked: 'Account checked', mobile_confirmed: 'Mobile confirmed', mobile_otp_sent: 'Mobile OTP sent',
  mobile_verified: 'Mobile verified', suggestions_ready: 'HPID suggestions ready',
};
const identityStep = ref('not_started');
const txnId = ref(null);
const maskedMobile = ref(null);
const hpidExists = ref(null);
const hpidSuggestions = ref([]);
const selectedHpId = ref(null);
const createdHprId = ref(null);
const loading = reactive({ aadhaar: false, verify: false, check: false, demo: false, mobileOtp: false, verifyMobile: false, suggest: false, create: false });

const aadhaar = ref('');
const otp = ref('');
const mobile = ref('');
const mobileOtp = ref('');
const password = ref('');

// One shared error surface for every real API failure in this panel — same shape
// FacilityHfrPanel.vue's own errorDetails banner uses, via hprRegistrationJourney.js's own
// parseAbdmErrorDetails (a smaller, HPR-specific FIELD_HINTS vocabulary — see that file's header
// for why several real fields intentionally get no "Fix in X" jump, since they live on other page
// tabs this panel doesn't control).
const errorDetails = ref([]);
function setLocalError(message) { errorDetails.value = [{ message }]; }
function setAbdmError(res, fallback) {
  const parsed = parseAbdmErrorDetails(res);
  errorDetails.value = parsed.length ? parsed : [{ message: fallback }];
}
function clearError() { errorDetails.value = []; }

function staffWrapped() {
  const instance = props.record ? getGroupInstances(props.record, 'section_staff')[props.staffIndex] : null;
  return instance ? { data: instance } : null;
}

// Mirrors staffWrapped() but for the PAIRED PractitionerRole (section_staff_role) group at the
// same staffIndex — createAccount()'s real HPR `role` code lives on staff_provider_role here, not
// on section_staff itself (see abdmAdapter.js's buildHprCreateBody header comment).
function roleWrapped() {
  const instance = props.record ? getGroupInstances(props.record, 'section_staff_role')[props.staffIndex] : null;
  return instance ? { data: instance } : null;
}

// Real spec fidelity — Register/Update Professional both need this person's full Qualifications
// list (registrationAcademic.registrationData[]), a nested repeating group inside THIS
// staffIndex's own section_staff instance (see ProviderQualificationsHost.vue's own header for
// why it's nested, not a sibling top-level block). Plain {staff_qual_*: value} objects —
// abdmAdapter.js's buildPractitionerPayload maps these straight into the real API shape.
function qualificationsFlat() {
  const instances = props.record ? getNestedGroupInstances(props.record, 'section_staff', props.staffIndex, 'section_staff_qualification') : [];
  return instances.map((instance) => {
    const rec = { data: instance };
    return Object.fromEntries([
      'staff_qual_degree_code', 'staff_qual_country', 'staff_qual_state', 'staff_qual_college', 'staff_qual_university',
      'staff_qual_year_awarded', 'staff_qual_degree_certificate', 'staff_qual_degree_name_matches_aadhaar',
      'staff_qual_degree_name_change_affidavit', 'staff_qual_registered_council',
      'staff_qual_registration_number', 'staff_qual_registration_date', 'staff_qual_registration_certificate',
      'staff_qual_registration_name_matches_aadhaar', 'staff_qual_registration_name_change_affidavit',
      'staff_qual_permanent_or_renewable', 'staff_qual_renewable_due_date',
    ].map((f) => [f, getAnswer(rec, f) || '']));
  });
}

// ─── The registration ledger: which of the 5 real stages is open, and each one's done/active/
// blocked state (hprRegistrationJourney.js's own pure classifier). ───
const activeStageId = ref('identity');
const previewConfirmed = ref(false);
const previewForm = reactive({ about: '', assistedRegistration: 'No', publicDisplayOptout: false });
const fullProfileSubmitted = ref(false);
const attestationConsented = ref(false);

const categoryReady = computed(() => {
  const rec = staffWrapped();
  if (!rec) return false;
  return !!(getAnswer(rec, 'staff_hp_category_code') && getAnswer(rec, 'staff_hp_subcategory_code')
    && getAnswer(rec, 'staff_state_code') && getAnswer(rec, 'staff_district_code'));
});
const hpidSuggestionsReady = computed(() => hpidSuggestions.value.length > 0);
const overallStatusLabel = computed(() => (fullProfileSubmitted.value ? 'Submitted to HPR' : createdHprId.value ? 'Account created' : 'Not started'));

const ledgerStages = computed(() => deriveLedgerStages({
  categoryReady: categoryReady.value, hpidSuggestionsReady: hpidSuggestionsReady.value,
  createdHprId: createdHprId.value, previewConfirmed: previewConfirmed.value, fullProfileSubmitted: fullProfileSubmitted.value,
}).map((s) => ({ id: s.id, label: s.label, icon: s.icon, state: s.state, lockedReason: s.lockedReason })));

// Preview Profile's own read-only summary — pulled straight from the already-saved Personal
// Details/Qualifications/Work Experience records, never re-captured here (see this file's own
// header for why).
const previewSummary = computed(() => {
  const rec = staffWrapped();
  if (!rec) return [];
  const quals = qualificationsFlat();
  const firstQual = quals[0];
  return [
    { label: 'Name', value: [getAnswer(rec, 'staff_first_name'), getAnswer(rec, 'staff_middle_name'), getAnswer(rec, 'staff_last_name')].filter(Boolean).join(' ') },
    { label: 'Category / Sub-Category', value: [getAnswer(rec, 'staff_hp_category_code'), getAnswer(rec, 'staff_hp_subcategory_code')].filter(Boolean).join(' / ') },
    { label: 'Languages Spoken', value: getAnswer(rec, 'staff_languages_spoken') },
    { label: 'Qualification', value: firstQual?.staff_qual_degree_code || '' },
    { label: 'Registration', value: firstQual?.staff_qual_registration_number ? `${firstQual.staff_qual_registered_council} · ${firstQual.staff_qual_registration_number}` : '' },
    { label: 'Work Status', value: getAnswer(rec, 'staff_work_status') },
  ];
});

const idCardSummary = computed(() => {
  const rec = staffWrapped();
  if (!rec) return { name: '', category: '' };
  return {
    name: [getAnswer(rec, 'staff_first_name'), getAnswer(rec, 'staff_middle_name'), getAnswer(rec, 'staff_last_name')].filter(Boolean).join(' '),
    category: [getAnswer(rec, 'staff_hp_category_code'), getAnswer(rec, 'staff_hp_subcategory_code')].filter(Boolean).join(' / '),
  };
});

function rebuildFromRecord() {
  const rec = staffWrapped();
  if (!rec) return;
  const existingHprId = getAnswer(rec, 'staff_hprid');
  if (existingHprId) createdHprId.value = existingHprId;
  fullProfileSubmitted.value = getAnswer(rec, 'staff_full_profile_submitted') === true;
  previewForm.about = getAnswer(rec, 'staff_about') || '';
  previewForm.assistedRegistration = getAnswer(rec, 'staff_assisted_registration') || 'No';
  previewForm.publicDisplayOptout = getAnswer(rec, 'staff_public_display_optout') === true;
  // Preview has no ABDM API of its own — "confirmed" is re-derived from whether it was ever saved
  // (same trick FacilityHfrPanel.vue's own publicDisplayConfirmed uses for the same reason).
  previewConfirmed.value = getAnswer(rec, 'staff_assisted_registration') !== '';
  activeStageId.value = currentStageFor({
    categoryReady: categoryReady.value, hpidSuggestionsReady: hpidSuggestionsReady.value,
    createdHprId: createdHprId.value, previewConfirmed: previewConfirmed.value, fullProfileSubmitted: fullProfileSubmitted.value,
  });
}
watch([() => props.record, () => props.staffIndex], rebuildFromRecord, { immediate: true });

async function sendAadhaarOtp() {
  if (!categoryReady.value) { setLocalError('Save your HP Category, Sub-Category, State and District on Personal Details first.'); return; }
  if (!aadhaar.value) { setLocalError('Enter an Aadhaar number.'); return; }
  clearError();
  loading.aadhaar = true;
  const res = await callAbdmGateway('/hpr/registration/aadhaar-otp', { body: buildHprAadhaarOtpBody(aadhaar.value) });
  loading.aadhaar = false;
  aadhaar.value = ''; // never held longer than the single outgoing request
  if (!res.success) { setAbdmError(res, 'Could not send Aadhaar OTP.'); return; }
  txnId.value = res.txnId;
  maskedMobile.value = res.maskedMobile;
  identityStep.value = 'otp_sent';
}

async function verifyAadhaarOtp() {
  if (!otp.value) { setLocalError('Enter the OTP.'); return; }
  clearError();
  loading.verify = true;
  const res = await callAbdmGateway('/hpr/registration/verify-aadhaar-otp', { body: buildHprVerifyAadhaarOtpBody(txnId.value, otp.value) });
  loading.verify = false;
  otp.value = '';
  if (!res.success) { setAbdmError(res, 'OTP verification failed.'); return; }
  identityStep.value = 'aadhaar_verified';
}

async function checkAccountExists() {
  clearError();
  loading.check = true;
  const res = await callAbdmGateway('/hpr/registration/check-account-exists', { body: buildHprCheckAccountBody(txnId.value) });
  loading.check = false;
  if (!res.success) { setAbdmError(res, 'Could not check account status.'); return; }
  hpidExists.value = res.hpidExists;
  identityStep.value = 'account_checked';
}

async function demographicAuthMobile() {
  if (!mobile.value) { setLocalError('Enter a mobile number.'); return; }
  clearError();
  loading.demo = true;
  const res = await callAbdmGateway('/hpr/registration/demographic-auth-mobile', { body: buildHprDemographicAuthBody(txnId.value, mobile.value) });
  loading.demo = false;
  if (!res.success) { setAbdmError(res, 'Mobile did not match the Aadhaar-linked number — send a mobile OTP instead.'); return; }
  identityStep.value = 'mobile_confirmed';
}

async function sendMobileOtp() {
  if (!mobile.value) { setLocalError('Enter a mobile number.'); return; }
  clearError();
  loading.mobileOtp = true;
  const res = await callAbdmGateway('/hpr/registration/mobile-otp', { body: buildHprMobileOtpBody(txnId.value, mobile.value) });
  loading.mobileOtp = false;
  if (!res.success) { setAbdmError(res, 'Could not send mobile OTP.'); return; }
  identityStep.value = 'mobile_otp_sent';
}

async function verifyMobileOtp() {
  if (!mobileOtp.value) { setLocalError('Enter the mobile OTP.'); return; }
  clearError();
  loading.verifyMobile = true;
  const res = await callAbdmGateway('/hpr/registration/verify-mobile-otp', { body: buildHprVerifyMobileOtpBody(txnId.value, mobileOtp.value) });
  loading.verifyMobile = false;
  mobileOtp.value = '';
  if (!res.success) { setAbdmError(res, 'Mobile OTP verification failed.'); return; }
  identityStep.value = 'mobile_verified';
}

async function fetchHpidSuggestions() {
  clearError();
  loading.suggest = true;
  const res = await callAbdmGateway(`/hpr/registration/hpid-suggestions?txnId=${encodeURIComponent(txnId.value)}`, { method: 'GET' });
  loading.suggest = false;
  if (!res.success) { setAbdmError(res, 'Could not fetch HPID suggestions.'); return; }
  hpidSuggestions.value = res.suggestions?.hpIdSuggestion || res.suggestions || [];
  identityStep.value = 'suggestions_ready';
  activeStageId.value = nextStageAfter('identity');
}

async function createAccount() {
  const rec = staffWrapped();
  if (!rec || !selectedHpId.value || !password.value) { setLocalError('Select an HPID and set a password.'); return; }
  clearError();
  loading.create = true;
  const body = buildHprCreateBody(rec, roleWrapped(), { txnId: txnId.value, selectedHpId: selectedHpId.value, password: password.value });
  const res = await callAbdmGateway('/hpr/registration/create', { body });
  loading.create = false;
  password.value = '';
  if (!res.success) { setAbdmError(res, 'Account creation failed.'); return; }
  createdHprId.value = res.hprId;
  // Scoped to exactly this one repeating instance — a global-linkId write would otherwise stamp
  // staff_hprid onto every staff member sharing that linkId (clinux-provider-composition-merge).
  patchGroupInstanceField(props.record.id, 'section_staff', props.staffIndex, {
    staff_hprid: res.hprId, staff_hpr_id_number: res.hprIdNumber,
  });
  activeStageId.value = nextStageAfter('account');
  emit('registered', { hprId: res.hprId, hprIdNumber: res.hprIdNumber });
}

function confirmPreview() {
  if (!props.record) return;
  patchGroupInstanceField(props.record.id, 'section_staff', props.staffIndex, {
    staff_about: previewForm.about, staff_assisted_registration: previewForm.assistedRegistration || 'No',
    staff_public_display_optout: previewForm.publicDisplayOptout,
  });
  previewConfirmed.value = true;
  activeStageId.value = nextStageAfter('preview');
}

// ─── Attestation & e-Sign — the manual's own Step 19-24 (Preview -> declare -> E-sign & Submit),
// wired to the real "submit full profile" API (buildHprRegisterProfessionalBody), previously just
// a stray button in the old undifferentiated post-creation block. Needs the professional's OWN
// per-user HPR login (myToken below), same as Update Professional/Documents/Email Verification —
// a DIFFERENT token from the one used to create the bare account. ───
const myLogin = reactive({ hprId: '', password: '' });
const myToken = ref(null);
const myLoginLoading = ref(false);

async function myPasswordLogin() {
  if (!myLogin.hprId || !myLogin.password) { setLocalError('Enter your HPR ID and password.'); return; }
  clearError();
  myLoginLoading.value = true;
  const res = await callAbdmGateway('/hpr/auth/password-login', { body: buildHprPasswordLoginBody(myLogin.hprId, myLogin.password) });
  myLoginLoading.value = false;
  myLogin.password = '';
  if (!res.success) { setAbdmError(res, 'Login failed.'); return; }
  myToken.value = res.token;
}

const registerStatus = ref(''); // '' | 'saving' | 'saved' | 'error'
async function registerProfessional() {
  const rec = staffWrapped();
  if (!rec || !myToken.value || !createdHprId.value) { setLocalError('Log in with your own HPR ID first.'); return; }
  clearError();
  registerStatus.value = 'saving';
  const res = await callAbdmGateway('/hpr/professional/register', {
    body: buildHprRegisterProfessionalBody(rec, qualificationsFlat(), myToken.value, createdHprId.value),
  });
  registerStatus.value = res.success ? 'saved' : 'error';
  if (!res.success) { setAbdmError(res, 'Registration submission failed.'); return; }
  fullProfileSubmitted.value = true;
  patchGroupInstanceField(props.record.id, 'section_staff', props.staffIndex, { staff_full_profile_submitted: true });
  activeStageId.value = nextStageAfter('attestation');
  emit('registered', { hprId: createdHprId.value });
}
const signingAsLabel = computed(() => (myToken.value && myLogin.hprId ? `Signing as: ${myLogin.hprId}` : ''));

// ─── Manage Your HPR Profile (post-registration) — Update Professional / Document List / Email
// Verification / Id Card / Change Password. Same actions, same logic as before, just relocated out
// of the old button-soup block since they're ongoing profile management, not registration steps. ───

// Real gap found live: buildHprProfessionalFetchBody / POST /hpr/professional/fetch
// (fetch-professional-info) already existed with zero call sites anywhere in this app (confirmed
// via grep — only ever referenced from abdmAdapter.test.js). It's the one API that could show the
// manual's own Application Status / Council Status / Work Status badges, which per the manual's
// own wording ("Once the Healthcare Professional application... is verified... the left menu will
// get added") are what a real user actually watches for. clinuxflow-abdm-gateway's own /
// professional/fetch route is a thin, unshaped passthrough of ABDM's real response — no confirmed
// field names for these 3 statuses exist anywhere in this codebase, so this deliberately does NOT
// guess at res.applicationStatus-style accessors (same "no fabricated field name" honesty this
// app's other not-yet-live-tested integrations already carry — see ProviderWorkExperienceHost.vue's
// own Search Facility panel for the identical treatment). A best-effort pluck of a few plausibly-
// named keys is attempted; the full raw response is always shown underneath either way, so nothing
// is hidden if the guess is wrong.
const professionalStatus = ref(null); // raw response, once fetched
const professionalStatusLoading = ref(false);
const professionalStatusBadges = computed(() => {
  const res = professionalStatus.value;
  if (!res) return [];
  const pick = (...keys) => keys.map((k) => res[k]).find((v) => v !== undefined && v !== null && v !== '');
  return [
    { label: 'Application Status', value: pick('applicationStatus', 'application_status', 'status') },
    { label: 'Council Status', value: pick('councilStatus', 'council_status') },
    { label: 'Work Status', value: pick('workStatus', 'work_status') },
  ].filter((b) => b.value !== undefined);
});
async function fetchProfessionalStatus() {
  const rec = staffWrapped();
  if (!rec) return;
  clearError();
  professionalStatusLoading.value = true;
  const res = await callAbdmGateway('/hpr/professional/fetch', { body: buildHprProfessionalFetchBody(rec) });
  professionalStatusLoading.value = false;
  if (!res.success) { setAbdmError(res, 'Could not fetch professional status.'); return; }
  professionalStatus.value = res;
}

const updateStatus = ref(''); // '' | 'saving' | 'saved' | 'error'
async function updateProfessional() {
  const rec = staffWrapped();
  if (!rec || !myToken.value) return;
  clearError();
  updateStatus.value = 'saving';
  const res = await callAbdmGateway('/hpr/professional/update', { body: buildHprUpdateProfessionalBody(rec, qualificationsFlat(), myToken.value) });
  updateStatus.value = res.success ? 'saved' : 'error';
  if (!res.success) setAbdmError(res, 'Update failed.');
}

const uploadDoc = reactive({ type: DOC_TYPES[0], loading: false, done: false });
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function uploadDocument(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !myToken.value || !createdHprId.value) return;
  clearError();
  uploadDoc.loading = true;
  uploadDoc.done = false;
  try {
    const base64 = await readFileAsBase64(file);
    const res = await callAbdmGateway('/hpr/professional/documents/upload', {
      body: buildHprDocumentUploadBody(myToken.value, createdHprId.value, docTypeCode(uploadDoc.type), base64),
    });
    if (!res.success) { setAbdmError(res, 'Document upload failed.'); return; }
    uploadDoc.done = true;
  } catch (e) {
    setLocalError(e.message || 'Could not read that file.');
  } finally {
    uploadDoc.loading = false;
  }
}

const documents = ref(null); // null = not fetched yet
const documentsLoading = ref(false);
async function fetchDocuments() {
  if (!createdHprId.value) return;
  documentsLoading.value = true;
  const res = await callAbdmGateway('/hpr/professional/documents', { body: buildHprDocumentsListBody(createdHprId.value) });
  documentsLoading.value = false;
  if (!res.success) { setAbdmError(res, 'Could not fetch documents.'); return; }
  documents.value = res.documentList || res;
}
const documentsPhotoDataUrl = computed(() => {
  const b64 = documents.value?.profileDetails?.profilePhoto?.data;
  return b64 ? `data:image/jpeg;base64,${b64}` : '';
});

const emailVerify = reactive({ step: 'idle', email: '', otp: '', loading: false }); // 'idle' | 'otp_sent' | 'verified'
async function sendEmailOtp() {
  if (!emailVerify.email || !myToken.value) { setLocalError('Log in and enter an email address.'); return; }
  clearError();
  emailVerify.loading = true;
  const res = await callAbdmGateway('/hpr/professional/email/generate-otp', { body: buildHprEmailGenerateOtpBody(myToken.value, emailVerify.email) });
  emailVerify.loading = false;
  if (!res.success) { setAbdmError(res, 'Could not send email OTP.'); return; }
  emailVerify.step = 'otp_sent';
}
async function resendEmailOtp() {
  emailVerify.loading = true;
  const res = await callAbdmGateway('/hpr/professional/email/resend-otp', { body: buildHprEmailResendOtpBody(myToken.value, emailVerify.email) });
  emailVerify.loading = false;
  if (!res.success) setAbdmError(res, 'Could not resend email OTP.');
}
async function verifyEmailOtp() {
  if (!emailVerify.otp) { setLocalError('Enter the email OTP.'); return; }
  clearError();
  emailVerify.loading = true;
  const res = await callAbdmGateway('/hpr/professional/email/verify-otp', { body: buildHprEmailVerifyOtpBody(myToken.value, createdHprId.value, emailVerify.email, emailVerify.otp) });
  emailVerify.loading = false;
  emailVerify.otp = '';
  if (!res.success) { setAbdmError(res, 'Email OTP verification failed.'); return; }
  emailVerify.step = 'verified';
}

const idCardLoading = ref(false);
const idCardPdf = ref(''); // base64
async function fetchIdCard() {
  if (!myToken.value) { setLocalError('Log in first to fetch your Id Card.'); return; }
  clearError();
  idCardLoading.value = true;
  const res = await callAbdmGateway('/hpr/account/id-card', { body: buildHprAccountTokenBody(myToken.value) });
  idCardLoading.value = false;
  if (!res.success) { setAbdmError(res, 'Could not fetch Id Card.'); return; }
  idCardPdf.value = res.pdf || '';
}

const changePwd = reactive({ oldPassword: '', newPassword: '', confirmPassword: '', loading: false, done: false });
async function changePassword() {
  if (!changePwd.oldPassword || !changePwd.newPassword) { setLocalError('Enter your current and new password.'); return; }
  if (changePwd.newPassword !== changePwd.confirmPassword) { setLocalError('New password and confirmation do not match.'); return; }
  clearError();
  changePwd.loading = true;
  const res = await callAbdmGateway('/hpr/password/change', { body: buildHprChangePasswordBody(changePwd.oldPassword, changePwd.newPassword) });
  changePwd.loading = false;
  if (!res.success) { setAbdmError(res, 'Could not change password.'); return; }
  changePwd.oldPassword = ''; changePwd.newPassword = ''; changePwd.confirmPassword = '';
  changePwd.done = true;
}

// ─── Forgot Password / Forgot HPR ID — always visible, independent of the ledger above: real
// recovery paths for someone who ISN'T logged in (or doesn't remember their HPR ID) at all. ───
const forgotPwd = reactive({
  hprId: '', method: 'mobile', txnId: '', otp: '', newPassword: '', confirmPassword: '',
  step: 'idle', loading: false, // 'idle' | 'otp_sent' | 'otp_verified' | 'done'
});
async function forgotPasswordSendOtp() {
  if (!forgotPwd.hprId) { setLocalError('Enter your HPR ID.'); return; }
  clearError();
  forgotPwd.loading = true;
  const path = forgotPwd.method === 'mobile' ? '/hpr/password/forgot/mobile/send-otp' : '/hpr/password/forgot/aadhaar/send-otp';
  const body = forgotPwd.method === 'mobile' ? buildHprForgotPasswordMobileOtpBody(forgotPwd.hprId) : buildHprForgotPasswordAadhaarOtpBody(forgotPwd.hprId);
  const res = await callAbdmGateway(path, { body });
  forgotPwd.loading = false;
  if (!res.success) { setAbdmError(res, 'Could not send OTP.'); return; }
  forgotPwd.txnId = res.txnId;
  forgotPwd.step = 'otp_sent';
}
async function forgotPasswordVerifyOtp() {
  if (!forgotPwd.otp) { setLocalError('Enter the OTP.'); return; }
  clearError();
  forgotPwd.loading = true;
  const path = forgotPwd.method === 'mobile' ? '/hpr/password/forgot/mobile/verify-otp' : '/hpr/password/forgot/aadhaar/verify-otp';
  const res = await callAbdmGateway(path, { body: { txnId: forgotPwd.txnId, otp: forgotPwd.otp } });
  forgotPwd.loading = false;
  if (!res.success) { setAbdmError(res, 'OTP verification failed.'); return; }
  forgotPwd.step = 'otp_verified';
}
async function forgotPasswordReset() {
  if (!forgotPwd.newPassword) { setLocalError('Enter a new password.'); return; }
  if (forgotPwd.newPassword !== forgotPwd.confirmPassword) { setLocalError('New password and confirmation do not match.'); return; }
  clearError();
  forgotPwd.loading = true;
  const res = await callAbdmGateway('/hpr/password/forgot/reset', { body: buildHprPasswordResetBody(forgotPwd.txnId, forgotPwd.newPassword) });
  forgotPwd.loading = false;
  if (!res.success) { setAbdmError(res, 'Could not reset password.'); return; }
  forgotPwd.step = 'done';
}

const forgotHprid = reactive({
  method: 'aadhaar', aadhaar: '', mobile: '', txnId: '', otp: '',
  step: 'idle', loading: false, result: null, // 'idle' | 'otp_sent' | 'done'
});
async function forgotHpridSendOtp() {
  clearError();
  forgotHprid.loading = true;
  const path = forgotHprid.method === 'aadhaar' ? '/hpr/hprid/forgot/aadhaar/send-otp' : '/hpr/hprid/forgot/mobile/send-otp';
  const body = forgotHprid.method === 'aadhaar' ? buildHprForgotHpridAadhaarOtpBody(forgotHprid.aadhaar) : buildHprForgotHpridMobileOtpBody(forgotHprid.mobile);
  const res = await callAbdmGateway(path, { body });
  forgotHprid.loading = false;
  if (!res.success) { setAbdmError(res, 'Could not send OTP.'); return; }
  forgotHprid.txnId = res.txnId;
  forgotHprid.step = 'otp_sent';
}
async function forgotHpridVerifyOtp() {
  if (!forgotHprid.otp) { setLocalError('Enter the OTP.'); return; }
  clearError();
  forgotHprid.loading = true;
  const path = forgotHprid.method === 'aadhaar' ? '/hpr/hprid/forgot/aadhaar/verify-otp' : '/hpr/hprid/forgot/mobile/verify-otp';
  const res = await callAbdmGateway(path, { body: buildHprForgotHpridVerifyBody(forgotHprid.txnId, forgotHprid.otp, staffWrapped()) });
  forgotHprid.loading = false;
  if (!res.success) { setAbdmError(res, 'OTP verification failed.'); return; }
  forgotHprid.result = { hprId: res.hprId, hprIdNumber: res.hprIdNumber };
  forgotHprid.step = 'done';
}
</script>

<template>
  <div class="cf-card rounded-2xl p-4 mt-3">
    <div class="flex items-center justify-between mb-2">
      <p class="cf-label mb-0"><i class="fas fa-id-badge mr-1.5"></i>ABDM Professional Registration (HPR)</p>
      <span class="text-xs font-semibold" style="color:var(--color-primary)">{{ overallStatusLabel }}</span>
    </div>
    <div v-if="errorDetails.length" class="mb-2 p-2 rounded-lg" style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25)">
      <p v-for="(d, i) in errorDetails" :key="i" class="text-xs font-medium flex items-center gap-2 flex-wrap" style="color:#b91c1c">
        <span>{{ d.message }}</span>
        <button v-if="d.stageId" class="btn-ghost text-[11px] px-2 py-0.5" @click="activeStageId = d.stageId">
          <i class="fas fa-arrow-right"></i> Fix in {{ d.label }}
        </button>
      </p>
    </div>

    <RegistrationLedger :stages="ledgerStages" v-model:active-id="activeStageId">
      <template #identity>
        <div v-if="createdHprId" class="text-xs" style="color:var(--cf-text)">
          <i class="fas fa-circle-check" style="color:var(--color-primary)"></i> Identity verified.
        </div>
        <template v-else>
          <p class="text-[11px] mb-2" style="color:var(--cf-text)">{{ IDENTITY_STEP_LABELS[identityStep] }}</p>

          <template v-if="identityStep === 'not_started' || identityStep === 'otp_sent'">
            <div v-if="identityStep === 'not_started'" class="flex gap-2">
              <input class="cf-input flex-1" v-model="aadhaar" placeholder="Aadhaar number" maxlength="12" />
              <button class="btn-outline text-xs px-2" :disabled="loading.aadhaar" @click="sendAadhaarOtp()">
                <i class="fas" :class="loading.aadhaar ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i>
              </button>
            </div>
            <div v-else class="flex gap-2">
              <input class="cf-input flex-1" v-model="otp" :placeholder="`Enter OTP (sent to ${maskedMobile || 'linked mobile'})`" />
              <button class="btn-outline text-xs px-2" :disabled="loading.verify" @click="verifyAadhaarOtp()">
                <i class="fas" :class="loading.verify ? 'fa-spinner fa-spin' : 'fa-check'"></i>
              </button>
            </div>
          </template>

          <button v-else-if="identityStep === 'aadhaar_verified'" class="btn-outline text-xs" :disabled="loading.check" @click="checkAccountExists()">
            <i class="fas" :class="loading.check ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> Check account status
          </button>

          <template v-else-if="identityStep === 'account_checked' || identityStep === 'mobile_otp_sent'">
            <div v-if="identityStep === 'account_checked'" class="flex flex-col gap-2">
              <input class="cf-input" v-model="mobile" placeholder="Mobile number" />
              <div class="flex gap-2">
                <button class="btn-outline text-xs flex-1" :disabled="loading.demo" @click="demographicAuthMobile()">Confirm (Aadhaar-linked)</button>
                <button class="btn-outline text-xs flex-1" :disabled="loading.mobileOtp" @click="sendMobileOtp()">Send OTP instead</button>
              </div>
            </div>
            <div v-else class="flex gap-2">
              <input class="cf-input flex-1" v-model="mobileOtp" placeholder="Enter mobile OTP" />
              <button class="btn-outline text-xs px-2" :disabled="loading.verifyMobile" @click="verifyMobileOtp()">
                <i class="fas" :class="loading.verifyMobile ? 'fa-spinner fa-spin' : 'fa-check'"></i>
              </button>
            </div>
          </template>

          <button v-else-if="identityStep === 'mobile_confirmed' || identityStep === 'mobile_verified'" class="btn-outline text-xs" :disabled="loading.suggest" @click="fetchHpidSuggestions()">
            <i class="fas" :class="loading.suggest ? 'fa-spinner fa-spin' : 'fa-list'"></i> Get HPID suggestions
          </button>

          <p v-else-if="identityStep === 'suggestions_ready'" class="text-xs" style="color:var(--color-primary)">
            <i class="fas fa-circle-check"></i> HPID suggestions ready — continue to Create HPR Account.
          </p>
        </template>
      </template>

      <template #account>
        <div v-if="createdHprId" class="record-card p-2">
          <p class="text-xs font-semibold" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> HPR ID: {{ createdHprId }}</p>
        </div>
        <div v-else-if="identityStep === 'suggestions_ready'" class="flex flex-col gap-2">
          <select class="cf-input" v-model="selectedHpId">
            <option :value="null">Choose an HPID…</option>
            <option v-for="s in hpidSuggestions" :key="s" :value="s">{{ s }}</option>
          </select>
          <input class="cf-input" v-model="password" type="password" placeholder="Set a password" />
          <button class="btn-teal text-xs" :disabled="loading.create" @click="createAccount()">
            <i class="fas" :class="loading.create ? 'fa-spinner fa-spin' : 'fa-user-check'"></i> Create HPR Account
          </button>
        </div>
        <p v-else class="text-xs" style="color:var(--cf-text)">Complete Identity Verification first.</p>
      </template>

      <template #preview>
        <div class="record-card p-2 mb-3">
          <div v-for="row in previewSummary" :key="row.label" class="flex justify-between text-xs py-1" style="border-bottom:1px solid var(--cf-border)">
            <span style="color:var(--cf-text)">{{ row.label }}</span>
            <span style="color:var(--cf-text-strong);font-weight:600">{{ row.value || '—' }}</span>
          </div>
        </div>
        <label class="cf-label">About (shown on your public profile)</label>
        <textarea class="cf-input mb-3" rows="2" v-model="previewForm.about" placeholder="A short description of your practice…"></textarea>
        <label class="cf-label">Anyone assisted you to register in HPR?</label>
        <select class="cf-input mb-3" v-model="previewForm.assistedRegistration">
          <option value="No">No</option>
          <option value="Yes">Yes</option>
        </select>
        <label class="flex items-center gap-2 mb-3 text-xs" style="color:var(--cf-text-strong);font-weight:600">
          <input type="checkbox" v-model="previewForm.publicDisplayOptout" />
          <span>Don't show my details to the public at all</span>
        </label>
        <button class="btn-teal text-xs" @click="confirmPreview()">
          <i class="fas fa-eye"></i> Confirm &amp; Continue
        </button>
      </template>

      <template #attestation>
        <AttestationCard
          v-model:consented="attestationConsented"
          title="Healthcare Professional Registration Declaration"
          :summary="previewSummary"
          declaration-text="I hereby declare that I am voluntarily sharing the above mentioned particulars and information. I certify that the above information furnished by me is true, complete, and correct to the best of my knowledge. I understand that in the event of my information being found false or incorrect at any stage, I shall be held liable for the same."
          :can-sign="!!myToken"
          cannot-sign-reason="Log in with your own HPR ID and password first."
          :signing-as-label="signingAsLabel"
          :loading="registerStatus === 'saving'"
          @sign="registerProfessional()"
        />
        <div v-if="!myToken" class="mt-3">
          <div class="flex gap-2 items-end flex-wrap">
            <input class="cf-input flex-1 min-w-[140px]" v-model="myLogin.hprId" placeholder="Your HPR ID" />
            <input class="cf-input flex-1 min-w-[120px]" v-model="myLogin.password" type="password" placeholder="Password" />
            <button class="btn-outline text-xs" :disabled="myLoginLoading" @click="myPasswordLogin()">
              <i class="fas" :class="myLoginLoading ? 'fa-spinner fa-spin' : 'fa-right-to-bracket'"></i> Log in
            </button>
          </div>
        </div>
      </template>

      <template #submitted>
        <div class="record-card p-2.5">
          <p class="text-sm font-semibold" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Full profile submitted to ABDM</p>
          <p class="text-xs" style="color:var(--cf-text)">HPR ID: {{ createdHprId }}</p>
        </div>
      </template>
    </RegistrationLedger>

    <!-- ─── Manage Your HPR Profile — ongoing profile management, not registration steps (see this
         file's own header for why these are relocated here, out of the old button soup). ─── -->
    <div v-if="createdHprId" class="mt-4 pt-4" style="border-top:1px solid var(--cf-border)">
      <div class="flex items-center justify-between mb-2">
        <p class="cf-label mb-0">Manage Your HPR Profile</p>
        <button class="btn-ghost text-xs px-2 py-1" :disabled="professionalStatusLoading" @click="fetchProfessionalStatus()">
          <i class="fas" :class="professionalStatusLoading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> Refresh Status
        </button>
      </div>
      <div v-if="professionalStatusBadges.length" class="flex flex-wrap gap-2 mb-3">
        <span v-for="b in professionalStatusBadges" :key="b.label" class="text-xs font-semibold px-2 py-1 rounded-full" style="background:var(--cf-bg-alt);color:var(--cf-text-strong)">
          {{ b.label }}: {{ b.value }}
        </span>
      </div>
      <details v-else-if="professionalStatus" class="record-card p-2 text-xs mb-3">
        <summary style="cursor:pointer;color:var(--cf-text)">Raw professional status response (no known status field matched — inspect here)</summary>
        <pre style="white-space:pre-wrap;font-size:10px;margin-top:.5rem">{{ professionalStatus }}</pre>
      </details>

      <div v-if="!myToken" class="flex gap-2 items-end flex-wrap mb-3">
        <input class="cf-input flex-1 min-w-[100px]" v-model="myLogin.hprId" placeholder="Your HPR ID" />
        <input class="cf-input flex-1 min-w-[100px]" v-model="myLogin.password" type="password" placeholder="Password" />
        <button class="btn-outline text-xs" :disabled="myLoginLoading" @click="myPasswordLogin()">
          <i class="fas" :class="myLoginLoading ? 'fa-spinner fa-spin' : 'fa-right-to-bracket'"></i> Log in to manage profile
        </button>
      </div>

      <template v-else>
        <div class="flex gap-2 flex-wrap mb-2">
          <button v-if="fullProfileSubmitted" class="btn-outline text-xs" :disabled="updateStatus === 'saving'" @click="updateProfessional()">
            <i class="fas" :class="updateStatus === 'saving' ? 'fa-spinner fa-spin' : 'fa-user-pen'"></i> Update Professional
          </button>
          <button class="btn-outline text-xs" :disabled="documentsLoading" @click="fetchDocuments()">
            <i class="fas" :class="documentsLoading ? 'fa-spinner fa-spin' : 'fa-file-lines'"></i> My Documents
          </button>
        </div>
        <p v-if="updateStatus === 'saved'" class="text-xs mb-2" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Profile updated.</p>
        <div v-if="documents" class="record-card p-2 text-xs mb-2">
          <img v-if="documentsPhotoDataUrl" :src="documentsPhotoDataUrl" alt="" style="width:64px;height:64px;border-radius:50%;object-fit:cover;margin-bottom:.5rem" />
          <div style="max-height:120px;overflow-y:auto">
            <pre style="white-space:pre-wrap;font-size:10px">{{ documents }}</pre>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap mb-2">
          <select class="cf-input text-xs" style="max-width:220px" v-model="uploadDoc.type">
            <option v-for="t in DOC_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
          <label class="btn-outline text-xs" style="cursor:pointer;display:inline-flex;align-items:center;gap:.4rem">
            <i class="fas" :class="uploadDoc.loading ? 'fa-spinner fa-spin' : 'fa-upload'"></i> Upload to ABDM
            <input type="file" style="display:none" :disabled="uploadDoc.loading" @change="uploadDocument" />
          </label>
        </div>
        <p v-if="uploadDoc.done" class="text-xs mb-2" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Document uploaded.</p>

        <div v-if="emailVerify.step === 'verified'" class="text-xs mb-2" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Email verified.</div>
        <div v-else-if="emailVerify.step === 'otp_sent'" class="flex gap-2 mb-2">
          <input class="cf-input flex-1" v-model="emailVerify.otp" placeholder="Enter email OTP" />
          <button class="btn-outline text-xs px-2" :disabled="emailVerify.loading" @click="verifyEmailOtp()">
            <i class="fas" :class="emailVerify.loading ? 'fa-spinner fa-spin' : 'fa-check'"></i>
          </button>
          <button class="btn-ghost text-xs px-2" :disabled="emailVerify.loading" @click="resendEmailOtp()" title="Resend OTP">
            <i class="fas fa-rotate"></i>
          </button>
        </div>
        <div v-else class="flex gap-2 mb-2">
          <input class="cf-input flex-1" v-model="emailVerify.email" placeholder="Email to verify" />
          <button class="btn-outline text-xs px-2" :disabled="emailVerify.loading" @click="sendEmailOtp()">
            <i class="fas" :class="emailVerify.loading ? 'fa-spinner fa-spin' : 'fa-envelope'"></i>
          </button>
        </div>

        <!-- A local, styled preview built from already-captured record data — same idea as the
             manual's own in-app ID card view before download. The real PDF (fetchIdCard's own
             res.pdf) stays the authoritative document; this is a cosmetic preview, not a
             substitute for it. -->
        <div class="record-card p-3 mb-2" style="max-width:360px">
          <p class="text-[10px] uppercase tracking-wide mb-1" style="color:var(--cf-text)">Healthcare Professional ID</p>
          <p class="text-sm font-bold" style="color:var(--cf-text-strong)">{{ idCardSummary.name }}</p>
          <p class="text-xs" style="color:var(--cf-text)">HPID: {{ createdHprId }}</p>
          <p v-if="idCardSummary.category" class="text-xs" style="color:var(--cf-text)">{{ idCardSummary.category }}</p>
        </div>
        <div class="flex items-center gap-2 mb-2">
          <button class="btn-outline text-xs" :disabled="idCardLoading" @click="fetchIdCard()">
            <i class="fas" :class="idCardLoading ? 'fa-spinner fa-spin' : 'fa-id-card'"></i> Get Id Card
          </button>
          <a v-if="idCardPdf" :href="`data:application/pdf;base64,${idCardPdf}`" target="_blank" class="text-xs" style="color:var(--color-primary)">
            <i class="fas fa-eye"></i> View Id Card PDF
          </a>
        </div>

        <div class="record-card p-2 flex flex-col gap-2">
          <p class="cf-label mb-0">Change Password</p>
          <p v-if="changePwd.done" class="text-xs" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Password changed.</p>
          <template v-else>
            <input class="cf-input" v-model="changePwd.oldPassword" type="password" placeholder="Current password" />
            <input class="cf-input" v-model="changePwd.newPassword" type="password" placeholder="New password" />
            <input class="cf-input" v-model="changePwd.confirmPassword" type="password" placeholder="Confirm new password" />
            <button class="btn-outline text-xs" :disabled="changePwd.loading" @click="changePassword()">
              <i class="fas" :class="changePwd.loading ? 'fa-spinner fa-spin' : 'fa-key'"></i> Change Password
            </button>
          </template>
        </div>
      </template>
    </div>

    <!-- Forgot Password / Forgot HPR ID — real recovery paths for someone who ISN'T logged in
         (or doesn't even remember their HPR ID) — always visible, independent of everything above. -->
    <div class="record-card p-2 flex flex-col gap-2 mt-3">
      <p class="cf-label mb-0"><i class="fas fa-unlock-keyhole"></i> Forgot Password</p>
      <template v-if="forgotPwd.step === 'idle'">
        <div class="flex gap-2">
          <label class="text-xs flex items-center gap-1"><input type="radio" value="mobile" v-model="forgotPwd.method" /> Via Mobile OTP</label>
          <label class="text-xs flex items-center gap-1"><input type="radio" value="aadhaar" v-model="forgotPwd.method" /> Via Aadhaar-linked mobile</label>
        </div>
        <input class="cf-input" v-model="forgotPwd.hprId" placeholder="Your HPR ID" />
        <button class="btn-outline text-xs" :disabled="forgotPwd.loading" @click="forgotPasswordSendOtp()">
          <i class="fas" :class="forgotPwd.loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i> Send OTP
        </button>
      </template>
      <template v-else-if="forgotPwd.step === 'otp_sent'">
        <div class="flex gap-2">
          <input class="cf-input flex-1" v-model="forgotPwd.otp" placeholder="Enter OTP" />
          <button class="btn-outline text-xs px-2" :disabled="forgotPwd.loading" @click="forgotPasswordVerifyOtp()">
            <i class="fas" :class="forgotPwd.loading ? 'fa-spinner fa-spin' : 'fa-check'"></i>
          </button>
        </div>
      </template>
      <template v-else-if="forgotPwd.step === 'otp_verified'">
        <input class="cf-input" v-model="forgotPwd.newPassword" type="password" placeholder="New password" />
        <input class="cf-input" v-model="forgotPwd.confirmPassword" type="password" placeholder="Confirm new password" />
        <button class="btn-outline text-xs" :disabled="forgotPwd.loading" @click="forgotPasswordReset()">
          <i class="fas" :class="forgotPwd.loading ? 'fa-spinner fa-spin' : 'fa-key'"></i> Reset Password
        </button>
      </template>
      <p v-else class="text-xs" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Password reset — log in above with your new password.</p>
    </div>

    <div class="record-card p-2 flex flex-col gap-2 mt-2">
      <p class="cf-label mb-0"><i class="fas fa-id-badge"></i> Forgot HPR ID</p>
      <template v-if="forgotHprid.step === 'idle'">
        <div class="flex gap-2">
          <label class="text-xs flex items-center gap-1"><input type="radio" value="aadhaar" v-model="forgotHprid.method" /> Via Aadhaar</label>
          <label class="text-xs flex items-center gap-1"><input type="radio" value="mobile" v-model="forgotHprid.method" /> Via Mobile</label>
        </div>
        <input v-if="forgotHprid.method === 'aadhaar'" class="cf-input" v-model="forgotHprid.aadhaar" placeholder="Aadhaar number" maxlength="12" />
        <input v-else class="cf-input" v-model="forgotHprid.mobile" placeholder="Registered mobile number" />
        <button class="btn-outline text-xs" :disabled="forgotHprid.loading" @click="forgotHpridSendOtp()">
          <i class="fas" :class="forgotHprid.loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i> Send OTP
        </button>
      </template>
      <template v-else-if="forgotHprid.step === 'otp_sent'">
        <div class="flex gap-2">
          <input class="cf-input flex-1" v-model="forgotHprid.otp" placeholder="Enter OTP" />
          <button class="btn-outline text-xs px-2" :disabled="forgotHprid.loading" @click="forgotHpridVerifyOtp()">
            <i class="fas" :class="forgotHprid.loading ? 'fa-spinner fa-spin' : 'fa-check'"></i>
          </button>
        </div>
      </template>
      <div v-else class="text-xs" style="color:var(--color-primary)">
        <i class="fas fa-circle-check"></i> Your HPR ID: {{ forgotHprid.result?.hprId }} ({{ forgotHprid.result?.hprIdNumber }})
      </div>
    </div>
  </div>
</template>
