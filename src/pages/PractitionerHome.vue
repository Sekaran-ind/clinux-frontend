<script setup>
// Practitioner's own Page View — the "not through ClinicHome" home a practitioner reaches
// directly (explicit instruction), mirroring ClinicHome.vue's own 3-surface pattern: this page is
// pure display + edit-triggers, /staff-onboarding (Data View) is the one real editing surface,
// and Cübo mounts directly here, not behind a link.
//
// Resume-style redesign (explicit instruction: "should look like a Resume page having the profile
// of the person not a series of navigation links") — the old version was 4 cards, each just a
// title + one line of status text + an edit-pencil that navigated away; almost none of the
// practitioner's real data ever actually rendered here. This version shows the real profile
// itself (photo, name, headline, contact, qualifications, HPR credential) as the page's own
// content, with edit affordances layered on top rather than standing in for the content.
//
// Architecture guideline (explicit instruction), same split StaffOnboarding.vue's own Data View
// now follows: graph-defined information (this practitioner's own FHIR-shaped profile) IS the
// resume body; externally-linked information (Professional Documents — local file uploads;
// Clinic Association — a join-token identity relationship) renders as a dedicated section below
// the resume, not woven into it.
//
// No more myIndex/cf_my_staff_index_* localStorage — real bug found live (the OTHER half of the
// "allows adding more than one record" fix): the practitioner self-service components
// (ProviderPersonalDetailsHost/ProviderQualificationsHost/ProviderWorkExperienceHost) guarantee at
// most one section_staff/section_staff_role pair per account, always at index 0, so there is no
// longer any "which of N rows is mine" ambiguity to track.
//
// Real HPR-spec-fidelity rebuild (explicit instruction) — the resume now surfaces every
// qualification (not just the old single free-text staff_qualification string) and the real
// currentWorkDetails block, matching StaffOnboarding.vue's own 3-way Personal Details/
// Qualifications/Work Experience split; editSection() targets now resolve to those 3 real nav ids.
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Cubo from '../components/Cubo.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import { useAuthStore } from '../stores/auth.js';
import { useLiveQuery } from '@tanstack/vue-db';
import { getGroupInstances, getNestedGroupInstances, getAnswer, getAnswers } from '../data/useSystemForms.js';
import { practitionerDocuments } from '../data/collections/practitionerDocs.js';

const router = useRouter();
const onboarding = useOnboardingStore();
const auth = useAuthStore();

function editSection(sectionId) {
  router.push({ path: '/staff-onboarding', query: { section: sectionId } });
}
// Documents/Associate are externally-linked, not graph sections (see header comment) — they no
// longer live in StaffOnboarding.vue's own AdaptiveSectionNav/?section= mechanism, just a plain
// in-page anchor on that same page now.
function goToExternalSection(anchorId) {
  router.push(`/staff-onboarding#${anchorId}`);
}

const myAffiliations = ref([]);
const affiliationsLoading = ref(true);
async function loadAffiliations() {
  affiliationsLoading.value = true;
  const res = await auth.fetchMyAffiliations();
  myAffiliations.value = res.affiliations || [];
  affiliationsLoading.value = false;
}
onMounted(loadAffiliations);

const myRecord = computed(() => {
  onboarding.dataVersion;
  const instance = getGroupInstances(onboarding.getProviderRecord(), 'section_staff')[0];
  return instance ? { data: instance } : null;
});
const myRole = computed(() => {
  onboarding.dataVersion;
  const instance = getGroupInstances(onboarding.getProviderRecord(), 'section_staff_role')[0];
  return instance ? { data: instance } : null;
});
const myQualifications = computed(() => {
  onboarding.dataVersion;
  const instances = getNestedGroupInstances(onboarding.getProviderRecord(), 'section_staff', 0, 'section_staff_qualification');
  return instances.map((instance) => {
    const rec = { data: instance };
    return {
      degree: (getAnswer(rec, 'staff_qual_degree_code') || '').split(' - ')[1] || getAnswer(rec, 'staff_qual_degree_code'),
      college: getAnswer(rec, 'staff_qual_college'),
      registrationNumber: getAnswer(rec, 'staff_qual_registration_number'),
      council: getAnswer(rec, 'staff_qual_registered_council'),
    };
  });
});

const { data: allDocs } = useLiveQuery((q) => q.from({ d: practitionerDocuments }));
const myDocCount = computed(() => allDocs.value.filter((d) => d.accountId === auth.currentUser?.id).length);

