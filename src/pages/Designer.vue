<script setup>
// Ported from clinixflow's public/designer.html — the "Room Architect" workspace: a two-step
// Compile & Preview / Training the Form designer plus a Forms Library sidebar and Data Explorer,
// all built around the same YAML -> FHIR Questionnaire compiler and SystemForms LForms glue every
// other page uses. Unlike the other pages, this one kept ALL its state in one big inline Alpine
// x-data object with no Alpine.store dependency beyond 'theme' — ported the same way, as page-
// local state, since nothing here is needed by any other page.
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
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
import AiEngineSandbox from './AiEngineSandbox.vue';
import {
  formsLibrary, seedSystemForms, activeVersionNumber, SYSTEM_FORM_IDS,
  listDataRecords, saveDataRecord, deleteDataRecord, recordSummary,
  renderBlank, renderWithRecord, extractResponse,
} from '../data/useSystemForms.js';
import { useThemeStore } from '../stores/theme.js';
import { useAuthStore } from '../stores/auth.js';
import { useCuboStore } from '../stores/cubo.js';
import { API_BASE, apiFetch } from '../config.js';

const theme = useThemeStore();
const auth = useAuthStore();
const cubo = useCuboStore();
// This page hosts Cübo full-time (same choice ConsultationDesk.vue/Checkout.vue/FrontDesk.vue
// already made), so start expanded rather than the collapsed FAB badge.
cubo.currentLayout = 'EXPANDED';

// Merged from the former standalone AiEngine.vue (see clinux-ai-engine-designer-merge-tanstack-
// table memory note) — one shared Cübo instance now serves both halves of this page; which half
// its cubo-api-submit emit actually reaches is just a matter of which tab is showing.
const primaryTab = ref('formsLibrary'); // 'formsLibrary' | 'sandbox'
const aiEngineSandboxRef = ref(null);
function onCuboSubmit(payload) {
  aiEngineSandboxRef.value?.classifyAndExecute(payload);
}

const currentView = ref('designer'); // 'designer' | 'dataExplorer'
const currentStep = ref(0);
const steps = [
  { id: 'compile', label: 'Compile & Preview' },
  { id: 'train', label: 'Training the Form' },
];

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
const accordionOpen = reactive({ bookmarked: true, system: true, user: true, results: false, compileDetails: false });
const openMenuFormId = ref(null);
const previewDrawerOpen = ref(false);
const saveAsMenuOpen = ref(false);
const activeDataRecordId = ref(null);
const currentVersionNumber = ref(null);
// Captured once via the '+ New Form' drawer for a brand-new (zero-version) form and consumed by
// saveToLibrary()'s very first save, since the library's own version counter otherwise always
// starts a new formId at v1 — see confirmNewForm()/saveToLibrary().
const pendingStartVersion = ref(null);
const newFormDrawerOpen = ref(false);
const newFormDraft = reactive({ formId: 'new-form-v1', title: 'New Form', version: 1 });

// Both drawers are page-level overlays (not scoped inside the Forms Library tab's own v-show
// block), so leaving one open while switching to Sandbox Data would float over that tab's
// content too, with its backdrop blocking every click there. Found during live verification of
// this merge, not anticipated at design time.
watch(primaryTab, () => {
  previewDrawerOpen.value = false;
  newFormDrawerOpen.value = false;
});
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

const voiceTranscriptInput = ref('Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet lisinopril 10mg.');
const llmResponseOutput = ref(null);
const localExtractedFhirGraph = ref(null);

