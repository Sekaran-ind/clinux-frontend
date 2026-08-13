import { createCollection, localStorageCollectionOptions } from '@tanstack/vue-db';
import { ensureSharedModeDetected, wireSharedSync } from './sharedServerSync.js';

// Thin wrapper around TanStack DB's localStorage collection so every collection in this app is
// created the same way. This is the "local-only for now, syncable later" collection primitive:
// swapping any one of these to a real backend-synced Query Collection later is a config change
// inside that collection's own file — callers (composables/components using useLiveQuery) don't
// change, since they only ever interact with the Collection interface, not the storage details.
//
// "Syncable later" arrived as an ADDITIVE layer, not a swap: every collection keeps its normal
// localStorage-backed behavior always, and ALSO gets mirrored to/from the Tauri desktop app's
// shared LAN server (see sharedServerSync.js) once that server is confirmed reachable — checked
// via a runtime probe, not an assumption about which URL loaded this page, so this works
// uniformly whether the page was served BY that server (another LAN device's browser) or is the
// Tauri app's own window (which loads via Vite's separate devUrl during `tauri dev`, a different
// origin the server can't inject into directly). Storage key doubles as the shared server's
// collection name — already unique and stable per collection, no separate name needed.
export function createLocalCollection(storageKey, { getKey = (r) => r.id, ...rest } = {}) {
  const collection = createCollection(
    localStorageCollectionOptions({
      storageKey,
      getKey,
      ...rest,
    })
  );

  ensureSharedModeDetected().then((active) => {
    if (active) wireSharedSync(collection, storageKey, getKey);
  });

  return collection;
}
