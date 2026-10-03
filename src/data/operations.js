// clinuxflow-api's Operations endpoints (routes/operations.js): Activity log, ABDM transactions,
// Access & roles — and the bridge that records a registry journey's outcome in the activity log.
import { apiFetch, API_BASE } from '../config.js';

async function getJson(path) {
  const res = await apiFetch(`${API_BASE}${path}`).catch(() => null);
  if (!res) return { error: 'Could not reach clinuxflow-api.' };
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) return { error: body?.error || `Request failed (${res.status}).` };
  return body;
}

const query = ({ limit, before } = {}) => {
  const q = new URLSearchParams();
  if (limit) q.set('limit', limit);
  if (before) q.set('before', before);
  return q.toString() ? `?${q}` : '';
};

export const fetchAccess = () => getJson('/api/operations/access');
export const fetchAuditEvents = (opts) => getJson(`/api/operations/audit${query(opts)}`);
export const fetchAbdmTransactions = (opts) => getJson(`/api/operations/abdm-transactions${query(opts)}`);

/** Best effort: never throws, never blocks the journey that achieved the thing being logged. */
export async function recordAuditEvent({ action, objectId, metadata }) {
  try {
    await apiFetch(`${API_BASE}/api/operations/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, objectId, metadata }),
    });
  } catch { /* the journey's own result stands */ }
}

const fact = (event, label) => (event.facts || []).find(([k]) => k === label)?.[1];

/**
 * A journey's journal event (clinux-cubo's journal shape: { journey, title, facts }) -> the audit
 * action it corresponds to, or null. Lets the ported HPR/HFR journeys feed the activity log
 * without editing them. The server sanitises metadata again (identifiers/statuses only).
 */
export function journalToAudit(event) {
  if (!event) return null;
  const { journey, title = '' } = event;
  if (journey === 'hpr' && title.startsWith('HPR ID linked')) return { action: 'hpr.linked', objectId: fact(event, 'HPR ID'), metadata: { hprId: fact(event, 'HPR ID'), via: 'sign-in' } };
  if (journey === 'hpr' && title.startsWith('HPR ID created')) return { action: 'hpr.registered', objectId: fact(event, 'HPR ID'), metadata: { hprId: fact(event, 'HPR ID'), via: 'registration' } };
  if (journey === 'hfr' && title.startsWith('HFR draft')) return { action: 'hfr.draft_saved', objectId: fact(event, 'Tracking id'), metadata: { trackingId: fact(event, 'Tracking id') } };
  if (journey === 'hfr' && title.endsWith('submitted to HFR')) return { action: 'hfr.submitted', objectId: fact(event, 'Facility id'), metadata: { facilityId: fact(event, 'Facility id'), trackingId: fact(event, 'Tracking id') } };
  if (journey === 'abha') {
    const metadata = { abhaNumber: fact(event, 'ABHA number'), abhaAddress: fact(event, 'ABHA address'), recordId: event.recordId, mode: fact(event, 'Via'), kind: fact(event, 'Patient') };
    if (title === 'Patient created from ABHA') return { action: 'abha.patient_created', objectId: event.recordId, metadata };
    if (title === 'ABHA recorded on a patient') return { action: 'abha.recorded', objectId: event.recordId, metadata };
  }
  return null;
}
