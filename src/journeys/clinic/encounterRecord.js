// Pure helpers for the clinic-operations journeys (Front Desk, Consultation, Checkout), which
// step through one Encounter composition record a section at a time (section_encounter,
// section_vitals, section_soap, section_prescription, section_billing — clinuxflow-api's
// system-encounter-composition-v1.yaml).

export const CLOSED_STATUSES = ['finished', 'cancelled'];

const answerOf = (a) => {
  if (!a) return '';
  if (a.valueCoding) return a.valueCoding.display || a.valueCoding.code || '';
  for (const k of ['valueString', 'valueInteger', 'valueDecimal', 'valueDate', 'valueDateTime', 'valueTime', 'valueBoolean']) {
    if (a[k] !== undefined && a[k] !== null) return k === 'valueBoolean' ? (a[k] ? 'Yes' : 'No') : String(a[k]);
  }
  if (a.valueQuantity) return `${a.valueQuantity.value}${a.valueQuantity.unit ? ` ${a.valueQuantity.unit}` : ''}`;
  return '';
};

/** First answer of linkId anywhere in a record ({ data: QuestionnaireResponse }). */
export function answer(record, linkId) {
  let found = '';
  const walk = (items) => (items || []).forEach((i) => {
    if (!found && i.linkId === linkId && i.answer?.[0]) found = answerOf(i.answer[0]);
    if (i.item) walk(i.item);
  });
  walk(record?.data?.item);
  return found;
}

export const isClosed = (record) => CLOSED_STATUSES.includes(String(answer(record, 'encounter_status')).toLowerCase());

const linkIdsOf = (item, out = new Set()) => {
  for (const c of item?.item || []) {
    out.add(c.linkId);
    linkIdsOf(c, out);
  }
  return out;
};

/**
 * Puts one section, as extracted from a form showing only that section, back into the record's
 * QuestionnaireResponse. A repeating section (vitals readings, medications, payments) replaces
 * all its instances. A single section keeps answers the form doesn't show — the visit's stage
 * flags (encounter_stage_*) live in section_encounter without being form fields, and extracting
 * the form must not erase them.
 */
export function mergeSection(recordData, group, extracted) {
  const data = structuredClone(recordData || { resourceType: 'QuestionnaireResponse', item: [] });
  data.item = data.item || [];
  const incoming = (extracted?.item || []).filter((i) => i.linkId === group.linkId);
  if (group.repeats) {
    const at = data.item.findIndex((i) => i.linkId === group.linkId);
    const rest = data.item.filter((i) => i.linkId !== group.linkId);
    rest.splice(at < 0 ? rest.length : at, 0, ...incoming);
    data.item = rest;
    return data;
  }
  const next = incoming[0] || { linkId: group.linkId, item: [] };
  const shown = linkIdsOf(group);
  const at = data.item.findIndex((i) => i.linkId === group.linkId);
  const kept = at >= 0 ? (data.item[at].item || []).filter((c) => !shown.has(c.linkId)) : [];
  const merged = { ...next, item: [...(next.item || []), ...kept] };
  if (at >= 0) data.item[at] = merged;
  else data.item.push(merged);
  return data;
}

/**
 * A record laid out for reading: one section per top-level group, a row per answered field
 * (repeating groups numbered). Used for the read-only view of a completed (closed) visit.
 */
export function sectionsOf(questionnaire, record) {
  const texts = new Map();
  const index = (items) => (items || []).forEach((i) => { texts.set(i.linkId, i.text || i.linkId); index(i.item); });
  index(questionnaire?.item);
  const rowsOf = (items, prefix = '') => {
    const rows = [];
    for (const i of items || []) {
      const v = (i.answer || []).map(answerOf).filter(Boolean).join(', ');
      if (v && texts.has(i.linkId)) rows.push([`${prefix}${texts.get(i.linkId)}`, v]);
      if (i.item) rows.push(...rowsOf(i.item, prefix));
    }
    return rows;
  };
  const sections = [];
  for (const g of questionnaire?.item || []) {
    const instances = (record?.data?.item || []).filter((i) => i.linkId === g.linkId);
    const rows = instances.length > 1
      ? instances.flatMap((inst, n) => rowsOf(inst.item, `#${n + 1} · `))
      : rowsOf(instances[0]?.item);
    if (rows.length) sections.push({ title: g.text || g.linkId, rows });
  }
  return sections;
}
