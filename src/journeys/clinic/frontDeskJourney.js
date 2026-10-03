// Front Desk check-in as a journey — steps and transitions in specs/front-desk.journey.json, run
// on XState (engine.js) inside Cübo like the registry journeys. Same records and calls as
// pages/FrontDesk.vue; deps.clinic (clinicDeps.js) is the clinic's data and coordination.
import spec from '../specs/front-desk.journey.json' with { type: 'json' };
import { closedView, lockVisit, lockedResult, missingResult, openVisit, saveSection, sectionPrompt } from './visit.js';

const NEW_PATIENT = '__new';

/** A new visit's starting record: just who it's for. */
const seedFor = (patientName) => ({ data: { resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [{ linkId: 'section_encounter', item: [{ linkId: 'encounter_patient_ref', answer: [{ valueString: patientName }] }] }] } });

export const frontDeskJourney = {
  spec,
  id: spec.id,
  title: spec.title,
  summary: spec.summary,
  icon: spec.icon,
  category: spec.category,

  prompts: {
    patient: (s, d) => ({
      text: 'Who is the visit for?',
      fields: [{ name: 'patientId', label: 'Patient', type: 'select', required: true, value: s.data.patientId || '', options: [{ value: NEW_PATIENT, label: '+ Register a new patient' }, ...d.clinic.patients()] }],
      submitLabel: 'Continue',
    }),
    newPatient: (s, d) => ({ text: 'Register the patient.', form: { formId: d.clinic.PATIENT_FORM_ID, record: null, title: 'patient registration' }, submitLabel: 'Register patient' }),
    encounter: (s, d) => sectionPrompt(s, d, 'section_encounter', `The visit for ${s.data.patientName || 'the patient'}: why they came, and how urgent it is.`),
    vitals: (s, d) => sectionPrompt(s, d, 'section_vitals', 'Vitals. Add another reading with the form’s “+” when you take more than one.', { submitLabel: 'Save vitals' }),
    routing: (s) => ({
      text: 'Route this visit to a specialist? Leave it unrouted and anyone can see the patient at Consultation.',
      ...(s.data.routedTo ? { detail: `Currently routed to ${s.data.routedTo}.` } : {}),
      ...(s.data.specialists.length ? {} : { warning: 'No colleagues or affiliates to route to (or ClinuxFlow couldn’t be reached).' }),
      fields: [{ name: 'specialistId', label: 'Specialist', type: 'select', value: '', options: [{ value: '', label: 'No routing' }, ...s.data.specialists] }],
      submitLabel: 'Continue',
    }),
    additional: (s, d) => ({
      text: 'Any additional forms for this visit?',
      ...(s.data.attached.length ? { list: s.data.attached } : { detail: 'None attached yet.' }),
      fields: [{ name: 'formId', label: 'Add a form', type: 'select', value: '', options: [{ value: '', label: 'No more forms' }, ...d.clinic.forms()] }],
      submitLabel: 'Continue',
    }),
    additionalForm: (s, d) => ({ text: `Fill in ${s.data.addFormTitle}.`, form: { formId: s.data.addFormId, record: null, title: s.data.addFormTitle }, submitLabel: 'Save and attach' }),
    handoff: (s) => ({
      text: `${s.data.patientName || 'The patient'} is checked in.`,
      choices: [
        { value: 'consult', label: 'Send to Consultation', detail: s.data.routedTo ? `Routed to ${s.data.routedTo}` : 'Anyone can pick it up' },
        { value: 'later', label: 'Keep it at Front Desk for now' },
      ],
    }),
  },

  actions: {
    begin: async (s, d) => {
      const visit = openVisit(s, d);
      if (visit.data.missing || visit.data.closed || !visit.data.hasEncounter) return visit;
      const lock = await lockVisit({ data: visit.data }, d, 'onboarding');
      return { data: { ...visit.data, ...lock.data } };
    },
    choosePatient: async (a, s, d) => {
      if (a.patientId === NEW_PATIENT) return { data: { newPatient: true } };
      const name = d.clinic.patientSummary(a.patientId);
      if (!name) throw new Error('That patient is no longer on this device.');
      return { data: { newPatient: false, patientId: a.patientId, patientName: name, seed: seedFor(name) } };
    },
    savePatient: async (a, s, d) => {
      const id = d.clinic.save(d.clinic.PATIENT_FORM_ID, a.qr);
      const name = d.clinic.patientSummary(id);
      return { data: { newPatient: false, patientId: id, patientName: name, seed: seedFor(name) } };
    },
    saveEncounter: async (a, s, d) => {
      saveSection(s, d, 'section_encounter', a.qr);
      return { data: { hasEncounter: true } };
    },
    saveVitals: async (a, s, d) => {
      saveSection(s, d, 'section_vitals', a.qr);
      return {};
    },
    loadRouting: async (s, d) => {
      const [specialists, current] = await Promise.all([d.clinic.specialists().catch(() => []), d.clinic.assignment(s.data.encounterId).catch(() => null)]);
      return { data: { specialists, routedTo: current?.name || '', attached: d.clinic.attachedForms(s.data.encounterId) } };
    },
    route: async (a, s, d) => {
      if (!a.specialistId) return {};
      const res = await d.clinic.assign(s.data.encounterId, a.specialistId);
      if (res?.error) throw new Error(res.error);
      const who = s.data.specialists.find((x) => x.value === a.specialistId)?.label || 'the specialist';
      d.clinic.log(s.data.encounterId, `Routed to ${who} at Front Desk.`);
      return { data: { routedTo: who } };
    },
    chooseAdditional: async (a, s, d) => {
      if (!a.formId) return { data: { addFormId: null } };
      const title = d.clinic.forms().find((f) => f.value === a.formId)?.label || a.formId;
      return { data: { addFormId: a.formId, addFormTitle: title } };
    },
    saveAdditional: async (a, s, d) => {
      const recordId = d.clinic.save(s.data.addFormId, a.qr);
      d.clinic.attachForm(s.data.encounterId, s.data.addFormId, recordId);
      return { data: { addFormId: null, attached: d.clinic.attachedForms(s.data.encounterId) } };
    },
    handOff: async (a, s, d) => {
      if (a.choice !== 'consult') return { data: { handedOff: false } };
      d.clinic.markStageComplete(s.data.encounterId, 'onboarding');
      await d.clinic.releaseLock(s.data.encounterId, 'onboarding');
      d.clinic.log(s.data.encounterId, 'Checked in at Front Desk; sent to Consultation.');
      return { data: { handedOff: true } };
    },
    result: async (s) => ({
      result: s.data.handedOff
        ? { ok: true, title: 'Sent to Consultation', text: `${s.data.patientName || 'The patient'} is ready to be seen.`, facts: [['Patient', s.data.patientName || '—'], ...(s.data.routedTo ? [['Routed to', s.data.routedTo]] : [])], next: { label: 'Open Consultation', to: `/clinic/consultation?encounter=${encodeURIComponent(s.data.encounterId)}` } }
        : { ok: true, title: 'Saved at Front Desk', text: 'The visit stays at Front Desk. Resume it from Clinic operations.', facts: [['Patient', s.data.patientName || '—']] },
    }),
    closedView: async (s, d) => closedView(s, d),
    lockedResult: async (s) => lockedResult(s),
    missingResult: async () => missingResult(),
  },
};
