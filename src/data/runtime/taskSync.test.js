import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pushTaskSnapshot, fetchTaskSnapshot, pushTaskAuditEntry, fetchTaskAuditLog, acquireTaskLock, getTaskLock } from './taskSync.js';

// Same localStorage stub encounterCoordination.test.js already established — this plain vitest
// environment has no global `localStorage`, and apiFetch() (config.js) reads it directly.
function fakeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
vi.stubGlobal('localStorage', fakeLocalStorage());

describe('taskSync.js — SPEC-25 §6/§9/§10 step 5', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = vi.spyOn(global, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  describe('pushTaskSnapshot / fetchTaskSnapshot', () => {
    it('PUTs the raw snapshot object as the request body', async () => {
      fetchSpy.mockResolvedValue({ status: 200, json: async () => ({ success: true }) });
      await pushTaskSnapshot('plan1', { value: { register: 'done' } });
      const [, options] = fetchSpy.mock.calls[0];
      expect(options.method).toBe('PUT');
      expect(JSON.parse(options.body)).toEqual({ value: { register: 'done' } });
    });

    it('a genuine network error is swallowed — best-effort, never throws', async () => {
      fetchSpy.mockRejectedValue(new Error('offline'));
      await expect(pushTaskSnapshot('plan1', {})).resolves.toBeUndefined();
    });

    it('fetch returns null on a 404 (nothing pushed yet)', async () => {
      fetchSpy.mockResolvedValue({ status: 404, json: async () => ({}) });
      const result = await fetchTaskSnapshot('plan1');
      expect(result).toBeNull();
    });

    it('fetch returns the parsed snapshot on success', async () => {
      fetchSpy.mockResolvedValue({ status: 200, json: async () => ({ success: true, snapshot: { value: { register: 'done' } } }) });
      const result = await fetchTaskSnapshot('plan1');
      expect(result).toEqual({ value: { register: 'done' } });
    });
  });

  describe('pushTaskAuditEntry', () => {
    it('skips the network call entirely when accountId is null — anonymous local-only entry', async () => {
      await pushTaskAuditEntry('plan1', { taskId: 'plan1:register', actionId: 'register', toStatus: 'ready', accountId: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs {taskId, actionId, fromStatus, toStatus} — never a client-supplied accountId in the body', async () => {
      fetchSpy.mockResolvedValue({ status: 200, json: async () => ({ success: true }) });
      await pushTaskAuditEntry('plan1', { taskId: 'plan1:register', actionId: 'register', fromStatus: 'ready', toStatus: 'done', accountId: 'acc1' });
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/tasks/plan1/audit');
      expect(JSON.parse(options.body)).toEqual({ taskId: 'plan1:register', actionId: 'register', fromStatus: 'ready', toStatus: 'done' });
    });
  });

  describe('fetchTaskAuditLog', () => {
    it('returns [] on a network error rather than throwing', async () => {
      fetchSpy.mockRejectedValue(new Error('offline'));
      expect(await fetchTaskAuditLog('plan1')).toEqual([]);
    });

    it('returns the entries array on success', async () => {
      fetchSpy.mockResolvedValue({ status: 200, json: async () => ({ success: true, entries: [{ id: 'a1' }] }) });
      expect(await fetchTaskAuditLog('plan1')).toEqual([{ id: 'a1' }]);
    });
  });

  // Same "403 = free tier, no coordination needed, proceed" exception acquireWorklistLock's own
  // tests already establish (encounterCoordination.test.js) — SPEC-25 §4's single-writer lock is
  // a paid-tier convenience for cross-device federation, not something a lone free-tier device's
  // own correctness depends on.
  describe('acquireTaskLock', () => {
    it('treats a 403 (free tier) as success', async () => {
      fetchSpy.mockResolvedValue({ status: 403, json: async () => ({ success: false }) });
      expect(await acquireTaskLock('plan1')).toEqual({ success: true });
    });

    it('treats a real 409 conflict as a genuine failure, surfacing who holds it', async () => {
      fetchSpy.mockResolvedValue({ status: 409, json: async () => ({ success: false, lockedBy: 'Dr. Mehta' }) });
      expect(await acquireTaskLock('plan1')).toEqual({ success: false, lockedBy: 'Dr. Mehta' });
    });

    it('succeeds on a normal 200 acquisition', async () => {
      fetchSpy.mockResolvedValue({ status: 200, json: async () => ({ success: true }) });
      expect(await acquireTaskLock('plan1')).toEqual({ success: true });
    });

    it('still fails on a genuine network error', async () => {
      fetchSpy.mockRejectedValue(new Error('offline'));
      const result = await acquireTaskLock('plan1');
      expect(result.success).toBe(false);
    });
  });

  describe('getTaskLock', () => {
    it('returns null when the request fails', async () => {
      fetchSpy.mockRejectedValue(new Error('offline'));
      expect(await getTaskLock('plan1')).toBeNull();
    });

    it('returns the lock payload on success, active:false included for a released-but-known holder', async () => {
      fetchSpy.mockResolvedValue({ status: 200, json: async () => ({ success: true, lock: { accountId: 'acc1', name: 'Dr Doc', active: false } }) });
      expect(await getTaskLock('plan1')).toEqual({ accountId: 'acc1', name: 'Dr Doc', active: false });
    });
  });
});
