// Copied unchanged from clinux-cubo (src/consent/terms.js) so the workspace and Cübo ask for, and record,
// exactly the same consents. Change the wording there first, then copy it here.
// The two consents Cübo asks for before the workspace opens. Bump TERMS_VERSION whenever the
// wording changes: an accepted consent only counts for the version it was given for, so every
// user is asked again after a change.
export const TERMS_VERSION = '2026-09-30';

// SNOMED CT notice required by the IHTSDO Affiliate Licence (clause 8.3), as served by
// clinuxflow-fhir-api with every SNOMED-derived expansion.
export const SNOMED_NOTICE =
    'This material includes SNOMED Clinical Terms® (SNOMED CT®) which is used by permission of the International Health Terminology Standards Development Organisation (IHTSDO). All rights reserved. SNOMED CT®, was originally created by The College of American Pathologists. "SNOMED" and "SNOMED CT" are registered trademarks of the IHTSDO.';

export const CONSENTS = [
    {
        key: 'terminology',
        title: 'Use of terminology services',
        policyUri: 'https://clinux.yaxb.ai/policy/terminology-use',
        actions: ['use'],
        summary: 'Clinical code lookups (SNOMED CT, LOINC, ICD-10 and the ABDM value sets) for documenting care.',
        points: [
            'SNOMED CT content is provided under the licence India holds through NRCeS, the National Release Centre. You may use it only for clinical documentation and health-data exchange in India.',
            'You will not copy, export or redistribute substantial parts of the terminology, or use it to build another terminology product.',
            'Lookups are sent to the ClinuxFlow FHIR API with your sign-in, so the terminology is served only to signed-in, consenting users.',
            'HL7 terminology (THO) is CC0. ABDM value sets are published by NRCeS for the ABDM Implementation Guide.',
        ],
        notice: SNOMED_NOTICE,
    },
    {
        key: 'personal-data',
        title: 'Personal data for clinical use',
        policyUri: 'https://clinux.yaxb.ai/policy/personal-data-clinical-use',
        actions: ['collect', 'use', 'access'],
        summary: 'How Cübo handles your details and the patient data you record, under the Digital Personal Data Protection Act, 2023.',
        points: [
            'Purpose: providing and documenting clinical care, and the ABDM, ABHA and UHI workflows you start. Nothing is used for advertising or sold.',
            'Your account details (name, email, role, clinic) are stored by ClinuxFlow to sign you in and to let colleagues and linked facilities contact you.',
            'Clinical records you create are stored on this device first. They are sent to ClinuxFlow only to be checked against FHIR and ABDM rules, and are not kept by that check.',
            'Chat messages go directly between devices (peer-to-peer) and are never stored on a server. Video calls run through Cloudflare RealtimeKit and are not recorded.',
            'Data is shared with ABDM or UHI only when you run a step that sends it, such as HPR or HFR registration or publishing to UHI, and each step says what it sends.',
            'You can withdraw this consent at any time from your profile menu. Cübo then stops working for your account until you consent again. Data already stored stays until you ask for it to be erased.',
        ],
    },
];
