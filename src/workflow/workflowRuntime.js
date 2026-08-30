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
// — see authPlanDefinition.js — is the first real case). What's still NOT handled here: reacting
// to one action's completion to trigger something OUTSIDE that action (registering a different
// PlanDefinition next, a cross-Task notification) — that's still open, tracked in SPEC-13 §9.
export function createWorkflowRuntime({ persistSnapshot = () => {}, loadPersistedSnapshot = () => null } = {}) {
  const events$ = new Subject();
  const registry = new Map(); // planId -> { actor, planDefinition }

  function registerPlan(planId, planDefinition, { services } = {}) {
    const existing = registry.get(planId);
    if (existing) return existing.actor;

    const snapshot = loadPersistedSnapshot(planId);
    const machine = buildPlanDefinitionRunnerMachine(planDefinition, { services });
    const actor = snapshot ? createActor(machine, { snapshot }) : createActor(machine);

    registry.set(planId, { actor, planDefinition });
    // Subscribing (not persisting only right after each dispatched event) is what actually
    // covers invoke-triggered transitions — verified empirically this session that an invoked
    // service's async onDone/onError fires actor.subscribe() the same as a synchronous .send()
    // does. A post-send-only persist would miss exactly the case this slice was built to prove:
    // register/login/change-password's real API calls resolving after the event that started them.
    actor.subscribe(() => persistSnapshot(planId, actor));
    actor.start(); // fires the subscription once immediately with the initial snapshot too
    return actor;
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
    entry.actor.send(event);
  });

  function dispose() {
    subscription.unsubscribe();
    registry.forEach(({ actor }) => actor.stop());
    registry.clear();
  }

  return { events$, emit, registerPlan, getPlanActor, droppedEvents, dispose };
}
