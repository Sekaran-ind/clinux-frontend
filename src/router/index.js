import { createRouter, createWebHistory } from 'vue-router';
import Index from '../pages/Index.vue';
import Onboarding from '../pages/Onboarding.vue';
import ClinicHome from '../pages/ClinicHome.vue';
import AbdmOnboarding from '../pages/AbdmOnboarding.vue';
import StaffOnboarding from '../pages/StaffOnboarding.vue';
import HospitalOnboarding from '../pages/HospitalOnboarding.vue';
import HospitalOnboardingChat from '../pages/HospitalOnboardingChat.vue';
import Designer from '../pages/Designer.vue';
import { useAuthStore } from '../stores/auth.js';
import { resolveGuard } from './guardLogic.js';

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
// step. Old bookmarks/links to their former routes redirect to /clinic-home (same "old route
// still lands somewhere useful" precedent /ai-engine → /designer already set) rather than the
// generic catch-all's redirect to /, since /clinic-home is the more specific "you were looking
// for this" destination.
const routes = [
  { path: '/', name: 'index', component: Index, meta: { hideAppNav: true } },
  { path: '/front-desk', redirect: '/clinic-home' },
  { path: '/consultation-desk', redirect: '/clinic-home' },
  { path: '/checkout', redirect: '/clinic-home' },
  { path: '/onboarding', name: 'onboarding', component: Onboarding, meta: { requiresAuth: true } },
  { path: '/clinic-home', name: 'clinic-home', component: ClinicHome, meta: { hideAppNav: true } },
  { path: '/onboarding-abdm', name: 'onboarding-abdm', component: AbdmOnboarding, meta: { requiresAuth: true } },
  // A teammate's own self-service onboarding (name/role/specialization/HPR fields + importing
  // the clinic's existing profile) — distinct from /onboarding (the admin's full clinic setup)
  // and /onboarding-abdm (the admin's full HFR/HPR registration console).
  { path: '/staff-onboarding', name: 'staff-onboarding', component: StaffOnboarding, meta: { requiresAuth: true } },
  // The HFR half of SPEC-11's prerequisite-layer onboarding — role-gated at the UI-card level in
  // ClinicHome.vue's user menu (Hospital Admin / Admin-and-Health-Professional see it, Health
  // Professional doesn't), same "cosmetic/defense-in-depth, not a router-level role guard"
  // precedent /staff-onboarding already established — no meta.requiresRole added here either.
  { path: '/hospital-onboarding', name: 'hospital-onboarding', component: HospitalOnboarding, meta: { requiresAuth: true } },
  // SPEC-14 (docs/SPEC-14-HFSM-RUNTIME-AND-CHAT-FIRST-CAPTURE.md) §7 — additive proof-of-concept,
  // side by side with the drawer flow above, not a replacement of it yet.
  { path: '/hospital-onboarding/chat', name: 'hospital-onboarding-chat', component: HospitalOnboardingChat, meta: { requiresAuth: true } },
  // Unauthenticated visitors can still reach this page, constrained to Sandbox Data — see
  // clinux-authenticated-vs-sandbox-mode memory note. The real Forms Library tab (Provider-
  // composition data) is gated inside Designer.vue itself instead of at the router level, since
  // the sandbox half of this page is a deliberately isolated demo (see
  // clinux-ai-engine-designer-merge-tanstack-table) that's safe to expose either way.
  { path: '/designer', name: 'designer', component: Designer },
  // AiEngine.vue merged into Designer.vue (see clinux-ai-engine-designer-merge-tanstack-table
  // memory note) — old bookmarks/links to /ai-engine still land somewhere useful.
  { path: '/ai-engine', redirect: '/designer' },
  { path: '/:catchAll(.*)', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  return resolveGuard(to.meta, auth.currentUser);
});
