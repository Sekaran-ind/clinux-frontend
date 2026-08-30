import { defineStore } from 'pinia';
import { ref, reactive, computed } from 'vue';
import { formData, listDataRecords, getAnswer, getAnswers, saveDataRecord, getGroupInstances } from '../data/collections/formData.js';
import { activeVersionNumber } from '../data/collections/formsLibrary.js';
import { extractResponse } from '../data/useSystemForms.js';
import { useAuthStore } from './auth.js';

const ONB_COLORS = ['#3B82F6', '#00D4B2', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#06B6D4', '#10B981'];
const ONB_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Replaces Alpine.store('onboarding') from clinixflow's store.js — flattens the ONE merged
// Provider-composition record's Hospital/Staff/Services/Office Hours/Consents/Locations groups
// into the flat clinic{} shape clinic-home.html reads from cf_clinic_profile. Was 6 separate
// forms/records before the Provider-composition merge (see clinux-provider-composition-merge
// memory note) — getGroupInstances() reads the repeating groups the same way
// Checkout.vue/FrontDesk.vue already read Vitals/Prescription/Billing off the (already merged)
// Encounter composition.
export const useOnboardingStore = defineStore('onboarding', () => {
  const PROVIDER_FORM_ID = 'system-provider-composition-v1';

  const auth = useAuthStore();
  // registeredUser is index.html's registration account, carried over here so the Hospital form
  // can be prefilled with it — now just a direct reference to the auth store's currentUser
  // rather than a separately-read/duplicated copy of cf_user.
  const registeredUser = computed(() => auth.currentUser);

  const branding = reactive({ tagline: '', brandColor: '#00D4B2', logoUrl: '', slug: '' });
  try {
    Object.assign(branding, JSON.parse(localStorage.getItem('cf_onboarding_branding') || '{}'));
  } catch (e) { /* keep defaults */ }

  // Whether this clinic has EVER gone through Publish at least once — the deliberate "go live"
  // gate (ClinicHome shows a demo placeholder until this happens), tracked separately from the
  // profile CONTENT itself. Proxied off cf_clinic_profile's mere existence, same signal
  // Index.vue's own routing check already uses.
  const everPublished = ref(!!localStorage.getItem('cf_clinic_profile'));

  // A computed, NOT a plain ref that publish() assigns once and nothing else ever touches again.
  // buildClinicProfile() already re-derives from the live Provider record on every call (it reads
  // dataVersion as a reactive dependency, bumped by every saveProviderRecord()) — the bug was
  // never in buildClinicProfile() itself, it was that nothing called it again after the FIRST
  // publish. Editing Hospital/Staff/etc. via "Manage Settings" post-publish went through
  // saveProviderRecord() (bumping dataVersion) same as always, but ClinicHome.vue reads
  // publishedClinic, which stayed frozen at whatever publish() last assigned — any edit made
  // after the first publish silently never showed up until the user re-clicked "Publish Clinic
  // Page" again, which nothing in the "Manage Settings" edit flow prompts them to do.
  const publishedClinic = computed(() => (everPublished.value ? buildClinicProfile() : {}));

  const providerRecordId = ref(listDataRecords(PROVIDER_FORM_ID)[0]?.id ?? null);

  // The one shared record every onboarding card now reads/writes — a thin wrapper since several
  // pages (ConsultationDesk.vue's care-team picker, AbdmOnboarding.vue) need it directly, not
  // just via buildClinicProfile()'s flattened snapshot.
  function getProviderRecord() {
    return listDataRecords(PROVIDER_FORM_ID)[0] || null;
  }

  // Bumped on every save/delete of any onboarding-related record so buildClinicProfile()'s
  // callers (Vue computeds) have a reactive dependency to track — plain collection reads
  // (.toArray/.get) aren't Vue-reactive on their own, same reasoning as FrontDesk/
  // ConsultationDesk's dataVersion idiom.
  const dataVersion = ref(0);
  // ALSO bumped by any change to formData from ANY origin, not just this store's own explicit
  // saves — real bug found live: the shared-server sync layer (sharedServerSync.js) merges
  // remote changes into formData via collection.insert()/.update() in the background, on its own
  // timer, with nothing else in the app aware it happened. Without this, a device that pulls in
  // another device's Provider record (e.g. a fresh login finding the clinic profile already set
  // up elsewhere) never re-renders to show it — publishedClinic/buildClinicProfile() stay stuck
  // on whatever was true at the moment this store was created, even though the underlying data
  // changed moments later. formData.subscribeChanges() is TanStack DB's own change-notification
  // primitive, already correct for every origin (local writes AND remote merges alike).
  formData.subscribeChanges(() => { dataVersion.value++; });

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
      id: 'seed-from-registration', formId: PROVIDER_FORM_ID, version: null,
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

  // Extracts and upserts the ONE Provider record from whichever container currently holds its
  // rendered form — every onboarding card (Hospital/Staff/Services/Hours/Consents/Locations)
  // shares this one save path now, not just Hospital's (there's no longer a "single vs
  // repeatable save mechanic" distinction at the store level — LForms' own "+ Add another"
  // handles repeating groups within the one document natively). Returns false if there was
  // nothing to read.
  function saveProviderRecord(containerId) {
    const qr = extractResponse(containerId);
    if (!qr) return false;
    providerRecordId.value = saveDataRecord(PROVIDER_FORM_ID, activeVersionNumber(PROVIDER_FORM_ID), qr, providerRecordId.value);
    saveBranding();
    dataVersion.value++;
    return true;
  }

  // Creates an empty Provider record if one doesn't exist yet — for SPEC-09's controlled-input
  // registration flows (AbdmFieldForm.vue), which append/patch group instances directly
  // (appendGroupInstance/patchGroupInstanceField) instead of extracting a whole LForms-rendered
  // document via saveProviderRecord() above. Idempotent: a no-op once a record already exists.
  //
  // Real bug found live (SPEC-11): providerRecordId is a plain ref, set once and then trusted —
  // if the record it points to stops existing (data cleared mid-session without a page reload,
  // e.g. this app's own "still pre-pilot, clear all data" testing habit; or a stale value left
  // over from a different clinicId's session), this used to skip re-creating one, since the ref
  // was still truthy. Every caller downstream then got back an id pointing at nothing:
  // HospitalOnboarding.vue's saveDrawer() crashed outright (getProviderRecord() correctly
  // returned null, and `record.data` on a null record threw); StaffOnboarding.vue's saveDrawer()
  // didn't crash but silently saved nothing at all (appendGroupInstance() no-ops for an unknown
  // recordId) while still showing a "Saved" toast. formData.has() verifies the id still resolves
  // to a real record before trusting it, fixing both call sites at their shared source.
  function ensureProviderRecord() {
    if (!providerRecordId.value || !formData.has(providerRecordId.value)) {
      providerRecordId.value = saveDataRecord(PROVIDER_FORM_ID, activeVersionNumber(PROVIDER_FORM_ID), { item: [] }, null);
    }
    return providerRecordId.value;
  }

  // Office Hours instances are arbitrary day-ranges; expands them into the fixed 7-day array
  // clinic-home.html's hours table expects. Instances are bare {linkId,item} group instances now
  // (see getGroupInstances), not full records — they share the ONE parent record's single
  // savedAt, so "later-saved wins" is no longer meaningful; natural array order (LForms' own
  // "+ Add another" append order) is the next-best proxy and is what's used instead: later
  // array position wins for a given day.
  function flattenHours(instances) {
    const byDay = {};
    instances.forEach((instance) => {
      const rec = { data: instance };
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
    const providerRec = getProviderRecord();
    const ga = (linkId) => getAnswer(providerRec, linkId);

    const name = ga('hospital_name');
    const staffInstances = getGroupInstances(providerRec, 'section_staff');
    const serviceInstances = getGroupInstances(providerRec, 'section_services_matrix');
    const consentInstances = getGroupInstances(providerRec, 'section_consent');
    const hoursInstances = getGroupInstances(providerRec, 'section_hours');
    const locationInstances = getGroupInstances(providerRec, 'section_location');

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
      // Every entity below is a repeating group instance now, not its own record — id has no
      // stable value from the record itself anymore (see getGroupInstances' own doc comment), so
      // array position is used as a synthetic id instead. Only ever used as a display/:key value
      // by ClinicHome.vue, never as a lookup key elsewhere — safe.
      staff: staffInstances.map((instance, i) => {
        const rec = { data: instance };
        return {
          id: 'staff-' + i,
          name: getAnswer(rec, 'staff_name'),
          role: getAnswer(rec, 'staff_role'),
          specialty: getAnswers(rec, 'staff_specialty').join(', '),
          qualification: getAnswer(rec, 'staff_qualification'),
          bio: '',
          color: ONB_COLORS[i % ONB_COLORS.length],
        };
      }),
      services: serviceInstances.map((instance, i) => {
        const rec = { data: instance };
        const program = getAnswer(rec, 'service_program_name');
        const description = getAnswer(rec, 'service_description');
        return {
          id: 'service-' + i,
          name: getAnswer(rec, 'service_name'),
          category: getAnswer(rec, 'service_specialty_category'),
          description: [program ? 'Program: ' + program : '', description].filter(Boolean).join(' — '),
          duration: '',
          fee: '',
        };
      }),
      hours: flattenHours(hoursInstances),
      consents: consentInstances.map((instance, i) => ({ id: 'consent-' + i, title: getAnswer({ data: instance }, 'consent_category'), enabled: true })),
      locations: locationInstances.map((instance, i) => {
        const rec = { data: instance };
        return {
          id: 'location-' + i,
          name: getAnswer(rec, 'location_name'),
          address: getAnswer(rec, 'location_address'),
          phone: getAnswer(rec, 'location_phone'),
        };
      }),
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
    // Still written for Index.vue's own "has this account ever published?" existence check and
    // as a one-time snapshot for anything reading cf_clinic_profile directly (e.g.
    // ConsultationDesk.vue's prescription-PDF header) -- ClinicHome.vue itself no longer depends
    // on this being fresh, since publishedClinic is now a live computed (see above).
    localStorage.setItem('cf_clinic_profile', JSON.stringify(profile));
    localStorage.setItem('cf_onboarding_clinic', JSON.stringify(profile));
    everPublished.value = true;
    syncRegisteredUser(profile);
    return profile;
  }

  // Phase C extension: applies an imported clinic-profile transfer (see sessionShare.js's
  // buildProviderProfileSharePayload/decodeProviderProfileShareKey) to THIS device's own local
  // state. existingRecordId = payload.recordId means this upserts by the SOURCE record's own id
  // — same "re-importing updates in place" convention Phase C's encounter transfer already
  // uses — so a fresh device importing for the first time ends up with providerRecordId pointed
  // at that same id, and a device re-importing a refreshed profile later doesn't duplicate it.
  // If this device already had its OWN different local provider record (e.g. it had started
  // onboarding independently before ever importing), that old record is left in place, unused,
  // rather than deleted — accepted v1 clutter rather than a destructive auto-merge/delete nobody
  // asked for. Reuses publish() to rebuild the flattened profile, write the localStorage
  // snapshots, flip everPublished, and sync the registered account's own contact fields — the
  // exact same side effects a normal first Publish already performs.
  function importProviderProfile(payload) {
    providerRecordId.value = saveDataRecord(payload.formId, payload.version, payload.data, payload.recordId);
    Object.assign(branding, payload.branding || {});
    saveBranding();
    dataVersion.value++;
    return publish();
  }

  return {
    PROVIDER_FORM_ID,
    registeredUser, branding, publishedClinic, providerRecordId, dataVersion,
    getProviderRecord, buildSeedFromRegistration, saveBranding, saveProviderRecord, ensureProviderRecord, buildClinicProfile, publish,
    importProviderProfile,
  };
});
