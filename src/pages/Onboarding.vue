<script setup>
// Ported from clinixflow's public/onboarding.html — the clinic setup hub (hub → review →
// published screens), each journey card backed by a real FHIR record via the same
// SystemForms/LhcFormHost drawer pattern Front Desk uses.
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import LhcFormHost from '../components/LhcFormHost.vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import {
  listDataRecords, recordSummary, activeQuestionnaire, deleteDataRecord, seedSystemForms,
  saveDataRecord, activeVersionNumber,
} from '../data/useSystemForms.js';
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

const confirmDel = reactive({ show: false, msg: '', action: () => {} });

const drawerOpen = ref(false);
const activeForm = ref(null); // the journeyCards entry currently open in the drawer
const drawerQuestionnaire = ref(null);
const drawerRecord = ref(null);
const formKey = ref(0); // bumped to force LhcFormHost to remount (guaranteed re-render to blank)
// after a repeatable save, since a re-assigned questionnaire ref isn't guaranteed to be a new
// object reference the component's own prop watcher would pick up as "changed."
const lhcFormHost = ref(null);

const journeyCards = [
  { formId: 'system-hospital-profile-v1', mode: 'single', icon: 'fas fa-hospital', color: '#3B82F6', bg: 'rgba(59,130,246,.1)', title: 'Hospital Profile', desc: 'Your clinic profile as a FHIR Organization resource.' },
  { formId: 'system-staff-profile-v1', mode: 'repeatable', icon: 'fas fa-user-md', color: '#00D4B2', bg: 'rgba(0,212,178,.1)', title: 'Care Team', desc: 'Add physicians, nurses and staff as FHIR Practitioner records.' },
  { formId: 'system-services-profile-v1', mode: 'repeatable', icon: 'fas fa-stethoscope', color: '#8B5CF6', bg: 'rgba(139,92,246,.1)', title: 'Services', desc: "List the services your clinic offers." },
  { formId: 'system-office-hours-profile-v1', mode: 'repeatable', icon: 'fas fa-clock', color: '#F59E0B', bg: 'rgba(245,158,11,.1)', title: 'Office Hours', desc: 'Add operating hours, one day-range at a time.' },
  { formId: 'system-consents-profile-v1', mode: 'repeatable', icon: 'fas fa-file-signature', color: '#EF4444', bg: 'rgba(239,68,68,.1)', title: 'Legal Consents', desc: 'Add the consent types your clinic collects from patients.' },
  { action: 'designer', icon: 'fas fa-layer-group', color: '#06B6D4', bg: 'rgba(6,182,212,.1)', title: 'Open Designer', desc: 'Manage versions, training and the full data grid for every form.' },
];

seedSystemForms(API_BASE).catch(() => {});

const screenLabel = computed(() => ({ hub: 'Setup', review: 'Review', published: 'Published' }[screen.value] || 'Setup'));

function listRecords(formId) {
  onboarding.dataVersion; // register the reactive dependency
  return listDataRecords(formId);
}

function cardStatus(card) {
  if (card.mode === 'single') return listRecords(card.formId).length > 0 ? 'Saved' : 'Not started';
  const n = listRecords(card.formId).length;
  return n > 0 ? `${n} added` : 'Not started';
}

function openDrawer(formId) {
  const card = journeyCards.find((c) => c.formId === formId);
  if (!card) return;
  activeForm.value = card;
  drawerOpen.value = true;

  const q = activeQuestionnaire(formId);
  drawerQuestionnaire.value = q;
  if (!q) { drawerRecord.value = null; return; }

  if (card.mode === 'single') {
    // Falls back to a synthetic record built from the index.html registration account the very
    // first time, so this card doesn't open blank when that info was already given at sign-up.
    const existing = listDataRecords(formId)[0]
      || (formId === onboarding.HOSPITAL_FORM_ID ? onboarding.buildSeedFromRegistration() : null);
    drawerRecord.value = existing;
  } else {
    drawerRecord.value = null;
  }
}

function openCard(card) {
  if (card.action === 'designer') router.push('/designer');
  else openDrawer(card.formId);
}

function closeDrawer() {
  drawerOpen.value = false;
}

function saveDrawerRecord() {
  if (!activeForm.value) return;
  const formId = activeForm.value.formId;

  if (activeForm.value.mode === 'single') {
    const ok = onboarding.saveHospitalRecord('drawerFormContainer');
    if (ok) { showToast('Saved.'); closeDrawer(); }
    else showToast('Could not read the entered data. Please try again.');
    return;
  }

  const qr = lhcFormHost.value?.extract();
  if (!qr) { showToast('Could not read the entered data. Please try again.'); return; }
  saveDataRecord(formId, activeVersionNumber(formId), qr);
  onboarding.dataVersion++;
  drawerRecord.value = null;
  formKey.value++;
  showToast('Added.');
}

function askRemoveDrawerRecord(recordId, label) {
  confirmDel.show = true;
  confirmDel.msg = `Remove "${label}"?`;
  confirmDel.action = () => {
    deleteDataRecord(recordId);
    onboarding.dataVersion++;
    showToast('Removed.');
  };
}

