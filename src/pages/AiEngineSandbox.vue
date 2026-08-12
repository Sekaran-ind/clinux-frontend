<script setup>
// Extracted from the former standalone AiEngine.vue as part of merging it into Designer.vue (see
// clinux-ai-engine-designer-merge-tanstack-table memory note) — this component owns everything
// AiEngine.vue did EXCEPT its custom nav bar, its height:100vh viewport-lock shell, and the
// <Cubo> mount itself: those are now the parent (Designer.vue)'s job, since the whole point of
// the merge is one shared left-Cubo/right-content layout instead of two separate pages each
// with their own. classifyAndExecute() is exposed so Designer.vue's single Cubo instance can
// forward its cubo-api-submit emit into this component regardless of which tab is active.
//
// Confirmed with the user when this merge was planned: this stays a fully isolated sandbox
// (own TanStack DB collections, own aiEngineNlp.js demo) — NOT migrated onto the real
// formData/system-patient-profile-v1 records Front Desk uses, and NOT the shared
// formSlotEngine.js. Nothing here can affect real patient data.
import { computed, defineExpose, nextTick, onMounted, reactive, ref } from 'vue';
import { useLiveQuery } from '@tanstack/vue-db';
import { debounce } from '@tanstack/pacer';
import { AgGridVue } from 'ag-grid-vue3';
import { themeQuartz } from 'ag-grid-community';
import GridAvatarNameCell from '../components/grid/GridAvatarNameCell.vue';
import GridBadgeCell from '../components/grid/GridBadgeCell.vue';
import GridActionsCell from '../components/grid/GridActionsCell.vue';
import { useCuboStore } from '../stores/cubo.js';
import { getAnswer } from '../data/collections/formData.js';
import { aiEnginePatients } from '../data/collections/aiEnginePatients.js';
import { aiEngineStaff } from '../data/collections/aiEngineStaff.js';
import { aiEngineEncounters } from '../data/collections/aiEngineEncounters.js';
import { classify, warmUp } from '../nlp/aiEngineNlp.js';

const cubo = useCuboStore();
const gridTheme = themeQuartz;
const defaultColDef = { resizable: true, sortable: true, filter: true };
const STAFF_ROLE_BADGE_CLASSES = { Doctor: 'badge-doctor', Nurse: 'badge-nurse', Administrator: 'badge-admin', 'Chief of Medicine': 'badge-doctor', Receptionist: 'badge-tech', Radiologist: 'badge-tech' };
const ENCOUNTER_STATUS_BADGE_CLASSES = { arrived: 'badge-arrived', 'in-progress': 'badge-in-progress', finished: 'badge-finished', cancelled: 'badge-cancelled' };

const accordion = reactive({ patients: true, staff: false, encounters: false });
const dbSearchInput = ref('');
const dbSearch = ref(''); // debounced mirror of dbSearchInput — see below
const toast = ref({ show: false, msg: '' });
let toastTimer = null;
const confirmDel = reactive({ show: false, message: '', action: () => {} });
const ready = ref(false); // true once nlp.js has finished training — TanStack DB collections are
// preloaded before app.mount() (see main.js), so there's no separate "DB ready" gate here.

// The search box re-filters 3 computed lists on every keystroke — debounce via the already-
// installed @tanstack/pacer (same package Cubo.vue's send-throttling uses) rather than adding a
// new dependency for this.
const debouncedSetSearch = debounce((v) => { dbSearch.value = v; }, { wait: 250 });
function onSearchInput(v) {
  dbSearchInput.value = v;
  debouncedSetSearch(v);
}

const modals = reactive({
  patient: { show: false, editing: false, form: {} },
  staff: { show: false, editing: false, form: {} },
  encounter: { show: false, editing: false, form: {} },
});

const { data: patientsData } = useLiveQuery((q) => q.from({ t: aiEnginePatients }));
const { data: staffData } = useLiveQuery((q) => q.from({ t: aiEngineStaff }));
const { data: encountersData } = useLiveQuery((q) => q.from({ t: aiEngineEncounters }));

const COLORS = ['#3B82F6', '#00D4B2', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#06B6D4', '#10B981', '#F97316', '#A855F7'];
function nextColor(arr) { return COLORS[arr.length % COLORS.length]; }
function newRecordId() { return 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7); }

// ─── FHIR QuestionnaireResponse construction/mutation (this component builds/patches these
// directly — there's no LhcFormHost drawer here, since the whole point is that Cübo's chat is
// the input surface, not a rendered form). ───
function buildQR(groupLinkId, stringFields, boolFields) {
  return buildQRMultiGroup([[groupLinkId, stringFields, boolFields]]);
}
function buildQRMultiGroup(groups) {
  return {
    resourceType: 'QuestionnaireResponse',
    status: 'completed',
    item: groups.map(([groupLinkId, stringFields, boolFields]) => {
      const items = [];
      Object.entries(stringFields || {}).forEach(([linkId, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          items.push({ linkId, answer: [{ valueString: String(value) }] });
        }
      });
      Object.entries(boolFields || {}).forEach(([linkId, value]) => {
        items.push({ linkId, answer: [{ valueBoolean: !!value }] });
      });
      return { linkId: groupLinkId, item: items };
    }),
  };
}
// Patches specific linkIds in place on an already-built QR (used for update_* intents, which
// only touch whichever fields the sentence actually mentioned). Falls back to appending onto the
// first group if a linkId genuinely isn't present yet.
function applyFieldUpdates(data, updates) {
  Object.entries(updates).forEach(([linkId, value]) => {
    let found = false;
    (data.item || []).forEach((group) => {
      (group.item || []).forEach((item) => {
        if (item.linkId === linkId) { item.answer = [{ valueString: String(value) }]; found = true; }
      });
    });
    if (!found && data.item && data.item[0]) {
      data.item[0].item = data.item[0].item || [];
      data.item[0].item.push({ linkId, answer: [{ valueString: String(value) }] });
    }
  });
}

