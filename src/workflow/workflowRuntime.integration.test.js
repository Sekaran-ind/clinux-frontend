// SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6 moved taskActorSnapshots.js onto
// indexedDbCollectionFactory.js's real IndexedDB backend — this file exercises that REAL backend
// (not a mock), so it needs the same 'fake-indexeddb/auto' polyfill
// indexedDbCollectionFactory.test.js's own header already documents (vitest isolates globals per
// test file, so importing it there doesn't cover this file). Must be the first import — idb-keyval
// reads the `indexedDB` global at call time, and a real failure mode was found here, not
// hypothetical: without this, taskActorSnapshots' underlying idbSet() throws (indexedDB
// undefined) inside an un-awaited async persist path, which silently rolled back the just-applied
// OPTIMISTIC insert between this file's two `it()` blocks — the first test's own synchronous
// assertions still passed (the optimistic value was applied and readable right up until the
// rejection resolved), only the second test's "resume after a refresh" read came up empty. That's
// exactly the kind of gap a plain "does it crash" check wouldn't have caught.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createWorkflowRuntime } from './workflowRuntime.js';
import { actionStatus, readyActionIds } from './planDefinitionRunner.js';
import { taskActorSnapshots, persistActorSnapshot, loadPersistedSnapshot } from '../data/collections/taskActorSnapshots.js';

// Integration test — the REAL persistence collection (data/collections/taskActorSnapshots.js,
// indexedDbCollectionFactory.js-backed as of SPEC-25 §6, same primitive taskAuditLog.js also
// uses) wired into a REAL createWorkflowRuntime(), driving the actual five-room PlanDefinition
// shape (matches clinuxflow-api/samples/workflow-definition-v1.draft.yaml's worked example,
// already verified there end to end through the compiler+extractor). Proves the pieces fit
// together, not just each in isolation — workflowRuntime.test.js already covers the runtime alone
// with injected mocks.
const FIVE_ROOM_PLAN = {
  id: 'clinic-visit-workflow-v1',
  action: [
    { id: 'facility_registration', title: 'Facility Registration' },
    { id: 'provider_registration', title: 'Provider Registration', relatedAction: [{ actionId: 'facility_registration', relationship: 'after-start' }] },
    { id: 'front_desk', title: 'Front Desk', relatedAction: [{ actionId: 'facility_registration', relationship: 'after-end' }] },
    {
      id: 'consultation_desk', title: 'Consultation Desk',
      relatedAction: [
        { actionId: 'front_desk', relationship: 'after-end' },
        { actionId: 'provider_registration', relationship: 'after-start' },
      ],
    },
    { id: 'checkout', title: 'Checkout', relatedAction: [{ actionId: 'consultation_desk', relationship: 'after-end' }] },
  ],
};

describe('Facility Registration Task, wired through the real runtime + real persistence', () => {
  it('completing Facility Registration through the event bus unblocks Provider Registration AND Front Desk — the closed loop, with real persistence, not mocks', () => {
    if (taskActorSnapshots.has(FIVE_ROOM_PLAN.id)) taskActorSnapshots.delete(FIVE_ROOM_PLAN.id); // clean slate

    const runtime = createWorkflowRuntime({ persistSnapshot: persistActorSnapshot, loadPersistedSnapshot });
    runtime.registerPlan(FIVE_ROOM_PLAN.id, FIVE_ROOM_PLAN);

    expect(readyActionIds(runtime.getPlanActor(FIVE_ROOM_PLAN.id).getSnapshot(), FIVE_ROOM_PLAN)).toEqual(['facility_registration']);

    runtime.emit({ type: 'FOCUS', planId: FIVE_ROOM_PLAN.id, actionId: 'facility_registration' });
    runtime.emit({ type: 'COMPLETE', planId: FIVE_ROOM_PLAN.id, actionId: 'facility_registration' });

    const snapshot = runtime.getPlanActor(FIVE_ROOM_PLAN.id).getSnapshot();
    expect(actionStatus(snapshot, 'facility_registration')).toBe('done');
    expect(readyActionIds(snapshot, FIVE_ROOM_PLAN).sort()).toEqual(['front_desk', 'provider_registration']);

    // Real persistence — not a mock. Confirm it actually landed in the real collection.
    const persisted = taskActorSnapshots.get(FIVE_ROOM_PLAN.id);
    expect(persisted).toBeTruthy();
    expect(persisted.snapshot.value.facility_registration).toBe('done');

    runtime.dispose();
  });

  it('resuming after a simulated refresh — a fresh runtime rehydrates from the real persisted collection, not from scratch', () => {
    // Depends on the previous test having left a real persisted record — same collection, real
    // IndexedDB-backed persistence, not reset between these two `it`s on purpose: this is exactly
    // the "closed the browser, came back" scenario this whole design line has held as a
    // requirement since its first turn.
    const runtime = createWorkflowRuntime({ persistSnapshot: persistActorSnapshot, loadPersistedSnapshot });
    const actor = runtime.registerPlan(FIVE_ROOM_PLAN.id, FIVE_ROOM_PLAN);

    expect(actionStatus(actor.getSnapshot(), 'facility_registration')).toBe('done');
    expect(readyActionIds(actor.getSnapshot(), FIVE_ROOM_PLAN).sort()).toEqual(['front_desk', 'provider_registration']);

    runtime.dispose();
    taskActorSnapshots.delete(FIVE_ROOM_PLAN.id); // clean up after ourselves
  });
});
