<script setup>
// SPEC-24 §7 step 6 (Patient) — real ABHA (Ayushman Bharat Health Account) registration, layered
// on top of PatientBasicsHost.vue's local FHIR capture the same way AbdmOnboarding.vue/
// abdmAdapter.js already layer HFR/HPR onto Facility/Provider (explicit precedent, not invented
// here). Two real, distinct lanes, matching how a front-desk patient actually arrives:
//
// FIND (doc §7.6.1) — the patient already has an ABHA from elsewhere: search by mobile
// (POST /abha/find/search, the one new gateway route this pass added), pick a match, verify by
// OTP. The OTP round-trip reuses the SAME generic /abha/login/request-otp + /abha/login/verify-
// otp routes the Login section already wraps fully parametrically (loginHint:'index') — confirmed
// directly against the real ABHA V3 API doc's own sample bodies, not assumed; no separate gateway
// route was needed for this half.
//
// CREATE (doc §3) — a genuinely new ABHA, via Aadhaar. Real finding from the doc's own sample
// response: the account is FULLY created (a real ABHANumber + a default phrAddress already
// assigned) the moment verify-aadhaar-otp succeeds — the later "address suggestion/custom
// creation" step (doc §3 Step 6) only customizes the PREFERRED address, it doesn't gate having a
// working ABHA at all. So this lane emits its result right after Aadhaar OTP verification;
// customizing the address and confirming a non-Aadhaar-linked mobile are real, optional refinements
// left for later (this component surfaces them if the account needs a mobile OTP, per the ABDM
// response's own signal, but never blocks emitting a real, usable ABHA on them) — email
// verification is not built at all here, deliberately deferred polish, same tone as this whole
// spec's other honestly-flagged gaps.
import { reactive, ref } from 'vue';
import { callAbdmGateway } from '../../data/control/abdmGatewayClient.js';
import {
  buildAbhaFindSearchBody, buildAbhaFindVerifyRequestOtpBody,
  buildAbhaLoginVerifyOtpBody,
  buildAbhaAadhaarOtpBody, buildAbhaVerifyAadhaarOtpBody,
  buildAbhaMobileOtpBody, buildAbhaVerifyMobileOtpBody,
  buildAbhaAddressBody, buildAbhaEmailVerificationLinkBody,
} from '../../data/control/abhaAdapter.js';

const emit = defineEmits(['linked']);

const mode = ref('choose'); // 'choose' | 'find' | 'create' | 'linked'
const linkedProfile = ref(null);
const errorMsg = ref('');
// Real per-user ABHA session token — both Find and Create lanes' own verify-otp calls return
// this (clinuxflow-abdm-gateway/src/routes/abha.js's own comment on why), needed as the
// X-ABHA-Token header for email verification and (Create lane only) address selection. Real gap
// found while auditing pending onboarding items: buildAbhaAddressBody already existed as prep
// work, but nothing ever captured this token or called it — email verification was explicitly
// flagged "deliberately deferred polish" in this file's own original header.
const abhaToken = ref(null);

function reset() {
  mode.value = 'choose';
  linkedProfile.value = null;
  errorMsg.value = '';
  abhaToken.value = null;
  Object.assign(find, { step: 'mobile', mobile: '', loading: false, txnId: null, matches: [], selectedIndex: null, otp: '' });
  Object.assign(create, { step: 'aadhaar', loading: false, aadhaar: '', txnId: null, otp: '', mobile: '', needsMobileVerify: false, mobileOtp: '' });
  Object.assign(addressCustomize, { open: false, loading: false, suggestions: [], custom: '', selected: '' });
  Object.assign(emailVerify, { open: false, loading: false, email: '', sent: false });
}

// ─── Find ───
const find = reactive({ step: 'mobile', mobile: '', loading: false, txnId: null, matches: [], selectedIndex: null, otp: '' });

async function findSearch() {
  if (!find.mobile) { errorMsg.value = 'Enter a mobile number.'; return; }
  errorMsg.value = '';
  find.loading = true;
  const res = await callAbdmGateway('/abha/find/search', { body: buildAbhaFindSearchBody(find.mobile) });
  find.loading = false;
  if (!res.success) { errorMsg.value = res.error || 'Search failed.'; return; }
  find.txnId = res.txnId;
  find.matches = res.matches || [];
  find.step = find.matches.length ? 'matches' : 'none';
}

async function findRequestOtp(match) {
  find.selectedIndex = match.index;
  errorMsg.value = '';
  find.loading = true;
  const res = await callAbdmGateway('/abha/login/request-otp', { body: buildAbhaFindVerifyRequestOtpBody(match.index) });
  find.loading = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not send OTP.'; return; }
  find.txnId = res.txnId;
  find.step = 'otp';
}

