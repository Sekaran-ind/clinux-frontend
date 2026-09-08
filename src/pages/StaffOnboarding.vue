<script setup>
// A NEW, focused self-service onboarding page for a teammate added via Phase D's Team invite —
// distinct from Onboarding.vue (the admin's full clinic setup hub) and AbdmOnboarding.vue (the
// admin's full HFR/HPR registration console, 767 lines of Aadhaar/OTP flows, currently reachable
// only by typing its URL). This page has exactly two jobs: (1) let a new teammate add THEIR OWN
// entry to the Staff directory — name/role/specialization/qualification + the HPR identifiers,
// if they already have them — and (2) bring over the clinic's existing profile, since a fresh
// device otherwise shows the sandbox demo clinic instead of the real one (see
// clinux-mobile-sync-multiuser-video-roadmap memory note's Phase D gap).
//
// (2) used to be QR/text-key only, which meant a colleague physically needed another logged-in
// device in front of them just to accept an email invite from home. Now it's automatic: the
// existing LAN shared-server sync (sharedServerSync.js) already pulls this in for free if this
// device is on the clinic's own network; for anywhere else, a direct authenticated fetch against
// clinuxflow-api's own GET /api/provider-composition (see migrations/0005) does the same job
// without needing another device present at all. QR/text-key stays available as a manual
// fallback (SessionImportModal below) for the genuinely offline case — no LAN, no
// clinuxflow-api reachable — not deleted, just no longer the primary path.
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import CustomFormHost from '../components/CustomFormHost.vue';
import SessionImportModal from '../components/SessionImportModal.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import {
  seedSystemForms, activeQuestionnaire, sliceQuestionnaireGroup,
  getGroupInstances, getAnswer, patchGroupInstanceField, appendGroupResponseItem,
} from '../data/useSystemForms.js';
import { API_BASE, apiFetch } from '../config.js';

const router = useRouter();
const onboarding = useOnboardingStore();
const auth = useAuthStore();

seedSystemForms(API_BASE).catch(() => {});

// 'idle' | 'checking' | 'imported' | 'not_found' | 'error' -- surfaced in the UI so a teammate
// isn't left guessing whether the profile pull is still happening, worked, or genuinely has
// nothing to find yet (e.g. the admin hasn't finished Onboarding.vue at all). Only attempts this
// if there's no local Provider record already -- never overwrites a device's own existing data,
// same caution importProviderProfile()'s QR path already takes.
const autoImportStatus = ref('idle');

async function tryDirectProviderCompositionFetch() {
  if (onboarding.getProviderRecord()) { autoImportStatus.value = 'idle'; return; }
  autoImportStatus.value = 'checking';
  const res = await apiFetch(`${API_BASE}/api/provider-composition`).catch(() => null);
  if (!res) { autoImportStatus.value = 'error'; return; }
  if (res.status === 404) { autoImportStatus.value = 'not_found'; return; }
  const body = await res.json().catch(() => null);
  if (!body?.success) { autoImportStatus.value = 'error'; return; }

  onboarding.importProviderProfile({
    formId: onboarding.PROVIDER_FORM_ID,
    version: activeVersionNumber(onboarding.PROVIDER_FORM_ID),
    data: body.data,
    recordId: null, // no local record exists yet (checked above) -- this creates one, doesn't upsert an existing id
    branding: {},
  });
  autoImportStatus.value = 'imported';
  showToast("Brought in your clinic's profile.");
}

onMounted(() => {
  // A short delay, not immediate -- gives the LAN shared-server sync (which runs on its own
  // ensureSharedModeDetected() probe + poll cycle already) a real chance to have populated this
  // first if this device IS on the clinic's own network, so the direct fetch below only ends up
  // doing real work for the case it's actually needed for: a device that isn't.
  setTimeout(tryDirectProviderCompositionFetch, 1500);
});

const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3200);
}

// Real onboarding-UI audit/rebuild, Provider (Staff) — the same real, compiled Questionnaire
// Designer's Provider drawer and Cübo's Hospital Setup checklist both already render, sliced down
// to just this one group (see Cubo.vue's own hospitalStepQuestionnaire computed for the identical
// pattern).
const staffQuestionnaire = computed(() => {
  const full = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  return full ? sliceQuestionnaireGroup(full, 'section_staff') : null;
});

const drawerOpen = ref(false);
const staffFormHost = ref(null); // CustomFormHost's exposed { extract() }
const importModalOpen = ref(false);
const saveError = ref('');

// Every entry currently on the Staff directory — just for the "N teammate(s) already listed"
// count below, not identity-matched to this account (section_staff has no accountId field of
// its own; see the memory note on why that wasn't added for this v1).
function staffCount() {
  onboarding.dataVersion;
  return getGroupInstances(onboarding.getProviderRecord(), 'section_staff').length;
}