onMounted(async () => {
  const changed = await seedSystemForms(API_BASE).catch(() => false);
  if (changed) libraryVersion.value++;

  const res = await apiFetch(`${API_BASE}/api/workflow/default-blueprint`).then((r) => r.json()).catch(() => ({ success: false }));
  if (res.success) {
    yamlInput.value = res.yaml;
    await compileWorkflow();
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

async function compileWorkflow() {
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
    previewDrawerOpen.value = true;
  } else {
    showToast('Compiler Error: ' + res.error);
  }
}

function closeDrawer() { previewDrawerOpen.value = false; }

function renderBlueprintPreview() {
  if (blueprintJson.value) renderBlank(blueprintJson.value, 'formContainer');
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

function formIcon(formId) {
  if (formId.includes('hospital')) return 'fas fa-hospital';
  if (formId.includes('patient')) return 'fas fa-user-injured';
  if (formId.includes('staff')) return 'fas fa-user-md';
  if (formId.includes('services')) return 'fas fa-stethoscope';
  if (formId.includes('consent')) return 'fas fa-file-signature';
  if (formId.includes('appointment')) return 'fas fa-calendar-alt';
  if (formId.includes('office-hours')) return 'fas fa-clock';
  if (formId.includes('locations')) return 'fas fa-map-marker-alt';
  return 'fas fa-file-lines';
}

function matchesSearch(formId) {
  const q = formSearchQuery.value.trim().toLowerCase();
  if (!q) return true;
  return formTitle(formId).toLowerCase().includes(q) || formId.toLowerCase().includes(q);
}

// Bookmarked forms (from either group) float to a dedicated section above everything else —
// system forms keep their fixed order, user forms stay most-recent-first.
function bookmarkedFormIds() {
  libraryVersion.value;
  const rows = formsLibrary.toArray;
  return rows
    .filter((r) => r.bookmarked)
    .filter((r) => libraryShowArchived.value || !r.archived)
    .filter((r) => matchesSearch(r.formId))
    .map((r) => r.formId)
    .sort((a, b) => {
      const aSys = SYSTEM_FORM_IDS.includes(a), bSys = SYSTEM_FORM_IDS.includes(b);
      if (aSys !== bSys) return aSys ? -1 : 1;
      if (aSys && bSys) return SYSTEM_FORM_IDS.indexOf(a) - SYSTEM_FORM_IDS.indexOf(b);
      const eA = formEntry(a), eB = formEntry(b);
      const latestA = eA.versions[eA.versions.length - 1]?.savedAt || '';
      const latestB = eB.versions[eB.versions.length - 1]?.savedAt || '';
      return latestB.localeCompare(latestA);
    });
}

// System forms: fixed display order. Bookmarked ones move up to the Bookmarked section instead
// of appearing here too.
function systemFormIds() {
  libraryVersion.value;
  return SYSTEM_FORM_IDS
    .filter((id) => formsLibrary.has(id) && !formEntry(id).bookmarked)
    .filter((id) => matchesSearch(id));
}

// User-created forms: most-recently-saved first; archived ones only included if the Show
// archived toggle is on; bookmarked ones move up to the Bookmarked section.
function userFormIds() {
  libraryVersion.value;
  return formsLibrary.toArray
    .filter((r) => !r.isSystem && !r.bookmarked)
    .filter((r) => libraryShowArchived.value || !r.archived)
    .filter((r) => matchesSearch(r.formId))
    .map((r) => r.formId)
    .sort((a, b) => {
      const eA = formEntry(a), eB = formEntry(b);
      if (eA.archived !== eB.archived) return eA.archived ? 1 : -1;
      const latestA = eA.versions[eA.versions.length - 1]?.savedAt || '';
      const latestB = eB.versions[eB.versions.length - 1]?.savedAt || '';
      return latestB.localeCompare(latestA);
    });
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
      const sel = primaryTab.value === 'sandbox' ? '[data-sandbox-search]' : '[data-library-search]';
      document.querySelector(sel)?.focus();
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

// Sidebar rows open straight into Data Explorer by default; Designer View is reached via each
// form's context menu (or the persistent toggle once a form is loaded).
function openInDataExplorer(formId) {
  loadVersionIntoEditor(formId, activeVersionNumber(formId));
  currentView.value = 'dataExplorer';
}

function openInDesigner(formId) {
  loadVersionIntoEditor(formId, activeVersionNumber(formId));
  currentView.value = 'designer';
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
  Object.assign(newFormDraft, { formId: 'new-form-v1', title: 'New Form', version: 1 });
  previewDrawerOpen.value = false; // avoid stacking two drawer-backdrops at once
  newFormDrawerOpen.value = true;
}

function buildBlankFormTemplate(formId, title) {
  const safeTitle = String(title).replace(/"/g, '\\"');
  return `formId: ${formId}
title: "${safeTitle}"
composition:
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

function confirmNewForm() {
  const formId = (newFormDraft.formId || '').trim();
  const title = (newFormDraft.title || '').trim();
  const version = parseInt(newFormDraft.version, 10);
  if (!formId || !title || !Number.isFinite(version) || version < 1) {
    showToast('Form ID, Title, and a valid starting Version (1 or higher) are all required.');
    return;
  }
  yamlInput.value = buildBlankFormTemplate(formId, title);
  pendingStartVersion.value = version;
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
    formsLibrary.insert({ formId, isSystem: false, archived: false, bookmarked: false, activeVersion: nextVersion, versions: [versionRow] });
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
      <input type="number" min="1" step="1" v-model.number="newFormDraft.version" class="cf-input" style="width:100%" />
    </div>
    <div class="drawer-footer">
      <button class="btn-ghost" @click="cancelNewForm()">Cancel</button>
      <button class="btn-teal" @click="confirmNewForm()" style="display:flex;align-items:center;gap:.4rem"><i class="fas fa-plus"></i>Create</button>
    </div>
  </div>

  <div class="flex-1 flex overflow-hidden">
    <!-- LEFT: Cübo, same confined-pane pattern as Front Desk/Consultation Desk/Checkout. One
         shared instance now serves both tabs — onCuboSubmit() forwards to whichever one is
         showing (only Sandbox Data actually consumes it; Forms Library ignores the emit). -->
    <div class="w-[380px] shrink-0 flex flex-col border-r" style="border-color:var(--cf-border)">
      <div class="cubo-inline-host flex-1" style="min-height:420px">
        <Cubo category="ai-engine" page-context="ClinüxFlow Room Architect — form design/library on the Forms Library tab, natural-language sandbox patient/staff/encounter management on Sandbox Data." @cubo-api-submit="onCuboSubmit" />
      </div>
    </div>

    <!-- RIGHT: primary tabs + content -->
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden">
      <!-- z-index above .drawer-backdrop's 100 — otherwise a click here while either drawer is
           open lands on the fixed, full-viewport backdrop instead (it would just close the
           drawer rather than switch tabs) since these buttons sit at z-index:auto by default.
           Found during live verification of this merge, not anticipated at design time. -->
      <div style="display:flex;gap:.5rem;padding:1rem 1.5rem 0;flex-shrink:0;position:relative;z-index:110">
        <button class="btn-outline" :class="primaryTab === 'formsLibrary' ? 'btn-teal' : ''" @click="primaryTab = 'formsLibrary'" style="font-size:.78rem">
          <i class="fas fa-pen-ruler" style="margin-right:.4rem"></i>Forms Library
        </button>
        <button class="btn-outline" :class="primaryTab === 'sandbox' ? 'btn-teal' : ''" @click="primaryTab = 'sandbox'" style="font-size:.78rem">
          <i class="fas fa-flask" style="margin-right:.4rem"></i>Sandbox Data
        </button>
      </div>

      <div v-show="primaryTab === 'sandbox'" style="flex:1;overflow:hidden;padding:1rem 1.5rem">
        <AiEngineSandbox ref="aiEngineSandboxRef" />
      </div>

  <main v-show="primaryTab === 'formsLibrary'" style="flex:1;overflow:hidden;display:flex;justify-content:center">
  <div style="max-width:1500px;width:100%;display:flex;gap:1.5rem;padding:1.5rem;overflow:hidden">

    <!-- ── LEFT: Forms Library ── -->
    <aside style="width:300px;flex-shrink:0;display:flex;flex-direction:column;overflow-y:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
        <span class="cf-label" style="margin:0">Forms Library</span>
        <button class="btn-ghost" @click="startNewForm()" style="padding:.3rem .6rem;font-size:.7rem;display:flex;align-items:center;gap:.3rem">
          <i class="fas fa-plus"></i>New
        </button>
      </div>

      <div style="position:relative;margin-bottom:.5rem">
        <i class="fas fa-search" style="position:absolute;left:.65rem;top:50%;transform:translateY(-50%);font-size:.68rem;color:var(--cf-text)"></i>
        <input type="text" data-library-search :value="formSearchInput" @input="onFormSearchInput($event.target.value)" placeholder="Search forms…" class="cf-input" style="padding-left:1.8rem" />
      </div>

      <!-- ── Bookmarked ── -->
      <div v-if="bookmarkedFormIds().length > 0">
        <button class="accordion-header" :class="accordionOpen.bookmarked ? '' : 'collapsed'" @click="toggleAccordion('bookmarked')">
          <span class="section-eyebrow" style="margin:0"><i class="fas fa-star" style="margin-right:.35rem;color:#F59E0B"></i>Bookmarked</span>
          <i class="fas fa-chevron-down"></i>
        </button>
        <div v-show="accordionOpen.bookmarked">
          <div v-for="formId in bookmarkedFormIds()" :key="'bm-' + formId" class="form-entry" :class="formEntry(formId).archived ? 'archived' : ''">
            <div style="display:flex;align-items:center;gap:.35rem">
              <button class="icon-btn bookmarked" @click.stop="toggleBookmark(formId)" title="Unbookmark"><i class="fas fa-star"></i></button>
              <button class="sidebar-item" :class="blueprintJson && blueprintJson.id === formId ? 'active' : ''" @click="openInDataExplorer(formId)">
                <i :class="formIcon(formId)" style="width:14px;text-align:center;flex-shrink:0;font-size:.8rem"></i>
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ formTitle(formId) }}</span>
              </button>
              <div style="position:relative">
                <button class="icon-btn" @click.stop="toggleMenu('bm-' + formId)"><i class="fas fa-ellipsis-vertical"></i></button>
                <div class="context-menu" v-show="openMenuFormId === ('bm-' + formId)">
                  <button class="context-menu-item" @click="openInDesigner(formId); closeMenu()"><i class="fas fa-pen-ruler"></i>Designer View</button>
                  <button class="context-menu-item" @click="toggleExpand(formId); closeMenu()"><i class="fas fa-clock-rotate-left"></i>Show Versions</button>
                  <button class="context-menu-item" v-show="!formEntry(formId).isSystem" @click="toggleArchive(formId); closeMenu()">
                    <i class="fas" :class="formEntry(formId).archived ? 'fa-box-open' : 'fa-box-archive'"></i>
                    <span>{{ formEntry(formId).archived ? 'Restore' : 'Archive' }}</span>
                  </button>
                  <label class="context-menu-item" style="cursor:pointer"><input type="checkbox" v-model="libraryShowArchived" />Show Archived</label>
                </div>
              </div>
            </div>

            <div v-show="libraryExpanded[formId]" style="padding-left:1.4rem;margin-top:.4rem">
              <div v-for="v in [...formEntry(formId).versions].reverse()" :key="v.version" class="version-row">
                <span>
                  <strong>v{{ v.version }}</strong>
                  <span class="badge" :class="v.status === 'final' ? 'badge-teal' : 'badge-muted'" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem">{{ (v.status || 'draft').toUpperCase() }}</span>
                  <span class="badge badge-teal" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem" v-show="v.version === activeVersionNumber(formId)">ACTIVE</span>
                  <span style="color:var(--cf-text)">{{ ' · ' + new Date(v.savedAt).toLocaleDateString() }}</span>
                </span>
                <div style="display:flex;gap:.3rem;flex-shrink:0">
                  <button class="btn-ghost" style="font-size:.62rem;padding:.2rem .45rem" @click="loadVersionIntoEditor(formId, v.version)">Load</button>
                  <button class="btn-outline" style="font-size:.62rem;padding:.2rem .45rem" v-show="v.version !== activeVersionNumber(formId)" @click="setActiveVersion(formId, v.version)">Set Active</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── System Forms ── -->
      <button class="accordion-header" :class="accordionOpen.system ? '' : 'collapsed'" @click="toggleAccordion('system')">
        <span class="section-eyebrow" style="margin:0">System Forms</span>
        <i class="fas fa-chevron-down"></i>
      </button>
      <div v-show="accordionOpen.system">
        <div v-for="formId in systemFormIds()" :key="formId" class="form-entry">
          <div style="display:flex;align-items:center;gap:.35rem">
            <button class="icon-btn" :class="formEntry(formId).bookmarked ? 'bookmarked' : ''" @click.stop="toggleBookmark(formId)" title="Bookmark">
              <i :class="formEntry(formId).bookmarked ? 'fas fa-star' : 'far fa-star'"></i>
            </button>
            <button class="sidebar-item" :class="blueprintJson && blueprintJson.id === formId ? 'active' : ''" @click="openInDataExplorer(formId)">
              <i :class="formIcon(formId)" style="width:14px;text-align:center;flex-shrink:0;font-size:.8rem"></i>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ formTitle(formId) }}</span>
            </button>
            <div style="position:relative">
              <button class="icon-btn" @click.stop="toggleMenu(formId)"><i class="fas fa-ellipsis-vertical"></i></button>
              <div class="context-menu" v-show="openMenuFormId === formId">
                <button class="context-menu-item" @click="openInDesigner(formId); closeMenu()"><i class="fas fa-pen-ruler"></i>Designer View</button>
                <button class="context-menu-item" @click="toggleExpand(formId); closeMenu()"><i class="fas fa-clock-rotate-left"></i>Show Versions</button>
                <label class="context-menu-item" style="cursor:pointer"><input type="checkbox" v-model="libraryShowArchived" />Show Archived</label>
              </div>
            </div>
          </div>

          <div v-show="libraryExpanded[formId]" style="padding-left:1.4rem;margin-top:.4rem">
            <div v-for="v in [...formEntry(formId).versions].reverse()" :key="v.version" class="version-row">
              <span>
                <strong>v{{ v.version }}</strong>
                <span class="badge badge-teal" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem" v-show="v.version === activeVersionNumber(formId)">ACTIVE</span>
                <span style="color:var(--cf-text)">{{ ' · ' + new Date(v.savedAt).toLocaleDateString() }}</span>
              </span>
              <div style="display:flex;gap:.3rem;flex-shrink:0">
                <button class="btn-ghost" style="font-size:.62rem;padding:.2rem .45rem" @click="loadVersionIntoEditor(formId, v.version)">Load</button>
                <button class="btn-outline" style="font-size:.62rem;padding:.2rem .45rem" v-show="v.version !== activeVersionNumber(formId)" @click="setActiveVersion(formId, v.version)">Set Active</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── My Forms ── -->
      <button class="accordion-header" :class="accordionOpen.user ? '' : 'collapsed'" @click="toggleAccordion('user')">
        <span class="section-eyebrow" style="margin:0">My Forms</span>
        <i class="fas fa-chevron-down"></i>
      </button>
      <div v-show="accordionOpen.user">
        <div v-for="formId in userFormIds()" :key="formId" class="form-entry" :class="formEntry(formId).archived ? 'archived' : ''">
          <div style="display:flex;align-items:center;gap:.35rem">
            <button class="icon-btn" :class="formEntry(formId).bookmarked ? 'bookmarked' : ''" @click.stop="toggleBookmark(formId)" title="Bookmark">
              <i :class="formEntry(formId).bookmarked ? 'fas fa-star' : 'far fa-star'"></i>
            </button>
            <button class="sidebar-item" :class="blueprintJson && blueprintJson.id === formId ? 'active' : ''" @click="openInDataExplorer(formId)">
              <i :class="formIcon(formId)" style="width:14px;text-align:center;flex-shrink:0;font-size:.8rem"></i>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ formTitle(formId) }}</span>
            </button>
            <div style="position:relative">
              <button class="icon-btn" @click.stop="toggleMenu(formId)"><i class="fas fa-ellipsis-vertical"></i></button>
              <div class="context-menu" v-show="openMenuFormId === formId">
                <button class="context-menu-item" @click="openInDesigner(formId); closeMenu()"><i class="fas fa-pen-ruler"></i>Designer View</button>
                <button class="context-menu-item" @click="toggleExpand(formId); closeMenu()"><i class="fas fa-clock-rotate-left"></i>Show Versions</button>
                <button class="context-menu-item" @click="toggleArchive(formId); closeMenu()">
                  <i class="fas" :class="formEntry(formId).archived ? 'fa-box-open' : 'fa-box-archive'"></i>
                  <span>{{ formEntry(formId).archived ? 'Restore' : 'Archive' }}</span>
                </button>
                <label class="context-menu-item" style="cursor:pointer"><input type="checkbox" v-model="libraryShowArchived" />Show Archived</label>
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:.35rem;margin-top:.3rem;padding-left:1.75rem">
            <span class="badge badge-muted" style="font-size:.58rem;padding:.1rem .5rem" v-show="formEntry(formId).archived">ARCHIVED</span>
          </div>

          <div v-show="libraryExpanded[formId]" style="padding-left:1.4rem;margin-top:.4rem">
            <div v-for="v in [...formEntry(formId).versions].reverse()" :key="v.version" class="version-row">
              <span>
                <strong>v{{ v.version }}</strong>
                <span class="badge badge-teal" style="font-size:.55rem;padding:.05rem .4rem;margin-left:.25rem" v-show="v.version === activeVersionNumber(formId)">ACTIVE</span>
                <span style="color:var(--cf-text)">{{ ' · ' + new Date(v.savedAt).toLocaleDateString() }}</span>
              </span>
              <div style="display:flex;gap:.3rem;flex-shrink:0">
                <button class="btn-ghost" style="font-size:.62rem;padding:.2rem .45rem" @click="loadVersionIntoEditor(formId, v.version)">Load</button>
                <button class="btn-outline" style="font-size:.62rem;padding:.2rem .45rem" v-show="v.version !== activeVersionNumber(formId)" @click="setActiveVersion(formId, v.version)">Set Active</button>
              </div>
            </div>
          </div>
        </div>

        <p style="font-size:.75rem;color:var(--cf-text);text-align:center;padding:1rem 0" v-show="userFormIds().length === 0">No custom forms yet — click New, or Save to Library from Step 1.</p>
      </div>
    </aside>

    <!-- ── RIGHT: Designer View / Data Explorer ── -->
    <div style="flex:1;min-width:0;overflow-y:auto">

    <div style="display:flex;gap:.5rem;justify-content:center;margin-bottom:1.5rem">
      <button class="btn-outline" :class="currentView === 'designer' ? 'btn-teal' : ''" @click="currentView = 'designer'" style="font-size:.75rem;padding:.4rem 1.1rem">
        <i class="fas fa-pen-ruler" style="margin-right:.35rem"></i>Designer View
      </button>
      <button class="btn-outline" :class="currentView === 'dataExplorer' ? 'btn-teal' : ''" @click="currentView = 'dataExplorer'" style="font-size:.75rem;padding:.4rem 1.1rem">
        <i class="fas fa-table-list" style="margin-right:.35rem"></i>Data Explorer
      </button>
    </div>

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
            <input type="text" v-model="keywordInputs[field.linkId]" class="cf-input" placeholder="Add keywords…" />
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

    <!-- ════ Data Explorer: Data Records ════ -->
    <div v-show="currentView === 'dataExplorer'" class="step-panel">
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
