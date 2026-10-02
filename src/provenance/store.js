// The device's provenance log: IndexedDB, every key scoped to the account (as journey records
// are). Each entry is { resource, published } — `published` turns true once clinuxflow-api has
// it (paid plan only). Kept forever on the device; nothing here is sent anywhere on its own.
import { createStore, get, set } from 'idb-keyval';
import { apiFetch, API_BASE } from '../config.js';

const store = createStore('clinux-workspace-provenance', 'kv');
const MAX_LOCAL = 5000; // oldest published entries are dropped past this; unpublished never are
const BATCH = 100;

export function provenanceLog(accountId, kv = { get: (k) => get(k, store), set: (k, v) => set(k, v, store) }) {
  if (!accountId) throw new Error('No signed-in account');
  const key = `${accountId}:provenance`;
  return {
    async list() {
      return (await kv.get(key)) || [];
    },
    async add(resource) {
      const list = (await kv.get(key)) || [];
      list.push({ resource, published: false });
      // Trim only entries already safe on the server.
      while (list.length > MAX_LOCAL && list.findIndex((e) => e.published) !== -1) list.splice(list.findIndex((e) => e.published), 1);
      await kv.set(key, list);
    },
    async markPublished(ids) {
      const list = (await kv.get(key)) || [];
      const set_ = new Set(ids);
      await kv.set(key, list.map((e) => (set_.has(e.resource.id) ? { ...e, published: true } : e)));
    },
    /** Paid plan only: sends unpublished entries in batches; never throws. Returns how many went. */
    async publishPending({ paid, post = postBatch } = {}) {
      if (!paid) return 0;
      const pending = ((await kv.get(key)) || []).filter((e) => !e.published).map((e) => e.resource);
      let sent = 0;
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        const ok = await post(batch).catch(() => false);
        if (!ok) break;
        await this.markPublished(batch.map((r) => r.id));
        sent += batch.length;
      }
      return sent;
    },
  };
}

async function postBatch(resources) {
  const res = await apiFetch(`${API_BASE}/api/provenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resources }),
  });
  return res.ok;
}
