<script setup>
// Ported from clinixflow's public/onboarding.html — the clinic setup hub (hub → review →
// published screens), each journey card backed by a real FHIR record via the same
// SystemForms/LhcFormHost drawer pattern Front Desk uses.
import { computed, ref } from 'vue';
import FacilityBasicsHost from '../components/control/FacilityBasicsHost.vue';
import FacilityHfrPanel from '../components/control/FacilityHfrPanel.vue';
import ProviderBasicsHost from '../components/control/ProviderBasicsHost.vue';
import ProviderHprPanel from '../components/control/ProviderHprPanel.vue';
import AffiliateOrganizationHost from '../components/control/AffiliateOrganizationHost.vue';
import ServicesHost from '../components/control/ServicesHost.vue';
import HoursHost from '../components/control/HoursHost.vue';
import ConsentsHost from '../components/control/ConsentsHost.vue';
import SessionImportModal from '../components/SessionImportModal.vue';
import AdaptiveSectionNav from '../components/AdaptiveSectionNav.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import {
  activeQuestionnaire, sliceRecordGroup, seedSystemForms,
  getGroupInstances, getAnswer, mergeGroupResponseItem, mergeGroupResponseItems,
  saveDataRecord, activeVersionNumber,
} from '../data/useSystemForms.js';
import { checkFacilityConformance } from '../data/control/facilityConformance.js';
import { checkProviderConformance } from '../data/control/providerConformance.js';
import { checkAffiliateOrganizationConformance } from '../data/control/affiliateOrganizationConformance.js';
import { API_BASE } from '../config.js';

// Cards whose drawer needs the FULL Provider record rather than a single-group slice — either
// because their own capture spans more than one real FHIR resource/group linkId
// (section_hospital/section_staff), or because their conformance panel needs the whole record for
// the auto-link reasoning facilityConformance.js/providerConformance.js already document
// (section_affiliate_organization). Services/Hours/Consents don't cross-reference anything and
// have no conformance panel, so they stay on the plain sliced-record contract below.
const HAND_AUTHORED_GROUP_LINK_IDS = new Set(['section_hospital', 'section_staff', 'section_affiliate_organization']);

const onboarding = useOnboardingStore();

const screen = ref(localStorage.getItem('cf_onboarding_screen') || 'hub'); // 'hub' | 'review' | 'published'
const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3200);
}

// UX rebuild (this pass) — the drawer is gone. AdaptiveSectionNav.vue (SPEC-24 §5) now lives
// directly on this page instead of nested one-per-card inside a narrow slide-out panel: it was
// eating roughly half the drawer's own width just for its own chrome, leaving the actual capture
// fields cramped into what was left — the exact complaint. `activeSectionId` (bound to the
// page-level nav's own v-model) replaces `activeForm`/`drawerOpen`; each entity's Host component,
// conformance panel, and HFR/HPR panel now render inline in that section's own named slot below,
// not inside a drawer body that only ever showed one card at a time anyway. Every Host's own
// INNER AdaptiveSectionNav (Person/ABDM Registration/Role, Basics/Address/Contact, etc.) is
// untouched — those are the real "sub-sections" this page's own outer nav didn't have a level for
// before; nesting two independent AdaptiveSectionNav instances (this page's own `onboarding-hub`
// storageKey, each Host's own separate one) is exactly what the component was already built to
// support, not a new capability.
const hprStaffIndex = ref(0); // which Care Team member the HPR Registration panel below targets
const customFormHost = ref(null); // whichever section's Host component is currently mounted — only one ever is, same guarantee the old v-else-if chain gave

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
  { groupLinkId: 'section_affiliate_organization', mode: 'repeatable', icon: 'fas fa-handshake', color: '#0EA5E9', bg: 'rgba(14,165,233,.1)', title: 'Affiliate Organizations', desc: 'Partner labs, imaging centres or billing services as FHIR OrganizationAffiliation records.' },
  // Open Designer used to be an 'action'-only entry here (no groupLinkId, routed away instead of
  // rendering content) — now a plain RouterLink in the hub's own intro button row below, since
  // navSections (further down) only ever wants real content sections, not nav actions.
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

