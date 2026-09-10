import { formsLibrary } from './collections/formsLibrary.js';
import { flowsLibrary } from './collections/flowsLibrary.js';
import { formData } from './collections/formData.js';
import { publicAppointments } from './collections/publicAppointments.js';
import {
  encounterLogs, encounterStage, encounterConsent, prescriptions,
  encounterImages, encounterAnnotations, careTeam,
} from './collections/encounterDocs.js';
import { aiEnginePatients } from './collections/aiEnginePatients.js';
import { aiEngineStaff } from './collections/aiEngineStaff.js';
import { aiEngineEncounters } from './collections/aiEngineEncounters.js';

// Route/feature-specific TanStack DB collections — Onboarding/Designer's forms+flows catalog,
// Front Desk/Consultation Desk/Checkout's 7 encounter-doc collections (all mounted inside
// ClinicHome.vue now, not their own routes), ClinicHome's public-appointments feed, AI Engine's 3
// sandbox collections. Previously ALL of these — plus main.js's own CORE set below — blocked
// app.mount() unconditionally, on every route including the bare unauthenticated Index.vue
// landing page, which needs none of them: real, measurable dead weight on first paint of the page
// almost every visit starts on. See main.js's own header comment for the split and why `users`/
// `chatThreads` are the only 2 that stay there.
//
// Deferred here rather than just removed — same "preload before a synchronous read can reach it"
// guarantee the original eager-preload fix (main.js) established, just SCOPED to the routes that
// actually need each collection, via router/index.js's own beforeEach guard below, not blanket-
// applied to a route that needs none of them.
const DEFERRED_COLLECTIONS = [
  formsLibrary, flowsLibrary, formData, publicAppointments,
  encounterLogs, encounterStage, encounterConsent, prescriptions, encounterImages, encounterAnnotations, careTeam,
  aiEnginePatients, aiEngineStaff, aiEngineEncounters,
];

// Memoized (module-level, not per-call) — main.js kicks this off once, fire-and-forget, right
// after app.mount() so it's already well underway (usually finished) by the time anyone actually
// navigates anywhere; router/index.js's beforeEach guard then AWAITS this same promise before
// resolving any non-Index navigation, so a cold direct deep-link (a bookmark straight to
// /clinic-home, say — no Index visit first) still gets the exact synchronous-read safety
// guarantee every route besides Index always had, not a weaker one.
let preloadPromise = null;
export function ensureDeferredCollectionsPreloaded() {
  if (!preloadPromise) preloadPromise = Promise.all(DEFERRED_COLLECTIONS.map((c) => c.preload()));
  return preloadPromise;
}
