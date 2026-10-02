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

export const ENCOUNTER_FORM_ID = 'system-encounter-composition-v1';
export const PATIENT_FORM_ID = 'system-patient-profile-v1';

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
