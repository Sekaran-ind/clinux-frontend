<script setup>
// Real HPR (Health Professional Registry) registration for ONE Care Team member, layered on top
// of ProviderBasicsHost.vue's local FHIR capture — same shape as FacilityHfrPanel.vue/
// PatientAbhaPanel.vue. Ported from AbdmOnboarding.vue's own per-staff hprSendAadhaarOtp/
// hprVerifyAadhaarOtp/hprCheckAccountExists/hprDemographicAuthMobile/hprSendMobileOtp/
// hprVerifyMobileOtp/hprFetchHpidSuggestions/hprCreateAccount sequence (that page is retired
// once this lands), not reinvented — abdmAdapter.js's buildHpr* builders are unchanged, already
// grounded against the real gateway.
//
// Takes the WHOLE Provider record + a staffIndex (not a pre-wrapped staffRecord) — mirrors
// AbdmOnboarding.vue's own staffRecord(staffIndex) wrapping (patchGroupInstanceField needs the
// record id + the group instance's array position, not just its bare data).
import { reactive, ref, watch } from 'vue';
import { callAbdmGateway } from '../../data/control/abdmGatewayClient.js';
import {
  buildHprAadhaarOtpBody, buildHprVerifyAadhaarOtpBody, buildHprCheckAccountBody,
  buildHprDemographicAuthBody, buildHprMobileOtpBody, buildHprVerifyMobileOtpBody, buildHprCreateBody,
  buildHprPasswordLoginBody, buildHprUpdateProfessionalBody, buildHprDocumentsListBody,
  buildHprEmailGenerateOtpBody, buildHprEmailResendOtpBody, buildHprEmailVerifyOtpBody,
} from '../../data/control/abdmAdapter.js';
import { getGroupInstances, getAnswer, patchGroupInstanceField } from '../../data/useSystemForms.js';

const props = defineProps({
  record: { type: Object, default: null }, // onboarding.getProviderRecord()
  staffIndex: { type: Number, required: true },
});
const emit = defineEmits(['registered']);

const STEP_LABELS = {
  not_started: 'Not started', otp_sent: 'OTP sent', aadhaar_verified: 'Aadhaar verified',
  account_checked: 'Account checked', mobile_confirmed: 'Mobile confirmed', mobile_otp_sent: 'Mobile OTP sent',
  mobile_verified: 'Mobile verified', suggestions_ready: 'HPID suggestions ready', account_created: 'HPR account created',
};

const step = ref('not_started');
const txnId = ref(null);
const maskedMobile = ref(null);
const hpidExists = ref(null);
const hpidSuggestions = ref([]);
const selectedHpId = ref(null);
const createdHprId = ref(null);
const errorMsg = ref('');
const loading = reactive({ aadhaar: false, verify: false, check: false, demo: false, mobileOtp: false, verifyMobile: false, suggest: false, create: false });

const aadhaar = ref('');
const otp = ref('');
const mobile = ref('');
const mobileOtp = ref('');
const password = ref('');

function staffWrapped() {
  const instance = props.record ? getGroupInstances(props.record, 'section_staff')[props.staffIndex] : null;
  return instance ? { data: instance } : null;
}

function rebuildFromRecord() {
  const rec = staffWrapped();
  if (!rec) return;
  const existingHprId = getAnswer(rec, 'staff_hprid');
  if (existingHprId) {
    createdHprId.value = existingHprId;
    step.value = 'account_created';
  }
}
watch([() => props.record, () => props.staffIndex], rebuildFromRecord, { immediate: true });

async function sendAadhaarOtp() {
  if (!aadhaar.value) { errorMsg.value = 'Enter an Aadhaar number.'; return; }
  errorMsg.value = '';
  loading.aadhaar = true;
  const res = await callAbdmGateway('/hpr/registration/aadhaar-otp', { body: buildHprAadhaarOtpBody(aadhaar.value) });
  loading.aadhaar = false;
  aadhaar.value = ''; // never held longer than the single outgoing request
  if (!res.success) { errorMsg.value = res.error || 'Could not send Aadhaar OTP.'; return; }
  txnId.value = res.txnId;
  maskedMobile.value = res.maskedMobile;
  step.value = 'otp_sent';
}

