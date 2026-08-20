import { describe, it, expect } from 'vitest';
import { getAnswer, getAnswers, recordSummary, getGroupInstances, withGroupFields, patchGroupInstanceField, appendGroupInstance, formData } from './formData.js';

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

    // Regression test: a MultiSelect field (e.g. Office Hours' "Days of Week") produces multiple
    // entries in one item's answer[] — recordSummary used to only ever read answer[0], so
    // selecting Mon–Fri and saving silently summarized as just "mon", dropping every day after
    // the first (reported as "breaks between the first section and last section").
    it('joins every answer for a multi-answer field (MultiSelect), not just the first', () => {
        const r = record([
            { linkId: 'hours_days', answer: [{ valueCoding: { display: 'mon' } }, { valueCoding: { display: 'wed' } }, { valueCoding: { display: 'fri' } }] },
            { linkId: 'hours_open', answer: [{ valueString: '08:00' }] },
            { linkId: 'hours_close', answer: [{ valueString: '20:00' }] },
        ]);
        expect(recordSummary(r)).toBe('mon, wed, fri · 08:00 · 20:00');
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

    // Real bug found live: clinical.js's getEncounter() reads through useLiveQuery, which hands
    // back a Vue-reactive Proxy, not a plain object. structuredClone() cannot clone a Proxy at
    // all — it threw DataCloneError, uncaught, which killed Cübo's whole slot-fill dispatch
    // mid-flight (formSlotEngine.js's applyFills() calls this with exactly that reactive
    // encounter.data) before the code that stops its progress indicator ever ran — reproduced
    // live via a real Vue reactive() wrapper below, not just asserted from reading the fix.
    it('handles a Vue-reactive (Proxy-wrapped) recordData without throwing', async () => {
        const { reactive } = await import('vue');
        const data = reactive({
            item: [{ linkId: 'section_encounter', item: [{ linkId: 'encounter_status', answer: [{ valueString: 'arrived' }] }] }],
        });
        expect(() => withGroupFields(data, 'section_encounter', { encounter_chief_complaint: 'chest pain' })).not.toThrow();
        const result = withGroupFields(data, 'section_encounter', { encounter_chief_complaint: 'chest pain' });
        expect(getAnswer({ data: result }, 'encounter_chief_complaint')).toBe('chest pain');
    });
});

describe('patchGroupInstanceField', () => {
    // Unlike withGroupFields (pure, singular groups), this persists directly against the real
    // formData collection and targets ONE instance of a REPEATING group by position — the whole
    // point being that patchRecordField's own global walk would otherwise write onto every
    // repeating instance sharing that linkId, not just the one that should change.
    it("patches only the targeted instance, leaving every other instance untouched", () => {
        const id = 'rec-patch-instance-test';
        formData.insert({
            id, formId: 'system-provider-composition-v1', version: 1,
            data: {
                item: [
                    { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Alice' }] }] },
                    { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Bob' }] }] },
                    { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Carol' }] }] },
                ],
            },
            savedAt: new Date().toISOString(),
        });

        patchGroupInstanceField(id, 'section_staff', 1, { staff_hprid: 'HPR-BOB-001' });

        const rec = formData.get(id);
        const instances = getGroupInstances(rec, 'section_staff');
        expect(getAnswer({ data: instances[0] }, 'staff_hprid')).toBe('');
        expect(getAnswer({ data: instances[1] }, 'staff_hprid')).toBe('HPR-BOB-001');
        expect(getAnswer({ data: instances[2] }, 'staff_hprid')).toBe('');
        // The targeted instance's other fields survive untouched.
        expect(getAnswer({ data: instances[1] }, 'staff_name')).toBe('Bob');

        formData.delete(id);
    });

    it('does nothing for a record id that does not exist', () => {
        expect(() => patchGroupInstanceField('rec-does-not-exist', 'section_staff', 0, { staff_hprid: 'x' })).not.toThrow();
    });
});

describe('appendGroupInstance', () => {
    // SPEC-09's controlled-input registration forms use this instead of LForms extraction — see
    // clinux-lforms-coded-field-data-loss-bug memory note for why: a plain v-model value has no
    // "click a dropdown to confirm" step to silently fail at, unlike LForms' coded fields.
    it('appends a new instance without disturbing existing ones, and returns its index', () => {
        const id = 'rec-append-instance-test';
        formData.insert({
            id, formId: 'system-provider-composition-v1', version: 1,
            data: { item: [{ linkId: 'section_staff', item: [{ linkId: 'staff_first_name', answer: [{ valueString: 'Alice' }] }] }] },
            savedAt: new Date().toISOString(),
        });

        const newIndex = appendGroupInstance(id, 'section_staff', { staff_first_name: 'Priya', staff_specialty: 'Cardiology' });
        expect(newIndex).toBe(1);

        const rec = formData.get(id);
        const instances = getGroupInstances(rec, 'section_staff');
        expect(instances).toHaveLength(2);
        expect(getAnswer({ data: instances[0] }, 'staff_first_name')).toBe('Alice');
        expect(getAnswer({ data: instances[1] }, 'staff_first_name')).toBe('Priya');
        expect(getAnswer({ data: instances[1] }, 'staff_specialty')).toBe('Cardiology');

        formData.delete(id);
    });

    it('omits blank/undefined field values instead of storing empty answers', () => {
        const id = 'rec-append-blank-test';
        formData.insert({ id, formId: 'system-provider-composition-v1', version: 1, data: { item: [] }, savedAt: new Date().toISOString() });

        appendGroupInstance(id, 'section_staff', { staff_first_name: 'Priya', staff_middle_name: '' });

        const rec = formData.get(id);
        const instance = getGroupInstances(rec, 'section_staff')[0];
        expect((instance.item || []).some((f) => f.linkId === 'staff_middle_name')).toBe(false);

        formData.delete(id);
    });

    it('returns -1 and does nothing for a record id that does not exist', () => {
        expect(appendGroupInstance('rec-does-not-exist', 'section_staff', { staff_first_name: 'x' })).toBe(-1);
    });
});
