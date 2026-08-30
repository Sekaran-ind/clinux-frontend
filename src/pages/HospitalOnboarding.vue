<script setup>
// SPEC-11 (docs/SPEC-11-ABDM-M1-M4-ALIGNMENT.md): the HFR half of the prerequisite-layer
// onboarding journey — offered to Hospital Admin and Admin-and-Health-Professional accounts from
// ClinicHome's user menu, mirroring StaffOnboarding.vue's self-service pattern for HPR. This page
// has one job: capture the facility's own identity + HFR-required fields.
//
// Two real differences from StaffOnboarding.vue, both because Hospital is a SINGULAR record
// (edit-in-place) where Staff is a repeating one (always a fresh new entry):
//   1. The drawer pre-fills from whatever's already saved, so returning to finish/fix the
//      facility's details doesn't start over from blank every time.
//   2. HOSPITAL_FIELDS' real data spans THREE separate non-repeating YAML groups (confirmed
//      against the compiled system-provider-composition-v1.yaml, see abdmSchema.js's own header
//      comment) — appendGroupInstance() (Staff's save mechanism) doesn't apply here at all;
//      saveDrawer() below splits one flat values object across each field's declared groupLinkId
//      and writes each group with withGroupFields() (the same helper Encounter/SOAP/Billing
//      already use for their own singular groups).
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import AbdmFieldForm from '../components/AbdmFieldForm.vue';
import { HOSPITAL_FIELDS } from '../data/abdmSchema.js';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import { seedSystemForms, getAnswer, withGroupFields, saveDataRecord, activeVersionNumber } from '../data/useSystemForms.js';
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
const hospitalFormRecord = ref(null); // { id, formId, data } | null -- pre-fills AbdmFieldForm from whatever's already saved
const hospitalForm = ref(null); // AbdmFieldForm's exposed { values, missingRequired(), touchAll() }
const saveError = ref('');

function openHospitalDrawer() {
  drawerOpen.value = true;
  hospitalFormRecord.value = onboarding.getProviderRecord(); // null if nothing saved yet -> AbdmFieldForm starts blank
  saveError.value = '';
}
function closeDrawer() {
  drawerOpen.value = false;
}

function hospitalName() {
  onboarding.dataVersion;
  return getAnswer(onboarding.getProviderRecord(), 'hospital_name');
}

async function saveDrawer() {
  const missing = hospitalForm.value?.missingRequired() || [];
  if (missing.length > 0) {
    hospitalForm.value.touchAll();
    saveError.value = 'A few required fields still need your input above.';
    return;
  }
  saveError.value = '';

  const recordId = onboarding.ensureProviderRecord();
  const record = onboarding.getProviderRecord();
  const values = hospitalForm.value.values;

  // Split ONE flat values object across HOSPITAL_FIELDS' declared groupLinkIds -- see this
  // file's own header comment and abdmSchema.js's for why Hospital needs 3 separate writes where
  // Staff only ever needed one.
  const byGroup = {};
  HOSPITAL_FIELDS.forEach((f) => {
    (byGroup[f.groupLinkId] ||= {})[f.linkId] = values[f.linkId];
  });

  // Defensive fallback, not the primary fix -- ensureProviderRecord() above now verifies its
  // cached id still resolves to a real record (see its own comment for the real bug this was
  // masking), so getProviderRecord() should never actually return null here anymore. Kept anyway
  // so a genuinely unexpected null can never crash this save outright the way it did live.
  let recordData = record?.data || { item: [] };
  Object.entries(byGroup).forEach(([groupLinkId, fieldValues]) => {
    recordData = withGroupFields(recordData, groupLinkId, fieldValues);
  });

  saveDataRecord(onboarding.PROVIDER_FORM_ID, activeVersionNumber(onboarding.PROVIDER_FORM_ID), recordData, recordId);
  onboarding.dataVersion++;
  drawerOpen.value = false;

  // Real, previously-reported defect: saving here alone left ClinicHome's PUBLIC page showing
  // DEMO_CLINIC forever, because publishedClinic only ever reflects the Provider record once
  // publish() has been called at least once (see onboarding.js's own comment on everPublished) —
  // nothing in this flow used to call it. This self-service journey has no separate "Publish"
  // step of its own the way the old Onboarding.vue hub does; saving a name here should make the
  // page go live immediately, matching what "very user friendly" actually requires. publish()
  // itself already no-ops safely if hospital_name isn't set (returns null, doesn't flip
  // everPublished) — fine to call unconditionally rather than duplicating that check here.
  onboarding.publish();

  // Replaces the placeholder clinicName sign-up left behind (see SPEC-11) with the real facility
  // name, now that we have one — best-effort, doesn't block the save itself if it fails. publish()
  // above already syncs it into the LOCAL session (syncRegisteredUser); this covers the SERVER
  // round-trip so a fresh login/different device also sees the real name, not the placeholder.
  const name = values.hospital_name;
  if (name) await auth.updateClinicName(name).catch(() => {});

  showToast('Saved — your facility details are up to date.');
}