async function verifyAadhaarOtp() {
  if (!otp.value) { errorMsg.value = 'Enter the OTP.'; return; }
  errorMsg.value = '';
  loading.verify = true;
  const res = await callAbdmGateway('/hpr/registration/verify-aadhaar-otp', { body: buildHprVerifyAadhaarOtpBody(txnId.value, otp.value) });
  loading.verify = false;
  otp.value = '';
  if (!res.success) { errorMsg.value = res.error || 'OTP verification failed.'; return; }
  step.value = 'aadhaar_verified';
}

async function checkAccountExists() {
  errorMsg.value = '';
  loading.check = true;
  const res = await callAbdmGateway('/hpr/registration/check-account-exists', { body: buildHprCheckAccountBody(txnId.value) });
  loading.check = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not check account status.'; return; }
  hpidExists.value = res.hpidExists;
  step.value = 'account_checked';
}

async function demographicAuthMobile() {
  if (!mobile.value) { errorMsg.value = 'Enter a mobile number.'; return; }
  errorMsg.value = '';
  loading.demo = true;
  const res = await callAbdmGateway('/hpr/registration/demographic-auth-mobile', { body: buildHprDemographicAuthBody(txnId.value, mobile.value) });
  loading.demo = false;
  if (!res.success) { errorMsg.value = res.error || 'Mobile did not match the Aadhaar-linked number — send a mobile OTP instead.'; return; }
  step.value = 'mobile_confirmed';
}

async function sendMobileOtp() {
  if (!mobile.value) { errorMsg.value = 'Enter a mobile number.'; return; }
  errorMsg.value = '';
  loading.mobileOtp = true;
  const res = await callAbdmGateway('/hpr/registration/mobile-otp', { body: buildHprMobileOtpBody(txnId.value, mobile.value) });
  loading.mobileOtp = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not send mobile OTP.'; return; }
  step.value = 'mobile_otp_sent';
}

async function verifyMobileOtp() {
  if (!mobileOtp.value) { errorMsg.value = 'Enter the mobile OTP.'; return; }
  errorMsg.value = '';
  loading.verifyMobile = true;
  const res = await callAbdmGateway('/hpr/registration/verify-mobile-otp', { body: buildHprVerifyMobileOtpBody(txnId.value, mobileOtp.value) });
  loading.verifyMobile = false;
  mobileOtp.value = '';
  if (!res.success) { errorMsg.value = res.error || 'Mobile OTP verification failed.'; return; }
  step.value = 'mobile_verified';
}

async function fetchHpidSuggestions() {
  errorMsg.value = '';
  loading.suggest = true;
  const res = await callAbdmGateway(`/hpr/registration/hpid-suggestions?txnId=${encodeURIComponent(txnId.value)}`, { method: 'GET' });
  loading.suggest = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not fetch HPID suggestions.'; return; }
  hpidSuggestions.value = res.suggestions?.hpIdSuggestion || res.suggestions || [];
  step.value = 'suggestions_ready';
}

async function createAccount() {
  const rec = staffWrapped();
  if (!rec || !selectedHpId.value || !password.value) { errorMsg.value = 'Select an HPID and set a password.'; return; }
  errorMsg.value = '';
  loading.create = true;
  const body = buildHprCreateBody(rec, { txnId: txnId.value, selectedHpId: selectedHpId.value, password: password.value });
  const res = await callAbdmGateway('/hpr/registration/create', { body });
  loading.create = false;
  password.value = '';
  if (!res.success) { errorMsg.value = res.error || 'Account creation failed.'; return; }
  createdHprId.value = res.hprId;
  step.value = 'account_created';
  // Scoped to exactly this one repeating instance — a global-linkId write would otherwise stamp
  // staff_hprid onto every staff member sharing that linkId (clinux-provider-composition-merge).
  patchGroupInstanceField(props.record.id, 'section_staff', props.staffIndex, {
    staff_hprid: res.hprId, staff_hpr_id_number: res.hprIdNumber,
  });
  emit('registered', { hprId: res.hprId, hprIdNumber: res.hprIdNumber });
}

// ─── Post-registration: Update Professional / Document List / Email Verification ───
// Real gap found while auditing pending onboarding items: 3 real HPR gateway routes (built this
// session, live-verified against the real sandbox via curl) had zero UI consumers. All three need
// the person's OWN per-user HPR token (not the Facility Manager's — a different login, same
// /hpr/auth/password-login route ProviderHprPanel doesn't otherwise use, since account creation
// itself never needed the caller to already be logged in as themselves).
const myLogin = reactive({ hprId: '', password: '' });
const myToken = ref(null);
const myLoginLoading = ref(false);