const needsSetup = computed(() => !myRecord.value && !myDocCount.value && !myAffiliations.value.length);

const photo = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_photo') : '');
const name = computed(() => {
  if (!myRecord.value) return '';
  return [getAnswer(myRecord.value, 'staff_first_name'), getAnswer(myRecord.value, 'staff_last_name')].filter(Boolean).join(' ');
});
const phone = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_phone') : '');
const email = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_email') : '');
const license = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_license') : '');
const clinicalRole = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_role') : '');
// getAnswers (plural) — real bug found live: staff_specialty is a MultiSelect (0..* real
// choices), but getAnswer (singular) only ever reads the first; a practitioner with 2+
// specialties silently only ever showed one. Joined for display, same convention
// myQualifications' own summary line uses.
const specialty = computed(() => myRecord.value ? getAnswers(myRecord.value, 'staff_specialty').join(', ') : '');
const hprRole = computed(() => myRole.value ? getAnswer(myRole.value, 'staff_provider_role') : '');
const hprId = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_hprid') : '');
const headline = computed(() => hprRole.value || clinicalRole.value || 'Healthcare Professional');

const workCurrentlyWorking = computed(() => {
  if (!myRecord.value) return true;
  const raw = getAnswer(myRecord.value, 'staff_work_currently_working');
  return raw === true || raw === 'true' || raw === '';
});
const workStatus = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_work_status') : '');
const workFacilityName = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_work_facility_name') : '');
const workDesignation = computed(() => myRecord.value ? getAnswer(myRecord.value, 'staff_work_facility_designation') : '');
</script>