function goToReview() {
  if (listRecords(onboarding.HOSPITAL_FORM_ID).length === 0) {
    showToast('Please complete your Hospital Profile first.');
    openDrawer(onboarding.HOSPITAL_FORM_ID);
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
  { label: 'Staff Members', value: listRecords(onboarding.STAFF_FORM_ID).length },
  { label: 'Services', value: listRecords(onboarding.SERVICES_FORM_ID).length },
  { label: 'Consents Added', value: listRecords(onboarding.CONSENTS_FORM_ID).length },
  { label: 'Hours Entries', value: listRecords(onboarding.HOURS_FORM_ID).length },
]);

const fhirPreview = computed(() => {
  onboarding.dataVersion;
  const hospitalRec = listDataRecords(onboarding.HOSPITAL_FORM_ID)[0];
  return hospitalRec ? JSON.stringify(hospitalRec.data, null, 2) : '// Complete the Hospital Profile card to see its FHIR QuestionnaireResponse here.';
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

  <div class="modal-backdrop" v-show="confirmDel.show" @click.self="confirmDel.show = false">
    <div class="modal-box" style="max-width:380px" @click.stop>
      <div style="text-align:center;padding-bottom:1rem">
        <div style="width:52px;height:52px;border-radius:50%;background:rgba(239,68,68,.1);display:flex;align-items:center;justify-content:center;margin:0 auto .875rem"><i class="fas fa-trash text-red-500 text-lg"></i></div>
        <h3 style="font-family:'Poppins',sans-serif;font-weight:700;color:var(--cf-text-strong);margin-bottom:.5rem">Remove Record?</h3>
        <p style="font-size:.85rem;color:var(--cf-text)">{{ confirmDel.msg }}</p>
      </div>
      <div style="display:flex;gap:.625rem;justify-content:flex-end;margin-top:1.25rem">
        <button class="btn-ghost" @click="confirmDel.show = false">Cancel</button>
        <button style="background:#EF4444;color:#fff;font-family:'Poppins',sans-serif;font-weight:700;padding:.5rem 1.25rem;border-radius:.5rem;border:none;cursor:pointer;font-size:.85rem" @click="confirmDel.action(); confirmDel.show = false">Delete</button>
      </div>
    </div>
  </div>

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

      <div v-if="activeForm && activeForm.mode === 'repeatable'" style="margin-top:1.25rem">
        <p class="cf-label" style="margin-bottom:.6rem">Added so far ({{ listRecords(activeForm.formId).length }})</p>
        <div v-show="listRecords(activeForm.formId).length === 0" style="font-size:.82rem;color:var(--cf-text);padding:.5rem 0">Nothing added yet.</div>
        <div style="display:flex;flex-direction:column;gap:.5rem">
          <div v-for="rec in listRecords(activeForm.formId)" :key="rec.id" class="record-card">
            <span style="font-size:.85rem;color:var(--cf-text-strong);font-weight:600">{{ recordSummary(rec) }}</span>
            <button @click="askRemoveDrawerRecord(rec.id, recordSummary(rec))" style="background:transparent;border:none;cursor:pointer;color:#EF4444;font-size:.85rem"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      </div>
    </div>
    <div class="drawer-footer">
      <button v-if="activeForm && activeForm.mode === 'single'" class="btn-teal" @click="saveDrawerRecord()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-save"></i>Save</button>
      <button v-if="activeForm && activeForm.mode === 'repeatable'" class="btn-teal" @click="saveDrawerRecord()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i>Add</button>
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
          <div style="display:flex;gap:.75rem">
            <button class="btn-teal" @click="goToReview()" style="display:flex;align-items:center;gap:.5rem"><i class="fas fa-arrow-right"></i>Continue to Review</button>
            <RouterLink to="/clinic-home" target="_blank" class="btn-outline" style="display:flex;align-items:center;gap:.5rem"><i class="fas fa-eye"></i>See Sample Page</RouterLink>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
          <button v-for="card in journeyCards" :key="card.formId || card.title" class="entry-card" @click="openCard(card)">
            <div style="width:36px;height:36px;border-radius:.625rem;display:flex;align-items:center;justify-content:center;margin-bottom:.75rem" :style="`background:${card.bg}`">
              <i :class="card.icon" :style="`color:${card.color};font-size:.9rem`"></i>
            </div>
            <p style="font-weight:700;font-size:.85rem;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ card.title }}</p>
            <p style="font-size:.75rem;color:var(--cf-text);line-height:1.45;margin-bottom:.5rem">{{ card.desc }}</p>
            <span v-show="card.action === 'designer'" style="font-size:.72rem;color:var(--color-primary);font-weight:600;font-family:'Poppins',sans-serif"><i class="fas fa-arrow-right" style="margin-right:.3rem"></i>Open Designer</span>
            <span v-show="card.formId" class="badge" :class="card.formId && listRecords(card.formId).length > 0 ? 'badge-teal' : 'badge-muted'">{{ cardStatus(card) }}</span>
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
          <h4 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);font-family:'Poppins',sans-serif"><i class="fas fa-code mr-2" style="color:var(--color-primary)"></i>FHIR QuestionnaireResponse Preview (Hospital)</h4>
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