function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3500);
}

onMounted(async () => {
  try {
    await warmUp();
    ready.value = true;
  } catch (e) {
    showToast(`nlp.js failed to load: ${e.message}`);
  }
});

/* ───────────────── CÜBO → NLP → TOOL PIPELINE ─────────────────
   Called by Designer.vue's onCuboSubmit (forwarded from its single <Cubo> mount's
   cubo-api-submit emit) — the user's message is already appended to the active Cübo thread by
   the time this runs. classifyAndExecute() is this component's actual "runCommand()": nlp.js
   picks the intent + enum entities, aiEngineNlp.js's regex extractors pick the free-text slots,
   executeIntent() runs the tool against the TanStack DB collections, and the result is posted
   back into the SAME Cübo thread as an assistant reply. */
async function classifyAndExecute(detail) {
  const prompt = ((detail && detail.prompt) || '').trim();
  if (!prompt || !ready.value) return;

  const result = await classify(prompt);
  const confident = result.intent && result.intent !== 'None' && result.score >= 0.35;

  if (!confident) {
    cubo.addCuboMessage('assistant', "I didn't catch a clear patient/staff/encounter action in that — try something like \"add patient Riya Singh, female\", \"add staff Dr. Kumar, doctor, cardiology\", or \"log encounter for Riya, chest pain\".");
    return;
  }

  let resultMsg;
  try {
    resultMsg = executeIntent(result.intent, result);
  } catch (e) {
    resultMsg = 'Could not complete that: ' + e.message;
  }
  cubo.addCuboMessage('assistant', resultMsg);
}
defineExpose({ classifyAndExecute });

function executeIntent(intent, r) {
  switch (intent) {
    case 'add_patient': {
      const name = r.name || 'Unknown';
      aiEnginePatients.insert({
        id: newRecordId(), formId: 'system-patient-profile-v1', version: 1,
        data: buildQR('section_patient', {
          patient_name: name, patient_gender: r.gender, patient_birthdate: r.birthdate,
        }),
        color: nextColor(aiEnginePatients.toArray),
        savedAt: new Date().toISOString(),
      });
      accordion.patients = true;
      return `Patient "${name}" registered.`;
    }
    case 'update_patient': {
      const rec = findPatientByName(r.name);
      if (!rec) throw new Error('Patient not found — try including their full name.');
      const updates = {};
      if (r.gender) updates.patient_gender = r.gender;
      if (r.birthdate) updates.patient_birthdate = r.birthdate;
      aiEnginePatients.update(rec.id, (draft) => applyFieldUpdates(draft.data, updates));
      return `Patient "${getAnswer(rec, 'patient_name')}" updated.`;
    }
    case 'delete_patient': {
      const rec = findPatientByName(r.name);
      if (!rec) throw new Error('Patient not found — try including their full name.');
      const name = getAnswer(rec, 'patient_name');
      aiEnginePatients.delete(rec.id);
      return `Patient "${name}" removed from the registry.`;
    }
    case 'add_staff': {
      const name = r.name || 'Unknown';
      aiEngineStaff.insert({
        id: newRecordId(), formId: 'system-staff-profile-v1', version: 1,
        data: buildQRMultiGroup([
          ['section_staff', { staff_name: name, staff_email: r.email, staff_phone: r.phone }, { staff_status: true }],
          ['section_staff_role', { staff_role: r.staffRole || 'Doctor', staff_specialty: r.specialty }],
        ]),
        color: nextColor(aiEngineStaff.toArray),
        savedAt: new Date().toISOString(),
      });
      accordion.staff = true;
      return `Staff "${name}" (${r.staffRole || 'Doctor'}) added to the care team.`;
    }
    case 'update_staff': {
      const rec = findStaffByName(r.name);
      if (!rec) throw new Error('Staff member not found — try including their full name.');
      const updates = {};
      if (r.staffRole) updates.staff_role = r.staffRole;
      if (r.specialty) updates.staff_specialty = r.specialty;
      aiEngineStaff.update(rec.id, (draft) => applyFieldUpdates(draft.data, updates));
      return `Staff "${getAnswer(rec, 'staff_name')}" updated.`;
    }
    case 'delete_staff': {
      const rec = findStaffByName(r.name);
      if (!rec) throw new Error('Staff member not found — try including their full name.');
      const name = getAnswer(rec, 'staff_name');
      aiEngineStaff.delete(rec.id);
      return `Staff "${name}" removed.`;
    }
    case 'add_encounter': {
      const patientRec = findPatientByName(r.name);
      if (!patientRec) throw new Error('Patient not found — add the patient first, then log the encounter.');
      aiEngineEncounters.insert({
        id: newRecordId(), formId: 'system-encounter-intake-v1', version: 1,
        data: buildQR('section_encounter', {
          encounter_patient_ref: patientRec.id,
          encounter_chief_complaint: r.chiefComplaint,
          encounter_status: r.encStatus || 'arrived',
          encounter_priority: r.priority || 'Normal',
        }),
        savedAt: new Date().toISOString(),
      });
      accordion.encounters = true;
      return `Encounter logged for "${getAnswer(patientRec, 'patient_name')}".`;
    }
    case 'update_encounter': {
      const patientRec = findPatientByName(r.name);
      if (!patientRec) throw new Error('Patient not found.');
      const rec = findLatestEncounterForPatient(patientRec.id);
      if (!rec) throw new Error(`No encounter found for "${getAnswer(patientRec, 'patient_name')}".`);
      const updates = {};
      if (r.encStatus) updates.encounter_status = r.encStatus;
      if (r.priority) updates.encounter_priority = r.priority;
      if (r.chiefComplaint) updates.encounter_chief_complaint = r.chiefComplaint;
      aiEngineEncounters.update(rec.id, (draft) => applyFieldUpdates(draft.data, updates));
      return `Encounter updated for "${getAnswer(patientRec, 'patient_name')}".`;
    }
    case 'delete_encounter': {
      const patientRec = findPatientByName(r.name);
      if (!patientRec) throw new Error('Patient not found.');
      const rec = findLatestEncounterForPatient(patientRec.id);
      if (!rec) throw new Error(`No encounter found for "${getAnswer(patientRec, 'patient_name')}".`);
      aiEngineEncounters.delete(rec.id);
      return `Encounter deleted for "${getAnswer(patientRec, 'patient_name')}".`;
    }
    default:
      throw new Error(`Unrecognized tool: ${intent}`);
  }
}

