<script setup>
// Practitioner's own Data View (explicit instruction: "Practitioner can register himself
// directly, not through ClinicHome... follow the same Page View, Data View and Cübo Thread").
// The underlying record is still onboarding.getProviderRecord() (the practitioner's own
// Practitioner/PractitionerRole entries don't require an Organization to already exist in the
// same document — nothing here ever reads section_hospital), not a new storage model.
//
// Architecture guideline (explicit instruction): information contained in the Graph Definition
// (this practitioner's own FHIR-shaped profile — Personal Details/Qualifications/Work Experience,
// ABDM Registration) renders as the page-level nav's own sections, switchable via
// accordion/sidebar/tabs. Information that is EXTERNALLY linked (Professional Documents — local
// file uploads, not FHIR data at all; Associate with a Clinic — a join-token identity
// relationship, not part of this practitioner's own FHIR resource) renders as a dedicated section
// BELOW the nav instead, so it never becomes a peer nav item competing for the same switching
// control the graph-defined sections use.
//
// Real HPR-spec-fidelity rebuild (explicit instruction: "Personal details, Qualifications and Work
// experience can be seperate tree elements instead of one with multiple tabs") — the former single
// ProviderMyProfileHost tabbed card is now 3 separate nav sections/components, each saving
// independently (ProviderPersonalDetailsHost/ProviderQualificationsHost/ProviderWorkExperienceHost
// — see their own header comments for why field-level patches, not a whole-instance replace).
// ProviderBasicsHost (the roster component this whole self-service line replaced) is deliberately
// NOT used here — real bug found live: it's built for an ADMIN adding MULTIPLE staff members, and
// reusing it (even with copy-only relabeling) let a practitioner accidentally save more than one
// "staff" entry under their own account. "It is not staff details that is captured in Practitioner
// portal" (explicit instruction) — none of the 3 components below have any add/remove/roster
// mechanics for the Practitioner itself, so myIndex tracking (the old cf_my_staff_index_*
// localStorage pointer) stays gone: there is always at most exactly one section_staff/
// section_staff_role pair for this account, always at index 0.
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ProviderPersonalDetailsHost from '../components/control/ProviderPersonalDetailsHost.vue';
import ProviderQualificationsHost from '../components/control/ProviderQualificationsHost.vue';
import ProviderWorkExperienceHost from '../components/control/ProviderWorkExperienceHost.vue';
import ProviderDocumentsHost from '../components/control/ProviderDocumentsHost.vue';
import JoinTokenRedeemForm from '../components/auth/JoinTokenRedeemForm.vue';
import AdaptiveSectionNav from '../components/AdaptiveSectionNav.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import { seedSystemForms, getGroupInstances } from '../data/useSystemForms.js';
import { API_BASE } from '../config.js';

const router = useRouter();
const route = useRoute();
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

const personalHost = ref(null);
const qualificationsHost = ref(null);
const workHost = ref(null);

// Each of the 3 hosts patches only its OWN fields directly against the store (see their own
// header comments) — this just supplies the record id they patch into and bumps dataVersion
// afterward so every other reader (ProviderHprPanel, PractitionerHome, ...) re-renders.
function savePersonal() { personalHost.value?.save(); onboarding.dataVersion++; showToast('Personal Details saved.'); }
function saveQualifications() { qualificationsHost.value?.save(); onboarding.dataVersion++; showToast('Qualifications saved.'); }
function saveWork() { workHost.value?.save(); onboarding.dataVersion++; showToast('Work Experience saved.'); }

// ?section=<id> deep-links a specific sidebar section in, same convention
// ClinicHome.vue's editSection()/Onboarding.vue's activeSectionId already use. Only graph-defined
// sections live in this nav now (see header comment) — Documents/Associate render below instead.
const activeSectionId = ref(
  (typeof route.query.section === 'string' && route.query.section) || 'personal'
);
const navSections = [
  { id: 'personal', label: 'Personal Details', icon: 'fa-user' },
  { id: 'qualifications', label: 'Qualifications', icon: 'fa-graduation-cap' },
  { id: 'work', label: 'Work Experience', icon: 'fa-briefcase' },
  { id: 'registry', label: 'ABDM (HPR) Registration', icon: 'fa-id-card' },
];

