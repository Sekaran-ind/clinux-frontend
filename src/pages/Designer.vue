<script setup>
// Ported from clinixflow's public/designer.html — the "Room Architect" workspace: a two-step
// Compile & Preview / Training the Form designer plus a Forms Library sidebar and Data Explorer,
// all built around the same YAML -> FHIR Questionnaire compiler and SystemForms LForms glue every
// other page uses. Unlike the other pages, this one kept ALL its state in one big inline Alpine
// x-data object with no Alpine.store dependency beyond 'theme' — ported the same way, as page-
// local state, since nothing here is needed by any other page.
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import ace from 'ace-builds/src-noconflict/ace';
import 'ace-builds/src-noconflict/mode-yaml';
import 'ace-builds/src-noconflict/theme-tomorrow';
import 'ace-builds/src-noconflict/theme-tomorrow_night';
import { tinykeys } from 'tinykeys';
import { debounce } from '@tanstack/pacer';
import { AgGridVue } from 'ag-grid-vue3';
import { themeQuartz } from 'ag-grid-community';
import GridActionsCell from '../components/grid/GridActionsCell.vue';
import Cubo from '../components/Cubo.vue';
import {
  formData, formsLibrary, seedSystemForms, activeVersionNumber, activeQuestionnaire, SYSTEM_FORM_IDS,
  listDataRecords, saveDataRecord, deleteDataRecord, recordSummary,
  getAnswer, getGroupInstances,
  renderBlank, renderWithRecord, extractResponse,
} from '../data/useSystemForms.js';
import { flowsLibrary, seedSystemFlows, activePlanDefinition } from '../data/collections/flowsLibrary.js';
import { rolesForRoom, setRolesForRoom } from '../data/collections/roomSettings.js';
import { ROOM_DEFINITIONS, roomFlowId } from '../workflow/rooms.js';
import { useThemeStore } from '../stores/theme.js';
import { useAuthStore } from '../stores/auth.js';
import { useCuboStore } from '../stores/cubo.js';
import { useOnboardingStore } from '../stores/onboarding.js';
import { API_BASE, apiFetch } from '../config.js';

// The 4 real account roles (migrations/0008_add_account_role.sql — same set entryPlanDefinition.js's
// own `roles` fields and ROOM_DEFINITIONS' defaultRoles already use) — the checklist a room's Roles
// editor offers. Kept here, not re-derived from anywhere, since there's no single existing export
// of "every real role" anywhere else in the codebase to import instead.
const ACCOUNT_ROLES = ['hospital_admin', 'health_professional', 'admin_and_health_professional'];

const router = useRouter();
const theme = useThemeStore();
const auth = useAuthStore();
const cubo = useCuboStore();
// The 8 Provider-composition entity cards below (Hospital/Staff/Administrators/Services/Hours/
// Consents/Branches/Appointments) read and write the ONE shared Provider record the same way
// Onboarding.vue's own journeyCards do — see clinux-provider-composition-merge memory note.
const onboarding = useOnboardingStore();
// UPDATE — Cübo is now a floating FAB here instead of an always-EXPANDED left pane (explicit
// instruction, once Rooms/Design & Compile Room needed the full page width). No currentLayout
// override at all — same as AiEngine.vue, this relies on the store's own real default ('FAB').

// SPEC-19 (docs/SPEC-19-LOCAL-FIRST-LOCAL-SERVER-AND-FEDERATED-MODES.md) §12's AI Engine +
// Sandbox redesign: split back out into its own standalone page (src/pages/AiEngine.vue), per
// explicit instruction — no shared tab/Cübo-instance/ref-forwarding dependency between the two
// pages anymore, reversing the earlier AI Engine+Designer merge (clinux-ai-engine-designer-merge-
// tanstack-table memory note). This file is Forms Library only now.
//
// Forms Library holds the real Provider-composition data, so this route now requires auth (see
// the router) — Sandbox Data's own "safe for anyone to reach" case moved to /ai-engine with it.

// SPEC-22 §5.8's Room-Architect redesign — the landing view is now the 5 Rooms, not raw forms.
// 'rooms' (new default landing — Provider/Facility/Patient/Encounter/Account, see rooms.js) |
// 'room' (drilled into one room's own entity cards — what 'cards' used to show ungrouped; see
// clinux-settings-page-entity-cards memory note for that view's own original design) | 'table'
// (drilled into one card's records/instances) | 'designer' (a single form/group's own Compile &
// Preview / Training session, reached via a card's context menu) | 'room-designer' (a ROOM's own
// Design & Compile Room / Forms Authoring session — a DIFFERENT YAML entirely: the room's
// workflow-definition plan, not any one form's data-capture composition).
const currentView = ref('rooms');
// The card currently drilled into (table/designer view) — null while on a room's card grid itself.
const activeCard = ref(null);
// The room currently drilled into ('room'/'room-designer' views) — null while on the rooms grid.
const activeRoom = ref(null);
const currentStep = ref(0);
const steps = [
  { id: 'compile', label: 'Compile & Preview' },
  { id: 'train', label: 'Training the Form' },
];
// The room-designer's own 2-step session — deliberately separate from `steps`/`currentStep` above
// (a room's workflow-definition YAML and a form's data-capture YAML are different documents, and
// step 2 here is "Forms Authoring", not keyword training, so sharing state risked one view's
// leftover data bleeding into the other's rendering).
const roomStep = ref(0);
const roomSteps = [
  { id: 'compile', label: 'Design & Compile Room' },
  { id: 'forms', label: 'Forms Authoring' },
];

// ─── Room-Architect: Design & Compile Room / Forms Authoring (SPEC-22 §5.8/§5.11) ───
// Mirrors yamlInput/blueprintJson's own shape below, deliberately kept separate — a room's
// workflow-definition YAML compiles into an AUTHORING FORM (a Questionnaire describing
// PlanDefinition steps), not a data-capture form, and its own compiled preview needs a SEPARATE
// container id (roomAuthoringFormContainer) so it can't collide with a data-form preview open at
// the same time.
const roomYamlInput = ref('');
const roomBlueprintJson = ref(null); // the compiled AUTHORING FORM (Questionnaire), not the plan itself
const roomExtractedPlan = ref(null); // the real PlanDefinition, once Extract Plan has run
const roomExtractedWarnings = ref([]);
const roomSaveError = ref('');
const roomFlowExists = computed(() => {
  flowsLibraryVersion.value;
  return !!activeRoom.value && flowsLibrary.has(roomFlowId(activeRoom.value));
});
// The room's currently-SAVED plan (flowsLibrary's own activeVersion, via activePlanDefinition) —
// what "Forms Authoring from this Room" walks. Distinct from roomExtractedPlan (a fresh, not-yet-
// saved Compile & Extract result still sitting in the room-designer's own step 1) on purpose:
// Forms Authoring should reflect what's actually durable, not an in-progress edit.
const roomSavedPlanDefinition = computed(() => {
  flowsLibraryVersion.value;
  return activeRoom.value ? activePlanDefinition(roomFlowId(activeRoom.value)) : null;
});
// For each of the room's real saved actions: which existing card (if any) already renders it —
// matched on groupLinkId (Provider-style group cards) or formId (standalone forms), scoped to
// THIS room only. Honest "Not yet linked" when nothing matches, rather than guessing.
const roomActionLinks = computed(() => {
  const plan = roomSavedPlanDefinition.value;
  if (!plan || !activeRoom.value) return [];
  const cards = cardsForRoom(activeRoom.value.roomId);
  return (plan.action || []).map((action) => ({
    action,
    card: cards.find((c) => c.groupLinkId === action.id || c.formId === action.id) || null,
  }));
});
// Whether activeRoom's saved plan is actually connected to a LIVE Pinia/workflowRuntime store —
// a real, honest distinction, not a formality: saving a plan for any room updates flowsLibrary (so
// it survives, and Forms Authoring can read it), but nothing reads a room's flowId into a running
// actor. UPDATE — this used to list 'facility' (hospitalSetupWorkflow.js read its flowId into a
// live checklist actor); that store was retired along with the whole in-Cübo Hospital Setup
// checklist — "for 3 onboarding journeys no plan definition or workflow is required, state
// machine will be used only for clinical journeys" (explicit instruction). Facility/Provider/
// Patient are real page routes now with no PlanDefinition involvement at all, by design, not a
// gap — this stays empty for them. A future Encounter/clinical-journey room is the real candidate
// to ever populate this again.
const ROOM_RUNTIME_WIRED = [];

const yamlInput = ref('');
const blueprintJson = ref(null);
const gbnfRules = ref('');
const terminologyLogs = ref([]);
const savedVersionLabel = ref('');
const keywordInputs = reactive({});
const libraryShowArchived = ref(false);
const libraryExpanded = reactive({});
const formSearchInput = ref('');
const formSearchQuery = ref(''); // debounced mirror of formSearchInput, via @tanstack/pacer
const debouncedSetFormSearch = debounce((v) => { formSearchQuery.value = v; }, { wait: 250 });
function onFormSearchInput(v) {
  formSearchInput.value = v;
  debouncedSetFormSearch(v);
}
const accordionOpen = reactive({ results: false, compileDetails: false });
const openMenuFormId = ref(null);
const previewDrawerOpen = ref(false);
const saveAsMenuOpen = ref(false);
const activeDataRecordId = ref(null);
const currentVersionNumber = ref(null);
// Captured once via the '+ New Form' drawer for a brand-new (zero-version) form and consumed by
// saveToLibrary()'s very first save, since the library's own version counter otherwise always
// starts a new formId at v1 — see confirmNewForm()/saveToLibrary().
const pendingStartVersion = ref(null);
// Same "capture at New Form time, consume at first-save time" pattern pendingStartVersion already
// established — roomId lives on the formsLibrary ROW (see newFormDraft's own comment), which only
// actually gets created in saveToLibrary(), a separate step from confirmNewForm() below.
const pendingRoomId = ref('');
const newFormDrawerOpen = ref(false);
// journey: '' | 'patient' | 'hospital' — see clinux-custom-forms-in-patient-hospital-journeys
// memory note. Written into the generated YAML template's own journey: line, same field
// clinuxflow-api's compiler now passes through onto the compiled Questionnaire. roomId (SPEC-22
// §5.8, new, generalizes the same underlying idea past journey's original 2 values) is stored on
// the formsLibrary ROW instead (not the YAML/Questionnaire — a room association is an authoring/
// organizational fact, not clinical data the compiled form itself needs to carry) — see
// confirmNewForm()'s own save call. Kept alongside journey rather than replacing it: journey
// already drives real, shipped behavior (journeyFormIds(), Front Desk's Additional Forms step)
// that a rename would risk breaking; roomId is derived FROM journey below for the 2 values that
// overlap, so existing custom forms don't need a manual re-tag to gain SOME roomId coverage.
const newFormDraft = reactive({ formId: 'new-form-v1', title: 'New Form', version: 1, journey: '', roomId: '' });
const JOURNEY_TO_ROOM = { patient: 'patient', hospital: 'facility' };

const dataSaveLabel = ref('');
const toast = ref({ show: false, msg: '' });
let toastTimer = null;
function showToast(msg) {
  toast.value = { show: true, msg };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value.show = false), 3200);
}

// Bumped on every write to the formsLibrary/formData collections. Plain collection reads
// (.toArray/.get) aren't Vue-reactive on their own — same dataVersion idiom every other page
// uses for its own TanStack DB collections.
const libraryVersion = ref(0);
const dataVersion = ref(0);
// Same idiom, for flowsLibrary/roomSettings — bumped by saveRoomPlan() and the room Roles editor.
const flowsLibraryVersion = ref(0);
// ALSO bumped by any formData change from ANY origin, not just this page's own explicit saves --
// see onboarding.js's identical wiring for the full story (shared-server sync merges happen in
// the background on their own timer, with nothing else in the app aware unless it subscribes).
formData.subscribeChanges(() => { dataVersion.value++; });

const voiceTranscriptInput = ref('Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet lisinopril 10mg.');
const llmResponseOutput = ref(null);
const localExtractedFhirGraph = ref(null);

onMounted(async () => {
  const changed = await seedSystemForms(API_BASE).catch(() => false);
  if (changed) libraryVersion.value++;
  // Same seed-once, tolerate-a-missing-backend convention as seedSystemForms above — redundant
  // with main.js's own app-boot call (that one's fire-and-forget; this await gives THIS page a
  // real signal, via roomFlowExists, of whether a room's flow has loaded before it renders).
  await seedSystemFlows(API_BASE).catch(() => false);

  const res = await apiFetch(`${API_BASE}/api/workflow/default-blueprint`).then((r) => r.json()).catch(() => ({ success: false }));
  if (res.success) {
    yamlInput.value = res.yaml;
    await compileWorkflow(false);
  }
});

// ─── Ace Editor ───
// yamlInput stays the single source of truth — Ace's own change event writes into it, and a
// watch() pushes any *externally*-driven change (new-form scaffold, loading a saved version,
// syncKeywordsIntoYaml()) back into the editor. Comparing values before each write is what keeps
// that from looping back on itself.
const aceYamlEditorEl = ref(null);
let aceEditor = null;

onMounted(() => {
  aceEditor = ace.edit(aceYamlEditorEl.value, {
    mode: 'ace/mode/yaml',
    theme: theme.isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/tomorrow',
    fontSize: '13px',
    tabSize: 2,
    useSoftTabs: true,
    useWorker: false, // no bundled yaml worker for live-lint squiggles
    showPrintMargin: false,
  });
  aceEditor.setValue(yamlInput.value || '', -1); // -1: cursor at document start, not select-all

  aceEditor.session.on('change', () => {
    const val = aceEditor.getValue();
    if (val !== yamlInput.value) yamlInput.value = val;
  });

  const resizeHandler = () => aceEditor.resize();
  window.addEventListener('resize', resizeHandler);
  onUnmounted(() => window.removeEventListener('resize', resizeHandler));
});

