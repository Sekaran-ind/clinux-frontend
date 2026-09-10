import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { isReactive, toRaw } from 'vue';
import { mergeAccountWithLocalProfile, useAuthStore } from './auth.js';

// Same fakeLocalStorage()/vi.stubGlobal pattern joinTokenAdapter.test.js already uses to exercise
// a real store method against a stubbed network+storage layer, rather than mocking the method
// itself away (which is what every OTHER register()/login() test in this codebase does — see
// entryWorkflow.test.js's own `vi.spyOn(auth, 'register').mockResolvedValue(...)` throughout —
// and exactly why this bug shipped past a clean 264/264 suite: nothing exercised the real body).
function fakeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
vi.stubGlobal('localStorage', fakeLocalStorage());

describe('mergeAccountWithLocalProfile', () => {
  it('preserves local-only fields (services/phone/city/careTeam/address) from the existing row', () => {
    const account = { id: '1', email: 'a@b.com', clinicName: 'City Clinic', tier: 'free' };
    const existingLocalRow = { id: '1', services: 'General', phone: '555-1234', city: 'Springfield', careTeam: 'x', address: '1 Main St' };
    const merged = mergeAccountWithLocalProfile(account, existingLocalRow);
    expect(merged).toMatchObject({
      id: '1', email: 'a@b.com', clinicName: 'City Clinic', tier: 'free',
      services: 'General', phone: '555-1234', city: 'Springfield', careTeam: 'x', address: '1 Main St',
    });
  });

  it('server identity fields always win over a stale local copy of the same field', () => {
    const account = { id: '1', clinicName: 'New Name', tier: 'paid' };
    const existingLocalRow = { id: '1', clinicName: 'Stale Old Name', tier: 'free', phone: '555-1234' };
    const merged = mergeAccountWithLocalProfile(account, existingLocalRow);
    expect(merged.clinicName).toBe('New Name');
    expect(merged.tier).toBe('paid');
    expect(merged.phone).toBe('555-1234');
  });

  it('defaults local-only fields to "" on a brand-new registration (no existing local row)', () => {
    const account = { id: '1', email: 'a@b.com', tier: 'free' };
    const merged = mergeAccountWithLocalProfile(account, null);
    expect(merged).toMatchObject({
      id: '1', email: 'a@b.com', tier: 'free',
      services: '', phone: '', city: '', careTeam: '', address: '',
    });
  });
});

// Real, live-found bug: register()/login() used to `return { user: currentUser.value }` —
// currentUser is a ref(), and Vue deep-wraps an object assigned to .value in a reactive Proxy, so
// that was never the plain merged account. The Proxy flows straight into entryWorkflow.js's XState
// context (planDefinitionRunner.js's result_register/result_login, via event.output), and every
// actor snapshot containing it gets persisted — which is exactly what taskActorSnapshots.js's real
// IndexedDB backend does on every transition (workflowRuntime.js's actor.subscribe). IndexedDB's
// structured-clone algorithm cannot clone a Proxy at all, so the very next registration/login after
// the first one landed a real `DataCloneError: ... could not be cloned` in the browser console
// (structuredClone() below is the same clone primitive IndexedDB's put() uses under the hood, so a
// throw here is the same failure, just without needing fake-indexeddb/a running actor to prove it).
// toRaw() is the fix — these pin the actual return value's shape, not just that a request happened.
describe('register()/login() return a plain, non-reactive user object', () => {
  let fetchSpy;
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchSpy = vi.spyOn(global, 'fetch');
  });
  afterEach(() => vi.restoreAllMocks());

  it('register() resolves with a user object that is not a Vue reactive Proxy', async () => {
    fetchSpy.mockResolvedValue({
      json: async () => ({ success: true, account: { id: 'acc1', email: 'a@b.com', role: 'health_professional', tier: 'free' }, token: 'tok1' }),
    });
    const auth = useAuthStore();
    const result = await auth.register({ email: 'a@b.com', password: 'password123', role: 'health_professional' });

    expect(isReactive(result.user)).toBe(false);
    expect(toRaw(result.user)).toBe(result.user); // toRaw() on an already-plain object is a no-op — proves nothing reactive is left to unwrap
    expect(() => structuredClone(result.user)).not.toThrow(); // the exact clone primitive IndexedDB's put() failed on
    expect(result.user).toMatchObject({ id: 'acc1', email: 'a@b.com', role: 'health_professional' });
  });

  it('login() resolves with a user object that is not a Vue reactive Proxy', async () => {
    fetchSpy.mockResolvedValue({
      json: async () => ({ success: true, account: { id: 'acc1', email: 'a@b.com', role: 'hospital_admin', tier: 'free' }, token: 'tok1' }),
    });
    const auth = useAuthStore();
    const result = await auth.login('a@b.com', 'password123');

    expect(isReactive(result.user)).toBe(false);
    expect(() => structuredClone(result.user)).not.toThrow();
  });
});
