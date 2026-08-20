import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';

// AG Grid's module system needs registering once, globally, before any <AgGridVue> mounts —
// AllCommunityModule bundles every free (MIT-licensed) feature: sorting/filtering/pagination,
// exactly what replaces PrimeVue's DataTable here (see clinux-ag-grid-instead-of-primevue memory
// note — PrimeVue v5 turned out to require a paid license for component chrome; AG Grid
// Community has no such gate).
ModuleRegistry.registerModules([AllCommunityModule]);
import './style.css';
import App from './App.vue';
import { router } from './router/index.js';
import { formsLibrary, seedSystemForms } from './data/collections/formsLibrary.js';
import { formData } from './data/collections/formData.js';
import { chatThreads } from './data/collections/chatThreads.js';
import {
  encounterLogs, encounterStage, encounterConsent, prescriptions,
  encounterImages, encounterAnnotations, careTeam,
} from './data/collections/encounterDocs.js';
import { users } from './data/collections/users.js';
import { publicAppointments } from './data/collections/publicAppointments.js';
import { aiEnginePatients } from './data/collections/aiEnginePatients.js';
import { aiEngineStaff } from './data/collections/aiEngineStaff.js';
import { aiEngineEncounters } from './data/collections/aiEngineEncounters.js';
import { API_BASE } from './config.js';
import { useAuthStore } from './stores/auth.js';
import { warmUp as warmUpFormSlotEngine } from './nlp/formSlotEngine.js';

// TanStack DB collections load their persisted data asynchronously (even the localStorage-backed
// ones — see collection.preload()'s own doc comment: "useful for preloading collections"), not
// synchronously at creation. Several components read collections synchronously at component-
// setup time (e.g. ConsultationDesk.vue's `const encounter = clinical.getEncounter()`), which
// raced and returned stale/empty data on a hard page load before this fix — preload everything
// before the router/app ever mounts so every synchronous read anywhere in the app is guaranteed
// to see already-hydrated data.
const collections = [
  formsLibrary, formData, chatThreads, users, publicAppointments,
  encounterLogs, encounterStage, encounterConsent, prescriptions, encounterImages, encounterAnnotations, careTeam,
  aiEnginePatients, aiEngineStaff, aiEngineEncounters,
];

await Promise.all(collections.map((c) => c.preload()));

const app = createApp(App);
app.use(createPinia());
app.use(router);
// TanStack Query — used by ActiveSessionsLanding.vue's infinite-scroll session timeline
// (useInfiniteQuery). The "backend" it pages through is the local TanStack DB collection above,
// not a network call — Query's infinite-scroll primitive doesn't care whether its page-fetcher
// is async-over-network or a synchronous local slice, so this is a legitimate use even though
// there's no server round-trip involved.
app.use(VueQueryPlugin);
app.mount('#app');

// Revalidates a stored session against the server on every app load — picks up a tier change
// (free -> paid) since last login without forcing a fresh login, and silently logs out if the
// token's no longer valid.
useAuthStore().refreshSession();

// clinuxflow-api may not be running (e.g. local dev without `wrangler dev` started in that
// project) — same tolerance clinixflow's seedSystemForms had for a missing server, just also
// covering a full network failure (connection refused), not only a non-success response body.
seedSystemForms(API_BASE).catch((err) => {
  console.warn('Could not reach clinuxflow-api to seed the system forms catalog:', err.message);
}).finally(() => {
  // Runs after the seed attempt settles either way — a previous session's already-seeded forms
  // are enough to train against even if this network call itself failed. Fails soft on its own
  // (see formSlotEngine.js's warmUp()) — never blocks app startup either way.
  warmUpFormSlotEngine();
});

