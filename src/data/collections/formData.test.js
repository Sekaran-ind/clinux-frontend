import { describe, it, expect } from 'vitest';
import { getAnswer, getAnswers, recordSummary, getGroupInstances, withGroupFields, mergeGroupResponseItem, mergeGroupResponseItems, sliceRecordGroup, patchGroupInstanceField, appendGroupInstance, appendGroupResponseItem, saveDataRecord, formData } from './formData.js';

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

    it('omits blank/undefined field values instead of storing empty answers, matching appendGroupInstance', () => {
        const result = withGroupFields({ item: [] }, 'section_hospital', { hospital_name: 'Malar Hospital', hospital_legalname: '' });
        const group = result.item.find((i) => i.linkId === 'section_hospital');
        expect((group.item || []).some((f) => f.linkId === 'hospital_legalname')).toBe(false);
        expect(getAnswer({ data: result }, 'hospital_name')).toBe('Malar Hospital');
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

describe('sliceRecordGroup', () => {
    // Real bug found live (LForms threw "Cannot read properties of null (reading 'dataType')"
    // rendering a step 2+ group with the FULL multi-group record) — see this function's own
    // comment for the reproduction. These tests are the regression case.
    it('narrows the record down to just the requested group, dropping every other group', () => {
        const rec = record([
            { linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'Malar' }] }] },
            { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Dr. Kumar' }] }] },
        ]);
        const sliced = sliceRecordGroup(rec, 'section_hospital');
        expect(sliced.data.item).toHaveLength(1);
        expect(sliced.data.item[0].linkId).toBe('section_hospital');
    });

    it('returns an empty-item record (not null) when the group has no saved data yet — a blank step, not a crash', () => {
        const rec = record([{ linkId: 'section_hospital', item: [] }]);
        const sliced = sliceRecordGroup(rec, 'section_hospital_abdm_facility_type');
        expect(sliced.data.item).toEqual([]);
    });

    it('returns null for a null record, and does not mutate the original', () => {
        expect(sliceRecordGroup(null, 'section_hospital')).toBeNull();
        const rec = record([{ linkId: 'section_hospital', item: [] }, { linkId: 'section_staff', item: [] }]);
        sliceRecordGroup(rec, 'section_hospital');
        expect(rec.data.item).toHaveLength(2); // original untouched
    });

    it('returns EVERY existing instance of a repeating group, not just the first — real bug fixed live: an earlier .find()-based version silently dropped every instance past the first', () => {
        const rec = record([
            { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Dr. Kumar' }] }] },
            { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Nurse Priya' }] }] },
            { linkId: 'section_hospital', item: [] },
        ]);
        const sliced = sliceRecordGroup(rec, 'section_staff');
        expect(sliced.data.item).toHaveLength(2);
        expect(sliced.data.item.map((g) => getAnswer({ data: { item: g.item } }, 'staff_name'))).toEqual(['Dr. Kumar', 'Nurse Priya']);
    });
});

describe('mergeGroupResponseItem', () => {
    it('replaces an existing group by linkId with a real QuestionnaireResponse item, leaving other groups untouched', () => {
        const data = {
            item: [
                { linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'old name' }] }] },
                { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Dr. Kumar' }] }] },
            ],
        };
        const newGroup = { linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'new name' }] }] };
        const result = mergeGroupResponseItem(data, newGroup);

        expect(getAnswer({ data: result }, 'hospital_name')).toBe('new name');
        expect(getAnswer({ data: result }, 'staff_name')).toBe('Dr. Kumar'); // untouched
        expect(result.item.filter((i) => i.linkId === 'section_hospital').length).toBe(1); // replaced, not duplicated

        // Pure — same discipline as withGroupFields.
        expect(getAnswer({ data }, 'hospital_name')).toBe('old name');
        expect(result).not.toBe(data);
    });

    it('appends the group when absent instead of requiring it to already exist', () => {
        const result = mergeGroupResponseItem({ item: [] }, { linkId: 'section_hospital_abdm_location', item: [{ linkId: 'hospital_state_lgd_code', answer: [{ valueString: 'TN' }] }] });
        expect(getAnswer({ data: result }, 'hospital_state_lgd_code')).toBe('TN');
    });

    it('preserves real FHIR answer types (not flattened to valueString) — the whole point vs. withGroupFields', () => {
        const newGroup = {
            linkId: 'section_hospital_abdm_facility_type',
            item: [
                { linkId: 'hospital_facility_type', answer: [{ valueCoding: { code: 'HOSP', display: 'Hospital' } }] },
                { linkId: 'hospital_operational_status', answer: [{ valueBoolean: true }] },
            ],
        };
        const result = mergeGroupResponseItem({ item: [] }, newGroup);
        const group = result.item.find((i) => i.linkId === 'section_hospital_abdm_facility_type');
        expect(group.item[0].answer[0].valueCoding).toEqual({ code: 'HOSP', display: 'Hospital' });
        expect(group.item[1].answer[0].valueBoolean).toBe(true);
    });

    it('handles a Vue-reactive (Proxy-wrapped) recordData without throwing', async () => {
        const { reactive } = await import('vue');
        const data = reactive({ item: [{ linkId: 'section_hospital', item: [] }] });
        const newGroup = { linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'Malar Hospital' }] }] };
        expect(() => mergeGroupResponseItem(data, newGroup)).not.toThrow();
        const result = mergeGroupResponseItem(data, newGroup);
        expect(getAnswer({ data: result }, 'hospital_name')).toBe('Malar Hospital');
    });
});

