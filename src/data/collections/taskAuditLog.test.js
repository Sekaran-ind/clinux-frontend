// SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6 — real IndexedDB backend, so this
// needs the same 'fake-indexeddb/auto' polyfill indexedDbCollectionFactory.test.js's own header
// documents (vitest isolates globals per test file). Must be the first import.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { taskAuditLog, taskId, appendAuditEntry, listAuditEntries } from './taskAuditLog.js';

vi.mock('../sharedServerSync.js', () => ({
  ensureSharedModeDetected: vi.fn(async () => false),
  wireSharedSync: vi.fn(),
}));

describe('taskAuditLog.js', () => {
  it('taskId() is the stable `${planId}:${actionId}` composite', () => {
    expect(taskId('plan1', 'register')).toBe('plan1:register');
  });

  it('appendAuditEntry writes an append-only row with a generated id and derived taskId', () => {
    const entry = { type: 'transition', planId: `p-${Date.now()}`, actionId: 'register', from: 'ready', to: 'done', at: '2026-09-09T00:00:00.000Z' };
    const record = appendAuditEntry(entry);
    expect(record.id).toBeTruthy();
    expect(record.taskId).toBe(taskId(entry.planId, entry.actionId));
    expect(taskAuditLog.get(record.id)).toMatchObject(record); // .get() adds TanStack DB's own $collectionId/$key/etc.
  });

  it('listAuditEntries returns only entries for the given planId, oldest first', () => {
    const planId = `p-${Date.now()}-${Math.random()}`;
    const other = `other-${Date.now()}`;
    appendAuditEntry({ type: 'transition', planId, actionId: 'b', from: 'ready', to: 'done', at: '2026-09-09T00:00:02.000Z' });
    appendAuditEntry({ type: 'transition', planId, actionId: 'a', from: 'ready', to: 'done', at: '2026-09-09T00:00:01.000Z' });
    appendAuditEntry({ type: 'transition', planId: other, actionId: 'c', from: 'ready', to: 'done', at: '2026-09-09T00:00:00.500Z' });

    const entries = listAuditEntries(planId);
    expect(entries.map((e) => e.actionId)).toEqual(['a', 'b']); // sorted by `at`, not insertion order
    expect(entries.every((e) => e.planId === planId)).toBe(true);
  });
});
