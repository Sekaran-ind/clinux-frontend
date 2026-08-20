import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useLiveQuery } from '@tanstack/vue-db';
import { formData, getAnswer, withGroupFields, saveDataRecord } from '../data/collections/formData.js';
import { getCareTeam, addCareTeamMember, removeCareTeamMember } from '../data/collections/encounterDocs.js';

// Per-encounter stage-completion tracking for the shared Active Sessions landing (see
// ActiveSessionsLanding.vue) — deliberately separate from encounter_status (arrived/in-progress/
// finished/cancelled, a coarse open/closed signal Checkout.vue already owns). These three track
// each of the three PHASES independently, set at the exact moment each phase's own existing
// hand-off action already fires (Front Desk's sendToConsultation(), Consultation Desk's
// sendToCheckout(), Checkout's closeEncounter()) -- not new user actions, just marking what
// already happens. Stored as ordinary answer fields on the SAME section_encounter group
// (via withGroupFields, same mechanism formSlotEngine.js's applyFills() uses) rather than a
// schema change to the compiled Questionnaire -- these are internal/system-tracked, never
// rendered as form inputs, so they don't need a YAML field definition to exist.
export const ENCOUNTER_STAGES = ['onboarding', 'consultation', 'checkout'];
function stageFieldId(stage) {
  return `stage_${stage}_complete`;
}

// The one merged Encounter-composition record per visit (Vitals/SOAP/Prescription/Billing all
// live inside it now, as repeating/singular groups — see formData.js's getGroupInstances) rather
// than each being a separately-keyed form. FrontDesk.vue/Checkout.vue import this constant
// instead of each hardcoding the literal string themselves.
const ENCOUNTER_FORM_ID = 'system-encounter-composition-v1';

// Deny-list, not allow-list. getAnswer() returns '' for a field the user hasn't touched yet
// (see formData.js) — a freshly created encounter's encounter_status starts exactly like that
// until someone explicitly opens the drawer and picks a value from the dropdown. Checking
// against an allow-list of ['arrived','in-progress'] meant '' never matched either one, so every
// new session was invisible in Front Desk/Checkout/ClinicHome's Active Sessions from the moment
// it was created — not just eventually, immediately — regardless of how far the visit actually
// progressed (real chief complaint, vitals, SOAP notes, prescriptions could all be filled in and
// it would still never show). 'finished'/'cancelled' are the only two statuses Checkout.vue's own
// closeEncounter() (or a manually cancelled visit) ever explicitly sets — anything else, including
// unset, is still an open visit.
const CLOSED_ENCOUNTER_STATUSES = ['finished', 'cancelled'];

const LAST_PAGE_KEY = 'cf_encounter_last_page';

