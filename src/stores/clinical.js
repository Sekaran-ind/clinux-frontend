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

// The other two choices compiled into encounter_status (system-encounter-composition-v1.yaml)
// are 'finished'/'cancelled' — everything else is still an open, in-progress visit.
const OPEN_ENCOUNTER_STATUSES = ['arrived', 'in-progress'];

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
  const { data: allFormData } = useLiveQuery((q) => q.from({ r: formData }));
  const encounterRecords = () =>
    allFormData.value.filter((r) => r.formId === ENCOUNTER_FORM_ID).sort((a, b) => b.savedAt.localeCompare(a.savedAt));

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
      .filter((r) => OPEN_ENCOUNTER_STATUSES.includes(getAnswer(r, 'encounter_status')))
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
