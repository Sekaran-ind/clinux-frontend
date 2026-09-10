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
import { seedSystemForms } from './data/collections/formsLibrary.js';
import { seedSystemFlows } from './data/collections/flowsLibrary.js';
import { chatThreads } from './data/collections/chatThreads.js';
import { users } from './data/collections/users.js';
import { ensureDeferredCollectionsPreloaded } from './data/collectionPreload.js';
import { API_BASE } from './config.js';
import { useAuthStore } from './stores/auth.js';
import { warmUp as warmUpFormSlotEngine } from './nlp/formSlotEngine.js';

// TanStack DB collections load their persisted data asynchronously (even the localStorage-backed
// ones — see collection.preload()'s own doc comment: "useful for preloading collections"), not
// synchronously at creation. Several components read a collection synchronously at component-
// setup time (e.g. ConsultationDesk.vue's `const encounter = clinical.getEncounter()`), which
// raced and returned stale/empty data on a hard page load before this fix — preloading before a
// route's own component is ever created is what guarantees every synchronous read anywhere in it
// sees already-hydrated data.
//
// CORE — the only 2 collections genuinely needed on EVERY route, including the bare
// unauthenticated Index.vue landing page (almost every visit's actual first paint): `users` backs
// auth.js's setSession()/refreshSession() (called unconditionally below, right after mount, if a
// stored session token exists); `chatThreads` backs Cübo, which Index.vue mounts directly (its
// own FAB) the same as every other route does. Every other collection this file used to preload
// here too — Onboarding/Designer's forms+flows catalog, the 7 encounter-doc collections,
// ClinicHome's public-appointments feed, AI Engine's 3 sandbox collections, taskActorSnapshots —
// is route/feature-specific, real dead weight blocking first paint of a page that needs none of
// them. Moved to data/collectionPreload.js, deferred and awaited per-route by router/index.js's
// own beforeEach guard instead (taskActorSnapshots dropped outright, not just deferred —
// entryWorkflow.js already awaits its own preload of it internally, this was a redundant second
// one). Same safety guarantee, correctly scoped rather than blanket-applied.
await Promise.all([users, chatThreads].map((c) => c.preload()));

const app = createApp(App);
app.use(createPinia());
app.use(router);
// TanStack Query — used by ActiveSessionsLanding.vue's infinite-scroll session timeline
// (useInfiniteQuery). The "backend" it pages through is a local TanStack DB collection, not a
// network call — Query's infinite-scroll primitive doesn't care whether its page-fetcher is
// async-over-network or a synchronous local slice, so this is a legitimate use even though
// there's no server round-trip involved.
app.use(VueQueryPlugin);
app.mount('#app');

// Revalidates a stored session against the server on every app load — picks up a tier change
// (free -> paid) since last login without forcing a fresh login, and silently logs out if the
// token's no longer valid. Only touches `users` (CORE, already preloaded above), so this doesn't
// need to wait on the deferred collections below.
useAuthStore().refreshSession();

// Fire-and-forget, kicked off the instant the app itself is up — usually well underway (often
// finished) by the time anyone actually navigates anywhere, since router/index.js's beforeEach
// guard also awaits this exact same (memoized) promise for every non-Index route. seedSystemForms/
// seedSystemFlows below both write into two of these deferred collections (formsLibrary/
// flowsLibrary) — chained after this resolves, not fired in parallel with it, so a formsLibrary.
// has(formId) check inside seedSystemForms can't run before formsLibrary's own local data has
// actually loaded (it would otherwise see an empty collection and re-insert over — or duplicate-
// key-conflict with — rows that are really already there, breaking seedSystemForms's own "seed
// once, never overwrite a locally-edited copy" contract; the real hazard this file's very first
// eager-preload fix exists to prevent, just formerly guaranteed for main.js's OWN callers too by
// blocking app.mount() on literally everything, not only the two things that needed it here).
ensureDeferredCollectionsPreloaded().then(() => {
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

  // SPEC-22 decision #2's real loader — same fire-and-forget, seed-once, tolerate-a-missing-
  // backend convention as seedSystemForms above. Deliberately NOT awaited/blocking beyond the
  // preload it's already chained after — a consumer reading the flows catalog before this
  // resolves (a first-ever visit, slow network) just sees it empty until the seed lands, same
  // graceful-degradation contract seedSystemForms's own callers already accept.
  seedSystemFlows(API_BASE).catch((err) => {
    console.warn('Could not reach clinuxflow-api to seed the system flows catalog:', err.message);
  });
});

