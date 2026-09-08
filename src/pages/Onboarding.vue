<script setup>
// Ported from clinixflow's public/onboarding.html — the clinic setup hub (hub → review →
// published screens), each journey card backed by a real FHIR record via the same
// SystemForms/LhcFormHost drawer pattern Front Desk uses.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import CustomFormHost from '../components/CustomFormHost.vue';
import FacilityBasicsHost from '../components/FacilityBasicsHost.vue';
import SessionImportModal from '../components/SessionImportModal.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import {
  activeQuestionnaire, sliceQuestionnaireGroup, sliceRecordGroup, seedSystemForms,
  getGroupInstances, getAnswer, mergeGroupResponseItem, mergeGroupResponseItems,
  saveDataRecord, activeVersionNumber,
} from '../data/useSystemForms.js';
import { checkFacilityConformance } from '../data/facilityConformance.js';
import { API_BASE } from '../config.js';

const router = useRouter();
const onboarding = useOnboardingStore();

const screen = ref(localStorage.getItem('cf_onboarding_screen') || 'hub'); // 'hub' | 'review' | 'published'
const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3200);
}

const drawerOpen = ref(false);
const activeForm = ref(null); // the journeyCards entry currently open in the drawer
const drawerQuestionnaire = ref(null);
const drawerRecord = ref(null);
const customFormHost = ref(null);

// Every card now points at one groupLinkId inside the single, shared Provider-composition
// record instead of its own separate formId (see clinux-provider-composition-merge memory
// note) — Hospital's own card has no repeating count, its "status" is just whether the one
// required field is filled in yet.
//
// A computed, not a plain const, so a standalone individual practitioner (facilityType ===
// 'individual', see the Register form's own fork + migrations/0005) sees labels that actually
// describe them rather than always assuming a multi-staff facility — the underlying FHIR data
// (still Organization/Practitioner/HealthcareService) is unchanged, this is presentation only.
// Deliberately does NOT remove the Care Team card for individuals -- a solo practitioner may
// still have an assistant or two; "0 added" is a perfectly honest, harmless state to show them,
// not worth a bigger restructure to hide.
const isIndividual = computed(() => onboarding.registeredUser?.facilityType === 'individual');
const journeyCards = computed(() => [
  {
    groupLinkId: 'section_hospital', mode: 'single', icon: 'fas fa-hospital', color: '#3B82F6', bg: 'rgba(59,130,246,.1)',
    title: isIndividual.value ? 'Practice Profile' : 'Hospital Profile',
    desc: isIndividual.value ? 'Your consultation practice as a FHIR Organization resource.' : 'Your clinic profile as a FHIR Organization resource.',
  },
  {
    groupLinkId: 'section_staff', mode: 'repeatable', icon: 'fas fa-user-md', color: '#00D4B2', bg: 'rgba(0,212,178,.1)',
    title: isIndividual.value ? 'Assistants (optional)' : 'Care Team',
    desc: isIndividual.value ? 'Add any assistants or support staff, if you have them.' : 'Add physicians, nurses and staff as FHIR Practitioner records.',
  },
  { groupLinkId: 'section_services_matrix', mode: 'repeatable', icon: 'fas fa-stethoscope', color: '#8B5CF6', bg: 'rgba(139,92,246,.1)', title: 'Services', desc: "List the services your clinic offers." },
  { groupLinkId: 'section_hours', mode: 'repeatable', icon: 'fas fa-clock', color: '#F59E0B', bg: 'rgba(245,158,11,.1)', title: 'Office Hours', desc: 'Add operating hours, one day-range at a time.' },
  { groupLinkId: 'section_consent', mode: 'repeatable', icon: 'fas fa-file-signature', color: '#EF4444', bg: 'rgba(239,68,68,.1)', title: 'Legal Consents', desc: 'Add the consent types your clinic collects from patients.' },
  { action: 'designer', icon: 'fas fa-layer-group', color: '#06B6D4', bg: 'rgba(6,182,212,.1)', title: 'Open Designer', desc: 'Manage versions, training and the full data grid for every form.' },
]);

seedSystemForms(API_BASE).catch(() => {});