function goToPractitionerHome() {
  router.push('/practitioner-home');
}
function onJoinSuccess() {
  showToast('Join request sent — you\'ll be notified once the facility admin decides.');
}
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i><span>{{ toast.msg }}</span></div>

  <main style="flex:1;overflow-y:auto">
    <div style="max-width:960px;margin:0 auto;padding:2rem 1.5rem 4rem">
      <div class="page-header">
        <div>
          <h1 class="page-title">Professional profile</h1>
          <p class="page-subtitle">
            This is yours, not tied to any one clinic. Fill in your details, register with ABDM's Healthcare
            Professionals Registry (HPR) if you'd like, and join a clinic whenever one sends you a join link.
          </p>
        </div>
        <div class="page-actions">
          <RouterLink to="/practitioner-home" class="ui-btn"><i class="fas fa-eye"></i> View profile</RouterLink>
        </div>
      </div>

      <AdaptiveSectionNav :sections="navSections" mode="sidebar" storage-key="practitioner-data-view" v-model:active-id="activeSectionId">
        <template #personal>
          <ProviderPersonalDetailsHost ref="personalHost" :record-id="onboarding.ensureProviderRecord()" :record="onboarding.getProviderRecord()" />
          <div class="flex justify-end mt-3">
            <button class="btn-teal" @click="savePersonal()"><i class="fas fa-save"></i> Save Personal Details</button>
          </div>
        </template>

        <template #qualifications>
          <ProviderQualificationsHost ref="qualificationsHost" :record-id="onboarding.ensureProviderRecord()" :record="onboarding.getProviderRecord()" />
          <div class="flex justify-end mt-3">
            <button class="btn-teal" @click="saveQualifications()"><i class="fas fa-save"></i> Save Qualifications</button>
          </div>
        </template>

        <template #work>
          <ProviderWorkExperienceHost ref="workHost" :record-id="onboarding.ensureProviderRecord()" :record="onboarding.getProviderRecord()" />
          <div class="flex justify-end mt-3">
            <button class="btn-teal" @click="saveWork()"><i class="fas fa-save"></i> Save Work Experience</button>
          </div>
        </template>

        <template #registry>
          <!-- The HPR journey in Registries (src/journeys/specs/hpr.journey.json) replaces ProviderHprPanel.vue. -->
          <div class="cf-card rounded-2xl p-4" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap">
            <p class="text-sm" style="color:var(--cf-text);margin:0">Link your existing HPR ID, or register a new one with Aadhaar (verified on NHA's own page), as a guided journey.</p>
            <RouterLink to="/registries/hpr" class="ui-btn ui-btn-primary"><i class="fas fa-user-doctor"></i> Open HPR ID</RouterLink>
          </div>
        </template>
      </AdaptiveSectionNav>

      <!-- Externally-linked information (explicit instruction) — a dedicated section below the
           graph-driven nav above, not a peer section fighting for the same accordion/sidebar/tabs
           switching control: Professional Documents are local file uploads (no FHIR shape at
           all), and Clinic Association is a join-token identity relationship (facility_affiliates,
           D1) — neither is part of this practitioner's own Practitioner/PractitionerRole profile. -->
      <div style="margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--cf-border)">
        <span class="section-eyebrow" style="display:block;margin-bottom:.75rem">Linked Elsewhere</span>
        <h2 style="font-size:1.25rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:1rem">Documents &amp; Clinic Association</h2>

        <p id="documents-section" class="cf-label mb-2" style="scroll-margin-top:5rem">Professional Documents</p>
        <ProviderDocumentsHost v-if="auth.currentUser" :account-id="auth.currentUser.id" />

        <p id="associate-section" class="cf-label mb-2 mt-4" style="scroll-margin-top:5rem">Associate with a Clinic</p>
        <div class="cf-card rounded-2xl p-4">
          <p class="text-sm mb-3" style="color:var(--cf-text)">
            Have a join link or code from a clinic? Redeem it here to associate your profile with them —
            this is the only way a clinic gets linked to your account; nothing here shares your data with
            a clinic automatically.
          </p>
          <JoinTokenRedeemForm @success="onJoinSuccess" />
        </div>
      </div>

      <button class="btn-primary mt-4" @click="goToPractitionerHome()">Go to My Profile Page <i class="fas fa-arrow-right ml-2"></i></button>
    </div>
  </main>
</template>
