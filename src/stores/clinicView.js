import { defineStore } from 'pinia';
import { ref } from 'vue';

// Which view ClinicHome.vue is showing: its public page, or one of the three clinic-operations
// views mounted inside it (see clinux-frontdesk-consultation-checkout-as-clinic-home-components
// memory note). Lifted out of ClinicHome's own local ref into Pinia so the app shell's sidebar
// (AppShell.vue) can switch views too — still pure in-memory UI state, still no query-param/hash
// deep-linking to a specific view, same as that note's original decision. Values reuse
// clinical.recordVisit()'s own page-key strings.
//
// Arriving at /clinic-home from another route always lands on the public page (the router guard
// in router/index.js resets it), unless the caller asked for a specific view first with
// arriveAt() — the sidebar and Dashboard do, every plain "/clinic-home" link elsewhere doesn't
// need to know this store exists.
export const useClinicViewStore = defineStore('clinicView', () => {
  const view = ref('public'); // 'public' | 'front-desk' | 'consultation-desk' | 'checkout'
  let arrival = null;

  function setView(next) {
    view.value = next;
  }

  function arriveAt(next) {
    arrival = next;
  }

  // Called by the router guard on entry to /clinic-home from another route.
  function applyArrival() {
    view.value = arrival || 'public';
    arrival = null;
  }

  return { view, setView, arriveAt, applyArrival };
});
