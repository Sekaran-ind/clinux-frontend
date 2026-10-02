// Per-person ABDM tokens (the HPR token HFR facility creation needs as x-hprid-auth), held in
// memory only. They are never written to IndexedDB: a reload or sign-out forgets them, and the
// person signs in to HPR again. Keyed by ClinuxFlow account so a shared browser can't mix them.
const tokens = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export const vault = {
    setHpr(accountId, { token, hprId, expiresIn }, now = Date.now()) {
        // ABDM reports expiresIn in seconds; fall back to 10 minutes when it doesn't say.
        const ttl = Number(expiresIn) > 0 ? Math.min(Number(expiresIn) * 1000, 60 * 60 * 1000) : DEFAULT_TTL_MS;
        tokens.set(`${accountId}:hpr`, { token, hprId, expiresAt: now + ttl });
    },
    hpr(accountId, now = Date.now()) {
        const t = tokens.get(`${accountId}:hpr`);
        if (!t || t.expiresAt <= now) return null;
        return t;
    },
    clear() {
        tokens.clear();
    },
};
