import { createIndexedDbCollection } from '../indexedDbCollectionFactory.js';

// SPEC-13 (docs/SPEC-13-FHIR-WORKFLOW-DOCUMENTS-AND-CONFORMANCE.md) §2's runtime persistence —
// the resumable-checkpoint requirement held since the very first turn of this whole design line
// (a room/Task must survive being interrupted mid-encounter), made real for the PlanDefinition
// runner actors in workflow/workflowRuntime.js. One row per running PlanDefinition instance
// (keyed by planId), holding its XState actor's persisted snapshot.
//
// actor.getPersistedSnapshot() — verified this session to be a plain, JSON-round-trip-safe object
// (NOT the richer runtime getSnapshot() object) — and createActor(machine, { snapshot }) rehydrates
// a fresh actor from it.
//
// SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6 — moved from createLocalCollection's
// localStorage backend to indexedDbCollectionFactory.js's IndexedDB one (SPEC-19 §4's own
// precedent). Not because THIS collection's own content outgrows localStorage (one small blob per
// planId), but because it and the new taskAuditLog.js collection are two halves of the same
// federated-Task-persistence feature and belong on the same backend — the storage key changed
// too (below) since collectionFactory's and indexedDbCollectionFactory's storageKey namespaces
// are otherwise indistinguishable and a stale localStorage row from before this migration should
// simply be orphaned, not silently misread as IndexedDB content.
export const taskActorSnapshots = createIndexedDbCollection('cf_task_actor_snapshots_idb_v1', {
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
