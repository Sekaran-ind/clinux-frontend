import { createIndexedDbCollection } from '../indexedDbCollectionFactory.js';

// AiEngine.vue's own isolated patient store — deliberately NOT the shared cf_form_data pool
// formData.js's saveDataRecord/listDataRecords read/write (front-desk.html/onboarding.html/
// designer.html all live there). Records here still use the exact same shape
// ({id, formId, version, data, savedAt}, data a FHIR QuestionnaireResponse item tree keyed to
// system-patient-profile-v1's field linkIds) so the shared pure readers (getAnswer/getAnswers/
// recordSummary in formData.js) work on them unmodified — only the storage location is isolated.
//
// SPEC-19 §4: IndexedDB-backed, not localStorage — the AI Engine sandbox is where this app
// plausibly generates enough synthetic records to matter against localStorage's ~5-10MB quota.
// Same Collection interface as createLocalCollection, so nothing downstream of this import changed.
export const aiEnginePatients = createIndexedDbCollection('cf_ai_engine__system-patient-profile-v1');
