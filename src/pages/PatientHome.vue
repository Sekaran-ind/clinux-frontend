<script setup>
// Patient's own staff-facing surface — the 3rd entity to get ClinicHome.vue/PractitionerHome.vue's
// pattern (StructureDefinition + GraphDefinition + generic conformance/search/save API, see
// clinuxflow-api's data/structure-definitions/ClinuxFlowPatient.json, data/graph-definitions/
// ClinuxFlowPatientGraph.json, src/lib/control/resource-registry.js). Structurally different from
// both: Patient is never a singleton (Facility) or a self-owned account (Provider) — it has to be
// a searchable DIRECTORY, since a facility manages many patients, none of whom ever log in
// (SPEC-21 §6 — Patient never gets an account, this page is reached only via staff nav, never as
// anyone's post-login home destination).
//
// Two internal views on this one route, toggled by ?section= (same deep-link convention
// ClinicHome.vue/PractitionerHome.vue's own editSection() already establishes, just keyed by
// recordId here instead of a fixed section name — Patient has no fixed set of sections, each
// record IS the "section"):
//   - Design Page (default, no ?section=) — the directory: search, a conformance summary and the
//     one real next-action (ClinuxFlowPatientGraph.json's Patient -> Encounter reverse link) for
//     whichever patient is selected. "Design" in the sense of showing a record's shape against
//     the real Profile+Graph, the direct runtime analog of Onboarding.vue's own "FHIR Facility
//     Conformance" panel for Facility.
//   - Data Page (?section=<recordId>, or ?section=new) — the actual capture/edit form, reusing
//     PatientBasicsHost.vue as-is (already hosts PatientAbhaPanel.vue internally — no new
//     form-rendering code here at all).
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Cubo from '../components/Cubo.vue';
import PatientBasicsHost from '../components/control/PatientBasicsHost.vue';
import { useThemeStore } from '../stores/theme.js';
import {
  formData, listDataRecords, recordSummary, activeQuestionnaire, activeVersionNumber, saveDataRecord,
} from '../data/useSystemForms.js';
import { checkResourceConformance, pushResourceRecord, searchResourceRecords } from '../data/control/resourceRecords.js';

const PATIENT_FORM_ID = 'system-patient-profile-v1';

const route = useRoute();
const router = useRouter();
const theme = useThemeStore();

// Same "page-local dataVersion, bumped on every collection write" convention FrontDesk.vue's own
// patient step already uses — formData is a local-first TanStack DB collection, not itself a Vue
// reactive source.
const dataVersion = ref(0);
formData.subscribeChanges(() => { dataVersion.value++; });

function editSection(recordId) {
  router.push({ path: '/patient-home', query: { section: recordId } });
}
function backToDirectory() {
  router.push({ path: '/patient-home' });
}

const activeRecordId = computed(() => route.query.section || null);
const onDataPage = computed(() => !!activeRecordId.value);

// ─── Design Page: directory ───
const search = ref('');
const localMatches = computed(() => {
  dataVersion.value;
  const q = search.value.trim().toLowerCase();
  const all = listDataRecords(PATIENT_FORM_ID);
  if (!q) return all.slice(0, 25);
  return all.filter((r) => recordSummary(r).toLowerCase().includes(q)).slice(0, 25);
});

// Cross-device awareness only (paid tier) — deliberately NOT clickable into Data Page: a search
// result here is a raw FHIR Patient resource (resource-records-db.js's own mirror), not this
// device's local QuestionnaireResponse shape PatientBasicsHost.vue's record prop expects, and no
// FHIR->QuestionnaireResponse reverse mapper exists anywhere in this codebase (only the one-way
// extract() direction does) — showing these as informational "also exists on another device"
// awareness is the honest scope for this pass, not a half-built edit path.
const cloudMatches = ref([]);
const cloudSearchLoading = ref(false);
async function runCloudSearch() {
  cloudSearchLoading.value = true;
  cloudMatches.value = await searchResourceRecords('Patient', search.value.trim());
  cloudSearchLoading.value = false;
}
runCloudSearch();
watch(search, () => { runCloudSearch(); });

const selectedPatientId = ref(null);
const selectedRecord = computed(() => {
  dataVersion.value;
  if (!selectedPatientId.value) return null;
  return listDataRecords(PATIENT_FORM_ID).find((r) => r.id === selectedPatientId.value) || null;
});