// Phase C extension: importing this clinic's OWN profile (Hospital/Staff/Services/Hours/
// Consents + branding) on a fresh device/teammate login — see sessionShare.js's
// decodeProviderProfileShareKey and onboarding.js's importProviderProfile(). Most useful right
// here, BEFORE any local onboarding has happened at all (a teammate's fresh device, the exact
// gap this closes), so it's offered unconditionally. The Share/generate side lives in
// ClinicHome's admin profile menu instead (see the Team memory note) — that's the discoverable
// "my account/clinic" surface, not this setup hub.
const importProfileModalOpen = ref(false);
// Deliberately does NOT close the modal here -- same lesson as FrontDesk.vue/Checkout.vue's
// onSessionImported: SessionImportModal shows its own "Clinic profile imported." success state
// and waits for the user to dismiss it (X button / backdrop click, both already wired to
// @close). Closing it immediately on this event would flash the modal shut before anyone ever
// saw that message.
function onProfileImported() {
  showToast('Clinic profile imported.');
}

const screenLabel = computed(() => ({ hub: 'Setup', review: 'Review', published: 'Published' }[screen.value] || 'Setup'));

function groupInstances(groupLinkId) {
  onboarding.dataVersion; // register the reactive dependency
  return getGroupInstances(onboarding.getProviderRecord(), groupLinkId);
}

function cardStatus(card) {
  if (card.mode === 'single') return getAnswer(onboarding.getProviderRecord(), 'hospital_name') ? 'Saved' : 'Not started';
  const n = groupInstances(card.groupLinkId).length;
  return n > 0 ? `${n} added` : 'Not started';
}

// Real onboarding-UI rebuild — the drawer now renders ONLY the clicked card's own group, sliced
// from the same real compiled Questionnaire (sliceQuestionnaireGroup/sliceRecordGroup, the same
// primitives Cübo's Hospital Setup checklist already proved out), not the whole accumulating
// Provider document every time. That "whole document in one drawer" behavior was itself part of
// what made this "getting difficult" (explicit instruction) — clicking Care Team used to open
// Hospital+Staff+Services+Hours+Consent all stacked together, scrolled to the top.
function openDrawer(card) {
  activeForm.value = card;
  drawerOpen.value = true;

  const q = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  drawerQuestionnaire.value = q ? sliceQuestionnaireGroup(q, card.groupLinkId) : null;
  if (!q) { drawerRecord.value = null; return; }

  // Falls back to a synthetic record built from the index.html registration account the very
  // first time, so this doesn't open blank when that info was already given at sign-up.
  const fullRecord = onboarding.getProviderRecord() || onboarding.buildSeedFromRegistration();
  drawerRecord.value = fullRecord ? sliceRecordGroup(fullRecord, card.groupLinkId) : null;
}

function openCard(card) {
  if (card.action === 'designer') router.push('/designer');
  else openDrawer(card);
}

function closeDrawer() {
  drawerOpen.value = false;
  conformanceResult.value = null;
}

// SPEC-24 §7 step 5 — the real chain, live: extract -> validate against ClinuxFlowFacility ->
// next-best-action, over the WHOLE Provider record (not just this drawer's own section_hospital
// slice — see facilityConformance.js's own header on why). Deliberately on-demand (a button, not
// auto-run on save) rather than baked into saveDrawerRecord()'s existing close-on-save flow for
// 'single' mode cards — checking "is the whole FHIR Facility profile satisfied yet" is a distinct
// question from "did this one save succeed", and most clinics (free tier, no ABDM registration —
// SPEC-05) will never see this go green, which is expected, not an error state to force past.
const conformanceLoading = ref(false);
const conformanceResult = ref(null); // { valid, errors, nextActions } | { error } | null
async function checkConformance() {
  conformanceLoading.value = true;
  const questionnaireJson = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  const responseJson = onboarding.getProviderRecord()?.data;
  conformanceResult.value = (questionnaireJson && responseJson)
    ? await checkFacilityConformance(questionnaireJson, responseJson)
    : { error: 'Save the Hospital Profile first.' };
  conformanceLoading.value = false;
}

