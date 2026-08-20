import { toRaw } from 'vue';
import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinixflow's cf_form_data localStorage key. That key held a QuestionnaireResponse
// store nested by formId ({ [formId]: [...] }); this is the flat-collection equivalent — one
// row per record, each carrying its own `formId` so callers filter with a live query instead
// of looking up a nested array. Holds every filled-out form record used by Front Desk +
// Consultation Desk: patients, encounters, vitals, triage, SOAP notes, care-team lookups, etc.
export const formData = createLocalCollection('cf_form_data_v2');

// Real server-side auth (accounts + clinics in D1, see auth.js) was added on top of this
// originally single-tenant, local-first collection without ever threading clinicId through it —
// listDataRecords()/saveDataRecord() had no concept of "whose" a record was, so on any browser
// where more than one clinic has ever been registered, EVERY consumer (getProviderRecord(),
// patient search, encounter lookups, ...) just saw whichever record happened to be first/most
// recent across ALL clinics, not the current one. auth.js persists the logged-in account
// (including clinicId) as plain JSON at USER_KEY — reading it directly here (rather than
// importing useAuthStore()) avoids this plain data-layer module depending on Pinia being active,
// matching the same "read localStorage directly" pattern several pages already use for
// cf_clinic_profile.
const USER_KEY = 'cf_user';
function currentClinicId() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null')?.clinicId || null;
  } catch (e) {
    return null;
  }
}

