import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinixflow's cf_users localStorage key — the clinic-admin account list used by
// index.html's plain-object (non-FHIR) register/login flow. Deliberately NOT modeled as a
// SystemForms/FHIR record: this is app-account auth, not clinical data.
// Row shape: { id, clinicName, adminName, designation, email, password, services, phone, city,
//              careTeam, address }
export const users = createLocalCollection('cf_users_v2');
