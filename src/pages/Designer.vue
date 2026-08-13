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
import AiEngineSandbox from './AiEngineSandbox.vue';
import {
  formData, formsLibrary, seedSystemForms, activeVersionNumber, activeQuestionnaire, SYSTEM_FORM_IDS,
  listDataRecords, saveDataRecord, deleteDataRecord, recordSummary,
  getAnswer, getGroupInstances,
  renderBlank, renderWithRecord, extractResponse,
} from '../data/useSystemForms.js';
import { useThemeStore } from '../stores/theme.js';
import { useAuthStore } from '../stores/auth.js';
import { useCuboStore } from '../stores/cubo.js';
import { useOnboardingStore } from '../stores/onboarding.js';
import { API_BASE, apiFetch } from '../config.js';

const router = useRouter();
const theme = useThemeStore();
const auth = useAuthStore();
const cubo = useCuboStore();
// The 8 Provider-composition entity cards below (Hospital/Staff/Administrators/Services/Hours/
// Consents/Branches/Appointments) read and write the ONE shared Provider record the same way
// Onboarding.vue's own journeyCards do — see clinux-provider-composition-merge memory note.
const onboarding = useOnboardingStore();
// This page hosts Cübo full-time (same choice ConsultationDesk.vue/Checkout.vue/FrontDesk.vue
// already made), so start expanded rather than the collapsed FAB badge.
cubo.currentLayout = 'EXPANDED';

// Merged from the former standalone AiEngine.vue (see clinux-ai-engine-designer-merge-tanstack-
// table memory note) — one shared Cübo instance now serves both halves of this page; which half
// its cubo-api-submit emit actually reaches is just a matter of which tab is showing.
//
// This route has no requiresAuth guard (see clinux-authenticated-vs-sandbox-mode memory note) —
// Sandbox Data is a deliberately isolated demo, safe for anyone to reach, but Forms Library holds
// the real Provider-composition data, so an unauthenticated visitor only ever lands on/stays on
// Sandbox Data; there is nothing behind Forms Library for them, so its own tab button is hidden
// rather than shown-but-disabled.
const primaryTab = ref(auth.currentUser ? 'formsLibrary' : 'sandbox'); // 'formsLibrary' | 'sandbox'
// Logging out while on Forms Library (e.g. via another tab) must not leave a signed-out visitor
// looking at real clinic data — same reasoning a moment ago, just reactive to a session change
// instead of only checked once at mount.
watch(() => auth.currentUser, (user) => {
  if (!user) primaryTab.value = 'sandbox';
});
const aiEngineSandboxRef = ref(null);
function onCuboSubmit(payload) {
  aiEngineSandboxRef.value?.classifyAndExecute(payload);
}

// 'cards' (new default landing — see clinux-settings-page-entity-cards memory note) | 'table'
// (drilled into one card's records/instances) | 'designer' (the Step 1/2 compile-and-train
// workflow, reached via a card's context menu instead of always being the landing view).
const currentView = ref('cards');
// The card currently drilled into (table/designer view) — null while on the card grid itself.
const activeCard = ref(null);
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
const newFormDrawerOpen = ref(false);
// journey: '' | 'patient' | 'hospital' — see clinux-custom-forms-in-patient-hospital-journeys
// memory note. Written into the generated YAML template's own journey: line, same field
// clinuxflow-api's compiler now passes through onto the compiled Questionnaire.
const newFormDraft = reactive({ formId: 'new-form-v1', title: 'New Form', version: 1, journey: '' });

