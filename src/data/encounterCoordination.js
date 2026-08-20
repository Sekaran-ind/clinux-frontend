// Client wrapper for clinuxflow-api's encounter routing/locking endpoints (see clinuxflow-api's
// migrations/0006 + src/index.js). This is deliberately server-authoritative, not local-first —
// unlike the rest of this app's TanStack DB collections, an assignment/lock has to be durable
// even if the recipient's device is offline when it's made (see the design discussion this
// followed: chat's ephemeral, client-side-only model is wrong for this specific need, a lost
// routing decision is a real clinical hand-off failure, not a missed casual message). Also
// deliberately connectivity-mode-agnostic — these calls go straight to clinuxflow-api regardless
// of whether the device is on the clinic's LAN or not, since assignment/lock behavior must be
// identical in both modes (an explicit decision, not a default).
import { API_BASE, apiFetch } from '../config.js';

async function jsonOrNull(res) {
  try { return await res.json(); } catch (e) { return null; }
}

export async function assignToSpecialist(encounterId, assignedToAccountId) {
  const res = await apiFetch(`${API_BASE}/api/encounters/${encodeURIComponent(encounterId)}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignedToAccountId }),
  }).catch(() => null);
  const body = res ? await jsonOrNull(res) : null;
  if (!body?.success) return { error: body?.error || 'Network error — please try again.' };
  return { success: true };
}

// Attempts to acquire the shared-worklist lock for Front Desk/Checkout. Returns
// { success: true } or { success: false, lockedBy } — lockedBy is a display name, present only
// on a genuine 409 (someone else holds it), so the caller can show "Currently being worked on by
// Dr. X" instead of a bare failure.
//
// Free tier gets a real, live-confirmed exception: the lock endpoint is requirePaidTier()-gated
// server-side (paid-tier-only cross-device coordination, see SPEC-05 §6), which used to mean a
// free-tier clinic's 403 read as "lock acquisition failed" and silently blocked Checkout's steps
// screen entirely — every single path into it (and Front Desk's own "resume a session" path)
// requires this call to succeed first, so there was no way around it. But free tier's whole
// model (SPEC-05 §2/§6: single admin device, or LAN-shared with the same local trust boundary) has
// no real concurrent-access risk this lock exists to protect against in the first place — a paid-
// tier CONVENIENCE, not something free tier's correctness depends on. So a 403 specifically
// (not a 409 genuine conflict, not a network error) is treated as "no coordination needed,
// proceed" rather than a failure.
export async function acquireWorklistLock(encounterId, stage) {
  const res = await apiFetch(`${API_BASE}/api/encounters/${encodeURIComponent(encounterId)}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
  }).catch(() => null);
  if (!res) return { success: false, error: 'Network error — please try again.' };
  if (res.status === 403) return { success: true }; // free tier: no cross-device coordination to protect, proceed
  const body = await jsonOrNull(res);
  if (res.status === 409) return { success: false, lockedBy: body?.lockedBy || 'another staff member' };
  if (!body?.success) return { success: false, error: body?.error || 'Could not acquire the lock.' };
  return { success: true };
}

export async function renewWorklistLock(encounterId, stage) {
  await apiFetch(`${API_BASE}/api/encounters/${encodeURIComponent(encounterId)}/lock/renew`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
  }).catch(() => null);
}

export async function releaseWorklistLock(encounterId, stage) {
  await apiFetch(`${API_BASE}/api/encounters/${encodeURIComponent(encounterId)}/lock/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
  }).catch(() => null);
}

// Current assignment/lock holder for one encounter+stage, or null if unassigned/unlocked (or the
// lock has expired — the server already treats an expired lock as if it never existed).
export async function getEncounterAssignmentStatus(encounterId, stage) {
  const res = await apiFetch(`${API_BASE}/api/encounters/${encodeURIComponent(encounterId)}/assignment?stage=${encodeURIComponent(stage)}`).catch(() => null);
  if (!res) return null;
  const body = await jsonOrNull(res);
  return body?.success ? body.assignment : null;
}

// The caller's own queue for a stage — what ActiveSessionsLanding.vue's "assigned to me" filter
// and the polling notifier below both read from.
export async function listMyAssignments(stage) {
  const res = await apiFetch(`${API_BASE}/api/encounters/assignments?stage=${encodeURIComponent(stage)}`).catch(() => null);
  if (!res) return [];
  const body = await jsonOrNull(res);
  return body?.success ? body.assignments : [];
}

export async function fetchEncounterDocument(encounterId) {
  const res = await apiFetch(`${API_BASE}/api/encounters/${encodeURIComponent(encounterId)}`).catch(() => null);
  if (!res || res.status === 404) return null;
  const body = await jsonOrNull(res);
  return body?.success ? body.data : null;
}

export async function pushEncounterDocument(encounterId, data) {
  await apiFetch(`${API_BASE}/api/encounters/${encodeURIComponent(encounterId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => null);
}

// --- Polling notifier: "you have a new Consultation assignment" ---
// Simple polling, deliberately not a Durable-Object push channel — see the design discussion
// this followed. An assignment notification doesn't have chat's real-time-or-it-feels-broken
// requirement; checking every 20s is a perfectly reasonable user experience for "you have a new
// case," and it's dramatically simpler to build/verify than a push mechanism. If this ever needs
// to feel more immediate, upgrading the transport here to whatever real-time channel chat
// eventually uses is a contained change — this function's callers don't need to know which one
// is underneath.
const POLL_INTERVAL_MS = 20000;
const SEEN_KEY = 'cf_seen_assignment_ids';

function readSeenIds() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch (e) { return new Set(); }
}
function writeSeenIds(ids) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...ids])); } catch (e) { /* ignore */ }
}

let pollTimer = null;

// onNewAssignment(assignment) fires once per genuinely NEW assignment id seen since the last
// poll on THIS device — not on every poll tick, and not for assignments already known about
// (e.g. from a previous session, or ones this same tab already surfaced).
export function startAssignmentPolling(onNewAssignment) {
  stopAssignmentPolling();
  const seen = readSeenIds();

  async function tick() {
    const assignments = await listMyAssignments('consultation');
    const currentIds = assignments.map((a) => a.encounterId);
    const freshOnes = assignments.filter((a) => !seen.has(a.encounterId));
    freshOnes.forEach((a) => { seen.add(a.encounterId); onNewAssignment(a); });
    writeSeenIds(seen);
  }

  tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopAssignmentPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
