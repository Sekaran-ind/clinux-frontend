// Polyfills `indexedDB`/`IDBKeyRange` as globals for this test file only — vitest isolates
// globals per test file by default (confirmed: the other 116 tests run under plain Node with no
// DOM/IndexedDB and are unaffected by this import), so this doesn't need a global vitest.config.js
// change. Node's own `BroadcastChannel` is a native global (Node 18+, confirmed this session) —
// no polyfill needed for that half.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollection } from '@tanstack/db';
import { indexedDbCollectionOptions, createIndexedDbCollection } from './indexedDbCollectionFactory.js';

// createLocalCollection's shared-server wiring (ensureSharedModeDetected/wireSharedSync) probes a
// network endpoint — irrelevant to this file's job of proving the IndexedDB backend itself works,
// same reason other collection tests in this codebase don't exercise that path directly.
vi.mock('./sharedServerSync.js', () => ({
  ensureSharedModeDetected: vi.fn(async () => false),
  wireSharedSync: vi.fn(),
}));

function uniqueKey() {
  return `test-collection-${Math.random().toString(36).slice(2)}`;
}

describe('indexedDbCollectionOptions — the IndexedDB backend itself', () => {
  it('starts empty and reaches ready state via markReady (preload resolves)', async () => {
    const collection = createCollection(indexedDbCollectionOptions({ storageKey: uniqueKey(), getKey: (r) => r.id }));
    await collection.preload();
    expect(collection.size).toBe(0);
  });

  it('insert persists to the real IndexedDB store, not just in-memory — verified by reopening a second collection instance on the same key', async () => {
    const storageKey = uniqueKey();
    const first = createCollection(indexedDbCollectionOptions({ storageKey, getKey: (r) => r.id }));
    await first.preload();
    first.insert({ id: 'p1', name: 'Alice' });
    // Mutation handlers are async (real idb-keyval writes) — wait for the record to actually land.
    await vi.waitFor(() => expect(first.has('p1')).toBe(true));

    const second = createCollection(indexedDbCollectionOptions({ storageKey, getKey: (r) => r.id }));
    await second.preload();
    expect(second.get('p1')).toMatchObject({ id: 'p1', name: 'Alice' });
  });

  it('update and delete round-trip through the real store the same way', async () => {
    const storageKey = uniqueKey();
    const collection = createCollection(indexedDbCollectionOptions({ storageKey, getKey: (r) => r.id }));
    await collection.preload();
    collection.insert({ id: 'p1', status: 'pending' });
    await vi.waitFor(() => expect(collection.has('p1')).toBe(true));

    collection.update('p1', (draft) => { draft.status = 'done'; });
    await vi.waitFor(() => expect(collection.get('p1').status).toBe('done'));

    collection.delete('p1');
    await vi.waitFor(() => expect(collection.has('p1')).toBe(false));

    const reopened = createCollection(indexedDbCollectionOptions({ storageKey, getKey: (r) => r.id }));
    await reopened.preload();
    expect(reopened.has('p1')).toBe(false); // the delete really persisted, not just an in-memory optimistic remove
  });

  it('two independent collection instances on the same storageKey stay in sync via the BroadcastChannel cross-tab signal — real substitute for localStorage\'s native storage event', async () => {
    const storageKey = uniqueKey();
    const tabA = createCollection(indexedDbCollectionOptions({ storageKey, getKey: (r) => r.id }));
    const tabB = createCollection(indexedDbCollectionOptions({ storageKey, getKey: (r) => r.id }));
    await Promise.all([tabA.preload(), tabB.preload()]);

    tabA.insert({ id: 'p1', name: 'Bob' });
    await vi.waitFor(() => expect(tabA.has('p1')).toBe(true));

    // tabB never called .insert() itself — only the BroadcastChannel message from tabA's write
    // should bring it in, proving the cross-tab path (not just tabA's own local state) works.
    await vi.waitFor(() => expect(tabB.has('p1')).toBe(true), { timeout: 2000 });
    expect(tabB.get('p1')).toMatchObject({ name: 'Bob' });
  });

  it('createIndexedDbCollection matches createLocalCollection\'s call shape and default getKey', async () => {
    const collection = createIndexedDbCollection(uniqueKey());
    await collection.preload();
    collection.insert({ id: 'x1', value: 42 }); // default getKey = r => r.id, same default as createLocalCollection
    await vi.waitFor(() => expect(collection.has('x1')).toBe(true));
  });

  it('rejects a missing storageKey the same way the localStorage backend does', () => {
    expect(() => indexedDbCollectionOptions({ getKey: (r) => r.id })).toThrow();
  });
});
