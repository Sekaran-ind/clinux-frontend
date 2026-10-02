import { describe, expect, it, vi } from 'vitest';
import { buildProvenance, PROVENANCE_PROFILE } from './provenance.js';
import { provenanceLog } from './store.js';

const account = { id: 'acc-1', clinicId: 'clinic-1', clinicName: 'Asha Clinic', email: 'asha@example.in', adminName: 'Dr Asha' };

describe('buildProvenance', () => {
  it('names the verified professional (HPR ID) as author, on behalf of the facility (HFR id)', () => {
    const p = buildProvenance({ targets: ['QuestionnaireResponse/rec-1'], activity: 'create', account, hprId: '71-0001-0002-0003', hfrFacilityId: 'IN2910000001', reason: 'Captured', now: new Date('2026-10-02T10:00:00Z'), id: 'p1' });
    expect(p).toEqual({
      resourceType: 'Provenance', id: 'p1', meta: { profile: [PROVENANCE_PROFILE] },
      target: [{ reference: 'QuestionnaireResponse/rec-1' }],
      recorded: '2026-10-02T10:00:00.000Z',
      activity: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation', code: 'CREATE', display: 'Create' }] },
      agent: [{
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'author', display: 'Author' }] },
        who: { identifier: { system: 'https://doctor.ndhm.gov.in', value: '71-0001-0002-0003' }, display: 'Dr Asha' },
        onBehalfOf: { identifier: { system: 'https://facility.ndhm.gov.in', value: 'IN2910000001' }, display: 'Asha Clinic' },
      }],
      reason: [{ text: 'Captured' }],
    });
  });

  it('falls back to the ClinuxFlow account and clinic before ABDM ids exist, and accepts identifier targets', () => {
    const p = buildProvenance({ targets: [{ system: 'https://doctor.ndhm.gov.in', value: 'x@hpr.abdm' }], activity: 'update', account });
    expect(p.agent[0].who.identifier).toEqual({ system: 'https://clinux.yaxb.ai/fhir/sid/account', value: 'acc-1' });
    expect(p.agent[0].onBehalfOf.identifier).toEqual({ system: 'https://clinux.yaxb.ai/fhir/sid/clinic', value: 'clinic-1' });
    expect(p.target).toEqual([{ identifier: { system: 'https://doctor.ndhm.gov.in', value: 'x@hpr.abdm' } }]);
    expect(p.activity.coding[0].code).toBe('UPDATE');
  });

  it('refuses a provenance with no target', () => {
    expect(() => buildProvenance({ targets: [], activity: 'create', account })).toThrow(/target/);
  });
});

describe('provenance log (device) and paid-only publishing', () => {
  const memory = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => m.set(k, v) }; };
  const p = (id) => buildProvenance({ targets: [`QuestionnaireResponse/${id}`], activity: 'create', account, id });

  it('keeps everything on the device and sends nothing on the free plan', async () => {
    const log = provenanceLog('acc-1', memory());
    await log.add(p('a'));
    const post = vi.fn(async () => true);
    expect(await log.publishPending({ paid: false, post })).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect((await log.list()).map((e) => e.published)).toEqual([false]);
  });

  it('publishes pending entries once on the paid plan, and keeps them pending if the server is unreachable', async () => {
    const log = provenanceLog('acc-1', memory());
    await log.add(p('a')); await log.add(p('b'));
    expect(await log.publishPending({ paid: true, post: async () => false })).toBe(0);
    expect((await log.list()).every((e) => !e.published)).toBe(true);
    const post = vi.fn(async () => true);
    expect(await log.publishPending({ paid: true, post })).toBe(2);
    expect(await log.publishPending({ paid: true, post })).toBe(0); // nothing re-sent
    expect(post).toHaveBeenCalledTimes(1);
  });
});
