import { createCollection, localStorageCollectionOptions } from '@tanstack/vue-db';

// Thin wrapper around TanStack DB's localStorage collection so every collection in this app is
// created the same way. This is the "local-only for now, syncable later" collection primitive:
// swapping any one of these to a real backend-synced Query Collection later is a config change
// inside that collection's own file — callers (composables/components using useLiveQuery) don't
// change, since they only ever interact with the Collection interface, not the storage details.
export function createLocalCollection(storageKey, { getKey = (r) => r.id, ...rest } = {}) {
  return createCollection(
    localStorageCollectionOptions({
      storageKey,
      getKey,
      ...rest,
    })
  );
}
