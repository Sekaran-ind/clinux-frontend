// What the clinic-operations journeys (Front Desk, Consultation, Checkout) run against: the
// clinic's local records (encounters, patients, attached forms, prescriptions), the
// server-side visit coordination (worklist locks, specialist routing), and the documents a visit
// produces. One object, so the journeys' handlers stay plain functions that tests can hand a fake.
// Same data and calls the FrontDesk/ConsultationDesk/Checkout pages use.
import {
  activeQuestionnaire, activeVersionNumber, formsLibrary, getAnswer, listDataRecords, recordSummary, saveDataRecord,
} from '../../data/useSystemForms.js';
import { attachCustomFormRecord, getEncounterCustomFormLinks, logEvent, prescriptions } from '../../data/collections/encounterDocs.js';
import { acquireWorklistLock, assignToSpecialist, getEncounterAssignmentStatus, releaseWorklistLock } from '../../data/runtime/encounterCoordination.js';
import { buildDigilockerRecordPdf } from '../../data/runtime/digilockerExport.js';
import { useClinicalStore } from '../../stores/clinical.js';
import { useAuthStore } from '../../stores/auth.js';
import { API_BASE, apiFetch } from '../../config.js';
import { chatThreads } from '../../data/collections/chatThreads.js';
import { buildPrescriptionPdf } from './prescriptionPdf.js';
import { answer } from './encounterRecord.js';
import { fetchScanShareFacilities } from '../../data/scanShare.js';
import { listBills, listCareContexts, publishBill, shareCareContext, smsNotify } from '../../data/hie.js';
import { billProcedures, opConsultBundle } from '../../abdm/careContextBundle.js';
import { accountRecords } from '../accountRecords.js';
import { HPR_RECORD } from '../hprJourney.js';

export const ENCOUNTER_FORM_ID = 'system-encounter-composition-v1';
export const PATIENT_FORM_ID = 'system-patient-profile-v1';

/** A patient record's details as ABDM needs them. */
export function patientDetails(record) {
  if (!record) return null;
  const first = answer(record, 'patient_first_name');
  const last = answer(record, 'patient_last_name');
  const birthDate = answer(record, 'patient_birthdate');
  return {
    id: record.id,
    name: [first, last].filter(Boolean).join(' ') || answer(record, 'patient_name'),
    gender: answer(record, 'patient_gender'),
    birthDate,
    yearOfBirth: birthDate ? Number(String(birthDate).slice(0, 4)) : null,
    mobile: answer(record, 'patient_mobile'),
    abhaNumber: answer(record, 'patient_abha_number'),
    abhaAddress: answer(record, 'patient_abha_address'),
  };
}

export const newEncounterId = () => 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

