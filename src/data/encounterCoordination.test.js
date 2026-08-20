import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireWorklistLock } from './encounterCoordination.js';

// This test environment (plain vitest, no jsdom) has no global `localStorage` at all —
// apiFetch() (config.js) reads it directly with no try/catch, so it has to be stubbed for any
// module that goes through apiFetch, same pattern sessionShare.test.js already established.
function fakeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
vi.stubGlobal('localStorage', fakeLocalStorage());

// Real, live-found regression: on the free tier, the lock endpoint is requirePaidTier()-gated
// server-side and 403s -- acquireWorklistLock() used to read that as a real failure, which
// silently blocked Checkout's steps screen (and Front Desk's "resume a session" path) entirely
// for every free-tier clinic, since both require this call to succeed first. Free tier has no
// cross-device concurrency this lock exists to protect against (SPEC-05 §2/§6's single-admin-
// device/LAN-shared model), so a 403 specifically should let the caller proceed.
describe('acquireWorklistLock', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = vi.spyOn(global, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('treats a 403 (free tier, paid-only feature) as success -- no coordination needed, proceed', async () => {
    fetchSpy.mockResolvedValue({
      status: 403,
      json: async () => ({ success: false, error: 'This feature requires a paid subscription.' }),
    });
    const result = await acquireWorklistLock('enc-1', 'checkout');
    expect(result).toEqual({ success: true });
  });

  it('treats a real 409 conflict (someone else holds the lock) as a genuine failure', async () => {
    fetchSpy.mockResolvedValue({
      status: 409,
      json: async () => ({ success: false, lockedBy: 'Dr. Mehta' }),
    });
    const result = await acquireWorklistLock('enc-1', 'checkout');
    expect(result).toEqual({ success: false, lockedBy: 'Dr. Mehta' });
  });

  it('succeeds on a normal 200 lock acquisition', async () => {
    fetchSpy.mockResolvedValue({ status: 200, json: async () => ({ success: true }) });
    const result = await acquireWorklistLock('enc-1', 'checkout');
    expect(result).toEqual({ success: true });
  });

  it('still fails on a genuine network error', async () => {
    fetchSpy.mockRejectedValue(new Error('offline'));
    const result = await acquireWorklistLock('enc-1', 'checkout');
    expect(result.success).toBe(false);
  });
});