async function myPasswordLogin() {
  if (!myLogin.hprId || !myLogin.password) { errorMsg.value = 'Enter your HPR ID and password.'; return; }
  errorMsg.value = '';
  myLoginLoading.value = true;
  const res = await callAbdmGateway('/hpr/auth/password-login', { body: buildHprPasswordLoginBody(myLogin.hprId, myLogin.password) });
  myLoginLoading.value = false;
  myLogin.password = '';
  if (!res.success) { errorMsg.value = res.error || 'Login failed.'; return; }
  myToken.value = res.token;
}

// Update Professional — deliberately scoped to the real minimal subset this app already
// captures (name/mobile/email), not the full 60+ field nested profile-update form. See
// buildHprUpdateProfessionalBody's own header for why.
const updateStatus = ref(''); // '' | 'saving' | 'saved' | 'error'
async function updateProfessional() {
  const rec = staffWrapped();
  if (!rec || !myToken.value) return;
  updateStatus.value = 'saving';
  const res = await callAbdmGateway('/hpr/professional/update', { body: buildHprUpdateProfessionalBody(rec, myToken.value) });
  updateStatus.value = res.success ? 'saved' : 'error';
  if (!res.success) errorMsg.value = res.error || 'Update failed.';
}

// Document List
const documents = ref(null); // null = not fetched yet
const documentsLoading = ref(false);
async function fetchDocuments() {
  if (!createdHprId.value) return;
  documentsLoading.value = true;
  const res = await callAbdmGateway('/hpr/professional/documents', { body: buildHprDocumentsListBody(createdHprId.value) });
  documentsLoading.value = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not fetch documents.'; return; }
  documents.value = res.documentList || res;
}

// Email verification — real 3-step flow (generate -> optionally resend -> verify).
const emailVerify = reactive({ step: 'idle', email: '', otp: '', loading: false }); // 'idle' | 'otp_sent' | 'verified'
async function sendEmailOtp() {
  if (!emailVerify.email || !myToken.value) { errorMsg.value = 'Log in and enter an email address.'; return; }
  errorMsg.value = '';
  emailVerify.loading = true;
  const res = await callAbdmGateway('/hpr/professional/email/generate-otp', { body: buildHprEmailGenerateOtpBody(myToken.value, emailVerify.email) });
  emailVerify.loading = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not send email OTP.'; return; }
  emailVerify.step = 'otp_sent';
}
async function resendEmailOtp() {
  emailVerify.loading = true;
  const res = await callAbdmGateway('/hpr/professional/email/resend-otp', { body: buildHprEmailResendOtpBody(myToken.value, emailVerify.email) });
  emailVerify.loading = false;
  if (!res.success) errorMsg.value = res.error || 'Could not resend email OTP.';
}
async function verifyEmailOtp() {
  if (!emailVerify.otp) { errorMsg.value = 'Enter the email OTP.'; return; }
  errorMsg.value = '';
  emailVerify.loading = true;
  const res = await callAbdmGateway('/hpr/professional/email/verify-otp', { body: buildHprEmailVerifyOtpBody(myToken.value, createdHprId.value, emailVerify.email, emailVerify.otp) });
  emailVerify.loading = false;
  emailVerify.otp = '';
  if (!res.success) { errorMsg.value = res.error || 'Email OTP verification failed.'; return; }
  emailVerify.step = 'verified';
}
</script>

