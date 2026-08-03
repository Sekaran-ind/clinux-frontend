import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinixflow's cf_form_data localStorage key. That key held a QuestionnaireResponse
// store nested by formId ({ [formId]: [...] }); this is the flat-collection equivalent — one
// row per record, each carrying its own `formId` so callers filter with a live query instead
// of looking up a nested array. Holds every filled-out form record used by Front Desk +
// Consultation Desk: patients, encounters, vitals, triage, SOAP notes, care-team lookups, etc.
export const formData = createLocalCollection('cf_form_data_v2');

export function listDataRecords(formId) {
  return formData
    .toArray
    .filter((r) => r.formId === formId)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// Upserts one record. Pass existingRecordId to update in place; omit to always insert a new one.
export function saveDataRecord(formId, version, questionnaireResponse, existingRecordId) {
  const id = existingRecordId || 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const record = { id, formId, version, data: questionnaireResponse, savedAt: new Date().toISOString() };

  if (formData.has(id)) {
    formData.update(id, (draft) => Object.assign(draft, record));
  } else {
    formData.insert(record);
  }
  return id;
}

export function deleteDataRecord(recordId) {
  if (formData.has(recordId)) formData.delete(recordId);
}

// Directly patches one already-saved record's QuestionnaireResponse item array in place —
// the TanStack DB equivalent of consultation-desk.html's savePriority()-style direct field
// writes (e.g. writing a lab result back onto an existing encounter without re-running the
// whole LHC-Forms extract/save round-trip).
export function patchRecordField(recordId, linkId, value) {
  if (!formData.has(recordId)) return;
  formData.update(recordId, (draft) => {
    const walk = (items) => {
      (items || []).forEach((item) => {
        if (item.linkId === linkId) {
          item.answer = [{ valueString: value }];
        }
        if (item.item) walk(item.item);
      });
    };
    walk(draft.data.item);
  });
}

// LForms represents any choice/coded answer as valueCoding even when the Questionnaire's
// answerOption was authored as plain valueString choices — reading only valueString/etc.
// without this fallback silently returns '' for every Dropdown/MultiSelect answer. Ported
// verbatim from clinixflow's public/js/system-forms.js.
function extractAnswerValue(a) {
  if (!a) return '';
  return a.valueString ?? a.valueDecimal ?? a.valueInteger ?? a.valueBoolean ?? a.valueDate
    ?? (a.valueCoding && (a.valueCoding.display ?? a.valueCoding.code)) ?? '';
}

export function recordSummary(record) {
  const values = [];
  const walk = (items) => {
    (items || []).forEach((item) => {
      if (item.item) walk(item.item);
      else if (item.answer && item.answer[0]) values.push(extractAnswerValue(item.answer[0]));
    });
  };
  walk(record.data.item);
  const summary = values.filter((v) => v !== '').slice(0, 3).join(' · ');
  return summary || record.id;
}

export function getAnswer(record, linkId) {
  if (!record) return '';
  let found = '';
  const walk = (items) => {
    (items || []).forEach((item) => {
      if (item.linkId === linkId && item.answer && item.answer[0]) {
        found = extractAnswerValue(item.answer[0]);
      }
      if (item.item) walk(item.item);
    });
  };
  walk(record.data.item);
  return found;
}

export function getAnswers(record, linkId) {
  const out = [];
  if (!record) return out;
  const walk = (items) => {
    (items || []).forEach((item) => {
      if (item.linkId === linkId && Array.isArray(item.answer)) {
        item.answer.forEach((a) => out.push(extractAnswerValue(a)));
      }
      if (item.item) walk(item.item);
    });
  };
  walk(record.data.item);
  return out;
}
