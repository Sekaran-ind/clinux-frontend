import { describe, expect, it, vi } from 'vitest';
import { revalidatePending } from './revalidate.js';
import { HFR_FACILITIES, facilityResourceKey } from './hfrFacilities.js';
const FACILITY_RESOURCE = facilityResourceKey('T1');
import { PROVIDER_RESOURCE } from './hprJourney.js';

const org = { resourceType: 'Organization', id: 'o1' };
const prac = { resourceType: 'Practitioner', id: 'p1' };
const store = (init) => {
  const m = new Map(Object.entries(init));
  return { get: async (k) => m.get(k), set: async (k, v) => m.set(k, v), m };
};
const okApi = vi.fn(async () => ({ ok: true, status: 200, data: { resourceType: 'OperationOutcome', issue: [] } }));

describe('revalidatePending', () => {
  it('checks pending journey resources again and keeps the result', async () => {
    const records = store({ [HFR_FACILITIES]: [{ trackingId: 'T1', facilityName: 'X' }], [FACILITY_RESOURCE]: { resource: org, validation: { status: 'pending', issues: [] } }, [PROVIDER_RESOURCE]: { resource: prac, validation: { status: 'valid', issues: [] } } });
    expect(await revalidatePending('acc-1', { apiImpl: okApi, records })).toBe(1);
    expect(records.m.get(FACILITY_RESOURCE).validation.status).toBe('valid');
    expect(okApi).toHaveBeenCalledTimes(1); // the already-valid Practitioner isn't sent again
  });
  it('leaves them pending while the FHIR API is still unreachable', async () => {
    const records = store({ [HFR_FACILITIES]: [{ trackingId: 'T1', facilityName: 'X' }], [FACILITY_RESOURCE]: { resource: org, validation: { status: 'pending', issues: [] } } });
    const down = async () => { throw new Error('offline'); };
    expect(await revalidatePending('acc-2', { apiImpl: down, records })).toBe(0);
    expect(records.m.get(FACILITY_RESOURCE).validation.status).toBe('pending');
  });
});