watch(yamlInput, (val) => {
  if (aceEditor && aceEditor.getValue() !== val) aceEditor.setValue(val ?? '', -1);
});
watch(() => theme.isDark, (isDark) => {
  if (aceEditor) aceEditor.setTheme(isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/tomorrow');
});

// ─── Room-Designer's own Ace Editor instance ───
// A SECOND, separate ace.edit() instance rather than re-pointing the one above at roomYamlInput —
// a room's workflow-definition YAML and a form's data-capture YAML are different documents that
// can legitimately be open in two different browser tabs' worth of navigation state at once
// (openCardDesigner vs. openRoomDesigner don't clear each other's state); sharing one editor
// instance risked one view's content flashing into the other's on a fast switch.
const roomAceYamlEditorEl = ref(null);
let roomAceEditor = null;

onMounted(() => {
  roomAceEditor = ace.edit(roomAceYamlEditorEl.value, {
    mode: 'ace/mode/yaml',
    theme: theme.isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/tomorrow',
    fontSize: '13px',
    tabSize: 2,
    useSoftTabs: true,
    useWorker: false,
    showPrintMargin: false,
  });
  roomAceEditor.setValue(roomYamlInput.value || '', -1);

  roomAceEditor.session.on('change', () => {
    const val = roomAceEditor.getValue();
    if (val !== roomYamlInput.value) roomYamlInput.value = val;
  });

  const resizeHandler = () => roomAceEditor.resize();
  window.addEventListener('resize', resizeHandler);
  onUnmounted(() => window.removeEventListener('resize', resizeHandler));
});

watch(roomYamlInput, (val) => {
  if (roomAceEditor && roomAceEditor.getValue() !== val) roomAceEditor.setValue(val ?? '', -1);
});
watch(() => theme.isDark, (isDark) => {
  if (roomAceEditor) roomAceEditor.setTheme(isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/tomorrow');
});

// openDrawer:false is used only by the silent on-mount preload below — the card grid is now the
// landing view (see clinux-settings-page-entity-cards memory note), so auto-opening the preview
// drawer over it on every load would cover the very thing the user is meant to land on. Every
// other caller (the Compile button, Trigger Scribe) still wants the drawer to open as before.
async function compileWorkflow(openDrawer = true) {
  // A fresh compile means the previewed form may have changed since the last save.
  savedVersionLabel.value = '';

  const res = await apiFetch(`${API_BASE}/api/workflow/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yamlPayload: yamlInput.value }),
  }).then((r) => r.json());

  if (res.success) {
    blueprintJson.value = res.questionnaireJson;
    gbnfRules.value = res.finalGbnf;
    terminologyLogs.value = res.terminologyLogs;
    activeDataRecordId.value = null;
    // A fresh compile isn't any saved version yet — it only becomes one once Save to Library runs.
    currentVersionNumber.value = null;
    resetKeywordInputs();
    await nextTick();
    renderBlueprintPreview();
    if (openDrawer) previewDrawerOpen.value = true;
  } else {
    showToast('Compiler Error: ' + res.error);
  }
}

function closeDrawer() { previewDrawerOpen.value = false; }

function renderBlueprintPreview() {
  if (blueprintJson.value) renderBlank(blueprintJson.value, 'formContainer');
}

// ─── Room-Designer: Design & Compile Room / Forms Authoring (SPEC-22 §5.8/§5.11) ───
// Reuses the SAME real /api/workflow/compile endpoint compileWorkflow() above already uses —
// confirmed resourceType-agnostic before relying on that (Designer.vue's own long-standing
// design), so a workflow-definition YAML compiles through the identical, unmodified pipeline.
// What comes back is the room's AUTHORING FORM (a Questionnaire describing PlanDefinition steps),
// not the plan itself — see hospital-setup-workflow-response.js's own header comment (clinuxflow-api)
// for why extraction is a separate step from compilation for this kind of YAML specifically.
async function compileRoomWorkflow() {
  roomExtractedPlan.value = null;
  roomExtractedWarnings.value = [];
  roomSaveError.value = '';

  const res = await apiFetch(`${API_BASE}/api/workflow/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yamlPayload: roomYamlInput.value }),
  }).then((r) => r.json());

  if (res.success) {
    roomBlueprintJson.value = res.questionnaireJson;
    await nextTick();
    renderBlank(roomBlueprintJson.value, 'roomAuthoringFormContainer');
  } else {
    showToast('Compiler Error: ' + res.error);
  }
}

