import { describe, it, expect } from 'vitest';
import { HOSPITAL_FIELDS, STAFF_FIELDS, getFieldSet, groupFieldsBySection } from './abdmSchema.js';

function expectWellFormed(fields) {
  const seen = new Set();
  fields.forEach((f) => {
    expect(f.linkId, 'every field needs a linkId').toBeTruthy();
    expect(seen.has(f.linkId), `duplicate linkId: ${f.linkId}`).toBe(false);
    seen.add(f.linkId);
    expect(f.label, `${f.linkId} needs a label`).toBeTruthy();
    expect(['text', 'select', 'checkbox']).toContain(f.type);
    if (f.type === 'select') {
      expect(Array.isArray(f.options) && f.options.length > 0, `${f.linkId} is a select with no options`).toBe(true);
      f.options.forEach((o) => {
        expect(o.value, `${f.linkId} option missing a value`).toBeTruthy();
        expect(o.label, `${f.linkId} option missing a label`).toBeTruthy();
      });
    }
  });
}

describe('HOSPITAL_FIELDS / STAFF_FIELDS', () => {
  it('are well-formed: unique linkIds, every field has a label/type, every select has options', () => {
    expectWellFormed(HOSPITAL_FIELDS);
    expectWellFormed(STAFF_FIELDS);
  });

  it('matches the exact linkIds abdmAdapter.js already reads, so existing HFR/HPR request builders keep working unchanged', () => {
    const hospitalLinkIds = HOSPITAL_FIELDS.map((f) => f.linkId);
    const staffLinkIds = STAFF_FIELDS.map((f) => f.linkId);
    // The fields buildHfrBasicInfoBody/buildHfrSearchBody actually read (confirmed against
    // src/data/abdmAdapter.js) -- if this schema doesn't cover these, the adapter breaks.
    ['hospital_name', 'hospital_ownership_code', 'hospital_facility_type', 'hospital_operational_status',
      'hospital_state_lgd_code', 'hospital_district_lgd_code', 'hospital_pin', 'hospital_address']
      .forEach((id) => expect(hospitalLinkIds).toContain(id));
    // The fields buildHprCreateBody actually reads.
    ['staff_first_name', 'staff_last_name', 'staff_email', 'staff_hp_category_code',
      'staff_hp_subcategory_code', 'staff_state_code', 'staff_district_code', 'staff_council', 'staff_abdm_role']
      .forEach((id) => expect(staffLinkIds).toContain(id));
  });
});

describe('getFieldSet', () => {
  it('returns the right field set for "hospital" and "staff"', () => {
    expect(getFieldSet('hospital')).toBe(HOSPITAL_FIELDS);
    expect(getFieldSet('staff')).toBe(STAFF_FIELDS);
  });

  it('throws on an unknown kind rather than silently returning nothing', () => {
    expect(() => getFieldSet('nonsense')).toThrow(/Unknown ABDM field set/);
  });
});

describe('groupFieldsBySection', () => {
  it('groups every field under its declared section, preserving first-seen section order and every field', () => {
    const groups = groupFieldsBySection(STAFF_FIELDS);
    expect(groups.map((g) => g.section)).toEqual(['About You', 'Your Practice', 'Registration Details']);
    const regroupedIds = groups.flatMap((g) => g.fields.map((f) => f.linkId));
    expect(regroupedIds.sort()).toEqual(STAFF_FIELDS.map((f) => f.linkId).sort());
  });

  it('falls back to a "Details" section for a field with none declared', () => {
    const groups = groupFieldsBySection([{ linkId: 'x', label: 'X', type: 'text' }]);
    expect(groups).toEqual([{ section: 'Details', fields: [{ linkId: 'x', label: 'X', type: 'text' }] }]);
  });
});
