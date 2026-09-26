<script setup>
// Ported from clinixflow's public/onboarding.html — the clinic setup hub (hub → review →
// published screens), each journey card backed by a real FHIR record via the same
// SystemForms/LhcFormHost drawer pattern Front Desk uses.
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import FacilityBasicsHost from '../components/control/FacilityBasicsHost.vue';
import FacilityHfrPanel from '../components/control/FacilityHfrPanel.vue';
import FacilityStatusCard from '../components/FacilityStatusCard.vue';
import ProviderBasicsHost from '../components/control/ProviderBasicsHost.vue';
import ProviderHprPanel from '../components/control/ProviderHprPanel.vue';
import AffiliateOrganizationHost from '../components/control/AffiliateOrganizationHost.vue';
import JoinTokenRedeemForm from '../components/auth/JoinTokenRedeemForm.vue';
import JoinLinkPanel from '../components/control/JoinLinkPanel.vue';
import ServicesHost from '../components/control/ServicesHost.vue';
import LocationsHost from '../components/control/LocationsHost.vue';
import HoursHost from '../components/control/HoursHost.vue';
import ConsentsHost from '../components/control/ConsentsHost.vue';
import SessionImportModal from '../components/SessionImportModal.vue';
import AdaptiveSectionNav from '../components/AdaptiveSectionNav.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import {
  activeQuestionnaire, sliceRecordGroup, seedSystemForms,
  getGroupInstances, getAnswer, mergeGroupResponseItem, mergeGroupResponseItems,
  saveDataRecord, activeVersionNumber,
} from '../data/useSystemForms.js';
import { checkFacilityConformance } from '../data/control/facilityConformance.js';
import { checkProviderConformance } from '../data/control/providerConformance.js';
import { checkAffiliateOrganizationConformance } from '../data/control/affiliateOrganizationConformance.js';
import { checkAffiliatePractitionerConformance } from '../data/control/affiliatePractitionerConformance.js';
import { API_BASE } from '../config.js';

// Cards whose drawer needs the FULL Provider record rather than a single-group slice — either
// because their own capture spans more than one real FHIR resource/group linkId
// (section_hospital/section_staff), or because their conformance panel needs the whole record for
// the auto-link reasoning facilityConformance.js/providerConformance.js already document
// (section_affiliate_organization). Services/Hours/Consents don't cross-reference anything and
// have no conformance panel, so they stay on the plain sliced-record contract below.
//
// Real bug found live while rebuilding FacilityHfrPanel.vue's UX: section_abdm_hfr was missing
// from this set. sliceRecordGroup(fullRecord, 'section_abdm_hfr') filters the record's top-level
// items for linkId === 'section_abdm_hfr' — but no real composition block is EVER named that; the
// actual ABDM blocks are section_hospital_abdm_facility_type/_location/_registration/
// _public_display, and hospital_name itself lives in section_hospital. So the filter always
// returned an empty array, meaning FacilityHfrPanel.vue's rebuildFromRecord() has been reading an
// always-empty sliced record ever since SPEC-24's AdaptiveSectionNav migration — every getAnswer()
// call inside it silently returned '', so a saved trackingId/facilityId/any HFR field never
// actually restored on remount, even though patchRecordField()'s own writes (keyed by record.id,
// not this prop) genuinely persisted correctly the whole time. Same multi-group-block reasoning as
// section_hospital/section_staff above — this card's own capture spans 4 real blocks, not 1.
const HAND_AUTHORED_GROUP_LINK_IDS = new Set(['section_hospital', 'section_staff', 'section_affiliate_organization', 'section_abdm_hfr']);

