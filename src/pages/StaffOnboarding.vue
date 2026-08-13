<script setup>
// A NEW, focused self-service onboarding page for a teammate added via Phase D's Team invite —
// distinct from Onboarding.vue (the admin's full clinic setup hub) and AbdmOnboarding.vue (the
// admin's full HFR/HPR registration console, 767 lines of Aadhaar/OTP flows, currently reachable
// only by typing its URL). This page has exactly two jobs: (1) let a new teammate add THEIR OWN
// entry to the Staff directory — name/role/specialization/qualification + the HPR identifiers,
// if they already have them — and (2) bring over the clinic's existing profile via the QR/text-
// key transfer (see sessionShare.js's buildProviderProfileSharePayload/decodeProviderProfileShareKey),
// since a fresh device otherwise shows the sandbox demo clinic instead of the real one (see
// clinux-mobile-sync-multiuser-video-roadmap memory note's Phase D gap).
//
// Reuses the SAME Provider-composition questionnaire + drawer/LhcFormHost pattern Onboarding.vue
// already uses (LhcFormHost renders the WHOLE document regardless of which card opened it — an
// already-accepted tradeoff in this codebase, not a new one) — scrollToLinkId is what makes this
// feel staff-focused rather than generic: it auto-scrolls straight to the Staff Details section
// instead of landing on Hospital Profile at the top.
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import LhcFormHost from '../components/LhcFormHost.vue';
import SessionImportModal from '../components/SessionImportModal.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import { activeQuestionnaire, seedSystemForms, getGroupInstances } from '../data/useSystemForms.js';
import { API_BASE } from '../config.js';

const router = useRouter();
const onboarding = useOnboardingStore();
const auth = useAuthStore();

seedSystemForms(API_BASE).catch(() => {});

const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3200);
}

const drawerOpen = ref(false);
const drawerQuestionnaire = ref(null);
const drawerRecord = ref(null);
const formKey = ref(0);
const lhcFormHost = ref(null);
const importModalOpen = ref(false);

// Every entry currently on the Staff directory — just for the "N teammate(s) already listed"
// count below, not identity-matched to this account (section_staff has no accountId field of
// its own; see the memory note on why that wasn't added for this v1).
function staffCount() {
  onboarding.dataVersion;
  return getGroupInstances(onboarding.getProviderRecord(), 'section_staff').length;
}

function openStaffDrawer() {
  drawerOpen.value = true;
  drawerQuestionnaire.value = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  drawerRecord.value = onboarding.getProviderRecord() || onboarding.buildSeedFromRegistration();
}
function closeDrawer() {
  drawerOpen.value = false;
}
function saveDrawer() {
  const ok = onboarding.saveProviderRecord('staffOnboardingFormContainer');
  if (!ok) { showToast('Could not read the entered data.'); return; }
  formKey.value++;
  showToast('Saved — thanks for joining the team!');
}

// Deliberately does NOT close the modal here -- SessionImportModal shows its own "Clinic
// profile imported." success state and waits for the user to dismiss it themselves (X button /
// backdrop click, already wired to @close). Closing it immediately on this event would flash
// the modal shut before anyone ever saw that message — the same bug already fixed once in
// Onboarding.vue and once in FrontDesk.vue/Checkout.vue's encounter-import handler.
function onProfileImported() {
  showToast('Clinic profile imported.');
}

function finish() {
  router.push('/clinic-home');
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i><span>{{ toast.msg }}</span></div>

  <SessionImportModal :open="importModalOpen" @close="importModalOpen = false" @profile-imported="onProfileImported" />

  <div class="drawer-backdrop" :class="drawerOpen ? 'open' : ''" @click="closeDrawer()"></div>
  <div class="drawer-panel" :class="drawerOpen ? 'open' : ''">
    <div class="drawer-header">
      <h3 style="font-size:.95rem;font-weight:700;color:var(--cf-text-strong)">My Staff Details</h3>
      <button @click="closeDrawer()" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <div class="preview-panel">
        <LhcFormHost v-if="drawerOpen && drawerQuestionnaire" :key="formKey" ref="lhcFormHost" :questionnaire="drawerQuestionnaire" :record="drawerRecord" container-id="staffOnboardingFormContainer" scroll-to-link-id="section_staff" />
        <p v-else-if="drawerOpen" class="text-sm" style="color:var(--cf-text)">
          This form isn't available yet — clinuxflow-api may not be reachable to seed it. Confirm it's running, then reopen this drawer.
        </p>
      </div>
    </div>
    <div class="drawer-footer">
      <button class="btn-teal" @click="saveDrawer()" style="display:flex;align-items:center;gap:.4rem">
        <i class="fas fa-plus"></i>
        <span>Add / Save</span>
      </button>
    </div>
  </div>

  <main style="flex:1;overflow-y:auto">
    <div style="max-width:720px;margin:0 auto;padding:3rem 1.5rem 4rem">
      <span class="section-eyebrow" style="display:block;margin-bottom:.75rem">Welcome to the team</span>
      <h1 style="font-size:2rem;font-weight:800;color:var(--cf-text-strong);line-height:1.15;letter-spacing:-1px;margin-bottom:.875rem">
        {{ auth.currentUser?.adminName || 'Hi' }}, let's get you set up<br>
        at <span style="color:var(--color-primary)">{{ auth.currentUser?.clinicName || 'your clinic' }}</span>.
      </h1>
      <p style="font-size:.95rem;color:var(--cf-text);line-height:1.7;margin-bottom:2rem">
        Two quick things: bring over the clinic's existing profile if a teammate already set one up
        elsewhere, and add your own name, role, specialization and (if you already have one) your HPR
        registration to the Staff directory.
      </p>

      <div class="cf-card rounded-2xl p-5 mb-4">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-qrcode mr-2" style="color:var(--color-primary)"></i>Import the Clinic's Profile</h3>
        </div>
        <p class="text-sm mb-3" style="color:var(--cf-text)">
          Scan or paste the key another teammate on this same clinic generated from their own device
          (via their profile menu's "Share Clinic Profile"). Skip this if your device already has it.
        </p>
        <button class="btn-outline text-sm" @click="importModalOpen = true"><i class="fas fa-qrcode"></i> Scan / Paste to Import</button>
      </div>

      <div class="cf-card rounded-2xl p-5 mb-4">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-user-md mr-2" style="color:var(--color-primary)"></i>Add Yourself to the Staff Directory</h3>
        </div>
        <p class="text-sm mb-3" style="color:var(--cf-text)">
          Name, role, specialization, qualification, and your HPR ID if you already have one from
          ABDM's registry. Opens the clinic's full profile form, scrolled straight to Staff Details —
          you only need to fill in your own entry there.
        </p>
        <button class="btn-teal text-sm" @click="openStaffDrawer()"><i class="fas fa-user-plus"></i> Add My Details</button>
        <p class="text-xs mt-2" style="color:var(--cf-text)">{{ staffCount() }} staff member(s) currently listed.</p>
      </div>

      <button class="btn-primary" @click="finish()">Go to Clinic Home <i class="fas fa-arrow-right ml-2"></i></button>
    </div>
  </main>
</template>
