import { describe, expect, it } from 'vitest';
import { answer, isClosed, mergeSection, sectionsOf } from './encounterRecord.js';

const Q = {
  item: [
    { linkId: 'section_encounter', text: 'Encounter', type: 'group', item: [{ linkId: 'encounter_chief_complaint', text: 'Chief complaint' }, { linkId: 'encounter_status', text: 'Status' }] },
    { linkId: 'section_vitals', text: 'Vitals', type: 'group', repeats: true, item: [{ linkId: 'vitals_pulse', text: 'Pulse' }] },
  ],
};
const record = {
  data: {
    item: [
      { linkId: 'section_encounter', item: [
        { linkId: 'encounter_chief_complaint', answer: [{ valueString: 'Fever' }] },
        { linkId: 'encounter_stage_onboarding', answer: [{ valueString: 'true' }] },
      ] },
      { linkId: 'section_vitals', item: [{ linkId: 'vitals_pulse', answer: [{ valueInteger: 80 }] }] },
    ],
  },
};

describe('encounter record helpers', () => {
  it('merging a single section keeps answers the form does not show (stage flags)', () => {
    const out = mergeSection(record.data, Q.item[0], { item: [{ linkId: 'section_encounter', item: [{ linkId: 'encounter_chief_complaint', answer: [{ valueString: 'Cough' }] }] }] });
    expect(answer({ data: out }, 'encounter_chief_complaint')).toBe('Cough');
    expect(answer({ data: out }, 'encounter_stage_onboarding')).toBe('true');
    expect(out.item.map((i) => i.linkId)).toEqual(['section_encounter', 'section_vitals']); // order kept
    expect(answer(record, 'encounter_chief_complaint')).toBe('Fever'); // input not mutated
  });

  it('merging a repeating section replaces every instance', () => {
    const out = mergeSection(record.data, Q.item[1], { item: [
      { linkId: 'section_vitals', item: [{ linkId: 'vitals_pulse', answer: [{ valueInteger: 88 }] }] },
      { linkId: 'section_vitals', item: [{ linkId: 'vitals_pulse', answer: [{ valueInteger: 92 }] }] },
    ] });
    expect(out.item.filter((i) => i.linkId === 'section_vitals')).toHaveLength(2);
    expect(out.item[0].linkId).toBe('section_encounter');
  });

  it('a section missing from the record is added', () => {
    const out = mergeSection({ item: [] }, Q.item[0], { item: [{ linkId: 'section_encounter', item: [{ linkId: 'encounter_status', answer: [{ valueCoding: { display: 'finished' } }] }] }] });
    expect(isClosed({ data: out })).toBe(true);
  });

  it('lays a record out by section for reading, numbering repeats and leaving out non-form answers', () => {
    const twoVitals = { data: { item: [...record.data.item, { linkId: 'section_vitals', item: [{ linkId: 'vitals_pulse', answer: [{ valueInteger: 90 }] }] }] } };
    expect(sectionsOf(Q, twoVitals)).toEqual([
      { title: 'Encounter', rows: [['Chief complaint', 'Fever']] },
      { title: 'Vitals', rows: [['#1 · Pulse', '80'], ['#2 · Pulse', '90']] },
    ]);
  });
});