function selectPatient(id) {
  selectedPatientId.value = id;
  conformanceResult.value = null;
}

// ─── Conformance + next-action (Design Page's own check, on demand) ───
const conformanceLoading = ref(false);
const conformanceResult = ref(null); // { valid, errors, resource, nextActions } | { error } | null
async function checkSelectedConformance() {
  if (!selectedRecord.value) return;
  conformanceLoading.value = true;
  const questionnaireJson = activeQuestionnaire(PATIENT_FORM_ID);
  conformanceResult.value = await checkResourceConformance('Patient', questionnaireJson, selectedRecord.value.data);
  conformanceLoading.value = false;
}

// ─── Data Page: capture/edit ───
const formHost = ref(null);
const editingRecord = computed(() => {
  if (!onDataPage.value || activeRecordId.value === 'new') return null;
  dataVersion.value;
  return listDataRecords(PATIENT_FORM_ID).find((r) => r.id === activeRecordId.value) || null;
});
const saving = ref(false);

async function savePatient() {
  const qr = formHost.value?.extract();
  if (!qr) return;
  saving.value = true;
  const existingId = activeRecordId.value !== 'new' ? activeRecordId.value : null;
  const recordId = saveDataRecord(PATIENT_FORM_ID, activeVersionNumber(PATIENT_FORM_ID), qr, existingId);
  dataVersion.value++;
  // Best-effort cloud mirror push (§3.5) — never blocks or rolls back the local save above, which
  // has already succeeded by this point regardless of what happens next.
  pushResourceRecord('Patient', activeQuestionnaire(PATIENT_FORM_ID), qr, recordId).finally(() => {
    saving.value = false;
  });
  selectedPatientId.value = recordId;
  router.push({ path: '/patient-home' });
}
</script>

