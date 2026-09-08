import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { useAuthStore } from './auth.js';
import { useCuboStore } from './cubo.js';
import { createWorkflowRuntime } from '../workflow/workflowRuntime.js';
import { ENTRY_PLAN_DEFINITION, buildEntryServices } from '../workflow/entryPlanDefinition.js';
import { actionStatus, actionError } from '../workflow/planDefinitionRunner.js';
import { persistActorSnapshot, loadPersistedSnapshot } from '../data/collections/taskActorSnapshots.js';

// SPEC-20's real home for ENTRY_PLAN_DEFINITION's runtime — a Pinia store, not a page-local
// instance. Corrects the first version of this build (a standalone GetStarted.vue page owning
// its own local runtime): the auth journey is now hosted INSIDE Cübo's existing 'general'
// category thread (see stores/cubo.js's CUBO_CATEGORIES — 'general' already existed as "a
// persistent session channel, not a scoped workspace tied to one record"), reachable from any
// page that mounts <Cubo>, so the runtime instance needs to be an app-wide singleton the same way
// the cubo/auth stores already are, not something re-created per page.
//
// Persisted via taskActorSnapshots.js — same collection/pattern every other PlanDefinition runner
// instance uses, real resumability across a reload (a partially-filled register step, or an
// interrupted forgot-password flow, survives it).
export const useEntryWorkflowStore = defineStore('entryWorkflow', () => {
  const authStore = useAuthStore();
  const cubo = useCuboStore();
  const runtime = createWorkflowRuntime({ persistSnapshot: persistActorSnapshot, loadPersistedSnapshot });
  const PLAN_ID = ENTRY_PLAN_DEFINITION.id;

  // Mirrors the actor's own status/error into plain reactive state on every transition — same
  // reasoning GetStarted.vue's now-removed local version used: form components shouldn't need to
  // know planDefinitionRunner.js's snapshot shape, just read statuses.register / errors.register.
  const statuses = reactive({});
  const errors = reactive({});
  const auditLog = ref([]); // kept for potential future use (a debug view, etc.) — not surfaced
  // in any UI in this pass; SPEC-20's real audit surfacing is narrated as Cübo chat messages by
  // the form components themselves instead (more native to the chat metaphor than a log pane).

  function refresh() {
    const actor = runtime.getPlanActor(PLAN_ID);
    if (!actor) return;
    const snapshot = actor.getSnapshot();
    (ENTRY_PLAN_DEFINITION.action || []).forEach((a) => {
      statuses[a.id] = actionStatus(snapshot, a.id);
      errors[a.id] = actionError(snapshot, a.id);
    });
    auditLog.value = [...runtime.auditLog];
  }

  let started = false;
  function ensureStarted() {
    if (started) return;
    started = true;
    runtime.registerPlan(PLAN_ID, ENTRY_PLAN_DEFINITION, { services: buildEntryServices(authStore) });
    // registerPlan() already calls actor.start() internally (firing its OWN persistence
    // subscription immediately with the initial snapshot) before this line ever runs — a real
    // bug caught by a failing test, not assumed: subscribing here only gets FUTURE transitions,
    // XState doesn't replay the already-fired initial one to a late subscriber. refresh() once,
    // manually, right after subscribing, to seed statuses/errors with the current state too.
    runtime.getPlanActor(PLAN_ID).subscribe(refresh);
    refresh();
  }
  ensureStarted(); // cheap — registering a plan does no network I/O, only focus() does

  function focus(actionId, payload) {
    runtime.emit({ type: 'FOCUS', planId: PLAN_ID, actionId, payload });
  }
  // The manual-completion half of the "Pinia pub/sub" pattern (user's own term) that replaces a
  // build-time services map for a designer-authored action with no real invoke: something OUTSIDE
  // the plan (a click handler) fires COMPLETE itself once the real work is actually done — logout
  // is the one real case left in this plan (see logout() below).
  function complete(actionId, payload) {
    runtime.emit({ type: 'COMPLETE', planId: PLAN_ID, actionId, payload });
  }

  // SPEC-22 decision #3 — "Cübo mirrors app state": logout resets to General. The single, real
  // home for every logout call site (Cubo.vue's Next Action, ClinicHome.vue's Sign Out,
  // Index.vue's header) — previously each one duplicated its own auth.logout() +
  // focus/complete('logout') sequence; centralizing here is what makes the thread-reset
  // guaranteed to happen regardless of which page's UI triggered it, not something each caller
  // has to remember to also do. createNewThread('general', ..., 'default-general') is idempotent
  // (switches to the existing general thread if one exists, per its own has() check) — safe to
  // call unconditionally rather than checking the current category first.
  function logout() {
    authStore.logout();
    focus('logout');
    complete('logout');
    cubo.createNewThread('general', 'General AI Terminal', 'default-general');
  }

  // The filter every "should this action be offered right now" question in this app now goes
  // through — login's post-auth exclusion and logout's requiresAuth gate are read straight off
  // ENTRY_PLAN_DEFINITION's own action objects, not a second lookup keyed by role. `roles`-based
  // gating (originally added for facility_registration/staff_registration) stays generically
  // supported here even though no current action in this plan uses it — a real future auth action
  // could still need it, and the mechanism costs nothing to keep.
  function isVisible(action) {
    if (action.id === 'login' && authStore.currentUser) return false; // already signed in
    if (action.requiresAuth && !authStore.currentUser) return false;
    if (action.roles && (!authStore.currentUser || !action.roles.includes(authStore.currentUser.role))) return false;
    return true;
  }
  const actionableActions = computed(() =>
    (ENTRY_PLAN_DEFINITION.action || []).filter((a) => isVisible(a) && (statuses[a.id] === 'ready' || statuses[a.id] === 'active'))
  );
  // UPDATE — facility_registration/staff_registration (the only actions that ever carried `roles`)
  // moved out to workflow/onboardingJourneys.js's plain ONBOARDING_JOURNEYS list ("no plan
  // definition or workflow is required" for the 3 onboarding entities, explicit instruction) — so
  // primaryActionIds is now always empty; register/login/forgot_password/change_password/logout
  // are all genuinely universal (no `roles`), which is exactly what secondaryActionIds already
  // captures. Left both computeds in place rather than collapsing to one list: the primary/
  // secondary split is still the right shape if a future auth action ever needs role-targeting,
  // and Cübo.vue's own real "targeted suggestion" section now comes from
  // onboardingJourneys.visibleOnboardingJourneys() instead — a separate concept, not a gap here.
  const primaryActionIds = computed(() => actionableActions.value.filter((a) => a.roles).map((a) => a.id));
  const secondaryActionIds = computed(() => actionableActions.value.filter((a) => !a.roles).map((a) => a.id));

  // SPEC-21 (docs/SPEC-21-STATE-MACHINE-MAP-SIX-DIMENSION-ARCHITECTURE.md) §5's role-based
  // next-action triggering, made real: register/login both resolve with a real account carrying
  // `role` (clinuxflow-api's own POST /api/auth/register and login routes) — previously that
  // value was read straight off the form's own local state (RegisterForm.vue) or not threaded
  // through at all (LoginForm.vue), never actually sourced from the runtime. Wires
  // workflowRuntime.js's new onActionDone to BOTH register and login (either one is a real
  // "the user is now known" moment), fires callback(role, actionId) — the caller (Cübo.vue)
  // decides what a role-appropriate next step looks like, this store only knows the role.
  function onRoleKnown(callback) {
    const unsubRegister = runtime.onActionDone(PLAN_ID, 'register', (result) => {
      if (result?.user?.role) callback(result.user.role, 'register');
    });
    const unsubLogin = runtime.onActionDone(PLAN_ID, 'login', (result) => {
      if (result?.user?.role) callback(result.user.role, 'login');
    });
    return () => { unsubRegister(); unsubLogin(); };
  }

  // SPEC-22 (docs/SPEC-22-PERSISTED-WORKFLOW-SYSTEM-FLOWS-CUBO-STATE-MIRROR-DRAWER-CAPTURE.md)
  // §5.1's 3-pane shell — the shared link between Cübo's own nav strip (sets this) and whichever
  // host page owns the content pane (reads it, renders ENTRY_FORM_COMPONENTS[activeEntryAction]).
  // Lives here, not as component-local state in either Cubo.vue or the host page, because both
  // need to read/write the SAME value and neither is an ancestor of the other (Cübo and the
  // host-page content pane are DOM siblings, not parent/child) — same reasoning `statuses`/
  // `errors` above are store state rather than a prop threaded down.
  const activeEntryAction = ref(null);
  function selectEntryAction(actionId) { activeEntryAction.value = actionId; }
  function clearEntryAction() { activeEntryAction.value = null; }

  return {
    statuses, errors, auditLog, focus, complete, logout, primaryActionIds, secondaryActionIds,
    onRoleKnown, activeEntryAction, selectEntryAction, clearEntryAction,
  };
});
