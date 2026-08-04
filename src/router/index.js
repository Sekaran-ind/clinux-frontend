import { createRouter, createWebHistory } from 'vue-router';
import Index from '../pages/Index.vue';
import FrontDesk from '../pages/FrontDesk.vue';
import ConsultationDesk from '../pages/ConsultationDesk.vue';
import Onboarding from '../pages/Onboarding.vue';
import ClinicHome from '../pages/ClinicHome.vue';
import Checkout from '../pages/Checkout.vue';
import AbdmOnboarding from '../pages/AbdmOnboarding.vue';
import Designer from '../pages/Designer.vue';
import AiEngine from '../pages/AiEngine.vue';
import { useAuthStore } from '../stores/auth.js';
import { resolveGuard } from './guardLogic.js';

// Today's 9 separate clinixflow HTML pages become 9 routes sharing one app shell and one
// Pinia/TanStack DB state tree. meta.hideAppNav marks routes that render their own full nav
// (index.html's marketing nav) instead of App.vue's shared "logo + badge + dark toggle + back
// link" nav every clinical workflow page uses — see App.vue. meta.requiresAuth marks the
// operational/clinical pages that need a real logged-in account — see the router.beforeEach
// guard below (resolveGuard() itself is a pure function, unit-tested in guardLogic.test.js).
const routes = [
  { path: '/', name: 'index', component: Index, meta: { hideAppNav: true } },
  { path: '/front-desk', name: 'front-desk', component: FrontDesk, meta: { requiresAuth: true } },
  { path: '/consultation-desk', name: 'consultation-desk', component: ConsultationDesk, meta: { requiresAuth: true } },
  { path: '/onboarding', name: 'onboarding', component: Onboarding, meta: { requiresAuth: true } },
  { path: '/clinic-home', name: 'clinic-home', component: ClinicHome, meta: { hideAppNav: true } },
  { path: '/checkout', name: 'checkout', component: Checkout, meta: { requiresAuth: true } },
  { path: '/onboarding-abdm', name: 'onboarding-abdm', component: AbdmOnboarding, meta: { requiresAuth: true } },
  { path: '/designer', name: 'designer', component: Designer, meta: { requiresAuth: true } },
  { path: '/ai-engine', name: 'ai-engine', component: AiEngine, meta: { hideAppNav: true, requiresAuth: true } },
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
