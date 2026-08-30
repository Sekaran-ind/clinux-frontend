import { createLocalCollection } from '../collectionFactory.js';

// SPEC-13 (docs/SPEC-13-FHIR-WORKFLOW-DOCUMENTS-AND-CONFORMANCE.md) §2's runtime persistence —
// the resumable-checkpoint requirement held since the very first turn of this whole design line
// (a room/Task must survive being interrupted mid-encounter), made real for the PlanDefinition
// runner actors in workflow/workflowRuntime.js. One row per running PlanDefinition instance
// (keyed by planId), holding its XState actor's persisted snapshot.
//
// actor.getPersistedSnapshot() — verified this session to be a plain, JSON-round-trip-safe object
// (NOT the richer runtime getSnapshot() object) — and createActor(machine, { snapshot }) rehydrates
// a fresh actor from it. Same createLocalCollection pattern every other collection in this app
// already uses (formData.js, chatThreads.js), not a new storage mechanism.
export const taskActorSnapshots = createLocalCollection('cf_task_actor_snapshots_v1', {
  getKey: (r) => r.planId,
});

export function persistActorSnapshot(planId, actor) {
  const snapshot = actor.getPersistedSnapshot();
  if (taskActorSnapshots.has(planId)) {
    taskActorSnapshots.update(planId, (draft) => {
      draft.snapshot = snapshot;
      draft.updatedAt = Date.now();
    });
  } else {
    taskActorSnapshots.insert({ planId, snapshot, updatedAt: Date.now() });
  }
}

export function loadPersistedSnapshot(planId) {
  const record = taskActorSnapshots.get(planId);
  return record ? record.snapshot : null;
}
