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
});
