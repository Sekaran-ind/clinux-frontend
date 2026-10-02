// The logic behind QuestionnaireForm.vue — the one generic renderer that replaces the hand-written
// Host components (FacilityBasicsHost, HoursHost, ...). Everything a Host used to hard-code
// (FIELDS, SECTIONS, kinds, choices, required) is read from the compiled FHIR Questionnaire
// instead, so a form changes by editing its YAML in clinuxflow-api, not a Vue file.
//
//   - fields: item.type / required / repeats / answerOption / enableWhen (standard FHIR)
//   - sections: the group's ui-section extensions; a field's ui-section-ref
//   - widgets: SDC questionnaire-itemControl, or ClinuxFlow's ui-input (email/tel/url/time/textarea)
//
// Answers are written with the same value keys the Hosts wrote (valueBoolean / valueDate /
// valueDecimal / valueInteger, valueString for everything else), so existing records read back
// unchanged and the extractor sees the same QuestionnaireResponse shape.

export const UI_SECTION_URL = 'https://clinux.yaxb.ai/fhir/StructureDefinition/ui-section';
export const UI_SECTION_REF_URL = 'https://clinux.yaxb.ai/fhir/StructureDefinition/ui-section-ref';
export const UI_INPUT_URL = 'https://clinux.yaxb.ai/fhir/StructureDefinition/ui-input';
const ITEM_CONTROL_URL = 'http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl';

const ext = (item, url) => (item.extension || []).find((e) => e.url === url);
const sub = (e, url) => (e.extension || []).find((x) => x.url === url)?.valueString;

/** The group's sections, in order — [] when it declares none (render as one block). */
export function sectionsOf(group) {
  return (group.extension || [])
    .filter((e) => e.url === UI_SECTION_URL)
    .map((e) => ({ id: sub(e, 'id'), label: sub(e, 'label') || sub(e, 'id'), icon: sub(e, 'icon') }));
}

function optionsOf(item) {
  return (item.answerOption || []).map((o) => {
    if (o.valueCoding) return { value: o.valueCoding.code, label: o.valueCoding.display || o.valueCoding.code };
    const v = o.valueString ?? o.valueInteger ?? o.valueDate;
    return { value: String(v), label: String(v) };
  });
}

/**
 * Choices for a cross-group reference field (`refTo: "Location"` in the YAML — e.g. which branch a
 * service belongs to): the saved instances of the repeating group whose items map to that
 * resource (read from their `definition`), valued by instance index — the reference value
 * clinuxflow-api's extractor resolves — and labelled by each instance's first text answer.
 */
export function refOptions(questionnaire, instancesOf, refTo) {
  const group = (questionnaire?.item || []).find((g) => g.type === 'group' && g.repeats
    && (g.item || []).some((i) => String(i.definition || '').includes(`#${refTo}.`)));
  if (!group) return [];
  const textIds = (group.item || []).filter((i) => i.type === 'string').map((i) => i.linkId);
  return instancesOf(group.linkId).map((inst, index) => {
    const first = textIds.map((id) => (inst.item || []).find((a) => a.linkId === id)?.answer?.[0]?.valueString).find(Boolean);
    return { value: String(index), label: first || `${refTo} ${index + 1}` };
  });
}

/** How a field renders: checkbox, number, date, select, multiselect, textarea, or an <input type>. */
export function widgetOf(item) {
  const input = ext(item, UI_INPUT_URL)?.valueCode;
  const control = ext(item, ITEM_CONTROL_URL)?.valueCodeableConcept?.coding?.[0]?.code;
  if (item.refTo) return 'select';
  if (item.type === 'boolean') return 'checkbox';
  if (item.type === 'decimal' || item.type === 'integer') return 'number';
  if (item.type === 'date' || input === 'date') return 'date';
  if (item.type === 'choice' || item.type === 'open-choice') {
    if (control === 'radio-button' && !item.repeats) return 'radio';
    return item.repeats ? 'multiselect' : 'select';
  }
  if (item.type === 'text' || input === 'textarea') return 'textarea';
  return input || 'text'; // email | tel | url | time | text
}

