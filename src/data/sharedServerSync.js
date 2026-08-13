// Mirrors a local TanStack DB collection to/from the Tauri desktop app's shared LAN server (see
// src-tauri/src/shared_server.rs). Deliberately NOT a replacement for the local-first TanStack DB
// collection — the local collection (backed by localStorage, same as always) stays the single
// source of truth for this device's own reactivity (useLiveQuery, .toArray, etc. are completely
// untouched by this file). This is an ADDITIVE mirror on top: local writes get pushed out, and a
// periodic poll pulls in whatever other devices/windows have written, merging it into the same
// local collection. That's a pragmatic "eventually consistent within a few seconds" model, not a
// real CRDT/live-sync protocol — good enough for a clinic's handful of LAN devices.
//
// Detection is a runtime PROBE (fetch /api/health), not just "was this page served by the shared
// server" — that first version had a real gap: the Tauri app's own window loads via Vite's
// separate devUrl (http://localhost:5173, for hot-reload) during `tauri dev`, a DIFFERENT origin
// that never gets the server-injected marker, even though the Rust server is running right there
// in the SAME app. A device/window that never probes-in stays fully local-only forever, silently
// diverging from whatever the shared database has — which is exactly the bug a live user hit:
// the Tauri window kept accumulating its own local-only data while a separate browser tab at
// :47856 (which DID get the injected marker) saw none of it. Probing fixes this for every
// context uniformly: the shared-server-served page (relative fetch, same origin) and the Tauri
// window/any other localhost tab (fixed port, since the Rust server always binds there on the
// same machine).
const FIXED_LOCALHOST_BASE = 'http://localhost:47856';
const PROBE_TIMEOUT_MS = 1500;
const POLL_INTERVAL_MS = 4000;
const SESSION_TOKEN_KEY = 'cf_session_token';
const VIRTUAL_PROP_KEYS = ['$synced', '$origin', '$key', '$collectionId'];

// Mutated once the probe resolves — read SHARED_MODE only after awaiting
// ensureSharedModeDetected() (collectionFactory.js does this per collection; the underlying
// probe itself only ever runs once, cached below).
export let SHARED_MODE = false;
let apiBase = '';
let detectPromise = null;

function currentToken() {
  try { return localStorage.getItem(SESSION_TOKEN_KEY); } catch (e) { return null; }
}

async function probe(base) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${base}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Resolves once, to whether shared mode is active — safe to call many times (every collection
// calls this independently); only the FIRST call actually probes, every later call reuses that
// same in-flight/settled promise.
export function ensureSharedModeDetected() {
  if (!detectPromise) {
    detectPromise = (async () => {
      // Prefer relative same-origin first — if this page was itself served by the shared server
      // (window.__CLINUX_SHARED_SERVER__, injected server-side, see shared_server.rs's
      // serve_injected_index()), a relative fetch avoids a cross-origin request entirely. Falls
      // back to the fixed local port otherwise, which is what makes the Tauri app's own window
      // (loaded via devUrl, a different origin) find the SAME machine's Rust server too.
      const preferRelative = typeof window !== 'undefined' && window.__CLINUX_SHARED_SERVER__ === true;
      if (preferRelative && (await probe(''))) {
        apiBase = '';
        SHARED_MODE = true;
        return true;
      }
      if (await probe(FIXED_LOCALHOST_BASE)) {
        apiBase = FIXED_LOCALHOST_BASE;
        SHARED_MODE = true;
        return true;
      }
      SHARED_MODE = false;
      return false;
    })();
  }
  return detectPromise;
}

// TanStack DB's localStorage collection stamps a few virtual bookkeeping props directly onto
// the stored row (confirmed by inspecting a real cf_user record in localStorage) — stripped
// before round-tripping through the shared server so they don't ride along as ordinary data on
// whichever OTHER device later pulls this row down.
function stripVirtualProps(value) {
  if (!value || typeof value !== 'object') return value;
  const clean = { ...value };
  VIRTUAL_PROP_KEYS.forEach((k) => delete clean[k]);
  return clean;
}

async function sharedFetch(path, options = {}) {
  const token = currentToken();
  if (!token) return null; // not logged in yet -- nothing to sync until there's a clinicId to scope to
  try {
    return await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    // Server unreachable (host machine asleep, this device briefly off the LAN, ...) -- shared
    // sync is best-effort; the local collection is unaffected either way.
    return null;
  }
}

// Wires push-on-write + poll-and-merge for one collection. Called from collectionFactory.js
// once ensureSharedModeDetected() has resolved true.
export function wireSharedSync(collection, collectionName, getKey) {
  // Keys currently being written INTO the local collection by pollOnce() below — pushOne() (the
  // subscribeChanges callback this triggers) checks this to avoid immediately re-pushing a
  // change that just came FROM the server, which would otherwise loop forever between two
  // devices re-syncing the same row back and forth.
  const applyingRemoteKeys = new Set();

  async function pushOne(type, key) {
    if (applyingRemoteKeys.has(String(key))) return;
    if (type === 'delete') {
      await sharedFetch(`/api/collections/${collectionName}/${encodeURIComponent(key)}`, { method: 'DELETE' });
      return;
    }
    // Re-reads the CURRENT row from the collection rather than trusting the change event's own
    // `value` — collection.get() is what's actually persisted after any collection-internal
    // normalization, and a rapid sequence of edits only needs the latest state pushed, not every
    // intermediate one.
    const current = collection.has(key) ? collection.get(key) : null;
    if (!current) return;
    await sharedFetch(`/api/collections/${collectionName}/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(stripVirtualProps(current)),
    });
  }

  collection.subscribeChanges((changes) => {
    changes.forEach((change) => pushOne(change.type, change.key));
  });

  async function pollOnce() {
    const res = await sharedFetch(`/api/collections/${collectionName}`);
    if (!res || !res.ok) return;
    let rows;
    try {
      rows = await res.json();
    } catch (e) {
      return;
    }

    const remoteKeys = new Set();
    rows.forEach((row) => {
      const key = getKey(row);
      remoteKeys.add(String(key));
      const existing = collection.has(key) ? collection.get(key) : null;
      // Cheap "did anything actually change" check -- skips a no-op update on every poll tick
      // for the (typical) case where nobody else has touched this row since last time.
      if (existing && JSON.stringify(stripVirtualProps(existing)) === JSON.stringify(row)) return;
      applyingRemoteKeys.add(String(key));
      try {
        if (collection.has(key)) collection.update(key, (draft) => Object.assign(draft, row));
        else collection.insert(row);
      } finally {
        applyingRemoteKeys.delete(String(key));
      }
    });

    // Anything local the server doesn't have yet -- this device's own pre-existing data from
    // before shared mode was ever reachable, or a push that failed while briefly offline -- gets
    // pushed up here. Runs every tick, not just on first connect, so it's self-healing rather
    // than a one-time special case. This is what backfills a window's pre-existing local-only
    // data (e.g. the Tauri window's own history from before this probe-based fix existed) up to
    // the shared database automatically, with no manual re-entry needed.
    collection.toArray.forEach((row) => {
      const key = getKey(row);
      if (!remoteKeys.has(String(key))) pushOne('insert', key);
    });
  }

  collection.preload().then(() => {
    pollOnce();
    setInterval(pollOnce, POLL_INTERVAL_MS);
  });
}
