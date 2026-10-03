// What the three clinic journeys share: opening a visit (encounter) and showing a closed one.
//
// A visit is one Encounter composition record; each journey works on it a section at a time
// (form steps: `form: { formId, group, record }`, merged back with mergeSection). Once the visit
// is closed at Checkout it is complete and read-only: every clinic journey opens it as a view.
import { isClosed, mergeSection, sectionsOf, answer } from './encounterRecord.js';

/** The journey's input visit: { encounterId } (a new check-in's id is chosen up front by the page). */
export function openVisit(s, d) {
  const id = s.data.encounterId;
  if (!id) return { data: { missing: true } };
  const record = d.clinic.encounter(id);
  return {
    data: {
      encounterId: id,
      hasEncounter: !!record,
      closed: !!record && isClosed(record),
      patientName: record ? answer(record, 'encounter_patient_ref') : '',
      chiefComplaint: record ? answer(record, 'encounter_chief_complaint') : '',
    },
  };
}

/** Takes the visit's worklist lock for a stage; someone else holding it stops the journey. */
export async function lockVisit(s, d, stage) {
  const lock = await d.clinic.acquireLock(s.data.encounterId, stage);
  if (lock?.lockedBy) return { data: { lockedBy: lock.lockedBy } };
  // Couldn't reach the server: carry on locally (the visit is on this device) and say so.
  return { data: { lockedBy: null, lockWarning: lock?.success ? '' : 'Couldn’t reach ClinuxFlow to check whether someone else is working on this visit.' } };
}

/** A closed visit, read-only: its record section by section. */
export function closedView(s, d) {
  const record = d.clinic.encounter(s.data.encounterId);
  return {
    result: {
      ok: true,
      readonly: true,
      title: `${s.data.patientName || 'This visit'} — closed`,
      text: 'This visit is complete. Its record is read-only.',
      sections: sectionsOf(d.clinic.questionnaire(d.clinic.ENCOUNTER_FORM_ID), record),
    },
  };
}

export const missingResult = () => ({ result: { ok: false, title: 'No visit chosen', text: 'Open this from Clinic operations, where the visits are listed.' } });
export const lockedResult = (s) => ({ result: { ok: false, title: 'Being worked on', text: `${s.data.lockedBy} is working on this visit right now. Try again shortly.` } });

/** A form step's prompt for one section of the visit's record. */
export function sectionPrompt(s, d, group, text, extra = {}) {
  const record = s.data.draft?.group === group ? s.data.draft.record : d.clinic.encounter(s.data.encounterId) || s.data.seed || null;
  return {
    text,
    ...(s.data.lockWarning ? { warning: s.data.lockWarning } : {}),
    form: { formId: d.clinic.ENCOUNTER_FORM_ID, group, record, title: groupTitle(d, group) },
    ...extra,
  };
}

export function groupTitle(d, group) {
  return d.clinic.questionnaire(d.clinic.ENCOUNTER_FORM_ID)?.item?.find((i) => i.linkId === group)?.text || group;
}

/** Saves one section (as extracted) into the visit's record, creating the record if new. */
export function saveSection(s, d, group, extracted) {
  const q = d.clinic.questionnaire(d.clinic.ENCOUNTER_FORM_ID);
  const def = q?.item?.find((i) => i.linkId === group);
  if (!def) throw new Error('The encounter form isn’t available — clinuxflow-api may not be reachable.');
  const base = d.clinic.encounter(s.data.encounterId)?.data || s.data.seed?.data || { resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [] };
  const data = mergeSection(base, def, extracted);
  d.clinic.saveEncounter(s.data.encounterId, data);
  return data;
}
