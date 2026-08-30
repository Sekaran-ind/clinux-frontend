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
// `groupLinkId` added for HOSPITAL_FIELDS specifically (SPEC-11) — DIFFERENT from `section`
// (which is purely AbdmFieldForm.vue's UI display grouping). Hospital's real data, unlike
// Staff's, is NOT one single YAML group: the compiled system-provider-composition-v1.yaml splits
// it across THREE separate non-repeating Organization blocks (`section_hospital`,
// `section_hospital_abdm_facility_type`, `section_hospital_abdm_location`) — confirmed by
// reading that file directly, not assumed. HospitalOnboarding.vue's save function needs
// `groupLinkId` to correctly split one flat AbdmFieldForm `values` object into 3 separate
// withGroupFields() writes; getting this wrong (as an earlier version of this file did — it
// silently wrote everything into `section_hospital` alone) means the ABDM-specific fields would
// persist somewhere buildClinicProfile()/abdmAdapter.js never look for them again.
//
// hospital_name/legalname/type/npi/website/address/city/state/pin/country/phone/whatsapp/email
// all live in `section_hospital` — onboarding.js's buildClinicProfile() already reads every one
// of them for ClinicHome's public page, but nothing wrote them before this file existed (the
// original HOSPITAL_FIELDS only had `hospital_name`) — including them here is this page's real
// job, not scope creep.
//
// Option lists below are a reasonable starter set, NOT yet pulled from ABDM's live master-data
// endpoints (clinuxflow-abdm-gateway already has these — hfrRoutes '/master/facility-types' etc,
// see docs/clinuxflow-abdm-integration-approach.md's "master data cache" section) — wiring that
// in depends on live ABDM sandbox connectivity this pass didn't verify. Flagged explicitly, same
// "known gap" discipline abdmAdapter.js's own comments already use, not silently assumed complete.

