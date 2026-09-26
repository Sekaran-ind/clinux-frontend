// Client wrapper for clinuxflow-api's generic StructureDefinition-anchored routes
// (src/routes/control.js's /api/resources/:resourceType/*, resource-registry.js) — Patient is
// the only registered resourceType today. Same "local-first stays primary, this is a best-effort
// paid-tier mirror" contract taskSync.js/encounterCoordination.js already established: never
// gate on tier client-side (that's a staleness risk — the server is the single source of truth
// for tier), just call the route and treat a 403 as "free tier, no cross-device reach, proceed"
// — same convention acquireTaskLock/acquireWorklistLock already use.
import { API_BASE, apiFetch } from '../../config.js';

async function jsonOrNull(res) {
  try { return await res.json(); } catch (e) { return null; }
}

// Pure conformance check (requireUser() only server-side — works on any tier). Same
// { success, valid, errors, resource, nextActions } shape POST /api/patient/conformance already
// returns, now registry-driven and including the real Patient-graph next-action once valid.
export async function checkResourceConformance(resourceType, questionnaireJson, responseJson) {
  try {
    const res = await apiFetch(`${API_BASE}/api/resources/${encodeURIComponent(resourceType)}/conformance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionnaireJson, responseJson }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) return { error: body.error || `Request failed (${res.status}).` };
    return body;
  } catch (err) {
    return { error: 'Could not reach clinuxflow-api — ' + err.message };
  }
}

// Best-effort paid-tier mirror push — call AFTER a successful local save, never instead of one.
// recordId is the caller's own stable local record id (formData.js's row id) — see the route's
// own header comment on why it's required. Returns null on any failure (network, free tier, or
// clinuxflow-api being unreachable) rather than throwing — a failed mirror push must never roll
// back or block the local save that already succeeded.
export async function pushResourceRecord(resourceType, questionnaireJson, responseJson, recordId) {
  const res = await apiFetch(`${API_BASE}/api/resources/${encodeURIComponent(resourceType)}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionnaireJson, responseJson, recordId }),
  }).catch(() => null);
  if (!res || res.status === 403) return null; // free tier — no cross-device mirror, local save already stands
  const body = await jsonOrNull(res);
  return body?.success ? body : null;
}

// Cross-device search — paid tier only server-side; a free-tier caller gets back an empty list
// (403 -> []) rather than an error, so a directory UI can fall back to its own local-only filter
// silently instead of surfacing a scary error for an expected, ordinary case.
export async function searchResourceRecords(resourceType, query) {
  const res = await apiFetch(`${API_BASE}/api/resources/${encodeURIComponent(resourceType)}/search?q=${encodeURIComponent(query || '')}`).catch(() => null);
  if (!res || res.status === 403) return [];
  const body = await jsonOrNull(res);
  return body?.success ? body.records : [];
}