/** The leaf fields of a group (nested groups are flattened only one level — the compiled forms nest no deeper here). */
export function fieldsOf(group) {
  return (group.item || [])
    .filter((i) => i.type !== 'group' && i.type !== 'display')
    .map((i) => ({
      linkId: i.linkId,
      label: i.text || i.linkId,
      type: i.type,
      required: !!i.required,
      repeats: !!i.repeats,
      options: optionsOf(i),
      widget: widgetOf(i),
      section: ext(i, UI_SECTION_REF_URL)?.valueString || null,
      enableWhen: i.enableWhen || null,
      refTo: i.refTo || null,
      hidden: (i.extension || []).some((e) => e.valueBoolean === true && e.url === 'http://hl7.org'),
    }));
}

export function blankValue(field) {
  if (field.widget === 'checkbox') return false;
  if (field.widget === 'multiselect') return [];
  return '';
}

export const blankValues = (fields) => Object.fromEntries(fields.map((f) => [f.linkId, blankValue(f)]));

const answerValue = (a) => (a ? a.valueString ?? a.valueBoolean ?? a.valueDate ?? a.valueDecimal ?? a.valueInteger ?? a.valueCoding?.code ?? a.valueTime : undefined);

/** One group instance (a QuestionnaireResponse item) -> { linkId: value } for these fields. */
export function valuesFromGroupItem(fields, groupItem) {
  const out = blankValues(fields);
  for (const f of fields) {
    const answered = (groupItem?.item || []).find((i) => i.linkId === f.linkId);
    if (!answered?.answer?.length) continue;
    out[f.linkId] = f.widget === 'multiselect' ? answered.answer.map(answerValue).map(String) : answerValue(answered.answer[0]);
  }
  return out;
}

function valueKey(field) {
  if (field.type === 'boolean') return 'valueBoolean';
  if (field.type === 'date') return 'valueDate';
  if (field.type === 'decimal') return 'valueDecimal';
  if (field.type === 'integer') return 'valueInteger';
  return 'valueString';
}

const isBlank = (v) => v === '' || v === null || v === undefined || v === false || (Array.isArray(v) && !v.length);

/** { linkId: value } -> a QuestionnaireResponse group item; blank and disabled fields are left out. */
export function groupItemFromValues(groupLinkId, fields, values) {
  const item = fields
    .filter((f) => !isBlank(values[f.linkId]) && isEnabled(f, values))
    .map((f) => {
      const key = valueKey(f);
      const vals = Array.isArray(values[f.linkId]) ? values[f.linkId] : [values[f.linkId]];
      const cast = (v) => (key === 'valueDecimal' || key === 'valueInteger' ? Number(v) : v);
      return { linkId: f.linkId, answer: vals.map((v) => ({ [key]: cast(v) })) };
    });
  return { linkId: groupLinkId, item };
}

/** FHIR enableWhen, for the operators the compiler emits (= and exists), across this group's own answers. */
export function isEnabled(field, values) {
  if (!field.enableWhen?.length) return true;
  return field.enableWhen.every((w) => {
    const v = values[w.question];
    if (w.operator === 'exists') return (w.answerBoolean ?? true) === !isBlank(v);
    const expected = w.answerString ?? w.answerBoolean ?? w.answerCoding?.code ?? w.answerInteger ?? w.answerDecimal;
    return Array.isArray(v) ? v.map(String).includes(String(expected)) : String(v) === String(expected);
  });
}

/** Required fields (that are shown) still empty -> [linkId]. */
export function missingRequired(fields, values) {
  return fields.filter((f) => f.required && isEnabled(f, values) && !f.hidden && isBlank(values[f.linkId])).map((f) => f.linkId);
}

/** Fields grouped by section, in section order; unsectioned fields go to the first section (or a single default). */
export function fieldsBySection(sections, fields) {
  if (!sections.length) return [{ id: 'all', label: '', fields: fields.filter((f) => !f.hidden) }];
  const known = new Set(sections.map((s) => s.id));
  return sections.map((s, i) => ({
    ...s,
    fields: fields.filter((f) => !f.hidden && (f.section === s.id || (i === 0 && (!f.section || !known.has(f.section))))),
  }));
}

/** A one-line summary of a repeating-group instance, for its row in the list. */
export function summarise(fields, values) {
  return fields
    .filter((f) => !isBlank(values[f.linkId]) && f.widget !== 'checkbox')
    .slice(0, 3)
    .map((f) => {
      const v = values[f.linkId];
      const label = (x) => f.options.find((o) => o.value === String(x))?.label ?? x;
      return Array.isArray(v) ? v.map(label).join(', ') : label(v);
    })
    .join(' · ') || 'Entry';
}