/* ───────────────── LOOKUPS ───────────────── */
function findPatientByName(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return aiEnginePatients.toArray.find((p) => (getAnswer(p, 'patient_name') || '').toLowerCase().includes(n));
}
function findStaffByName(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return aiEngineStaff.toArray.find((s) => (getAnswer(s, 'staff_name') || '').toLowerCase().includes(n));
}
function findLatestEncounterForPatient(patientId) {
  return aiEngineEncounters.toArray
    .filter((e) => getAnswer(e, 'encounter_patient_ref') === patientId)
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
    .pop();
}
function patientName(id) {
  const p = aiEnginePatients.get(id);
  return p ? getAnswer(p, 'patient_name') : 'Unknown patient';
}

/* ───────────────── FILTERED VIEWS ───────────────── */
const filteredPatients = computed(() => {
  const list = patientsData.value;
  if (!dbSearch.value) return list;
  const q = dbSearch.value.toLowerCase();
  return list.filter((p) =>
    (getAnswer(p, 'patient_name') || '').toLowerCase().includes(q) ||
    (getAnswer(p, 'patient_gender') || '').toLowerCase().includes(q) ||
    (getAnswer(p, 'patient_emergency_contact_name') || '').toLowerCase().includes(q));
});
const filteredStaff = computed(() => {
  const list = staffData.value;
  if (!dbSearch.value) return list;
  const q = dbSearch.value.toLowerCase();
  return list.filter((s) =>
    (getAnswer(s, 'staff_name') || '').toLowerCase().includes(q) ||
    (getAnswer(s, 'staff_role') || '').toLowerCase().includes(q) ||
    (getAnswer(s, 'staff_specialty') || '').toLowerCase().includes(q) ||
    (getAnswer(s, 'staff_email') || '').toLowerCase().includes(q));
});
const filteredEncounters = computed(() => {
  const list = encountersData.value;
  if (!dbSearch.value) return list;
  const q = dbSearch.value.toLowerCase();
  return list.filter((e) =>
    patientName(getAnswer(e, 'encounter_patient_ref')).toLowerCase().includes(q) ||
    (getAnswer(e, 'encounter_chief_complaint') || '').toLowerCase().includes(q) ||
    (getAnswer(e, 'encounter_status') || '').toLowerCase().includes(q));
});

/* ───────────────── AG Grid column defs — one valueGetter per column since every row is a bare
   FHIR QuestionnaireResponse-shaped record (getAnswer(row, linkId)), not a flat object AG Grid
   could just `field:` into directly. ───────────────── */
const patientColumnDefs = computed(() => [
  { headerName: 'Patient', valueGetter: (p) => getAnswer(p.data, 'patient_name'), cellRenderer: GridAvatarNameCell, flex: 1.2 },
  { headerName: 'Gender', valueGetter: (p) => getAnswer(p.data, 'patient_gender') || '—', flex: 0.7 },
  { headerName: 'Date of Birth', valueGetter: (p) => getAnswer(p.data, 'patient_birthdate') || '—', flex: 0.8 },
  { headerName: 'Emergency Contact', valueGetter: (p) => [getAnswer(p.data, 'patient_emergency_contact_name'), getAnswer(p.data, 'patient_emergency_contact_phone')].filter(Boolean).join(' · ') || '—', flex: 1.3 },
  { headerName: 'Actions', cellRenderer: GridActionsCell, cellRendererParams: { onEdit: openPatientModal, onDelete: (p) => askDelete('patient', p.id, getAnswer(p, 'patient_name')) }, flex: 0.7, sortable: false, filter: false },
]);

const staffColumnDefs = computed(() => [
  { headerName: 'Name', valueGetter: (p) => getAnswer(p.data, 'staff_name'), cellRenderer: GridAvatarNameCell, flex: 1.1 },
  { headerName: 'Role', valueGetter: (p) => getAnswer(p.data, 'staff_role'), cellRenderer: GridBadgeCell, cellRendererParams: { classMap: STAFF_ROLE_BADGE_CLASSES, fallbackClass: 'badge-tech' }, flex: 0.9 },
  { headerName: 'Specialty', valueGetter: (p) => getAnswer(p.data, 'staff_specialty') || '—', flex: 0.9 },
  { headerName: 'License', valueGetter: (p) => getAnswer(p.data, 'staff_license') || '—', flex: 0.8 },
  { headerName: 'Email / Phone', valueGetter: (p) => [getAnswer(p.data, 'staff_email'), getAnswer(p.data, 'staff_phone')].filter(Boolean).join(' · ') || '—', flex: 1.1 },
  { headerName: 'Status', valueGetter: (p) => (getAnswer(p.data, 'staff_status') === true ? 'Active' : 'Inactive'), cellRenderer: GridBadgeCell, cellRendererParams: { classMap: { Active: 'badge-active', Inactive: 'badge-inactive' } }, flex: 0.7 },
  { headerName: 'Actions', cellRenderer: GridActionsCell, cellRendererParams: { onEdit: openStaffModal, onDelete: (p) => askDelete('staff', p.id, getAnswer(p, 'staff_name')) }, flex: 0.7, sortable: false, filter: false },
]);

