import { describe, it, expect } from 'vitest';
import { sliceQuestionnaireGroup } from './formsLibrary.js';

// sliceQuestionnaireGroup is pure — tested directly against plain compiled-Questionnaire-shaped
// fixtures, no formsLibrary collection/localStorage involved.
function questionnaire(items) {
  return { resourceType: 'Questionnaire', status: 'active', item: items };
}

describe('sliceQuestionnaireGroup', () => {
  it('returns a new Questionnaire whose item array holds only the requested group', () => {
    const q = questionnaire([
      { linkId: 'section_hospital', text: 'Hospital Details', type: 'group', item: [{ linkId: 'hospital_name', type: 'string' }] },
      { linkId: 'section_staff', text: 'Staff', type: 'group', item: [{ linkId: 'staff_name', type: 'string' }] },
    ]);
    const sliced = sliceQuestionnaireGroup(q, 'section_hospital');

    expect(sliced.item).toHaveLength(1);
    expect(sliced.item[0].linkId).toBe('section_hospital');
    expect(sliced.item[0].item).toEqual([{ linkId: 'hospital_name', type: 'string' }]);
  });

  it('preserves every other top-level Questionnaire field (resourceType, status, etc.)', () => {
    const q = questionnaire([{ linkId: 'section_hospital', type: 'group', item: [] }]);
    const sliced = sliceQuestionnaireGroup(q, 'section_hospital');
    expect(sliced.resourceType).toBe('Questionnaire');
    expect(sliced.status).toBe('active');
  });

  it('is pure — the original Questionnaire object is untouched, the result is a new reference', () => {
    const q = questionnaire([
      { linkId: 'section_hospital', type: 'group', item: [] },
      { linkId: 'section_staff', type: 'group', item: [] },
    ]);
    const sliced = sliceQuestionnaireGroup(q, 'section_hospital');
    expect(q.item).toHaveLength(2); // original untouched
    expect(sliced).not.toBe(q);
  });

  it('returns null for a group id that does not exist, and for a null questionnaire — caller checks, same convention as activeQuestionnaire', () => {
    const q = questionnaire([{ linkId: 'section_hospital', type: 'group', item: [] }]);
    expect(sliceQuestionnaireGroup(q, 'section_nonexistent')).toBeNull();
    expect(sliceQuestionnaireGroup(null, 'section_hospital')).toBeNull();
  });
});