describe('mergeGroupResponseItems', () => {
    it('replaces ALL existing instances of a repeating group with the new set, leaving other groups untouched', () => {
        const data = {
            item: [
                { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'old Dr. Kumar' }] }] },
                { linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'Malar' }] }] },
            ],
        };
        const newInstances = [
            { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Dr. Kumar' }] }] },
            { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Nurse Priya' }] }] },
        ];
        const result = mergeGroupResponseItems(data, 'section_staff', newInstances);

        const staffGroups = result.item.filter((i) => i.linkId === 'section_staff');
        expect(staffGroups).toHaveLength(2);
        expect(staffGroups.map((g) => getAnswer({ data: { item: g.item } }, 'staff_name'))).toEqual(['Dr. Kumar', 'Nurse Priya']);
        expect(getAnswer({ data: result }, 'hospital_name')).toBe('Malar'); // untouched

        // Pure — same discipline as mergeGroupResponseItem.
        expect(data.item.filter((i) => i.linkId === 'section_staff')).toHaveLength(1);
        expect(result).not.toBe(data);
    });

    it('replacing with an empty array removes every existing instance — a real allowed case (the user removed all of them)', () => {
        const data = { item: [{ linkId: 'section_consent', item: [{ linkId: 'consent_title', answer: [{ valueString: 'old' }] }] }] };
        const result = mergeGroupResponseItems(data, 'section_consent', []);
        expect(result.item.filter((i) => i.linkId === 'section_consent')).toHaveLength(0);
    });

    it('adds the group fresh when no existing instances are present', () => {
        const result = mergeGroupResponseItems({ item: [] }, 'section_hours', [
            { linkId: 'section_hours', item: [{ linkId: 'hours_days', answer: [{ valueString: 'mon' }] }] },
        ]);
        expect(getAnswer({ data: result }, 'hours_days')).toBe('mon');
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

describe('appendGroupResponseItem', () => {
    // Real onboarding-UI audit/rebuild, Provider (Staff) — the FHIR-native counterpart to
    // appendGroupInstance above, taking real QuestionnaireResponse group item(s) straight from
    // LhcFormHost.extract() instead of a flat { linkId: value } map (see StaffOnboarding.vue).
    it('appends a new real FHIR group item without disturbing existing ones, and returns its index', () => {
        const id = 'rec-append-response-item-test';
        formData.insert({
            id, formId: 'system-provider-composition-v1', version: 1,
            data: { item: [{ linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'Alice' }] }] }] },
            savedAt: new Date().toISOString(),
        });

        const newIndexes = appendGroupResponseItem(id, 'section_staff', [{
            linkId: 'section_staff',
            item: [
                { linkId: 'staff_name', answer: [{ valueString: 'Priya' }] },
                { linkId: 'staff_specialty', answer: [{ valueCoding: { display: 'Cardiology' } }] },
            ],
        }]);
        expect(newIndexes).toEqual([1]);

        const rec = formData.get(id);
        const instances = getGroupInstances(rec, 'section_staff');
        expect(instances).toHaveLength(2);
        expect(getAnswer({ data: instances[0] }, 'staff_name')).toBe('Alice');
        expect(getAnswer({ data: instances[1] }, 'staff_name')).toBe('Priya');
        expect(getAnswer({ data: instances[1] }, 'staff_specialty')).toBe('Cardiology');

        formData.delete(id);
    });

    it('accepts multiple group items in one call, indexing each after the existing count', () => {
        const id = 'rec-append-response-item-multi-test';
        formData.insert({ id, formId: 'system-provider-composition-v1', version: 1, data: { item: [] }, savedAt: new Date().toISOString() });

        const newIndexes = appendGroupResponseItem(id, 'section_staff', [
            { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'A' }] }] },
            { linkId: 'section_staff', item: [{ linkId: 'staff_name', answer: [{ valueString: 'B' }] }] },
        ]);
        expect(newIndexes).toEqual([0, 1]);
        expect(getGroupInstances(formData.get(id), 'section_staff')).toHaveLength(2);

        formData.delete(id);
    });

    it('returns [] and does nothing for a record id that does not exist', () => {
        expect(appendGroupResponseItem('rec-does-not-exist', 'section_staff', [{ linkId: 'section_staff', item: [] }])).toEqual([]);
    });
});

describe('saveDataRecord', () => {
    // Real bug found live (SPEC-11): window.LForms.Util.mergeFHIRDataIntoLForms() silently merges
    // NOTHING (no thrown error, every field just renders blank) when the record data isn't shaped
    // like a real FHIR QuestionnaireResponse resource — resourceType/status have to be present, a
    // bare { item: [...] } isn't enough. Every controlled-input write path (appendGroupInstance,
    // withGroupFields, ensureProviderRecord's own seed) builds/patches plain { item: [...] }
    // objects with neither field, unlike LForms' own extraction (getFormFHIRData) which always
    // included them — invisible until a Provider record saved this way was viewed through
    // Designer.vue's still-LForms-rendered entity drawer. Confirmed live: a real Hospital record
    // with correct data in localStorage rendered every field blank in that drawer until this fix.
    it('always stamps resourceType/status onto the saved data, even when the caller omits them', () => {
        const id = saveDataRecord('system-provider-composition-v1', 1, { item: [{ linkId: 'hospital_name', answer: [{ valueString: 'Malar Hospital' }] }] }, null);
        const rec = formData.get(id);
        expect(rec.data.resourceType).toBe('QuestionnaireResponse');
        expect(rec.data.status).toBe('completed');
        expect(getAnswer(rec, 'hospital_name')).toBe('Malar Hospital');
        formData.delete(id);
    });

    it('never overwrites a resourceType/status the caller already set (e.g. real LForms extraction)', () => {
        const id = saveDataRecord('system-encounter-composition-v1', 1, { resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [] }, null);
        const rec = formData.get(id);
        expect(rec.data.status).toBe('in-progress');
        formData.delete(id);
    });
});