function finish() {
  router.push('/clinic-home');
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i><span>{{ toast.msg }}</span></div>

  <div class="drawer-backdrop" :class="drawerOpen ? 'open' : ''" @click="closeDrawer()"></div>
  <div class="drawer-panel" :class="drawerOpen ? 'open' : ''">
    <div class="drawer-header">
      <h3 style="font-size:.95rem;font-weight:700;color:var(--cf-text-strong)">My Facility Details</h3>
      <button @click="closeDrawer()" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <div class="preview-panel">
        <AbdmFieldForm v-if="drawerOpen" ref="hospitalForm" :fields="HOSPITAL_FIELDS" :record="hospitalFormRecord" />
        <p v-if="saveError" style="font-size:.75rem;color:#dc2626;margin-top:.6rem"><i class="fas fa-circle-exclamation"></i> {{ saveError }}</p>
      </div>
    </div>
    <div class="drawer-footer">
      <button class="btn-teal" @click="saveDrawer()" style="display:flex;align-items:center;gap:.4rem">
        <i class="fas fa-floppy-disk"></i>
        <span>Save</span>
      </button>
    </div>
  </div>

  <main style="flex:1;overflow-y:auto">
    <div style="max-width:720px;margin:0 auto;padding:3rem 1.5rem 4rem">
      <span class="section-eyebrow" style="display:block;margin-bottom:.75rem">Facility Registration (HFR)</span>
      <h1 style="font-size:2rem;font-weight:800;color:var(--cf-text-strong);line-height:1.15;letter-spacing:-1px;margin-bottom:.875rem">
        {{ auth.currentUser?.adminName || 'Hi' }}, let's set up<br>
        <span style="color:var(--color-primary)">your facility</span>.
      </h1>
      <p style="font-size:.95rem;color:var(--cf-text);line-height:1.7;margin-bottom:2rem">
        Facility name, address, and the details ABDM's Health Facility Registry (HFR) needs.
        You can save and come back to finish this any time.
      </p>

      <div class="cf-card rounded-2xl p-5 mb-4">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-hospital mr-2" style="color:var(--color-primary)"></i>Facility Details</h3>
        </div>
        <p class="text-sm mb-3" style="color:var(--cf-text)">
          Name, address, ownership, facility type, and location codes — everything HFR registration needs.
        </p>
        <button class="btn-teal text-sm" @click="openHospitalDrawer()"><i class="fas fa-pen"></i> {{ hospitalName() ? 'Edit Facility Details' : 'Add Facility Details' }}</button>
        <p class="text-xs mt-2" style="color:var(--cf-text)">{{ hospitalName() || 'Not started yet' }}</p>
      </div>

      <!-- SPEC-14 (docs/SPEC-14-HFSM-RUNTIME-AND-CHAT-FIRST-CAPTURE.md) §7 — additive entry point
           to the new HFSM+chat-first flow, side by side with the drawer above, not replacing it. -->
      <div class="cf-card rounded-2xl p-5 mb-4">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-comments mr-2" style="color:var(--color-primary)"></i>Try the chat-based setup</h3>
        </div>
        <p class="text-sm mb-3" style="color:var(--cf-text)">
          Same facility details, asked one question at a time instead of a form — an in-progress alternative to the drawer above.
        </p>
        <router-link to="/hospital-onboarding/chat" class="btn-outline text-sm" style="display:inline-flex;align-items:center;gap:.4rem;text-decoration:none">
          <i class="fas fa-arrow-right"></i> Start chat setup
        </router-link>
      </div>

      <button class="btn-primary" @click="finish()">Go to Clinic Home <i class="fas fa-arrow-right ml-2"></i></button>
    </div>
  </main>
</template>
