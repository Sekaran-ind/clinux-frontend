import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { useAuthStore } from './auth.js';
import { useCuboStore } from './cubo.js';
import { createWorkflowRuntime } from '../workflow/workflowRuntime.js';
import { ENTRY_PLAN_DEFINITION, buildEntryServices } from '../workflow/entryPlanDefinition.js';
import { actionStatus, actionError } from '../workflow/planDefinitionRunner.js';
import { taskActorSnapshots, persistActorSnapshot, loadPersistedSnapshot } from '../data/collections/taskActorSnapshots.js';
import { appendAuditEntry } from '../data/collections/taskAuditLog.js';
import { pushTaskSnapshot, pushTaskAuditEntry } from '../data/runtime/taskSync.js';

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
  // SPEC-25 §6/§9's durable mirror is per-clinic infrastructure — every route keys on the bare
  // `:planId` alone (task_snapshots.plan_id is its PRIMARY KEY). ENTRY_PLAN_DEFINITION.id
  // ('unauth-entry-v1') is a shared TEMPLATE id, the SAME literal string for every account in
  // the system — a real bug found while wiring this, not hypothetical: pushing it bare would
  // have every user's register/login snapshot silently overwrite every OTHER user's row on the
  // same primary key, and commingle every account's audit entries under one plan_id. Every other
  // real consumer of this pattern in this app (encounter_assignments, provider_composition) is
  // keyed by a genuinely unique per-instance id (an actual encounterId/clinicId) — this plan is
  // the odd one out specifically because it was designed local-only, pre-SPEC-25, where "one
  // shared planId per device" was a safe assumption (local storage is already scoped to whoever
  // is using that device). Scoping the DURABLE key to `${planId}:${accountId}` restores real
  // per-instance isolation without touching task-db.js/the routes/the migration at all — they
  // already treat :planId as an opaque string. Anonymous (pre-login) transitions have no
  // accountId to scope by yet, so they simply aren't pushed durably at all — correct, not a
  // shortcut: "resume on another device" only means something once there's a real identity to
  // resume AS (same reasoning SPEC-25 §7 already applied to Patient never holding a login).
  function durableTaskKey() {
    const accountId = authStore.currentUser?.id;
    return accountId ? `${PLAN_ID}:${accountId}` : null;
  }

  const runtime = createWorkflowRuntime({
    // Local write always happens first and always succeeds; the durable D1 push (SPEC-25 §6/§9,
    // clinuxflow-api's /api/tasks/:planId/*) is best-effort on top, fired but not awaited — same
    // "local-first collection is source of truth between syncs" contract every other paid-tier
    // mirror in this app already has. loadPersistedSnapshot deliberately stays LOCAL-only for
    // this plan (registerPlan() needs it synchronous — see ensureStarted() below on why even the
    // local IndexedDB read already needed care here) — a genuine cross-device "resume this plan
    // on a device that's never touched it locally" pull is left to fetchTaskSnapshot() in
    // taskSync.js for whichever future PlanDefinition consumer actually needs that (SPEC-25 §10
    // step 6 is the live-verify checkpoint for it), not forced into this one's hot path now.
    persistSnapshot: (planId, actor) => {
      persistActorSnapshot(planId, actor);
      const durableKey = durableTaskKey();
      if (durableKey) pushTaskSnapshot(durableKey, actor.getPersistedSnapshot());
    },
    loadPersistedSnapshot,
    // SPEC-25 §6/§10 step 2 — this store is the one place that actually knows who's logged in
    // (workflowRuntime.js itself deliberately doesn't), so it's the wrapper that adds accountId
    // before the entry is durably written. Anonymous (pre-login/register) transitions still get
    // persisted locally — accountId is simply null until authStore.currentUser exists, and the
    // durable push is skipped entirely then (see durableTaskKey() above — matches migrations/
    // 0010's own NOT NULL account_id, there's no authenticated session to push through anyway).
    persistAuditEntry: (entry) => {
      const accountId = authStore.currentUser?.id ?? null;
      const record = appendAuditEntry({ ...entry, accountId });
      const durableKey = durableTaskKey();
      if (durableKey) pushTaskAuditEntry(durableKey, { taskId: record.taskId, actionId: entry.actionId, fromStatus: entry.from, toStatus: entry.to, accountId });
    },
  });
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
  async function ensureStarted() {
    if (started) return;
    started = true;
    // SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6 moved taskActorSnapshots.js onto
    // indexedDbCollectionFactory.js's real IndexedDB backend. Unlike the localStorage backend it
    // replaced (synchronous hydration), IndexedDB's initial load is genuinely async — a real,
    // found-not-assumed gap: without waiting here, a persisted snapshot from an earlier real
    // session isn't visible yet to registerPlan()'s synchronous loadPersistedSnapshot() check on
    // a freshly-loaded page, so EVERY reload would silently look like a brand-new session,
    // defeating the exact resumability guarantee this whole runtime exists for (caught by a
    // failing integration test once taskActorSnapshots.js moved backends, not theoretical).
    // preload() is TanStack DB's own "wait for the first real sync commit" primitive — falls
    // through to a fresh start on failure (e.g. IndexedDB genuinely unavailable) rather than
    // leaving the store stuck mid-registration.
    try { await taskActorSnapshots.preload(); } catch (e) { /* unavailable — start fresh below */ }
    runtime.registerPlan(PLAN_ID, ENTRY_PLAN_DEFINITION, { services: buildEntryServices(authStore) });
    // registerPlan() already calls actor.start() internally (firing its OWN persistence
    // subscription immediately with the initial snapshot) before this line ever runs — a real
    // bug caught by a failing test, not assumed: subscribing here only gets FUTURE transitions,
    // XState doesn't replay the already-fired initial one to a late subscriber. refresh() once,
    // manually, right after subscribing, to seed statuses/errors with the current state too.
    runtime.getPlanActor(PLAN_ID).subscribe(refresh);
    refresh();
  }
  // Kept, not just fire-and-forget: focus()/complete() below await it before emitting, so a
  // caller that fires either in the first tick after store creation (a real, if narrow, race
  // against IndexedDB's genuinely-async preload — see ensureStarted() above) still works
  // correctly instead of being silently dropped by runtime.emit()'s own "unknown planId" guard.
  // Also exported (`ready`, below) for tests that check `statuses`/`errors` directly rather than
  // through focus() — those have no event to hang a wait off of, so they await this instead.
  const readyPromise = ensureStarted();

  function focus(actionId, payload) {
    readyPromise.then(() => runtime.emit({ type: 'FOCUS', planId: PLAN_ID, actionId, payload }));
  }
  // The manual-completion half of the "Pinia pub/sub" pattern (user's own term) that replaces a
  // build-time services map for a designer-authored action with no real invoke: something OUTSIDE
  // the plan (a click handler) fires COMPLETE itself once the real work is actually done — logout
  // is the one real case left in this plan (see logout() below).
  function complete(actionId, payload) {
    readyPromise.then(() => runtime.emit({ type: 'COMPLETE', planId: PLAN_ID, actionId, payload }));
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
    onRoleKnown, activeEntryAction, selectEntryAction, clearEntryAction, ready: readyPromise,
  };
});