const onboarding = useOnboardingStore();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// Real gap found live: this page used to require Continue to Review -> Publish Clinic Page
// before ClinicHome would show real data at all — a forced second step on top of a save that
// already persisted everything, and confusing now that onboarding.publishIfReady() (see its own
// header comment in the store) already takes a facility live the moment it has a name. Data View
// (this page) and Page View (ClinicHome) are now just two ends of the same editing loop: ClinicHome's
// own edit icons navigate here (see routeToSection below), and "Back to Clinic Home" below is how
// you close this view and land back on Page View — no separate review/publish gate in between.
function backToClinicHome() {
  router.push('/clinic-home');
}

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
    desc: isIndividual.value ? 'Your name, contact details and where you practice.' : 'Your clinic\'s name, address and contact details.',
  },
  // Branches, ahead of Care Team/Services below — a real gap found while wiring ClinicHome's
  // own Locations section: service_location_id/staff_location_ids (both added this pass) had
  // nothing to reference, since no card here ever created a section_location instance at all.
  { groupLinkId: 'section_location', mode: 'repeatable', icon: 'fas fa-map-marker-alt', color: '#14B8A6', bg: 'rgba(20,184,166,.1)', title: 'Branches', desc: 'Add your clinic\'s branch locations, one at a time.' },
  {
    groupLinkId: 'section_staff', mode: 'repeatable', icon: 'fas fa-user-md', color: '#00D4B2', bg: 'rgba(0,212,178,.1)',
    title: isIndividual.value ? 'Assistants (optional)' : 'Care Team',
    desc: isIndividual.value ? 'Add any assistants or support staff, if you have them.' : 'Add your doctors, nurses and other staff.',
  },
  { groupLinkId: 'section_services_matrix', mode: 'repeatable', icon: 'fas fa-stethoscope', color: '#8B5CF6', bg: 'rgba(139,92,246,.1)', title: 'Services', desc: "List the services your clinic offers." },
  { groupLinkId: 'section_hours', mode: 'repeatable', icon: 'fas fa-clock', color: '#F59E0B', bg: 'rgba(245,158,11,.1)', title: 'Office Hours', desc: 'Add operating hours, one day-range at a time.' },
  { groupLinkId: 'section_consent', mode: 'repeatable', icon: 'fas fa-file-signature', color: '#EF4444', bg: 'rgba(239,68,68,.1)', title: 'Legal Consents', desc: 'Add the consent types your clinic collects from patients.' },
  // Renamed from "Affiliate Organizations" (explicit instruction). This is ONLY the free-text
  // half (section_affiliate_organization's own FHIR-shaped QuestionnaireResponse group) — real,
  // resolvable D1 links to another ClinuxFlow-registered facility (migrations/0015), Affiliate
  // Practitioners, and Team Accounts all moved to the "External Associations" section BELOW this
  // nav instead (architecture guideline, explicit instruction): information contained in the
  // Graph Definition renders as a nav section here; externally-linked information (an
  // account/clinic cross-reference, not part of this Organization's own FHIR resource) renders as
  // a dedicated section below, so it never competes with the graph-defined sections for the same
  // accordion/sidebar/tabs switching control.
  { groupLinkId: 'section_affiliate_organization', mode: 'repeatable', icon: 'fas fa-handshake', color: '#0EA5E9', bg: 'rgba(14,165,233,.1)', title: 'Affiliate Partners', desc: 'Partner labs, imaging centres or other facilities you work with (free-text only — see External Associations below for real links).' },
  // A real, separate government registration process (India's ABDM Health Facility Registry),
  // not app-internal data capture — split out of Hospital Profile into its own card (explicit
  // instruction). mode: 'abdm' — see cardStatus()'s own handling for why it doesn't count
  // group instances like the repeatable cards above.
  { groupLinkId: 'section_abdm_hfr', mode: 'abdm', icon: 'fas fa-landmark', color: '#DC2626', bg: 'rgba(220,38,38,.1)', title: 'ABDM Registration (HFR)', desc: 'Optional — register your facility with India\'s national health registry.' },
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

// Real Organization-to-Organization linking (migrations/0015) — alongside, not replacing,
// AffiliateOrganizationHost's free-text section_affiliate_organization fields above: a partner
// with no real ClinuxFlow account (most real-world labs/imaging centres today) still only has the
// free-text path available, same "may or may not be registered" reasoning that applies to ABDM
// registration for staff/affiliates too. This is for when the partner DOES have their own real
// ClinuxFlow account and issued a join link for it — same JoinTokenRedeemForm.vue every other
// relationship kind already uses, just embedded here instead of a practitioner's Data View.
function onOrgJoinSuccess() {
  showToast('Join request sent — you\'ll be notified once the partner facility decides.');
}

// Retired TeamSettingsModal.vue's own D1 reads/writes — moved here so Staff (Care Team, below),
// Affiliate Practitioners, and Affiliate Partners are managed in Data View/Page View like every
// other Organisation entity, not a separate popup. Eager-loaded once at mount (not gated on
// which section is active) since Care Team's own status badge and this page's other cards may
// render before their own section is ever opened.
const staffAccounts = ref([]);
async function loadStaffAccounts() {
  const { accounts: list } = await auth.fetchTeam();
  staffAccounts.value = list || [];
}
loadStaffAccounts();

