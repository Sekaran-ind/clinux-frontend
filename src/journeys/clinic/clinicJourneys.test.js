import { describe, expect, it } from 'vitest';
import { checkJourney, createXStateRunner as createRunner } from '../engine.js';
import { frontDeskJourney } from './frontDeskJourney.js';
import { consultationJourney } from './consultationJourney.js';
import { checkoutJourney } from './checkoutJourney.js';
import { answer, isClosed } from './encounterRecord.js';

const ENC = 'system-encounter-composition-v1';
const PAT = 'system-patient-profile-v1';
const Q = {
  item: [
    { linkId: 'section_encounter', text: 'Encounter', item: [{ linkId: 'encounter_patient_ref', text: 'Patient' }, { linkId: 'encounter_chief_complaint', text: 'Chief complaint' }, { linkId: 'encounter_status', text: 'Status' }] },
    { linkId: 'section_vitals', text: 'Vitals', repeats: true, item: [{ linkId: 'vitals_pulse', text: 'Pulse' }] },
    { linkId: 'section_soap', text: 'SOAP', item: [{ linkId: 'soap_assessment', text: 'Assessment' }, { linkId: 'soap_plan', text: 'Plan' }] },
    { linkId: 'section_prescription', text: 'Prescription', repeats: true, item: [{ linkId: 'rx_medication', text: 'Medication' }] },
    { linkId: 'section_billing', text: 'Billing', repeats: true, item: [{ linkId: 'billing_total', text: 'Total' }] },
  ],
};
const section = (linkId, fields) => ({ item: [{ linkId, item: Object.entries(fields).map(([k, v]) => ({ linkId: k, answer: [{ valueString: v }] })) }] });

/** A fake clinic: records in a Map, every coordination call recorded. */
function fakeClinic({ records = new Map(), lock = { success: true }, assigned = null, paid = false } = {}) {
  const calls = [];
  const clinic = {
    ENCOUNTER_FORM_ID: ENC,
    PATIENT_FORM_ID: PAT,
    questionnaire: (id) => (id === ENC ? Q : { item: [] }),
    encounter: (id) => records.get(id) || null,
    record: (f, id) => records.get(id) || null,
    patients: () => [{ value: 'p1', label: 'Asha Rao' }],
    patientSummary: (id) => (id === 'p1' ? 'Asha Rao' : id === 'p-new' ? 'New Person' : ''),
    save: (formId, qr) => { calls.push(['save', formId]); return formId === PAT ? 'p-new' : `r-${calls.length}`; },
    saveEncounter: (id, data) => { records.set(id, { id, data }); calls.push(['saveEncounter', id]); return id; },
    stagesOf: () => ({}),
    markStageComplete: (id, stage) => calls.push(['stage', id, stage]),
    closeEncounter: (id) => {
      const r = records.get(id);
      const data = structuredClone(r.data);
      data.item.find((i) => i.linkId === 'section_encounter').item.push({ linkId: 'encounter_status', answer: [{ valueCoding: { display: 'finished' } }] });
      records.set(id, { id, data });
      calls.push(['close', id]);
    },
    log: () => {},
    acquireLock: async (id, stage) => { calls.push(['lock', id, stage]); return lock; },
    releaseLock: async (id, stage) => calls.push(['unlock', id, stage]),
    assignment: async () => assigned,
    assign: async (id, who) => { calls.push(['assign', id, who]); return { success: true }; },
    specialists: async () => [{ value: 'dr-2', label: 'Dr Mehta (staff)' }],
    me: () => ({ id: 'me' }),
    forms: () => [{ value: 'form-consent', label: 'Consent' }],
    attachForm: (id, formId, recordId) => calls.push(['attach', id, formId, recordId]),
    attachedForms: () => [],
    prescriptionsOf: () => [],
    makePrescription: async (id) => { calls.push(['rx', id]); return 'rx-1'; },
    downloadHealthRecord: async (id) => { calls.push(['pdf', id]); return { qrIncluded: true }; },
    paid: () => paid,
    transcript: () => 'Fever for three days. Paracetamol.',
    soapDraft: async () => ({ soap_assessment: 'Viral fever', soap_plan: 'Paracetamol 500 mg' }),
  };
  return { clinic, calls, records };
}
const deps = (clinic) => ({ clinic, threadId: 'journey-consultation--e1' });

