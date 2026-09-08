import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkFacilityConformance } from './facilityConformance.js';

// This test environment (plain vitest, no jsdom) has no global `localStorage` — apiFetch()
// (config.js) reads it directly, same stub encounterCoordination.test.js already establishes.
function fakeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
vi.stubGlobal('localStorage', fakeLocalStorage());

describe('checkFacilityConformance', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = vi.spyOn(global, 'fetch'); });
  afterEach(() => vi.restoreAllMocks());

  it('returns the real body on success', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, valid: true, errors: [], organization: { resourceType: 'Organization', id: 'org-1' }, nextActions: [] }),
    });
    const result = await checkFacilityConformance({ item: [] }, { item: [] });
    expect(result.valid).toBe(true);
    expect(result.organization.id).toBe('org-1');
  });

  it('surfaces the server-reported error on a non-2xx response instead of pretending success', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 400, json: async () => ({ success: false, error: 'questionnaireJson and responseJson are both required.' }) });
    const result = await checkFacilityConformance(null, null);
    expect(result.error).toBe('questionnaireJson and responseJson are both required.');
    expect(result.valid).toBeUndefined();
  });

  it('surfaces a real network failure rather than throwing out of the caller', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const result = await checkFacilityConformance({ item: [] }, { item: [] });
    expect(result.error).toContain('network down');
  });
});
