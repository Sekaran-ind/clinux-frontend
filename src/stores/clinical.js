import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useLiveQuery } from '@tanstack/vue-db';
import { formData, getAnswer } from '../data/collections/formData.js';
import { getCareTeam, addCareTeamMember, removeCareTeamMember } from '../data/collections/encounterDocs.js';

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
    recordVisit,
    getLastVisitedPage,
    getCareTeam,
    addCareTeamMember,
    removeCareTeamMember,
  };
});