describe('clinic journeys', () => {
  it('are valid journeys', () => {
    for (const j of [frontDeskJourney, consultationJourney, checkoutJourney]) expect(checkJourney(j)).toEqual([]);
  });

  it('Front Desk: a new visit — patient, encounter, vitals, routing, an extra form, hand-off', async () => {
    const { clinic, calls, records } = fakeClinic();
    const run = createRunner(frontDeskJourney, deps(clinic));
    expect((await run.start({ encounterId: 'e1' })).prompt.step).toBe('patient');
    const enc = (await run.answer({ patientId: 'p1' })).prompt;
    expect(enc.step).toBe('encounter');
    expect(enc.form).toMatchObject({ formId: ENC, group: 'section_encounter' });
    expect(answer(enc.form.record, 'encounter_patient_ref')).toBe('Asha Rao'); // seeded with the patient
    expect((await run.answer({ qr: section('section_encounter', { encounter_patient_ref: 'Asha Rao', encounter_chief_complaint: 'Fever' }) })).prompt.step).toBe('vitals');
    expect(answer(records.get('e1'), 'encounter_chief_complaint')).toBe('Fever');
    const routing = (await run.answer({ qr: section('section_vitals', { vitals_pulse: '88' }) })).prompt;
    expect(routing.step).toBe('routing');
    expect(routing.fields[0].options.map((o) => o.value)).toEqual(['', 'dr-2']);
    expect((await run.answer({ specialistId: 'dr-2' })).prompt.step).toBe('additional');
    expect((await run.answer({ formId: 'form-consent' })).prompt.form).toMatchObject({ formId: 'form-consent' });
    expect((await run.answer({ qr: { item: [] } })).prompt.step).toBe('additional');
    expect((await run.answer({ formId: '' })).prompt.step).toBe('handoff');
    const end = await run.answer({ choice: 'consult' });
    expect(end.result).toMatchObject({ ok: true, title: 'Sent to Consultation', next: { to: '/clinic/consultation?encounter=e1' } });
    expect(calls).toEqual(expect.arrayContaining([['assign', 'e1', 'dr-2'], ['attach', 'e1', 'form-consent', expect.any(String)], ['stage', 'e1', 'onboarding'], ['unlock', 'e1', 'onboarding']]));
    expect(answer(records.get('e1'), 'vitals_pulse')).toBe('88');
    expect(answer(records.get('e1'), 'encounter_chief_complaint')).toBe('Fever'); // a later section doesn't erase an earlier one
  });

  it('Front Desk: registering a new patient first', async () => {
    const { clinic, calls } = fakeClinic();
    const run = createRunner(frontDeskJourney, deps(clinic));
    await run.start({ encounterId: 'e2' });
    expect((await run.answer({ patientId: '__new' })).prompt.form).toMatchObject({ formId: PAT });
    const enc = (await run.answer({ qr: { item: [] } })).prompt;
    expect(answer(enc.form.record, 'encounter_patient_ref')).toBe('New Person');
    expect(calls[0]).toEqual(['save', PAT]);
  });

  it('Front Desk: a visit someone else holds is not opened; an existing one resumes at Encounter', async () => {
    const records = new Map([['e3', { id: 'e3', data: section('section_encounter', { encounter_patient_ref: 'Asha Rao' }) }]]);
    expect((await createRunner(frontDeskJourney, deps(fakeClinic({ records, lock: { success: false, lockedBy: 'Ravi' } }).clinic)).start({ encounterId: 'e3' })).result).toMatchObject({ ok: false, title: 'Being worked on' });
    expect((await createRunner(frontDeskJourney, deps(fakeClinic({ records }).clinic)).start({ encounterId: 'e3' })).prompt.step).toBe('encounter');
  });

  it('Consultation: AI draft (paid) fills the form without saving; Prescription PDF saves then attaches; routed elsewhere is refused', async () => {
    const records = new Map([['e1', { id: 'e1', data: section('section_encounter', { encounter_patient_ref: 'Asha Rao', encounter_chief_complaint: 'Fever' }) }]]);
    const { clinic, calls } = fakeClinic({ records, paid: true });
    const run = createRunner(consultationJourney, deps(clinic));
    const notes = (await run.start({ encounterId: 'e1' })).prompt;
    expect(notes.form.group).toBe('section_soap');
    expect(notes.actions.map((a) => a.value)).toEqual(['soap', 'rx']);
    const drafted = (await run.answer({ action: 'soap', qr: { item: [] } })).prompt;
    expect(drafted.step).toBe('notes');
    expect(answer(drafted.form.record, 'soap_assessment')).toBe('Viral fever');
    expect(answer(records.get('e1'), 'soap_assessment')).toBe(''); // not saved until the clinician saves
    expect((await run.answer({ action: 'rx', qr: section('section_soap', { soap_assessment: 'Viral fever', soap_plan: '' }) })).prompt.error).toMatch(/Add a Plan/);
    const afterRx = (await run.answer({ action: 'rx', qr: section('section_soap', { soap_assessment: 'Viral fever', soap_plan: 'Paracetamol' }) })).prompt;
    expect(afterRx).toMatchObject({ step: 'notes', detail: expect.stringMatching(/prescription PDF attached/) });
    expect(calls).toContainEqual(['rx', 'e1']);
    expect((await run.answer({ qr: section('section_soap', { soap_assessment: 'Viral fever', soap_plan: 'Paracetamol' }) })).prompt.step).toBe('documents');
    expect((await run.answer({ formId: '' })).prompt.step).toBe('handoff');
    expect((await run.answer({ choice: 'checkout' })).result.next.to).toBe('/clinic/checkout?encounter=e1');
    expect(calls).toContainEqual(['stage', 'e1', 'consultation']);

    const free = createRunner(consultationJourney, deps(fakeClinic({ records }).clinic));
    await free.start({ encounterId: 'e1' });
    expect((await free.answer({ action: 'soap', qr: { item: [] } })).prompt.error).toMatch(/paid plan/);

    const routed = await createRunner(consultationJourney, deps(fakeClinic({ records, assigned: { accountId: 'dr-9', name: 'Dr Iyer' } }).clinic)).start({ encounterId: 'e1' });
    expect(routed.result).toMatchObject({ ok: false, title: 'Routed to someone else' });
  });

  it('Checkout: medication, payment, health record, close — then the visit is read-only everywhere', async () => {
    const records = new Map([['e1', { id: 'e1', data: section('section_encounter', { encounter_patient_ref: 'Asha Rao' }) }]]);
    const { clinic, calls } = fakeClinic({ records });
    const run = createRunner(checkoutJourney, deps(clinic));
    expect((await run.start({ encounterId: 'e1' })).prompt.form.group).toBe('section_prescription');
    expect((await run.answer({ qr: section('section_prescription', { rx_medication: 'Paracetamol' }) })).prompt.form.group).toBe('section_billing');
    const rec = (await run.answer({ qr: section('section_billing', { billing_total: '500' }) })).prompt;
    expect(rec.step).toBe('record');
    expect((await run.answer({ choice: 'download' })).prompt.detail).toMatch(/Downloaded/);
    expect((await run.answer({ choice: 'continue' })).prompt.step).toBe('close');
    const closed = await run.answer({ choice: 'close' });
    expect(closed.result).toMatchObject({ ok: true, readonly: true });
    expect(closed.result.sections.map((x) => x.title)).toEqual(['Encounter', 'Prescription', 'Billing']);
    expect(isClosed(records.get('e1'))).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([['pdf', 'e1'], ['close', 'e1'], ['unlock', 'e1', 'checkout']]));
    // Every clinic journey now opens it read-only, sending nothing.
    for (const j of [frontDeskJourney, consultationJourney, checkoutJourney]) {
      const c = fakeClinic({ records });
      const view = await createRunner(j, deps(c.clinic)).start({ encounterId: 'e1' });
      expect(view.result).toMatchObject({ ok: true, readonly: true });
      expect(c.calls.filter(([k]) => k !== 'lock')).toEqual([]);
    }
  });
});
