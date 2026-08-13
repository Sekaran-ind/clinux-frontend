// Encounter-specific packing on top of sessionTransfer.js's generic encrypt/decrypt-to-string
// primitives. This is the "session sync between my own devices" / "share with a colleague at
// the same clinic" / "cross-clinic referral with consent" feature (Phase C of the mobile/sync
// roadmap) — see clinux-mobile-sync-multiuser-video-roadmap memory note for the full plan.
import { encodeSessionTransfer, decodeSessionTransfer } from './sessionTransfer.js';
import { saveDataRecord } from './collections/formData.js';
import { recordCrossClinicConsent, hasCrossClinicConsent } from './collections/encounterDocs.js';

const USER_KEY = 'cf_user';
function currentUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
}

// Only large binary attachments (images, prescription/PDF data URLs) are excluded from a
// transfer, and that happens for free, not via any stripping logic here — they live in their
// own encounterDocs.js collections keyed by encounterId, never inside the encounter's own
// formData record's QuestionnaireResponse tree. v1 limitation, same as the roadmap notes: a
// transferred session carries the Encounter/Vitals/SOAP/Prescription/Billing *form data* only.
export async function buildEncounterSharePayload(record) {
  const user = currentUser();
  const payload = {
    kind: 'encounter-session',
    v: 1,
    encounterId: record.id,
    formId: record.formId,
    version: record.version,
    sourceClinicId: record.clinicId ?? user?.clinicId ?? null,
    sourceClinicName: user?.clinicName || null,
    data: record.data,
  };
  const key = await encodeSessionTransfer(payload);
  return { key, payload };
}

// Decodes a scanned/pasted key into its payload WITHOUT importing it yet — the UI needs to see
// sourceClinicId first to decide whether to show a consent prompt before touching local storage.
export async function decodeEncounterShareKey(rawString) {
  const result = await decodeSessionTransfer(rawString);
  if (!result.ok) return result;
  if (!result.data || result.data.kind !== 'encounter-session') {
    return { ok: false, error: 'This key is valid but is not a ClinüxFlow session transfer.' };
  }
  return result;
}

// True when the payload's origin matches this device's own logged-in clinic — the "sync my own
// devices" and "share within the clinic/branch network" case from the roadmap. No consent
// needed: it's the same account's/clinic's own data coming back to it (or a teammate on the same
// clinic sending it directly), same trust boundary as any other write this app already makes.
export function isSameClinic(payload) {
  const myClinicId = currentUser()?.clinicId ?? null;
  return !!payload.sourceClinicId && payload.sourceClinicId === myClinicId;
}

// Cross-clinic transfers that were already explicitly consented to once (e.g. re-importing an
// updated version of a referral you already accepted) skip the prompt a second time.
export function alreadyConsented(payload) {
  return hasCrossClinicConsent(payload.encounterId, payload.sourceClinicId);
}

// Actually writes the imported record into the CURRENT device's own formData collection.
// existingRecordId = payload.encounterId means this upserts by the SOURCE record's own id — a
// second import of the same session (a refreshed sync, not a duplicate) updates it in place
// instead of creating a second local copy. saveDataRecord() stamps the record with THIS device's
// current clinicId (not the source's), same as any other locally-created record from this point
// on, so it shows up in this clinic's own Active Sessions list.
export function importEncounterSharePayload(payload) {
  const recordId = saveDataRecord(payload.formId, payload.version, payload.data, payload.encounterId);
  return { encounterId: recordId };
}

// Records the consent grant, then imports. Call only after the user has explicitly confirmed —
// never call this to auto-consent.
export function consentAndImport(payload) {
  const myClinicId = currentUser()?.clinicId ?? null;
  recordCrossClinicConsent(payload.encounterId, payload.sourceClinicId, myClinicId);
  return importEncounterSharePayload(payload);
}

// ---- Provider/Onboarding clinic-profile transfer -----------------------------------------
// Syncing YOUR OWN clinic's profile (Hospital/Staff/Services/Hours/Consents + branding) across
// your own devices or to a teammate's fresh one — the gap found while verifying Phase D: a
// teammate given a login on the same clinic gets the right clinicId, but never the clinic's
// actual published profile, since that lives only in whichever device ran Onboarding, never
// synced via login. UNLIKE the encounter case above, there is no legitimate cross-clinic
// version of this — importing a DIFFERENT clinic's profile into your own would just overwrite
// your own clinic's public page with a stranger's data, not a referral workflow worth consenting
// into. So this path has no consent step at all: same-clinic imports, everything else is
// rejected outright (see isSameClinic() above, reused as-is; the actual reject decision lives in
// the UI, SessionImportModal.vue, since there's nothing further to do here on a mismatch).

// The clinic's actual FHIR-ish record (Hospital/Staff/Services/Hours/Consents, one merged
// Provider-composition document) PLUS its branding, which — unlike vitals/prescriptions living
// inside the Encounter record — lives in a separate localStorage key (cf_onboarding_branding),
// not inside the Provider record's own QuestionnaireResponse tree. Passed in explicitly rather
// than read directly here so this module stays independent of the onboarding store.
export async function buildProviderProfileSharePayload(record, branding) {
  const user = currentUser();
  const payload = {
    kind: 'provider-profile',
    v: 1,
    recordId: record.id,
    formId: record.formId,
    version: record.version,
    sourceClinicId: record.clinicId ?? user?.clinicId ?? null,
    sourceClinicName: user?.clinicName || null,
    data: record.data,
    branding: branding || {},
  };
  const key = await encodeSessionTransfer(payload);
  return { key, payload };
}

export async function decodeProviderProfileShareKey(rawString) {
  const result = await decodeSessionTransfer(rawString);
  if (!result.ok) return result;
  if (!result.data || result.data.kind !== 'provider-profile') {
    return { ok: false, error: 'This key is valid but is not a ClinüxFlow clinic-profile transfer.' };
  }
  return result;
}
