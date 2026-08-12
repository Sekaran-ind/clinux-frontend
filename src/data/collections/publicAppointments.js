import { createLocalCollection } from '../collectionFactory.js';

// Replaces clinic-home.html's cf_appointments_pub localStorage key — public, patient-submitted
// booking requests from the published clinic microsite (distinct from the FHIR
// section_appointment group inside system-provider-composition-v1, used elsewhere).
export const publicAppointments = createLocalCollection('cf_appointments_pub_v2');