// Real onboarding-UI rebuild — merges just this one group back into the Provider record
// (mergeGroupResponseItem/mergeGroupResponseItems, the same surgical per-group primitives Cübo's
// Hospital Setup checklist already uses) instead of extracting and overwriting the WHOLE
// document. CustomFormHost's own extract() already blocks and inline-flags missing required
// fields, returning null — mirrors LhcFormHost/extractResponse()'s existing failure contract, so
// this only needs to check for that, not re-validate anything itself.
function saveDrawerRecord() {
  if (!activeForm.value || !customFormHost.value) return;
  const response = customFormHost.value.extract();
  if (!response) { showToast('Please fill in the required fields.'); return; }

  const groupLinkId = activeForm.value.groupLinkId;
  const recordId = onboarding.ensureProviderRecord();
  const record = onboarding.getProviderRecord();
  const mergedData = activeForm.value.mode === 'repeatable'
    ? mergeGroupResponseItems(record?.data || { item: [] }, groupLinkId, response.item || [])
    : mergeGroupResponseItem(record?.data || { item: [] }, response.item[0] || { linkId: groupLinkId, item: [] });
  saveDataRecord(onboarding.PROVIDER_FORM_ID, activeVersionNumber(onboarding.PROVIDER_FORM_ID), mergedData, recordId);
  onboarding.dataVersion++;

  if (activeForm.value.mode === 'repeatable') {
    // Stay open — CustomFormHost's own "+ Add Another" is how multiple entries get added, not a
    // separate save-per-entry action (same pattern Front Desk/Checkout already use for Vitals/
    // Prescription/Billing). Re-slice from the just-saved record so every existing instance
    // (including the one just added) is visible.
    drawerRecord.value = sliceRecordGroup(onboarding.getProviderRecord(), groupLinkId);
    showToast('Added.');
  } else {
    showToast('Saved.');
    closeDrawer();
  }
}

function goToReview() {
  if (!getAnswer(onboarding.getProviderRecord(), 'hospital_name')) {
    showToast('Please complete your Hospital Profile first.');
    openDrawer(journeyCards.value[0]);
    return;
  }
  screen.value = 'review';
  localStorage.setItem('cf_onboarding_screen', 'review');
  window.scrollTo(0, 0);
}

function backToHub() {
  screen.value = 'hub';
  localStorage.setItem('cf_onboarding_screen', 'hub');
  window.scrollTo(0, 0);
}

const reviewStats = computed(() => [
  { label: 'Staff Members', value: groupInstances('section_staff').length },
  { label: 'Services', value: groupInstances('section_services_matrix').length },
  { label: 'Consents Added', value: groupInstances('section_consent').length },
  { label: 'Hours Entries', value: groupInstances('section_hours').length },
]);

const fhirPreview = computed(() => {
  onboarding.dataVersion;
  const providerRec = onboarding.getProviderRecord();
  return providerRec ? JSON.stringify(providerRec.data, null, 2) : '// Complete the Hospital Profile card to see the Provider record\'s FHIR QuestionnaireResponse here.';
});

function copyFhir() {
  navigator.clipboard.writeText(fhirPreview.value).then(() => showToast('FHIR data copied to clipboard.')).catch(() => showToast('Copy failed.'));
}