// Real onboarding-UI rebuild — the page-level nav's active section renders ONLY that card's own
// group, sliced from the same real compiled Questionnaire (sliceRecordGroup, the same primitive
// Cübo's Hospital Setup checklist already proved out), not the whole accumulating Provider
// document every time. That "whole document visible at once" shape was itself part of what made
// this "getting difficult" (explicit instruction) — clicking Care Team used to open
// Hospital+Staff+Services+Hours+Consent all stacked together, scrolled to the top.
//
// SPEC-24 §7 step 7 (Tier B): every card is a hand-authored panel now (no more CustomFormHost
// fallback) — the `activeQuestionnaire()` call stays only as the "has this form been seeded at
// all yet" guard this computed still depends on.
//
// A computed (recomputes on onboarding.dataVersion, same reactive-dependency convention
// groupInstances()/fhirPreview below already use), not an imperative "open" call — a click just
// changes `activeSectionId` now (the page-level AdaptiveSectionNav's own v-model), and whichever
// record that section needs follows automatically. getProviderRecord()/buildSeedFromRegistration()
// are both pure reads (see onboarding.js's own header on buildSeedFromRegistration — "never
// persisted itself"), safe to call from here.
const activeSectionId = ref('section_hospital');
function cardById(groupLinkId) { return journeyCards.value.find((c) => c.groupLinkId === groupLinkId) || null; }
const activeCard = computed(() => cardById(activeSectionId.value));
const activeRecord = computed(() => {
  onboarding.dataVersion; // register the reactive dependency
  if (!activeCard.value) return null;
  const q = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  if (!q) return null;
  const fullRecord = onboarding.getProviderRecord() || onboarding.buildSeedFromRegistration();
  if (!fullRecord) return null;
  return HAND_AUTHORED_GROUP_LINK_IDS.has(activeCard.value.groupLinkId) ? fullRecord : sliceRecordGroup(fullRecord, activeCard.value.groupLinkId);
});

// The page-level AdaptiveSectionNav's own `sections` — one per real entity card (excludes the
// 'designer' action card, which isn't a section of content to render inline; it's a plain nav
// link now, alongside Continue to Review below). `badge`/`badgeTone` reproduce the old card
// grid's own "N added"/"Not started" status chips (cardStatus() below, unchanged) directly in the
// nav itself — AdaptiveSectionNav.vue's own optional per-section badge, additive to every other
// caller of that shared component.
const navSections = computed(() => journeyCards.value
  .filter((c) => c.groupLinkId)
  .map((c) => ({
    id: c.groupLinkId, label: c.title, icon: c.icon,
    badge: cardStatus(c), badgeTone: cardStatus(c) === 'Not started' ? 'muted' : 'teal',
  })));

// SPEC-24 §7 step 5 — the real chain, live: extract -> validate against ClinuxFlowFacility ->
// next-best-action, over the WHOLE Provider record (not just this section's own section_hospital
// slice — see facilityConformance.js's own header on why). Deliberately on-demand (a button, not
// auto-run on save) rather than baked into saveActiveSection()'s own save flow for 'single' mode
// cards — checking "is the whole FHIR Facility profile satisfied yet" is a distinct question from
// "did this one save succeed", and most clinics (free tier, no ABDM registration — SPEC-05) will
// never see this go green, which is expected, not an error state to force past.
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

// SPEC-24 §7 step 6 — the same real chain for Provider, over the WHOLE record (a PractitionerRole's
// .organization only auto-links when a real Organization is in the same extraction — see
// providerConformance.js's own header).
const providerConformanceLoading = ref(false);
const providerConformanceResult = ref(null); // { providers, nextActions } | { error } | null
async function checkProviderConformanceNow() {
  providerConformanceLoading.value = true;
  const questionnaireJson = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  const responseJson = onboarding.getProviderRecord()?.data;
  providerConformanceResult.value = (questionnaireJson && responseJson)
    ? await checkProviderConformance(questionnaireJson, responseJson)
    : { error: 'Save at least one staff member first.' };
  providerConformanceLoading.value = false;
}

// SPEC-24 §7 step 6 (Affiliate Organization) — same real chain, over the WHOLE record (an
// OrganizationAffiliation's .organization only auto-links when a real Organization is in the same
// extraction — see affiliateOrganizationConformance.js's own header).
const affiliateOrgConformanceLoading = ref(false);
const affiliateOrgConformanceResult = ref(null); // { affiliations, nextActions } | { error } | null
async function checkAffiliateOrgConformanceNow() {
  affiliateOrgConformanceLoading.value = true;
  const questionnaireJson = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  const responseJson = onboarding.getProviderRecord()?.data;
  affiliateOrgConformanceResult.value = (questionnaireJson && responseJson)
    ? await checkAffiliateOrganizationConformance(questionnaireJson, responseJson)
    : { error: 'Save at least one affiliate organization first.' };
  affiliateOrgConformanceLoading.value = false;
}

