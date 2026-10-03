// Consultation as a journey — steps in specs/consultation.journey.json. Same records and calls as
// pages/ConsultationDesk.vue: the SOAP section of the visit's Encounter record, the AI SOAP draft
// (/api/workflow/test-scribe, paid plan) from what was typed into this journey's Cübo thread, the
// prescription PDF, and documents attached to the visit. (Labs & imaging, care team and the video
// call stay on the Consultation Desk page for now.)
import spec from '../specs/consultation.journey.json' with { type: 'json' };
import { closedView, missingResult, openVisit, saveSection, sectionPrompt } from './visit.js';
import { answer } from './encounterRecord.js';

/** Sets field answers inside an extracted section ({ item: [{ linkId: group, item: [...] }] }). */
function withAnswers(extracted, group, values) {
  const qr = structuredClone(extracted || { item: [] });
  qr.item = qr.item || [];
  let g = qr.item.find((i) => i.linkId === group);
  if (!g) qr.item.push((g = { linkId: group, item: [] }));
  g.item = g.item || [];
  for (const [linkId, v] of Object.entries(values)) {
    if (!v) continue;
    const it = g.item.find((i) => i.linkId === linkId);
    if (it) it.answer = [{ valueString: v }];
    else g.item.push({ linkId, answer: [{ valueString: v }] });
  }
  return qr;
}

export const consultationJourney = {
  spec,
  id: spec.id,
  title: spec.title,
  summary: spec.summary,
  icon: spec.icon,
  category: spec.category,

  prompts: {
    notes: (s, d) => sectionPrompt(s, d, 'section_soap', `Consultation for ${s.data.patientName || 'the patient'}${s.data.chiefComplaint ? ` — ${s.data.chiefComplaint}` : ''}.`, {
      ...(s.data.notice ? { detail: s.data.notice } : { detail: 'Type the history into this thread as you go; “Draft with AI” turns it into SOAP notes for you to check.' }),
      actions: [
        { value: 'soap', label: 'Draft with AI', icon: 'fa-wand-magic-sparkles', detail: 'From what’s been typed into this thread (paid plan)' },
        { value: 'rx', label: 'Prescription PDF', icon: 'fa-prescription', detail: 'Saves the notes, then makes the prescription from Assessment and Plan' },
      ],
      submitLabel: 'Save notes and continue',
    }),
    documents: (s, d) => {
      const rx = d.clinic.prescriptionsOf(s.data.encounterId).map((r) => ({ name: 'Prescription', detail: new Date(r.createdAt).toLocaleString() }));
      const docs = [...rx, ...d.clinic.attachedForms(s.data.encounterId)];
      return {
        text: 'Documents for this visit.',
        ...(docs.length ? { list: docs } : { detail: 'None yet.' }),
        fields: [{ name: 'formId', label: 'Add a form', type: 'select', value: '', options: [{ value: '', label: 'No more documents' }, ...d.clinic.forms()] }],
        submitLabel: 'Continue',
      };
    },
    documentForm: (s) => ({ text: `Fill in ${s.data.addFormTitle}.`, form: { formId: s.data.addFormId, record: null, title: s.data.addFormTitle }, submitLabel: 'Save and attach' }),
    handoff: (s) => ({
      text: `Consultation for ${s.data.patientName || 'the patient'} is done?`,
      choices: [
        { value: 'checkout', label: 'Send to Checkout' },
        { value: 'later', label: 'Not yet — keep it at Consultation' },
      ],
    }),
  },

  actions: {
    begin: async (s, d) => {
      const visit = openVisit(s, d);
      if (visit.data.missing || !visit.data.hasEncounter || visit.data.closed) return visit;
      // Routed at Triage to a specific specialist: only they open it (unrouted visits are open to anyone).
      const assigned = await d.clinic.assignment(visit.data.encounterId).catch(() => null);
      const me = d.clinic.me();
      if (assigned && assigned.accountId && assigned.accountId !== me?.id) return { data: { ...visit.data, notYours: assigned.name || 'another specialist' } };
      return visit;
    },
    saveNotes: async (a, s, d) => {
      if (a.action === 'soap') {
        if (!d.clinic.paid()) throw new Error('Drafting notes with AI needs the paid plan. Write them in the form.');
        const transcript = d.clinic.transcript(d.threadId);
        if (!transcript.trim()) throw new Error('Nothing has been typed into this thread yet. Type the history here first, then draft.');
        const q = d.clinic.questionnaire(d.clinic.ENCOUNTER_FORM_ID);
        const soap = q?.item?.find((i) => i.linkId === 'section_soap');
        const values = await d.clinic.soapDraft(transcript, { ...q, item: [soap] });
        const current = d.clinic.encounter(s.data.encounterId);
        const draftData = { ...(current?.data || {}), item: [...(current?.data?.item || []).filter((i) => i.linkId !== 'section_soap'), ...withAnswers(a.qr, 'section_soap', values).item.filter((i) => i.linkId === 'section_soap')] };
        // Not saved: shown in the form for the clinician to check, then saved with the button.
        return { data: { stay: true, draft: { group: 'section_soap', record: { ...(current || {}), data: draftData } }, notice: 'AI draft filled in below — check it, then save.' } };
      }
      const data = saveSection(s, d, 'section_soap', a.qr);
      if (a.action === 'rx') {
        const plan = answer({ data }, 'soap_plan');
        if (!plan.trim()) throw new Error('Add a Plan before making a prescription.');
        await d.clinic.makePrescription(s.data.encounterId, { patientName: s.data.patientName, chiefComplaint: s.data.chiefComplaint, assessment: answer({ data }, 'soap_assessment'), plan });
        d.clinic.log(s.data.encounterId, 'Prescription PDF generated and attached to the visit.');
        return { data: { stay: true, draft: null, notice: 'Notes saved and the prescription PDF attached (see Documents).' } };
      }
      d.clinic.log(s.data.encounterId, 'Consultation notes saved.');
      return { data: { stay: false, draft: null, notice: '' } };
    },
    chooseDocument: async (a, s, d) => {
      if (!a.formId) return { data: { addFormId: null } };
      return { data: { addFormId: a.formId, addFormTitle: d.clinic.forms().find((f) => f.value === a.formId)?.label || a.formId } };
    },
    saveDocument: async (a, s, d) => {
      const recordId = d.clinic.save(s.data.addFormId, a.qr);
      d.clinic.attachForm(s.data.encounterId, s.data.addFormId, recordId);
      return { data: { addFormId: null } };
    },
    handOff: async (a, s, d) => {
      if (a.choice !== 'checkout') return { data: { handedOff: false } };
      d.clinic.markStageComplete(s.data.encounterId, 'consultation');
      d.clinic.log(s.data.encounterId, 'Consultation complete; sent to Checkout.');
      return { data: { handedOff: true } };
    },
    result: async (s) => ({
      result: s.data.handedOff
        ? { ok: true, title: 'Sent to Checkout', text: `${s.data.patientName || 'The patient'} is ready for checkout.`, next: { label: 'Open Checkout', to: `/clinic/checkout?encounter=${encodeURIComponent(s.data.encounterId)}` } }
        : { ok: true, title: 'Consultation saved', text: 'Resume it from Clinic operations.' },
    }),
    closedView: async (s, d) => closedView(s, d),
    notYoursResult: async (s) => ({ result: { ok: false, title: 'Routed to someone else', text: `This visit is routed to ${s.data.notYours}.` } }),
    missingResult: async () => missingResult(),
  },
};
