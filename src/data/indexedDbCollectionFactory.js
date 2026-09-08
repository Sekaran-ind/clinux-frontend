import { createCollection, StorageKeyRequiredError, safeRandomUUID } from '@tanstack/db';
import { createStore, entries, set as idbSet, del as idbDel } from 'idb-keyval';
import { ensureSharedModeDetected, wireSharedSync } from './sharedServerSync.js';

// SPEC-19 (docs/SPEC-19-LOCAL-FIRST-LOCAL-SERVER-AND-FEDERATED-MODES.md) §4's IndexedDB
// migration, scoped to the AI Engine sandbox collections only (per explicit instruction — the
// other 40+ collections stay on collectionFactory.js's localStorage backend until this is proven
// out; see that spec's own build-order note and the clinux-local-first-federated-modes-spec19
// memory for the "other journeys" TODO this intentionally does not touch yet).
//
// Why AI Engine specifically needs this and nothing else did yet: it's a sandbox for generating
// and exploring bulk synthetic clinical records (AiEngine.vue) — the one place in this
// app that plausibly outgrows localStorage's ~5-10MB synchronous quota under normal use, and the
// first of the "2 untouched components" SPEC-19 §12 names as the next thing to redesign.
//
// Implements the EXACT SAME CollectionConfig protocol collectionFactory.js's
// localStorageCollectionOptions uses (read directly from @tanstack/db's own source before writing
// this, not guessed): a `sync(params)` function that calls params.begin()/write()/commit()/
// markReady() to hydrate the collection, plus onInsert/onUpdate/onDelete handlers that persist a
// mutation and then re-confirm it through that same sync channel. The protocol is
// backend-agnostic about sync/timing — the localStorage implementation just happens to load
// synchronously; IndexedDB's own async get/set slots into the identical shape.
//
// Storage engine: idb-keyval (createStore/entries/set/del), not raw IndexedDB or Dexie — each
// createStore(dbName, storeName) call is its own tiny single-object-store database, so adding a
// new collection later never needs IndexedDB's onupgradeneeded/version-bump dance the way a
// single shared multi-store database would. One idb-keyval store per storageKey, same identity
// convention collectionFactory.js already uses for localStorage keys.
//
// Cross-tab sync: localStorage gets this for free from the native 'storage' event; IndexedDB
// writes fire no equivalent event, so a BroadcastChannel per storageKey stands in for it — same
// "another tab changed this, go re-read and diff" trigger, appropriate substitute for the same job.
export function indexedDbCollectionOptions(config) {
  if (!config.storageKey) {
    throw new StorageKeyRequiredError();
  }

  // One dedicated database PER collection, not one shared database with a store per collection —
  // verified via a real failing test that idb-keyval's createStore(dbName, storeName) only
  // creates storeName on that database's first-ever open (indexedDB.open(dbName) with no version
  // arg never re-fires onupgradeneeded for an already-existing database), so a second collection
  // sharing the same dbName with a different storeName silently got "no objectStore named X."
  // Prefixing dbName with storageKey keeps each collection's database name unique and stable.
  const dbNamePrefix = config.dbName || 'clinux-idb-v1';
  const dbName = `${dbNamePrefix}:${config.storageKey}`;
  const store = createStore(dbName, 'data');
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`${dbName}:${config.storageKey}`) : null;

  // {versionKey, data} per key, mirroring localStorage's StoredItem shape — versionKey is what
  // lets a cross-tab change be diffed as insert/update/delete without a full deep-equal.
  const lastKnownData = new Map();
  let syncParams = null;

  async function loadAll() {
    const rows = await entries(store); // [[key, {versionKey, data}], ...]
    const map = new Map();
    rows.forEach(([key, storedItem]) => map.set(key, storedItem));
    return map;
  }

  function findChanges(oldData, newData) {
    const changes = [];
    oldData.forEach((oldItem, key) => {
      const newItem = newData.get(key);
      if (!newItem) changes.push({ type: 'delete', key, value: oldItem.data });
      else if (oldItem.versionKey !== newItem.versionKey) changes.push({ type: 'update', key, value: newItem.data });
    });
    newData.forEach((newItem, key) => {
      if (!oldData.has(key)) changes.push({ type: 'insert', key, value: newItem.data });
    });
    return changes;
  }

  async function processExternalChanges() {
    if (!syncParams) return;
    const { begin, write, commit } = syncParams;
    const newData = await loadAll();
    const changes = findChanges(lastKnownData, newData);
    if (changes.length === 0) return;
    begin();
    changes.forEach(({ type, value }) => write({ type, value }));
    commit();
    lastKnownData.clear();
    newData.forEach((item, key) => lastKnownData.set(key, item));
  }

  if (channel) {
    channel.onmessage = () => { processExternalChanges(); };
  }

  const sync = {
    sync: (params) => {
      syncParams = params;
      const { begin, write, commit, markReady } = params;
      loadAll().then((initialData) => {
        if (initialData.size > 0) {
          begin();
          initialData.forEach((item) => write({ type: 'insert', value: item.data }));
          commit();
        }
        lastKnownData.clear();
        initialData.forEach((item, key) => lastKnownData.set(key, item));
        markReady();
      });
    },
    getSyncMetadata: () => ({ storageKey: config.storageKey, storageType: 'indexeddb', dbName }),
  };

  // Confirms mutations through the sync channel (optimistic -> synced), same two-phase shape
  // localStorage's confirmOperationsSync uses — write() again here is what tells the Collection's
  // own optimistic-state tracking "this mutation is now durable," not a second data write.
  function confirmMutations(mutations) {
    if (!syncParams) return;
    const { begin, write, commit } = syncParams;
    begin();
    mutations.forEach((m) => write({ type: m.type, value: m.type === 'delete' ? m.original : m.modified }));
    commit();
  }

  async function persist(mutations, { deleting = false } = {}) {
    for (const mutation of mutations) {
      if (deleting) {
        lastKnownData.delete(mutation.key);
        await idbDel(mutation.key, store);
      } else {
        const storedItem = { versionKey: safeRandomUUID(), data: mutation.modified };
        lastKnownData.set(mutation.key, storedItem);
        await idbSet(mutation.key, storedItem, store);
      }
    }
    channel?.postMessage('changed'); // tell other tabs to re-read; this tab already applied it above
  }

  async function wrappedOnInsert(params) {
    const result = config.onInsert ? (await config.onInsert(params)) ?? {} : {};
    await persist(params.transaction.mutations);
    confirmMutations(params.transaction.mutations);
    return result;
  }
  async function wrappedOnUpdate(params) {
    const result = config.onUpdate ? (await config.onUpdate(params)) ?? {} : {};
    await persist(params.transaction.mutations);
    confirmMutations(params.transaction.mutations);
    return result;
  }
  async function wrappedOnDelete(params) {
    const result = config.onDelete ? (await config.onDelete(params)) ?? {} : {};
    await persist(params.transaction.mutations, { deleting: true });
    confirmMutations(params.transaction.mutations);
    return result;
  }

  const { storageKey: _storageKey, dbName: _dbName, onInsert: _oi, onUpdate: _ou, onDelete: _od, id, ...restConfig } = config;

  return {
    ...restConfig,
    id: id ?? `indexeddb-collection:${config.storageKey}`,
    sync,
    onInsert: wrappedOnInsert,
    onUpdate: wrappedOnUpdate,
    onDelete: wrappedOnDelete,
    utils: {
      async clearStorage() {
        const rows = await entries(store);
        await Promise.all(rows.map(([key]) => idbDel(key, store)));
        lastKnownData.clear();
      },
    },
  };
}

// Same shape as collectionFactory.js's createLocalCollection, including the identical
// shared-LAN-server additive-sync wiring (storage backend is orthogonal to that layer — it only
// ever calls Collection-interface methods, never touches idb-keyval/localStorage directly).
export function createIndexedDbCollection(storageKey, { getKey = (r) => r.id, ...rest } = {}) {
  const collection = createCollection(
    indexedDbCollectionOptions({ storageKey, getKey, ...rest })
  );

  ensureSharedModeDetected().then((active) => {
    if (active) wireSharedSync(collection, storageKey, getKey);
  });

  return collection;
}