<template>
  <!-- Renders inside AppShell (requiresAuth route) — the shell's sidebar/top bar replace the
       site-nav this page used to carry (photo/name lockup, theme toggle, Home link); the resume
       card below already shows the photo/name/headline. -->
  <div class="page" style="max-width:820px">
        <div class="page-header">
          <div>
            <h1 class="page-title">My profile</h1>
            <p class="page-subtitle">Your professional profile as other clinics and the Healthcare Professionals Registry (HPR) see it. It belongs to you, not to any one clinic.</p>
          </div>
          <div v-if="!needsSetup" class="page-actions">
            <button class="ui-btn" @click="editSection('registry')"><i class="fas fa-id-card"></i> HPR registration</button>
            <button class="ui-btn ui-btn-primary" @click="editSection('personal')"><i class="fas fa-user-pen"></i> Edit profile</button>
          </div>
        </div>

        <div v-if="needsSetup" class="panel">
          <div class="empty-state">
            <div class="empty-state-icon"><i class="fas fa-id-badge"></i></div>
            <div class="empty-state-title">Nothing filled in yet</div>
            <p class="empty-state-text">Your details show up here as soon as they're saved. There's no separate publish step.</p>
            <div class="empty-state-actions">
              <button class="ui-btn ui-btn-primary" @click="editSection('personal')"><i class="fas fa-user-pen"></i> Build my profile</button>
            </div>
          </div>
        </div>

        <template v-else>
          <!-- The resume itself — real profile content, not a card of status text. Photo/name/
               headline live above already (site-nav); this is the body: contact strip, then
               qualifications/registry as real resume sections, each with a quiet edit affordance
               rather than the content BEING "click to edit". -->
          <div class="cf-card" style="border-radius:.625rem;padding:1.5rem;margin-bottom:1.5rem;position:relative">
            <button class="btn-outline btn-xs" title="Edit" style="position:absolute;top:1.25rem;right:1.25rem" @click="editSection('personal')"><i class="fas fa-pencil"></i></button>
            <div style="display:flex;align-items:center;gap:1.25rem;margin-bottom:1.5rem;flex-wrap:wrap">
              <div style="width:88px;height:88px;border-radius:50%;overflow:hidden;flex-shrink:0;background:var(--bg-alt);border:2px solid var(--brand);display:flex;align-items:center;justify-content:center">
                <img v-if="photo" :src="`data:image/jpeg;base64,${photo}`" alt="" style="width:100%;height:100%;object-fit:cover" />
                <i v-else class="fas fa-user" style="color:var(--text);font-size:2rem"></i>
              </div>
              <div>
                <h1 style="font-size:1.6rem;font-weight:800;color:var(--text-strong);line-height:1.15">{{ name || 'Your Name' }}</h1>
                <p style="font-size:.95rem;font-weight:600;color:var(--brand)">{{ headline }}</p>
                <p v-show="specialty" style="font-size:.85rem;color:var(--text)"><i class="fas fa-stethoscope mr-1.5"></i>{{ specialty }}</p>
              </div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:1.25rem;font-size:.85rem;color:var(--text);padding-top:1rem;border-top:1px solid var(--border)">
              <span v-show="phone"><i class="fas fa-phone mr-1.5" style="color:var(--brand)"></i>{{ phone }}</span>
              <span v-show="email"><i class="fas fa-envelope mr-1.5" style="color:var(--brand)"></i>{{ email }}</span>
              <span v-show="!phone && !email" style="color:var(--text)">No contact details added yet.</span>
            </div>
          </div>

          <div class="cf-card" style="border-radius:.625rem;padding:1.25rem 1.5rem;margin-bottom:1.5rem;position:relative">
            <button class="btn-outline btn-xs" title="Edit" style="position:absolute;top:1.25rem;right:1.25rem" @click="editSection('qualifications')"><i class="fas fa-pencil"></i></button>
            <h2 style="font-size:1.05rem;font-weight:700;color:var(--text-strong);margin-bottom:.875rem"><i class="fas fa-graduation-cap mr-2" style="color:var(--brand)"></i>Qualifications</h2>
            <div v-if="myQualifications.length" class="flex flex-col gap-2.5">
              <div v-for="(q, i) in myQualifications" :key="i" style="padding-bottom:.6rem" :style="i < myQualifications.length - 1 ? 'border-bottom:1px solid var(--border)' : ''">
                <p style="font-size:.9rem;font-weight:700;color:var(--text-strong)">{{ q.degree }}</p>
                <p v-show="q.college" style="font-size:.8rem;color:var(--text)">{{ q.college }}</p>
                <p v-show="q.registrationNumber" style="font-size:.8rem;color:var(--text)">Reg. No. {{ q.registrationNumber }}</p>
              </div>
            </div>
            <p v-show="license" style="font-size:.85rem;color:var(--text);margin-top:.6rem"><strong style="color:var(--text-strong)">License / Registration ID:</strong> {{ license }}</p>
            <p v-if="!myQualifications.length && !license" style="font-size:.85rem;color:var(--text)">No qualifications added yet.</p>
          </div>

          <div class="cf-card" style="border-radius:.625rem;padding:1.25rem 1.5rem;margin-bottom:1.5rem;position:relative">
            <button class="btn-outline btn-xs" title="Edit" style="position:absolute;top:1.25rem;right:1.25rem" @click="editSection('work')"><i class="fas fa-pencil"></i></button>
            <h2 style="font-size:1.05rem;font-weight:700;color:var(--text-strong);margin-bottom:.875rem"><i class="fas fa-briefcase mr-2" style="color:var(--brand)"></i>Work Experience</h2>
            <p v-if="workFacilityName" style="font-size:.9rem;color:var(--text)">
              <strong style="color:var(--text-strong)">{{ workDesignation || 'Practicing' }}</strong> at {{ workFacilityName }}
              <span v-show="workStatus" style="color:var(--text)"> · {{ workStatus }}</span>
            </p>
            <p v-else-if="workStatus" style="font-size:.9rem;color:var(--text)">{{ workStatus }} practice</p>
            <p v-show="!workCurrentlyWorking" style="font-size:.8rem;color:var(--text);margin-top:.3rem">Not currently working.</p>
            <p v-if="!workFacilityName && !workStatus" style="font-size:.85rem;color:var(--text)">No work experience added yet.</p>
          </div>

          <div class="cf-card" style="border-radius:.625rem;padding:1.25rem 1.5rem;position:relative">
            <button class="btn-outline btn-xs" title="Edit" style="position:absolute;top:1.25rem;right:1.25rem" @click="editSection('registry')"><i class="fas fa-pencil"></i></button>
            <h2 style="font-size:1.05rem;font-weight:700;color:var(--text-strong);margin-bottom:.875rem"><i class="fas fa-id-card mr-2" style="color:var(--brand)"></i>ABDM Registration (HPR)</h2>
            <p v-if="hprId" style="font-size:.95rem;font-weight:700;color:var(--brand)"><i class="fas fa-circle-check"></i> {{ hprId }}</p>
            <p v-else style="font-size:.85rem;color:var(--text)">Not registered with ABDM yet — Aadhaar or mobile verification, Id card and password recovery all live here.</p>
          </div>

          <!-- Externally-linked information (explicit instruction) — a dedicated section below
               the resume itself, not woven into it: neither of these is part of this
               practitioner's own FHIR profile. -->
          <div style="margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--border)">
            <span class="eyebrow">Linked Elsewhere</span>
            <div class="cf-card" style="border-radius:.625rem;padding:1.25rem 1.5rem;margin:1rem 0 1.5rem;position:relative">
              <button class="btn-outline btn-xs" title="Manage documents" style="position:absolute;top:1.25rem;right:1.25rem" @click="goToExternalSection('documents-section')"><i class="fas fa-pencil"></i></button>
              <h2 style="font-size:1.05rem;font-weight:700;color:var(--text-strong);margin-bottom:.5rem"><i class="fas fa-folder-open mr-2" style="color:var(--brand)"></i>Professional Documents</h2>
              <p v-if="myDocCount" style="font-size:.85rem;color:var(--text)">{{ myDocCount }} document{{ myDocCount === 1 ? '' : 's' }} on file</p>
              <p v-else style="font-size:.85rem;color:var(--text)">No documents uploaded yet — degree certificates, council registration, ID and more.</p>
            </div>

            <div class="cf-card" style="border-radius:.625rem;padding:1.25rem 1.5rem;position:relative">
              <button class="btn-outline btn-xs" title="Associate with a clinic" style="position:absolute;top:1.25rem;right:1.25rem" @click="goToExternalSection('associate-section')"><i class="fas fa-link"></i></button>
              <h2 style="font-size:1.05rem;font-weight:700;color:var(--text-strong);margin-bottom:.5rem"><i class="fas fa-hospital mr-2" style="color:var(--brand)"></i>Clinic Association</h2>
              <div v-if="myAffiliations.length" class="flex flex-col gap-2">
                <div v-for="a in myAffiliations" :key="a.facilityClinicId" style="display:flex;align-items:center;gap:.5rem">
                  <i class="fas fa-hospital" style="color:var(--brand)"></i>
                  <span style="font-size:.9rem;font-weight:700;color:var(--text-strong)">{{ a.facilityName }}</span>
                  <span v-if="a.role" style="font-size:.75rem;color:var(--text)">— {{ a.role }}</span>
                </div>
              </div>
              <p v-else-if="!affiliationsLoading" style="font-size:.85rem;color:var(--text)">
                Redeem a clinic's Share Link to associate your profile with them — the only way a clinic
                gets linked here.
              </p>
            </div>
          </div>
        </template>
  </div>

  <Cubo category="practitioner" page-context="Your professional profile — personal details, ABDM registration and clinic association." />