async function findVerifyOtp() {
  if (!find.otp) { errorMsg.value = 'Enter the OTP.'; return; }
  errorMsg.value = '';
  find.loading = true;
  const res = await callAbdmGateway('/abha/login/verify-otp', {
    body: buildAbhaLoginVerifyOtpBody(find.txnId, find.otp, ['abha-login', 'search-abha', 'mobile-verify']),
  });
  find.loading = false;
  if (!res.success) { errorMsg.value = res.error || 'OTP verification failed.'; return; }
  const account = (res.accounts || [])[0];
  if (!account) { errorMsg.value = 'Verified, but no account details came back.'; return; }
  abhaToken.value = res.abhaToken || null;
  applyLinkedProfile({
    abhaNumber: account.ABHANumber, abhaAddress: account.preferredAbhaAddress,
    name: account.name, mobile: find.mobile,
  });
}

// ─── Create (via Aadhaar) ───
const create = reactive({ step: 'aadhaar', loading: false, aadhaar: '', txnId: null, otp: '', mobile: '', needsMobileVerify: false, mobileOtp: '' });

async function createSendAadhaarOtp() {
  if (!create.aadhaar) { errorMsg.value = 'Enter an Aadhaar number.'; return; }
  errorMsg.value = '';
  create.loading = true;
  const res = await callAbdmGateway('/abha/enrollment/aadhaar-otp', { body: buildAbhaAadhaarOtpBody(create.aadhaar) });
  create.loading = false;
  create.aadhaar = ''; // never held longer than the single outgoing request
  if (!res.success) { errorMsg.value = res.error || 'Could not send Aadhaar OTP.'; return; }
  create.txnId = res.txnId;
  create.step = 'otp';
}

async function createVerifyAadhaarOtp() {
  if (!create.otp || !create.mobile) { errorMsg.value = 'Enter the OTP and a primary mobile number.'; return; }
  errorMsg.value = '';
  create.loading = true;
  const res = await callAbdmGateway('/abha/enrollment/verify-aadhaar-otp', {
    body: buildAbhaVerifyAadhaarOtpBody(create.txnId, create.otp, create.mobile),
  });
  create.loading = false;
  create.otp = '';
  if (!res.success) { errorMsg.value = res.error || 'OTP verification failed.'; return; }
  abhaToken.value = res.abhaToken || null;
  // Real ABDM behavior confirmed via the doc's own sample response (see header comment): the
  // account already has a real ABHANumber + default phrAddress at this point. `profile.mobile`
  // present means it already matched the Aadhaar-linked number; absent means this typed-in
  // mobile still needs its own OTP confirmation — offered as an optional next step, never a
  // block on emitting the (already real) linked profile below.
  create.needsMobileVerify = !res.profile?.mobile;
  applyLinkedProfile({
    abhaNumber: res.profile?.ABHANumber, abhaAddress: (res.profile?.phrAddress || [])[0],
    firstName: res.profile?.firstName, middleName: res.profile?.middleName, lastName: res.profile?.lastName,
    gender: res.profile?.gender, dob: res.profile?.dob, mobile: create.mobile,
  });
}

async function createSendMobileOtp() {
  errorMsg.value = '';
  create.loading = true;
  const res = await callAbdmGateway('/abha/enrollment/mobile-otp', { body: buildAbhaMobileOtpBody(create.txnId, create.mobile) });
  create.loading = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not send mobile OTP.'; return; }
  create.step = 'mobile-otp';
}

async function createVerifyMobileOtp() {
  if (!create.mobileOtp) { errorMsg.value = 'Enter the mobile OTP.'; return; }
  errorMsg.value = '';
  create.loading = true;
  const res = await callAbdmGateway('/abha/enrollment/verify-mobile-otp', { body: buildAbhaVerifyMobileOtpBody(create.txnId, create.mobileOtp) });
  create.loading = false;
  create.mobileOtp = '';
  if (!res.success) { errorMsg.value = res.error || 'Mobile OTP verification failed.'; return; }
  create.needsMobileVerify = false;
}

// ─── Address customization (doc §3 Step 6) — real gap found while auditing pending onboarding
// items: this file's own original header explicitly deferred it ("a real, optional refinement
// left for later... never blocks emitting a real, usable ABHA"). Genuinely optional — the account
// already has a working default phrAddress the moment createVerifyAadhaarOtp succeeds (see that
// function's own comment) — this just lets the patient pick a nicer one instead of keeping it.
const addressCustomize = reactive({ open: false, loading: false, suggestions: [], custom: '', selected: '' });