export function clinicDeps() {
  const clinical = useClinicalStore();
  const auth = useAuthStore();
  const find = (formId, id) => listDataRecords(formId).find((r) => r.id === id) || null;

  return {
    ENCOUNTER_FORM_ID,
    PATIENT_FORM_ID,
    questionnaire: (formId) => activeQuestionnaire(formId),
    encounter: (id) => find(ENCOUNTER_FORM_ID, id),
    record: (formId, id) => find(formId, id),
    patients: () => listDataRecords(PATIENT_FORM_ID).map((r) => ({ value: r.id, label: recordSummary(r) })),
    patientSummary: (id) => { const r = find(PATIENT_FORM_ID, id); return r ? recordSummary(r) : ''; },
    /** Saves a whole record (a new patient, an additional form); returns its id. */
    save: (formId, qr, id = null) => saveDataRecord(formId, activeVersionNumber(formId), qr, id),
    /** Saves the encounter's QuestionnaireResponse under its id (created if new) and makes it the active visit. */
    saveEncounter(id, data) {
      saveDataRecord(ENCOUNTER_FORM_ID, activeVersionNumber(ENCOUNTER_FORM_ID), data, id);
      clinical.setActive(id);
      clinical.recordVisit(id, 'journeys');
      return id;
    },
    setActive: (id) => clinical.setActive(id),
    stagesOf: (record) => clinical.getStageCompletion(record),
    markStageComplete: (id, stage) => clinical.markStageComplete(id, stage),
    /** Closes the visit (encounter_status = finished, checkout stage done). */
    closeEncounter(id) {
      const record = find(ENCOUNTER_FORM_ID, id);
      if (!record) throw new Error('This visit is no longer on this device.');
      const qr = structuredClone(record.data);
      const group = qr.item.find((i) => i.linkId === 'section_encounter') || (qr.item.unshift({ linkId: 'section_encounter', item: [] }), qr.item[0]);
      group.item = (group.item || []).filter((i) => i.linkId !== 'encounter_status');
      group.item.push({ linkId: 'encounter_status', answer: [{ valueCoding: { display: 'finished' } }] });
      saveDataRecord(ENCOUNTER_FORM_ID, record.version, qr, id);
      clinical.markStageComplete(id, 'checkout');
      if (clinical.activeEncounterId === id) clinical.clearActive();
    },
    log: (id, text, color) => logEvent(id, text, color),

    // Server-side coordination (paid tier; free tier proceeds — encounterCoordination.js).
    acquireLock: (id, stage) => acquireWorklistLock(id, stage),
    releaseLock: (id, stage) => releaseWorklistLock(id, stage),
    assignment: (id) => getEncounterAssignmentStatus(id, 'consultation'),
    assign: (id, accountId) => assignToSpecialist(id, accountId),
    async specialists() {
      const [{ accounts = [] } = {}, { affiliates = [] } = {}] = await Promise.all([auth.fetchTeam().catch(() => ({})), auth.fetchAffiliates().catch(() => ({}))]);
      return [
        ...accounts.filter((a) => a.id !== auth.currentUser?.id).map((a) => ({ value: a.id, label: `${a.adminName || a.email} (staff)` })),
        ...affiliates.map((a) => ({ value: a.accountId, label: `${a.adminName || a.email} (affiliate)` })),
      ];
    },
    me: () => auth.currentUser,

    // Additional forms and documents attached to a visit.
    forms: () => formsLibrary.toArray.map((r) => ({ value: r.formId, label: activeQuestionnaire(r.formId)?.title || r.formId })).sort((a, b) => a.label.localeCompare(b.label)),
    attachForm: (id, formId, recordId) => attachCustomFormRecord(id, formId, recordId),
    attachedForms: (id) => getEncounterCustomFormLinks(id).map((l) => {
      const r = find(l.formId, l.recordId);
      return { name: activeQuestionnaire(l.formId)?.title || l.formId, detail: r ? recordSummary(r) : l.recordId };
    }),
    prescriptionsOf: (id) => prescriptions.toArray.filter((r) => r.encounterId === id),
    async makePrescription(id, { patientName, chiefComplaint, assessment, plan }) {
      const rx = await buildPrescriptionPdf({ patientName, chiefComplaint, assessment, plan });
      prescriptions.insert({ id: rx.id, encounterId: id, createdAt: new Date().toISOString(), dataUrl: rx.dataUrl });
      return rx.id;
    },
    /** The DigiLocker-ready health-record PDF, downloaded by the browser. */
    async downloadHealthRecord(id) {
      const record = find(ENCOUNTER_FORM_ID, id);
      const { blob, qrIncluded } = await buildDigilockerRecordPdf(record);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: `health-record-${id}.pdf` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { qrIncluded };
    },

    // ABDM at Checkout: share the visit (M2 care context) and send its bill (Scan & Pay).
    /** The visit's patient record: the id Front Desk stored, else the one patient with the visit's name. */
    patientOf(encounterId, chosenId = null) {
      const record = find(ENCOUNTER_FORM_ID, encounterId);
      const id = chosenId || answer(record, 'encounter_patient_id');
      if (id) return find(PATIENT_FORM_ID, id);
      const name = answer(record, 'encounter_patient_ref');
      const same = listDataRecords(PATIENT_FORM_ID).filter((r) => name && (recordSummary(r) === name || answer(r, 'patient_name') === name));
      return same.length === 1 ? same[0] : null;
    },
    async abdmStatus(encounterId, chosenPatientId = null) {
      const { facilities = [] } = await fetchScanShareFacilities();
      const facility = facilities[0] || null;
      if (!facility) return { facility: null };
      const record = find(ENCOUNTER_FORM_ID, encounterId);
      const patient = patientDetails(this.patientOf(encounterId, chosenPatientId));
      if (!patient) return { facility, patient: null, needPatient: true };
      const [{ careContexts = [] }, { bills = [] }] = await Promise.all([listCareContexts({ patientReference: patient.id }), listBills(encounterId)]);
      const unpaid = billProcedures(record).flatMap((p) => p.services).reduce((sum, x) => sum + x.amount, 0);
      return {
        facility, patient, unpaid,
        careContext: careContexts.find((c) => c.careContextReference === encounterId && c.facilityId === facility.facilityId) || null,
        bill: bills.find((b) => b.status !== 'cancelled') || null,
      };
    },
    async shareVisit(encounterId, patient, facility) {
      const record = find(ENCOUNTER_FORM_ID, encounterId);
      if (!record) throw new Error('This visit is no longer on this device.');
      const me = auth.currentUser;
      const hpr = me?.id ? await accountRecords(me.id).get(HPR_RECORD).catch(() => null) : null;
      const date = record.updatedAt || record.createdAt || new Date().toISOString();
      const bundle = opConsultBundle({ encounter: record, patient, facility: { id: facility.facilityId, name: facility.facilityName }, practitioner: { name: hpr?.name || me?.adminName || me?.email, hprId: hpr?.hprId }, date: new Date(date).toISOString() });
      const chief = answer(record, 'encounter_chief_complaint');
      if (!patient.gender || !patient.yearOfBirth) throw new Error('Add the patient’s gender and date of birth to their record first — ABDM matches records on them.');
      return shareCareContext({
        facilityId: facility.facilityId,
        patient: { reference: patient.id, name: patient.name, gender: patient.gender, yearOfBirth: patient.yearOfBirth, abhaAddress: patient.abhaAddress || undefined, abhaNumber: patient.abhaNumber || undefined, mobile: patient.mobile || undefined },
        careContext: { reference: encounterId, display: `OP consultation ${new Date(date).toLocaleDateString('en-IN')}${chief ? ` — ${chief}` : ''}`.slice(0, 200), hiType: 'OPConsultation', date },
        bundle,
      });
    },
    sendBill(encounterId, patient, facility) {
      const procedures = billProcedures(find(ENCOUNTER_FORM_ID, encounterId), { patientName: patient.name });
      if (!procedures.length) throw new Error('This visit has no unpaid charges (Payment step: an issued invoice with an amount).');
      return publishBill({ facilityId: facility.facilityId, abhaAddress: patient.abhaAddress, abhaNumber: patient.abhaNumber || undefined, patientName: patient.name, encounterReference: encounterId, procedures });
    },
    textPatient: (facility, mobile) => smsNotify(facility.facilityId, mobile),

    // AI SOAP draft (paid): the journey thread's typed messages are the dictation.
    paid: () => auth.currentUser?.tier === 'paid',
    transcript: (threadId) => (chatThreads.get(threadId)?.messages || []).filter((m) => m.role === 'user' && m.text && !m.text.startsWith('Saved: ') && !m.text.startsWith('↩')).map((m) => m.text).join('. '),
    async soapDraft(transcript, soapQuestionnaire) {
      const res = await apiFetch(`${API_BASE}/api/workflow/test-scribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, activeBlueprint: soapQuestionnaire, context: '' }),
      }).then((r) => r.json());
      if (!res.success) throw new Error('Scribe error: ' + res.error);
      const env = { data: res.questionnaireResponseEnvelope };
      return { soap_subjective: getAnswer(env, 'soap_subjective'), soap_objective: getAnswer(env, 'soap_objective'), soap_assessment: getAnswer(env, 'soap_assessment'), soap_plan: getAnswer(env, 'soap_plan') };
    },
  };
}
