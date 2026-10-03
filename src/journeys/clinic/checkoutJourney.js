// Checkout as a journey — steps in specs/checkout.journey.json. Same records and calls as
// pages/Checkout.vue: the prescription and billing sections of the visit's Encounter record, the
// DigiLocker health-record PDF (digilockerExport.js), and closing the visit — after which it's
// complete and every clinic journey shows it read-only.
import spec from '../specs/checkout.journey.json' with { type: 'json' };
import { closedView, lockVisit, lockedResult, missingResult, openVisit, saveSection, sectionPrompt } from './visit.js';

export const checkoutJourney = {
  spec,
  id: spec.id,
  title: spec.title,
  summary: spec.summary,
  icon: spec.icon,
  category: spec.category,

  prompts: {
    medication: (s, d) => sectionPrompt(s, d, 'section_prescription', `Checkout for ${s.data.patientName || 'the patient'}: medication dispensed or prescribed. Add more with the form’s “+”.`, { submitLabel: 'Save medication' }),
    payment: (s, d) => sectionPrompt(s, d, 'section_billing', 'Payment for the visit.', { submitLabel: 'Save payment' }),
    record: (s) => ({
      text: 'The patient’s health record for this visit, as a PDF they can keep in DigiLocker.',
      ...(s.data.notice ? { detail: s.data.notice } : {}),
      choices: [
        { value: 'download', label: 'Download the health record', detail: 'PDF with a QR the patient can scan' },
        { value: 'continue', label: 'Continue' },
      ],
    }),
    close: (s) => ({
      text: `Close ${s.data.patientName ? s.data.patientName + '’s' : 'this'} visit?`,
      warning: 'Closing completes the visit: its record becomes read-only.',
      choices: [
        { value: 'close', label: 'Close the visit' },
        { value: 'later', label: 'Not yet' },
      ],
    }),
  },

  actions: {
    begin: async (s, d) => {
      const visit = openVisit(s, d);
      if (visit.data.missing || !visit.data.hasEncounter || visit.data.closed) return visit;
      const lock = await lockVisit({ data: visit.data }, d, 'checkout');
      return { data: { ...visit.data, ...lock.data } };
    },
    saveMedication: async (a, s, d) => { saveSection(s, d, 'section_prescription', a.qr); return {}; },
    savePayment: async (a, s, d) => { saveSection(s, d, 'section_billing', a.qr); return {}; },
    healthRecord: async (a, s, d) => {
      if (a.choice !== 'download') return { data: { stay: false } };
      const { qrIncluded } = await d.clinic.downloadHealthRecord(s.data.encounterId);
      return { data: { stay: true, notice: qrIncluded ? 'Downloaded — ready for DigiLocker.' : 'Downloaded (too much data for a QR; a text transfer key is printed instead).' } };
    },
    closeVisit: async (a, s, d) => {
      if (a.choice !== 'close') {
        await d.clinic.releaseLock(s.data.encounterId, 'checkout');
        return { data: { closedNow: false } };
      }
      d.clinic.closeEncounter(s.data.encounterId);
      await d.clinic.releaseLock(s.data.encounterId, 'checkout');
      d.clinic.log(s.data.encounterId, 'Visit closed at Checkout.');
      return { data: { closedNow: true } };
    },
    result: async () => ({ result: { ok: true, title: 'Checkout saved', text: 'The visit stays open. Resume it from Clinic operations.' } }),
    closedView: async (s, d) => closedView(s, d),
    lockedResult: async (s) => lockedResult(s),
    missingResult: async () => missingResult(),
  },
};
