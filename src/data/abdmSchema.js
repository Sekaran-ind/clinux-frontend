// Canonical field schema for Provider (Hospital/Facility) and Staff registration — SPEC-09
// (docs/SPEC-09-ABDM-ANCHORED-ONBOARDING-REBUILD.md). Field set is driven by what
// abdmAdapter.js's existing HFR/HPR builders already read (verified against the real gateway
// routes) — promoted from "fields an adapter happens to use" to the actual schema this data is
// captured against, rather than the generic system-provider-composition-v1 YAML/LForms form
// these were previously extracted from. Same linkIds as before on purpose, so every existing
// reader (getAnswer/getAnswers, abdmAdapter.js, onboarding.js's buildClinicProfile,
// formSlotEngine.js) keeps working unchanged — only how these fields get CAPTURED changes.
//
// `section` + `help` added deliberately, not decoration — "make the new journeys very user
// friendly" was a real, explicit requirement that got dropped while fixing the underlying data-
// loss bug (see clinux-lforms-coded-field-data-loss-bug memory note). Grouping related fields and
// explaining them in plain language instead of raw registry jargon (e.g. "HP Category" alone
// means nothing to a first-time user) is the concrete fix, not a nice-to-have on top.
//
// Option lists below are a reasonable starter set, NOT yet pulled from ABDM's live master-data
// endpoints (clinuxflow-abdm-gateway already has these — hfrRoutes '/master/facility-types' etc,
// see docs/clinuxflow-abdm-integration-approach.md's "master data cache" section) — wiring that
// in depends on live ABDM sandbox connectivity this pass didn't verify. Flagged explicitly, same
// "known gap" discipline abdmAdapter.js's own comments already use, not silently assumed complete.

export const HOSPITAL_FIELDS = [
  { linkId: 'hospital_name', label: 'Facility Name', type: 'text', required: true, section: 'Basics', help: 'The name your clinic is registered under — this is what patients and ABDM will see.' },
  {
    linkId: 'hospital_ownership_code', label: 'Ownership', type: 'select', required: true, section: 'Basics',
    help: 'Who legally owns this facility — needed for HFR registration.',
    options: [
      { value: 'G', label: 'Government' },
      { value: 'P', label: 'Private' },
      { value: 'T', label: 'Trust / NGO' },
    ],
  },
  {
    linkId: 'hospital_facility_type', label: 'Facility Type', type: 'select', required: true, section: 'Basics',
    help: 'The closest match to what kind of facility this is.',
    options: [
      { value: 'HOSPITAL', label: 'Hospital' },
      { value: 'CLINIC', label: 'Clinic' },
      { value: 'DIAGNOSTIC_CENTRE', label: 'Diagnostic Centre' },
      { value: 'NURSING_HOME', label: 'Nursing Home' },
    ],
  },
  { linkId: 'hospital_facility_subtype', label: 'Facility Sub-Type', type: 'text', required: false, section: 'Basics', help: 'Optional — a more specific category, if one applies.' },
  {
    linkId: 'hospital_operational_status', label: 'Operational Status', type: 'select', required: true, section: 'Basics',
    help: 'Whether this facility is currently open and seeing patients.',
    options: [
      { value: 'FUNCTIONAL', label: 'Functional' },
      { value: 'NON_FUNCTIONAL', label: 'Non-Functional' },
    ],
  },
  { linkId: 'hospital_state_lgd_code', label: 'State', type: 'text', required: true, section: 'Location', help: "Your state's official LGD (Local Government Directory) code — used by ABDM to pinpoint your facility." },
  { linkId: 'hospital_district_lgd_code', label: 'District', type: 'text', required: true, section: 'Location', help: "Your district's LGD code." },
  { linkId: 'hospital_subdistrict_lgd_code', label: 'Sub-District', type: 'text', required: false, section: 'Location', help: 'Optional, if your area has one.' },
  { linkId: 'hospital_pin', label: 'PIN Code', type: 'text', required: true, section: 'Location', help: 'Your facility’s postal PIN code.' },
  { linkId: 'hospital_address', label: 'Address', type: 'text', required: true, section: 'Location', help: 'Full street address.' },
];

export const STAFF_FIELDS = [
  { linkId: 'staff_first_name', label: 'First Name (as on Aadhaar)', type: 'text', required: true, section: 'About You', help: 'Must match your Aadhaar exactly — ABDM verifies against it.' },
  { linkId: 'staff_middle_name', label: 'Middle Name', type: 'text', required: false, section: 'About You', help: 'Optional — leave blank if you don’t have one.' },
  { linkId: 'staff_last_name', label: 'Last Name (as on Aadhaar)', type: 'text', required: true, section: 'About You', help: 'Must match your Aadhaar exactly.' },
  { linkId: 'staff_email', label: 'Email', type: 'text', required: true, section: 'About You', help: 'Where we’ll reach you about your registration.' },
  {
    linkId: 'staff_specialty', label: 'Specialty', type: 'text', required: false, section: 'Your Practice',
    // Free text, not select — this is exactly the field SPEC-06's Wikidata tagging (§6) enriches
    // after the fact; forcing a closed option list here would work against that, not with it.
    help: 'E.g. "Cardiology" or "General Medicine" — type freely, you’ll be able to confirm a standard match after saving.',
  },
  {
    linkId: 'staff_hp_category_code', label: 'Professional Category', type: 'select', required: true, section: 'Your Practice',
    help: 'The broad category ABDM’s Healthcare Professionals Registry sorts you under.',
    options: [
      { value: 'A', label: 'Doctor' },
      { value: 'B', label: 'Nurse' },
      { value: 'C', label: 'Allied Healthcare Professional' },
    ],
  },
  { linkId: 'staff_hp_subcategory_code', label: 'More Specific Category', type: 'text', required: false, section: 'Your Practice', help: 'Optional — a finer-grained category, if applicable.' },
  { linkId: 'staff_state_code', label: 'State', type: 'text', required: true, section: 'Registration Details', help: 'The state your professional registration is under.' },
  { linkId: 'staff_district_code', label: 'District', type: 'text', required: false, section: 'Registration Details', help: 'Optional.' },
  { linkId: 'staff_council', label: 'I’m registered with a State Medical Council', type: 'checkbox', required: false, section: 'Registration Details' },
  {
    linkId: 'staff_abdm_role', label: 'Your Role in ABDM', type: 'select', required: true, section: 'Registration Details',
    help: 'How you’ll act within the ABDM ecosystem — most clinicians pick Doctor or Nurse.',
    options: [
      { value: 'DOCTOR', label: 'Doctor' },
      { value: 'NURSE', label: 'Nurse' },
      { value: 'FACILITY_MANAGER', label: 'Facility Manager' },
    ],
  },
];

export function getFieldSet(kind) {
  if (kind === 'hospital') return HOSPITAL_FIELDS;
  if (kind === 'staff') return STAFF_FIELDS;
  throw new Error(`Unknown ABDM field set: "${kind}" (expected "hospital" or "staff")`);
}

// Groups a flat field list into its declared sections, preserving first-seen section order —
// what AbdmFieldForm.vue actually renders, instead of one long undifferentiated list.
export function groupFieldsBySection(fields) {
  const order = [];
  const bySection = new Map();
  fields.forEach((f) => {
    const key = f.section || 'Details';
    if (!bySection.has(key)) { bySection.set(key, []); order.push(key); }
    bySection.get(key).push(f);
  });
  return order.map((section) => ({ section, fields: bySection.get(section) }));
}
