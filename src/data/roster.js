// The doctor roster (pages/DoctorRoster.vue): clinuxflow-api's routes/roster.js holds who works at
// which HFR facility; clinuxflow-abdm-gateway's POST /hpr/search finds a practitioner in HPR and
// signs an attestation, which is the only way the API accepts someone as "HPR verified".
import { apiFetch, API_BASE } from '../config.js';
import { gateway } from '../journeys/gateway.js';
import { loadFacilities } from '../journeys/hfrFacilities.js';

async function call(path, { method = 'GET', body } = {}) {
  const res = await apiFetch(`${API_BASE}${path}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }).catch(() => null);
  if (!res) return { error: 'Could not reach clinuxflow-api.' };
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) return { error: data?.error || `Request failed (${res.status}).` };
  return data;
}

export function fetchRoster({ facilityId, includeLeft } = {}) {
  const q = new URLSearchParams();
  if (facilityId) q.set('facilityId', facilityId);
  if (includeLeft) q.set('includeLeft', '1');
  return call(`/api/roster${q.toString() ? `?${q}` : ''}`);
}
export const fetchRosterFacilities = () => call('/api/roster/facilities');
export const addToRoster = (body) => call('/api/roster', { method: 'POST', body });
export const updateRosterEntry = (id, patch) => call(`/api/roster/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });

/** HPR search through the gateway: { hprId } (14 digits or name@hpr.abdm) or { mobile }. Throws a readable error. */
export async function searchHpr(query) {
  const res = await gateway('/hpr/search', { method: 'POST', body: query });
  return res.matches || [];
}

/** HPR's public profile for one practitioner (fetch-professional-info), flattened. */
export async function fetchHprProfile(hprIdNumber) {
  const res = await gateway('/hpr/professional/fetch', { method: 'POST', body: { hprId: hprIdNumber } });
  return (res.practitioners || []).flat()[0] || null;
}

export const ROLE_LABELS = { doctor: 'Doctor', nurse: 'Nurse', pharmacist: 'Pharmacist', other: 'Other' };
export const ROLE_OF_CATEGORY = { 1: 'doctor', 2: 'nurse', 6: 'pharmacist' };

/**
 * The facilities a roster can be kept for, one entry per HFR facility id: the HFR facilities this
 * account submitted (journeys/hfrFacilities.js), those already on the clinic's roster, and those
 * taking Scan & Share. Drafts (no facility id yet) can't have a roster.
 */
export function facilityOptions({ hfr = [], roster = [], scanShare = [] } = {}) {
  const byId = new Map();
  const add = (id, name, source) => {
    if (!id) return;
    const prev = byId.get(id);
    byId.set(id, { facilityId: id, facilityName: prev?.facilityName || name || '', sources: [...new Set([...(prev?.sources || []), source])] });
  };
  for (const f of hfr) if (f.facilityId) add(f.facilityId, f.facilityName, 'hfr');
  for (const f of roster) add(f.facilityId, f.facilityName, 'roster');
  for (const f of scanShare) add(f.facilityId, f.facilityName, 'scan-share');
  return [...byId.values()].sort((a, b) => a.facilityName.localeCompare(b.facilityName) || a.facilityId.localeCompare(b.facilityId));
}

// HFR facilities found by id (rather than registered from this account), kept per account on
// this device so the roster and Scan & Share both offer them.
const FOUND_KEY = 'roster:facilities';

/** Every facility this account can keep a roster or take Scan & Share for (see facilityOptions). */
export async function knownFacilities(records, { scanShare = [] } = {}) {
  const [hfr, roster, found] = await Promise.all([
    records ? loadFacilities(records).catch(() => []) : [],
    fetchRosterFacilities().then((r) => r.facilities || []).catch(() => []),
    records ? records.get(FOUND_KEY).then((v) => v || []).catch(() => []) : [],
  ]);
  return facilityOptions({ hfr, roster: [...roster, ...found], scanShare });
}

/** Looks an HFR facility up by id in HFR (through the gateway) and remembers it; returns it or throws. */
export async function findHfrFacility(records, facilityId) {
  const id = String(facilityId || '').trim().toUpperCase();
  if (!/^IN[A-Z0-9]{10}$/.test(id)) throw new Error('An HFR facility id starts with IN and has 12 characters.');
  const res = await gateway('/hfr/facility/search', { method: 'POST', body: { facilityId: id, ownershipCode: '', stateLGDCode: '', facilityName: '', page: 1, resultsPerPage: 10 } });
  const f = (res.facilities || []).find((x) => x.facilityId === id);
  if (!f) throw new Error('HFR has no facility with that id.');
  const entry = { facilityId: id, facilityName: f.facilityName };
  if (records) {
    const found = (await records.get(FOUND_KEY).catch(() => null)) || [];
    await records.set(FOUND_KEY, [...found.filter((x) => x.facilityId !== id), entry]);
  }
  return entry;
}
