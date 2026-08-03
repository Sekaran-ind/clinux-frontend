import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinic-home.html's cf_appointments_pub localStorage key — public, patient-submitted
// booking requests from the published clinic microsite (distinct from the FHIR
// system-appointments-profile-v1 form used elsewhere).
export const publicAppointments = createLocalCollection('cf_appointments_pub_v2');