const encounterColumnDefs = computed(() => [
  { headerName: 'Patient', valueGetter: (p) => patientName(getAnswer(p.data, 'encounter_patient_ref')), flex: 1 },
  { headerName: 'Chief Complaint', valueGetter: (p) => getAnswer(p.data, 'encounter_chief_complaint') || '—', flex: 1.3 },
  { headerName: 'Status', valueGetter: (p) => getAnswer(p.data, 'encounter_status') || 'arrived', cellRenderer: GridBadgeCell, cellRendererParams: { classMap: ENCOUNTER_STATUS_BADGE_CLASSES, fallbackClass: 'badge-arrived' }, flex: 0.8 },
  { headerName: 'Priority', valueGetter: (p) => getAnswer(p.data, 'encounter_priority') || 'Normal', cellRenderer: GridBadgeCell, cellRendererParams: { classMap: { Emergency: 'badge-priority-emergency', Normal: 'badge-priority-normal' } }, flex: 0.7 },
  { headerName: 'Logged', valueGetter: (p) => new Date(p.data.savedAt).toLocaleString(), flex: 1 },
  { headerName: 'Actions', cellRenderer: GridActionsCell, cellRendererParams: { onEdit: openEncounterModal, onDelete: (p) => askDelete('encounter', p.id, 'this encounter') }, flex: 0.7, sortable: false, filter: false },
]);

/* ───────────────── MODALS (manual add/edit) ───────────────── */
function openPatientModal(p = null) {
  modals.patient.editing = !!p;
  modals.patient.form = p ? {
    id: p.id,
    patient_name: getAnswer(p, 'patient_name'),
    patient_gender: getAnswer(p, 'patient_gender'),
    patient_birthdate: getAnswer(p, 'patient_birthdate'),
    patient_emergency_contact_name: getAnswer(p, 'patient_emergency_contact_name'),
    patient_emergency_contact_phone: getAnswer(p, 'patient_emergency_contact_phone'),
  } : { patient_name: '', patient_gender: '', patient_birthdate: '', patient_emergency_contact_name: '', patient_emergency_contact_phone: '' };
  modals.patient.show = true;
}
function savePatient() {
  const f = modals.patient.form;
  const data = buildQR('section_patient', {
    patient_name: f.patient_name, patient_gender: f.patient_gender, patient_birthdate: f.patient_birthdate,
    patient_emergency_contact_name: f.patient_emergency_contact_name, patient_emergency_contact_phone: f.patient_emergency_contact_phone,
  });
  if (modals.patient.editing) {
    aiEnginePatients.update(f.id, (draft) => { draft.data = data; draft.savedAt = new Date().toISOString(); });
    showToast(`Patient "${f.patient_name}" updated`);
  } else {
    aiEnginePatients.insert({ id: newRecordId(), formId: 'system-patient-profile-v1', version: 1, data, color: nextColor(aiEnginePatients.toArray), savedAt: new Date().toISOString() });
    showToast(`Patient "${f.patient_name}" registered`);
  }
  modals.patient.show = false;
}

function openStaffModal(s = null) {
  modals.staff.editing = !!s;
  modals.staff.form = s ? {
    id: s.id,
    staff_name: getAnswer(s, 'staff_name'),
    staff_role: getAnswer(s, 'staff_role') || 'Doctor',
    staff_specialty: getAnswer(s, 'staff_specialty'),
    staff_phone: getAnswer(s, 'staff_phone'),
    staff_email: getAnswer(s, 'staff_email'),
    staff_license: getAnswer(s, 'staff_license'),
    staff_qualification: getAnswer(s, 'staff_qualification'),
    staff_status: getAnswer(s, 'staff_status') === true,
  } : { staff_name: '', staff_role: 'Doctor', staff_specialty: '', staff_phone: '', staff_email: '', staff_license: '', staff_qualification: '', staff_status: true };
  modals.staff.show = true;
}
function saveStaff() {
  const f = modals.staff.form;
  const data = buildQRMultiGroup([
    ['section_staff', { staff_name: f.staff_name, staff_phone: f.staff_phone, staff_email: f.staff_email, staff_qualification: f.staff_qualification, staff_license: f.staff_license }, { staff_status: !!f.staff_status }],
    ['section_staff_role', { staff_role: f.staff_role, staff_specialty: f.staff_specialty }],
  ]);
  if (modals.staff.editing) {
    aiEngineStaff.update(f.id, (draft) => { draft.data = data; draft.savedAt = new Date().toISOString(); });
    showToast(`Staff "${f.staff_name}" updated`);
  } else {
    aiEngineStaff.insert({ id: newRecordId(), formId: 'system-staff-profile-v1', version: 1, data, color: nextColor(aiEngineStaff.toArray), savedAt: new Date().toISOString() });
    showToast(`Staff "${f.staff_name}" added`);
  }
  modals.staff.show = false;
}

function openEncounterModal(e = null) {
  modals.encounter.editing = !!e;
  modals.encounter.form = e ? {
    id: e.id,
    encounter_patient_ref: getAnswer(e, 'encounter_patient_ref'),
    encounter_chief_complaint: getAnswer(e, 'encounter_chief_complaint'),
    encounter_status: getAnswer(e, 'encounter_status') || 'arrived',
    encounter_priority: getAnswer(e, 'encounter_priority') || 'Normal',
  } : { encounter_patient_ref: '', encounter_chief_complaint: '', encounter_status: 'arrived', encounter_priority: 'Normal' };
  modals.encounter.show = true;
}
function saveEncounter() {
  const f = modals.encounter.form;
  const data = buildQR('section_encounter', {
    encounter_patient_ref: f.encounter_patient_ref, encounter_chief_complaint: f.encounter_chief_complaint,
    encounter_status: f.encounter_status, encounter_priority: f.encounter_priority,
  });
  if (modals.encounter.editing) {
    aiEngineEncounters.update(f.id, (draft) => { draft.data = data; draft.savedAt = new Date().toISOString(); });
    showToast('Encounter updated');
  } else {
    aiEngineEncounters.insert({ id: newRecordId(), formId: 'system-encounter-intake-v1', version: 1, data, savedAt: new Date().toISOString() });
    showToast('Encounter logged');
  }
  modals.encounter.show = false;
}

