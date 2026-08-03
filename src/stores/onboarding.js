import { defineStore } from 'pinia';
import { ref, reactive, computed } from 'vue';
import { listDataRecords, getAnswer, getAnswers, saveDataRecord } from '../data/collections/formData.js';
import { activeVersionNumber } from '../data/collections/formsLibrary.js';
import { extractResponse } from '../data/useSystemForms.js';
import { useAuthStore } from './auth.js';

const ONB_COLORS = ['#3B82F6', '#00D4B2', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#06B6D4', '#10B981'];
const ONB_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Replaces Alpine.store('onboarding') from clinixflow's store.js — flattens the FHIR
// QuestionnaireResponse records collected across Hospital/Staff/Services/Office Hours/Consents
// into the flat clinic{} shape clinic-home.html reads from cf_clinic_profile.
export const useOnboardingStore = defineStore('onboarding', () => {
  const HOSPITAL_FORM_ID = 'system-hospital-profile-v1';
  const STAFF_FORM_ID = 'system-staff-profile-v1';
  const SERVICES_FORM_ID = 'system-services-profile-v1';
  const HOURS_FORM_ID = 'system-office-hours-profile-v1';
  const CONSENTS_FORM_ID = 'system-consents-profile-v1';
  const LOCATIONS_FORM_ID = 'system-locations-profile-v1';

  const auth = useAuthStore();
  // registeredUser is index.html's registration account, carried over here so the Hospital form
  // can be prefilled with it — now just a direct reference to the auth store's currentUser
  // rather than a separately-read/duplicated copy of cf_user.
  const registeredUser = computed(() => auth.currentUser);

  const branding = reactive({ tagline: '', brandColor: '#00D4B2', logoUrl: '', slug: '' });
  try {
    Object.assign(branding, JSON.parse(localStorage.getItem('cf_onboarding_branding') || '{}'));
  } catch (e) { /* keep defaults */ }

  const publishedClinic = ref({});
  try {
    const saved = localStorage.getItem('cf_clinic_profile');
    if (saved) publishedClinic.value = JSON.parse(saved);
  } catch (e) { /* keep default */ }

  const hospitalRecordId = ref(listDataRecords(HOSPITAL_FORM_ID)[0]?.id ?? null);

  // Bumped on every save/delete of any onboarding-related record so buildClinicProfile()'s
  // callers (Vue computeds) have a reactive dependency to track — plain collection reads
  // (.toArray/.get) aren't Vue-reactive on their own, same reasoning as FrontDesk/
  // ConsultationDesk's dataVersion idiom.
  const dataVersion = ref(0);

  // A synthetic "existing record" built from the registration account, so the Hospital drawer
  // opens pre-filled the very first time instead of starting blank. Never persisted itself —
  // once the user actually saves, a real record replaces it.
  function buildSeedFromRegistration() {
    const u = registeredUser.value;
    if (!u) return null;
    const answers = [];
    if (u.clinicName) answers.push({ linkId: 'hospital_name', answer: [{ valueString: u.clinicName }] });
    if (u.phone) answers.push({ linkId: 'hospital_phone', answer: [{ valueString: u.phone }] });
    if (u.city) answers.push({ linkId: 'hospital_city', answer: [{ valueString: u.city }] });
    if (answers.length === 0) return null;
    return {
      id: 'seed-from-registration', formId: HOSPITAL_FORM_ID, version: null,
      data: { resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [{ linkId: 'section_hospital', item: answers }] },
      savedAt: new Date().toISOString(),
    };
  }

  // Writes the published clinic's name/phone/city/address back onto the registration account
  // (auth store + users collection) so index.html reflects what was actually set up.
  function syncRegisteredUser(profile) {
    if (!registeredUser.value) return;
    auth.saveProfile({
      clinicName: profile.name || registeredUser.value.clinicName,
      phone: profile.phone || registeredUser.value.phone,
      city: profile.city || registeredUser.value.city,
      address: profile.address || registeredUser.value.address,
    });
  }

  function saveBranding() {
    localStorage.setItem('cf_onboarding_branding', JSON.stringify(branding));
  }

  // Extracts and upserts the single Hospital record from whichever container currently holds
  // its rendered form. Returns false if there was nothing to read.
  function saveHospitalRecord(containerId) {
    const qr = extractResponse(containerId);
    if (!qr) return false;
    hospitalRecordId.value = saveDataRecord(HOSPITAL_FORM_ID, activeVersionNumber(HOSPITAL_FORM_ID), qr, hospitalRecordId.value);
    saveBranding();
    dataVersion.value++;
    return true;
  }

  // Office Hours records are arbitrary day-ranges; expands them into the fixed 7-day array
  // clinic-home.html's hours table expects. Later-saved records win for a given day.
  function flattenHours(records) {
    const byDay = {};
    [...records].sort((a, b) => a.savedAt.localeCompare(b.savedAt)).forEach((rec) => {
      const abbrevs = getAnswers(rec, 'hours_days');
      const open = getAnswer(rec, 'hours_open');
      const close = getAnswer(rec, 'hours_close');
      const allDay = getAnswer(rec, 'hours_allday');
      abbrevs.forEach((ab) => {
        if (!ab) return;
        const day = ONB_DAYS.find((d) => d.toLowerCase().startsWith(String(ab).toLowerCase()));
        if (day) byDay[day] = { open: true, from: allDay ? '00:00' : open, to: allDay ? '23:59' : close };
      });
    });
    return ONB_DAYS.map((d) => ({ day: d, ...(byDay[d] || { open: false, from: '', to: '' }) }));
  }

  function buildClinicProfile() {
    dataVersion.value; // register the reactive dependency
    const hospitalRec = listDataRecords(HOSPITAL_FORM_ID)[0] || null;
    const ga = (linkId) => getAnswer(hospitalRec, linkId);

    const name = ga('hospital_name');
    const staffRecs = listDataRecords(STAFF_FORM_ID);
    const serviceRecs = listDataRecords(SERVICES_FORM_ID);
    const consentRecs = listDataRecords(CONSENTS_FORM_ID);
    const hoursRecs = listDataRecords(HOURS_FORM_ID);
    const locationRecs = listDataRecords(LOCATIONS_FORM_ID);

    return {
      name,
      legalName: ga('hospital_legalname'),
      type: ga('hospital_type') || 'Hospital',
      npi: ga('hospital_npi'),
      tagline: branding.tagline || '',
      brandColor: branding.brandColor || '#00D4B2',
      logoUrl: branding.logoUrl || '',
      slug: branding.slug || (name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : ''),
      address: ga('hospital_address'),
      city: ga('hospital_city'),
      state: ga('hospital_state'),
      pin: ga('hospital_pin'),
      country: ga('hospital_country') || 'India',
      phone: ga('hospital_phone'),
      whatsapp: ga('hospital_whatsapp'),
      email: ga('hospital_email'),
      website: ga('hospital_website'),
      staff: staffRecs.map((rec, i) => ({
        id: rec.id,
        name: getAnswer(rec, 'staff_name'),
        role: getAnswer(rec, 'staff_role'),
        specialty: getAnswers(rec, 'staff_specialty').join(', '),
        qualification: getAnswer(rec, 'staff_qualification'),
        bio: '',
        color: ONB_COLORS[i % ONB_COLORS.length],
      })),
      services: serviceRecs.map((rec) => {
        const program = getAnswer(rec, 'service_program_name');
        const description = getAnswer(rec, 'service_description');
        return {
          id: rec.id,
          name: getAnswer(rec, 'service_name'),
          category: getAnswer(rec, 'service_specialty_category'),
          description: [program ? 'Program: ' + program : '', description].filter(Boolean).join(' — '),
          duration: '',
          fee: '',
        };
      }),
      hours: flattenHours(hoursRecs),
      consents: consentRecs.map((rec) => ({ id: rec.id, title: getAnswer(rec, 'consent_category'), enabled: true })),
      locations: locationRecs.map((rec) => ({
        id: rec.id,
        name: getAnswer(rec, 'location_name'),
        address: getAnswer(rec, 'location_address'),
        phone: getAnswer(rec, 'location_phone'),
      })),
      apptConfig: { onlineBooking: true },
      published: false,
    };
  }

  // Builds and persists the final clinic profile. Returns null if the Hospital step was never
  // completed — caller should treat that as a validation failure, not a successful publish.
  function publish() {
    const profile = buildClinicProfile();
    if (!profile.name) return null;
    profile.published = true;
    localStorage.setItem('cf_clinic_profile', JSON.stringify(profile));
    localStorage.setItem('cf_onboarding_clinic', JSON.stringify(profile));
    publishedClinic.value = profile;
    syncRegisteredUser(profile);
    return profile;
  }

  return {
    HOSPITAL_FORM_ID, STAFF_FORM_ID, SERVICES_FORM_ID, HOURS_FORM_ID, CONSENTS_FORM_ID, LOCATIONS_FORM_ID,
    registeredUser, branding, publishedClinic, hospitalRecordId, dataVersion,
    buildSeedFromRegistration, saveBranding, saveHospitalRecord, buildClinicProfile, publish,
  };
});
