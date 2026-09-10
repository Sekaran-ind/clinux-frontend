import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { ensureDeferredCollectionsPreloaded } from './collectionPreload.js';

// main.js/router/index.js's own real fix: previously EVERY collection blocked app.mount() on
// EVERY route, Index.vue's bare unauthenticated landing page included. These 14 (Onboarding/
// Designer's forms+flows catalog, the 7 encounter-doc collections, ClinicHome's public-
// appointments feed, AI Engine's 3 sandbox collections) are deferred instead — kicked off once,
// fire-and-forget, right after mount, and awaited per-route by router/index.js's beforeEach guard
// for every route except Index. Pinned here: the promise this all hinges on actually resolves,
// and is genuinely memoized (one real preload run, not one per caller).
describe('ensureDeferredCollectionsPreloaded', () => {
  it('resolves once every deferred collection has preloaded', async () => {
    await expect(ensureDeferredCollectionsPreloaded()).resolves.toBeDefined();
  });

  it('is memoized — the same promise instance on a second call, not a fresh preload run', () => {
    const first = ensureDeferredCollectionsPreloaded();
    const second = ensureDeferredCollectionsPreloaded();
    expect(second).toBe(first);
  });
});
