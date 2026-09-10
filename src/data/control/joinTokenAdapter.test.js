import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueJoinToken, listJoinTokens, listPendingJoinRequests, renewJoinToken, redeemJoinToken, deliverJoinRequestPayload, getJoinRequestPayload, decideJoinToken } from './joinTokenAdapter.js';

function fakeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
vi.stubGlobal('localStorage', fakeLocalStorage());

describe('joinTokenAdapter', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = vi.spyOn(global, 'fetch'); });
  afterEach(() => vi.restoreAllMocks());

  it('issueJoinToken returns the real body on success', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, token: 'ABC12345', expiresAt: 'x' }) });
    const result = await issueJoinToken('staff');
    expect(result.token).toBe('ABC12345');
  });

  it('issueJoinToken surfaces the gate error with its stage', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 409, json: async () => ({ success: false, error: 'Publish first.', stage: 'draft' }) });
    const result = await issueJoinToken('staff');
    expect(result.error).toBe('Publish first.');
  });

  it('listJoinTokens returns the token list', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, tokens: [{ token: 'X' }] }) });
    const result = await listJoinTokens();
    expect(result.tokens).toEqual([{ token: 'X' }]);
  });

  it('listPendingJoinRequests returns the pending list', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, pending: [{ token: 'X', adminName: 'New Hire' }] }) });
    const result = await listPendingJoinRequests();
    expect(result.pending).toEqual([{ token: 'X', adminName: 'New Hire' }]);
  });

  it('getJoinRequestPayload returns the stored ciphertext', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, ciphertext: 'cfx1.xxx' }) });
    const result = await getJoinRequestPayload('ABC12345');
    expect(result.ciphertext).toBe('cfx1.xxx');
  });

  it('renewJoinToken returns the new expiry', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, expiresAt: 'later' }) });
    const result = await renewJoinToken('ABC12345');
    expect(result.expiresAt).toBe('later');
  });

  it('redeemJoinToken posts the given body and returns success fields', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, sessionToken: 'jwt', admin: { name: 'Dr A' } }) });
    const result = await redeemJoinToken('ABC12345', { email: 'a@b.com', password: 'password123' });
    expect(result.sessionToken).toBe('jwt');
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toContain('/api/facility/join-tokens/ABC12345/redeem');
    expect(JSON.parse(call[1].body)).toEqual({ email: 'a@b.com', password: 'password123' });
  });

  it('deliverJoinRequestPayload posts the ciphertext', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    await deliverJoinRequestPayload('ABC12345', 'cfx1.xxx');
    const call = fetchSpy.mock.calls[0];
    expect(JSON.parse(call[1].body)).toEqual({ ciphertext: 'cfx1.xxx' });
  });

  it('decideJoinToken posts decision + role', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, decision: 'approved' }) });
    const result = await decideJoinToken('ABC12345', 'approved', 'Visiting Cardiologist');
    expect(result.decision).toBe('approved');
    const call = fetchSpy.mock.calls[0];
    expect(JSON.parse(call[1].body)).toEqual({ decision: 'approved', role: 'Visiting Cardiologist' });
  });

  it('returns a network error string when fetch itself throws', async () => {
    fetchSpy.mockRejectedValue(new Error('offline'));
    const result = await issueJoinToken('staff');
    expect(result.error).toContain('Could not reach clinuxflow-api');
  });
});
