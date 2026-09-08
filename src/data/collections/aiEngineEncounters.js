import { createIndexedDbCollection } from '../indexedDbCollectionFactory.js';

// AiEngine.vue's own isolated encounter store — see aiEnginePatients.js for why this is a
// separate, isolated collection rather than the shared cf_form_data pool. Shaped to
// system-encounter-intake-v1's field set: encounter_patient_ref (an aiEnginePatients record id,
// not a name string), encounter_chief_complaint, encounter_status, encounter_priority.
//
// SPEC-19 §4: IndexedDB-backed — see aiEnginePatients.js for why.
export const aiEngineEncounters = createIndexedDbCollection('cf_ai_engine__system-encounter-intake-v1');
