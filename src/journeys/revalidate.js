// Journey FHIR resources (the HPR journey's Practitioner, the HFR journey's Organization) are
// validated against their ClinuxFlow profile when the journey saves them (fhir.js keepResource).
// If clinuxflow-fhir-api couldn't be reached then, they're kept as `validation: { status:
// 'pending' }` — this checks them again once it can, the way stores/consent.js re-validates
// pending consents. Called when the workspace opens, and on the Records and Registries pages.
import { accountRecords } from './accountRecords.js';
import { PROFILE, validateResource } from './fhir.js';
import { api } from './fhirApi.js';
import { PROVIDER_RESOURCE } from './hprJourney.js';
import { facilityResourceKey, loadFacilities } from './hfrFacilities.js';

/** Every journey FHIR resource key this account has, with its profile: the HPR Practitioner and one Organization per HFR facility. */
export async function journeyResourceKeys(records) {
  const facilities = await loadFacilities(records);
  return [[PROVIDER_RESOURCE, PROFILE.provider], ...facilities.map((f) => [facilityResourceKey(f.trackingId), PROFILE.facility])];
}

const running = new Map(); // accountId -> promise, so overlapping callers share one pass

/**
 * Re-validates this account's pending journey resources. Resolves to how many got a result
 * (valid or invalid); anything still unreachable stays pending for next time.
 */
export function revalidatePending(accountId, { apiImpl = api, records = accountRecords(accountId) } = {}) {
  if (!accountId) return Promise.resolve(0);
  if (running.has(accountId)) return running.get(accountId);
  const pass = (async () => {
    let checked = 0;
    for (const [key, profile] of await journeyResourceKeys(records)) {
      const rec = await records.get(key);
      if (!rec?.resource || rec.validation?.status !== 'pending') continue;
      const validation = await validateResource(apiImpl, rec.resource, profile);
      if (validation.status === 'pending') break; // still unreachable: don't hammer it
      await records.set(key, { ...rec, validation });
      checked++;
    }
    return checked;
  })().finally(() => running.delete(accountId));
  running.set(accountId, pass);
  return pass;
}