// Replaces Alpine.store('clinical') from clinixflow's store.js — the active-encounter pointer
// shared across Front Desk → Consultation Desk (→ Checkout, once migrated). Just an id pointer,
// so it stays plain Pinia + localStorage rather than a TanStack DB collection.
export const useClinicalStore = defineStore('clinical', () => {
  const activeEncounterId = ref(localStorage.getItem('cf_active_encounter') || null);

  // Reactive to every formData write (any page's own saveDataRecord() call), not just this
  // store's own local activeEncounterId ref — plain .toArray()/.filter() reads aren't Vue-
  // reactive on their own; useLiveQuery is what actually subscribes to the collection's change
  // events (same pattern CornerstoneViewer.vue/Cubo.vue already use for their own collections).
  // Needed now that Front Desk/Consultation Desk/Checkout are long-lived child components of
  // ClinicHome.vue instead of separate routed pages (see
  // clinux-frontdesk-consultation-checkout-as-clinic-home-components memory note) — a session
  // created in one no longer implies a fresh page load (and thus a fresh, correct read) for
  // ClinicHome's own view of it.
  // Reads allFormData.value directly (not formData.js's own listDataRecords()) to stay reactive
  // via useLiveQuery — but that means it also has to redo listDataRecords()' own clinicId scoping
  // itself, rather than inheriting it for free. Without this, every clinic sharing this browser
  // would see the same "active" encounters regardless of who's actually logged in (see
  // formData.js's own currentClinicId() comment for the full story).
  const CLINIC_USER_KEY = 'cf_user';
  const currentClinicId = () => {
    try { return JSON.parse(localStorage.getItem(CLINIC_USER_KEY) || 'null')?.clinicId || null; } catch (e) { return null; }
  };
  const { data: allFormData } = useLiveQuery((q) => q.from({ r: formData }));
  const encounterRecords = () => {
    const clinicId = currentClinicId();
    return allFormData.value
      .filter((r) => r.formId === ENCOUNTER_FORM_ID && r.clinicId === clinicId)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  };

  function setActive(id) {
    activeEncounterId.value = id;
    localStorage.setItem('cf_active_encounter', id);
  }

  function clearActive() {
    activeEncounterId.value = null;
    localStorage.removeItem('cf_active_encounter');
  }

  function getEncounter() {
    if (!activeEncounterId.value) return null;
    return encounterRecords().find((r) => r.id === activeEncounterId.value) || null;
  }

  // The shared "active sessions list" foundation for Front Desk/Checkout/ClinicHome — every open
  // encounter-composition record, not just the single one activeEncounterId happens to point at.
  // Sorted most-recent-first already, via encounterRecords()' own savedAt ordering.
  function listActiveSessions() {
    return encounterRecords()
      .filter((r) => !CLOSED_ENCOUNTER_STATUSES.includes(getAnswer(r, 'encounter_status')))
      .map((r) => ({
        id: r.id,
        status: getAnswer(r, 'encounter_status'),
        priority: getAnswer(r, 'encounter_priority'),
        patientRef: getAnswer(r, 'encounter_patient_ref'),
        chiefComplaint: getAnswer(r, 'encounter_chief_complaint'),
        savedAt: r.savedAt,
      }));
  }

  // { onboarding: bool, consultation: bool, checkout: bool } for one encounter record — the
  // shared landing's 3 per-row action badges read this to show complete vs. not-yet.
  function getStageCompletion(record) {
    const out = {};
    ENCOUNTER_STAGES.forEach((stage) => {
      out[stage] = getAnswer(record, stageFieldId(stage)) === 'true';
    });
    return out;
  }

  // Called from each phase's own EXISTING hand-off action (see this function's own comment
  // above) — not a new user-facing action. Silently no-ops if the encounter's gone missing
  // (closed/deleted elsewhere mid-action) rather than throwing partway through a hand-off.
  function markStageComplete(encounterId, stage) {
    const record = encounterRecords().find((r) => r.id === encounterId);
    if (!record) return;
    const newData = withGroupFields(record.data, 'section_encounter', { [stageFieldId(stage)]: 'true' });
    saveDataRecord(ENCOUNTER_FORM_ID, record.version, newData, record.id);
  }

  // Every encounter — open AND closed — sorted most-recent-first, for the shared Active Sessions
  // landing's timeline (see ActiveSessionsLanding.vue). Deliberately NOT filtered by
  // CLOSED_ENCOUNTER_STATUSES the way listActiveSessions() is: the landing is a real session
  // history/timeline now, not just a "what's still open" list, and TanStack Query's infinite
  // scroll needs a genuinely growing dataset to page through, not just the handful of visits
  // open on a given day.
  function listAllSessions() {
    return encounterRecords().map((r) => ({
      id: r.id,
      status: getAnswer(r, 'encounter_status'),
      priority: getAnswer(r, 'encounter_priority'),
      patientRef: getAnswer(r, 'encounter_patient_ref'),
      chiefComplaint: getAnswer(r, 'encounter_chief_complaint'),
      savedAt: r.savedAt,
      stages: getStageCompletion(r),
    }));
  }

  // Per-encounter "last page visited" — lets ClinicHome's session cards resume exactly where
  // staff left off instead of always bouncing back to Front Desk. Plain localStorage map, same
  // simple-ref-backed-by-localStorage pattern as activeEncounterId above (no TanStack collection
  // needed for something this small).
  function readLastPageMap() {
    try { return JSON.parse(localStorage.getItem(LAST_PAGE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function recordVisit(encounterId, pageKey) {
    if (!encounterId) return;
    const map = readLastPageMap();
    map[encounterId] = pageKey;
    localStorage.setItem(LAST_PAGE_KEY, JSON.stringify(map));
  }

  function getLastVisitedPage(encounterId) {
    return readLastPageMap()[encounterId] || null;
  }

  return {
    ENCOUNTER_FORM_ID,
    activeEncounterId,
    setActive,
    clearActive,
    getEncounter,
    listActiveSessions,
    listAllSessions,
    getStageCompletion,
    markStageComplete,
    recordVisit,
    getLastVisitedPage,
    getCareTeam,
    addCareTeamMember,
    removeCareTeamMember,
  };
});