function openStaffDrawer() {
  drawerOpen.value = true; // LhcFormHost below always renders blank (:record="null") -- this page's own job is "add THIS teammate", never editing an existing one
  saveError.value = '';
}
function closeDrawer() {
  drawerOpen.value = false;
}

// Real onboarding-UI audit/rebuild, Provider (Staff) — swaps AbdmFieldForm/STAFF_FIELDS (a
// bespoke non-FHIR renderer, missing fields the real Questionnaire already has — staff_phone/
// staff_qualification/staff_license/staff_status) for real, FHIR-native capture against the same
// compiled section_staff group. Originally routed through LForms (LhcFormHost) here; superseded
// again almost immediately — "narrow lhcforms is getting difficult" (explicit instruction) — by
// CustomFormHost, a custom app-styled renderer reading the exact same compiled Questionnaire
// (still one real schema, never a second hand-maintained field list), just without delegating to
// the LForms JS widget library at all. Its extract() returns the same real QuestionnaireResponse
// shape LhcFormHost's did, so nothing below this comment needed to change. The LForms coded-field
// data-loss bug that originally justified AbdmFieldForm here (clinux-lforms-coded-field-data-loss-
// bug memory note) doesn't apply to CustomFormHost either way — it never delegates to LForms.
//
// Uses appendGroupResponseItem (APPEND one new instance) rather than Cübo's own
// mergeGroupResponseItems (REPLACE the whole group) — this drawer always renders blank, never
// pre-filled with other teammates' entries (privacy, and so a save here can never clobber anyone
// else's row the way submitting a pre-filled-with-everyone's-data form back through a
// replace-the-group helper would risk).
function saveDrawer() {
  const response = staffFormHost.value?.extract();
  if (!response || !response.item?.[0]) {
    saveError.value = 'Could not read the entered data. Please try again.';
    return;
  }
  saveError.value = '';
  const recordId = onboarding.ensureProviderRecord();
  const newIndexes = appendGroupResponseItem(recordId, 'section_staff', response.item);
  // appendGroupResponseItem() silently no-ops (returns []) for a recordId that doesn't resolve to
  // a real record — ensureProviderRecord() now guards against its own cached id going stale (see
  // its own comment), so this should be unreachable in practice, but a save genuinely failing
  // should never still claim "Saved" — that was a real, live-found gap this closes defensively.
  if (newIndexes.length === 0) {
    saveError.value = 'Could not save — please try again.';
    return;
  }
  onboarding.dataVersion++;
  showToast('Saved — thanks for joining the team!');
  drawerOpen.value = false;
  prepareSpecialtyTag(newIndexes[0]);
}

// --- Wikidata-assisted specialty tagging (SPEC-06 §6 / SPEC-08 Phase 1) — this is the concrete
// "how will this be used in the main flow" resolution for the staff-specialization Wikidata
// tagging that was paused earlier in this project: onboarding-time, once, not a runtime feature.
const specialtyTagCandidates = ref(null); // null = not searched yet / picker closed
const specialtyTagLoading = ref(false);
const specialtyTagApplied = ref(false);
const currentSpecialtyText = ref('');
let savedStaffInstanceIndex = -1;

// newIndex comes straight from appendGroupResponseItem()'s own return value now — no more
// guessing "last instance" the way plain LForms-document extraction used to require.
function prepareSpecialtyTag(newIndex) {
  specialtyTagCandidates.value = null;
  specialtyTagApplied.value = false;
  savedStaffInstanceIndex = newIndex;
  if (savedStaffInstanceIndex < 0) { currentSpecialtyText.value = ''; return; }
  const instances = getGroupInstances(onboarding.getProviderRecord(), 'section_staff');
  currentSpecialtyText.value = getAnswer({ data: instances[savedStaffInstanceIndex] }, 'staff_specialty') || '';
}

async function suggestSpecialtyWikidataTags() {
  if (!currentSpecialtyText.value) return;
  specialtyTagLoading.value = true;
  specialtyTagCandidates.value = null;
  try {
    const res = await apiFetch(`${API_BASE}/api/nlp/wikidata-search?term=${encodeURIComponent(currentSpecialtyText.value)}`);
    const body = await res.json().catch(() => null);
    specialtyTagCandidates.value = body?.success ? body.candidates : [];
  } catch (e) {
    specialtyTagCandidates.value = [];
  } finally {
    specialtyTagLoading.value = false;
  }
}

async function applySpecialtyWikidataTag(candidate) {
  specialtyTagCandidates.value = null;
  if (savedStaffInstanceIndex < 0 || !onboarding.providerRecordId) return;
  try {
    const res = await apiFetch(`${API_BASE}/api/nlp/wikidata-concept?qid=${encodeURIComponent(candidate.qid)}`);
    const body = await res.json().catch(() => null);
    if (!body?.success) return;
    patchGroupInstanceField(onboarding.providerRecordId, 'section_staff', savedStaffInstanceIndex, {
      staff_specialty_wikidata_qid: candidate.qid,
      staff_specialty_wikidata_aliases: body.concept.aliases.join(', '),
    });
    specialtyTagApplied.value = true;
    showToast('Specialty tagged.');
  } catch (e) {
    // Silent — tagging is a nice-to-have on top of an already-saved entry, not a blocker.
  }
}

