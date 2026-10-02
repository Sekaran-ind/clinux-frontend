import { describe, expect, it } from 'vitest';
import {
  UI_INPUT_URL, UI_SECTION_REF_URL, UI_SECTION_URL, fieldsBySection, fieldsOf, groupItemFromValues, isEnabled,
  missingRequired, sectionsOf, summarise, valuesFromGroupItem, widgetOf,
} from './questionnaireForm.js';

const section = (id, label, icon) => ({ url: UI_SECTION_URL, extension: [{ url: 'id', valueString: id }, { url: 'label', valueString: label }, ...(icon ? [{ url: 'icon', valueString: icon }] : [])] });
const ref = (id) => ({ url: UI_SECTION_REF_URL, valueString: id });

// The shape clinuxflow-api compiles section_hospital into (trimmed).
const hospital = {
  linkId: 'section_hospital', type: 'group', text: 'Hospital Details',
  extension: [section('basics', 'Basics', 'fa-hospital'), section('contact', 'Contact', 'fa-phone')],
  item: [
    { linkId: 'hospital_name', type: 'string', text: 'Hospital Name', required: true, extension: [ref('basics')] },
    { linkId: 'hospital_operational_status', type: 'boolean', text: 'Currently Operational', extension: [ref('basics')] },
    { linkId: 'hospital_type', type: 'choice', text: 'Facility Category', answerOption: [{ valueString: 'Hospital' }, { valueString: 'Clinic' }], extension: [ref('basics')] },
    { linkId: 'hospital_email', type: 'string', text: 'Email', extension: [ref('contact'), { url: UI_INPUT_URL, valueCode: 'email' }] },
    { linkId: 'hospital_beds', type: 'integer', text: 'Beds' },
  ],
};

describe('reading a compiled Questionnaire group', () => {
  it('reads sections and fields from the Questionnaire, not from code', () => {
    expect(sectionsOf(hospital)).toEqual([{ id: 'basics', label: 'Basics', icon: 'fa-hospital' }, { id: 'contact', label: 'Contact', icon: 'fa-phone' }]);
    const f = fieldsOf(hospital);
    expect(f.map((x) => [x.linkId, x.widget, x.section, x.required])).toEqual([
      ['hospital_name', 'text', 'basics', true],
      ['hospital_operational_status', 'checkbox', 'basics', false],
      ['hospital_type', 'select', 'basics', false],
      ['hospital_email', 'email', 'contact', false],
      ['hospital_beds', 'number', null, false],
    ]);
    expect(f[2].options).toEqual([{ value: 'Hospital', label: 'Hospital' }, { value: 'Clinic', label: 'Clinic' }]);
  });

  it('picks widgets from type, SDC itemControl and ui-input', () => {
    expect(widgetOf({ type: 'choice', repeats: true })).toBe('multiselect');
    expect(widgetOf({ type: 'choice', extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl', valueCodeableConcept: { coding: [{ code: 'radio-button' }] } }] })).toBe('radio');
    expect(widgetOf({ type: 'string', extension: [{ url: UI_INPUT_URL, valueCode: 'time' }] })).toBe('time');
    expect(widgetOf({ type: 'text' })).toBe('textarea');
  });

  it('puts unsectioned fields in the first section', () => {
    const by = fieldsBySection(sectionsOf(hospital), fieldsOf(hospital));
    expect(by.map((s) => [s.id, s.fields.map((f) => f.linkId)])).toEqual([
      ['basics', ['hospital_name', 'hospital_operational_status', 'hospital_type', 'hospital_beds']],
      ['contact', ['hospital_email']],
    ]);
    expect(fieldsBySection([], fieldsOf(hospital))[0].fields).toHaveLength(5);
  });
});

describe('answers', () => {
  const fields = fieldsOf(hospital);

  it('round-trips with the value keys the Hosts used', () => {
    const values = { hospital_name: 'Asha Clinic', hospital_operational_status: true, hospital_type: 'Clinic', hospital_email: '', hospital_beds: '12' };
    const item = groupItemFromValues('section_hospital', fields, values);
    expect(item).toEqual({
      linkId: 'section_hospital',
      item: [
        { linkId: 'hospital_name', answer: [{ valueString: 'Asha Clinic' }] },
        { linkId: 'hospital_operational_status', answer: [{ valueBoolean: true }] },
        { linkId: 'hospital_type', answer: [{ valueString: 'Clinic' }] },
        { linkId: 'hospital_beds', answer: [{ valueInteger: 12 }] },
      ],
    });
    expect(valuesFromGroupItem(fields, item)).toMatchObject({ hospital_name: 'Asha Clinic', hospital_operational_status: true, hospital_type: 'Clinic', hospital_email: '', hospital_beds: 12 });
  });

  it('repeating choices become several answers', () => {
    const days = fieldsOf({ item: [{ linkId: 'hours_days', type: 'choice', repeats: true, answerOption: [{ valueString: 'mon' }, { valueString: 'tue' }] }] });
    const item = groupItemFromValues('section_hours', days, { hours_days: ['mon', 'tue'] });
    expect(item.item[0].answer).toEqual([{ valueString: 'mon' }, { valueString: 'tue' }]);
    expect(valuesFromGroupItem(days, item).hours_days).toEqual(['mon', 'tue']);
    expect(summarise(days, { hours_days: ['mon', 'tue'] })).toBe('mon, tue');
  });

  it('enforces required fields', () => {
    expect(missingRequired(fields, { hospital_name: '' })).toEqual(['hospital_name']);
    expect(missingRequired(fields, { hospital_name: 'x' })).toEqual([]);
  });

  it('applies enableWhen (= and exists) and leaves disabled answers out', () => {
    const f = fieldsOf({ item: [
      { linkId: 'allday', type: 'boolean' },
      { linkId: 'open', type: 'string', enableWhen: [{ question: 'allday', operator: '=', answerBoolean: false }] },
      { linkId: 'note', type: 'string', enableWhen: [{ question: 'open', operator: 'exists', answerBoolean: true }] },
    ] });
    expect(isEnabled(f[1], { allday: false })).toBe(true);
    expect(isEnabled(f[1], { allday: true })).toBe(false);
    expect(isEnabled(f[2], { open: '' })).toBe(false);
    expect(groupItemFromValues('g', f, { allday: true, open: '09:00' }).item.map((i) => i.linkId)).toEqual(['allday']);
  });
});

describe('cross-group references (refTo)', () => {
  it('offers the referenced group’s saved instances, valued by index', async () => {
    const { refOptions } = await import('./questionnaireForm.js');
    const q = { item: [
      { linkId: 'section_location', type: 'group', repeats: true, item: [{ linkId: 'location_name', type: 'string', definition: 'http://hl7.org/Location#Location.name' }] },
      { linkId: 'section_services_matrix', type: 'group', repeats: true, item: [{ linkId: 'service_location_id', type: 'string', refTo: 'Location' }] },
    ] };
    const saved = { section_location: [{ item: [{ linkId: 'location_name', answer: [{ valueString: 'Main branch' }] }] }, { item: [] }] };
    expect(refOptions(q, (id) => saved[id] || [], 'Location')).toEqual([{ value: '0', label: 'Main branch' }, { value: '1', label: 'Location 2' }]);
    expect(refOptions(q, () => [], 'Organization')).toEqual([]);
  });
});
