<script setup>
// Ported from clinixflow's public/onboarding.html — the clinic setup hub (hub → review →
// published screens), each journey card backed by a real FHIR record via the same
// SystemForms/LhcFormHost drawer pattern Front Desk uses.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import LhcFormHost from '../components/LhcFormHost.vue';
import SessionImportModal from '../components/SessionImportModal.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import { activeQuestionnaire, seedSystemForms, getGroupInstances, getAnswer } from '../data/useSystemForms.js';
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
const formKey = ref(0); // bumped to force LhcFormHost to remount (guaranteed re-render to blank)
// after a repeatable save, since a re-assigned questionnaire ref isn't guaranteed to be a new
// object reference the component's own prop watcher would pick up as "changed."
const lhcFormHost = ref(null);

// Every card now points at one groupLinkId inside the single, shared Provider-composition
// record instead of its own separate formId (see clinux-provider-composition-merge memory
// note) — Hospital's own card has no repeating count, its "status" is just whether the one
// required field is filled in yet.
const journeyCards = [
  { groupLinkId: 'section_hospital', mode: 'single', icon: 'fas fa-hospital', color: '#3B82F6', bg: 'rgba(59,130,246,.1)', title: 'Hospital Profile', desc: 'Your clinic profile as a FHIR Organization resource.' },
  { groupLinkId: 'section_staff', mode: 'repeatable', icon: 'fas fa-user-md', color: '#00D4B2', bg: 'rgba(0,212,178,.1)', title: 'Care Team', desc: 'Add physicians, nurses and staff as FHIR Practitioner records.' },
  { groupLinkId: 'section_services_matrix', mode: 'repeatable', icon: 'fas fa-stethoscope', color: '#8B5CF6', bg: 'rgba(139,92,246,.1)', title: 'Services', desc: "List the services your clinic offers." },
  { groupLinkId: 'section_hours', mode: 'repeatable', icon: 'fas fa-clock', color: '#F59E0B', bg: 'rgba(245,158,11,.1)', title: 'Office Hours', desc: 'Add operating hours, one day-range at a time.' },
  { groupLinkId: 'section_consent', mode: 'repeatable', icon: 'fas fa-file-signature', color: '#EF4444', bg: 'rgba(239,68,68,.1)', title: 'Legal Consents', desc: 'Add the consent types your clinic collects from patients.' },
  { action: 'designer', icon: 'fas fa-layer-group', color: '#06B6D4', bg: 'rgba(6,182,212,.1)', title: 'Open Designer', desc: 'Manage versions, training and the full data grid for every form.' },
];

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

// The drawer always renders the WHOLE Provider questionnaire regardless of which card was
// clicked — same "whole accumulating document everywhere" tradeoff already accepted for Front
// Desk/Checkout/Consultation Desk's Encounter composition, not a new pattern here.
function openDrawer(card) {
  activeForm.value = card;
  drawerOpen.value = true;

  const q = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  drawerQuestionnaire.value = q;
  if (!q) { drawerRecord.value = null; return; }

  // Falls back to a synthetic record built from the index.html registration account the very
  // first time, so this doesn't open blank when that info was already given at sign-up.
  drawerRecord.value = onboarding.getProviderRecord() || onboarding.buildSeedFromRegistration();
}

function openCard(card) {
  if (card.action === 'designer') router.push('/designer');
  else openDrawer(card);
}

function closeDrawer() {
  drawerOpen.value = false;
}

function saveDrawerRecord() {
  if (!activeForm.value) return;
  const ok = onboarding.saveProviderRecord('drawerFormContainer');
  if (!ok) { showToast('Could not read the entered data. Please try again.'); return; }

  if (activeForm.value.mode === 'repeatable') {
    // Stay open — LForms' own "+ Add another" control is how multiple entries get added, not a
    // separate save-per-entry action (same pattern Front Desk/Checkout already use for Vitals/
    // Prescription/Billing). Re-fetch + remount so the just-saved entry is visible in the form.
    drawerRecord.value = onboarding.getProviderRecord();
    formKey.value++;
    showToast('Added.');
  } else {
    showToast('Saved.');
    closeDrawer();
  }
}

function goToReview() {
  if (!getAnswer(onboarding.getProviderRecord(), 'hospital_name')) {
    showToast('Please complete your Hospital Profile first.');
    openDrawer(journeyCards[0]);
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
        <LhcFormHost v-if="drawerOpen" :key="formKey" ref="lhcFormHost" :questionnaire="drawerQuestionnaire" :record="drawerRecord" container-id="drawerFormContainer" />
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
