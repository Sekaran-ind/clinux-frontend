// The registry journeys the workspace runs (Registries in AppShell's sidebar). HPR and HFR are
// clinux-cubo's own journeys, ported unchanged (src/journeys/hprJourney.js, hfrJourney.js); Patient
// ABHA follows cubo-diary's ABHA journey from the clinic's side (patientAbhaJourney.js). All three
// call the same clinuxflow-abdm-gateway routes Cübo and the diary use.
//
// No role filtering: every signed-in account sees every registry journey (unlike clinux-cubo's
// journeysFor(role)). A journey's own steps still ask ABDM for whatever it requires.
import { api } from './fhirApi.js';
import { gateway } from './gateway.js';
import { vault } from './vault.js';
import { hprJourney } from './hprJourney.js';
import { hfrJourney } from './hfrJourney.js';
import { patientAbhaJourney } from './patientAbhaJourney.js';
import { PATIENT_FORM_ID, mergeAbhaIntoPatientResponse } from './patientRecord.js';
import { listDataRecords, saveDataRecord, getAnswer, recordSummary, activeVersionNumber, activeQuestionnaire } from '../data/useSystemForms.js';
import { pushResourceRecord } from '../data/control/resourceRecords.js';
import { journalToAudit, recordAuditEvent } from '../data/operations.js';
import { provenanceForAudit, recordProvenance } from '../provenance/recorder.js';

import { frontDeskJourney } from './clinic/frontDeskJourney.js';
import { consultationJourney } from './clinic/consultationJourney.js';
import { checkoutJourney } from './clinic/checkoutJourney.js';
import { clinicDeps } from './clinic/clinicDeps.js';

export const JOURNEYS = [hprJourney, hfrJourney, patientAbhaJourney];
// Clinic operations as journeys (Front Desk, Consultation, Checkout): one run per visit.
export const CLINIC_JOURNEYS = [frontDeskJourney, consultationJourney, checkoutJourney];
export const journeyById = (id) => [...JOURNEYS, ...CLINIC_JOURNEYS].find((j) => j.id === id);

import { accountRecords } from './accountRecords.js';

export { accountRecords };

// clinux-cubo's journal (src/journal/journal.js): one event per thing a journey achieved, capped.
// Each entry that maps to an audit action (an HPR ID linked, a facility submitted, an ABHA
// recorded) is also sent to the clinic's activity log — that's how the ported journeys feed
// Operations → Activity log without being edited (see data/operations.js's journalToAudit).
const JOURNAL_KEY = 'journal';
function createJournal(records) {
  return {
    async add(event, at = new Date()) {
      const list = (await records.get(JOURNAL_KEY)) || [];
      const entry = { id: crypto.randomUUID(), at: at.toISOString(), ...event };
      await records.set(JOURNAL_KEY, [...list, entry].slice(-500));
      const audit = journalToAudit(entry);
      if (audit) recordAuditEvent(audit);
      // ...and the outcome's digital provenance, on this device (published on the paid plan).
      const prov = provenanceForAudit(audit);
      if (prov) recordProvenance(prov);
      return entry;
    },
    async list() {
      return (await records.get(JOURNAL_KEY)) || [];
    },
  };
}

// The patient side of the ABHA journey: the clinic's local patient records (PatientHome's).
export const patients = {
  async list() {
    return listDataRecords(PATIENT_FORM_ID).map((r) => ({
      value: r.id,
      label: recordSummary(r),
      // The person's name alone (label is the directory's one-line summary, which may lead with ids).
      name: getAnswer(r, 'patient_name') || [getAnswer(r, 'patient_first_name'), getAnswer(r, 'patient_last_name')].filter(Boolean).join(' ') || recordSummary(r),
      mobile: getAnswer(r, 'patient_mobile') || '',
      abhaNumber: getAnswer(r, 'patient_abha_number') || '',
      abhaAddress: getAnswer(r, 'patient_abha_address') || '',
    }));
  },
  async saveAbha(recordId, person) {
    const existing = recordId ? listDataRecords(PATIENT_FORM_ID).find((r) => r.id === recordId) : null;
    const qr = mergeAbhaIntoPatientResponse(existing?.data, person);
    const id = saveDataRecord(PATIENT_FORM_ID, activeVersionNumber(PATIENT_FORM_ID), qr, existing?.id);
    // Best-effort paid-tier mirror, exactly as PatientHome.vue's savePatient() does.
    pushResourceRecord('Patient', activeQuestionnaire(PATIENT_FORM_ID), qr, id).catch(() => {});
    return id;
  },
};

// The Facility profile (Profiles → Facility profile, the Provider composition record): the HFR
// journey offers its name for a new facility. Read-only here; the two stay independent.
const PROVIDER_FORM_ID = 'system-provider-composition-v1';
export async function facilityProfile() {
  const rec = listDataRecords(PROVIDER_FORM_ID)[0];
  if (!rec) return null;
  return { name: getAnswer(rec, 'hospital_name') || '', phone: getAnswer(rec, 'hospital_phone') || '', email: getAnswer(rec, 'hospital_email') || '' };
}

/** What a journey runs against for this signed-in account. */
export function journeyDeps(account) {
  const records = accountRecords(account.id);
  return {
    account,
    api,
    gateway,
    vault,
    records,
    patients,
    facilityProfile,
    // The clinic's records and visit coordination (clinic journeys only; built when first used).
    get clinic() { return clinicDeps(); },
    journal: createJournal(records),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