<template>
  <div class="cf-card rounded-2xl p-3 mt-2">
    <div class="flex items-center justify-between mb-2">
      <p class="text-xs font-semibold" style="color:var(--cf-text-strong)"><i class="fas fa-id-badge mr-1.5"></i>HPR Registration</p>
      <span class="text-xs font-semibold" style="color:var(--color-primary)">{{ STEP_LABELS[step] }}</span>
    </div>
    <p v-show="errorMsg" class="text-red-500 text-xs font-medium mb-2">{{ errorMsg }}</p>

    <div v-if="step === 'account_created'" class="flex flex-col gap-2">
      <div class="record-card p-2">
        <p class="text-xs font-semibold" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> HPR ID: {{ createdHprId }}</p>
      </div>

      <!-- Real login as yourself — needed for Update Professional/Document List/Email
           Verification, a DIFFERENT token from the Facility Manager's own login. -->
      <div v-if="!myToken" class="flex gap-2 items-end flex-wrap">
        <input class="cf-input flex-1 min-w-[100px]" v-model="myLogin.hprId" placeholder="Your HPR ID" />
        <input class="cf-input flex-1 min-w-[100px]" v-model="myLogin.password" type="password" placeholder="Password" />
        <button class="btn-outline text-xs" :disabled="myLoginLoading" @click="myPasswordLogin()">
          <i class="fas" :class="myLoginLoading ? 'fa-spinner fa-spin' : 'fa-right-to-bracket'"></i> Log in to manage profile
        </button>
      </div>

      <template v-else>
        <div class="flex gap-2 flex-wrap">
          <button class="btn-outline text-xs" :disabled="updateStatus === 'saving'" @click="updateProfessional()">
            <i class="fas" :class="updateStatus === 'saving' ? 'fa-spinner fa-spin' : 'fa-user-pen'"></i> Update Professional
          </button>
          <button class="btn-outline text-xs" :disabled="documentsLoading" @click="fetchDocuments()">
            <i class="fas" :class="documentsLoading ? 'fa-spinner fa-spin' : 'fa-file-lines'"></i> My Documents
          </button>
        </div>
        <p v-if="updateStatus === 'saved'" class="text-xs" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Profile updated.</p>
        <div v-if="documents" class="record-card p-2 text-xs" style="max-height:120px;overflow-y:auto">
          <pre style="white-space:pre-wrap;font-size:10px">{{ documents }}</pre>
        </div>

        <!-- Email verification — real 3-step flow. -->
        <div v-if="emailVerify.step === 'verified'" class="text-xs" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Email verified.</div>
        <div v-else-if="emailVerify.step === 'otp_sent'" class="flex gap-2">
          <input class="cf-input flex-1" v-model="emailVerify.otp" placeholder="Enter email OTP" />
          <button class="btn-outline text-xs px-2" :disabled="emailVerify.loading" @click="verifyEmailOtp()">
            <i class="fas" :class="emailVerify.loading ? 'fa-spinner fa-spin' : 'fa-check'"></i>
          </button>
          <button class="btn-ghost text-xs px-2" :disabled="emailVerify.loading" @click="resendEmailOtp()" title="Resend OTP">
            <i class="fas fa-rotate"></i>
          </button>
        </div>
        <div v-else class="flex gap-2">
          <input class="cf-input flex-1" v-model="emailVerify.email" placeholder="Email to verify" />
          <button class="btn-outline text-xs px-2" :disabled="emailVerify.loading" @click="sendEmailOtp()">
            <i class="fas" :class="emailVerify.loading ? 'fa-spinner fa-spin' : 'fa-envelope'"></i>
          </button>
        </div>
      </template>
    </div>

    <template v-else>
      <template v-if="step === 'not_started' || step === 'otp_sent'">
        <div v-if="step === 'not_started'" class="flex gap-2">
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

      <button v-else-if="step === 'aadhaar_verified'" class="btn-outline text-xs" :disabled="loading.check" @click="checkAccountExists()">
        <i class="fas" :class="loading.check ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> Check account status
      </button>

      <template v-else-if="step === 'account_checked' || step === 'mobile_otp_sent'">
        <div v-if="step === 'account_checked'" class="flex flex-col gap-2">
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

      <button v-else-if="step === 'mobile_confirmed' || step === 'mobile_verified'" class="btn-outline text-xs" :disabled="loading.suggest" @click="fetchHpidSuggestions()">
        <i class="fas" :class="loading.suggest ? 'fa-spinner fa-spin' : 'fa-list'"></i> Get HPID suggestions
      </button>

      <div v-else-if="step === 'suggestions_ready'" class="flex flex-col gap-2">
        <select class="cf-input" v-model="selectedHpId">
          <option :value="null">Choose an HPID…</option>
          <option v-for="s in hpidSuggestions" :key="s" :value="s">{{ s }}</option>
        </select>
        <input class="cf-input" v-model="password" type="password" placeholder="Set a password" />
        <button class="btn-teal text-xs" :disabled="loading.create" @click="createAccount()">
          <i class="fas" :class="loading.create ? 'fa-spinner fa-spin' : 'fa-user-check'"></i> Create HPR Account
        </button>
      </div>
    </template>
  </div>
</template>