</template>

<style scoped>
/* Same self-contained design-system tokens ClinicHome.vue's own style block defines — this page
   needs to render correctly even if someone lands here directly (e.g. from a Share Link redeem
   flow) without ever visiting /clinic-home first, so these can't rely on that page's chunk
   having loaded. :global() so they cascade to every element here, same reasoning ClinicHome.vue's
   own header comment already gives. */
:global(:root) {
  --brand:#00D4B2; --brand2:#00B89C;
  --bg:#FAFCFF; --bg-alt:#F0F4F9;
  --text:#475569; --text-strong:#0A2540;
  --border:#CBD5E1;
}
:global(.dark) {
  --bg:#080F1C; --bg-alt:#0D1A2E;
  --text:#94A3B8; --text-strong:#E2E8F0;
  --border:#1E3A5F;
}
.site-nav { position:sticky; top:0; z-index:50; background:var(--bg); border-bottom:1px solid var(--border); }
.nav-inner { max-width:1150px; margin:0 auto; padding:.875rem 1.5rem; display:flex; align-items:center; justify-content:space-between; }
.nav-logo { display:flex; align-items:center; gap:.75rem; }
.icon-btn-round { width:36px; height:36px; border-radius:999px; display:flex; align-items:center; justify-content:center; background:var(--bg-alt); border:1px solid var(--border); cursor:pointer; color:var(--text); }
.eyebrow { color:var(--brand); font-weight:700; font-size:.78rem; text-transform:uppercase; letter-spacing:.05em; }
</style>