// The real missing link, made real: reads the authoring form the user just filled in (LForms,
// same extractResponse() every data-form save already uses) and sends it to the NEW
// POST /api/workflow/extract (clinuxflow-api's real ComprehensiveLocalExtractor, wrapped) — the
// first interactive caller of that extractor; every other caller (hospital-setup-workflow.test.js,
// build-system-flows.js) only ever ran it build-time/test-time against a hand-built response.
async function extractRoomPlan() {
  if (!roomBlueprintJson.value) return;
  roomSaveError.value = '';
  const responseJson = extractResponse('roomAuthoringFormContainer');
  if (!responseJson) {
    roomSaveError.value = 'Could not read the filled-in form. Please try again.';
    return;
  }

  const res = await apiFetch(`${API_BASE}/api/workflow/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionnaireJson: roomBlueprintJson.value, responseJson }),
  }).then((r) => r.json());

  if (!res.success) {
    roomSaveError.value = 'Extraction error: ' + res.error;
    return;
  }
  if (res.warnings && res.warnings.length) {
    roomExtractedWarnings.value = res.warnings;
  }
  const plan = res.resources.find((r) => r.resourceType === 'PlanDefinition');
  if (!plan) {
    roomSaveError.value = 'Extraction produced no PlanDefinition — check the filled-in steps.';
    return;
  }
  roomExtractedPlan.value = plan;
}

// Writes the extracted plan into flowsLibrary (a new version — same versions[] shape
// tools/build-system-flows.js's own output already uses, so a room saved here and a room seeded
// from the real backend catalog are indistinguishable to any reader). Real, stated honesty in the
// toast message: no room's flowId is read by a live runtime store today — see
// ROOM_RUNTIME_WIRED's own comment for why, and for which room type is the real future candidate.
function saveRoomPlan() {
  if (!activeRoom.value || !roomExtractedPlan.value) return;
  const flowId = roomFlowId(activeRoom.value);
  const existing = flowsLibrary.get(flowId);
  const nextVersion = existing ? (existing.versions[existing.versions.length - 1]?.version || 0) + 1 : 1;
  const versionEntry = {
    version: nextVersion, status: 'active',
    yaml: roomYamlInput.value, planDefinition: roomExtractedPlan.value,
    savedAt: new Date().toISOString(),
  };

  if (existing) {
    flowsLibrary.update(flowId, (draft) => {
      draft.versions.push(versionEntry);
      draft.activeVersion = nextVersion;
    });
  } else {
    flowsLibrary.insert({ flowId, isSystem: false, archived: false, activeVersion: nextVersion, versions: [versionEntry] });
  }

  flowsLibraryVersion.value++;
  const wired = ROOM_RUNTIME_WIRED.includes(activeRoom.value.roomId);
  showToast(wired
    ? `${activeRoom.value.title} plan saved — reload to pick it up in the running checklist.`
    : `${activeRoom.value.title} plan saved. Not wired to a live runtime by design — Facility/Provider/Patient are real pages, not PlanDefinition-driven.`);
  roomStep.value = 1; // jump to Forms Authoring so the newly-saved steps are immediately visible there
}

// ─── Forms Library maintenance (add / view / modify / archive — no deletion) ───

function formEntry(formId) {
  return formsLibrary.get(formId);
}

function formTitle(formId) {
  const entry = formEntry(formId);
  const latest = entry?.versions[entry.versions.length - 1];
  return latest?.questionnaire?.title || formId;
}

// Patient/Encounter are also their own compositions, but stay unsplit (one card apiece) — only
// Provider's sub-entities get the Onboarding.vue-style split (see PROVIDER_CARDS below and the
// clinux-settings-page-entity-cards memory note). Provider's own formId is excluded here (never
// reaches this function) so the hospital/staff/services/etc. substring checks below no longer
// apply to anything — trimmed to just what a non-Provider form can actually be.
function formIcon(formId) {
  if (formId.includes('patient')) return 'fas fa-user-injured';
  if (formId.includes('encounter')) return 'fas fa-clipboard-list';
  return 'fas fa-file-lines';
}

function matchesSearch(formId) {
  const q = formSearchQuery.value.trim().toLowerCase();
  if (!q) return true;
  return formTitle(formId).toLowerCase().includes(q) || formId.toLowerCase().includes(q);
}

// Provider composition's sub-entities, one card each — mirrors Onboarding.vue's journeyCards
// (same groupLinkIds), extended with Branches/Appointments (no onboarding card exists for those
// yet) and Administrators (a filtered view into Staff by role, not its own FHIR resource — see
// clinux-provider-composition-merge memory note). Fixed order/set, unlike the dynamic form cards
// below, since these always exist regardless of what's in the forms library.
//
// `roomId` (SPEC-22 §5.8) — Facility and Provider split the OLD single Provider-composition card
// grid apart, matching real ABDM HFR/HPR separation (user's own decision: "Services/Hours/Consent/
// Location are all part of the system-provider-composition-v1 yaml definition... only exception is
// Appointment which should be part of global action list"). Appointment stays tagged 'facility'
// here regardless — the underlying data YAML doesn't need splitting (a room's actions just
// reference section ids, they don't own the file), and the global-room relocation itself hasn't
// been implemented yet (see clinux-spec22-four-foundational-decisions memory note's §5.8 entry) —
// this reflects the real, currently-running shape, not the still-pending decision.
const PROVIDER_CARDS = [
  { id: 'hospital', kind: 'group', groupLinkId: 'section_hospital', mode: 'single', roomId: 'facility', icon: 'fas fa-hospital', color: '#3B82F6', bg: 'rgba(59,130,246,.1)', title: 'Hospital Profile', desc: 'Your clinic profile as a FHIR Organization resource.' },
  { id: 'staff', kind: 'group', groupLinkId: 'section_staff', mode: 'repeatable', roomId: 'provider', icon: 'fas fa-user-md', color: '#00D4B2', bg: 'rgba(0,212,178,.1)', title: 'Care Team', desc: 'Physicians, nurses and staff as FHIR Practitioner records.' },
  { id: 'admin', kind: 'group', groupLinkId: 'section_staff', mode: 'repeatable', roleFilter: 'Administrator', roomId: 'provider', icon: 'fas fa-user-shield', color: '#6366F1', bg: 'rgba(99,102,241,.1)', title: 'Administrators', desc: 'Staff members with the Administrator role.' },
  { id: 'services', kind: 'group', groupLinkId: 'section_services_matrix', mode: 'repeatable', roomId: 'facility', icon: 'fas fa-stethoscope', color: '#8B5CF6', bg: 'rgba(139,92,246,.1)', title: 'Services', desc: 'Services your clinic offers.' },
  { id: 'hours', kind: 'group', groupLinkId: 'section_hours', mode: 'repeatable', roomId: 'facility', icon: 'fas fa-clock', color: '#F59E0B', bg: 'rgba(245,158,11,.1)', title: 'Office Hours', desc: 'Operating hours, one day-range at a time.' },
  { id: 'consent', kind: 'group', groupLinkId: 'section_consent', mode: 'repeatable', roomId: 'facility', icon: 'fas fa-file-signature', color: '#EF4444', bg: 'rgba(239,68,68,.1)', title: 'Legal Consents', desc: 'Consent types your clinic collects from patients.' },
  { id: 'location', kind: 'group', groupLinkId: 'section_location', mode: 'repeatable', roomId: 'facility', icon: 'fas fa-map-marker-alt', color: '#14B8A6', bg: 'rgba(20,184,166,.1)', title: 'Branches', desc: 'Additional clinic locations.' },
  { id: 'appointment', kind: 'group', groupLinkId: 'section_appointment', mode: 'repeatable', roomId: 'facility', icon: 'fas fa-calendar-alt', color: '#EC4899', bg: 'rgba(236,72,153,.1)', title: 'Appointments', desc: 'Booked appointment records.' },
];

// System forms aren't tagged with a roomId in their own formsLibrary row (they're seeded verbatim
// from clinuxflow-api's system-forms-library.json, unmodified) — a small frontend-only lookup,
// same idiom formIcon() below already uses for a similar per-formId special case, rather than a
// backend/seed-data change for something purely organizational.
const SYSTEM_FORM_ROOM_MAP = {
  'system-patient-profile-v1': 'patient',
  'system-encounter-composition-v1': 'encounter',
};

// Every other form in the library — Patient/Encounter (unsplit) plus any custom/user-created
// forms — gets ONE card apiece, same single formId as the old sidebar row, just reached via a
// card now. Provider's own formId is excluded (replaced by the 8 PROVIDER_CARDS above).
function formLibraryCards() {
  libraryVersion.value;
  return formsLibrary.toArray
    .filter((r) => r.formId !== onboarding.PROVIDER_FORM_ID)
    .filter((r) => libraryShowArchived.value || !r.archived)
    .filter((r) => matchesSearch(r.formId))
    .map((r) => ({
      id: r.formId, kind: 'form', formId: r.formId, mode: 'form',
      icon: formIcon(r.formId), color: '#64748B', bg: 'rgba(100,116,139,.1)',
      title: formTitle(r.formId), desc: r.isSystem ? 'System form' : 'Custom form',
      isSystem: r.isSystem, archived: r.archived, bookmarked: r.bookmarked,
      // SPEC-22 §5.8 — SYSTEM_FORM_ROOM_MAP for the 2 unsplit system forms; a custom form's own
      // roomId (set via the '+ New Form' drawer, see newFormDraft/confirmNewForm) for everything
      // else. Undefined (not shown under any room) for an older custom form saved before this
      // field existed — real, honest, not backfilled with a guess.
      roomId: SYSTEM_FORM_ROOM_MAP[r.formId] || r.roomId,
    }))
    .sort((a, b) => {
      if (a.bookmarked !== b.bookmarked) return a.bookmarked ? -1 : 1;
      const aSys = SYSTEM_FORM_IDS.includes(a.formId), bSys = SYSTEM_FORM_IDS.includes(b.formId);
      if (aSys !== bSys) return aSys ? -1 : 1;
      if (aSys && bSys) return SYSTEM_FORM_IDS.indexOf(a.formId) - SYSTEM_FORM_IDS.indexOf(b.formId);
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      const eA = formEntry(a.formId), eB = formEntry(b.formId);
      const latestA = eA.versions[eA.versions.length - 1]?.savedAt || '';
      const latestB = eB.versions[eB.versions.length - 1]?.savedAt || '';
      return latestB.localeCompare(latestA);
    });
}

// Provider's 8 cards always come first (fixed order, always shown — filtered only by the search
// box, since Show Archived doesn't apply to them), then every other form card.
function allLibraryCards() {
  const q = formSearchQuery.value.trim().toLowerCase();
  const providerCards = q ? PROVIDER_CARDS.filter((c) => c.title.toLowerCase().includes(q)) : PROVIDER_CARDS;
  return [...providerCards, ...formLibraryCards()];
}

// SPEC-22 §5.8's Room-Architect redesign — every card, scoped to the ONE room currently open.
// Same "Provider cards first, then dynamic form cards" ordering allLibraryCards() already used,
// just filtered by roomId first. Real, honest gap surfaced by this filter, not hidden: an older
// custom form saved before roomId existed has roomId===undefined, so it matches NO room here —
// still reachable from its own room once re-saved/edited with a roomId, or (not built) a future
// bulk-tagging pass; not silently guessed at.
function cardsForRoom(roomId) {
  return allLibraryCards().filter((c) => c.roomId === roomId);
}

// Reads a Provider group card's current instances off the ONE shared record — same
// getGroupInstances() pattern every other post-merge page uses, with an optional role filter for
// the Administrators card.
function groupInstancesForCard(card) {
  dataVersion.value; onboarding.dataVersion;
  let instances = getGroupInstances(onboarding.getProviderRecord(), card.groupLinkId);
  if (card.roleFilter) instances = instances.filter((i) => getAnswer({ data: i }, 'staff_role') === card.roleFilter);
  return instances;
}

// recordSummary() expects a full { id, data: { item } } record — group instances are bare
// { linkId, item } objects with no id of their own, so wrap one the same way every other
// bare-instance read in this migration does (see formData.js's getGroupInstances doc comment).
function instanceSummary(instance, index) {
  return recordSummary({ data: instance, id: String(index) });
}

// Safe accessor for the version-list v-for below — v-show (unlike v-if) still evaluates its
// subtree's expressions even while hidden, so a group card's formId (always undefined — group
// cards have a groupLinkId, not a formId) would otherwise throw reading .versions off
// formEntry(undefined) every render, not just when actually expanded.
function versionsReversed(formId) {
  const entry = formEntry(formId);
  return entry ? [...entry.versions].reverse() : [];
}

// Same shape/null-safety as versionsReversed above, for a ROOM's own workflow-YAML versions
// (flowsLibrary, not formsLibrary) — the room-card context menu's "Show Versions" (SPEC-22 §5.12).
function flowVersionsReversed(room) {
  flowsLibraryVersion.value;
  if (!room) return [];
  const entry = flowsLibrary.get(roomFlowId(room));
  return entry ? [...entry.versions].reverse() : [];
}

function cardStatus(card) {
  if (card.kind === 'form') {
    dataVersion.value;
    const n = listDataRecords(card.formId).length;
    return n > 0 ? `${n} record${n === 1 ? '' : 's'}` : 'No records';
  }
  if (card.mode === 'single') {
    return getAnswer(onboarding.getProviderRecord(), 'hospital_name') ? 'Saved' : 'Not started';
  }
  const n = groupInstancesForCard(card).length;
  return n > 0 ? `${n} added` : 'Not started';
}

function toggleAccordion(key) { accordionOpen[key] = !accordionOpen[key]; }
function toggleExpand(formId) { libraryExpanded[formId] = !libraryExpanded[formId]; }
function toggleMenu(formId) { openMenuFormId.value = openMenuFormId.value === formId ? null : formId; }
function closeMenu() { openMenuFormId.value = null; }

// Vue has no built-in equivalent to Alpine's @click.outside — each context-menu toggle button
// already stops propagation (see toggleMenu() callers), so any click that reaches document is
// genuinely outside the menu; the Save As button does NOT stop propagation (matching the
// original), so its own click is excluded here via the .save-as-anchor wrapper instead, or the
// very same click that opens it would immediately close it again.
function closeMenusOnOutsideClick(e) {
  if (openMenuFormId.value !== null && !e.target.closest('.context-menu')) {
    openMenuFormId.value = null;
  }
  if (saveAsMenuOpen.value && !e.target.closest('.save-as-anchor')) {
    saveAsMenuOpen.value = false;
  }
}
onMounted(() => document.addEventListener('click', closeMenusOnOutsideClick));
onUnmounted(() => document.removeEventListener('click', closeMenusOnOutsideClick));

// Hotkeys — new pattern for this codebase (no prior hotkey library/convention existed anywhere
// in it, confirmed before adding tinykeys). Scoped to this merged page only, not app-wide.
function isTypingContext() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  if (el.closest && el.closest('.ace_editor')) return true;
  return false;
}
let unregisterHotkeys = null;
onMounted(() => {
  unregisterHotkeys = tinykeys(window, {
    '/': (e) => {
      if (isTypingContext()) return; // don't hijack '/' while typing anywhere else
      e.preventDefault();
      document.querySelector('.cubo-wrapper textarea')?.focus();
    },
    '$mod+KeyK': (e) => {
      e.preventDefault();
      document.querySelector('[data-library-search]')?.focus();
    },
    Escape: () => {
      if (previewDrawerOpen.value) previewDrawerOpen.value = false;
      else if (newFormDrawerOpen.value) newFormDrawerOpen.value = false;
    },
  });
});
onUnmounted(() => unregisterHotkeys?.());

function toggleBookmark(formId) {
  if (!formsLibrary.has(formId)) return;
  formsLibrary.update(formId, (draft) => { draft.bookmarked = !draft.bookmarked; });
  libraryVersion.value++;
}

// Archive is a visibility flag only — versions and data are never removed, so an archived form
// can always be restored or its history reviewed.
function toggleArchive(formId) {
  const entry = formEntry(formId);
  if (!entry || entry.isSystem) return;
  formsLibrary.update(formId, (draft) => { draft.archived = !draft.archived; });
  libraryVersion.value++;
}

// Load: opens a specific saved version's YAML in the Step 1 editor to view or edit it, without
// changing which version is the form's active one. Uses the questionnaire stored alongside this
// version (not a fresh recompile), so any trained keywords saved with it survive being reopened.
function loadVersionIntoEditor(formId, version) {
  const entry = formEntry(formId);
  const v = entry?.versions.find((x) => x.version === version);
  if (!v) return;
  // Loading an existing form/version means any not-yet-saved '+ New Form' starting version
  // capture (if the user abandoned that flow) no longer applies to anything.
  pendingStartVersion.value = null;

  yamlInput.value = v.yaml;
  blueprintJson.value = v.questionnaire;
  gbnfRules.value = '';
  terminologyLogs.value = [];
  savedVersionLabel.value = '';
  activeDataRecordId.value = null;
  currentVersionNumber.value = version;
  currentStep.value = 0;
  resetKeywordInputs();
  renderBlueprintPreview();
}

// A form card's own click opens straight into its Data Explorer table; Designer/YAML View is
// reached via that same card's context menu instead.
function openInDataExplorer(formId) {
  loadVersionIntoEditor(formId, activeVersionNumber(formId));
  currentView.value = 'table';
}

function openInDesigner(formId) {
  loadVersionIntoEditor(formId, activeVersionNumber(formId));
  currentView.value = 'designer';
}

// ─── Card grid: drill-in / back navigation (see clinux-settings-page-entity-cards memory note) ───

// Provider's 'single' cards (just Hospital today) have nothing to list — one card, one record —
// so clicking it opens the whole-document drawer directly, same as Onboarding.vue's own Hospital
// card. 'repeatable' Provider cards and every form card drill into a table view instead.
function openCard(card) {
  activeCard.value = card;
  if (card.kind === 'group' && card.mode === 'single') {
    openProviderDrawer(card);
    return;
  }
  if (card.kind === 'group') {
    currentView.value = 'table';
    return;
  }
  openInDataExplorer(card.formId);
}

// Every card's context-menu "Designer/YAML View" routes here — Provider's 8 cards all share the
// ONE underlying system-provider-composition-v1 form, so they all land on the same YAML/version.
function openCardDesigner(card) {
  activeCard.value = card;
  openInDesigner(card.kind === 'group' ? onboarding.PROVIDER_FORM_ID : card.formId);
}

function backToCards() {
  // Returns to the currently-open ROOM's own card grid (not all the way back to the Rooms
  // landing) — table/designer are always reached FROM a room now, so activeRoom is expected to
  // still be set; falling back to 'rooms' defensively is honest if it somehow isn't, not a normal
  // path.
  currentView.value = activeRoom.value ? 'room' : 'rooms';
  activeCard.value = null;
}

// ─── Rooms: drill-in / back navigation (SPEC-22 §5.8) ───

function openRoom(room) {
  activeRoom.value = room;
  currentView.value = 'room';
}

// ─── Rooms: role gating (SPEC-22 §5.8 — "we also need to design the roles who can be part of the
// Room so we will be able to load them in the runtime") ───
// Real, editable, persisted (roomSettings.js) — not the room CARD's own visibility on the Rooms
// grid (every room stays visible/reachable to the person authoring it here regardless of role
// gating; role gating is about which SIGNED-IN ACCOUNT ROLE a room is meant for at RUNTIME, e.g.
// entryPlanDefinition.js's own facility_registration/staff_registration actions — Designer itself
// is an authoring tool, not the gated surface).
// Null-safe on `room` — v-show (unlike v-if) still evaluates its subtree's expressions even while
// hidden (same real bug versionsReversed()'s own comment already documents for a different
// function), and these are called from template blocks gated on `activeRoom` being truthy, which
// is only true once the block is actually SHOWN, not before — a template call site with
// `activeRoom` still null at initial render would otherwise throw reading room.roomId.
function roomRoles(room) {
  flowsLibraryVersion.value; // roomSettings shares no version ref of its own yet — piggybacks on this one, bumped by any room-editing action
  if (!room) return [];
  return rolesForRoom(room.roomId) || [];
}
function isRoleChecked(room, role) {
  if (!room) return false;
  const roles = rolesForRoom(room.roomId);
  return !roles || roles.includes(role); // no roles saved yet = universal = every checkbox reads as checked
}
function toggleRoomRole(room, role) {
  if (!room) return;
  const current = rolesForRoom(room.roomId);
  // Universal (null) -> toggling ANY one role off means "everyone except that one", i.e. start
  // from the full real role set, not from an empty list (unchecking Nurse from "everyone" should
  // leave the OTHER 2 roles checked, not zero).
  const base = current || [...ACCOUNT_ROLES];
  const next = base.includes(role) ? base.filter((r) => r !== role) : [...base, role];
  setRolesForRoom(room.roomId, next);
  flowsLibraryVersion.value++;
}

function backToRooms() {
  currentView.value = 'rooms';
  activeRoom.value = null;
}

// Opens a room's OWN Design & Compile Room / Forms Authoring session — a different YAML entirely
// from a form/group's own data-capture composition (openCardDesigner above). Loads the room's
// currently-saved plan (flowsLibrary, via roomFlowId) into the room-designer's own Ace editor if
// one exists yet; otherwise seeds a blank workflow-definition scaffold, same "new form" spirit
// buildBlankFormTemplate() already uses for data forms. `version`, when given (the room-card
// context menu's "Load" — see flowVersionsReversed's own template usage), opens that SPECIFIC
// saved version rather than whichever one is currently active — same distinction
// loadVersionIntoEditor/setActiveVersion already draw for forms.
function openRoomDesigner(room, version = null) {
  activeRoom.value = room;
  currentView.value = 'room-designer';
  roomStep.value = 0;
  roomExtractedPlan.value = null;
  roomExtractedWarnings.value = [];
  roomSaveError.value = '';

  const flowId = roomFlowId(room);
  const entry = flowsLibrary.get(flowId);
  if (entry) {
    const targetVersion = version ?? (entry.activeVersion || entry.versions[entry.versions.length - 1]?.version);
    const v = entry.versions.find((x) => x.version === targetVersion);
    roomYamlInput.value = v?.yaml || '';
    roomBlueprintJson.value = null; // real compiled preview only appears after Compile is clicked again — the saved plan itself isn't the authoring-form Questionnaire
  } else {
    roomYamlInput.value = buildBlankRoomTemplate(flowId, room.title);
    roomBlueprintJson.value = null;
  }
  nextTick(() => { if (roomAceEditor) roomAceEditor.setValue(roomYamlInput.value || '', -1); });
}

// Room-card context menu's "Set Active" (SPEC-22 §5.12) — mirrors setActiveVersion's own real
// effect (which version's YAML/plan a room's "Design & Compile Room" opens to by default), for
// flowsLibrary instead of formsLibrary.
function setActiveRoomVersion(room, version) {
  const flowId = roomFlowId(room);
  if (!flowsLibrary.has(flowId)) return;
  flowsLibrary.update(flowId, (draft) => { draft.activeVersion = version; });
  flowsLibraryVersion.value++;
}

function backToRoom() {
  currentView.value = 'room';
}

// ─── Provider Entity Drawer — whole-document add/view/edit for the 8 Provider cards ───
// Separate from the Live Preview Slide-Over below (that one is blueprintJson/compile-driven);
// this one is onboarding-store-driven, mirroring Onboarding.vue's own drawer exactly, including
// the "whole accumulating document every time" tradeoff and LForms' native "+ Add another" for
// repeating instances instead of any custom add/remove UI.
const providerDrawerOpen = ref(false);
const providerDrawerQuestionnaire = ref(null);
const providerDrawerRecord = ref(null);

function openProviderDrawer(card) {
  activeCard.value = card;
  providerDrawerOpen.value = true;
  const q = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  providerDrawerQuestionnaire.value = q;
  if (!q) { providerDrawerRecord.value = null; return; }
  providerDrawerRecord.value = onboarding.getProviderRecord() || onboarding.buildSeedFromRegistration();
  nextTick(() => renderWithRecord(q, providerDrawerRecord.value, 'providerFormContainer'));
}

function closeProviderDrawer() { providerDrawerOpen.value = false; }

function saveProviderDrawerRecord() {
  const ok = onboarding.saveProviderRecord('providerFormContainer');
  if (!ok) { showToast('Could not read the entered data. Please try again.'); return; }
  if (activeCard.value?.mode === 'repeatable') {
    // Stay open — LForms' own "+ Add another" is how a second/third instance gets added, not a
    // separate save-per-entry action.
    providerDrawerRecord.value = onboarding.getProviderRecord();
    nextTick(() => renderWithRecord(providerDrawerQuestionnaire.value, providerDrawerRecord.value, 'providerFormContainer'));
    showToast('Added.');
  } else {
    showToast('Saved.');
    closeProviderDrawer();
  }
}

// Set Active: only one version per form can be active at a time — this is the version that
// opens when the form's row is clicked from the sidebar.
function setActiveVersion(formId, version) {
  const entry = formEntry(formId);
  if (!entry || !entry.versions.find((v) => v.version === version)) return;
  formsLibrary.update(formId, (draft) => { draft.activeVersion = version; });
  libraryVersion.value++;
  loadVersionIntoEditor(formId, version);
}

// Add: opens the '+ New Form' slide-over to capture formId/title/starting version before
// dropping a minimal valid scaffold into the editor — see confirmNewForm().
function startNewForm() {
  // Defaults to the room currently open, if any — "New Form" is only ever reached from within a
  // room's own card grid now (see the room-view template), so the new form is almost always meant
  // for THAT room; still overridable in the drawer itself.
  Object.assign(newFormDraft, { formId: 'new-form-v1', title: 'New Form', version: 1, journey: '', roomId: activeRoom.value?.roomId || '' });
  previewDrawerOpen.value = false; // avoid stacking two drawer-backdrops at once
  newFormDrawerOpen.value = true;
}

function buildBlankFormTemplate(formId, title, journey) {
  const safeTitle = String(title).replace(/"/g, '\\"');
  return `formId: ${formId}
title: "${safeTitle}"
${journey ? `journey: ${journey}\n` : ''}composition:
  - resourceType: Patient
    id: section_1
    label: "Section 1"
    fields:
      - id: "field_1"
        path: "Patient.name.text"
        label: "Full Name"
        uiComponent: "TextInput"
`;
}

// The real workflow-definition authoring-form schema — same `section_workflow_plan` +
// `section_workflow_action` (repeatable, with nested repeatable Depends On/Condition groups)
// hospital-setup-workflow-v1.yaml's own real, tested composition uses (see
// clinuxflow-api/src/lib/hospital-setup-workflow.test.js). A genuinely working scaffold, not a
// stub — the SAME schema every real system-flow YAML in this app already compiles through.
function buildBlankRoomTemplate(flowId, title) {
  const safeTitle = String(title).replace(/"/g, '\\"');
  return `formId: ${flowId}
title: "${safeTitle} — System Flow"
composition:
  - resourceType: PlanDefinition
    id: section_workflow_plan
    label: "${safeTitle} Workflow"
    fields:
      - id: "plan_title"
        path: "PlanDefinition.title"
        label: "Workflow Title"
        uiComponent: "TextInput"
        required: true
      - id: "plan_status"
        path: "PlanDefinition.status"
        label: "Status"
        uiComponent: "Dropdown"
        choices: ["draft", "active", "retired"]
        required: true
      - id: "plan_type"
        path: "PlanDefinition.type"
        label: "Type"
        uiComponent: "Dropdown"
        choices: ["workflow-definition", "order-set", "clinical-protocol"]
        required: true

  - resourceType: PlanDefinition
    id: section_workflow_action
    label: "Steps"
    repeats: true
    fields:
      - id: "action_id"
        path: "PlanDefinition.action.id"
        label: "Step ID"
        uiComponent: "TextInput"
        required: true
        description: "Set equal to the real section/group id it renders, if any — the binding between this sequence and the actual captured fields."
      - id: "action_title"
        path: "PlanDefinition.action.title"
        label: "Step Name"
        uiComponent: "TextInput"
        required: true
      - id: "action_related"
        path: "PlanDefinition.action.relatedAction"
        label: "Depends On"
        type: "group"
        repeats: true
        fields:
          - id: "relation_target_action_id"
            path: "PlanDefinition.action.relatedAction.actionId"
            label: "Depends On Step"
            uiComponent: "TextInput"
            required: true
          - id: "relation_relationship"
            path: "PlanDefinition.action.relatedAction.relationship"
            label: "Relationship"
            uiComponent: "Dropdown"
            choices: ["before-start", "before", "before-end", "concurrent-with-start", "concurrent", "concurrent-with-end", "after-start", "after", "after-end"]
            required: true
`;
}

function confirmNewForm() {
  const formId = (newFormDraft.formId || '').trim();
  const title = (newFormDraft.title || '').trim();
  const version = parseInt(newFormDraft.version, 10);
  if (!formId || !title || !Number.isFinite(version) || version < 1) {
    showToast('Form ID, Title, and a valid starting Version (1 or higher) are all required.');
    return;
  }
  yamlInput.value = buildBlankFormTemplate(formId, title, newFormDraft.journey);
  pendingStartVersion.value = version;
  // roomId wins if explicitly chosen; otherwise derive one from journey where the two overlap
  // (JOURNEY_TO_ROOM), so a form tagged the old way still gets SOME room association — real,
  // not a guess: 'hospital' genuinely means Facility, 'patient' genuinely means Patient.
  pendingRoomId.value = newFormDraft.roomId || JOURNEY_TO_ROOM[newFormDraft.journey] || '';
  currentVersionNumber.value = null;
  currentStep.value = 0;
  currentView.value = 'designer';
  newFormDrawerOpen.value = false;
  compileWorkflow();
}

function cancelNewForm() { newFormDrawerOpen.value = false; }

// ─── Field Keyword Training (Step 2) ───
// Flattens the compiled blueprint's sections into a plain list of leaf question items, for
// rendering one keyword-input row per field.
function formFields() {
  if (!blueprintJson.value || !blueprintJson.value.item) return [];
  const fields = [];
  const walk = (items, sectionLabel) => {
    (items || []).forEach((item) => {
      if (item.type === 'group' && item.item) {
        walk(item.item, item.text);
      } else if (item.linkId) {
        fields.push({ linkId: item.linkId, text: item.text, section: sectionLabel });
      }
    });
  };
  walk(blueprintJson.value.item, null);
  return fields;
}

function findBlueprintItem(linkId) {
  let found = null;
  const walk = (items) => {
    (items || []).forEach((item) => {
      if (item.linkId === linkId) found = item;
      if (item.item) walk(item.item);
    });
  };
  if (blueprintJson.value) walk(blueprintJson.value.item);
  return found;
}

// Rebuilds the keyword-training text inputs from whatever is currently on the compiled
// blueprint. Called every time a form is compiled or (re)loaded so switching between forms never
// carries one form's keywords into another's fields.
function resetKeywordInputs() {
  Object.keys(keywordInputs).forEach((k) => delete keywordInputs[k]);
  formFields().forEach((f) => {
    const item = findBlueprintItem(f.linkId);
    keywordInputs[f.linkId] = (item && Array.isArray(item.keywords)) ? item.keywords.join(', ') : '';
  });
}

// Writes the keyword-training inputs back onto the compiled blueprint's matching items, so they
// travel with it into Save to Library and into the Trigger Scribe request.
function syncKeywordsToBlueprint() {
  Object.keys(keywordInputs).forEach((linkId) => {
    const item = findBlueprintItem(linkId);
    if (!item) return;
    const keywords = keywordInputs[linkId].split(',').map((k) => k.trim()).filter(Boolean);
    if (keywords.length > 0) item.keywords = keywords;
    else delete item.keywords;
  });
}

// Writes the keyword-training inputs into the YAML source itself (not just the compiled
// blueprint), as a `keywords:` list on each matching field — so recompiling this YAML later
// still has the trained keywords instead of losing them.
function syncKeywordsIntoYaml() {
  try {
    const doc = yamlLoad(yamlInput.value);
    if (!doc || !Array.isArray(doc.composition)) return;

    doc.composition.forEach((section) => {
      (section.fields || []).forEach((field) => {
        const linkId = field.id || field.path;
        if (!(linkId in keywordInputs)) return;
        const keywords = keywordInputs[linkId].split(',').map((k) => k.trim()).filter(Boolean);
        if (keywords.length > 0) field.keywords = keywords;
        else delete field.keywords;
      });
    });

    yamlInput.value = yamlDump(doc, { lineWidth: -1, noRefs: true });
  } catch (e) {
    console.warn('Could not sync keywords into YAML:', e.message);
  }
}

// --- Wikidata-assisted keyword suggestions (SPEC-06 §6 / SPEC-08 Phase 1) — design-time
// semantic tagging, free/Cloud-tier-safe (not gated behind requirePaidTier() server-side).
// Never auto-applies a match: Wikidata is general-knowledge, not a clinical terminology, so a
// "closest match" can be wrong or absent for clinically-precise terms — the author always picks
// from real candidates, same discipline as everywhere else NLP touches this app (the deterministic
// /shortcut escape hatch exists for exactly this kind of ambiguity risk).
const wikidataCandidates = reactive({}); // linkId -> array | null (null = picker closed)
const wikidataLoading = reactive({}); // linkId -> boolean

async function suggestWikidataTags(field) {
  wikidataLoading[field.linkId] = true;
  wikidataCandidates[field.linkId] = null;
  try {
    const res = await apiFetch(`${API_BASE}/api/nlp/wikidata-search?term=${encodeURIComponent(field.text)}`);
    const body = await res.json().catch(() => null);
    wikidataCandidates[field.linkId] = body?.success ? body.candidates : [];
  } catch (e) {
    wikidataCandidates[field.linkId] = [];
  } finally {
    wikidataLoading[field.linkId] = false;
  }
}

// Merges the confirmed concept's aliases into the field's EXISTING keyword input rather than
// overwriting it — an author may have already typed keywords by hand before asking for
// suggestions, and this shouldn't discard that work.
async function applyWikidataConcept(field, candidate) {
  wikidataCandidates[field.linkId] = null;
  try {
    const res = await apiFetch(`${API_BASE}/api/nlp/wikidata-concept?qid=${encodeURIComponent(candidate.qid)}`);
    const body = await res.json().catch(() => null);
    if (!body?.success) return;
    const existing = (keywordInputs[field.linkId] || '').split(',').map((k) => k.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...body.concept.aliases])];
    keywordInputs[field.linkId] = merged.join(', ');
  } catch (e) {
    // Silent — the author can just type keywords manually, same fallback as if this feature
    // didn't exist at all; a Wikidata hiccup shouldn't block form training.
  }
}

function dismissWikidataCandidates(linkId) {
  wikidataCandidates[linkId] = null;
}

// ─── Data Records (Data Explorer) ───
// Actual filled-out data captured using a form — distinct from the Forms Library, which holds
// form *templates*.
function currentFormDataRecords() {
  dataVersion.value;
  if (!blueprintJson.value) return [];
  return listDataRecords(blueprintJson.value.id);
}

const gridTheme = themeQuartz;
const dataExplorerDefaultColDef = { resizable: true, sortable: true, filter: true };
const dataExplorerColumnDefs = computed(() => [
  { headerName: 'Record', valueGetter: (p) => recordSummary(p.data), flex: 1.4 },
  { headerName: 'Form Version', valueGetter: (p) => (p.data.version ? 'v' + p.data.version : '—'), flex: 0.6 },
  { headerName: 'Saved', valueGetter: (p) => new Date(p.data.savedAt).toLocaleString(), flex: 1 },
  { headerName: 'Actions', cellRenderer: GridActionsCell, cellRendererParams: { onView: (r) => viewDataRecord(r.id) }, flex: 0.6, sortable: false, filter: false },
]);

// Opens the slide-over with a blank copy of the active form, ready for a new entry.
function openNewDataEntry() {
  if (!blueprintJson.value) return;
  activeDataRecordId.value = null;
  previewDrawerOpen.value = true;
  nextTick(renderBlueprintPreview);
}

// Looks up the exact questionnaire snapshot a record was saved against (by formId + version,
// not whatever is currently loaded) so linkIds always line up for the merge — if the form has
// since been re-versioned with different/renamed fields, merging against today's active version
// instead of the one the record actually belongs to would silently fail to populate anything.
function questionnaireForVersion(formId, version) {
  const entry = formEntry(formId || blueprintJson.value?.id);
  const stored = entry?.versions.find((v) => v.version === version)?.questionnaire;
  return stored || blueprintJson.value || null;
}

// Opens the slide-over with a saved record's answers merged into the form version it was
// actually saved against. Opens the drawer first (before any rendering is attempted) so a
// rendering failure still gives visible feedback instead of the click silently doing nothing.
function viewDataRecord(recordId) {
  const record = currentFormDataRecords().find((r) => r.id === recordId);
  if (!record) return;

  activeDataRecordId.value = recordId;
  previewDrawerOpen.value = true;

  const questionnaire = questionnaireForVersion(record.formId, record.version);
  if (!questionnaire) {
    console.warn('No questionnaire available to merge record ' + recordId + ' into.');
    return;
  }
  nextTick(() => renderWithRecord(questionnaire, record, 'formContainer'));
}

// Reads the slide-over's current answers back out and persists them as a QuestionnaireResponse,
// tagged with the exact form + version it was captured against. Updates the open record in
// place if one is active, otherwise creates a new one.
function saveDataEntry() {
  if (!blueprintJson.value) return;

  const questionnaireResponse = extractResponse('formContainer');
  if (!questionnaireResponse) {
    showToast('Could not read the entered data from the form. Please try again.');
    return;
  }

  const formId = blueprintJson.value.id;
  const version = currentVersionNumber.value || activeVersionNumber(formId) || null;
  activeDataRecordId.value = saveDataRecord(formId, version, questionnaireResponse, activeDataRecordId.value);
  dataVersion.value++;
  dataSaveLabel.value = 'Saved';
  setTimeout(() => { dataSaveLabel.value = ''; }, 2000);
}

// Resets the slide-over back to a blank form, detaching from whichever record was open (it is
// not deleted — just no longer the one being edited).
function clearDataEntry() {
  activeDataRecordId.value = null;
  dataSaveLabel.value = '';
  renderBlueprintPreview();
}

// Data records are real deletions (unlike form templates/versions, which are never deleted) —
// this removes an individual filled-out entry.
function deleteDataEntry(recordId) {
  const targetId = recordId || activeDataRecordId.value;
  if (!targetId || !blueprintJson.value) return;
  if (!confirm('Permanently delete this record? This cannot be undone.')) return;

  deleteDataRecord(targetId);
  dataVersion.value++;

  if (targetId === activeDataRecordId.value) {
    activeDataRecordId.value = null;
    previewDrawerOpen.value = false;
  }
}

// status is 'draft' (default) or 'final'. Draft versions never touch which version is active —
// they're saved for safekeeping/review without affecting production. Final versions are
// promoted to active immediately, same as the very first version always is.
async function saveToLibrary(status = 'draft') {
  if (!blueprintJson.value) {
    showToast('Compile the form first — there is nothing to save yet.');
    return;
  }

  syncKeywordsToBlueprint();
  syncKeywordsIntoYaml();

  const formId = blueprintJson.value.id;
  const entry = formEntry(formId);
  // A brand-new form's captured starting version (see confirmNewForm()) only applies to its
  // very first save — once versions exist, the library's own max+1 counter takes over.
  const nextVersion = entry && entry.versions.length > 0
    ? Math.max(...entry.versions.map((v) => v.version)) + 1
    : (pendingStartVersion.value || 1);
  pendingStartVersion.value = null;

  const versionRow = { version: nextVersion, status, yaml: yamlInput.value, questionnaire: blueprintJson.value, savedAt: new Date().toISOString() };

  // Always save locally first, in the browser — this is the default, always-on library.
  if (!entry) {
    formsLibrary.insert({ formId, isSystem: false, archived: false, bookmarked: false, activeVersion: nextVersion, versions: [versionRow], roomId: pendingRoomId.value || undefined });
    pendingRoomId.value = '';
  } else {
    formsLibrary.update(formId, (draft) => {
      draft.versions.push(versionRow);
      // A form that gets a new version is implicitly back in active use.
      draft.archived = false;
      // The very first version becomes active regardless of status; afterwards, only an
      // explicit Final save promotes a version — Draft saves leave the active one untouched.
      if (!draft.activeVersion || status === 'final') draft.activeVersion = nextVersion;
    });
  }
  libraryVersion.value++;
  // Data records saved from here on reference this exact version.
  currentVersionNumber.value = nextVersion;

  savedVersionLabel.value = `Saved as ${status === 'final' ? 'Final' : 'Draft'} v${nextVersion}`;
  terminologyLogs.value = [...terminologyLogs.value, `📚 Saved to local forms library: ${formId} v${nextVersion} [${status}] (browser storage).`];

  // Paid-tier clinics additionally get a durable server-side copy.
  if (auth.currentUser?.tier === 'paid') {
    const res = await apiFetch(`${API_BASE}/api/workflow/save-to-library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yamlPayload: yamlInput.value, questionnaireJson: blueprintJson.value }),
    }).then((r) => r.json());

    if (res.success) {
      savedVersionLabel.value = `Saved locally as v${nextVersion} + server v${res.version}`;
      terminologyLogs.value = [...terminologyLogs.value, `☁️ Subscription active — also backed up to server: ${res.formId} v${res.version} (${res.jsonKey} + ${res.yamlKey}).`];
    } else {
      terminologyLogs.value = [...terminologyLogs.value, `⚠️ Local save succeeded (v${nextVersion}) but server backup failed: ${res.error}`];
    }
  }
}

