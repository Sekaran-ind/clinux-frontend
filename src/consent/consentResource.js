// Copied unchanged from clinux-cubo (src/consent/consentResource.js) so the workspace and Cübo ask for, and record,
// exactly the same consents. Change the wording there first, then copy it here.
// FHIR R4 Consent resources for the terms a provider accepts in Cübo. One Consent per term, so
// each can be withdrawn on its own. The provider is the performer (the one consenting); there is
// no patient on these resources, since they are the provider's own agreement.
import { TERMS_VERSION } from './terms.js';

export const IDENTIFIER_SYSTEM = 'https://clinux.yaxb.ai/fhir/sid/cubo-consent';
export const ACCOUNT_SYSTEM = 'https://clinux.yaxb.ai/fhir/sid/account';
export const CLINIC_SYSTEM = 'https://clinux.yaxb.ai/fhir/sid/clinic';

const SCOPE = { terminology: 'treatment', 'personal-data': 'patient-privacy' };

export function buildConsent(term, account, { now = new Date(), id = crypto.randomUUID() } = {}) {
    const at = now.toISOString();
    return {
        resourceType: 'Consent',
        id,
        identifier: [{ system: IDENTIFIER_SYSTEM, value: `${term.key}|${TERMS_VERSION}` }],
        status: 'active',
        scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: SCOPE[term.key] }] },
        // LOINC 57016-8: privacy policy acknowledgment document.
        category: [{ coding: [{ system: 'http://loinc.org', code: '57016-8', display: 'Privacy policy acknowledgment Document' }], text: term.title }],
        dateTime: at,
        performer: [{ identifier: { system: ACCOUNT_SYSTEM, value: account.id }, display: account.adminName || account.email }],
        organization: [{ identifier: { system: CLINIC_SYSTEM, value: account.clinicId }, display: account.clinicName }],
        policy: [{ uri: `${term.policyUri}?version=${TERMS_VERSION}` }],
        provision: {
            type: 'permit',
            period: { start: at },
            action: term.actions.map((code) => ({ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentaction', code }] })),
            purpose: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT', display: 'treatment' }],
        },
    };
}

/** The same Consent, withdrawn: inactive, with the permission's period closed. */
export function withdrawConsent(consent, { now = new Date() } = {}) {
    return {
        ...consent,
        status: 'inactive',
        provision: { ...consent.provision, period: { ...consent.provision.period, end: now.toISOString() } },
    };
}

/** Does this stored Consent cover the term at the current version? */
export function isCurrent(consent, termKey) {
    return consent?.status === 'active' && consent.identifier?.[0]?.value === `${termKey}|${TERMS_VERSION}`;
}
