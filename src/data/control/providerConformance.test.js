import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkProviderConformance } from './providerConformance.js';

function fakeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
vi.stubGlobal('localStorage', fakeLocalStorage());

describe('checkProviderConformance', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = vi.spyOn(global, 'fetch'); });
  afterEach(() => vi.restoreAllMocks());

  it('returns the real body on success', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, providers: [{ practitioner: { id: 'p1' }, practitionerValid: true, role: { id: 'r1' }, roleValid: true }], nextActions: [] }),
    });
    const result = await checkProviderConformance({ item: [] }, { item: [] });
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].practitionerValid).toBe(true);
  });

  it('surfaces the server-reported error on a non-2xx response', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 400, json: async () => ({ success: false, error: 'questionnaireJson and responseJson are both required.' }) });
    const result = await checkProviderConformance(null, null);
    expect(result.error).toBe('questionnaireJson and responseJson are both required.');
    expect(result.providers).toBeUndefined();
  });

  it('surfaces a real network failure rather than throwing out of the caller', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const result = await checkProviderConformance({ item: [] }, { item: [] });
    expect(result.error).toContain('network down');
  });
});