async function testVoiceScribeExtraction() {
  if (auth.currentUser?.tier !== 'paid') {
    showToast('Voice-scribe testing requires a paid subscription.');
    return;
  }
  if (!blueprintJson.value) {
    showToast('Compile the form first — there is nothing to train or test yet.');
    return;
  }
  // Bake the current keyword-training inputs into the blueprint before sending it, so the
  // server's reverse-mapping match uses this run's keywords.
  syncKeywordsToBlueprint();

  // source: 'designer-test' — lets clinuxflow-api deny this specific dev-testing path in
  // production while leaving ConsultationDesk.vue's real scribe feature untouched.
  const res = await apiFetch(`${API_BASE}/api/workflow/test-scribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: voiceTranscriptInput.value, activeBlueprint: blueprintJson.value, source: 'designer-test' }),
  }).then((r) => r.json());

  if (res.success) {
    llmResponseOutput.value = res.maskedLlmOutput;
    localExtractedFhirGraph.value = res.localExtractedFhirGraph;
    activeDataRecordId.value = null;
    previewDrawerOpen.value = true;
    await nextTick();
    renderBlueprintPreview();
  } else {
    showToast('Extraction Error: ' + res.error);
  }
}

function nextStep() { if (currentStep.value < steps.length - 1) { currentStep.value++; window.scrollTo(0, 0); } }
function prevStep() { if (currentStep.value > 0) { currentStep.value--; window.scrollTo(0, 0); } }
</script>

<template>
  <div class="cf-toast" v-show="toast.show"><i class="fas fa-check-circle" style="color:var(--color-primary)"></i><span>{{ toast.msg }}</span></div>

  <!-- ─── Live Preview Slide-Over (opens from Compile, Trigger Scribe, or a Data Record's View/New Entry) ─── -->
  <div class="drawer-backdrop" :class="previewDrawerOpen ? 'open' : ''" @click="closeDrawer()"></div>
  <div class="drawer-panel" :class="previewDrawerOpen ? 'open' : ''">
    <div class="drawer-header">
      <div>
        <h3 style="font-size:.95rem;font-weight:700;color:var(--cf-text-strong);display:flex;align-items:center;gap:.5rem"><i class="fas fa-eye" style="color:var(--color-primary)"></i>Live Preview</h3>
        <p style="font-size:.72rem;color:var(--cf-text);margin-top:.15rem">{{ blueprintJson ? blueprintJson.title : '' }}</p>
      </div>
      <button @click="closeDrawer()" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <div class="preview-panel">
        <div id="formContainer"></div>
      </div>
    </div>
    <div class="drawer-footer">
      <span style="font-size:.75rem;color:var(--color-primary);font-weight:600;margin-right:auto" v-show="dataSaveLabel">{{ dataSaveLabel }}</span>
      <button class="btn-outline" v-show="activeDataRecordId" @click="deleteDataEntry()" style="display:flex;align-items:center;gap:.4rem">
        <i class="fas fa-trash"></i>Delete Record
      </button>
      <button class="btn-ghost" @click="clearDataEntry()" style="display:flex;align-items:center;gap:.4rem">
        <i class="fas fa-broom"></i>Clear
      </button>
      <button class="btn-teal" @click="saveDataEntry()" :disabled="!blueprintJson" style="display:flex;align-items:center;gap:.4rem">
        <i class="fas fa-save"></i>Save Record
      </button>
    </div>
  </div>

  <!-- ─── "+ New Form" Slide-Over ─── -->
  <div class="drawer-backdrop" :class="newFormDrawerOpen ? 'open' : ''" @click="cancelNewForm()"></div>
  <div class="drawer-panel" :class="newFormDrawerOpen ? 'open' : ''">
    <div class="drawer-header">
      <div>
        <h3 style="font-size:.95rem;font-weight:700;color:var(--cf-text-strong);display:flex;align-items:center;gap:.5rem"><i class="fas fa-file-circle-plus" style="color:var(--color-primary)"></i>New Form</h3>
        <p style="font-size:.72rem;color:var(--cf-text);margin-top:.15rem">Capture the Form ID, Title, and starting Version before scaffolding a blank YAML blueprint.</p>
      </div>
      <button @click="cancelNewForm()" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <label class="cf-label" style="display:block;margin-bottom:.3rem">Form ID</label>
      <input type="text" v-model="newFormDraft.formId" class="cf-input" style="margin-bottom:1.1rem;width:100%" placeholder="e.g. my-clinic-intake-v1" />

      <label class="cf-label" style="display:block;margin-bottom:.3rem">Title</label>
      <input type="text" v-model="newFormDraft.title" class="cf-input" style="margin-bottom:1.1rem;width:100%" placeholder="e.g. My Clinic Intake" />

      <label class="cf-label" style="display:block;margin-bottom:.3rem">Starting Version #</label>
      <input type="number" min="1" step="1" v-model.number="newFormDraft.version" class="cf-input" style="width:100%;margin-bottom:1.1rem" />

      <label class="cf-label" style="display:block;margin-bottom:.3rem">Room</label>
      <select v-model="newFormDraft.roomId" class="cf-input" style="width:100%;margin-bottom:1.1rem">
        <option value="">None — not shown in any room's own card grid</option>
        <option v-for="room in ROOM_DEFINITIONS" :key="room.roomId" :value="room.roomId">{{ room.title }}</option>
      </select>

      <label class="cf-label" style="display:block;margin-bottom:.3rem">Journey (optional)</label>
      <select v-model="newFormDraft.journey" class="cf-input" style="width:100%">
        <option value="">None — only reachable from Designer's own Data Explorer</option>
        <option value="patient">Patient — surfaces in Front Desk's "Additional Forms" step</option>
        <option value="hospital">Hospital — clinic-management workflow</option>
      </select>
    </div>
    <div class="drawer-footer">
      <button class="btn-ghost" @click="cancelNewForm()">Cancel</button>
      <button class="btn-teal" @click="confirmNewForm()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i>Create</button>
    </div>
  </div>

  <!-- ─── Provider Entity Drawer (Hospital/Care Team/Administrators/Services/Hours/Consents/
       Branches/Appointments) — whole-document add/view/edit, same pattern as Onboarding.vue's
       own drawer, kept separate from the Live Preview Slide-Over above since it's driven by the
       onboarding store's Provider record rather than the compiler's blueprintJson. ─── -->
  <div class="drawer-backdrop" :class="providerDrawerOpen ? 'open' : ''" @click="closeProviderDrawer()"></div>
  <div class="drawer-panel" :class="providerDrawerOpen ? 'open' : ''">
    <div class="drawer-header">
      <div>
        <h3 style="font-size:.95rem;font-weight:700;color:var(--cf-text-strong);display:flex;align-items:center;gap:.5rem">
          <i :class="activeCard ? activeCard.icon : 'fas fa-file-lines'" :style="activeCard ? `color:${activeCard.color}` : ''"></i>
          <span>{{ activeCard ? activeCard.title : '' }}</span>
        </h3>
        <p style="font-size:.72rem;color:var(--cf-text);margin-top:.15rem">{{ activeCard ? activeCard.desc : '' }}</p>
      </div>
      <button @click="closeProviderDrawer()" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
    </div>
    <div class="drawer-body">
      <div class="preview-panel">
        <div id="providerFormContainer"></div>
      </div>
    </div>
    <div class="drawer-footer">
      <button v-if="activeCard && activeCard.mode === 'single'" class="btn-teal" @click="saveProviderDrawerRecord()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-save"></i>Save</button>
      <button v-if="activeCard && activeCard.mode === 'repeatable'" class="btn-teal" @click="saveProviderDrawerRecord()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i>Add</button>
    </div>
  </div>

  <!-- Cübo as a floating FAB (not the old fixed 380px left pane, per explicit instruction) — the
       Room Architect's own content (Rooms grid, a room's entities, Design & Compile Room) now
       gets the full page width; Cübo is one click away rather than always eating a third of the
       screen. Deliberately NOT wrapped in a `.cubo-inline-host` container — that class exists
       specifically to force Cübo into a confined, non-floating box (see style.css's own
       `.cubo-inline-host .cubo-wrapper` override), which is exactly the opposite of what FAB mode
       needs here. No currentLayout override at all — same as AiEngine.vue, this just uses the
       store's own real default ('FAB'). -->
  <Cubo category="ai-engine" page-context="ClinüxFlow Room Architect — Rooms, form design, and library." />

  <div class="flex-1 flex overflow-hidden">
    <!-- Forms Library content — this route now requires auth (see the router), so no
         "sandbox mode / sign in" fallback branch is needed here any more. -->
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;gap:.5rem;padding:1rem 1.5rem 0;flex-shrink:0;position:relative;z-index:110">
        <span class="btn-outline btn-teal" style="font-size:.78rem;cursor:default">
          <i class="fas fa-pen-ruler" style="margin-right:.4rem"></i>Forms Library
        </span>
      </div>

  <main style="flex:1;overflow:hidden;display:flex;justify-content:center">
  <div style="max-width:1500px;width:100%;overflow-y:auto;padding:1.5rem">

    <!-- ── Rooms grid (default landing, SPEC-22 §5.8) — Provider/Facility/Patient/Encounter/
         Account, the top-level entities the Room Architect actually lists now. ── -->
    <div v-show="currentView === 'rooms'">
      <div style="margin-bottom:1.25rem">
        <span class="cf-label" style="margin-bottom:.2rem;display:block">Rooms</span>
        <p style="font-size:.8rem;color:var(--cf-text)">Every real workspace ClinüxFlow manages. Open a room to view its entities, design its workflow, or edit which account roles it applies to.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem">
        <div v-for="room in ROOM_DEFINITIONS" :key="room.roomId" style="position:relative">
        <button class="entry-card" @click="openRoom(room)">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem">
            <div style="width:40px;height:40px;border-radius:.625rem;display:flex;align-items:center;justify-content:center;margin-bottom:.75rem" :style="`background:${room.bg}`">
              <i :class="room.icon" :style="`color:${room.color};font-size:1rem`"></i>
            </div>
            <button class="icon-btn" style="margin-top:.1rem" @click.stop="toggleMenu(room.roomId)"><i class="fas fa-ellipsis-vertical"></i></button>
          </div>
          <p style="font-weight:700;font-size:.9rem;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ room.title }}</p>
          <p style="font-size:.75rem;color:var(--cf-text);line-height:1.45;margin-bottom:.5rem">{{ room.desc }}</p>
          <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
            <span class="badge" :class="cardsForRoom(room.roomId).length ? 'badge-teal' : 'badge-muted'">{{ cardsForRoom(room.roomId).length }} card{{ cardsForRoom(room.roomId).length === 1 ? '' : 's' }}</span>
            <span class="badge" :class="roomFlowId(room) && flowsLibrary.has(roomFlowId(room)) ? 'badge-teal' : 'badge-muted'">{{ flowsLibrary.has(roomFlowId(room)) ? 'Plan designed' : 'No plan yet' }}</span>
            <span class="badge badge-muted" v-show="!roomRoles(room).length">All roles</span>
            <span class="badge badge-muted" v-show="roomRoles(room).length" v-for="r in roomRoles(room)" :key="r">{{ r.replace(/_/g, ' ') }}</span>
          </div>
        </button>
        <!-- Same context-menu pattern the form cards use (SPEC-22 §5.12: "the rooms card should
             be the same like forms card with designer/yaml view and show versions menu"). -->
        <div class="context-menu" v-show="openMenuFormId === room.roomId" style="right:.5rem;top:2.6rem">
          <button class="context-menu-item" @click="openRoomDesigner(room); closeMenu()"><i class="fas fa-pen-ruler"></i>Designer / YAML View</button>
          <button class="context-menu-item" @click="toggleExpand(roomFlowId(room)); closeMenu()"><i class="fas fa-clock-rotate-left"></i>Show Versions</button>
        </div>
        <div v-show="libraryExpanded[roomFlowId(room)] && flowsLibrary.has(roomFlowId(room))" class="cf-card" style="margin-top:.4rem;padding:.6rem .75rem;border-radius:.6rem">
          <div v-for="v in flowVersionsReversed(room)" :key="v.version" class="version-row">
            <span>
              <strong>v{{ v.version }}</strong>
              <span class="badge" :class="v.status === 'active' ? 'badge-teal' : 'badge-muted'" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem">{{ (v.status || 'draft').toUpperCase() }}</span>
              <span class="badge badge-teal" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem" v-show="v.version === flowsLibrary.get(roomFlowId(room))?.activeVersion">ACTIVE</span>
              <span style="color:var(--cf-text)">{{ ' · ' + new Date(v.savedAt).toLocaleDateString() }}</span>
            </span>
            <div style="display:flex;gap:.3rem;flex-shrink:0">
              <button class="btn-ghost" style="font-size:.62rem;padding:.2rem .45rem" @click="openRoomDesigner(room, v.version)">Load</button>
              <button class="btn-outline" style="font-size:.62rem;padding:.2rem .45rem" v-show="v.version !== flowsLibrary.get(roomFlowId(room))?.activeVersion" @click="setActiveRoomVersion(room, v.version)">Set Active</button>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>

    <!-- ── Room view (drilled into one room) — one card per entity that room owns, plus a real
         Roles editor and the entry point into that room's own Design & Compile Room session. ── -->
    <div v-show="currentView === 'room' && activeRoom">
      <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem">
        <button class="btn-ghost" @click="backToRooms()" style="font-size:.78rem;display:flex;align-items:center;gap:.35rem"><i class="fas fa-arrow-left"></i>Rooms</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem">
        <div style="display:flex;align-items:center;gap:.6rem">
          <div style="width:36px;height:36px;border-radius:.625rem;display:flex;align-items:center;justify-content:center" :style="`background:${activeRoom?.bg}`">
            <i :class="activeRoom?.icon" :style="`color:${activeRoom?.color};font-size:.9rem`"></i>
          </div>
          <div>
            <span class="cf-label" style="display:block">{{ activeRoom?.title }}</span>
            <p style="font-size:.78rem;color:var(--cf-text)">{{ activeRoom?.desc }}</p>
          </div>
        </div>
        <button class="btn-teal" @click="openRoomDesigner(activeRoom)" style="padding:.5rem 1rem;font-size:.78rem;display:flex;align-items:center;gap:.4rem;white-space:nowrap">
          <i class="fas fa-diagram-project"></i>Design &amp; Compile Room
        </button>
      </div>

      <!-- Roles editor — SPEC-22 §5.8's "we also need to design the roles who can be part of the
           Room" — real, persisted (roomSettings.js), not decorative. -->
      <div class="cf-card" style="padding:.75rem 1rem;border-radius:.6rem;margin-bottom:1.25rem">
        <span class="cf-label" style="display:block;margin-bottom:.4rem">Who can use this room</span>
        <div style="display:flex;flex-wrap:wrap;gap:1rem">
          <label v-for="role in ACCOUNT_ROLES" :key="role" style="display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--cf-text);cursor:pointer">
            <input type="checkbox" :checked="isRoleChecked(activeRoom, role)" @change="toggleRoomRole(activeRoom, role)" />{{ role.replace(/_/g, ' ') }}
          </label>
        </div>
        <p style="font-size:.7rem;color:var(--cf-text);margin-top:.4rem" v-show="!roomRoles(activeRoom).length">All roles checked — this room is universal (no gating).</p>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1.25rem">
        <div>
          <span class="cf-label" style="margin-bottom:.2rem;display:block">Entities</span>
          <p style="font-size:.8rem;color:var(--cf-text)">Click a card to view its records; use the menu for the Designer/YAML view.</p>
        </div>
        <div style="display:flex;align-items:center;gap:.5rem;flex-shrink:0">
          <label style="display:flex;align-items:center;gap:.35rem;font-size:.75rem;color:var(--cf-text);cursor:pointer"><input type="checkbox" v-model="libraryShowArchived" />Show Archived</label>
          <div style="position:relative">
            <i class="fas fa-search" style="position:absolute;left:.65rem;top:50%;transform:translateY(-50%);font-size:.68rem;color:var(--cf-text)"></i>
            <input type="text" data-library-search :value="formSearchInput" @input="onFormSearchInput($event.target.value)" placeholder="Search forms…" class="cf-input" style="padding-left:1.8rem;width:220px" />
          </div>
          <button class="btn-teal" @click="startNewForm()" style="padding:.5rem 1rem;font-size:.78rem;display:flex;align-items:center;gap:.4rem;white-space:nowrap">
            <i class="fas fa-plus"></i>New Form
          </button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.9rem">
        <div v-for="card in cardsForRoom(activeRoom?.roomId)" :key="card.id" style="position:relative">
          <button class="entry-card" @click="openCard(card)">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem">
              <div style="width:36px;height:36px;border-radius:.625rem;display:flex;align-items:center;justify-content:center;margin-bottom:.75rem" :style="`background:${card.bg}`">
                <i :class="card.icon" :style="`color:${card.color};font-size:.9rem`"></i>
              </div>
              <button class="icon-btn" style="margin-top:.1rem" @click.stop="toggleMenu(card.id)"><i class="fas fa-ellipsis-vertical"></i></button>
            </div>
            <p style="font-weight:700;font-size:.85rem;color:var(--cf-text-strong);font-family:'Poppins',sans-serif;margin-bottom:.3rem">{{ card.title }}</p>
            <p style="font-size:.75rem;color:var(--cf-text);line-height:1.45;margin-bottom:.5rem">{{ card.desc }}</p>
            <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <span class="badge" :class="cardStatus(card) !== 'Not started' && cardStatus(card) !== 'No records' ? 'badge-teal' : 'badge-muted'">{{ cardStatus(card) }}</span>
              <span class="badge badge-muted" v-show="card.archived">ARCHIVED</span>
              <span v-show="card.bookmarked"><i class="fas fa-star" style="color:#F59E0B;font-size:.7rem"></i></span>
            </div>
          </button>
          <div class="context-menu" v-show="openMenuFormId === card.id" style="right:.5rem;top:2.6rem">
            <button class="context-menu-item" @click="openCardDesigner(card); closeMenu()"><i class="fas fa-pen-ruler"></i>Designer / YAML View</button>
            <button class="context-menu-item" v-show="card.kind === 'group'" @click="toggleExpand(onboarding.PROVIDER_FORM_ID); closeMenu()"><i class="fas fa-clock-rotate-left"></i>Show Versions</button>
            <button class="context-menu-item" v-show="card.kind === 'form'" @click="toggleExpand(card.formId); closeMenu()"><i class="fas fa-clock-rotate-left"></i>Show Versions</button>
            <button class="context-menu-item" v-show="card.kind === 'form'" @click="toggleBookmark(card.formId); closeMenu()">
              <i :class="card.bookmarked ? 'fas fa-star' : 'far fa-star'"></i><span>{{ card.bookmarked ? 'Unbookmark' : 'Bookmark' }}</span>
            </button>
            <button class="context-menu-item" v-show="card.kind === 'form' && !card.isSystem" @click="toggleArchive(card.formId); closeMenu()">
              <i class="fas" :class="card.archived ? 'fa-box-open' : 'fa-box-archive'"></i><span>{{ card.archived ? 'Restore' : 'Archive' }}</span>
            </button>
          </div>
          <div v-show="card.kind === 'form' && libraryExpanded[card.formId]" class="cf-card" style="margin-top:.4rem;padding:.6rem .75rem;border-radius:.6rem">
            <div v-for="v in versionsReversed(card.formId)" :key="v.version" class="version-row">
              <span>
                <strong>v{{ v.version }}</strong>
                <span class="badge" :class="v.status === 'final' ? 'badge-teal' : 'badge-muted'" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem">{{ (v.status || 'draft').toUpperCase() }}</span>
                <span class="badge badge-teal" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem" v-show="v.version === activeVersionNumber(card.formId)">ACTIVE</span>
                <span style="color:var(--cf-text)">{{ ' · ' + new Date(v.savedAt).toLocaleDateString() }}</span>
              </span>
              <div style="display:flex;gap:.3rem;flex-shrink:0">
                <button class="btn-ghost" style="font-size:.62rem;padding:.2rem .45rem" @click="loadVersionIntoEditor(card.formId, v.version); currentView = 'designer'">Load</button>
                <button class="btn-outline" style="font-size:.62rem;padding:.2rem .45rem" v-show="v.version !== activeVersionNumber(card.formId)" @click="setActiveVersion(card.formId, v.version); currentView = 'designer'">Set Active</button>
              </div>
            </div>
          </div>
          <div v-show="card.kind === 'group' && libraryExpanded[onboarding.PROVIDER_FORM_ID] && formEntry(onboarding.PROVIDER_FORM_ID)" class="cf-card" style="margin-top:.4rem;padding:.6rem .75rem;border-radius:.6rem">
            <div v-for="v in versionsReversed(onboarding.PROVIDER_FORM_ID)" :key="v.version" class="version-row">
              <span>
                <strong>v{{ v.version }}</strong>
                <span class="badge" :class="v.status === 'final' ? 'badge-teal' : 'badge-muted'" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem">{{ (v.status || 'draft').toUpperCase() }}</span>
                <span class="badge badge-teal" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem" v-show="v.version === activeVersionNumber(onboarding.PROVIDER_FORM_ID)">ACTIVE</span>
                <span style="color:var(--cf-text)">{{ ' · ' + new Date(v.savedAt).toLocaleDateString() }}</span>
              </span>
              <div style="display:flex;gap:.3rem;flex-shrink:0">
                <button class="btn-ghost" style="font-size:.62rem;padding:.2rem .45rem" @click="loadVersionIntoEditor(onboarding.PROVIDER_FORM_ID, v.version); currentView = 'designer'">Load</button>
                <button class="btn-outline" style="font-size:.62rem;padding:.2rem .45rem" v-show="v.version !== activeVersionNumber(onboarding.PROVIDER_FORM_ID)" @click="setActiveVersion(onboarding.PROVIDER_FORM_ID, v.version); currentView = 'designer'">Set Active</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Table view / Designer view (drilled into one card) ── -->
    <div v-show="currentView === 'table' || currentView === 'designer'">
    <button class="btn-outline" @click="backToCards()" style="font-size:.75rem;padding:.4rem 1rem;margin-bottom:1.25rem;display:flex;align-items:center;gap:.4rem">
      <i class="fas fa-arrow-left"></i>Back to {{ activeRoom ? activeRoom?.title : 'Rooms' }}
    </button>

    <div v-show="currentView === 'designer'">

    <!-- ── Step Progress Bar ── -->
    <div style="display:flex;align-items:center;justify-content:center;gap:1.25rem;margin-bottom:2.5rem">
      <button class="step-nav-btn" @click="prevStep()" :disabled="currentStep === 0" title="Previous step">
        <i class="fas fa-chevron-left"></i>
      </button>

      <div style="display:flex;align-items:center">
        <div v-for="(s, idx) in steps" :key="s.id" style="display:flex;align-items:center">
          <div style="display:flex;flex-direction:column;align-items:center;gap:.35rem;width:6.5rem">
            <div class="step-dot" :class="idx < currentStep ? 'done' : idx === currentStep ? 'active' : 'pending'">
              <i v-if="idx < currentStep" class="fas fa-check text-xs"></i>
              <span v-else>{{ idx + 1 }}</span>
            </div>
            <span style="font-size:.68rem;font-family:'Poppins',sans-serif;font-weight:600;white-space:nowrap;color:var(--cf-text)" :style="idx === currentStep ? 'color:var(--cf-text-strong)' : ''">{{ s.label }}</span>
          </div>
          <div v-if="idx < steps.length - 1" class="step-connector" :class="idx < currentStep ? 'done' : ''" style="margin-bottom:1.1rem;width:2.5rem"></div>
        </div>
      </div>

      <button class="step-nav-btn" @click="nextStep()" :disabled="currentStep === steps.length - 1 || !blueprintJson" title="Next step">
        <i class="fas fa-chevron-right"></i>
      </button>
    </div>

    <!-- ════ STEP 1: Compile & Preview ════ -->
    <div v-show="currentStep === 0" class="step-panel">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1.5rem">
        <div>
          <span class="section-eyebrow" style="display:block;margin-bottom:.4rem">Step 1 of 2</span>
          <h2 style="font-size:1.5rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.35rem">Compile &amp; Preview</h2>
          <p style="font-size:.85rem;color:var(--cf-text)">Edit the room's Clinical Quasi-Language (YAML) blueprint and compile it into a FHIR Questionnaire — the preview slides in from the right once it's built.</p>
        </div>
        <div style="display:flex;align-items:center;gap:.625rem;flex-shrink:0">
          <span style="font-size:.72rem;color:var(--color-primary);font-weight:600" v-show="savedVersionLabel">{{ savedVersionLabel }}</span>
          <div class="save-as-anchor" style="position:relative">
            <button class="btn-outline" @click="saveAsMenuOpen = !saveAsMenuOpen" :disabled="!blueprintJson" style="display:flex;align-items:center;gap:.5rem;white-space:nowrap">
              <i class="fas fa-save"></i>Save As<i class="fas fa-chevron-down" style="font-size:.6rem"></i>
            </button>
            <div class="context-menu" v-show="saveAsMenuOpen" style="min-width:150px">
              <button class="context-menu-item" @click="saveToLibrary('draft'); saveAsMenuOpen = false">
                <i class="fas fa-pen"></i>Draft
              </button>
              <button class="context-menu-item" @click="saveToLibrary('final'); saveAsMenuOpen = false">
                <i class="fas fa-check-circle"></i>Final
              </button>
            </div>
          </div>
          <button class="btn-teal" @click="compileWorkflow()" style="display:flex;align-items:center;gap:.5rem;white-space:nowrap">
            <i class="fas fa-hammer"></i>Run Compiler &amp; Rebuild UI
          </button>
        </div>
      </div>

      <div class="cf-card" style="border-radius:1rem;padding:1.5rem;margin-bottom:1.25rem">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:.75rem">
          <h3 style="font-size:.9rem;font-weight:700;color:var(--cf-text-strong);display:flex;align-items:center;gap:.5rem;margin:0"><i class="fas fa-code" style="color:var(--color-primary)"></i>Clinical Quasi-Language Schema (YAML)</h3>
          <div v-show="blueprintJson" style="display:flex;align-items:center;gap:.4rem;font-size:.72rem;font-weight:600">
            <span style="padding:.15rem .55rem;border-radius:.4rem;background:var(--cf-bg-alt);color:var(--cf-text-strong);border:1px solid var(--cf-border);font-family:'JetBrains Mono',monospace">{{ blueprintJson?.id }}</span>
            <span style="padding:.15rem .55rem;border-radius:.4rem;background:var(--cf-bg-alt);color:var(--cf-text);border:1px solid var(--cf-border)">{{ blueprintJson?.title }}</span>
            <span style="padding:.15rem .55rem;border-radius:.4rem;background:var(--color-primary);color:#fff">{{ 'v' + (currentVersionNumber || pendingStartVersion || 1) }}</span>
          </div>
        </div>
        <div ref="aceYamlEditorEl" style="height:560px;border-radius:.6rem;overflow:hidden;border:1px solid var(--cf-border)"></div>
      </div>

      <div class="cf-card" style="border-radius:1rem;padding:1.25rem 1.5rem">
        <button class="accordion-header" :class="accordionOpen.compileDetails ? '' : 'collapsed'" @click="toggleAccordion('compileDetails')" style="margin-top:0">
          <span class="section-eyebrow" style="margin:0"><i class="fas fa-terminal" style="margin-right:.35rem"></i>Compiler Details</span>
          <i class="fas fa-chevron-down"></i>
        </button>
        <div v-show="accordionOpen.compileDetails" style="margin-top:.9rem">
          <div style="margin-bottom:.9rem">
            <h3 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-diagram-project" style="color:var(--color-primary)"></i>Dynamic Scribe GBNF Grammar Rules Mask</h3>
            <pre class="console-pre" style="height:90px">{{ gbnfRules || 'Awaiting dynamic compiler engine generation pass...' }}</pre>
          </div>
          <div>
            <h3 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-list-check" style="color:var(--color-primary)"></i>Terminology Vocabulary System Validation Log</h3>
            <div class="console-pre" style="height:90px;font-family:'Inter',sans-serif;font-size:.78rem">
              <div v-for="log in terminologyLogs" :key="log" :style="log.includes('✅') || log.includes('📚') || log.includes('☁️') ? 'color:var(--color-primary)' : 'color:#D97706'">{{ log }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ════ STEP 2: Training the Form ════ -->
    <div v-show="currentStep === 1" class="step-panel">
      <div style="margin-bottom:1.5rem">
        <span class="section-eyebrow" style="display:block;margin-bottom:.4rem">Step 2 of 2</span>
        <h2 style="font-size:1.5rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.35rem">Training the Form</h2>
        <p style="font-size:.85rem;color:var(--cf-text)">Give each field a few keywords so the scribe engine knows what to listen for, then simulate a room's voice dictation stream and check how it mapped back onto the form.</p>
      </div>

      <div class="cf-card" style="border-radius:1rem;padding:1.5rem;margin-bottom:1.25rem">
        <h3 style="font-size:.9rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.4rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-tags" style="color:var(--color-primary)"></i>Field Keyword Training</h3>
        <p style="font-size:.78rem;color:var(--cf-text);margin-bottom:.9rem">Comma-separated keywords or phrases (e.g. <span style="font-family:'JetBrains Mono',monospace">hypertension, high blood pressure</span>). A transcript matching a trained keyword scores higher than a generic label/path match, so it wins the field.</p>
        <div style="display:flex;flex-direction:column;gap:.65rem;max-height:280px;overflow-y:auto">
          <div v-for="field in formFields()" :key="field.linkId" style="display:grid;grid-template-columns:1fr 1.4fr;gap:.75rem;align-items:center">
            <div style="overflow:hidden">
              <p style="font-size:.8rem;font-weight:600;color:var(--cf-text-strong);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ field.text }}</p>
              <p style="font-size:.65rem;color:var(--cf-text);font-family:'JetBrains Mono',monospace">{{ field.linkId }}</p>
            </div>
            <div style="display:flex;gap:.35rem;position:relative">
              <input type="text" v-model="keywordInputs[field.linkId]" class="cf-input" placeholder="Add keywords…" style="flex:1;min-width:0" />
              <button
                type="button" @click="suggestWikidataTags(field)" :disabled="wikidataLoading[field.linkId]"
                title="Suggest keywords from Wikidata"
                style="flex-shrink:0;width:28px;height:28px;border-radius:.4rem;border:1px solid var(--cf-border);background:var(--cf-bg-alt);cursor:pointer;display:flex;align-items:center;justify-content:center"
              >
                <i :class="wikidataLoading[field.linkId] ? 'fas fa-spinner fa-spin' : 'fas fa-wand-magic-sparkles'" style="font-size:.75rem;color:var(--color-primary)"></i>
              </button>
              <div v-if="wikidataCandidates[field.linkId]" style="position:absolute;z-index:20;top:100%;left:0;right:0;margin-top:.25rem;background:var(--cf-bg);border:1px solid var(--cf-border);border-radius:.5rem;box-shadow:0 8px 20px rgba(0,0,0,.15);padding:.35rem">
                <p v-if="wikidataCandidates[field.linkId].length === 0" style="font-size:.72rem;color:var(--cf-text);padding:.35rem">No Wikidata match found — enter keywords manually.</p>
                <button
                  v-for="c in wikidataCandidates[field.linkId]" :key="c.qid"
                  type="button" @click="applyWikidataConcept(field, c)"
                  style="display:block;width:100%;text-align:left;padding:.4rem .5rem;border:none;background:transparent;cursor:pointer;border-radius:.35rem;font-size:.72rem"
                >
                  <strong style="color:var(--cf-text-strong)">{{ c.label }}</strong>
                  <span style="color:var(--cf-text)"> — {{ c.description || 'no description' }}</span>
                </button>
                <button type="button" @click="dismissWikidataCandidates(field.linkId)" style="font-size:.68rem;color:var(--cf-text);background:transparent;border:none;cursor:pointer;padding:.3rem .5rem">Cancel</button>
              </div>
            </div>
          </div>
          <p style="font-size:.8rem;color:var(--cf-text);text-align:center;padding:.5rem 0" v-show="formFields().length === 0">Compile a form in Step 1 first — there are no fields to train yet.</p>
        </div>
      </div>

      <div class="cf-card" style="border-radius:1rem;padding:1.5rem;margin-bottom:1.25rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
          <h3 style="font-size:.9rem;font-weight:700;color:var(--cf-text-strong);display:flex;align-items:center;gap:.5rem"><i class="fas fa-microphone" style="color:var(--color-primary)"></i>Voice Room Dictation Stream Simulator</h3>
          <button v-if="auth.currentUser?.tier === 'paid'" class="btn-teal" @click="testVoiceScribeExtraction()" style="padding:.5rem 1rem;font-size:.78rem;display:flex;align-items:center;gap:.4rem">
            <i class="fas fa-bolt"></i>Trigger Scribe
          </button>
          <span v-else style="font-size:.78rem;color:var(--cf-text)">Voice-scribe testing requires a paid subscription.</span>
        </div>
        <textarea v-model="voiceTranscriptInput" class="cf-textarea" rows="3"></textarea>
      </div>

      <div class="cf-card" style="border-radius:1rem;padding:1.25rem 1.5rem">
        <button class="accordion-header" :class="accordionOpen.results ? '' : 'collapsed'" @click="toggleAccordion('results')" style="margin-top:0">
          <span class="section-eyebrow" style="margin:0"><i class="fas fa-terminal" style="margin-right:.35rem"></i>Scribe Run Results</span>
          <i class="fas fa-chevron-down"></i>
        </button>
        <div v-show="accordionOpen.results" style="margin-top:.9rem">
          <div style="margin-bottom:.9rem">
            <h3 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-robot" style="color:var(--color-primary)"></i>GBNF Masked LLM Output Capture Array</h3>
            <pre class="console-pre" style="height:90px">{{ llmResponseOutput ? JSON.stringify(llmResponseOutput, null, 2) : 'Awaiting dictation track execution scenario...' }}</pre>
          </div>
          <div>
            <h3 style="font-size:.85rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-share-nodes" style="color:var(--color-primary)"></i>Local Node.js $extract Interoperable Asset Graph</h3>
            <pre class="console-pre" style="height:90px">{{ localExtractedFhirGraph ? JSON.stringify(localExtractedFhirGraph, null, 2) : 'Awaiting extraction sequence verification pass...' }}</pre>
          </div>
        </div>
      </div>
    </div>

    </div>
    <!-- ════ end Designer View ════ -->

    <!-- ════ Data Explorer: Data Records (Patient/Encounter/custom form cards) ════ -->
    <div v-show="currentView === 'table' && activeCard && activeCard.kind === 'form'" class="step-panel">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1.5rem">
        <div>
          <span class="section-eyebrow" style="display:block;margin-bottom:.4rem">Data Explorer</span>
          <h2 style="font-size:1.5rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.35rem">Data Records</h2>
          <p style="font-size:.85rem;color:var(--cf-text)">Entries actually saved using this form. View opens them in the slide-over, prepopulated via the LHC-Forms FHIR data API.</p>
        </div>
        <button class="btn-teal" @click="openNewDataEntry()" :disabled="!blueprintJson" style="display:flex;align-items:center;gap:.5rem;white-space:nowrap">
          <i class="fas fa-plus"></i>New Entry
        </button>
      </div>

      <div class="cf-card" style="border-radius:1rem;padding:0;overflow:hidden">
        <AgGridVue
          :theme="gridTheme" :rowData="currentFormDataRecords()" :columnDefs="dataExplorerColumnDefs" :defaultColDef="dataExplorerDefaultColDef"
          pagination :paginationPageSize="10" domLayout="autoHeight" :getRowId="(p) => p.data.id"
          overlayNoRowsTemplate="No data saved for this form yet. Click New Entry to create one."
        />
      </div>
    </div>

    <!-- ════ Provider group table (Care Team/Administrators/Services/Hours/Consents/Branches/
         Appointments cards) — one row per repeating-group instance inside the ONE shared
         Provider record, not one row per formData record (there's only ever one). ════ -->
    <div v-show="currentView === 'table' && activeCard && activeCard.kind === 'group'" class="step-panel">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1.5rem">
        <div>
          <span class="section-eyebrow" style="display:block;margin-bottom:.4rem">{{ activeCard ? activeCard.title : '' }}</span>
          <h2 style="font-size:1.5rem;font-weight:700;color:var(--cf-text-strong);margin-bottom:.35rem">{{ activeCard ? activeCard.desc : '' }}</h2>
        </div>
        <button class="btn-teal" @click="openProviderDrawer(activeCard)" style="display:flex;align-items:center;gap:.5rem;white-space:nowrap">
          <i class="fas fa-plus"></i>Add
        </button>
      </div>

      <div class="cf-card" style="border-radius:1rem;padding:0;overflow:hidden">
        <AgGridVue
          :theme="gridTheme" :rowData="activeCard ? groupInstancesForCard(activeCard) : []" :defaultColDef="dataExplorerDefaultColDef"
          :columnDefs="[
            { headerName: 'Record', valueGetter: (p) => instanceSummary(p.data, p.node.rowIndex), flex: 1.4 },
            { headerName: 'Actions', cellRenderer: GridActionsCell, cellRendererParams: { onView: () => openProviderDrawer(activeCard) }, flex: 0.6, sortable: false, filter: false },
          ]"
          pagination :paginationPageSize="10" domLayout="autoHeight"
          overlayNoRowsTemplate="Nothing added yet. Click Add to open the form."
        />
      </div>
    </div>

    </div>

    <!-- ── Room-Designer: Design & Compile Room / Forms Authoring (SPEC-22 §5.8/§5.11) — a
         DIFFERENT YAML/session entirely from the form-designer above: this compiles/extracts the
         ROOM's own workflow-definition plan, not any one entity's data-capture composition. ── -->
    <div v-show="currentView === 'room-designer' && activeRoom">
      <button class="btn-outline" @click="backToRoom()" style="font-size:.75rem;padding:.4rem 1rem;margin-bottom:1.25rem;display:flex;align-items:center;gap:.4rem">
        <i class="fas fa-arrow-left"></i>Back to {{ activeRoom?.title }}
      </button>

      <!-- ── Step Progress Bar (room-designer's own — see roomSteps/roomStep) ── -->
      <div style="display:flex;align-items:center;justify-content:center;gap:1.25rem;margin-bottom:2rem">
        <button class="step-nav-btn" @click="roomStep = Math.max(0, roomStep - 1)" :disabled="roomStep === 0" title="Previous step"><i class="fas fa-chevron-left"></i></button>
        <template v-for="(s, i) in roomSteps" :key="s.id">
          <div style="display:flex;align-items:center;gap:.5rem;cursor:pointer" @click="roomStep = i">
            <div class="step-dot" :class="i === roomStep ? 'active' : (i < roomStep ? 'done' : 'pending')">{{ i + 1 }}</div>
            <span style="font-size:.8rem;font-weight:700;color:var(--cf-text-strong)">{{ s.label }}</span>
          </div>
          <div v-if="i < roomSteps.length - 1" class="step-connector" :class="i < roomStep ? 'done' : ''"></div>
        </template>
        <button class="step-nav-btn" @click="roomStep = Math.min(roomSteps.length - 1, roomStep + 1)" :disabled="roomStep === roomSteps.length - 1" title="Next step"><i class="fas fa-chevron-right"></i></button>
      </div>

      <!-- ── Step 1: Design & Compile Room ── -->
      <div v-show="roomStep === 0" class="step-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
          <div>
            <span class="cf-label" style="display:block">{{ activeRoom?.title }} — Workflow YAML</span>
            <p style="font-size:.75rem;color:var(--cf-text)" v-show="!roomFlowExists">No plan authored yet for this room — starting from a blank scaffold.</p>
            <p style="font-size:.75rem;color:var(--cf-text)" v-show="roomFlowExists && !ROOM_RUNTIME_WIRED.includes(activeRoom?.roomId)">Saved plans here aren't wired to a live runtime — Facility/Provider/Patient are real pages by design, not PlanDefinition-driven.</p>
          </div>
          <button class="btn-teal" @click="compileRoomWorkflow()" style="padding:.5rem 1rem;font-size:.78rem;display:flex;align-items:center;gap:.4rem"><i class="fas fa-hammer"></i>Compile</button>
        </div>
        <div ref="roomAceYamlEditorEl" style="height:380px;border-radius:.6rem;overflow:hidden;border:1px solid var(--cf-border)"></div>

        <template v-if="roomBlueprintJson">
          <div style="display:flex;align-items:center;justify-content:space-between;margin:1.25rem 0 .5rem">
            <span class="cf-label">Fill in the compiled steps form, then extract the real plan</span>
            <button class="btn-outline" @click="extractRoomPlan()" style="padding:.45rem .9rem;font-size:.76rem;display:flex;align-items:center;gap:.4rem"><i class="fas fa-wand-magic-sparkles"></i>Extract Plan</button>
          </div>
          <div class="cf-card" style="padding:.75rem;border-radius:.6rem"><div id="roomAuthoringFormContainer"></div></div>
        </template>

        <p style="font-size:.75rem;color:#EF4444;margin-top:.6rem" v-show="roomSaveError">{{ roomSaveError }}</p>
        <p style="font-size:.72rem;color:#F59E0B;margin-top:.4rem" v-show="roomExtractedWarnings.length">Extraction warnings: {{ roomExtractedWarnings.join('; ') }}</p>

        <template v-if="roomExtractedPlan">
          <div style="display:flex;align-items:center;justify-content:space-between;margin:1.25rem 0 .5rem">
            <span class="cf-label">Extracted plan — {{ roomExtractedPlan.action?.length || 0 }} action{{ roomExtractedPlan.action?.length === 1 ? '' : 's' }}</span>
            <button class="btn-teal" @click="saveRoomPlan()" style="padding:.5rem 1rem;font-size:.78rem;display:flex;align-items:center;gap:.4rem"><i class="fas fa-save"></i>Save Room Plan</button>
          </div>
          <div class="cf-card" style="padding:.6rem .75rem;border-radius:.6rem">
            <div v-for="a in roomExtractedPlan.action" :key="a.id" class="version-row">
              <span><strong>{{ a.title }}</strong> <span style="color:var(--cf-text)">({{ a.id }})</span></span>
              <span style="font-size:.68rem;color:var(--cf-text)" v-show="a.relatedAction?.length">after {{ a.relatedAction.map((r) => r.actionId).join(', ') }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- ── Step 2: Forms Authoring from this Room — replaces "Training the Form" for a room's
           own session; for each real saved action, which entity card (if any) already renders
           it. ── -->
      <div v-show="roomStep === 1" class="step-panel">
        <span class="cf-label" style="display:block;margin-bottom:.4rem">Forms Authoring — {{ activeRoom?.title }}</span>
        <p style="font-size:.78rem;color:var(--cf-text);margin-bottom:1rem" v-show="!roomSavedPlanDefinition">No saved plan for this room yet — compile and save one in Design &amp; Compile Room first.</p>
        <div v-show="roomSavedPlanDefinition" class="cf-card" style="padding:.6rem .75rem;border-radius:.6rem">
          <div v-for="entry in roomActionLinks" :key="entry.action.id" class="version-row">
            <span>
              <strong>{{ entry.action.title }}</strong>
              <span style="color:var(--cf-text)"> ({{ entry.action.id }})</span>
            </span>
            <span v-if="entry.card" class="badge badge-teal" style="cursor:pointer" @click="openCard(entry.card)">Linked → {{ entry.card.title }}</span>
            <span v-else class="badge badge-muted">Not yet linked</span>
          </div>
        </div>
      </div>
    </div>

  </div>
  </main>
    </div>
  </div>
</template>

<style>
/* ─── Forms Library sidebar (specific to this page only) ─── */
.form-entry { border:1px solid var(--cf-border);border-radius:.75rem;padding:.7rem .8rem;margin-bottom:.5rem;background:var(--cf-bg-alt); }
.form-entry.archived { opacity:.55; }
.version-row { display:flex;align-items:center;justify-content:space-between;padding:.4rem 0;border-top:1px solid var(--cf-border);font-size:.75rem; }
.sidebar-item { flex:1;min-width:0;text-align:left;background:none;border:none;cursor:pointer;font:inherit;color:var(--cf-text);display:flex;align-items:center;gap:.5rem;padding:.2rem;border-radius:.4rem;font-weight:700;font-size:.85rem; }
.sidebar-item:hover { color:var(--color-primary); }
.sidebar-item.active { color:var(--color-primary); }

/* ─── Step Progress ─── */
.step-connector { flex:1;height:2px;background:var(--cf-border);border-radius:2px;margin:0 .5rem;transition:background .3s; }
.step-connector.done { background:var(--color-primary); }
.step-dot { width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-family:'Poppins',sans-serif;font-weight:700;font-size:.8rem;transition:all .25s;border:2px solid var(--cf-border); }
.step-dot.active { background:var(--color-secondary);color:#fff;border-color:var(--color-secondary);box-shadow:0 0 0 4px rgba(10,37,64,.15); }
.dark .step-dot.active { background:var(--color-primary);color:var(--color-secondary);border-color:var(--color-primary); }
.step-dot.done { background:var(--color-primary);color:var(--color-secondary);border-color:var(--color-primary); }
.step-dot.pending { background:var(--cf-bg-alt);color:var(--cf-text); }
.step-panel { animation:fadeUp .25s ease; }
@keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
.step-nav-btn { width:36px;height:36px;border-radius:50%;flex-shrink:0;border:1.5px solid var(--cf-border);background:var(--cf-bg-alt);color:var(--cf-text-strong);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;font-size:.8rem; }
.step-nav-btn:hover:not(:disabled) { border-color:var(--color-primary);color:var(--color-primary);background:rgba(0,212,178,.08); }
.step-nav-btn:disabled { opacity:.35;cursor:not-allowed; }

/* ─── Accordion ─── */
.accordion-header { width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:none;cursor:pointer;padding:.4rem 0;margin-top:.5rem; }
.accordion-header i { font-size:.65rem;color:var(--cf-text);transition:transform .2s; }
.accordion-header.collapsed i { transform:rotate(-90deg); }

/* ─── Row icon buttons (bookmark, context menu) ─── */
.icon-btn { background:none;border:none;cursor:pointer;color:var(--cf-text);flex-shrink:0;padding:.15rem;font-size:.78rem; }
.icon-btn:hover { color:var(--color-primary); }
.icon-btn.bookmarked { color:#F59E0B; }

/* ─── Context menu ─── */
.context-menu { position:absolute;right:0;top:100%;margin-top:.25rem;background:var(--cf-bg);border:1px solid var(--cf-border);border-radius:.5rem;box-shadow:0 10px 24px rgba(0,0,0,.18);z-index:30;min-width:170px;overflow:hidden; }
.context-menu-item { display:flex;align-items:center;gap:.5rem;width:100%;text-align:left;padding:.5rem .75rem;font-size:.76rem;background:none;border:none;cursor:pointer;color:var(--cf-text);font-family:'Inter',sans-serif; }
.context-menu-item:hover { background:var(--cf-bg-alt);color:var(--color-primary); }

/* ─── Preview / console panels ─── */
.console-pre { font-family:'JetBrains Mono',monospace;font-size:.72rem;background:var(--cf-bg);border:1px solid var(--cf-border);border-radius:.5rem;padding:.875rem;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--cf-text-strong); }

/* ─── LHC-Forms overrides ─── */
.lformsContainer,.lfForm { background:transparent !important; }
</style>
