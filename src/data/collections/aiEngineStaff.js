import { createIndexedDbCollection } from '../indexedDbCollectionFactory.js';

// AiEngine.vue's own isolated staff store — see aiEnginePatients.js for why this is a separate,
// isolated collection rather than the shared cf_form_data pool. Shaped to system-staff-profile-v1's
// core (non-ABDM) field set: section_staff (staff_name/staff_phone/staff_email/
// staff_qualification/staff_license/staff_status) + section_staff_role (staff_role/
// staff_specialty).
//
// SPEC-19 §4: IndexedDB-backed — see aiEnginePatients.js for why.
export const aiEngineStaff = createIndexedDbCollection('cf_ai_engine__system-staff-profile-v1');