// Both drawers are page-level overlays (not scoped inside the Forms Library tab's own v-show
// block), so leaving one open while switching to Sandbox Data would float over that tab's
// content too, with its backdrop blocking every click there. Found during live verification of
// this merge, not anticipated at design time.
watch(primaryTab, () => {
  previewDrawerOpen.value = false;
  newFormDrawerOpen.value = false;
  providerDrawerOpen.value = false;
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
const PROVIDER_CARDS = [
  { id: 'hospital', kind: 'group', groupLinkId: 'section_hospital', mode: 'single', icon: 'fas fa-hospital', color: '#3B82F6', bg: 'rgba(59,130,246,.1)', title: 'Hospital Profile', desc: 'Your clinic profile as a FHIR Organization resource.' },
  { id: 'staff', kind: 'group', groupLinkId: 'section_staff', mode: 'repeatable', icon: 'fas fa-user-md', color: '#00D4B2', bg: 'rgba(0,212,178,.1)', title: 'Care Team', desc: 'Physicians, nurses and staff as FHIR Practitioner records.' },
  { id: 'admin', kind: 'group', groupLinkId: 'section_staff', mode: 'repeatable', roleFilter: 'Administrator', icon: 'fas fa-user-shield', color: '#6366F1', bg: 'rgba(99,102,241,.1)', title: 'Administrators', desc: 'Staff members with the Administrator role.' },
  { id: 'services', kind: 'group', groupLinkId: 'section_services_matrix', mode: 'repeatable', icon: 'fas fa-stethoscope', color: '#8B5CF6', bg: 'rgba(139,92,246,.1)', title: 'Services', desc: 'Services your clinic offers.' },
  { id: 'hours', kind: 'group', groupLinkId: 'section_hours', mode: 'repeatable', icon: 'fas fa-clock', color: '#F59E0B', bg: 'rgba(245,158,11,.1)', title: 'Office Hours', desc: 'Operating hours, one day-range at a time.' },
  { id: 'consent', kind: 'group', groupLinkId: 'section_consent', mode: 'repeatable', icon: 'fas fa-file-signature', color: '#EF4444', bg: 'rgba(239,68,68,.1)', title: 'Legal Consents', desc: 'Consent types your clinic collects from patients.' },
  { id: 'location', kind: 'group', groupLinkId: 'section_location', mode: 'repeatable', icon: 'fas fa-map-marker-alt', color: '#14B8A6', bg: 'rgba(20,184,166,.1)', title: 'Branches', desc: 'Additional clinic locations.' },
  { id: 'appointment', kind: 'group', groupLinkId: 'section_appointment', mode: 'repeatable', icon: 'fas fa-calendar-alt', color: '#EC4899', bg: 'rgba(236,72,153,.1)', title: 'Appointments', desc: 'Booked appointment records.' },
];

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
  currentView.value = 'cards';
  activeCard.value = null;
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
  Object.assign(newFormDraft, { formId: 'new-form-v1', title: 'New Form', version: 1, journey: '' });
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
      <input type="number" min="1" step="1" v-model.number="newFormDraft.version" class="cf-input" style="width:100%;margin-bottom:1.1rem" />

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
        <button v-show="auth.currentUser" class="btn-outline" :class="primaryTab === 'formsLibrary' ? 'btn-teal' : ''" @click="primaryTab = 'formsLibrary'" style="font-size:.78rem">
          <i class="fas fa-pen-ruler" style="margin-right:.4rem"></i>Forms Library
        </button>
        <span v-show="!auth.currentUser" style="font-size:.75rem;color:var(--cf-text);align-self:center;padding:0 .25rem">
          <i class="fas fa-flask" style="margin-right:.35rem;color:var(--color-primary)"></i>Sandbox mode — <button class="btn-ghost" style="padding:0;font-size:.75rem;text-decoration:underline;display:inline" @click="router.push('/')">sign in</button> for your clinic's real data.
        </span>
        <button class="btn-outline" :class="primaryTab === 'sandbox' ? 'btn-teal' : ''" @click="primaryTab = 'sandbox'" style="font-size:.78rem">
          <i class="fas fa-flask" style="margin-right:.4rem"></i>Sandbox Data
        </button>
      </div>

      <div v-show="primaryTab === 'sandbox'" style="flex:1;overflow:hidden;padding:1rem 1.5rem">
        <AiEngineSandbox ref="aiEngineSandboxRef" />
      </div>

  <main v-show="primaryTab === 'formsLibrary'" style="flex:1;overflow:hidden;display:flex;justify-content:center">
  <div style="max-width:1500px;width:100%;overflow-y:auto;padding:1.5rem">

    <!-- ── Card grid (default landing) — one card per Provider entity plus one per Patient/
         Encounter/custom form. See clinux-settings-page-entity-cards memory note. ── -->
    <div v-show="currentView === 'cards'">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1.25rem">
        <div>
          <span class="cf-label" style="margin-bottom:.2rem;display:block">Forms Library</span>
          <p style="font-size:.8rem;color:var(--cf-text)">Every entity your clinic manages, plus every custom form you've designed. Click a card to view its records; use the menu for the Designer/YAML view.</p>
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
        <div v-for="card in allLibraryCards()" :key="card.id" style="position:relative">
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
    <div v-show="currentView !== 'cards'">
    <button class="btn-outline" @click="backToCards()" style="font-size:.75rem;padding:.4rem 1rem;margin-bottom:1.25rem;display:flex;align-items:center;gap:.4rem">
      <i class="fas fa-arrow-left"></i>Back to Forms Library
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
