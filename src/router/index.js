import { createRouter, createWebHistory } from 'vue-router';
import Index from '../pages/Index.vue';
import Onboarding from '../pages/Onboarding.vue';
import ClinicHome from '../pages/ClinicHome.vue';
import AbdmOnboarding from '../pages/AbdmOnboarding.vue';
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
