// Ported from clinux-cubo's test/consent.test.js: same Consent resource and store behaviour, with
// the store's storage injected (a Map) instead of IndexedDB.
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConsent, isCurrent, withdrawConsent } from '../consent/consentResource.js';
import { CONSENTS, TERMS_VERSION } from '../consent/terms.js';
import { useConsentStore, consentRedirect } from './consent.js';

const account = { id: 'acc-1', clinicId: 'clinic-1', clinicName: 'Asha Clinic', email: 'asha@clinic.in', adminName: 'Asha' };
const valid = { issue: [{ severity: 'information', diagnostics: 'Valid' }] };

function memoryStore() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => m.set(k, v), m };
}

function mockFetch(handler) {
  globalThis.fetch = vi.fn(async (url, init) => {
    const r = await handler(url, init);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
});

describe('Consent resource (copied from Cübo)', () => {
  it('one active Consent per term, performer is the provider, purpose TREAT', () => {
    const c = buildConsent(CONSENTS[0], account, { now: new Date('2026-09-30T00:00:00Z'), id: 'x' });
    expect(c).toMatchObject({
      resourceType: 'Consent',
      status: 'active',
      identifier: [{ value: `terminology|${TERMS_VERSION}` }],
      performer: [{ identifier: { value: account.id } }],
      provision: { type: 'permit', period: { start: '2026-09-30T00:00:00.000Z' }, purpose: [{ code: 'TREAT' }] },
    });
    expect(isCurrent(c, 'terminology')).toBe(true);
    expect(isCurrent(c, 'personal-data')).toBe(false);
  });

  it('withdrawal makes it inactive and closes the period', () => {
    const w = withdrawConsent(buildConsent(CONSENTS[1], account), { now: new Date('2026-10-01T00:00:00Z') });
    expect(w.status).toBe('inactive');
    expect(w.provision.period.end).toBe('2026-10-01T00:00:00.000Z');
    expect(isCurrent(w, 'personal-data')).toBe(false);
  });
});

describe('consent store', () => {
  it('grants both after $validate and stores them for this account', async () => {
    mockFetch(() => ({ body: valid }));
    const storage = memoryStore();
    const store = useConsentStore();
    await store.load(account.id, storage);
    expect(store.allGranted).toBe(false);
    expect((await store.grantAll(account)).ok).toBe(true);
    expect(store.allGranted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toMatch(/\/\$validate$/);
    expect(Object.keys(storage.m.get('consents'))).toEqual(['terminology', 'personal-data']);
  });

  it('stores nothing when validation reports errors', async () => {
    mockFetch(() => ({ body: { issue: [{ severity: 'error', diagnostics: 'Consent.scope: required' }] } }));
    const storage = memoryStore();
    const store = useConsentStore();
    await store.load(account.id, storage);
    const r = await store.grantAll(account);
    expect(r).toMatchObject({ ok: false, errors: expect.arrayContaining(['Consent.scope: required']) });
    expect(store.allGranted).toBe(false);
    expect(storage.m.get('consents')).toEqual({});
  });

  it('offline: saved as pending, then re-validated on next load', async () => {
    mockFetch(() => new TypeError('fetch failed'));
    const storage = memoryStore();
    const store = useConsentStore();
    await store.load(account.id, storage);
    expect(await store.grantAll(account)).toMatchObject({ ok: true, pending: true });
    expect(store.records.terminology.validation.status).toBe('pending');

    mockFetch(() => ({ body: valid }));
    setActivePinia(createPinia());
    const again = useConsentStore();
    await again.load(account.id, storage);
    expect(again.allGranted).toBe(true);
    expect(again.records.terminology.validation.status).toBe('valid');
  });

  it('withdrawing one consent closes the workspace', async () => {
    mockFetch(() => ({ body: valid }));
    const store = useConsentStore();
    await store.load(account.id, memoryStore());
    await store.grantAll(account);
    await store.withdraw('personal-data');
    expect(store.granted).toEqual({ terminology: true, 'personal-data': false });
    expect(store.allGranted).toBe(false);
  });
});

describe('consentRedirect (router guard)', () => {
  it('sends a signed-in account without consent to /consent, except from the exempt pages', () => {
    expect(consentRedirect('dashboard', { signedIn: true, allGranted: false })).toBe('consent');
    for (const exempt of ['index', 'legal', 'consent']) expect(consentRedirect(exempt, { signedIn: true, allGranted: false })).toBeNull();
    expect(consentRedirect('dashboard', { signedIn: true, allGranted: true })).toBeNull();
    expect(consentRedirect('dashboard', { signedIn: false, allGranted: false })).toBeNull();
  });
});
