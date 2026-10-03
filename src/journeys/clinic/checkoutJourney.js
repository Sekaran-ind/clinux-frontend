// Checkout as a journey — steps in specs/checkout.journey.json. Same records and calls as
// pages/Checkout.vue: the prescription and billing sections of the visit's Encounter record, the
// DigiLocker health-record PDF (digilockerExport.js), sharing the visit through ABDM (the visit as
// an OPConsultRecord care context linked to the patient's ABHA — M2 — and its bill sent to their
// ABHA app — Scan & Pay), and closing the visit — after which it's complete and every clinic
// journey shows it read-only.
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
    abdmPatient: (s, d) => ({
      text: `Which patient record is ${s.data.patientName ? `${s.data.patientName}’s` : 'this visit’s'}? ABDM shares it under their ABHA.`,
      fields: [{ name: 'patientId', label: 'Patient', type: 'select', value: '', options: [{ value: '', label: 'Skip sharing through ABDM' }, ...d.clinic.patients()] }],
      submitLabel: 'Continue',
    }),
    abdm: (s) => abdmPrompt(s.data),
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
    abdmCheck: async (s, d) => ({ data: { abdm: await d.clinic.abdmStatus(s.data.encounterId, s.data.abdmPatientId).catch((err) => ({ error: err.message })) } }),
    choosePatient: async (a) => ({ data: { abdmPatientId: a.patientId || null } }),
    abdmAct: async (a, s, d) => {
      const { facility, patient } = s.data.abdm || {};
      switch (a.choice) {
        case 'share': {
          const { careContext } = await d.clinic.shareVisit(s.data.encounterId, patient, facility);
          d.clinic.log(s.data.encounterId, patient.abhaAddress ? `Visit shared through ABDM to ${patient.abhaAddress}.` : 'Visit shared through ABDM (the patient can find it from their ABHA app).');
          return { data: { stay: true, abdmNotice: careContext.linkStatus === 'failed' ? `ABDM did not link it: ${careContext.linkError}` : patient.abhaAddress ? 'Sent to ABDM. Linking takes a few seconds — check again.' : 'Saved for ABDM. The patient can find it from their ABHA app by their mobile number.' } };
        }
        case 'bill': {
          const res = await d.clinic.sendBill(s.data.encounterId, patient, facility);
          d.clinic.log(s.data.encounterId, `Bill of ₹${res.amount} sent to the patient’s ABHA app (Scan & Pay).`);
          return { data: { stay: true, abdmNotice: res.offeredToWaitingOrder ? 'Bill sent: the patient’s ABHA app shows it now.' : 'Bill ready: the patient sees it when they scan the counter QR with the ABHA app.' } };
        }
        case 'sms':
          await d.clinic.textPatient(facility, patient.mobile);
          return { data: { stay: true, abdmNotice: 'ABDM will text the patient that their record is ready.' } };
        case 'check':
          return { data: { stay: true, abdmNotice: '' } };
        default:
          return { data: { stay: false, abdmNotice: '' } };
      }
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

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const LINKED = { linked: 'Linked to their ABHA', awaiting_token: 'Linking…', linking: 'Linking…', unlinked: 'Saved for ABDM — the patient can find it from their ABHA app', failed: 'Not linked' };

/** The ABDM step's prompt, from what abdmCheck found. Exported for tests. */
export function abdmPrompt(data) {
  const { facility, patient, careContext, bill, unpaid, error } = data.abdm || {};
  const done = { value: 'continue', label: 'Continue' };
  if (error) return { text: 'Share this visit through ABDM.', warning: `ABDM isn’t reachable right now (${error}).`, choices: [{ value: 'check', label: 'Try again' }, done] };
  if (!facility) return { text: 'Share this visit through ABDM.', detail: 'Register your facility for ABDM first (Registries → Scan & Share), then visits can be shared to patients’ ABHA.', choices: [done] };
  if (!patient) return { text: 'Share this visit through ABDM.', detail: 'Skipped: no patient record chosen.', choices: [done] };
  const choices = [];
  if (careContext?.linkStatus === 'linked') choices.push({ value: 'share', label: 'Share the updated record', detail: 'If the visit changed after sharing' });
  else if (!['awaiting_token', 'linking'].includes(careContext?.linkStatus)) {
    choices.push(patient.abhaAddress
      ? { value: 'share', label: careContext ? 'Try linking again' : 'Share to their ABHA', detail: `${patient.abhaAddress} · OP consultation` }
      : { value: 'share', label: 'Make it findable from the ABHA app', detail: 'No ABHA on record: they find it by mobile number' });
  } else choices.push({ value: 'check', label: 'Check again' });
  if (facility.scanPayEnabled && patient.abhaAddress && unpaid > 0 && !bill) choices.push({ value: 'bill', label: `Send the bill to their ABHA app`, detail: `${rupees(unpaid)} · Scan & Pay` });
  if (!patient.abhaAddress && patient.mobile && careContext) choices.push({ value: 'sms', label: 'Text them that it’s ready', detail: `ABDM SMS to ${patient.mobile}` });
  choices.push(done);
  const facts = [
    careContext ? `Record: ${LINKED[careContext.linkStatus] || careContext.linkStatus}${careContext.linkError && careContext.linkStatus === 'failed' ? ` (${careContext.linkError})` : ''}` : null,
    bill ? `Bill: ${rupees(bill.amount)} ${bill.status === 'paid' ? 'paid through ABHA' : 'waiting in their ABHA app'}` : null,
  ].filter(Boolean);
  return {
    text: `Share ${patient.name || 'the patient'}’s visit through ABDM (${facility.facilityName || facility.facilityId}).`,
    ...(data.abdmNotice || facts.length ? { detail: [data.abdmNotice, ...facts].filter(Boolean).join(' · ') } : {}),
    choices,
  };
}