function publishClinic() {
  const profile = onboarding.publish();
  if (!profile) { showToast('Please complete the clinic profile first.'); screen.value = 'hub'; return; }
  screen.value = 'published';
  localStorage.setItem('cf_onboarding_screen', 'published');
  window.scrollTo(0, 0);
  showToast(`🚀 ${profile.name} is now live!`);
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i><span>{{ toast.msg }}</span></div>

  <SessionImportModal :open="importProfileModalOpen" @close="importProfileModalOpen = false" @profile-imported="onProfileImported" />

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
        <!-- SPEC-24 §1/§6: Hospital Profile is the first card off CustomFormHost (a hand-authored
             replacement, real named fields via AdaptiveSectionNav) — the other cards stay on it
             until they get their own pass (spec §7 step 7). -->
        <FacilityBasicsHost v-if="drawerOpen && activeForm?.groupLinkId === 'section_hospital'" ref="customFormHost" :record="drawerRecord" />
        <CustomFormHost v-else-if="drawerOpen && drawerQuestionnaire" ref="customFormHost" :questionnaire="drawerQuestionnaire" :record="drawerRecord" />
      </div>

      <!-- SPEC-24 §7 step 5: the real conformance chain, on demand — see checkConformance()'s own
           comment on why this isn't auto-run on save. Facility-only; Provider/Affiliate/Patient
           get the same treatment once THEY have a real Profile-anchored capture UI (step 6). -->
      <div v-if="drawerOpen && activeForm?.groupLinkId === 'section_hospital'" class="cf-card rounded-2xl p-4 mt-3">
        <div class="flex items-center justify-between mb-2">
          <p class="cf-label mb-0">FHIR Facility Conformance <span style="font-weight:400">(ClinuxFlowFacility profile)</span></p>
          <button class="btn-ghost text-xs px-2 py-1" :disabled="conformanceLoading" @click="checkConformance()">
            <i class="fas" :class="conformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
          </button>
        </div>
        <p v-if="!conformanceResult" class="text-xs" style="color:var(--cf-text)">
          Checks the saved profile — across this page AND ABDM Registration — against the full HFR-grounded Facility schema. Most clinics won't see this go green unless they've completed ABDM registration too; that's expected, not required to publish.
        </p>
        <p v-else-if="conformanceResult.error" class="text-xs" style="color:#b91c1c">{{ conformanceResult.error }}</p>
        <template v-else>
          <p class="text-xs font-semibold mb-2" :style="conformanceResult.valid ? 'color:var(--color-primary)' : 'color:var(--cf-text)'">
            <i class="fas" :class="conformanceResult.valid ? 'fa-circle-check' : 'fa-circle-info'"></i>
            {{ conformanceResult.valid ? 'Fully conformant.' : `${conformanceResult.errors.length} field(s) still needed for full conformance.` }}
          </p>
          <ul v-if="!conformanceResult.valid" style="font-size:.72rem;color:var(--cf-text);padding-left:1rem;max-height:140px;overflow-y:auto">
            <li v-for="e in conformanceResult.errors" :key="e.path">{{ e.message }}</li>
          </ul>
          <div v-if="conformanceResult.valid && conformanceResult.nextActions?.length" class="mt-2">
            <p class="text-xs font-semibold" style="color:var(--cf-text-strong)">Next up:</p>
            <ul style="font-size:.72rem;color:var(--cf-text);padding-left:1rem">
              <li v-for="a in conformanceResult.nextActions" :key="a.linkId">{{ a.reason }}</li>
            </ul>
          </div>
        </template>
      </div>
    </div>
    <!-- Repeating-group add/remove is LForms' own native "+ Add another" control inside the
         form now, not a separate app-level list — same precedent as Front Desk/Checkout's
         Vitals/Prescription/Billing sections. -->
    <div class="drawer-footer">
      <button class="btn-teal" @click="saveDrawerRecord()" style="display:flex;align-items:center;gap:.4rem">
        <i class="fas" :class="activeForm && activeForm.mode === 'single' ? 'fa-save' : 'fa-plus'"></i>
        <span>{{ activeForm && activeForm.mode === 'single' ? 'Save' : 'Add' }}</span>
      </button>
    </div>
  </div>

  <main style="flex:1;overflow-y:auto">
  <div style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem 4rem">

    <!-- HUB -->
    <div v-show="screen === 'hub'" class="screen-panel">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;align-items:start">
        <div>
          <span class="section-eyebrow" style="display:block;margin-bottom:.75rem">{{ onboarding.registeredUser ? 'Welcome back' : 'Welcome to ClinixFlow' }}</span>
          <div class="teal-line" style="margin-bottom:1.25rem"></div>
          <h1 v-if="!onboarding.registeredUser" style="font-size:2.25rem;font-weight:800;color:var(--cf-text-strong);line-height:1.15;letter-spacing:-1px;margin-bottom:.875rem">
            Set up your clinic's<br><span style="color:var(--color-primary)">digital presence</span><br>in minutes.
          </h1>
          <h1 v-else style="font-size:2.25rem;font-weight:800;color:var(--cf-text-strong);line-height:1.15;letter-spacing:-1px;margin-bottom:.875rem">
            {{ onboarding.registeredUser?.adminName }}, let's finish setting up<br><span style="color:var(--color-primary)">{{ onboarding.registeredUser?.clinicName }}</span>.
          </h1>
          <p style="font-size:.95rem;color:var(--cf-text);line-height:1.7;margin-bottom:1.5rem">
            Tap a card to add that piece of your clinic's profile — each opens a quick entry panel and saves as a real FHIR record. Add as much or as little as you like, then review and publish when ready.
          </p>
          <div style="display:flex;gap:.75rem;flex-wrap:wrap">
            <button class="btn-teal" @click="goToReview()" style="display:flex;align-items:center;gap:.5rem"><i class="fas fa-arrow-right"></i>Continue to Review</button>
            <RouterLink to="/clinic-home" target="_blank" class="btn-outline" style="display:flex;align-items:center;gap:.5rem"><i class="fas fa-eye"></i>See Sample Page</RouterLink>
          </div>
          <!-- Already part of this clinic on another device? Import brings over the whole
               profile (Hospital/Staff/Services/Hours/Consents + branding) instead of re-typing
               it — most useful right here, before any local onboarding exists at all. (The
               Share side of this now lives in ClinicHome's admin profile menu, next to Team —
               that's the discoverable "my account/clinic" surface; this hub is Import-only.) -->
          <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:.625rem">
            <button class="btn-outline text-sm" @click="importProfileModalOpen = true"><i class="fas fa-qrcode"></i> Import Clinic Profile</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
          <button v-for="card in journeyCards" :key="card.groupLinkId || card.title" class="entry-card" @click="openCard(card)">
            <div style="width:36px;height:36px;border-radius:.625rem;display:flex;align-items:center;justify-content:center;margin-bottom:.75rem" :style="`background:${card.bg}`">
              <i :class="card.icon" :style="`color:${card.color};font-size:.9rem`"></i>
            </div>
            <p style="font-weight:700;font-size:.85rem;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ card.title }}</p>
            <p style="font-size:.75rem;color:var(--cf-text);line-height:1.45;margin-bottom:.5rem">{{ card.desc }}</p>
            <span v-show="card.action === 'designer'" style="font-size:.72rem;color:var(--color-primary);font-weight:600;font-family:'Poppins',sans-serif"><i class="fas fa-arrow-right" style="margin-right:.3rem"></i>Open Designer</span>
            <span v-show="card.groupLinkId" class="badge" :class="cardStatus(card) !== 'Not started' ? 'badge-teal' : 'badge-muted'">{{ cardStatus(card) }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- REVIEW & PUBLISH -->
    <div v-show="screen === 'review'" class="screen-panel">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1.5rem">
        <div>
          <span class="section-eyebrow" style="display:block;margin-bottom:.4rem">Review & Publish</span>
          <h2 style="font-size:1.5rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.35rem">Everything look right?</h2>
          <p style="font-size:.85rem;color:var(--cf-text)">Launch your clinic page and start onboarding patients — or go back and add more.</p>
        </div>
        <button class="btn-ghost" @click="backToHub()"><i class="fas fa-arrow-left text-xs mr-1"></i>Back</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.5rem">
        <div class="cf-card" style="border-radius:1rem;padding:1.25rem">
          <h4 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.875rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-hospital" style="color:var(--color-primary)"></i>Clinic Profile</h4>
          <div style="display:flex;flex-direction:column;gap:.45rem">
            <div style="display:flex;justify-content:space-between;font-size:.82rem"><span style="color:var(--cf-text)">Name</span><span style="font-weight:600;color:var(--cf-text-strong)">{{ onboarding.buildClinicProfile().name || '—' }}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:.82rem"><span style="color:var(--cf-text)">Type</span><span style="font-weight:600;color:var(--cf-text-strong)">{{ onboarding.buildClinicProfile().type || '—' }}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:.82rem"><span style="color:var(--cf-text)">City</span><span style="font-weight:600;color:var(--cf-text-strong)">{{ onboarding.buildClinicProfile().city || '—' }}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:.82rem"><span style="color:var(--cf-text)">Phone</span><span style="font-weight:600;color:var(--cf-text-strong)">{{ onboarding.buildClinicProfile().phone || '—' }}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:.82rem"><span style="color:var(--cf-text)">URL</span><span style="font-weight:600;color:var(--color-primary)">{{ 'clinixflow.ai/' + (onboarding.buildClinicProfile().slug || 'your-clinic') }}</span></div>
          </div>
        </div>
        <div class="cf-card" style="border-radius:1rem;padding:1.25rem">
          <h4 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.875rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-chart-bar" style="color:var(--color-primary)"></i>Setup Summary</h4>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
            <div v-for="stat in reviewStats" :key="stat.label" style="background:var(--cf-bg);border:1px solid var(--cf-border);border-radius:.625rem;padding:.75rem;text-align:center">
              <div style="font-size:1.5rem;font-weight:800;color:var(--color-primary);font-family:'Poppins',sans-serif">{{ stat.value }}</div>
              <div style="font-size:.72rem;color:var(--cf-text);margin-top:.2rem">{{ stat.label }}</div>
            </div>
          </div>
        </div>
        <div class="cf-card" style="border-radius:1rem;padding:1.25rem">
          <h4 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.875rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-file-signature" style="color:var(--color-primary)"></i>Consents Collected</h4>
          <div style="display:flex;flex-wrap:wrap;gap:.4rem">
            <span v-for="c in onboarding.buildClinicProfile().consents" :key="c.id" class="tag-chip"><i class="fas fa-check text-xs"></i><span>{{ c.title }}</span></span>
            <span v-show="onboarding.buildClinicProfile().consents.length === 0" style="font-size:.82rem;color:var(--cf-text)">No consents added</span>
          </div>
        </div>
        <div class="cf-card" style="border-radius:1rem;padding:1.25rem">
          <h4 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.875rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-stethoscope" style="color:var(--color-primary)"></i>Services</h4>
          <div style="display:flex;flex-wrap:wrap;gap:.4rem">
            <span v-for="s in onboarding.buildClinicProfile().services" :key="s.id" class="tag-chip"><span>{{ s.name }}</span></span>
            <span v-show="onboarding.buildClinicProfile().services.length === 0" style="font-size:.82rem;color:var(--cf-text)">No services added</span>
          </div>
        </div>
      </div>
      <div class="cf-card" style="border-radius:1rem;padding:1.25rem;margin-bottom:1.5rem">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.875rem">
          <h4 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);font-family:'Poppins',sans-serif"><i class="fas fa-code mr-2" style="color:var(--color-primary)"></i>FHIR QuestionnaireResponse Preview (Provider)</h4>
          <button class="btn-ghost" @click="copyFhir()" style="font-size:.75rem"><i class="fas fa-copy mr-1.5"></i>Copy JSON</button>
        </div>
        <pre style="font-family:'JetBrains Mono',monospace;font-size:.72rem;color:var(--color-primary);background:var(--cf-bg);border:1px solid var(--cf-border);border-radius:.5rem;padding:1rem;overflow-x:auto;max-height:220px;white-space:pre-wrap">{{ fhirPreview }}</pre>
      </div>
      <div style="background:var(--color-secondary);border-radius:1.25rem;padding:2rem;text-align:center">
        <h3 style="color:#fff;font-size:1.25rem;font-weight:700;font-family:'Poppins',sans-serif;margin-bottom:.5rem">Ready to go live?</h3>
        <p style="color:rgba(255,255,255,.7);font-size:.9rem;margin-bottom:1.5rem">Your clinic page will be available at clinixflow.ai/{{ onboarding.buildClinicProfile().slug || 'your-clinic' }}</p>
        <div style="display:flex;gap:.875rem;justify-content:center;flex-wrap:wrap">
          <button class="btn-teal" @click="publishClinic()" style="font-size:.95rem;padding:.875rem 2rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-rocket"></i>Publish Clinic Page</button>
          <RouterLink to="/designer" class="btn-outline" style="color:#fff;border-color:rgba(255,255,255,.3);font-size:.9rem;padding:.875rem 1.75rem;display:inline-flex;align-items:center;gap:.5rem"><i class="fas fa-cog"></i>Advanced Settings</RouterLink>
        </div>
      </div>
    </div>

    <!-- PUBLISHED -->
    <div v-show="screen === 'published'" class="screen-panel" style="text-align:center;padding:3rem 1rem">
      <div class="completion-ring"><i class="fas fa-check" style="color:var(--color-primary);font-size:2.5rem"></i></div>
      <h2 style="font-size:2rem;font-weight:800;color:var(--cf-text-strong);margin-bottom:.625rem">{{ (onboarding.publishedClinic.name || 'Your clinic') + ' is live!' }}</h2>
      <p style="color:var(--cf-text);font-size:1rem;margin-bottom:.5rem">Your clinic landing page is ready at:</p>
      <RouterLink :to="`/clinic-home?slug=${onboarding.publishedClinic.slug}`" style="font-size:1.1rem;font-weight:700;color:var(--color-primary);font-family:'JetBrains Mono',monospace">clinixflow.ai/{{ onboarding.publishedClinic.slug || 'your-clinic' }}</RouterLink>
      <div style="display:flex;gap:.875rem;justify-content:center;flex-wrap:wrap;margin-top:2rem">
        <RouterLink :to="`/clinic-home?slug=${onboarding.publishedClinic.slug}`" target="_blank" class="btn-teal" style="display:inline-flex;align-items:center;gap:.5rem;font-size:.95rem"><i class="fas fa-external-link-alt"></i>View Clinic Page</RouterLink>
        <RouterLink to="/designer" class="btn-primary" style="display:inline-flex;align-items:center;gap:.5rem;font-size:.95rem"><i class="fas fa-cog"></i>Manage Settings</RouterLink>
        <RouterLink to="/" class="btn-outline" style="display:inline-flex;align-items:center;gap:.5rem;font-size:.95rem"><i class="fas fa-home"></i>Back to ClinixFlow</RouterLink>
      </div>
    </div>

  </div>
  </main>
</template>
