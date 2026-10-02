// Digital provenance, local-first: every write this workspace makes (a form save, a registry
// journey's outcome) gets a FHIR R4 Provenance saying who made it, on whose behalf, from what, and
// when. Built and kept on this device; published to clinuxflow-api only on the paid plan
// (publishPending below), so the free tier adds no server compute or storage.
//
// Who: the verified professional — the account's HPR ID (https://doctor.ndhm.gov.in) once the HPR
// journey has linked one — else the ClinuxFlow account. On behalf of: the facility (the clinic, and
// its HFR id once registered). The ABDM IG profiles no Provenance, so these follow ClinuxFlow's
// own ClinuxFlowProvenance (clinuxflow-fhir-api/profiles), on base R4.
export const PROVENANCE_PROFILE = 'https://clinux.yaxb.ai/fhir/StructureDefinition/ClinuxFlowProvenance';
export const ACCOUNT_SYSTEM = 'https://clinux.yaxb.ai/fhir/sid/account';
export const CLINIC_SYSTEM = 'https://clinux.yaxb.ai/fhir/sid/clinic';
export const HPR_SYSTEM = 'https://doctor.ndhm.gov.in';
export const HFR_SYSTEM = 'https://facility.ndhm.gov.in';
const DATA_OPERATION = 'http://terminology.hl7.org/CodeSystem/v3-DataOperation';
const PARTICIPANT = 'http://terminology.hl7.org/CodeSystem/provenance-participant-type';

const ACTIVITY = { create: 'CREATE', update: 'UPDATE', delete: 'DELETE' };

/**
 * @param {{ targets: string[], activity: 'create'|'update'|'delete', account: object,
 *           hprId?: string, hfrFacilityId?: string, source?: string, reason?: string,
 *           now?: Date, id?: string }} p  targets/source are relative references ("Patient/123",
 *           "QuestionnaireResponse/rec-1"); the account is the signed-in ClinuxFlow account.
 */
export function buildProvenance({ targets, activity, account, hprId, hfrFacilityId, source, reason, now = new Date(), id = crypto.randomUUID() }) {
  if (!targets?.length) throw new Error('Provenance needs at least one target');
  const who = hprId
    ? { identifier: { system: HPR_SYSTEM, value: hprId }, display: account.adminName || account.email }
    : { identifier: { system: ACCOUNT_SYSTEM, value: account.id }, display: account.adminName || account.email };
  const onBehalfOf = hfrFacilityId
    ? { identifier: { system: HFR_SYSTEM, value: hfrFacilityId }, display: account.clinicName }
    : { identifier: { system: CLINIC_SYSTEM, value: account.clinicId }, display: account.clinicName };
  const code = ACTIVITY[activity] || 'UPDATE';
  return {
    resourceType: 'Provenance',
    id,
    meta: { profile: [PROVENANCE_PROFILE] },
    // A target is a relative reference ("QuestionnaireResponse/rec-1") or a logical one by
    // identifier ({ system, value } — e.g. an HPR ID before any local resource id exists).
    target: targets.map((t) => (typeof t === 'string' ? { reference: t } : { identifier: t })),
    recorded: now.toISOString(),
    activity: { coding: [{ system: DATA_OPERATION, code, display: code.charAt(0) + code.slice(1).toLowerCase() }] },
    agent: [{
      type: { coding: [{ system: PARTICIPANT, code: 'author', display: 'Author' }] },
      who,
      onBehalfOf,
    }],
    ...(source ? { entity: [{ role: 'source', what: { reference: source } }] } : {}),
    ...(reason ? { reason: [{ text: reason }] } : {}),
  };
}
