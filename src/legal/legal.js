// What the footer and the /legal page say — adapted from clinux-cubo's src/legal/legal.js (and
// cubo-diary's, for records and documents) for the clinic workspace. Terms and Privacy reuse the
// consent text people accept (src/consent/terms.js, copied unchanged from Cübo), so the page can
// never say something different from what was agreed to.
//
// Affiliations are stated as they stand: an ABDM sandbox integration is not ABDM certification,
// and a standard or library we use is not an endorsement. Only what this app actually uses is
// listed. Update this file when that changes.
import { CONSENTS, SNOMED_NOTICE, TERMS_VERSION } from '../consent/terms.js';

export const OPERATOR = 'YAXB Technologies Pvt. Ltd.';
export const PRODUCT = 'ClinüxFlow';
export const CONTACT = import.meta.env.VITE_PRIVACY_CONTACT || 'helpdesk@yaxb.ai';
export const UPDATED = TERMS_VERSION;

const terminology = CONSENTS.find((c) => c.key === 'terminology');
const personalData = CONSENTS.find((c) => c.key === 'personal-data');

export const AFFILIATIONS = {
  intro: 'ClinüxFlow works with these national programmes and standards. Being listed here does not mean they endorse ClinuxFlow.',
  programmes: [
    {
      name: 'Ayushman Bharat Digital Mission (ABDM), National Health Authority',
      detail: 'Registers professionals with HPR, facilities with HFR, and finds, links or creates patients’ ABHA, through the ABDM sandbox. ClinuxFlow is not yet certified by ABDM for production.',
      url: 'https://abdm.gov.in',
    },
    {
      name: 'NRCeS, National Resource Centre for EHR Standards',
      detail: 'Records are checked against the ABDM FHIR profiles published by NRCeS. SNOMED CT is used under the licence India holds through NRCeS as the National Release Centre.',
      url: 'https://www.nrces.in',
    },
  ],
  standards: [
    { name: 'HL7 FHIR R4', detail: 'Patients, practitioners, facilities and consents are FHIR resources on the ClinuxFlow and ABDM profiles.', url: 'https://hl7.org/fhir/R4/' },
    { name: 'SNOMED CT', detail: SNOMED_NOTICE, url: 'https://www.snomed.org' },
    { name: 'LHC-Forms', detail: 'Forms are rendered with the U.S. National Library of Medicine’s LHC-Forms.', url: 'https://lhcforms.nlm.nih.gov' },
    { name: 'Wikidata', detail: 'Form fields can be tagged with Wikidata concepts (data available under CC0).', url: 'https://www.wikidata.org' },
  ],
  builtWith: [
    { name: 'OpenStreetMap', detail: 'Map data © OpenStreetMap contributors, available under the Open Database License.', url: 'https://www.openstreetmap.org/copyright' },
    { name: 'Leaflet', detail: 'BSD-2-Clause.', url: 'https://leafletjs.com' },
    { name: 'LangGraph', detail: 'LangChain, MIT. Runs the registry journeys.', url: 'https://github.com/langchain-ai/langgraphjs' },
    { name: 'Cloudflare RealtimeKit', detail: 'Video calls.', url: 'https://developers.cloudflare.com/realtime/' },
    { name: 'Cornerstone.js', detail: 'DICOM image viewing. MIT.', url: 'https://www.cornerstonejs.org' },
    { name: 'AG Grid Community', detail: 'Data tables. MIT.', url: 'https://www.ag-grid.com' },
    { name: 'jsPDF and node-qrcode', detail: 'Visit summaries as PDF with a QR. MIT.', url: 'https://github.com/parallax/jsPDF' },
  ],
};

export const TERMS = {
  summary: 'For registered healthcare providers and their staff in India. You answer for what you submit to ABDM. ClinüxFlow supports your work; it does not make clinical decisions.',
  sections: [
    {
      title: 'Who may use ClinüxFlow',
      points: [
        `${PRODUCT} is provided by ${OPERATOR} for clinics and hospitals in India: facility administrators, doctors, nurses, front-desk staff and affiliated practitioners.`,
        'Keep your sign-in to yourself. Anything done with your account is taken to be done by you, and the Activity log records it.',
      ],
    },
    {
      title: 'What you submit to ABDM',
      points: [
        'HPR and HFR registrations, and the ABHA you create or link for a patient, go to national registries in your name or your facility’s. Submit only information that is true and that you are entitled to submit, with the patient’s consent where a step asks for it.',
        'Submitting an HFR registration is an attestation by the facility manager that the facility details are correct.',
        'The ABDM connection currently runs against the ABDM sandbox. Registrations there are for testing and do not create production records.',
      ],
    },
    { title: terminology.title, points: terminology.points },
    {
      title: 'Clinical responsibility',
      points: [
        'ClinüxFlow helps you register patients, document visits, check records and reach colleagues. It is not a medical device, and clinical decisions remain yours.',
        'Validation results and suggestions can be wrong or incomplete. Check anything that matters.',
      ],
    },
    {
      title: 'Changes',
      points: [
        `These terms are version ${TERMS_VERSION}. When they change, ClinüxFlow asks you to accept them again before you continue.`,
        `Questions: ${CONTACT}.`,
      ],
    },
  ],
};

export const PRIVACY = {
  summary: 'Clinical records stay on your clinic’s devices first. Your account sits with ClinuxFlow; ABDM gets only what a step you run sends. You can withdraw consent at any time.',
  sections: [
    { title: personalData.title, points: personalData.points },
    {
      title: 'Where your data is',
      points: [
        'On this device (or your clinic’s own server, in Live Server mode): patient records, visits, your consents and what the registry journeys produced (HPR ID, HFR ids). Every record is tied to your clinic and account, so clinics sharing a browser never see each other’s data. Protect the device with a screen lock.',
        'With ClinuxFlow: your account (name, email, role, clinic), the links between facilities and practitioners, and the Activity log and ABDM transaction log (identifiers and statuses only, never payloads). On the paid plan, encounters and patient records are also kept in ClinuxFlow’s cloud so they sync between devices.',
        'In memory only, never stored: Aadhaar numbers, OTPs, HPR passwords and ABDM tokens used during a journey.',
      ],
    },
    {
      title: 'Maps',
      points: ['The facility map shows OpenStreetMap tiles. Loading them tells OpenStreetMap’s servers roughly which area is being shown.'],
    },
    {
      title: 'Your rights',
      points: [
        'Under the Digital Personal Data Protection Act, 2023, you can ask for a summary of the personal data we hold about you, have it corrected or erased, nominate someone to act for you, and raise a grievance.',
        `Write to ${CONTACT}. If you are not satisfied with our response, you can complain to the Data Protection Board of India.`,
      ],
    },
  ],
};