const practitionerAffiliates = ref([]);
async function loadPractitionerAffiliates() {
  const { affiliates: list } = await auth.fetchAffiliates();
  practitionerAffiliates.value = list || [];
}
loadPractitionerAffiliates();
async function removePractitionerAffiliate(accountId) {
  await auth.revokeAffiliate(accountId);
  await loadPractitionerAffiliates();
}

const orgAffiliates = ref([]);
async function loadOrgAffiliates() {
  const { affiliates: list } = await auth.fetchOrganizationAffiliates();
  orgAffiliates.value = list || [];
}
loadOrgAffiliates();
async function removeOrgAffiliateLink(clinicId) {
  await auth.revokeOrganizationAffiliate(clinicId);
  await loadOrgAffiliates();
}

// SPEC-24 §7 step 6 — moved from TeamSettingsModal.vue, same ClinuxFlowAffiliatePractitionerRole
// conformance check, now living alongside the D1 list it describes.
const practitionerAffiliateConformanceLoading = ref(false);
const practitionerAffiliateConformanceResult = ref(null);
async function checkPractitionerAffiliateConformance() {
  practitionerAffiliateConformanceLoading.value = true;
  practitionerAffiliateConformanceResult.value = await checkAffiliatePractitionerConformance();
  practitionerAffiliateConformanceLoading.value = false;
}

function groupInstances(groupLinkId) {
  onboarding.dataVersion; // register the reactive dependency
  return getGroupInstances(onboarding.getProviderRecord(), groupLinkId);
}

