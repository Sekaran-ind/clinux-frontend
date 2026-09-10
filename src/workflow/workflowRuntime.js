import { Subject } from 'rxjs';
import { createActor } from 'xstate';
import { buildPlanDefinitionRunnerMachine } from './planDefinitionRunner.js';

// SPEC-13 (docs/SPEC-13-FHIR-WORKFLOW-DOCUMENTS-AND-CONFORMANCE.md) §2's runtime, made real — the
// central orchestrator this session's design discussion settled on before any of it got built:
// no UI component ever calls an XState actor's .send() directly. Every action (a button click
// today; later Cübo-classified intents, remote WebSocket events) pushes an event onto ONE shared
// RxJS bus. This module's dispatcher is the ONLY code path that reads that bus and calls .send()
// on an actor — that's what makes this genuinely orchestrated (one central authority deciding
// what happens) rather than choreographed (each component wiring its own reaction, which drifts).
//
// A factory, not module-level singletons — real app code should call this once and share the
// instance (e.g. provide/inject, or a Pinia store wrapping it), but tests need independent
// instances that don't bleed state into each other, which singletons would prevent.
//
// Persistence (data/collections/taskActorSnapshots.js) is INJECTED, not imported directly here —
// keeps this module testable without touching real localStorage/TanStack DB, and keeps the
// runtime's own logic decoupled from one specific storage choice, same reasoning
// local-extractor.js's injectable identityResolvers already used this session. Both default to
// no-ops, so omitting them is safe — just non-resumable, which is exactly what an in-memory-only
// test actor should be.
//
// Side effects: `registerPlan`'s optional `services` map is passed straight through to
// planDefinitionRunner.js's `invoke` support (built this session, register/login/change-password
// — see authPlanDefinition.js — is the first real case). `onActionDone` (SPEC-21 §5) is the
// cross-plan-triggering capability SPEC-13 §9 named as still open — "reacting to one action's
// completion to trigger something OUTSIDE that action" — made real.
export function createWorkflowRuntime({
  persistSnapshot = () => {},
  loadPersistedSnapshot = () => null,
  // SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6/§10 step 2's durable audit trail —
  // same injection-point discipline as persistSnapshot/loadPersistedSnapshot above (testable
  // without touching real storage, decoupled from one specific backend). Deliberately NOT given
  // the accountId itself — this module has no auth context by design (see this function's own
  // header) — the caller's wrapper (entryWorkflow.js) is what knows who's logged in and adds it
  // when actually persisting.
  persistAuditEntry = () => {},
} = {}) {
  const events$ = new Subject();
  const registry = new Map(); // planId -> { actor, planDefinition, lastValue }

  // SPEC-20 (docs/SPEC-20-REFERENCE-PATTERN-JOURNEY-WORKBENCH-AND-UNAUTH-CUBO-ENTRY.md) §4's
  // "Audit now, Observe deferred" decision — a real, structured transition/blocked-attempt log,
  // additive on top of the actor.subscribe() persistence hook already here, not new machinery.
  // Only two of the reference demo's three audit categories are populated: HFSM transitions (a
  // real per-action status diff on every snapshot) and blocked/invalid attempts (an event sent
  // for a planId/actionId whose status didn't move, meaning its guard rejected it). The third —
  // "Copilot interactions" (suggested/applied/dismissed) — is deliberately NOT logged here yet:
  // there's no real Copilot suggestion mechanism anywhere in this app to generate such an event
  // from (Cübo's own "AI" is still a single canned reply, per the AI Engine work this session) —
  // logging it now would mean logging nothing real. Add it once SPEC-06/07's agentic dispatch
  // layer exists and actually produces suggest/apply/dismiss events.
  const auditLog = [];
  function logAudit(entry) {
    const record = { at: new Date().toISOString(), ...entry };
    auditLog.push(record);
    // SPEC-25 §6 — the durable half of this same log. Best-effort by design (same "local write
    // always happens first and always succeeds" contract every persistence hook in this app
    // already has, see persistSnapshot above) — a caller that doesn't inject a real
    // persistAuditEntry (a test, or a runtime instance nobody wired up) still gets the in-memory
    // array unchanged, just not durably.
    persistAuditEntry(record);
  }

  // SPEC-21 (docs/SPEC-21-STATE-MACHINE-MAP-SIX-DIMENSION-ARCHITECTURE.md) §5's role-based
  // next-action triggering — the real, missing capability SPEC-13 §9 named: "reacting to one
  // action's completion to trigger something OUTSIDE that action." Callbacks are keyed by
  // `${planId}:${actionId}` and fire with (result, context) every time that action transitions
  // INTO 'done' — including a second time for a `repeatable` action (planDefinitionRunner.js),
  // since diffAndLogTransitions below fires on every real from!==to move, not just the first.
  // Deliberately app-level callbacks, not "register a different plan" baked in here directly —
  // keeps this module from needing to know what a caller wants to do next (show a suggestion,
  // register a second plan, fire a notification), same separation-of-concerns registerPlan's own
  // services injection already uses.
  const doneTriggers = new Map(); // `${planId}:${actionId}` -> Set<callback>
  function onActionDone(planId, actionId, callback) {
    const key = `${planId}:${actionId}`;
    if (!doneTriggers.has(key)) doneTriggers.set(key, new Set());
    doneTriggers.get(key).add(callback);
    return () => doneTriggers.get(key)?.delete(callback);
  }

  function registerPlan(planId, planDefinition, { services } = {}) {
    const existing = registry.get(planId);
    if (existing) return existing.actor;

    let snapshot = loadPersistedSnapshot(planId);
    // Real bug found live: a persisted snapshot from an EARLIER version of this planId's
    // PlanDefinition (fewer/different actions — exactly what happened when Hospital setup grew
    // from 4 to 10 actions) restored into today's machine leaves XState's own snapshot.value
    // broken (confirmed empirically: entirely `undefined`, not just missing the new regions) —
    // every action then reads as an unknown status, which Cubo.vue's own "disabled unless ready"
    // checklist rendering shows as permanently locked. A PlanDefinition's shape can genuinely
    // change over time; this isn't Hospital-setup-specific, so the fix belongs here, not in one
    // caller — discard an incompatible snapshot and start fresh rather than trying to restore it,
    // same principle a schema migration would use.
    if (snapshot) {
      const expectedActionIds = (planDefinition.action || []).map((a) => a.id).sort();
      const restoredActionIds = Object.keys(snapshot.value || {}).sort();
      const isCompatible = restoredActionIds.length === expectedActionIds.length
        && restoredActionIds.every((id, i) => id === expectedActionIds[i]);
      if (!isCompatible) snapshot = null;
    }

    const machine = buildPlanDefinitionRunnerMachine(planDefinition, { services });
    const actor = snapshot ? createActor(machine, { snapshot }) : createActor(machine);

    const entry = { actor, planDefinition, lastValue: null };
    registry.set(planId, entry);
    // Subscribing (not persisting only right after each dispatched event) is what actually
    // covers invoke-triggered transitions — verified empirically this session that an invoked
    // service's async onDone/onError fires actor.subscribe() the same as a synchronous .send()
    // does. A post-send-only persist would miss exactly the case this slice was built to prove:
    // register/login/change-password's real API calls resolving after the event that started them.
    actor.subscribe((snap) => {
      diffAndLogTransitions(planId, planDefinition, entry, snap);
      persistSnapshot(planId, actor);
    });
    actor.start(); // fires the subscription once immediately with the initial snapshot too
    return actor;
  }

  // Compares this snapshot's per-action status against the last one recorded for this plan,
  // logging one 'transition' audit entry per action whose status actually moved. First call per
  // plan (lastValue still null, right after actor.start()) logs each action's initial state as
  // its own transition from null — "HFSM initialized" in the reference demo's own terms. Also
  // fires any onActionDone triggers registered for an action that just moved INTO 'done'.
  function diffAndLogTransitions(planId, planDefinition, entry, snap) {
    const value = snap.value;
    (planDefinition.action || []).forEach((action) => {
      const from = entry.lastValue ? entry.lastValue[action.id] : null;
      const to = value[action.id];
      if (from === to) return;
      logAudit({ type: 'transition', planId, actionId: action.id, from, to });
      if (to === 'done') {
        const result = snap.context[`result_${action.id}`] ?? null;
        doneTriggers.get(`${planId}:${action.id}`)?.forEach((cb) => cb(result, snap.context));
      }
    });
    entry.lastValue = { ...value };
  }

  function getPlanActor(planId) {
    return registry.get(planId)?.actor || null;
  }

  function emit(event) {
    events$.next(event);
  }

  const droppedEvents = []; // inspectable — an event for an unregistered planId isn't silently lost
  const subscription = events$.subscribe((event) => {
    const entry = registry.get(event.planId);
    if (!entry) {
      const warning = `Workflow event "${event.type}" for unknown planId "${event.planId}" — dropped.`;
      console.warn(`⚠️ ${warning}`);
      droppedEvents.push({ event, warning });
      return;
    }
    // A blocked/invalid attempt: the targeted action's own status didn't move as a result of this
    // exact event — its guard rejected it (e.g. FOCUS on an action that wasn't 'ready').
    // diffAndLogTransitions (fired synchronously by the .send() below, via actor.subscribe) has
    // already updated entry.lastValue by the time this line runs, so compare against the status
    // captured just before sending.
    const statusBefore = entry.lastValue ? entry.lastValue[event.actionId] : undefined;
    entry.actor.send(event);
    const statusAfter = entry.lastValue ? entry.lastValue[event.actionId] : undefined;
    if (event.actionId && statusBefore === statusAfter) {
      logAudit({ type: 'blocked', planId: event.planId, actionId: event.actionId, eventType: event.type });
    }
  });

  function dispose() {
    subscription.unsubscribe();
    registry.forEach(({ actor }) => actor.stop());
    registry.clear();
  }

  return { events$, emit, registerPlan, getPlanActor, onActionDone, droppedEvents, auditLog, dispose };
}