// Real onboarding-UI rebuild — merges just this one group back into the Provider record
// (mergeGroupResponseItem/mergeGroupResponseItems, the same surgical per-group primitives Cübo's
// Hospital Setup checklist already uses) instead of extracting and overwriting the WHOLE
// document. CustomFormHost's own extract() already blocks and inline-flags missing required
// fields, returning null — mirrors LhcFormHost/extractResponse()'s existing failure contract, so
// this only needs to check for that, not re-validate anything itself.
//
// UPDATE — no more drawer to close/stay-open. A 'single' card (Hospital) and a 'repeatable' one
// (Care Team etc.) both just save in place now; `activeRecord` above is a computed keyed off
// onboarding.dataVersion, so it re-slices itself automatically the instant saveDataRecord() below
// bumps that counter — the old repeatable-mode branch's own manual "re-read the saved record"
// step is gone because the computed already does that reactively, not because anything about
// staying open to add more entries changed.
function saveActiveSection() {
  if (!activeCard.value || !customFormHost.value) return;
  const response = customFormHost.value.extract();
  if (!response) { showToast('Please fill in the required fields.'); return; }

  const groupLinkId = activeCard.value.groupLinkId;
  const recordId = onboarding.ensureProviderRecord();
  const record = onboarding.getProviderRecord();
  let mergedData = record?.data || { item: [] };
  if (activeCard.value.mode === 'repeatable') {
    // SPEC-24 §7 step 6: a repeatable card can now span MORE than one real group linkId (Care
    // Team: section_staff + section_staff_role, ProviderBasicsHost.vue's own Practitioner/
    // PractitionerRole split) — group the extracted items by their own linkId and merge each as
    // its own full-replacement set. Every existing single-linkId repeatable card (Services/Hours/
    // Consents) still produces exactly one group here, so this is a strict generalization, not a
    // behavior change for them.
    const byLinkId = new Map();
    (response.item || []).forEach((item) => {
      if (!byLinkId.has(item.linkId)) byLinkId.set(item.linkId, []);
      byLinkId.get(item.linkId).push(item);
    });
    byLinkId.forEach((items, linkId) => { mergedData = mergeGroupResponseItems(mergedData, linkId, items); });
  } else {
    mergedData = mergeGroupResponseItem(mergedData, response.item[0] || { linkId: groupLinkId, item: [] });
  }
  saveDataRecord(onboarding.PROVIDER_FORM_ID, activeVersionNumber(onboarding.PROVIDER_FORM_ID), mergedData, recordId);
  onboarding.dataVersion++;
  showToast(activeCard.value.mode === 'repeatable' ? 'Added.' : 'Saved.');
}

