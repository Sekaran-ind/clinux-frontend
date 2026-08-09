import { describe, it, expect, vi } from 'vitest';

const FAKE_QUESTIONNAIRES = {
  'form-a': {
    item: [
      {
        linkId: 'section_encounter',
        type: 'group',
        item: [
          { linkId: 'encounter_status', type: 'choice', text: 'Status', definition: 'http://hl7.org/Encounter#Encounter.status', answerOption: [{ valueString: 'arrived' }, { valueString: 'finished' }] },
          { linkId: 'encounter_chief_complaint', type: 'string', text: 'Chief Complaint', description: 'What brought the patient in', definition: 'http://hl7.org/Encounter#Encounter.reasonCode' },
        ],
      },
      {
        linkId: 'section_soap',
        type: 'group',
        item: [
          { linkId: 'soap_subjective', type: 'string', text: 'Subjective', keywords: ['complains', 'reports'], definition: 'http://hl7.org/Condition#Condition.note.text' },
        ],
      },
    ],
  },
  'form-b': { item: [] },
  'form-missing': null,
};

vi.mock('../data/useSystemForms.js', () => ({
  activeQuestionnaire: (formId) => FAKE_QUESTIONNAIRES[formId] ?? null,
  SYSTEM_FORM_IDS: ['form-a', 'form-b'],
}));

const { harvestFieldMetadata } = await import('./formFieldHarvester.js');

describe('harvestFieldMetadata', () => {
  it('flattens every leaf field across every form, tagging each with its enclosing group linkId', () => {
    const fields = harvestFieldMetadata(['form-a']);
    expect(fields).toHaveLength(3);

    const status = fields.find((f) => f.linkId === 'encounter_status');
    expect(status).toMatchObject({
      formId: 'form-a', groupLinkId: 'section_encounter', label: 'Status',
      path: 'Encounter.status', type: 'choice', choices: ['arrived', 'finished'],
    });

    const complaint = fields.find((f) => f.linkId === 'encounter_chief_complaint');
    expect(complaint).toMatchObject({ groupLinkId: 'section_encounter', description: 'What brought the patient in', keywords: [] });

    const subjective = fields.find((f) => f.linkId === 'soap_subjective');
    expect(subjective).toMatchObject({ groupLinkId: 'section_soap', keywords: ['complains', 'reports'] });
  });

  it('defaults to SYSTEM_FORM_IDS and skips forms with no compiled questionnaire yet', () => {
    const fields = harvestFieldMetadata();
    // form-b has no items, form-a contributes 3 — SYSTEM_FORM_IDS only lists these two.
    expect(fields).toHaveLength(3);
  });

  it('returns [] for a form id with no compiled questionnaire (never seeded)', () => {
    expect(harvestFieldMetadata(['form-missing'])).toEqual([]);
  });
});