function cardStatus(card) {
  if (card.mode === 'single') return getAnswer(onboarding.getProviderRecord(), 'hospital_name') ? 'Saved' : 'Not started';
  // ABDM registration isn't a captured QuestionnaireResponse group (FacilityHfrPanel.vue talks
  // to the real gateway directly) — hospital_tracking_id is the real signal that at least the
  // first stage (Basic Information) has gone through, patched onto the record by that panel's
  // own doBasicInfo().
  if (card.mode === 'abdm') return getAnswer(onboarding.getProviderRecord(), 'hospital_tracking_id') ? 'Started' : 'Not started';
  // D1 data, not a QuestionnaireResponse group — practitionerAffiliates is its own reactive ref
  // (loadPractitionerAffiliates above), not groupInstances().
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
// groupInstances() below already uses), not an imperative "open" call — a click just
// changes `activeSectionId` now (the page-level AdaptiveSectionNav's own v-model), and whichever
// record that section needs follows automatically. getProviderRecord()/buildSeedFromRegistration()
// are both pure reads (see onboarding.js's own header on buildSeedFromRegistration — "never
// persisted itself"), safe to call from here.
// ?section=<groupLinkId> is how ClinicHome.vue's own edit icons deep-link in (e.g. Edit Services
// -> /onboarding?section=section_services_matrix) — read once on entry, same "just changes
// activeSectionId" mechanism the NBA jump-to-section links above already use, not a second
// navigation system.
const activeSectionId = ref(
  (typeof route.query.section === 'string' && route.query.section) || 'section_hospital'
);
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

// Structural nav vs. Next Best Action: AdaptiveSectionNav's sidebar (navSections above) is
// always-available wayfinding — every section, reachable any time, regardless of progress. The
// items below are the other, narrower thing: a Next Best Action, computed from
// ClinuxFlowOnboardingGraph.json's own reference topology (next-best-action.js, server-side),
// specifically recommending what advances this onboarding graph toward completion. Making each
// one clickable (not just descriptive text, as before) is the concrete difference between the
// two — this jumps you TO the recommended section, same activeSectionId the sidebar itself
// drives, it just picks the destination for you instead of leaving it to browsing. Scoped to
// exactly the 4 links ClinuxFlowOnboardingGraph.json authors (same deliberate scoping
// next-best-action.js's own header already documents for itself, not a general
// GraphDefinition-link-to-section resolver).
const NEXT_ACTION_SECTION = {
  'role-at-facility': 'section_staff',
  'affiliation-from-facility': 'section_affiliate_organization',
  'practitioner-behind-role': 'section_staff',
  'affiliate-partner-org': 'section_affiliate_organization',
};
function goToNextAction(linkId) {
  const section = NEXT_ACTION_SECTION[linkId];
  if (section) activeSectionId.value = section;
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
  // Real gap found live: ClinicHome.vue's own empty state already promises "goes live
  // automatically as soon as your facility details are saved" — this is what actually keeps
  // that promise for a save made here, not just for the Review screen's own explicit Publish
  // button (see publishIfReady()'s own header comment on why the fix lives in the store, not
  // duplicated per call site).
  onboarding.publishIfReady();
  showToast(activeCard.value.mode === 'repeatable' ? 'Added.' : 'Saved.');
}

// Real gap found while removing the Review screen this stayed part of: not "does the current
// section make one blank" (saveActiveSection's own required-field check already handles that)
// but "was a Hospital Name ever actually saved at all" — the one real prerequisite for
// publishIfReady() to have anything to go live with. Kept as its own guard on the way back to
// Clinic Home specifically, not folded into every section save, since it's a one-time "you're not
// done yet" nudge, not a per-save validation.
function goToClinicHome() {
  if (!getAnswer(onboarding.getProviderRecord(), 'hospital_name')) {
    showToast('Please complete your Hospital Profile first.');
    activeSectionId.value = 'section_hospital';
    return;
  }
  backToClinicHome();
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i><span>{{ toast.msg }}</span></div>

  <SessionImportModal :open="importProfileModalOpen" @close="importProfileModalOpen = false" @profile-imported="onProfileImported" />

  <main style="flex:1;overflow-y:auto">
  <div style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem 4rem">

    <!-- HUB -->
    <div class="screen-panel">
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
          Pick a section below to add that piece of your clinic's profile — each one saves and goes live on your Clinic Home page immediately, no separate publish step.
        </p>
        <div style="display:flex;gap:.75rem;flex-wrap:wrap">
          <button class="btn-teal" @click="goToClinicHome()" style="display:flex;align-items:center;gap:.5rem"><i class="fas fa-arrow-right"></i>Back to Clinic Home</button>
          <!-- Was its own card in the old grid ('Open Designer', an action entry with no
               groupLinkId) — now a plain nav link alongside Back to Clinic Home, not a section:
               it navigates away rather than rendering content inline, so it never belonged in
               navSections below (see navSections' own header comment). -->
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
      <FacilityStatusCard
        v-if="activeSectionId === 'section_hospital' || activeSectionId === 'section_abdm_hfr'"
        :stage="onboarding.facilitySetupStage"
        @continue-hfr="activeSectionId = 'section_abdm_hfr'"
      />
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
              <p class="cf-label mb-0">Profile Completeness Check</p>
              <button class="btn-ghost text-xs px-2 py-1" :disabled="conformanceLoading" @click="checkConformance()">
                <i class="fas" :class="conformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
              </button>
            </div>
            <p v-if="!conformanceResult" class="text-xs" style="color:var(--cf-text)">
              Checks how complete your clinic profile is, including ABDM Registration. Most clinics won't see this fully green unless they've completed ABDM registration too — that's expected, and not required to publish your page.
            </p>
            <p v-else-if="conformanceResult.error" class="text-xs" style="color:#b91c1c">{{ conformanceResult.error }}</p>
            <template v-else>
              <p class="text-xs font-semibold mb-2" :style="conformanceResult.valid ? 'color:var(--color-primary)' : 'color:var(--cf-text)'">
                <i class="fas" :class="conformanceResult.valid ? 'fa-circle-check' : 'fa-circle-info'"></i>
                {{ conformanceResult.valid ? 'Everything looks complete.' : `${conformanceResult.errors.length} field(s) still needed.` }}
              </p>
              <ul v-if="!conformanceResult.valid" style="font-size:.72rem;color:var(--cf-text);padding-left:1rem;max-height:140px;overflow-y:auto">
                <li v-for="e in conformanceResult.errors" :key="e.path">{{ e.message }}</li>
              </ul>
              <div v-if="conformanceResult.valid && conformanceResult.nextActions?.length" class="mt-2">
                <p class="text-xs font-semibold" style="color:var(--cf-text-strong)">
                  <i class="fas fa-diamond-turn-right" style="color:var(--color-primary)"></i> Suggested next step
                </p>
                <div class="flex flex-col gap-1 mt-1">
                  <button
                    v-for="a in conformanceResult.nextActions"
                    :key="`${a.linkId}:${a.sourceResourceId}`"
                    class="btn-ghost text-xs px-2 py-1.5 text-left flex items-center justify-between gap-2"
                    style="border:1px solid var(--cf-border);border-radius:.5rem"
                    @click="goToNextAction(a.linkId)"
                  >
                    <span>{{ a.reason }}</span>
                    <i class="fas fa-arrow-right" style="color:var(--color-primary)"></i>
                  </button>
                </div>
              </div>
            </template>
          </div>
        </template>

        <template #section_abdm_hfr>
          <div class="cf-card rounded-2xl p-4 mb-3">
            <p class="text-sm" style="color:var(--cf-text)">
              This registers your facility with <strong>ABDM</strong>, India's national health registry — a real
              government process, separate from your clinic profile above, and optional. The steps below are real
              submissions to the registry, not drafts — each one unlocks the next once it succeeds.
            </p>
          </div>
          <FacilityHfrPanel :record="activeRecord" @submitted="onboarding.dataVersion++" />
        </template>

        <template #section_location>
          <div class="cf-card rounded-2xl p-4">
            <LocationsHost ref="customFormHost" :record="activeRecord" />
            <div class="flex justify-end mt-3">
              <button class="btn-teal" @click="saveActiveSection()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i><span>Add</span></button>
            </div>
          </div>
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
              <p class="cf-label mb-0">Staff Completeness Check</p>
              <button class="btn-ghost text-xs px-2 py-1" :disabled="providerConformanceLoading" @click="checkProviderConformanceNow()">
                <i class="fas" :class="providerConformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
              </button>
            </div>
            <p v-if="!providerConformanceResult" class="text-xs" style="color:var(--cf-text)">
              Checks whether each saved staff member's details are complete enough for HPR registration.
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
          <p class="text-xs text-center my-2" style="color:var(--cf-text)">
            Free-text entries only — for a real, resolvable link to another ClinuxFlow facility, see
            <strong>External Associations</strong> below.
          </p>

          <div class="cf-card rounded-2xl p-4 mt-3">
            <div class="flex items-center justify-between mb-2">
              <p class="cf-label mb-0">Affiliate Completeness Check</p>
              <button class="btn-ghost text-xs px-2 py-1" :disabled="affiliateOrgConformanceLoading" @click="checkAffiliateOrgConformanceNow()">
                <i class="fas" :class="affiliateOrgConformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
              </button>
            </div>
            <p v-if="!affiliateOrgConformanceResult" class="text-xs" style="color:var(--cf-text)">
              Checks whether each saved affiliate organization's details are complete.
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

    <!-- External Associations (explicit instruction) — everything cross-referencing another real
         account/clinic (D1 identity data, migrations/0005 + 0015), kept OUT of the graph-driven
         nav above so it never competes with the graph-defined sections for the same
         accordion/sidebar/tabs switching control. Moved here from the now-retired
         TeamSettingsModal.vue: Staff accounts, Affiliate Practitioners, and Affiliate Partners'
         real (non-free-text) links all managed through the same consistent join-token
         issue/redeem/decide pipeline (JoinLinkPanel), one dedicated section per relationship. -->
    <div class="screen-panel mt-6">
      <span class="section-eyebrow" style="display:block;margin-bottom:.75rem">Linked Elsewhere</span>
      <h2 style="font-size:1.5rem;font-weight:800;color:var(--cf-text-strong);margin-bottom:1.5rem">External Associations</h2>

      <p class="cf-label mb-2">Team Accounts <span style="font-weight:400">(logins on this clinic)</span></p>
      <div class="cf-card rounded-2xl p-4 mb-2">
        <div class="flex flex-col gap-2 mb-2">
          <div v-for="a in staffAccounts" :key="a.id" class="record-card flex items-center justify-between p-2.5">
            <div>
              <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ a.adminName || a.email }}</span>
              <span v-if="a.designation" class="text-xs ml-2" style="color:var(--cf-text)">{{ a.designation }}</span>
              <span v-if="a.status === 'pending'" class="text-xs ml-2" style="color:#b45309">(pending approval)</span>
              <span v-else-if="a.status === 'rejected'" class="text-xs ml-2" style="color:#b91c1c">(rejected)</span>
              <div class="text-xs" style="color:var(--cf-text)">{{ a.email }}</div>
            </div>
          </div>
        </div>
        <p v-show="staffAccounts.length >= 4" class="text-xs" style="color:var(--cf-text)">This clinic already has the maximum of 4 team accounts.</p>
      </div>
      <JoinLinkPanel link-kind="staff" audience-label="new teammate" redeemed-by-label=" with their own email and password" class="mb-5" />

      <p class="cf-label mb-2">Affiliate Practitioners</p>
      <div class="cf-card rounded-2xl p-4 mb-2">
        <p v-show="practitionerAffiliates.length === 0" class="text-xs text-center py-2" style="color:var(--cf-text)">No affiliate practitioners linked yet.</p>
        <div class="flex flex-col gap-2">
          <div v-for="a in practitionerAffiliates" :key="a.accountId" class="record-card flex items-center justify-between p-2.5">
            <div>
              <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ a.adminName || a.email }}</span>
              <span v-if="a.role" class="text-xs ml-2" style="color:var(--cf-text)">{{ a.role }}</span>
              <div class="text-xs" style="color:var(--cf-text)">{{ a.email }}</div>
            </div>
            <button class="btn-ghost text-xs px-2 py-1" @click="removePractitionerAffiliate(a.accountId)"><i class="fas fa-times"></i> Remove</button>
          </div>
        </div>
      </div>
      <div v-if="practitionerAffiliates.length" class="cf-card rounded-2xl p-4 mb-2">
        <div class="flex items-center justify-between mb-2">
          <p class="cf-label mb-0">FHIR Affiliate Conformance <span style="font-weight:400">(ClinuxFlowAffiliatePractitionerRole)</span></p>
          <button class="btn-ghost text-xs px-2 py-1" :disabled="practitionerAffiliateConformanceLoading" @click="checkPractitionerAffiliateConformance()">
            <i class="fas" :class="practitionerAffiliateConformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
          </button>
        </div>
        <p v-if="!practitionerAffiliateConformanceResult" class="text-xs" style="color:var(--cf-text)">
          Checks each linked affiliate as a real FHIR PractitionerRole against this facility's own Organization.
        </p>
        <p v-else-if="practitionerAffiliateConformanceResult.error" class="text-xs" style="color:#b91c1c">{{ practitionerAffiliateConformanceResult.error }}</p>
        <template v-else>
          <p v-if="!practitionerAffiliateConformanceResult.hasOrganization" class="text-xs mb-2" style="color:var(--cf-text)">
            No Hospital Profile saved yet — every affiliate below will show a missing Organization link until one is.
          </p>
          <div class="flex flex-col gap-2" style="max-height:220px;overflow-y:auto">
            <div v-for="a in practitionerAffiliateConformanceResult.affiliates" :key="a.role.id" class="record-card p-2">
              <p class="text-xs font-semibold mb-1" :style="a.valid ? 'color:var(--color-primary)' : 'color:var(--cf-text-strong)'">
                <i class="fas" :class="a.valid ? 'fa-circle-check' : 'fa-circle-info'"></i>
                {{ a.affiliate.adminName || a.affiliate.email }}
              </p>
              <ul style="font-size:.7rem;color:var(--cf-text);padding-left:1rem">
                <li v-for="e in a.errors" :key="e.path">{{ e.message }}</li>
              </ul>
            </div>
          </div>
        </template>
      </div>
      <JoinLinkPanel link-kind="affiliate" audience-label="practitioner" redeemed-by-label=" from their own account" class="mb-5" />

      <p class="cf-label mb-2">Affiliate Partners <span style="font-weight:400">(real, resolvable links)</span></p>
      <div class="cf-card rounded-2xl p-4 mb-2">
        <p class="text-xs mb-3" style="color:var(--cf-text)">
          Have a join link or code from another ClinuxFlow-registered facility? Redeem it here to
          link your organizations for real — resolvable, unlike the free-text entries in Affiliate
          Partners above.
        </p>
        <JoinTokenRedeemForm @success="onOrgJoinSuccess" />
      </div>
      <div class="cf-card rounded-2xl p-4 mb-2">
        <p v-show="orgAffiliates.length === 0" class="text-xs text-center py-2" style="color:var(--cf-text)">No real linked partners yet.</p>
        <div class="flex flex-col gap-2">
          <div v-for="o in orgAffiliates" :key="o.affiliateClinicId" class="record-card flex items-center justify-between p-2.5">
            <div>
              <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ o.affiliateClinicName }}</span>
              <span v-if="o.relationship" class="text-xs ml-2" style="color:var(--cf-text)">{{ o.relationship }}</span>
            </div>
            <button class="btn-ghost text-xs px-2 py-1" @click="removeOrgAffiliateLink(o.affiliateClinicId)"><i class="fas fa-times"></i> Remove</button>
          </div>
        </div>
      </div>
      <JoinLinkPanel link-kind="organization" audience-label="partner organization's admin" redeemed-by-label=" from their own facility account" />
    </div>

  </div>
  </main>
</template>
