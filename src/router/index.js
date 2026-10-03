import { createRouter, createWebHistory } from 'vue-router';
import Index from '../pages/Index.vue';
import Onboarding from '../pages/Onboarding.vue';
import ClinicHome from '../pages/ClinicHome.vue';
import StaffOnboarding from '../pages/StaffOnboarding.vue';
import PractitionerHome from '../pages/PractitionerHome.vue';
import PatientHome from '../pages/PatientHome.vue';
import Designer from '../pages/Designer.vue';
import Dashboard from '../pages/Dashboard.vue';
import Registries from '../pages/Registries.vue';
import ClinicOps from '../pages/ClinicOps.vue';
import Operations from '../pages/Operations.vue';
import Legal from '../pages/Legal.vue';
import Consent from '../pages/Consent.vue';
import Consents from '../pages/Consents.vue';
import Records from '../pages/Records.vue';
import { useConsentStore, consentRedirect } from '../stores/consent.js';
import Cubo from '../components/Cubo.vue';
import { useAuthStore } from '../stores/auth.js';
import { useClinicViewStore } from '../stores/clinicView.js';
import { resolveGuard } from './guardLogic.js';
import { ensureDeferredCollectionsPreloaded } from '../data/collectionPreload.js';

// Today's 9 separate clinixflow HTML pages become 9 routes sharing one app shell and one
// Pinia/TanStack DB state tree. meta.hideAppNav marks routes that render their own full nav
// (index.html's marketing nav) instead of App.vue's shared "logo + badge + dark toggle + back
// link" nav every clinical workflow page uses — see App.vue. meta.requiresAuth marks the
// operational/clinical pages that need a real logged-in account — see the router.beforeEach
// guard below (resolveGuard() itself is a pure function, unit-tested in guardLogic.test.js).
//
// Front Desk/Consultation Desk/Checkout are no longer routes of their own — they're mounted
// directly inside ClinicHome.vue as internally-switched views (see
// clinux-frontdesk-consultation-checkout-as-clinic-home-components memory note): one persistent
// /clinic-home URL, pure in-memory view state, no query-param/hash deep-linking to a specific
// step. Old bookmarks/links to their former routes redirect to /clinic-home ("old route still
// lands somewhere useful" rather than the generic catch-all's redirect to /, since /clinic-home
// is the more specific "you were looking for this" destination.
const routes = [
  { path: '/', name: 'index', component: Index, meta: { hideAppNav: true } },
  { path: '/front-desk', redirect: '/clinic-home' },
  { path: '/consultation-desk', redirect: '/clinic-home' },
  { path: '/checkout', redirect: '/clinic-home' },
  { path: '/onboarding', name: 'onboarding', component: Onboarding, meta: { requiresAuth: true } },
  { path: '/clinic-home', name: 'clinic-home', component: ClinicHome, meta: { hideAppNav: true } },
  // RETIRED (Hospital/Provider/Affiliate journey audit) — AbdmOnboarding.vue was the last page
  // still on the pre-SPEC-24 useSystemForms.js/LhcFormHost (LForms) pattern, evidently missed
  // when HospitalOnboarding.vue (a later, already-retired intermediate version, see the
  // /hospital-onboarding redirect above) was consolidated away. Its real HFR/HPR gateway calls
  // are now FacilityHfrPanel.vue/ProviderHprPanel.vue, hosted inside /onboarding and
  // /staff-onboarding themselves (same "small panel next to the real Host component" shape
  // PatientAbhaPanel.vue already established for Patient/ABHA) — same "old route still lands
  // somewhere useful" precedent as the other redirects on this page.
  { path: '/onboarding-abdm', redirect: '/onboarding' },
  // A teammate's own self-service onboarding (name/role/specialization/HPR fields + importing
  // the clinic's existing profile) — distinct from /onboarding (the admin's full clinic setup).
  { path: '/staff-onboarding', name: 'staff-onboarding', component: StaffOnboarding, meta: { requiresAuth: true } },
  // Practitioner's own Page View (explicit instruction: a real page independent of ClinicHome,
  // same 3-surface pattern) — hideAppNav since it renders its own nav, matching ClinicHome's
  // own meta for the identical reason.
  { path: '/practitioner-home', name: 'practitioner-home', component: PractitionerHome, meta: { requiresAuth: true, hideAppNav: true } },
  // Patient's own staff-facing directory/record surface (Patient GraphDefinition + generic
  // conformance/search/save API build) — same 3-surface pattern as ClinicHome/PractitionerHome,
  // but never a login destination: Patient itself never gets an account (SPEC-21 §6), so this is
  // reached only via a staff nav link, never homeDestination.js.
  { path: '/patient-home', name: 'patient-home', component: PatientHome, meta: { requiresAuth: true, hideAppNav: true } },
  // RETIRED (real onboarding-UI audit/rebuild) — HospitalOnboarding.vue's own drawer (AbdmFieldForm-
  // based, a bespoke non-FHIR-native renderer) and HospitalOnboardingChat.vue (an in-progress HFSM
  // proof-of-concept, "additive... not a replacement yet" — never finished, never actually the
  // canonical path) both duplicated what /onboarding (Onboarding.vue) already does properly: real,
  // FHIR-native, custom-widget capture against the same system-provider-composition-v1
  // Questionnaire. UPDATE — briefly redirected through Cübo's own in-Cübo Hospital Setup checklist
  // (`/ai-engine?startHospitalSetup=1`) instead; that checklist was itself retired ("no plan
  // definition or workflow is required" for the 3 onboarding entities, explicit instruction) in
  // favor of /onboarding's own real page route, so old links/bookmarks now land there directly —
  // same "old route still lands somewhere useful" precedent /front-desk etc. already established
  // just above.
  { path: '/hospital-onboarding', redirect: '/onboarding' },
  { path: '/hospital-onboarding/chat', redirect: '/onboarding' },
  // SPEC-19 (docs/SPEC-19-LOCAL-FIRST-LOCAL-SERVER-AND-FEDERATED-MODES.md) §12: Designer
  // (Forms Library) and AI Engine (Sandbox Data) are separate pages again, no dependency between
  // them — reverses the earlier AI Engine+Designer merge (clinux-ai-engine-designer-merge-
  // tanstack-table memory note). Designer now holds only the real Provider-composition Forms
  // Library, so it requires auth; AI Engine's sandbox data is a deliberately isolated demo, safe
  // for anyone to reach unauthenticated (see clinux-authenticated-vs-sandbox-mode memory note),
  // so it keeps the "no requiresAuth" treatment that page used to have.
  { path: '/designer', name: 'designer', component: Designer, meta: { requiresAuth: true } },
  // The old Onboarding.vue "Review & Publish" screen's real content (entity counts, FHIR JSON
  // preview) — given its own real destination once publishIfReady() made the forced publish
  // step it used to gate redundant (explicit instruction). Linked from ClinicHome's user menu.
  { path: '/dashboard', name: 'dashboard', component: Dashboard, meta: { requiresAuth: true } },
  // ABDM registry journeys (HPR, HFR, Patient ABHA) on clinux-cubo's LangGraph journey runtime and
  // the same clinuxflow-abdm-gateway APIs Cübo/cubo-diary use — see src/journeys/index.js.
  { path: '/registries/:journey?', name: 'registries', component: Registries, meta: { requiresAuth: true } },
  // Clinic operations as journeys (Front Desk / Consultation / Checkout), built like Registries —
  // see pages/ClinicOps.vue and src/journeys/clinic/.
  { path: '/clinic/:journey?', name: 'clinic', component: ClinicOps, meta: { requiresAuth: true } },
  // Activity log / ABDM transactions / Access & roles (Swastik-style Operations) — clinuxflow-api's
  // routes/operations.js, role-scoped server-side.
  // Affiliations, terms and privacy (src/legal/legal.js, from clinux-cubo/cubo-diary) — public, and
  // never behind the consent gate. hideAppNav: it brings its own header when signed out.
  { path: '/legal', name: 'legal', component: Legal, meta: { hideAppNav: true } },
  // The consent gate (clinux-cubo's): shown after sign-in until both consents are given for the
  // current terms version. Outside the workspace shell (App.vue) — the workspace is closed until then.
  { path: '/consent', name: 'consent', component: Consent, meta: { requiresAuth: true, hideAppNav: true } },
  { path: '/account', redirect: '/account/consents' },
  { path: '/account/consents', name: 'account-consents', component: Consents, meta: { requiresAuth: true } },
  { path: '/account/records', name: 'account-records', component: Records, meta: { requiresAuth: true } },
  { path: '/operations', redirect: '/operations/activity' },
  { path: '/operations/:section(activity|abdm-transactions|access)', name: 'operations', component: Operations, meta: { requiresAuth: true } },
  // SPEC-22 (docs/SPEC-22-PERSISTED-WORKFLOW-SYSTEM-FLOWS-CUBO-STATE-MIRROR-DRAWER-CAPTURE.md)
  // §5.1's 3-pane Cübo shell — user's explicit correction: "ai-engine is the cubo in 3 pane
  // layout... open cubo as a separate page route". No wrapper page needed — Cubo.vue mounts
  // directly as this route's own component, forced into its 'THREE_PANE' layout via the
  // forceLayout prop (a route breakpoint, not a page-level concept) — same pattern FAB/EXPANDED/
  // MODAL_DOCK already use, just triggered by this route instead of a header button.
  { path: '/ai-engine', name: 'ai-engine', component: Cubo, props: { forceLayout: 'THREE_PANE' } },
  // SPEC-20 (docs/SPEC-20-REFERENCE-PATTERN-JOURNEY-WORKBENCH-AND-UNAUTH-CUBO-ENTRY.md) — the real
  // unauthenticated entry point (Register/Login/Forgot Password/Change Password) lives directly
  // inside Cübo's 'general' category thread now (see Cubo.vue), not a standalone route — an
  // earlier version of this build was a separate /get-started page/route, corrected per explicit
  // instruction. Old bookmarks/links to it land on the generic catch-all's redirect to /, where
  // Cübo's General thread is reachable via the "Try Guided Setup with Cübo" button.
  { path: '/:catchAll(.*)', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, from) => {
  // See stores/clinicView.js — entering ClinicHome from elsewhere opens its public view unless
  // the caller (AppShell's sidebar, Dashboard) asked for a specific ops view.
  if (to.name === 'clinic-home' && from.name !== 'clinic-home') useClinicViewStore().applyArrival();
  // main.js's own header comment — Index.vue is the only route that needs neither
  // data/collectionPreload.js's deferred collections nor the guarantee they're already hydrated
  // before its component is created; every other route gets that guarantee here instead of
  // main.js blocking first paint on it for EVERY route, Index included.
  if (to.name !== 'index') await ensureDeferredCollectionsPreloaded();
  const auth = useAuthStore();
  const guard = resolveGuard(to.meta, auth.currentUser);
  if (guard !== true) return guard;
  // Consent gate (stores/consent.js): a signed-in account goes to /consent until it has agreed to
  // the current terms; the landing page, /legal and /consent itself are exempt.
  if (auth.currentUser) {
    const consent = useConsentStore();
    if (consent.accountId !== auth.currentUser.id) await consent.load(auth.currentUser.id);
    if (consentRedirect(to.name, { signedIn: true, allGranted: consent.allGranted })) {
      return { name: 'consent', query: { next: to.fullPath } };
    }
  }
  return true;
});