async function loadAddressSuggestions() {
  errorMsg.value = '';
  addressCustomize.loading = true;
  const res = await callAbdmGateway(`/abha/enrollment/address-suggestions?txnId=${encodeURIComponent(create.txnId)}`, { method: 'GET' });
  addressCustomize.loading = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not load address suggestions.'; return; }
  addressCustomize.suggestions = res.suggestions || [];
  addressCustomize.open = true;
}

async function saveCustomAddress() {
  const abhaAddress = addressCustomize.selected || addressCustomize.custom;
  if (!abhaAddress) { errorMsg.value = 'Choose a suggestion or type a custom address.'; return; }
  errorMsg.value = '';
  addressCustomize.loading = true;
  const res = await callAbdmGateway('/abha/enrollment/address', { body: buildAbhaAddressBody(create.txnId, abhaAddress) });
  addressCustomize.loading = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not set that ABHA address.'; return; }
  linkedProfile.value = { ...linkedProfile.value, abhaAddress };
  addressCustomize.open = false;
}

// ─── Email verification (doc §3 Step 5) — real gap found the same way: explicitly flagged
// "email verification is not built at all here, deliberately deferred polish" in this file's own
// original header. Real per-user X-ABHA-Token header, not a body field (see requireAbhaToken's
// own comment on clinuxflow-abdm-gateway) — ABDM's own response has no further poll step, the
// patient completes verification by clicking the emailed link outside this app entirely.
const emailVerify = reactive({ open: false, loading: false, email: '', sent: false });

async function sendEmailVerificationLink() {
  if (!emailVerify.email || !abhaToken.value) { errorMsg.value = 'Enter an email address.'; return; }
  errorMsg.value = '';
  emailVerify.loading = true;
  const res = await callAbdmGateway('/abha/enrollment/email-verification-link', {
    body: buildAbhaEmailVerificationLinkBody(emailVerify.email), extraHeaders: { 'X-ABHA-Token': abhaToken.value },
  });
  emailVerify.loading = false;
  if (!res.success) { errorMsg.value = res.error || 'Could not send the verification link.'; return; }
  emailVerify.sent = true;
}

function applyLinkedProfile(profile) {
  linkedProfile.value = profile;
  mode.value = 'linked';
  emit('linked', profile);
}

defineExpose({ reset });
</script>