// Deliberately does NOT close the modal here -- SessionImportModal shows its own "Clinic
// profile imported." success state and waits for the user to dismiss it themselves (X button /
// backdrop click, already wired to @close). Closing it immediately on this event would flash
// the modal shut before anyone ever saw that message — the same bug already fixed once in
// Onboarding.vue and once in FrontDesk.vue/Checkout.vue's encounter-import handler.
function onProfileImported() {
  autoImportStatus.value = 'imported';
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
        <CustomFormHost v-if="drawerOpen && staffQuestionnaire" ref="staffFormHost" :questionnaire="staffQuestionnaire" :record="null" />
        <p v-if="saveError" style="font-size:.75rem;color:#dc2626;margin-top:.6rem"><i class="fas fa-circle-exclamation"></i> {{ saveError }}</p>

        <!-- Post-save Wikidata specialty tagging -- see prepareSpecialtyTag()'s own comment for
             why this runs after save rather than inline in the LForms-rendered fields above. -->
        <div v-if="currentSpecialtyText && !specialtyTagApplied" class="cf-card" style="margin-top:1rem;padding:1rem;border-radius:.75rem;position:relative">
          <p style="font-size:.78rem;color:var(--cf-text-strong);font-weight:600;margin-bottom:.3rem">Tag your specialty: <span style="color:var(--color-primary)">{{ currentSpecialtyText }}</span></p>
          <p style="font-size:.7rem;color:var(--cf-text);margin-bottom:.6rem">Optional — helps this app recognize related terms for you. You always confirm the match yourself.</p>
          <button
            type="button" @click="suggestSpecialtyWikidataTags()" :disabled="specialtyTagLoading"
            class="btn-outline text-sm" style="display:flex;align-items:center;gap:.4rem"
          >
            <i :class="specialtyTagLoading ? 'fas fa-spinner fa-spin' : 'fas fa-wand-magic-sparkles'"></i>
            <span>Suggest from Wikidata</span>
          </button>
          <div v-if="specialtyTagCandidates" style="margin-top:.6rem;border:1px solid var(--cf-border);border-radius:.5rem;padding:.35rem">
            <p v-if="specialtyTagCandidates.length === 0" style="font-size:.72rem;color:var(--cf-text);padding:.35rem">No Wikidata match found.</p>
            <button
              v-for="c in specialtyTagCandidates" :key="c.qid"
              type="button" @click="applySpecialtyWikidataTag(c)"
              style="display:block;width:100%;text-align:left;padding:.4rem .5rem;border:none;background:transparent;cursor:pointer;border-radius:.35rem;font-size:.72rem"
            >
              <strong style="color:var(--cf-text-strong)">{{ c.label }}</strong>
              <span style="color:var(--cf-text)"> — {{ c.description || 'no description' }}</span>
            </button>
          </div>
        </div>
        <p v-else-if="specialtyTagApplied" style="font-size:.75rem;color:var(--color-primary);margin-top:1rem"><i class="fas fa-check"></i> Specialty tagged.</p>
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
          <h3 class="font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-cloud-arrow-down mr-2" style="color:var(--color-primary)"></i>Clinic Profile</h3>
        </div>

        <p v-if="autoImportStatus === 'checking'" class="text-sm mb-3" style="color:var(--cf-text)">
          <i class="fas fa-spinner fa-spin mr-1.5"></i>Bringing in your clinic's profile...
        </p>
        <p v-else-if="autoImportStatus === 'imported'" class="text-sm mb-3" style="color:var(--color-primary)">
          <i class="fas fa-check mr-1.5"></i>Your clinic's profile is on this device.
        </p>
        <p v-else-if="autoImportStatus === 'not_found'" class="text-sm mb-3" style="color:var(--cf-text)">
          Nothing's been set up for this clinic yet — once an admin completes Onboarding, revisit this page and it'll pull in automatically. You can still add your own Staff details below in the meantime.
        </p>
        <p v-else-if="autoImportStatus === 'error'" class="text-sm mb-3" style="color:var(--cf-text)">
          <i class="fas fa-circle-exclamation mr-1.5" style="color:#F59E0B"></i>Couldn't reach the clinic's profile automatically right now.
        </p>
        <p v-else class="text-sm mb-3" style="color:var(--cf-text)">
          Checked automatically — nothing to do here normally.
        </p>

        <!-- QR/text-key stays as a manual fallback for the genuinely offline case (no LAN
             shared-server, clinuxflow-api unreachable) -- demoted, not removed. -->
        <button v-if="autoImportStatus !== 'imported'" class="btn-outline text-sm" @click="importModalOpen = true"><i class="fas fa-qrcode"></i> Or Scan / Paste a Transfer Key Instead</button>
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