function goToReview() {
  if (!getAnswer(onboarding.getProviderRecord(), 'hospital_name')) {
    showToast('Please complete your Hospital Profile first.');
    activeSectionId.value = 'section_hospital';
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

  <main style="flex:1;overflow-y:auto">
  <div style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem 4rem">

    <!-- HUB -->
    <div v-show="screen === 'hub'" class="screen-panel">
      <div style="margin-bottom:2rem">
        <span class="section-eyebrow" style="display:block;margin-bottom:.75rem">{{ onboarding.registeredUser ? 'Welcome back' : 'Welcome to ClinixFlow' }}</span>
        <div class="teal-line" style="margin-bottom:1.25rem"></div>
        <h1 v-if="!onboarding.registeredUser" style="font-size:2.25rem;font-weight:800;color:var(--cf-text-strong);line-height:1.15;letter-spacing:-1px;margin-bottom:.875rem">
          Set up your clinic's<br><span style="color:var(--color-primary)">digital presence</span><br>in minutes.
        </h1>
        <h1 v-else style="font-size:2.25rem;font-weight:800;color:var(--cf-text-strong);line-height:1.15;letter-spacing:-1px;margin-bottom:.875rem">
          {{ onboarding.registeredUser?.adminName }}, let's finish setting up<br><span style="color:var(--color-primary)">{{ onboarding.registeredUser?.clinicName }}</span>.
        </h1>
        <p style="font-size:.95rem;color:var(--cf-text);line-height:1.7;margin-bottom:1.5rem;max-width:52rem">
          Pick a section below to add that piece of your clinic's profile — each saves as a real FHIR record. Add as much or as little as you like, then review and publish when ready.
        </p>
        <div style="display:flex;gap:.75rem;flex-wrap:wrap">
          <button class="btn-teal" @click="goToReview()" style="display:flex;align-items:center;gap:.5rem"><i class="fas fa-arrow-right"></i>Continue to Review</button>
          <RouterLink to="/clinic-home" target="_blank" class="btn-outline" style="display:flex;align-items:center;gap:.5rem"><i class="fas fa-eye"></i>See Sample Page</RouterLink>
          <!-- Was its own card in the old grid ('Open Designer', an action entry with no
               groupLinkId) — now a plain nav link alongside Review, not a section: it navigates
               away rather than rendering content inline, so it never belonged in navSections
               below (see navSections' own header comment). -->
          <RouterLink to="/designer" class="btn-outline" style="display:flex;align-items:center;gap:.5rem"><i class="fas fa-layer-group"></i>Open Designer</RouterLink>
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

      <!-- The page-level nav — sidebar mode: this hub is the one page in the app with genuinely
           "many sections and sub-sections" (explicit description), so a persistent left-hand list
           of all 6 entities reads better here than tabs eating a full row above the content, and
           gives every section's own content the full page width to breathe instead of a drawer's
           ~420px. Users can still switch to tabs/accordion via the nav's own "⋮ Display" menu
           (AdaptiveSectionNav.vue's existing, unchanged capability) if they prefer. -->
      <AdaptiveSectionNav :sections="navSections" mode="sidebar" storage-key="onboarding-hub" v-model:active-id="activeSectionId">
        <template #section_hospital>
          <div class="cf-card rounded-2xl p-4">
            <FacilityBasicsHost ref="customFormHost" :record="activeRecord" />
            <div class="flex justify-end mt-3">
              <button class="btn-teal" @click="saveActiveSection()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-save"></i><span>Save</span></button>
            </div>
          </div>

          <!-- SPEC-24 §7 step 5/6: the real conformance chain, on demand — see checkConformance()'s
               own comment on why this isn't auto-run on save. Facility/Provider only; Affiliate/
               Patient get the same treatment once THEY have a real Profile-anchored capture UI. -->
          <div class="cf-card rounded-2xl p-4 mt-3">
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

          <FacilityHfrPanel :record="activeRecord" @submitted="onboarding.dataVersion++" />
        </template>

        <template #section_staff>
          <div class="cf-card rounded-2xl p-4">
            <ProviderBasicsHost ref="customFormHost" :record="activeRecord" />
            <div class="flex justify-end mt-3">
              <button class="btn-teal" @click="saveActiveSection()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i><span>Add</span></button>
            </div>
          </div>

          <div class="cf-card rounded-2xl p-4 mt-3">
            <div class="flex items-center justify-between mb-2">
              <p class="cf-label mb-0">FHIR Provider Conformance <span style="font-weight:400">(ClinuxFlowProvider / ClinuxFlowProviderRole)</span></p>
              <button class="btn-ghost text-xs px-2 py-1" :disabled="providerConformanceLoading" @click="checkProviderConformanceNow()">
                <i class="fas" :class="providerConformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
              </button>
            </div>
            <p v-if="!providerConformanceResult" class="text-xs" style="color:var(--cf-text)">
              Checks each saved staff member's Practitioner and PractitionerRole records against the real HPR-grounded schema.
            </p>
            <p v-else-if="providerConformanceResult.error" class="text-xs" style="color:#b91c1c">{{ providerConformanceResult.error }}</p>
            <template v-else-if="providerConformanceResult.providers.length === 0">
              <p class="text-xs" style="color:var(--cf-text)">No staff saved yet.</p>
            </template>
            <div v-else class="flex flex-col gap-2" style="max-height:220px;overflow-y:auto">
              <div v-for="p in providerConformanceResult.providers" :key="p.practitioner.id" class="record-card p-2">
                <p class="text-xs font-semibold mb-1" :style="(p.practitionerValid && p.roleValid) ? 'color:var(--color-primary)' : 'color:var(--cf-text-strong)'">
                  <i class="fas" :class="(p.practitionerValid && p.roleValid) ? 'fa-circle-check' : 'fa-circle-info'"></i>
                  {{ p.practitioner.name?.given?.join(' ') || '(unnamed)' }} {{ p.practitioner.name?.family || '' }}
                </p>
                <ul style="font-size:.7rem;color:var(--cf-text);padding-left:1rem">
                  <li v-for="e in p.practitionerErrors" :key="'p-' + e.path">{{ e.message }}</li>
                  <li v-for="e in p.roleErrors" :key="'r-' + e.path">{{ e.message }}</li>
                </ul>
              </div>
            </div>
          </div>

          <div v-if="groupInstances('section_staff').length > 0" class="cf-card rounded-2xl p-4 mt-3">
            <p class="cf-label mb-2">ABDM Provider Registration (HPR)</p>
            <select class="cf-input mb-2" v-model.number="hprStaffIndex">
              <option v-for="(inst, i) in groupInstances('section_staff')" :key="i" :value="i">{{ [getAnswer({ data: inst }, 'staff_first_name'), getAnswer({ data: inst }, 'staff_last_name')].filter(Boolean).join(' ') || `Staff #${i + 1}` }}</option>
            </select>
            <ProviderHprPanel v-if="hprStaffIndex !== null" :record="onboarding.getProviderRecord()" :staff-index="hprStaffIndex" @registered="onboarding.dataVersion++" />
          </div>
        </template>

        <template #section_services_matrix>
          <div class="cf-card rounded-2xl p-4">
            <ServicesHost ref="customFormHost" :record="activeRecord" />
            <div class="flex justify-end mt-3">
              <button class="btn-teal" @click="saveActiveSection()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i><span>Add</span></button>
            </div>
          </div>
        </template>

        <template #section_hours>
          <div class="cf-card rounded-2xl p-4">
            <HoursHost ref="customFormHost" :record="activeRecord" />
            <div class="flex justify-end mt-3">
              <button class="btn-teal" @click="saveActiveSection()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i><span>Add</span></button>
            </div>
          </div>
        </template>

        <template #section_consent>
          <div class="cf-card rounded-2xl p-4">
            <ConsentsHost ref="customFormHost" :record="activeRecord" />
            <div class="flex justify-end mt-3">
              <button class="btn-teal" @click="saveActiveSection()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i><span>Add</span></button>
            </div>
          </div>
        </template>

        <template #section_affiliate_organization>
          <div class="cf-card rounded-2xl p-4">
            <AffiliateOrganizationHost ref="customFormHost" :record="activeRecord" />
            <div class="flex justify-end mt-3">
              <button class="btn-teal" @click="saveActiveSection()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i><span>Add</span></button>
            </div>
          </div>

          <div class="cf-card rounded-2xl p-4 mt-3">
            <div class="flex items-center justify-between mb-2">
              <p class="cf-label mb-0">FHIR Affiliate Organization Conformance <span style="font-weight:400">(ClinuxFlowAffiliateOrganization)</span></p>
              <button class="btn-ghost text-xs px-2 py-1" :disabled="affiliateOrgConformanceLoading" @click="checkAffiliateOrgConformanceNow()">
                <i class="fas" :class="affiliateOrgConformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
              </button>
            </div>
            <p v-if="!affiliateOrgConformanceResult" class="text-xs" style="color:var(--cf-text)">
              Checks each saved affiliate organization against the real ClinuxFlowAffiliateOrganization schema.
            </p>
            <p v-else-if="affiliateOrgConformanceResult.error" class="text-xs" style="color:#b91c1c">{{ affiliateOrgConformanceResult.error }}</p>
            <template v-else-if="affiliateOrgConformanceResult.affiliations.length === 0">
              <p class="text-xs" style="color:var(--cf-text)">No affiliate organizations saved yet.</p>
            </template>
            <div v-else class="flex flex-col gap-2" style="max-height:220px;overflow-y:auto">
              <div v-for="a in affiliateOrgConformanceResult.affiliations" :key="a.organizationAffiliation.id" class="record-card p-2">
                <p class="text-xs font-semibold mb-1" :style="a.valid ? 'color:var(--color-primary)' : 'color:var(--cf-text-strong)'">
                  <i class="fas" :class="a.valid ? 'fa-circle-check' : 'fa-circle-info'"></i>
                  {{ a.organizationAffiliation.participatingOrganization || '(unnamed)' }}
                </p>
                <ul style="font-size:.7rem;color:var(--cf-text);padding-left:1rem">
                  <li v-for="e in a.errors" :key="e.path">{{ e.message }}</li>
                </ul>
              </div>
            </div>
          </div>
        </template>
      </AdaptiveSectionNav>
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
            <div style="display:flex;justify-content:space-between;font-size:.82rem;align-items:center">
              <span style="color:var(--cf-text)">Setup stage</span>
              <span class="tag-chip" :style="onboarding.canAcceptJoinToken ? 'color:#10B981' : ''" :title="onboarding.facilitySetupStageLabel">
                <i class="fas" :class="onboarding.canAcceptJoinToken ? 'fa-circle-check' : 'fa-circle-half-stroke'"></i>
                <span>{{ onboarding.facilitySetupStageLabel }}</span>
              </span>
            </div>
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