/* ───────────────── CONFIRM DELETE ───────────────── */
function askDelete(type, id, label) {
  confirmDel.message = `Are you sure you want to permanently delete "${label}" from the ${type} registry? This cannot be undone.`;
  confirmDel.show = true;
  confirmDel.action = () => {
    if (type === 'patient') aiEnginePatients.delete(id);
    if (type === 'staff') aiEngineStaff.delete(id);
    if (type === 'encounter') aiEngineEncounters.delete(id);
    showToast(`"${label}" removed`);
  };
}
</script>

<template>
  <div class="ai-sandbox-root">
    <!-- ─────────────────── MODAL: Add/Edit Patient ─────────────────── -->
    <div class="modal-backdrop" v-show="modals.patient.show" @click.self="modals.patient.show = false">
      <div class="modal-box" @click.stop v-show="modals.patient.show">
        <h3 class="modal-title">
          <i class="fas fa-user-injured" style="color:var(--color-primary)"></i>
          <span>{{ modals.patient.editing ? 'Edit Patient Record' : 'Register New Patient' }}</span>
        </h3>
        <form @submit.prevent="savePatient()" style="display:flex;flex-direction:column;gap:0">
          <div class="modal-form-grid">
            <div class="modal-form-full">
              <label class="form-row-label">Full Name *</label>
              <input class="cf-input" v-model="modals.patient.form.patient_name" placeholder="Arjun Verma" required />
            </div>
            <div>
              <label class="form-row-label">Gender</label>
              <select class="cf-select" v-model="modals.patient.form.patient_gender">
                <option value="">Unknown</option>
                <option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
              </select>
            </div>
            <div>
              <label class="form-row-label">Date of Birth</label>
              <input class="cf-input" type="date" v-model="modals.patient.form.patient_birthdate" />
            </div>
            <div>
              <label class="form-row-label">Emergency Contact Name</label>
              <input class="cf-input" v-model="modals.patient.form.patient_emergency_contact_name" placeholder="Priya Verma" />
            </div>
            <div>
              <label class="form-row-label">Emergency Contact Phone</label>
              <input class="cf-input" v-model="modals.patient.form.patient_emergency_contact_phone" placeholder="+91 98765 43210" />
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-cancel" @click="modals.patient.show = false">Cancel</button>
            <button type="submit" class="btn-save"><i class="fas fa-save mr-1.5"></i>Save Patient</button>
          </div>
        </form>
      </div>
    </div>

    <!-- ─────────────────── MODAL: Add/Edit Staff ─────────────────── -->
    <div class="modal-backdrop" v-show="modals.staff.show" @click.self="modals.staff.show = false">
      <div class="modal-box" @click.stop v-show="modals.staff.show">
        <h3 class="modal-title">
          <i class="fas fa-user-md" style="color:var(--color-primary)"></i>
          <span>{{ modals.staff.editing ? 'Edit Staff Record' : 'Add Staff Member' }}</span>
        </h3>
        <form @submit.prevent="saveStaff()" style="display:flex;flex-direction:column;gap:0">
          <div class="modal-form-grid">
            <div class="modal-form-full">
              <label class="form-row-label">Full Name *</label>
              <input class="cf-input" v-model="modals.staff.form.staff_name" placeholder="Dr. Priya Menon" required />
            </div>
            <div>
              <label class="form-row-label">Role *</label>
              <select class="cf-select" v-model="modals.staff.form.staff_role" required>
                <option>Chief of Medicine</option><option>Doctor</option><option>Nurse</option><option>Administrator</option><option>Receptionist</option><option>Radiologist</option>
              </select>
            </div>
            <div>
              <label class="form-row-label">Specialty</label>
              <input class="cf-input" v-model="modals.staff.form.staff_specialty" placeholder="Cardiology" />
            </div>
            <div>
              <label class="form-row-label">Phone</label>
              <input class="cf-input" v-model="modals.staff.form.staff_phone" placeholder="+91 98765 43210" />
            </div>
            <div>
              <label class="form-row-label">Email</label>
              <input class="cf-input" type="email" v-model="modals.staff.form.staff_email" placeholder="priya@clinic.com" />
            </div>
            <div>
              <label class="form-row-label">License / Registration ID</label>
              <input class="cf-input" v-model="modals.staff.form.staff_license" placeholder="MCI-12345" />
            </div>
            <div>
              <label class="form-row-label">Qualification</label>
              <input class="cf-input" v-model="modals.staff.form.staff_qualification" placeholder="MD, DM Cardiology" />
            </div>
            <div style="display:flex;align-items:center;gap:.5rem;padding-top:1.4rem">
              <input type="checkbox" id="staffActiveCb" v-model="modals.staff.form.staff_status" style="width:16px;height:16px" />
              <label for="staffActiveCb" class="form-row-label" style="margin:0">Active</label>
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-cancel" @click="modals.staff.show = false">Cancel</button>
            <button type="submit" class="btn-save"><i class="fas fa-save mr-1.5"></i>Save Staff</button>
          </div>
        </form>
      </div>
    </div>

    <!-- ─────────────────── MODAL: Add/Edit Encounter ─────────────────── -->
    <div class="modal-backdrop" v-show="modals.encounter.show" @click.self="modals.encounter.show = false">
      <div class="modal-box" @click.stop v-show="modals.encounter.show">
        <h3 class="modal-title">
          <i class="fas fa-stethoscope" style="color:var(--color-primary)"></i>
          <span>{{ modals.encounter.editing ? 'Edit Encounter' : 'Log New Encounter' }}</span>
        </h3>
        <form @submit.prevent="saveEncounter()" style="display:flex;flex-direction:column;gap:0">
          <div class="modal-form-grid">
            <div class="modal-form-full">
              <label class="form-row-label">Patient *</label>
              <select class="cf-select" v-model="modals.encounter.form.encounter_patient_ref" required>
                <option value="">Select patient…</option>
                <option v-for="p in patientsData" :key="p.id" :value="p.id">{{ getAnswer(p, 'patient_name') }}</option>
              </select>
            </div>
            <div class="modal-form-full">
              <label class="form-row-label">Chief Complaint</label>
              <input class="cf-input" v-model="modals.encounter.form.encounter_chief_complaint" placeholder="Chest pain, shortness of breath…" />
            </div>
            <div>
              <label class="form-row-label">Status *</label>
              <select class="cf-select" v-model="modals.encounter.form.encounter_status" required>
                <option value="arrived">Arrived</option><option value="in-progress">In Progress</option><option value="finished">Finished</option><option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div>
              <label class="form-row-label">Triage Priority</label>
              <select class="cf-select" v-model="modals.encounter.form.encounter_priority">
                <option value="Normal">Normal</option><option value="Emergency">Emergency</option>
              </select>
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-cancel" @click="modals.encounter.show = false">Cancel</button>
            <button type="submit" class="btn-save"><i class="fas fa-save mr-1.5"></i>Save Encounter</button>
          </div>
        </form>
      </div>
    </div>

    <!-- ─────────────────── CONFIRM DELETE ─────────────────── -->
    <div class="modal-backdrop" v-show="confirmDel.show" @click.self="confirmDel.show = false">
      <div class="modal-box" @click.stop v-show="confirmDel.show" style="max-width:360px">
        <h3 class="modal-title"><i class="fas fa-exclamation-triangle" style="color:#EF4444"></i>Confirm Delete</h3>
        <p style="font-size:.88rem;color:var(--text);line-height:1.6">{{ confirmDel.message }}</p>
        <div class="modal-actions">
          <button class="btn-cancel" @click="confirmDel.show = false">Cancel</button>
          <button class="btn-save" style="background:#EF4444" @click="confirmDel.action(); confirmDel.show = false"><i class="fas fa-trash mr-1.5"></i>Delete</button>
        </div>
      </div>
    </div>

    <!-- ─────────────────── TOAST ─────────────────── -->
    <div class="cf-toast" v-show="toast.show">
      <i class="fas fa-check-circle" style="color:var(--color-primary)"></i>
      <span>{{ toast.msg }}</span>
    </div>

    <div class="right-panel-header">
      <div>
        <div class="panel-title">
          <div style="width:28px;height:28px;border-radius:.4rem;background:rgba(0,212,178,.12);display:flex;align-items:center;justify-content:center">
            <i class="fas fa-database" style="color:var(--color-primary);font-size:.75rem"></i>
          </div>
          Sandbox Data
        </div>
        <p class="panel-sub" style="margin-top:.15rem">Isolated demo storage — talk to Cübo or use the Add buttons below. Unrelated to real patient/staff/encounter records.</p>
      </div>
      <div class="db-toolbar">
        <div style="display:flex;align-items:center;gap:.4rem;padding:.25rem .625rem;border:1px solid var(--border);border-radius:99px;background:var(--bg-panel)">
          <div class="worker-status-dot" :class="ready ? 'ws-online' : 'ws-pending'"></div>
          <span style="font-size:.72rem;font-family:'JetBrains Mono',monospace;color:var(--text)">{{ ready ? 'Engine ready' : 'Loading…' }}</span>
        </div>
        <div class="search-bar" style="width:180px">
          <i class="fas fa-search"></i>
          <input class="cf-input" data-sandbox-search :value="dbSearchInput" @input="onSearchInput($event.target.value)" placeholder="Search all records…" />
        </div>
      </div>
    </div>

    <div class="right-panel-body">

      <!-- ── PATIENTS ACCORDION ── -->
      <div class="accord-section" :class="accordion.patients ? 'open' : ''">
        <div class="accord-header" @click="accordion.patients = !accordion.patients">
          <div style="display:flex;align-items:center;gap:.1rem">
            <div class="accord-icon" style="background:rgba(239,68,68,.1)"><i class="fas fa-user-injured" style="color:#EF4444"></i></div>
            <span class="accord-title">Patients</span>
            <span class="accord-count" style="margin-left:.5rem">{{ filteredPatients.length }}</span>
          </div>
          <div style="display:flex;align-items:center;gap:.625rem">
            <button class="btn-add" @click.stop="openPatientModal()" title="Add patient">
              <i class="fas fa-plus text-xs"></i>Add
            </button>
            <i class="fas fa-chevron-down accord-chevron"></i>
          </div>
        </div>
        <div class="accord-body" :class="accordion.patients ? 'show' : ''">
          <AgGridVue
            :theme="gridTheme" :rowData="filteredPatients" :columnDefs="patientColumnDefs" :defaultColDef="defaultColDef"
            pagination :paginationPageSize="10" domLayout="autoHeight" :getRowId="(p) => p.data.id"
            overlayNoRowsTemplate="No patient records. Tell Cübo to add one, or click + Add above."
          />
        </div>
      </div>

      <!-- ── STAFF ACCORDION ── -->
      <div class="accord-section" :class="accordion.staff ? 'open' : ''">
        <div class="accord-header" @click="accordion.staff = !accordion.staff">
          <div style="display:flex;align-items:center;gap:.1rem">
            <div class="accord-icon" style="background:rgba(59,130,246,.1)"><i class="fas fa-user-md" style="color:#3B82F6"></i></div>
            <span class="accord-title">Care Team / Staff</span>
            <span class="accord-count" style="margin-left:.5rem">{{ filteredStaff.length }}</span>
          </div>
          <div style="display:flex;align-items:center;gap:.625rem">
            <button class="btn-add" @click.stop="openStaffModal()"><i class="fas fa-plus text-xs"></i>Add</button>
            <i class="fas fa-chevron-down accord-chevron"></i>
          </div>
        </div>
        <div class="accord-body" :class="accordion.staff ? 'show' : ''">
          <AgGridVue
            :theme="gridTheme" :rowData="filteredStaff" :columnDefs="staffColumnDefs" :defaultColDef="defaultColDef"
            pagination :paginationPageSize="10" domLayout="autoHeight" :getRowId="(p) => p.data.id"
            overlayNoRowsTemplate="No staff records yet."
          />
        </div>
      </div>

      <!-- ── ENCOUNTERS ACCORDION ── -->
      <div class="accord-section" :class="accordion.encounters ? 'open' : ''">
        <div class="accord-header" @click="accordion.encounters = !accordion.encounters">
          <div style="display:flex;align-items:center;gap:.1rem">
            <div class="accord-icon" style="background:rgba(139,92,246,.1)"><i class="fas fa-stethoscope" style="color:#8B5CF6"></i></div>
            <span class="accord-title">Encounters</span>
            <span class="accord-count" style="margin-left:.5rem">{{ filteredEncounters.length }}</span>
          </div>
          <div style="display:flex;align-items:center;gap:.625rem">
            <button class="btn-add" @click.stop="openEncounterModal()"><i class="fas fa-plus text-xs"></i>Log</button>
            <i class="fas fa-chevron-down accord-chevron"></i>
          </div>
        </div>
        <div class="accord-body" :class="accordion.encounters ? 'show' : ''">
          <AgGridVue
            :theme="gridTheme" :rowData="filteredEncounters" :columnDefs="encounterColumnDefs" :defaultColDef="defaultColDef"
            pagination :paginationPageSize="10" domLayout="autoHeight" :getRowId="(p) => p.data.id"
            overlayNoRowsTemplate="No encounters logged yet."
          />
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
/* Same self-contained token set AiEngine.vue had — kept as-is so every color/spacing value below
   still resolves; scoped to .ai-sandbox-root instead of :global(:root) now that this no longer
   owns the whole page (the merged Designer.vue page has its own tokens for its own chrome). */