<template>
  <div style="min-height:100vh;display:flex;flex-direction:column">
    <nav class="site-nav">
      <div class="nav-inner">
        <div class="nav-logo">
          <div style="padding:.4rem .65rem;border-radius:.5rem;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.5rem;font-family:'JetBrains Mono',monospace;box-shadow:0 10px 15px -3px rgba(0,0,0,.15);background:#00D4B2;color:#fff">P</div>
          <div>
            <p style="font-family:'Poppins',sans-serif;font-weight:700;font-size:1.25rem;color:var(--text-strong);line-height:1.2">Patients</p>
            <p style="font-size:.7rem;color:var(--brand);font-weight:600;font-family:'Poppins',sans-serif">Directory &amp; records</p>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:.625rem">
          <button v-if="onDataPage" class="btn-outline text-sm" @click="backToDirectory()"><i class="fas fa-arrow-left"></i> Directory</button>
          <button class="icon-btn-round" @click="theme.toggle()"><i class="fas" :class="theme.isDark ? 'fa-sun' : 'fa-moon'"></i></button>
          <RouterLink to="/" class="btn-outline text-sm"><i class="fas fa-arrow-left"></i> Home</RouterLink>
        </div>
      </div>
    </nav>

    <main style="flex:1;overflow-y:auto">
      <div style="max-width:900px;margin:0 auto;padding:2.5rem 1.5rem 4rem">

        <!-- ── Design Page: directory ── -->
        <template v-if="!onDataPage">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap">
            <div>
              <span class="eyebrow">Design Page</span>
              <h1 style="font-size:1.75rem;font-weight:800;color:var(--text-strong)">Find or register a patient</h1>
            </div>
            <button class="btn btn-brand" @click="editSection('new')"><i class="fas fa-user-plus"></i> New Patient</button>
          </div>

          <input class="cf-input" v-model="search" placeholder="Search by name, mobile or ABHA number/address..." style="margin-bottom:1.25rem" />

          <div style="display:grid;grid-template-columns:1fr;gap:.6rem;margin-bottom:1.5rem">
            <div
              v-for="rec in localMatches" :key="rec.id"
              class="cf-card record-row"
              :class="{ active: selectedPatientId === rec.id }"
              @click="selectPatient(rec.id)"
            >
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span style="font-weight:600;color:var(--text-strong)">{{ recordSummary(rec) }}</span>
                <button class="btn-outline btn-xs" @click.stop="editSection(rec.id)"><i class="fas fa-pencil"></i> Edit</button>
              </div>
            </div>
            <p v-if="localMatches.length === 0" style="font-size:.85rem;color:var(--text)">No matching patients on this device yet.</p>
          </div>

          <div v-if="selectedRecord" class="cf-card" style="border-radius:1.25rem;padding:1.5rem;margin-bottom:1.5rem">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
              <h2 style="font-size:1rem;font-weight:700;color:var(--text-strong)">FHIR Conformance — {{ recordSummary(selectedRecord) }}</h2>
              <button class="btn-outline btn-xs" :disabled="conformanceLoading" @click="checkSelectedConformance()">
                <i class="fas" :class="conformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
              </button>
            </div>
            <p v-if="!conformanceResult" style="font-size:.85rem;color:var(--text)">Not checked yet — click Check to validate against ClinuxFlowPatient.</p>
            <template v-else-if="conformanceResult.error">
              <p style="font-size:.85rem;color:#b91c1c">{{ conformanceResult.error }}</p>
            </template>
            <template v-else>
              <p style="font-size:.9rem;font-weight:700;margin-bottom:.5rem" :style="conformanceResult.valid ? 'color:var(--brand)' : 'color:var(--text-strong)'">
                <i class="fas" :class="conformanceResult.valid ? 'fa-circle-check' : 'fa-circle-info'"></i>
                {{ conformanceResult.valid ? 'Fully FHIR-conformant.' : `${conformanceResult.errors?.length || 0} field(s) still needed.` }}
              </p>
              <ul v-if="conformanceResult.errors?.length" style="font-size:.78rem;color:var(--text);margin-bottom:.5rem;padding-left:1.1rem">
                <li v-for="e in conformanceResult.errors" :key="e.path">{{ e.message }}</li>
              </ul>
              <div v-if="conformanceResult.nextActions?.length" style="border-top:1px solid var(--border);padding-top:.6rem;margin-top:.4rem">
                <p v-for="a in conformanceResult.nextActions" :key="a.linkId" style="font-size:.82rem;color:var(--brand);font-weight:600">
                  <i class="fas fa-lightbulb"></i> {{ a.reason }}
                </p>
              </div>
            </template>
          </div>

          <div v-if="cloudMatches.length" class="cf-card" style="border-radius:1.25rem;padding:1.5rem">
            <h2 style="font-size:1rem;font-weight:700;color:var(--text-strong);margin-bottom:.6rem">
              <i class="fas fa-cloud"></i> Also found on other devices
            </h2>
            <p style="font-size:.78rem;color:var(--text);margin-bottom:.75rem">Paid-tier cross-device search — informational only; open the record on its own device to edit it.</p>
            <div v-for="rec in cloudMatches" :key="rec.id" style="padding:.5rem 0;border-top:1px solid var(--border);font-size:.85rem;color:var(--text-strong)">
              {{ rec.resource?.name?.text || rec.resource?.name?.given || rec.id }}
            </div>
          </div>
        </template>

        <!-- ── Data Page: capture/edit ── -->
        <template v-else>
          <span class="eyebrow">Data Page</span>
          <h1 style="font-size:1.75rem;font-weight:800;color:var(--text-strong);margin-bottom:1.25rem">
            {{ activeRecordId === 'new' ? 'Register a new patient' : 'Edit patient' }}
          </h1>
          <div class="cf-card" style="border-radius:1.25rem;padding:1.5rem;margin-bottom:1.25rem">
            <PatientBasicsHost ref="formHost" :record="editingRecord" />
          </div>
          <div style="display:flex;gap:.75rem">
            <button class="btn btn-brand" :disabled="saving" @click="savePatient()">
              <i class="fas" :class="saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i> Save
            </button>
            <button class="btn-outline" @click="backToDirectory()">Cancel</button>
          </div>
        </template>

      </div>
    </main>
  </div>

  <Cubo category="patient-directory" page-context="Patient directory — find, register and check ABHA/conformance status for a patient." />
</template>

<style scoped>
/* Same self-contained design-system tokens ClinicHome.vue/PractitionerHome.vue's own style
   blocks define — this page needs to render correctly reached directly from staff nav, not
   depend on another page's chunk having loaded first. */
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
.eyebrow { color:var(--brand); font-weight:700; font-size:.78rem; text-transform:uppercase; letter-spacing:.05em; display:block; margin-bottom:.4rem; }
.record-row { border-radius:.85rem; padding:.9rem 1.1rem; cursor:pointer; transition:border-color .15s; border:1px solid var(--border); }
.record-row.active { border-color:var(--brand); }
</style>
