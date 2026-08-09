import { describe, it, expect } from 'vitest';
import { getAnswer, getAnswers, recordSummary, getGroupInstances, withGroupFields } from './formData.js';

// getAnswer/getAnswers/recordSummary are pure functions over a FHIR QuestionnaireResponse-shaped
// record ({ data: { item: [...] } }) — tested directly with plain fixtures, no TanStack DB/
// localStorage involved (formData itself, the collection, is untouched by these tests).

function record(item) {
    return { id: 'rec-1', data: { item } };
}

describe('getAnswer', () => {
    it('finds a flat valueString answer by linkId', () => {
        const r = record([{ linkId: 'gender', answer: [{ valueString: 'female' }] }]);
        expect(getAnswer(r, 'gender')).toBe('female');
    });

    it('finds an answer nested inside a group item', () => {
        const r = record([
            { linkId: 'section_vitals', item: [{ linkId: 'systolic_bp', answer: [{ valueDecimal: 148 }] }] },
        ]);
        expect(getAnswer(r, 'systolic_bp')).toBe(148);
    });

    it('falls back through valueBoolean, valueDate, and valueCoding (display then code)', () => {
        expect(getAnswer(record([{ linkId: 'a', answer: [{ valueBoolean: true }] }]), 'a')).toBe(true);
        expect(getAnswer(record([{ linkId: 'b', answer: [{ valueDate: '2026-01-01' }] }]), 'b')).toBe('2026-01-01');
        expect(getAnswer(record([{ linkId: 'c', answer: [{ valueCoding: { code: 'M', display: 'Male' } }] }]), 'c')).toBe('Male');
        expect(getAnswer(record([{ linkId: 'd', answer: [{ valueCoding: { code: 'M' } }] }]), 'd')).toBe('M');
    });

    it('returns "" for a missing linkId or a null record', () => {
        expect(getAnswer(record([{ linkId: 'x', answer: [{ valueString: 'y' }] }]), 'nope')).toBe('');
        expect(getAnswer(null, 'nope')).toBe('');
    });
});

describe('getAnswers', () => {
    it('collects every answer for a repeating linkId, including nested', () => {
        const r = record([
            { linkId: 'allergies', answer: [{ valueString: 'penicillin' }, { valueString: 'latex' }] },
            { linkId: 'section', item: [{ linkId: 'allergies', answer: [{ valueString: 'peanuts' }] }] },
        ]);
        expect(getAnswers(r, 'allergies')).toEqual(['penicillin', 'latex', 'peanuts']);
    });

    it('returns [] when nothing matches', () => {
        expect(getAnswers(record([]), 'nope')).toEqual([]);
        expect(getAnswers(null, 'nope')).toEqual([]);
    });
});

describe('recordSummary', () => {
    it('joins up to 3 non-empty answers with " · "', () => {
        const r = record([
            { linkId: 'a', answer: [{ valueString: 'Alice' }] },
            { linkId: 'b', answer: [{ valueString: '' }] },
            { linkId: 'c', answer: [{ valueDecimal: 30 }] },
            { linkId: 'd', answer: [{ valueString: 'female' }] },
            { linkId: 'e', answer: [{ valueString: 'extra-should-be-dropped' }] },
        ]);
        expect(recordSummary(r)).toBe('Alice · 30 · female');
    });

    it('falls back to record.id when there are no non-empty answers', () => {
        expect(recordSummary(record([]))).toBe('rec-1');
    });
});

describe('getGroupInstances', () => {
    it('returns every sibling item sharing a repeating group\'s linkId', () => {
        const r = record([
            { linkId: 'section_vitals', item: [{ linkId: 'vitals_systolic', answer: [{ valueDecimal: 120 }] }] },
            { linkId: 'section_vitals', item: [{ linkId: 'vitals_systolic', answer: [{ valueDecimal: 130 }] }] },
            { linkId: 'section_soap', item: [{ linkId: 'soap_subjective', answer: [{ valueString: 'ok' }] }] },
        ]);
        const vitals = getGroupInstances(r, 'section_vitals');
        expect(vitals).toHaveLength(2);
        expect(getAnswer({ data: { item: vitals[0].item } }, 'vitals_systolic')).toBe(120);
        expect(getAnswer({ data: { item: vitals[1].item } }, 'vitals_systolic')).toBe(130);
    });

    it('returns a single-element array for a singular group, and [] for no record/no match', () => {
        const r = record([{ linkId: 'section_soap', item: [] }]);
        expect(getGroupInstances(r, 'section_soap')).toHaveLength(1);
        expect(getGroupInstances(r, 'section_billing')).toEqual([]);
        expect(getGroupInstances(null, 'section_soap')).toEqual([]);
    });
});

describe('withGroupFields', () => {
    it('patches an existing singular group\'s fields without touching other groups', () => {
        const data = {
            item: [
                { linkId: 'section_encounter', item: [{ linkId: 'encounter_status', answer: [{ valueString: 'arrived' }] }] },
                { linkId: 'section_soap', item: [{ linkId: 'soap_subjective', answer: [{ valueString: 'old' }] }] },
            ],
        };
        const result = withGroupFields(data, 'section_soap', { soap_subjective: 'new subjective', soap_plan: 'rest' });

        expect(getAnswer({ data: result }, 'soap_subjective')).toBe('new subjective');
        expect(getAnswer({ data: result }, 'soap_plan')).toBe('rest');
        expect(getAnswer({ data: result }, 'encounter_status')).toBe('arrived'); // untouched

        // Pure — the original object must not be mutated, and the result must be a new reference.
        expect(getAnswer({ data }, 'soap_subjective')).toBe('old');
        expect(result).not.toBe(data);
    });

    it('creates the group (and its fields) from scratch when absent', () => {
        const result = withGroupFields({ item: [] }, 'section_billing', { billing_total: '500' });
        expect(getAnswer({ data: result }, 'billing_total')).toBe('500');
    });
});
