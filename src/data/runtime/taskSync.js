// SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6/§9/§10 step 5 — client wrapper for
// clinuxflow-api's Task persistence routes (src/routes/runtime.js's /api/tasks/:planId/*).
// Deliberately mirrors encounterCoordination.js's own shape: local-first primary (IndexedDB, via
// taskActorSnapshots.js/taskAuditLog.js), this is a best-effort durable mirror on top, explicit
// push/pull, never automatic — "local write always happens first and always succeeds" (§6's own
// contract). Free tier gets a plain 403 from every route here (requirePaidTier()-gated
// server-side, SPEC-05 §6) and simply never benefits from cross-device sync — that's fine, it
// still gets local IndexedDB + LAN sync (sharedServerSync.js) automatically for these two
// collections, zero extra code (§6/§8's own point).
import { API_BASE, apiFetch } from '../../config.js';

async function jsonOrNull(res) {
  try { return await res.json(); } catch (e) { return null; }
}

// --- Snapshot mirror ---

export async function pushTaskSnapshot(planId, snapshot) {
  await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(planId)}/snapshot`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  }).catch(() => null); // best-effort — same swallow-on-failure convention as pushEncounterDocument
}

export async function fetchTaskSnapshot(planId) {
  const res = await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(planId)}/snapshot`).catch(() => null);
  if (!res || res.status === 404) return null;
  const body = await jsonOrNull(res);
  return body?.success ? body.snapshot : null;
}

// --- Audit log mirror ---
// Skips entirely when accountId is null (an anonymous pre-login transition, e.g. SPEC-20's own
// register/login flow) — matches migrations/0010's own NOT NULL account_id, and there's no
// authenticated session to push through yet anyway at that point. The local IndexedDB entry
// (taskAuditLog.js) still records it either way; only the durable mirror is skipped.
export async function pushTaskAuditEntry(planId, { taskId, actionId, fromStatus, toStatus, accountId }) {
  if (!accountId) return;
  await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(planId)}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, actionId, fromStatus, toStatus }),
  }).catch(() => null);
}

// The full durable trail for one plan — used to reconcile local history against what other
// devices/roles have contributed (SPEC-25 §10 step 6's live-verify), not on any hot path.
export async function fetchTaskAuditLog(planId) {
  const res = await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(planId)}/audit`).catch(() => null);
  if (!res) return [];
  const body = await jsonOrNull(res);
  return body?.success ? body.entries : [];
}

// --- Single-writer lock ---
// Same "403 means free tier, no coordination needed, proceed" exception acquireWorklistLock
// (encounterCoordination.js) already established — a Task's single-writer enforcement is a
// paid-tier CONVENIENCE for cross-device federation (SPEC-25 §4), not something a single free-
// tier device's own correctness depends on.
export async function acquireTaskLock(planId) {
  const res = await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(planId)}/lock`, { method: 'POST' }).catch(() => null);
  if (!res) return { success: false, error: 'Network error — please try again.' };
  if (res.status === 403) return { success: true };
  const body = await jsonOrNull(res);
  if (res.status === 409) return { success: false, lockedBy: body?.lockedBy || 'another device' };
  if (!body?.success) return { success: false, error: body?.error || 'Could not acquire the lock.' };
  return { success: true };
}

export async function renewTaskLock(planId) {
  await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(planId)}/lock/renew`, { method: 'POST' }).catch(() => null);
}

export async function releaseTaskLock(planId) {
  await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(planId)}/lock/release`, { method: 'POST' }).catch(() => null);
}

// Current/last holder for one plan, or null if never locked — powers a "being worked on
// elsewhere" indicator, same shape as getEncounterAssignmentStatus.
export async function getTaskLock(planId) {
  const res = await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(planId)}/lock`).catch(() => null);
  if (!res) return null;
  const body = await jsonOrNull(res);
  return body?.success ? body.lock : null;
}
