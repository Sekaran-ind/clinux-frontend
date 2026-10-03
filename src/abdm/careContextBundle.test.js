import { describe, expect, it } from 'vitest';
import { billProcedures, opConsultBundle } from './careContextBundle.js';

const qr = (...groups) => ({ resourceType: 'QuestionnaireResponse', item: groups.map(([linkId, values]) => ({ linkId, item: Object.entries(values).map(([k, v]) => ({ linkId: k, answer: [typeof v === 'number' ? { valueDecimal: v } : { valueString: v }] })) })) });
const encounter = {
  id: 'rec-1',
  data: qr(
    ['section_encounter', { encounter_patient_ref: 'Asha Rao', encounter_chief_complaint: 'Fever for 3 days' }],
    ['section_vitals', { vitals_systolic: 120, vitals_diastolic: 80, vitals_pulse: 92, vitals_temperature: 101.2 }],
    ['section_soap', { soap_subjective: 'Fever, chills', soap_objective: 'Throat congested', soap_assessment: 'Viral pharyngitis', soap_plan: 'Rest, fluids' }],
    ['section_prescription', { rx_medication: 'Paracetamol 650 mg', rx_dosage: '1 tablet SOS', rx_status: 'active' }],
    ['section_prescription', { rx_medication: 'Cetirizine 10 mg', rx_dosage: 'At night' }],
    ['section_billing', { billing_total: '500', billing_status: 'issued' }],
    ['section_billing', { billing_total: '200', billing_status: 'balanced' }],
  ),
};
const args = { encounter, patient: { id: 'pat-1', name: 'Asha Rao', gender: 'F', birthDate: '1994-10-10', mobile: '9876543210' }, facility: { id: 'IN3310002300', name: 'Asha Clinic' }, practitioner: { name: 'Dr Rao', hprId: '71-0285-6047-2578' }, date: '2026-10-03T05:00:00.000Z' };

describe('OPConsultRecord document', () => {
  const b = opConsultBundle(args);
  const byType = (t) => b.entry.filter((e) => e.resource.resourceType === t).map((e) => e.resource);
  const resolve = (r) => b.entry.find((e) => e.fullUrl === r.reference)?.resource;

  it('is an ABDM document bundle whose Composition comes first and references only what is in it', () => {
    expect(b).toMatchObject({ resourceType: 'Bundle', type: 'document', meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/DocumentBundle'] } });
    const comp = b.entry[0].resource;
    expect(comp).toMatchObject({ resourceType: 'Composition', status: 'final', title: 'Consultation Report', type: { coding: [{ code: '371530004' }] }, meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/OPConsultRecord'] } });
    expect(resolve(comp.subject).resourceType).toBe('Patient');
    expect(resolve(comp.encounter).resourceType).toBe('Encounter');
    expect(resolve(comp.custodian).identifier[0].value).toBe('IN3310002300');
    for (const s of comp.section) for (const e of s.entry) expect(resolve(e)).toBeTruthy();
    expect(new Set(b.entry.map((e) => e.fullUrl)).size).toBe(b.entry.length);
  });

  it('puts each part of the visit in the IG’s section', () => {
    const codes = Object.fromEntries(b.entry[0].resource.section.map((s) => [s.code.coding[0].code, s.entry.map((e) => resolve(e))]));
    expect(codes['422843007'].map((c) => c.code.text)).toEqual(['Fever for 3 days']);
    const bp = codes['425044008'].find((o) => o.code.coding?.[0].code === '85354-9');
    expect(bp.component.map((c) => c.valueQuantity.value)).toEqual([120, 80]);
    expect(codes['425044008'].find((o) => o.code.coding?.[0].code === '8310-5').valueQuantity).toMatchObject({ value: 101.2, code: '[degF]' });
    expect(codes['721912009'].map((m) => [m.medicationCodeableConcept.text, m.dosageInstruction?.[0].text, m.status])).toEqual([['Paracetamol 650 mg', '1 tablet SOS', 'active'], ['Cetirizine 10 mg', 'At night', 'active']]);
    expect(codes['404684003'].map((o) => o.valueString)).toEqual(['Fever, chills', 'Viral pharyngitis', 'Rest, fluids']);
  });

  it('identifies the patient as the IG requires and leaves out empty sections', () => {
    const [p] = byType('Patient');
    expect(p.identifier[0].type.coding[0].code).toBe('MR');
    expect(p).toMatchObject({ gender: 'female', birthDate: '1994-10-10', name: [{ text: 'Asha Rao' }] });
    const bare = opConsultBundle({ ...args, encounter: { id: 'rec-2', data: qr(['section_encounter', { encounter_chief_complaint: 'Checkup' }]) } });
    expect(bare.entry[0].resource.section.map((s) => s.title)).toEqual(['Chief complaints']);
  });
});

describe('Scan & Pay bill from a visit', () => {
  it('lists only the visit’s unpaid charges', () => {
    expect(billProcedures(encounter, { patientName: 'Asha Rao' })).toEqual([{ category: 'OPD consultation', services: [{ serviceId: 'rec-1-1', name: 'Visit charges', description: 'Asha Rao · visit rec-1', amount: 500 }] }]);
    expect(billProcedures({ id: 'x', data: qr(['section_billing', { billing_total: '100', billing_status: 'balanced' }]) })).toEqual([]);
  });
});