.ai-sandbox-root {
  --color-primary: #00D4B2;
  --color-secondary: #0A2540;
  --bg: #FAFCFF;
  --bg-alt: #F0F4F9;
  --bg-panel: #E8EEF6;
  --bg-input: #FFFFFF;
  --text: #475569;
  --text-strong: #0A2540;
  --border: #CBD5E1;
  --border-soft: #E2E8F0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
:global(.dark) .ai-sandbox-root {
  --bg: #080F1C;
  --bg-alt: #0D1A2E;
  --bg-panel: #0F2035;
  --bg-input: #091525;
  --text: #94A3B8;
  --text-strong: #E2E8F0;
  --border: #1E3A5F;
  --border-soft: #152840;
}

.panel-title { font-size:1rem;font-weight:700;color:var(--text-strong);font-family:'Poppins',sans-serif;display:flex;align-items:center;gap:.6rem; }
.panel-sub { font-size:.75rem;color:var(--text);margin-top:.2rem;line-height:1.4; }

.cf-input {
  width:100%;padding:.55rem .875rem;border-radius:.5rem;
  border:1.5px solid var(--border);background:var(--bg-input);
  color:var(--text-strong);font-size:.85rem;font-family:'Inter',sans-serif;
  outline:none;transition:border .15s,box-shadow .15s;
}
.cf-input:focus { border-color:var(--color-primary);box-shadow:0 0 0 3px rgba(0,212,178,.12); }
.cf-input::placeholder { color:var(--text);opacity:.6; }

.worker-status-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0; }
.ws-online { background:#22C55E; box-shadow:0 0 6px rgba(34,197,94,.5); }
.ws-pending { background:#F59E0B; animation:blink 1s infinite; }
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}

.right-panel-header { padding:0 0 .75rem; border-bottom:1px solid var(--border); flex-shrink:0; display:flex;align-items:center;justify-content:space-between; }
.right-panel-body { flex:1;overflow-y:auto;padding:.875rem 0; }

.accord-section { border:1px solid var(--border);border-radius:.875rem;overflow:hidden;margin-bottom:.75rem;transition:border .2s; }
.accord-section.open { border-color:var(--color-primary);box-shadow:0 0 0 1px rgba(0,212,178,.15); }
.accord-header { padding:.875rem 1.125rem;display:flex;align-items:center;justify-content:space-between; cursor:pointer;background:var(--bg-alt);user-select:none;transition:background .15s; }
.accord-header:hover { background:var(--bg-panel); }
.open .accord-header { background:var(--bg-panel); }
.accord-icon { width:32px;height:32px;border-radius:.5rem;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0; }
.accord-title { font-family:'Poppins',sans-serif;font-weight:700;font-size:.9rem;color:var(--text-strong);margin-left:.625rem; }
.accord-count { font-size:.7rem;font-weight:700;padding:.15rem .55rem;border-radius:99px;background:rgba(0,212,178,.15);color:var(--color-primary);font-family:'Poppins',sans-serif; }
.accord-chevron { font-size:.7rem;color:var(--text);transition:transform .25s; }
.open .accord-chevron { transform:rotate(180deg);color:var(--color-primary); }
.accord-body { display:none;border-top:1px solid var(--border); }
.accord-body.show { display:block; }

.muted { color:var(--text);font-size:.75rem; }
.td-name { font-weight:600;font-family:'Poppins',sans-serif; }

.row-actions { display:flex;gap:.35rem;align-items:center; }
.btn-row { padding:.25rem .55rem;border-radius:.375rem;border:1px solid transparent;cursor:pointer;font-size:.7rem;font-weight:600;font-family:'Poppins',sans-serif;transition:all .15s;white-space:nowrap;display:inline-flex;align-items:center;gap:.25rem; }
.btn-edit { border-color:var(--border);color:var(--text);background:transparent; }
.btn-edit:hover { border-color:var(--color-primary);color:var(--color-primary);background:rgba(0,212,178,.08); }
.btn-del { border-color:var(--border);color:var(--text);background:transparent; }
.btn-del:hover { border-color:#EF4444;color:#EF4444;background:rgba(239,68,68,.08); }

.empty-state { padding:2rem;text-align:center;color:var(--text); }
.empty-state i { display:block;font-size:2rem;color:var(--border);margin-bottom:.75rem; }
.empty-state p { font-size:.8rem;line-height:1.5; }

.form-row-label { font-size:.72rem;font-weight:600;color:var(--text-strong);font-family:'Poppins',sans-serif;margin-bottom:.2rem;display:block; }
.cf-select { width:100%;padding:.5rem .75rem;border-radius:.5rem;border:1.5px solid var(--border);background:var(--bg-input);color:var(--text-strong);font-size:.82rem;outline:none;font-family:'Inter',sans-serif; }
.cf-select:focus { border-color:var(--color-primary);box-shadow:0 0 0 3px rgba(0,212,178,.12); }
.btn-save { background:var(--color-secondary);color:#fff;font-family:'Poppins',sans-serif;font-weight:700;padding:.45rem 1rem;border-radius:.45rem;border:none;cursor:pointer;font-size:.8rem;transition:all .15s; }
.btn-save:hover { background:#0D2F52; }
:global(.dark) .btn-save { background:var(--color-primary);color:var(--color-secondary); }
.btn-cancel { background:transparent;border:1px solid var(--border);color:var(--text);font-family:'Poppins',sans-serif;font-weight:600;padding:.45rem 1rem;border-radius:.45rem;cursor:pointer;font-size:.8rem;transition:all .15s; }
.btn-cancel:hover { border-color:var(--color-primary);color:var(--color-primary); }
.btn-add { background:rgba(0,212,178,.12);color:var(--color-primary);font-family:'Poppins',sans-serif;font-weight:700;padding:.35rem .875rem;border-radius:.45rem;border:1px solid rgba(0,212,178,.3);cursor:pointer;font-size:.76rem;transition:all .15s;display:flex;align-items:center;gap:.35rem; }
.btn-add:hover { background:rgba(0,212,178,.2); }

.badge { display:inline-block;padding:.18rem .55rem;border-radius:99px;font-size:.67rem;font-weight:700;font-family:'Poppins',sans-serif;white-space:nowrap; }
.badge-doctor     { background:rgba(59,130,246,.12); color:#3B82F6;  border:1px solid rgba(59,130,246,.25); }
.badge-nurse      { background:rgba(139,92,246,.12); color:#8B5CF6;  border:1px solid rgba(139,92,246,.25); }
.badge-admin      { background:rgba(245,158,11,.12);color:#F59E0B;   border:1px solid rgba(245,158,11,.25); }
.badge-tech       { background:rgba(16,185,129,.12); color:#10B981;  border:1px solid rgba(16,185,129,.25); }
.badge-active     { background:rgba(34,197,94,.12);  color:#22C55E;  border:1px solid rgba(34,197,94,.25); }
.badge-inactive   { background:rgba(156,163,175,.12);color:#9CA3AF;  border:1px solid rgba(156,163,175,.25); }
.badge-arrived     { background:rgba(59,130,246,.12); color:#3B82F6;  border:1px solid rgba(59,130,246,.25); }
.badge-in-progress { background:rgba(245,158,11,.12); color:#F59E0B;  border:1px solid rgba(245,158,11,.25); }
.badge-finished    { background:rgba(34,197,94,.12);  color:#22C55E;  border:1px solid rgba(34,197,94,.25); }
.badge-cancelled   { background:rgba(239,68,68,.12);  color:#EF4444;  border:1px solid rgba(239,68,68,.25); }
.badge-priority-normal    { background:rgba(0,212,178,.12); color:var(--color-primary); border:1px solid rgba(0,212,178,.25); }
.badge-priority-emergency { background:rgba(239,68,68,.12); color:#EF4444; border:1px solid rgba(239,68,68,.25); }

.modal-backdrop { position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(5px);z-index:50;display:flex;align-items:center;justify-content:center;padding:1rem; }
.modal-box { background:var(--bg);border:1px solid var(--border);border-radius:1.125rem;padding:1.75rem;width:100%;max-width:480px;max-height:88vh;overflow-y:auto;box-shadow:0 30px 60px rgba(0,0,0,.3); }
.modal-title { font-family:'Poppins',sans-serif;font-weight:700;font-size:1.05rem;color:var(--text-strong);margin-bottom:1.25rem;display:flex;align-items:center;gap:.5rem; }
.modal-form-grid { display:grid;grid-template-columns:1fr 1fr;gap:.75rem; }
.modal-form-full { grid-column:1/-1; }
.modal-actions { display:flex;gap:.625rem;justify-content:flex-end;margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--border); }

.cf-toast { position:fixed;bottom:1.5rem;right:1.5rem;z-index:99;padding:.75rem 1.25rem;border-radius:.75rem;background:var(--color-secondary);color:#fff;font-family:'Poppins',sans-serif;font-weight:600;font-size:.85rem;box-shadow:0 10px 30px rgba(0,0,0,.3);display:flex;align-items:center;gap:.5rem; }
:global(.dark) .cf-toast { background:#0D2442;border:1px solid var(--color-primary); }

.db-toolbar { display:flex;align-items:center;gap:.5rem; }
.avatar { width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:.65rem;flex-shrink:0;font-family:'Poppins',sans-serif; }
.search-bar { position:relative; }
.search-bar input { padding-left:2rem;font-size:.78rem; }
.search-bar i { position:absolute;left:.65rem;top:50%;transform:translateY(-50%);font-size:.72rem;color:var(--text);pointer-events:none; }
</style>
