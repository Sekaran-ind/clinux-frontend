import { describe, expect, it, vi } from 'vitest';
import { createWorkflowRuntime } from './workflowRuntime.js';
import { actionStatus } from './planDefinitionRunner.js';

const TWO_ROOM_PLAN = {
  id: 'test-plan',
  action: [
    { id: 'first', title: 'First' },
    { id: 'second', title: 'Second', relatedAction: [{ actionId: 'first', relationship: 'after-end' }] },
  ],
};

// SPEC-13 §2's runtime — exercises the actual orchestration path (emit onto the shared bus, never
// call .send() on an actor directly), not just that the machine itself works (already covered by
// planDefinitionRunner.test.js).
describe('createWorkflowRuntime', () => {
  it('routes an emitted event to the correct plan actor via planId — never touches the actor directly', () => {
    const runtime = createWorkflowRuntime();
    runtime.registerPlan('test-plan', TWO_ROOM_PLAN);

    runtime.emit({ type: 'FOCUS', planId: 'test-plan', actionId: 'first' });
    expect(actionStatus(runtime.getPlanActor('test-plan').getSnapshot(), 'first')).toBe('active');

    runtime.dispose();
  });

  it('drops an event for an unregistered planId, but records it rather than losing it silently', () => {
    const runtime = createWorkflowRuntime();
    runtime.emit({ type: 'FOCUS', planId: 'no-such-plan', actionId: 'first' });

    expect(runtime.droppedEvents.length).toBe(1);
    expect(runtime.droppedEvents[0].warning).toContain('no-such-plan');

    runtime.dispose();
  });

  it('registerPlan is idempotent — calling it twice for the same planId returns the SAME actor, not a fresh one', () => {
    const runtime = createWorkflowRuntime();
    const first = runtime.registerPlan('test-plan', TWO_ROOM_PLAN);
    first.send({ type: 'FOCUS', actionId: 'first' });

    const second = runtime.registerPlan('test-plan', TWO_ROOM_PLAN);
    expect(second).toBe(first);
    expect(actionStatus(second.getSnapshot(), 'first')).toBe('active'); // not reset to pending

    runtime.dispose();
  });

  it('persists a snapshot on registration AND after every routed event — no gap in the resumable-checkpoint guarantee', () => {
    const persistSnapshot = vi.fn();
    const runtime = createWorkflowRuntime({ persistSnapshot, loadPersistedSnapshot: () => null });

    runtime.registerPlan('test-plan', TWO_ROOM_PLAN);
    expect(persistSnapshot).toHaveBeenCalledTimes(1); // initial snapshot captured too

    runtime.emit({ type: 'FOCUS', planId: 'test-plan', actionId: 'first' });
    expect(persistSnapshot).toHaveBeenCalledTimes(2);

    runtime.emit({ type: 'COMPLETE', planId: 'test-plan', actionId: 'first' });
    expect(persistSnapshot).toHaveBeenCalledTimes(3);

    runtime.dispose();
  });

  it('rehydrates from a persisted snapshot instead of starting fresh — the actual resumability guarantee, not just that persistSnapshot gets called', () => {
    // First runtime: progress a real actor, capture its persisted snapshot for real (not a mock).
    let capturedSnapshot = null;
    const firstRuntime = createWorkflowRuntime({
      persistSnapshot: (planId, actor) => { capturedSnapshot = actor.getPersistedSnapshot(); },
      loadPersistedSnapshot: () => null,
    });
    firstRuntime.registerPlan('test-plan', TWO_ROOM_PLAN);
    firstRuntime.emit({ type: 'FOCUS', planId: 'test-plan', actionId: 'first' });
    firstRuntime.emit({ type: 'COMPLETE', planId: 'test-plan', actionId: 'first' });
    expect(actionStatus(firstRuntime.getPlanActor('test-plan').getSnapshot(), 'second')).toBe('ready');
    firstRuntime.dispose();

    // Second runtime: simulates a page refresh — fresh registry, loads the real captured snapshot.
    const secondRuntime = createWorkflowRuntime({
      persistSnapshot: () => {},
      loadPersistedSnapshot: (planId) => (planId === 'test-plan' ? capturedSnapshot : null),
    });
    const rehydrated = secondRuntime.registerPlan('test-plan', TWO_ROOM_PLAN);
    expect(actionStatus(rehydrated.getSnapshot(), 'first')).toBe('done'); // NOT reset to pending
    expect(actionStatus(rehydrated.getSnapshot(), 'second')).toBe('ready'); // the closed-loop unblock survived the "refresh"

    secondRuntime.dispose();
  });

  // Real bug found live (Hospital setup, SPEC-22 §5.5): a persisted snapshot from an EARLIER,
  // smaller version of a PlanDefinition restored into TODAY's larger machine left XState's own
  // snapshot.value entirely `undefined` — confirmed empirically, not assumed — which read as every
  // action being permanently locked. A plan's shape can genuinely change over time (Hospital setup
  // grew from 4 actions to 10); registerPlan() must detect that and start fresh instead of
  // handing an incompatible snapshot to createActor().
  it('discards an incompatible persisted snapshot (from an EARLIER, differently-shaped version of this planId) and starts fresh, rather than restoring broken state', () => {
    const OLD_SHAPE_PLAN = { id: 'evolving-plan', action: [{ id: 'only_step', title: 'Only Step' }] };
    const NEW_SHAPE_PLAN = {
      id: 'evolving-plan',
      action: [
        { id: 'only_step', title: 'Only Step' },
        { id: 'new_step', title: 'New Step', relatedAction: [{ actionId: 'only_step', relationship: 'after-end' }] },
      ],
    };

    let capturedSnapshot = null;
    const firstRuntime = createWorkflowRuntime({
      persistSnapshot: (planId, actor) => { capturedSnapshot = actor.getPersistedSnapshot(); },
      loadPersistedSnapshot: () => null,
    });
    firstRuntime.registerPlan('evolving-plan', OLD_SHAPE_PLAN);
    firstRuntime.emit({ type: 'FOCUS', planId: 'evolving-plan', actionId: 'only_step' });
    firstRuntime.emit({ type: 'COMPLETE', planId: 'evolving-plan', actionId: 'only_step' });
    firstRuntime.dispose();

    // Simulates the app being upgraded to the new shape while this old snapshot is still in
    // localStorage — the exact real scenario.
    const secondRuntime = createWorkflowRuntime({
      persistSnapshot: () => {},
      loadPersistedSnapshot: (planId) => (planId === 'evolving-plan' ? capturedSnapshot : null),
    });
    const actor = secondRuntime.registerPlan('evolving-plan', NEW_SHAPE_PLAN);
    const snapshot = actor.getSnapshot();

    // Starts genuinely fresh — every real action reaches a real, known status, not undefined/stuck.
    expect(actionStatus(snapshot, 'only_step')).toBe('ready');
    expect(actionStatus(snapshot, 'new_step')).toBe('pending');

    // And the new shape's own real closed loop still works correctly from here.
    secondRuntime.emit({ type: 'FOCUS', planId: 'evolving-plan', actionId: 'only_step' });
    secondRuntime.emit({ type: 'COMPLETE', planId: 'evolving-plan', actionId: 'only_step' });
    expect(actionStatus(secondRuntime.getPlanActor('evolving-plan').getSnapshot(), 'new_step')).toBe('ready');

    secondRuntime.dispose();
  });

  it('dispose() stops every actor and clears the registry — a re-registration after dispose starts fresh, not from stale state', () => {
    const runtime = createWorkflowRuntime();
    runtime.registerPlan('test-plan', TWO_ROOM_PLAN);
    runtime.emit({ type: 'FOCUS', planId: 'test-plan', actionId: 'first' });
    runtime.dispose();

    const runtime2 = createWorkflowRuntime();
    const fresh = runtime2.registerPlan('test-plan', TWO_ROOM_PLAN);
    expect(actionStatus(fresh.getSnapshot(), 'first')).toBe('ready'); // fresh, not 'active' from before

    runtime2.dispose();
  });

  // SPEC-21 §5's role-based next-action triggering — the real "reacting to one action's
  // completion to trigger something OUTSIDE that action" capability SPEC-13 §9 named as missing.
  describe('onActionDone', () => {
    const RESULT_PLAN = {
      id: 'result-plan',
      action: [
        { id: 'login', title: 'Login', repeatable: true },
        { id: 'other', title: 'Other' },
      ],
    };
    function servicesFor(role) {
      return { login: vi.fn(async () => ({ user: { role } })), other: vi.fn(async () => ({ ok: true })) };
    }

    it('fires with the real resolved result when the specific action reaches done', async () => {
      const runtime = createWorkflowRuntime();
      const services = servicesFor('hospital_admin');
      runtime.registerPlan('result-plan', RESULT_PLAN, { services });
      const seen = [];
      runtime.onActionDone('result-plan', 'login', (result) => seen.push(result));

      runtime.emit({ type: 'FOCUS', planId: 'result-plan', actionId: 'login', payload: {} });
      await vi.waitFor(() => expect(seen.length).toBe(1));
      expect(seen[0]).toEqual({ user: { role: 'hospital_admin' } });

      runtime.dispose();
    });

    it('does NOT fire for a different action or a different plan', async () => {
      const runtime = createWorkflowRuntime();
      const services = servicesFor('hospital_admin');
      runtime.registerPlan('result-plan', RESULT_PLAN, { services });
      const loginSeen = vi.fn();
      runtime.onActionDone('result-plan', 'login', loginSeen);
      runtime.onActionDone('some-other-plan', 'login', loginSeen);

      runtime.emit({ type: 'FOCUS', planId: 'result-plan', actionId: 'other', payload: {} });
      await vi.waitFor(() => expect(services.other).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20)); // let any wrongful async fire happen if it were going to
      expect(loginSeen).not.toHaveBeenCalled();

      runtime.dispose();
    });

    it('fires again on a SECOND completion of a repeatable action — the real login-twice case', async () => {
      const runtime = createWorkflowRuntime();
      const services = servicesFor('health_professional');
      runtime.registerPlan('result-plan', RESULT_PLAN, { services });
      const seen = [];
      runtime.onActionDone('result-plan', 'login', (result) => seen.push(result));

      runtime.emit({ type: 'FOCUS', planId: 'result-plan', actionId: 'login', payload: {} });
      await vi.waitFor(() => expect(seen.length).toBe(1));

      runtime.emit({ type: 'FOCUS', planId: 'result-plan', actionId: 'login', payload: {} });
      await vi.waitFor(() => expect(seen.length).toBe(2));

      runtime.dispose();
    });

    it('the returned unsubscribe function stops future firing', async () => {
      const runtime = createWorkflowRuntime();
      const services = servicesFor('hospital_admin');
      runtime.registerPlan('result-plan', RESULT_PLAN, { services });
      const seen = [];
      const unsubscribe = runtime.onActionDone('result-plan', 'login', (result) => seen.push(result));
      unsubscribe();

      runtime.emit({ type: 'FOCUS', planId: 'result-plan', actionId: 'login', payload: {} });
      await vi.waitFor(() => expect(services.login).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.length).toBe(0);

      runtime.dispose();
    });
  });

  // SPEC-20 §4's "Audit now, Observe deferred" decision.
  describe('auditLog', () => {
    it('logs the initial pending->ready transitions on registration, before any event is ever sent', () => {
      const runtime = createWorkflowRuntime();
      runtime.registerPlan('test-plan', TWO_ROOM_PLAN);

      const firstEntry = runtime.auditLog.find((e) => e.actionId === 'first');
      expect(firstEntry).toMatchObject({ type: 'transition', planId: 'test-plan', actionId: 'first', from: null, to: 'ready' });
      // 'second' depends on 'first' — starts pending, not ready, until 'first' is done.
      const secondEntry = runtime.auditLog.find((e) => e.actionId === 'second');
      expect(secondEntry).toMatchObject({ type: 'transition', actionId: 'second', from: null, to: 'pending' });

      runtime.dispose();
    });

    it('logs a real accepted transition when a FOCUS event moves an action ready->active', () => {
      const runtime = createWorkflowRuntime();
      runtime.registerPlan('test-plan', TWO_ROOM_PLAN);
      const before = runtime.auditLog.length;

      runtime.emit({ type: 'FOCUS', planId: 'test-plan', actionId: 'first' });

      const newEntries = runtime.auditLog.slice(before);
      expect(newEntries).toContainEqual(expect.objectContaining({ type: 'transition', actionId: 'first', from: 'ready', to: 'active' }));
      expect(newEntries.some((e) => e.type === 'blocked')).toBe(false);

      runtime.dispose();
    });

    it('logs a blocked attempt, not a transition, when FOCUS targets an action that is not ready yet', () => {
      const runtime = createWorkflowRuntime();
      runtime.registerPlan('test-plan', TWO_ROOM_PLAN);
      const before = runtime.auditLog.length;

      // 'second' is still pending ('first' hasn't completed) — this FOCUS should be rejected by
      // the guard, not silently accepted.
      runtime.emit({ type: 'FOCUS', planId: 'test-plan', actionId: 'second' });

      expect(actionStatus(runtime.getPlanActor('test-plan').getSnapshot(), 'second')).toBe('pending'); // unchanged
      const newEntries = runtime.auditLog.slice(before);
      expect(newEntries).toEqual([{ type: 'blocked', planId: 'test-plan', actionId: 'second', eventType: 'FOCUS', at: expect.any(String) }]);

      runtime.dispose();
    });
  });
});
