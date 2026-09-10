import { createIndexedDbCollection } from '../indexedDbCollectionFactory.js';

// SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6's durable half of the audit trail
// SPEC-20 §4 originally designed — workflowRuntime.js's own `auditLog` array is real but
// in-memory-only, lost on reload. This collection is what makes it survive one. IndexedDB, not
// localStorage (indexedDbCollectionFactory.js, SPEC-19 §4's own precedent) — part of the second
// real use of that protocol (alongside taskActorSnapshots.js's own migration to the same
// backend), and the right call specifically because an append-only log genuinely can
// outgrow localStorage's ~5-10MB quota over a long-running federated journey, the same reasoning
// AI Engine's own bulk records needed it for.
//
// Append-only by construction: every write here is `insert`, never `update` — even a
// lock-bypassed double-write (SPEC-25 §4) still lands as its own entry instead of overwriting
// anything, which is the whole point (reconstructable after the fact, not silently lost).
export const taskAuditLog = createIndexedDbCollection('cf_task_audit_log_v1', {
  getKey: (r) => r.id,
});

let seq = 0;
function nextEntryId() {
  // Timestamp-prefixed so natural key order already approximates insertion order, same
  // reasoning encounterDocs.js's own generated ids use — a real tie-break, not just uniqueness.
  return `audit_${Date.now()}_${(seq++).toString(36)}`;
}

// `${planId}:${actionId}` — the stable id one running PlanDefinition action's Task instance is
// known by everywhere in SPEC-25 (local collections, D1's task_audit_log.task_id, lock
// acquisition) — a plain deterministic composite, not a second id scheme to keep in sync.
export function taskId(planId, actionId) {
  return `${planId}:${actionId}`;
}

// entry: workflowRuntime.js's own audit record ({type, planId, actionId, from, to, at} or
// {type:'blocked', planId, actionId, eventType, at}), plus whatever the caller adds (accountId —
// workflowRuntime.js itself is deliberately auth-agnostic, see its own header, so the caller
// wiring persistAuditEntry is what knows who's logged in, not this collection or that module).
export function appendAuditEntry(entry) {
  const record = { id: nextEntryId(), taskId: taskId(entry.planId, entry.actionId), ...entry };
  taskAuditLog.insert(record);
  return record;
}

// Every entry for one running plan, oldest first — what a live-verify pass (SPEC-25 §10 step 6)
// or a future audit-trail UI reconstructs the real sequence of transitions from.
export function listAuditEntries(planId) {
  return taskAuditLog.toArray
    .filter((r) => r.planId === planId)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
