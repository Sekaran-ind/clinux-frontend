// The HFR facilities this account has registered or started, kept on this device by the HFR
// journey. An account can register many facilities; each is independent (not tied to the
// Facility profile) and is identified by its HFR tracking id:
//   { trackingId, facilityName, stage: 'basic'|'additional'|'detailed', systemsOfMedicine,
//     typesOfService, address, facilityId?, status?, createdAt, updatedAt?, submittedAt? }
// A facility with a facilityId is submitted: the journey only shows it, read-only.
//
// Each facility's FHIR Organization is kept under its own key (facilityResourceKey).
// Before multiple facilities, the journey kept one record (`abdm:hfr`) and one Organization
// (`fhir:facility`); loadFacilities moves those into the list the first time it runs.

export const HFR_FACILITIES = 'abdm:hfr:facilities';
const LEGACY_RECORD = 'abdm:hfr';
const LEGACY_RESOURCE = 'fhir:facility';

export const facilityResourceKey = (trackingId) => `fhir:facility:${trackingId}`;
export const isSubmitted = (f) => !!f?.facilityId;

/** This account's HFR facilities, newest first (migrating the single legacy record once). */
export async function loadFacilities(records) {
  let list = await records.get(HFR_FACILITIES);
  if (!Array.isArray(list)) {
    list = [];
    const legacy = await records.get(LEGACY_RECORD);
    if (legacy?.trackingId) {
      list.push({ ...legacy });
      const org = await records.get(LEGACY_RESOURCE);
      if (org?.resource) await records.set(facilityResourceKey(legacy.trackingId), org);
    }
    await records.set(HFR_FACILITIES, list);
  }
  return [...list].sort((a, b) => String(b.updatedAt || b.submittedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.submittedAt || a.createdAt || '')));
}

/** Adds or updates (by tracking id) one facility; returns the saved entry. */
export async function saveFacility(records, entry) {
  const list = (await records.get(HFR_FACILITIES)) || [];
  const i = list.findIndex((f) => f.trackingId === entry.trackingId);
  const saved = i >= 0 ? { ...list[i], ...entry } : entry;
  if (i >= 0) list[i] = saved;
  else list.push(saved);
  await records.set(HFR_FACILITIES, list);
  return saved;
}

/** Forgets a draft on this device (HFR keeps it). Submitted facilities are never removed. */
export async function forgetDraft(records, trackingId) {
  const list = (await records.get(HFR_FACILITIES)) || [];
  await records.set(HFR_FACILITIES, list.filter((f) => f.trackingId !== trackingId || isSubmitted(f)));
}

/** One line per facility, for lists and cards. */
export function facilityLine(f) {
  if (isSubmitted(f)) return `${f.facilityName} · ${f.facilityId}${f.status ? ` · ${f.status}` : ''}`;
  const next = { basic: 'programmes and services next', additional: 'specialities next', detailed: 'ready to submit' }[f.stage || 'basic'];
  return `${f.facilityName} · draft ${f.trackingId} · ${next}`;
}