export const HOSPITAL_FIELDS = [
  // --- section_hospital / "Basics" ---
  { linkId: 'hospital_name', groupLinkId: 'section_hospital', label: 'Facility Name', type: 'text', required: true, section: 'Basics', help: 'The name your clinic is registered under — this is what patients and ABDM will see.' },
  { linkId: 'hospital_legalname', groupLinkId: 'section_hospital', label: 'Legal / Trade Name', type: 'text', required: false, section: 'Basics', help: 'Optional — only if different from the name above.' },
  {
    linkId: 'hospital_type', groupLinkId: 'section_hospital', label: 'Facility Type (general)', type: 'select', required: false, section: 'Basics',
    help: 'A general category for display purposes — separate from the HFR-specific Facility Type below.',
    options: [
      { value: 'Hospital', label: 'Hospital' },
      { value: 'Clinic', label: 'Clinic' },
      { value: 'Pharmacy', label: 'Pharmacy' },
      { value: 'Laboratory', label: 'Laboratory' },
      { value: 'Imaging Centre', label: 'Imaging Centre' },
    ],
  },
  { linkId: 'hospital_npi', groupLinkId: 'section_hospital', label: 'NPI / Registration No.', type: 'text', required: false, section: 'Basics', help: 'Optional — any existing registration number you already have.' },
  { linkId: 'hospital_website', groupLinkId: 'section_hospital', label: 'Website URL', type: 'text', required: false, section: 'Basics' },

  // --- section_hospital / "Contact & Address" ---
  { linkId: 'hospital_address', groupLinkId: 'section_hospital', label: 'Street Address', type: 'text', required: true, section: 'Contact & Address', help: 'Full street address.' },
  { linkId: 'hospital_city', groupLinkId: 'section_hospital', label: 'City', type: 'text', required: false, section: 'Contact & Address' },
  { linkId: 'hospital_state', groupLinkId: 'section_hospital', label: 'State', type: 'text', required: false, section: 'Contact & Address' },
  { linkId: 'hospital_pin', groupLinkId: 'section_hospital', label: 'PIN Code', type: 'text', required: true, section: 'Contact & Address', help: 'Your facility’s postal PIN code.' },
  { linkId: 'hospital_country', groupLinkId: 'section_hospital', label: 'Country', type: 'text', required: false, section: 'Contact & Address' },
  { linkId: 'hospital_phone', groupLinkId: 'section_hospital', label: 'Primary Phone', type: 'text', required: false, section: 'Contact & Address' },
  { linkId: 'hospital_whatsapp', groupLinkId: 'section_hospital', label: 'WhatsApp Number', type: 'text', required: false, section: 'Contact & Address' },
  { linkId: 'hospital_email', groupLinkId: 'section_hospital', label: 'Email Address', type: 'text', required: false, section: 'Contact & Address' },

  // --- section_hospital_abdm_facility_type / "Facility Type & Ownership" ---
  {
    linkId: 'hospital_ownership_code', groupLinkId: 'section_hospital_abdm_facility_type', label: 'Ownership', type: 'select', required: true, section: 'Facility Type & Ownership',
    help: 'Who legally owns this facility — needed for HFR registration.',
    options: [
      { value: 'G', label: 'Government' },
      { value: 'P', label: 'Private' },
      { value: 'T', label: 'Trust / NGO' },
    ],
  },
  {
    linkId: 'hospital_facility_type', groupLinkId: 'section_hospital_abdm_facility_type', label: 'Facility Type', type: 'select', required: true, section: 'Facility Type & Ownership',
    help: 'The closest match to what kind of facility this is, for HFR.',
    options: [
      { value: 'HOSPITAL', label: 'Hospital' },
      { value: 'CLINIC', label: 'Clinic' },
      { value: 'DIAGNOSTIC_CENTRE', label: 'Diagnostic Centre' },
      { value: 'NURSING_HOME', label: 'Nursing Home' },
    ],
  },
  { linkId: 'hospital_facility_subtype', groupLinkId: 'section_hospital_abdm_facility_type', label: 'Facility Sub-Type', type: 'text', required: false, section: 'Facility Type & Ownership', help: 'Optional — a more specific category, if one applies.' },
  {
    linkId: 'hospital_operational_status', groupLinkId: 'section_hospital_abdm_facility_type', label: 'Operational Status', type: 'select', required: true, section: 'Facility Type & Ownership',
    help: 'Whether this facility is currently open and seeing patients.',
    options: [
      { value: 'FUNCTIONAL', label: 'Functional' },
      { value: 'NON_FUNCTIONAL', label: 'Non-Functional' },
    ],
  },

  // --- section_hospital_abdm_location / "ABDM Location (LGD Codes)" ---
  // Fixed this session (docs/SPEC-12-ROOMS-AND-BOUNDED-CONTEXT-SLOT-FILLING.md §3, Defect 4):
  // these were plain `type: 'text'` despite each help string naming the exact HFR/LGD master
  // list the value must resolve against — a free-text "Tamil Nadu"/"Trichy" looks plausible to a
  // human and is still wrong for ABDM's Facility Registry, which needs the actual LGD code.
  //
  // `options` below are DEMO PLACEHOLDERS ONLY — deliberately non-numeric codes (e.g. `TN-DEMO`),
  // not real LGD codes. The real LGD dataset is government reference data (36 states/UTs, 700+
  // districts) this session did not verify field-by-field; inventing plausible-looking numeric
  // codes here would recreate the exact failure this fix is for — a value that LOOKS
  // authoritative but isn't. Wire to the real ABDM LGD master-data endpoint
  // (clinuxflow-abdm-gateway's hfrRoutes, same gap this file's header comment already flags for
  // the other option lists) before this is trustworthy for a real HFR submission.
  //
  // District is NOT yet cascaded by the selected state (AbdmFieldForm.vue's <select> rendering
  // has no concept of one field's options depending on another field's current value) — flat demo
  // list only, correct for the Tamil Nadu demo data this session's screenshots used, not general.
  // Real cascading is an open item (docs/SPEC-14-HFSM-RUNTIME-AND-CHAT-FIRST-CAPTURE.md §9).
  {
    linkId: 'hospital_state_lgd_code', groupLinkId: 'section_hospital_abdm_location', label: 'State', type: 'select', required: true, section: 'ABDM Location (LGD Codes)',
    help: "Your state's official LGD (Local Government Directory) code — used by ABDM to pinpoint your facility. Demo list — not the real LGD master data yet.",
    options: [
      { value: 'TN-DEMO', label: 'Tamil Nadu' },
      { value: 'KA-DEMO', label: 'Karnataka' },
      { value: 'MH-DEMO', label: 'Maharashtra' },
      { value: 'DL-DEMO', label: 'Delhi' },
    ],
  },
  {
    linkId: 'hospital_district_lgd_code', groupLinkId: 'section_hospital_abdm_location', label: 'District', type: 'select', required: true, section: 'ABDM Location (LGD Codes)',
    help: "Your district's LGD code. Demo list, not state-filtered yet — not the real LGD master data.",
    options: [
      { value: 'TRICHY-DEMO', label: 'Tiruchirappalli' },
      { value: 'CHENNAI-DEMO', label: 'Chennai' },
      { value: 'COIMBATORE-DEMO', label: 'Coimbatore' },
      { value: 'OTHER-DEMO', label: 'Other (not yet in demo list)' },
    ],
  },
  { linkId: 'hospital_subdistrict_lgd_code', groupLinkId: 'section_hospital_abdm_location', label: 'Sub-District', type: 'text', required: false, section: 'ABDM Location (LGD Codes)', help: 'Optional, if your area has one. Still free-text — lower risk while optional, same fix needed here eventually.' },
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
