import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listDataRecords } from '../data/collections/formData.js';
import { getCareTeam, addCareTeamMember, removeCareTeamMember } from '../data/collections/encounterDocs.js';

// The one merged Encounter-composition record per visit (Vitals/SOAP/Prescription/Billing all
// live inside it now, as repeating/singular groups — see formData.js's getGroupInstances) rather
// than each being a separately-keyed form. FrontDesk.vue/Checkout.vue import this constant
// instead of each hardcoding the literal string themselves.
const ENCOUNTER_FORM_ID = 'system-encounter-composition-v1';

// Replaces Alpine.store('clinical') from clinixflow's store.js — the active-encounter pointer
// shared across Front Desk → Consultation Desk (→ Checkout, once migrated). Just an id pointer,
// so it stays plain Pinia + localStorage rather than a TanStack DB collection.
export const useClinicalStore = defineStore('clinical', () => {
  const activeEncounterId = ref(localStorage.getItem('cf_active_encounter') || null);

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
    return listDataRecords(ENCOUNTER_FORM_ID).find((r) => r.id === activeEncounterId.value) || null;
  }

  return {
    ENCOUNTER_FORM_ID,
    activeEncounterId,
    setActive,
    clearActive,
    getEncounter,
    getCareTeam,
    addCareTeamMember,
    removeCareTeamMember,
  };
});
