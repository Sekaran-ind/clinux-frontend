import { describe, expect, it, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useEntryWorkflowStore } from './entryWorkflow.js';
import { useAuthStore } from './auth.js';
import { useCuboStore } from './cubo.js';
import { taskActorSnapshots } from '../data/collections/taskActorSnapshots.js';
import { chatThreads } from '../data/collections/chatThreads.js';

// SPEC-20's real home for ENTRY_PLAN_DEFINITION's runtime — a Pinia store singleton, not a
// page-local instance (see this file's own header comment on why). Verifies the store correctly
// wraps the already-tested runtime (entryPlanDefinition.test.js covers the runtime/graph itself),
// not re-testing that logic here.
describe('useEntryWorkflowStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // A fresh Pinia instance gives a fresh entryWorkflow store, but persistence (real
    // taskActorSnapshots.js, entryWorkflow.js's own design) is a module-level singleton
    // collection that survives across tests in this file regardless of Pinia. Without clearing
    // it, an earlier test driving `register` (non-repeatable) to 'done' leaves a persisted
    // snapshot a later test's fresh store rehydrates FROM — register.js's own FOCUS then gets
    // silently dropped (already 'done', not repeatable), exactly like the real bug this session
    // found and fixed, just here as a test-isolation artifact rather than the real thing. Found
    // via a real failing test (passed in isolation, failed in the full run), not assumed.
    taskActorSnapshots.toArray.forEach((r) => taskActorSnapshots.delete(r.planId));
    // Same isolation reasoning as taskActorSnapshots above — chatThreads (cubo.js) is ALSO a
    // module-level singleton collection, so a thread inserted by one test (e.g. logout()'s own
    // scenarios below) would otherwise bleed into the next test's fresh store.
    chatThreads.toArray.forEach((r) => chatThreads.delete(r.id));
  });

  it('starts with register/login/forgot_password/change_password all ready — a real Pinia-wrapped read of the same menu-not-pipeline structure', () => {
    const store = useEntryWorkflowStore();
    expect(store.statuses.register).toBe('ready');
    expect(store.statuses.login).toBe('ready');
    expect(store.statuses.forgot_password).toBe('ready');
    expect(store.statuses.change_password).toBe('ready');
  });

  it('focus() dispatches through the real runtime and updates reactive statuses/errors', async () => {
    const store = useEntryWorkflowStore();
    const auth = useAuthStore();
    vi.spyOn(auth, 'register').mockResolvedValue({ user: { id: 'acc1', email: 'a@b.com', role: 'hospital_admin' } });

    store.focus('register', { email: 'a@b.com', password: 'password123', role: 'hospital_admin' });
    await vi.waitFor(() => expect(store.statuses.register).toBe('done'));
    expect(auth.register).toHaveBeenCalledWith({ email: 'a@b.com', password: 'password123', role: 'hospital_admin' });
  });

  it('a failed focus() surfaces the real error message via the reactive errors object', async () => {
    const store = useEntryWorkflowStore();
    const auth = useAuthStore();
    vi.spyOn(auth, 'login').mockResolvedValue({ error: 'Invalid email or password.' });

    store.focus('login', { email: 'a@b.com', password: 'wrong' });
    await vi.waitFor(() => expect(store.errors.login).toBe('Invalid email or password.'));
    expect(store.statuses.login).toBe('ready'); // back to ready, not stuck — a retry is possible
  });

  it('is a real singleton within one Pinia instance — two calls to useEntryWorkflowStore() share state, not fresh runtimes each time', () => {
    const first = useEntryWorkflowStore();
    const second = useEntryWorkflowStore();
    expect(first).toBe(second);
  });

  // SPEC-21 §5's role-based next-action triggering.
  describe('onRoleKnown', () => {
    it('fires with the real role and "register" after a successful register', async () => {
      const store = useEntryWorkflowStore();
      const auth = useAuthStore();
      vi.spyOn(auth, 'register').mockResolvedValue({ user: { id: 'acc1', email: 'a@b.com', role: 'hospital_admin' } });
      const seen = [];
      store.onRoleKnown((role, actionId) => seen.push({ role, actionId }));

      store.focus('register', { email: 'a@b.com', password: 'password123', role: 'hospital_admin' });
      await vi.waitFor(() => expect(seen.length).toBe(1));
      expect(seen[0]).toEqual({ role: 'hospital_admin', actionId: 'register' });
    });

    it('fires with the real role and "login" after a successful login — and again on a second login, since login is repeatable', async () => {
      const store = useEntryWorkflowStore();
      const auth = useAuthStore();
      vi.spyOn(auth, 'login').mockResolvedValue({ user: { id: 'acc1', email: 'a@b.com', role: 'health_professional' } });
      const seen = [];
      store.onRoleKnown((role, actionId) => seen.push({ role, actionId }));

      store.focus('login', { email: 'a@b.com', password: 'password123' });
      await vi.waitFor(() => expect(seen.length).toBe(1));
      expect(seen[0]).toEqual({ role: 'health_professional', actionId: 'login' });

      store.focus('login', { email: 'a@b.com', password: 'password123' });
      await vi.waitFor(() => expect(seen.length).toBe(2));
    });

    it('a failed register/login never fires onRoleKnown — no result to read a role from', async () => {
      const store = useEntryWorkflowStore();
      const auth = useAuthStore();
      vi.spyOn(auth, 'login').mockResolvedValue({ error: 'Invalid email or password.' });
      const seen = vi.fn();
      store.onRoleKnown(seen);

      store.focus('login', { email: 'a@b.com', password: 'wrong' });
      await vi.waitFor(() => expect(store.errors.login).toBe('Invalid email or password.'));
      expect(seen).not.toHaveBeenCalled();
    });
  });

  // SPEC-22 §5.8 added the fifth "room" (logout/facility_registration/staff_registration) as the
  // real ROLE_SUGGESTIONS replacement. UPDATE — facility_registration/staff_registration then
  // moved OUT to workflow/onboardingJourneys.js's plain ONBOARDING_JOURNEYS list ("no plan
  // definition or workflow is required" for the 3 onboarding entities, explicit instruction; see
  // onboardingJourneys.test.js for their own role-gating tests). No action left in
  // ENTRY_PLAN_DEFINITION carries `roles` any more, so primaryActionIds is now always empty —
  // still asserted here so a future action being given `roles` without updating this expectation
  // fails loudly, not silently.
  describe('primaryActionIds / secondaryActionIds — always empty / always universal, now that roles-based actions moved out', () => {
    it('pre-auth: only the 4 universal actions are secondary; nothing is primary and nothing requiresAuth-gated shows up', () => {
      const store = useEntryWorkflowStore();
      expect(store.primaryActionIds).toEqual([]);
      expect(store.secondaryActionIds.sort()).toEqual(['change_password', 'forgot_password', 'login', 'register']);
    });

    it('signed in (any role): primaryActionIds stays empty, logout joins the universal secondary list', () => {
      const store = useEntryWorkflowStore();
      const auth = useAuthStore();
      auth.currentUser = { id: 'acc1', email: 'a@b.com', role: 'hospital_admin' };

      expect(store.primaryActionIds).toEqual([]);
      expect(store.secondaryActionIds.sort()).toEqual(['change_password', 'forgot_password', 'logout', 'register']);
    });

    it('a non-repeatable action that already reached done (register, after a real registration) drops out on its own — no special-case needed', async () => {
      const store = useEntryWorkflowStore();
      const auth = useAuthStore();
      vi.spyOn(auth, 'register').mockResolvedValue({ user: { id: 'acc1', email: 'a@b.com', role: 'hospital_admin' } });

      store.focus('register', { email: 'a@b.com', password: 'password123', role: 'hospital_admin' });
      await vi.waitFor(() => expect(store.statuses.register).toBe('done'));
      auth.currentUser = { id: 'acc1', email: 'a@b.com', role: 'hospital_admin' };

      expect(store.secondaryActionIds).not.toContain('register'); // done, not ready/active — filtered by status, not a role rule
      expect(store.secondaryActionIds).toContain('logout');
    });
  });

  // SPEC-22 decision #3 — "Cübo mirrors app state": logout resets to General. Centralized here so
  // every real call site (Cubo.vue, ClinicHome.vue, Index.vue) gets the identical behavior instead
  // of each one duplicating auth.logout() + focus/complete('logout') + a thread reset.
  //
  // auth.logout() is mocked in every test below, same convention every other test in this file
  // already uses for register/login — the real implementation touches raw localStorage
  // (removeItem, unguarded, unlike the store's own constructor) which this Node test environment
  // doesn't provide; a pre-existing gap in auth.js, not something this update introduces or is
  // trying to fix here. The mock reproduces logout()'s one real observable effect this store's own
  // logic depends on (currentUser becoming null).
  describe('logout() — centralizes auth.logout() + the tracked action + the Cübo thread reset', () => {
    it('signs out, marks the logout action done, and switches Cübo back to the general thread', () => {
      const store = useEntryWorkflowStore();
      const auth = useAuthStore();
      const cubo = useCuboStore();
      vi.spyOn(auth, 'logout').mockImplementation(() => { auth.currentUser = null; });
      auth.currentUser = { id: 'acc1', email: 'a@b.com', role: 'hospital_admin' };
      // Any non-general thread simulates "logged in, doing something else" — 'administration'
      // (the Hospital Setup checklist's own thread) no longer exists as a category; 'encounter' is
      // still a real one.
      cubo.createNewThread('encounter', 'An Encounter', 'cat-encounter');
      expect(cubo.activeThreadId).toBe('cat-encounter');

      store.logout();

      expect(auth.logout).toHaveBeenCalled();
      expect(auth.currentUser).toBe(null);
      expect(store.statuses.logout).toBe('done');
      expect(cubo.activeThreadId).toBe('default-general');
    });

    it('is idempotent when already on the general thread — no duplicate thread inserted', () => {
      const store = useEntryWorkflowStore();
      const auth = useAuthStore();
      const cubo = useCuboStore();
      vi.spyOn(auth, 'logout').mockImplementation(() => { auth.currentUser = null; });
      const before = chatThreads.toArray.length; // cubo.js's own cleanCuboHistory() already seeded 'default-general' on store creation

      store.logout();

      expect(cubo.activeThreadId).toBe('default-general');
      expect(chatThreads.toArray.length).toBe(before); // createNewThread's has() check — switches, doesn't re-insert
    });

    it('logout is repeatable — a second sign-out (a different account, same session) works too', () => {
      const store = useEntryWorkflowStore();
      const auth = useAuthStore();
      vi.spyOn(auth, 'logout').mockImplementation(() => { auth.currentUser = null; });
      auth.currentUser = { id: 'acc1', email: 'a@b.com', role: 'hospital_admin' };

      store.logout();
      expect(store.statuses.logout).toBe('done');

      auth.currentUser = { id: 'acc2', email: 'c@d.com', role: 'health_professional' };
      store.logout();
      expect(store.statuses.logout).toBe('done');
      expect(auth.currentUser).toBe(null);
    });
  });
});