// Scoped to the CURRENT clinicId — a record from a different clinic (or one saved before this
// scoping existed, so it has no clinicId at all) never matches, even if its formId is right.
export function listDataRecords(formId) {
  const clinicId = currentClinicId();
  return formData
    .toArray
    .filter((r) => r.formId === formId && r.clinicId === clinicId)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// Upserts one record. Pass existingRecordId to update in place; omit to always insert a new one.
export function saveDataRecord(formId, version, questionnaireResponse, existingRecordId) {
  const id = existingRecordId || 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const record = { id, formId, version, clinicId: currentClinicId(), data: questionnaireResponse, savedAt: new Date().toISOString() };

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

// Persisting equivalent of withGroupFields, but scoped to ONE instance of a REPEATING group.
// Repeating instances have no id of their own (getGroupInstances returns plain sibling items
// sharing groupLinkId, addressed only by their position) — instanceIndex is the only way to
// target "this one instance" instead of every instance sharing that linkId. Needed once a
// formerly-separate-record entity (e.g. one Staff member, before the Provider-composition merge)
// becomes a repeating group inside one shared record: patchRecordField's own global walk would
// otherwise write the same value onto every repeating instance indiscriminately (e.g. every staff
// member's HPR ID, not just the one that was just registered).
export function patchGroupInstanceField(recordId, groupLinkId, instanceIndex, fieldValues) {
  if (!formData.has(recordId)) return;
  formData.update(recordId, (draft) => {
    const instances = (draft.data.item || []).filter((item) => item.linkId === groupLinkId);
    const instance = instances[instanceIndex];
    if (!instance) return;
    instance.item = instance.item || [];
    Object.entries(fieldValues).forEach(([linkId, value]) => {
      let field = instance.item.find((item) => item.linkId === linkId);
      if (!field) {
        field = { linkId };
        instance.item.push(field);
      }
      field.answer = [{ valueString: value }];
    });
  });
}

// Appends a brand-new repeating-group instance (e.g. one new Staff member) built from a flat
// { linkId: value } map — the create counterpart to patchGroupInstanceField's edit-in-place.
// SPEC-09's controlled-input registration forms use this instead of LForms extraction: no
// silent-discard risk (see clinux-lforms-coded-field-data-loss-bug memory note), since there's
// no "click a dropdown to confirm" step for a plain v-model value to fall through. Requires the
// record to already exist (same convention as patchGroupInstanceField) — callers create it via
// saveDataRecord() first if needed. Returns the new instance's index within that group, or -1 if
// the record doesn't exist.
export function appendGroupInstance(recordId, groupLinkId, fieldValues) {
  if (!formData.has(recordId)) return -1;
  let newIndex = -1;
  formData.update(recordId, (draft) => {
    draft.data.item = draft.data.item || [];
    const existingCount = draft.data.item.filter((item) => item.linkId === groupLinkId).length;
    newIndex = existingCount;
    draft.data.item.push({
      linkId: groupLinkId,
      item: Object.entries(fieldValues)
        .filter(([, value]) => value !== '' && value !== null && value !== undefined)
        .map(([linkId, value]) => ({ linkId, answer: [{ valueString: String(value) }] })),
    });
  });
  return newIndex;
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

// Bare-item-array version of recordSummary's walk — needed because getGroupInstances() below
// returns bare { linkId, item } group instances, not full { id, data: { item } } records, so
// recordSummary(record) can't be called directly on one of them.
export function summarizeItems(items, recordFallbackId) {
  const values = [];
  const walk = (items) => {
    (items || []).forEach((item) => {
      if (item.item) walk(item.item);
      else if (Array.isArray(item.answer) && item.answer.length > 0) {
        // A MultiSelect field (e.g. Office Hours' "Days of Week") produces multiple entries in
        // answer[], not just answer[0] — joining all of them (not just the first) is what fixes
        // a repeatable Office Hours record silently summarizing as just "mon" when mon–fri were
        // actually all selected and saved correctly.
        const joined = item.answer.map(extractAnswerValue).filter((v) => v !== '').join(', ');
        if (joined) values.push(joined);
      }
    });
  };
  walk(items);
  const summary = values.filter((v) => v !== '').slice(0, 3).join(' · ');
  return summary || recordFallbackId || '';
}

export function recordSummary(record) {
  return summarizeItems(record.data.item, record.id);
}

// Every top-level item in record.data.item sharing groupLinkId — one instance for a singular
// group (Encounter/SOAP/Billing), N sibling instances for a repeats:true group (Vitals/
// Prescription). FHIR QuestionnaireResponse represents a repeating GROUP's repetitions this way
// (multiple sibling items with the same linkId, each with its own nested item[]) — distinct from
// a repeating simple field, which instead gets multiple entries in one item's answer[].
export function getGroupInstances(record, groupLinkId) {
  if (!record) return [];
  return (record.data.item || []).filter((item) => item.linkId === groupLinkId);
}

// Pure (non-persisting, unlike patchRecordField) — returns a NEW recordData object with the
// FIRST instance of groupLinkId patched (or created, if absent) from a { linkId: value } map.
// Targets singular groups only (Encounter/SOAP/Billing) — deliberately not used for repeating
// groups, since patchRecordField-style "write to every matching linkId" would hit every
// repetition rather than the one instance you meant. Returning a new object (not mutating
// recordData in place) matters because LhcFormHost's watch() only re-renders on a new object
// reference, not on in-place mutation of the same one.
export function withGroupFields(recordData, groupLinkId, fieldValues) {
  // toRaw() first — real bug found live: a caller reading its record through a reactive source
  // (clinical.js's getEncounter(), backed by useLiveQuery -- see formSlotEngine.js's applyFills())
  // hands this a Vue-reactive Proxy, not a plain object. structuredClone() cannot clone a Proxy
  // at all -- it throws DataCloneError, uncaught, which killed Cübo's whole slot-fill dispatch
  // mid-flight (this runs before the code that stops the "Thinking/Planning/Doing/Verifying"
  // progress indicator, so it got stuck showing that forever instead of ever reaching "Filled N
  // field(s)"). toRaw() is a no-op on an already-plain object, so every other existing caller of
  // this function is unaffected either way.
  const cloned = structuredClone(toRaw(recordData) || { item: [] });
  cloned.item = cloned.item || [];
  let group = cloned.item.find((item) => item.linkId === groupLinkId);
  if (!group) {
    group = { linkId: groupLinkId, item: [] };
    cloned.item.push(group);
  }
  group.item = group.item || [];

  Object.entries(fieldValues).forEach(([linkId, value]) => {
    let field = group.item.find((item) => item.linkId === linkId);
    if (!field) {
      field = { linkId };
      group.item.push(field);
    }
    field.answer = [{ valueString: value }];
  });

  return cloned;
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
