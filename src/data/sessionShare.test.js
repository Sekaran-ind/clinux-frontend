import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildEncounterSharePayload, decodeEncounterShareKey, isSameClinic, alreadyConsented,
  importEncounterSharePayload, consentAndImport,
  buildProviderProfileSharePayload, decodeProviderProfileShareKey,
} from './sessionShare.js';
import { encodeSessionTransfer } from './sessionTransfer.js';
import { formData } from './collections/formData.js';
import { encounterConsent } from './collections/encounterDocs.js';

// This test environment (plain vitest, no jsdom) has no global `localStorage` at all — every
// currentClinicId()/currentUser() read in formData.js/sessionShare.js/encounterDocs.js already
// tolerates that (try/catch around the access, falling back to null), so we only need to stub it
// in when a test actually wants to control "who's logged in on this device".
function fakeLocalStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
function loginAs(clinicId, extra = {}) {
  vi.stubGlobal('localStorage', fakeLocalStorage({ cf_user: JSON.stringify({ clinicId, ...extra }) }));
}

afterEach(() => vi.unstubAllGlobals());

describe('buildEncounterSharePayload / decodeEncounterShareKey', () => {
  it('carries the source clinicId/name and round-trips through decode', async () => {
    loginAs('clinic-a', { clinicName: 'Clinic A' });
    const record = {
      id: 'rec-share-1', formId: 'system-encounter-composition-v1', version: 3, clinicId: 'clinic-a',
      data: { item: [{ linkId: 'encounter_chief_complaint', answer: [{ valueString: 'Headache' }] }] },
    };
    const { key, payload } = await buildEncounterSharePayload(record);
    expect(payload).toMatchObject({
      kind: 'encounter-session', encounterId: 'rec-share-1', sourceClinicId: 'clinic-a', sourceClinicName: 'Clinic A',
    });

    const decoded = await decodeEncounterShareKey(key);
    expect(decoded.ok).toBe(true);
    expect(decoded.data).toEqual(payload);
  });

  it('rejects a validly-encrypted key that is not an encounter-session payload', async () => {
    const key = await encodeSessionTransfer({ kind: 'something-else' });
    const result = await decodeEncounterShareKey(key);
    expect(result.ok).toBe(false);
  });
});

describe('isSameClinic', () => {
  it('true only when payload.sourceClinicId matches this device\'s own logged-in clinic', () => {
    loginAs('clinic-a');
    expect(isSameClinic({ sourceClinicId: 'clinic-a' })).toBe(true);
    expect(isSameClinic({ sourceClinicId: 'clinic-b' })).toBe(false);
    expect(isSameClinic({ sourceClinicId: null })).toBe(false);
  });
});

describe('cross-clinic import flow', () => {
  afterEach(() => {
    if (formData.has('rec-imported-1')) formData.delete('rec-imported-1');
    if (formData.has('rec-imported-2')) formData.delete('rec-imported-2');
    if (encounterConsent.has('rec-imported-2:clinic-a')) encounterConsent.delete('rec-imported-2:clinic-a');
  });

  it('importEncounterSharePayload upserts under THIS device\'s own clinicId, keyed by the source encounterId', () => {
    loginAs('clinic-b');
    const payload = {
      kind: 'encounter-session', encounterId: 'rec-imported-1', formId: 'system-encounter-composition-v1',
      version: 2, sourceClinicId: 'clinic-a', data: { item: [] },
    };
    const { encounterId } = importEncounterSharePayload(payload);
    expect(encounterId).toBe('rec-imported-1');
    const stored = formData.get('rec-imported-1');
    expect(stored.clinicId).toBe('clinic-b'); // the IMPORTING clinic's own id, not the source's
  });

  it('consentAndImport records a consent grant, then imports; alreadyConsented reflects it afterwards', () => {
    loginAs('clinic-b', { adminName: 'Nurse Joy' });
    const payload = {
      kind: 'encounter-session', encounterId: 'rec-imported-2', formId: 'system-encounter-composition-v1',
      version: 1, sourceClinicId: 'clinic-a', data: { item: [] },
    };
    expect(alreadyConsented(payload)).toBe(false);
    consentAndImport(payload);
    expect(alreadyConsented(payload)).toBe(true);
    expect(formData.has('rec-imported-2')).toBe(true);
  });
});

describe('buildProviderProfileSharePayload / decodeProviderProfileShareKey', () => {
  it('carries the source clinicId/name + branding, and round-trips through decode', async () => {
    loginAs('clinic-a', { clinicName: 'Clinic A' });
    const record = {
      id: 'provider-rec-1', formId: 'system-provider-composition-v1', version: 2, clinicId: 'clinic-a',
      data: { item: [{ linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'Clinic A' }] }] }] },
    };
    const branding = { tagline: 'Trusted care', brandColor: '#00D4B2', logoUrl: '', slug: 'clinic-a' };
    const { key, payload } = await buildProviderProfileSharePayload(record, branding);
    expect(payload).toMatchObject({
      kind: 'provider-profile', recordId: 'provider-rec-1', sourceClinicId: 'clinic-a', sourceClinicName: 'Clinic A', branding,
    });

    const decoded = await decodeProviderProfileShareKey(key);
    expect(decoded.ok).toBe(true);
    expect(decoded.data).toEqual(payload);
  });

  it('rejects a validly-encrypted key that is not a provider-profile payload (e.g. an encounter one)', async () => {
    const { key } = await buildEncounterSharePayload({ id: 'x', formId: 'f', version: 1, clinicId: 'c', data: { item: [] } });
    const result = await decodeProviderProfileShareKey(key);
    expect(result.ok).toBe(false);
  });

  // isSameClinic() is already fully covered above (it's reused as-is, not duplicated) -- the
  // thing specific to the provider-profile path is that there's NO consentAndImport/alreadyConsented
  // equivalent for it at all, by design (see sessionShare.js's own comment on why). That absence
  // is enforced in the UI (SessionImportModal.vue rejects outright on a clinic mismatch), not
  // testable as a missing export here.
});