<template>
  <div class="cf-card rounded-2xl p-4">
    <p class="cf-label mb-2">ABHA (Ayushman Bharat Health Account)</p>
    <p v-show="errorMsg" class="text-red-500 text-xs font-medium mb-2">{{ errorMsg }}</p>

    <!-- Linked summary -->
    <div v-if="mode === 'linked'" class="record-card p-2.5">
      <p class="text-sm font-semibold" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> ABHA linked</p>
      <p class="text-xs" style="color:var(--cf-text)">{{ linkedProfile.abhaNumber }}<span v-if="linkedProfile.abhaAddress"> · {{ linkedProfile.abhaAddress }}</span></p>
      <div v-if="create.needsMobileVerify" class="mt-2 pt-2" style="border-top:1px dashed var(--cf-border)">
        <p class="text-xs mb-1" style="color:var(--cf-text)">This mobile number wasn't already linked to the Aadhaar — confirm it with an OTP (optional).</p>
        <button v-if="create.step !== 'mobile-otp'" class="btn-outline text-xs" :disabled="create.loading" @click="createSendMobileOtp()">Send Mobile OTP</button>
        <div v-else class="flex gap-2">
          <input class="cf-input" v-model="create.mobileOtp" placeholder="Enter OTP" />
          <button class="btn-teal text-xs px-3" :disabled="create.loading" @click="createVerifyMobileOtp()">Verify</button>
        </div>
      </div>

      <!-- Address customization — Create lane only (create.txnId only exists there); genuinely
           optional, the account already works with its default address. -->
      <div v-if="create.txnId" class="mt-2 pt-2" style="border-top:1px dashed var(--cf-border)">
        <button v-if="!addressCustomize.open" class="btn-outline text-xs" :disabled="addressCustomize.loading" @click="loadAddressSuggestions()">
          <i class="fas" :class="addressCustomize.loading ? 'fa-spinner fa-spin' : 'fa-at'"></i> Choose a custom ABHA address
        </button>
        <div v-else class="flex flex-col gap-2">
          <div v-for="s in addressCustomize.suggestions" :key="s" class="flex items-center gap-2">
            <input type="radio" :value="s" v-model="addressCustomize.selected" />
            <label class="text-xs">{{ s }}</label>
          </div>
          <input class="cf-input" v-model="addressCustomize.custom" placeholder="...or type your own" />
          <button class="btn-teal text-xs" :disabled="addressCustomize.loading" @click="saveCustomAddress()">
            <i class="fas" :class="addressCustomize.loading ? 'fa-spinner fa-spin' : 'fa-check'"></i> Save address
          </button>
        </div>
      </div>

      <!-- Email verification — optional, either lane (abhaToken is captured by both). -->
      <div v-if="abhaToken" class="mt-2 pt-2" style="border-top:1px dashed var(--cf-border)">
        <p v-if="emailVerify.sent" class="text-xs" style="color:var(--color-primary)"><i class="fas fa-circle-check"></i> Verification link sent — check the inbox.</p>
        <div v-else class="flex gap-2">
          <input class="cf-input flex-1" v-model="emailVerify.email" placeholder="Email to verify (optional)" />
          <button class="btn-outline text-xs px-2" :disabled="emailVerify.loading" @click="sendEmailVerificationLink()">
            <i class="fas" :class="emailVerify.loading ? 'fa-spinner fa-spin' : 'fa-envelope'"></i>
          </button>
        </div>
      </div>

      <button class="btn-ghost text-xs mt-2" @click="reset()">Start over</button>
    </div>

    <!-- Lane picker -->
    <div v-else-if="mode === 'choose'" class="flex gap-2">
      <button class="btn-outline text-sm flex-1" @click="mode = 'find'"><i class="fas fa-magnifying-glass"></i> I already have an ABHA</button>
      <button class="btn-outline text-sm flex-1" @click="mode = 'create'"><i class="fas fa-plus"></i> Create a new ABHA</button>
    </div>

    <!-- Find lane -->
    <div v-else-if="mode === 'find'" class="flex flex-col gap-2">
      <template v-if="find.step === 'mobile'">
        <input class="cf-input" v-model="find.mobile" placeholder="Mobile number linked to the ABHA" />
        <button class="btn-teal text-sm" :disabled="find.loading" @click="findSearch()">
          <i class="fas" :class="find.loading ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> Search
        </button>
      </template>
      <template v-else-if="find.step === 'none'">
        <p class="text-xs" style="color:var(--cf-text)">No ABHA found for that mobile number.</p>
        <button class="btn-ghost text-xs" @click="mode = 'create'">Create a new ABHA instead</button>
      </template>
      <template v-else-if="find.step === 'matches'">
        <div v-for="m in find.matches" :key="m.index" class="record-card flex items-center justify-between p-2">
          <span class="text-sm">{{ m.name }} <span class="text-xs" style="color:var(--cf-text)">{{ m.abhaNumber }}</span></span>
          <button class="btn-outline text-xs px-2 py-1" :disabled="find.loading" @click="findRequestOtp(m)">Select</button>
        </div>
      </template>
      <template v-else-if="find.step === 'otp'">
        <input class="cf-input" v-model="find.otp" placeholder="Enter OTP" />
        <button class="btn-teal text-sm" :disabled="find.loading" @click="findVerifyOtp()">
          <i class="fas" :class="find.loading ? 'fa-spinner fa-spin' : 'fa-check'"></i> Verify
        </button>
      </template>
      <button class="btn-ghost text-xs" @click="reset()">Back</button>
    </div>

    <!-- Create lane -->
    <div v-else-if="mode === 'create'" class="flex flex-col gap-2">
      <template v-if="create.step === 'aadhaar'">
        <input class="cf-input" v-model="create.aadhaar" placeholder="Aadhaar number" maxlength="12" />
        <button class="btn-teal text-sm" :disabled="create.loading" @click="createSendAadhaarOtp()">
          <i class="fas" :class="create.loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i> Send OTP
        </button>
      </template>
      <template v-else-if="create.step === 'otp'">
        <input class="cf-input" v-model="create.otp" placeholder="Enter Aadhaar OTP" />
        <input class="cf-input" v-model="create.mobile" placeholder="Primary mobile number" />
        <button class="btn-teal text-sm" :disabled="create.loading" @click="createVerifyAadhaarOtp()">
          <i class="fas" :class="create.loading ? 'fa-spinner fa-spin' : 'fa-check'"></i> Verify &amp; Create ABHA
        </button>
      </template>
      <button class="btn-ghost text-xs" @click="reset()">Back</button>
    </div>
  </div>
</template>
