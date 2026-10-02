// What the HPR and HFR journeys produce: FHIR resources on the ClinuxFlow profiles, validated by
// clinuxflow-fhir-api ($validate?profile=) and kept on this device.
//
//   HPR -> Practitioner  on ClinuxFlowProvider  (ABDM IG Practitioner)
//   HFR -> Organization  on ClinuxFlowFacility  (ABDM IG Organization)
//
// The profiles' required slices were read from the validator's own messages against the live
// fhir-api (2026-09-30). Their extension definitions aren't published yet (fhir-api reports them
// under missingExtensionDefinitions), so the value types here are this app's choice: valueCode
// for codes, valueDecimal for coordinates, valueBoolean for flags. The ABDM IG itself fixes
// Organization.type to HL7 organization-type and address.country to "India".
export const PROFILE = {
    provider: 'https://clinux.yaxb.ai/fhir/StructureDefinition/ClinuxFlowProvider',
    facility: 'https://clinux.yaxb.ai/fhir/StructureDefinition/ClinuxFlowFacility',
};
export const HPR_ID_SYSTEM = 'https://doctor.ndhm.gov.in';
export const HFR_ID_SYSTEM = 'https://facility.ndhm.gov.in';
export const CLINIC_SYSTEM = 'https://clinux.yaxb.ai/fhir/sid/clinic';
const SD = 'https://clinux.yaxb.ai/fhir/StructureDefinition/';
const PRN = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PRN', display: 'Provider number' }] };
// The ABDM IG's own Practitioner example types the HPR id as v2-0203 MD; identifier.type is min 1 in the IG.
const MD = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MD', display: 'Medical License number' }] };

const ext = (name, value) => {
    if (value === undefined || value === null || value === '') return null;
    const key = typeof value === 'boolean' ? 'valueBoolean' : typeof value === 'number' ? 'valueDecimal' : 'valueCode';
    return { url: SD + name, [key]: value };
};
const exts = (...list) => list.filter(Boolean);

/** A Practitioner for the person's HPR identity. `p` holds what the journey collected. */
export function providerResource(p, { id = crypto.randomUUID() } = {}) {
    // A linked HPR ID comes with a full name only; split it so name.given (required) is filled.
    if (!p.firstName && p.name) {
        const parts = String(p.name).trim().split(/\s+/);
        p = { ...p, firstName: parts[0], middleName: parts.slice(1, -1).join(' '), lastName: parts.length > 1 ? parts.at(-1) : '' };
    }
    const given = [p.firstName, p.middleName].filter(Boolean);
    return {
        resourceType: 'Practitioner',
        id,
        meta: { profile: [PROFILE.provider] },
        extension: exts(
            ext('hpr-source-type', p.sourceType),
            ext('hpr-category-code', p.category),
            ext('hpr-subcategory-code', p.subCategory),
            ext('hpr-registered-with-council', p.council),
            ext('hpr-jurisdiction-state-code', p.stateCode),
            ext('hpr-jurisdiction-district-code', p.districtCode),
        ),
        identifier: [{ type: MD, system: HPR_ID_SYSTEM, value: p.hprIdNumber || p.hprId }],
        active: true,
        name: [{ text: p.name || [...given, p.lastName].filter(Boolean).join(' '), ...(given.length ? { given } : {}), ...(p.lastName ? { family: p.lastName } : {}) }],
        telecom: [...(p.email ? [{ system: 'email', value: p.email }] : []), ...(p.mobile ? [{ system: 'phone', value: p.mobile, use: 'mobile' }] : [])],
    };
}

/** An Organization for the facility, from the HFR journey's answers and HFR's ids. */
export function facilityResource(f, { clinicId, facilityTypeLabel, trackingId, facilityId, id = crypto.randomUUID() }) {
    return {
        resourceType: 'Organization',
        id,
        meta: { profile: [PROFILE.facility] },
        extension: exts(
            ext('hfr-state-lgd-code', f.state),
            ext('hfr-district-lgd-code', f.district),
            ext('hfr-subdistrict-lgd-code', f.subdistrict),
            ext('hfr-facility-region', f.region),
            ext('hfr-speciality-type-code', f.specialityType),
            ext('hfr-geolocation-latitude', Number(f.latitude)),
            ext('hfr-geolocation-longitude', Number(f.longitude)),
            ext('hfr-ownership-code', f.ownership),
            ext('hfr-ownership-subtype-code', f.ownershipSubType),
            ext('hfr-ownership-subtype-code-2', f.ownershipSubType2),
            ext('hfr-facility-type', f.facilityType),
            ext('hfr-facility-subtype', f.facilitySubType),
            ...(f.systemsOfMedicine || []).map((code) => ext('hfr-system-of-medicine', code)),
            ext('hfr-operational-status-code', 'F'),
            ext('hfr-tracking-id', trackingId),
        ),
        // The ABDM IG requires identifier.type; both are provider numbers (HL7 v2-0203 PRN).
        identifier: [{ type: PRN, system: CLINIC_SYSTEM, value: clinicId }, ...(facilityId ? [{ type: PRN, system: HFR_ID_SYSTEM, value: facilityId }] : [])],
        active: true,
        // The ABDM IG fixes the coding system to HL7 organization-type; HFR's own facility type
        // goes in the hfr-facility-type extension above and in the text here.
        type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'prov', display: 'Healthcare Provider' }], text: facilityTypeLabel }],
        name: f.facilityName,
        telecom: [...(f.phone ? [{ system: 'phone', value: f.phone, use: 'work' }] : []), ...(f.email ? [{ system: 'email', value: f.email }] : [])],
        address: [{ line: [f.addressLine1], city: f.city, postalCode: f.pincode, country: 'India' }],
    };
}

/**
 * Validates `resource` against `profile` on fhir-api. Never throws: an unreachable API gives
 * { status: 'pending' } so the result is kept and can be checked again later.
 */
export async function validateResource(api, resource, profile) {
    try {
        const res = await api(`/$validate?profile=${encodeURIComponent(profile)}`, { method: 'POST', body: resource });
        if (res.status !== 200) return { status: 'pending', issues: [] };
        const issues = (res.data?.issue || []).filter((i) => i.severity === 'error' || i.severity === 'fatal').map((i) => i.diagnostics);
        return { status: issues.length ? 'invalid' : 'valid', issues, checkedAt: new Date().toISOString() };
    } catch {
        return { status: 'pending', issues: [] };
    }
}

/** Validates and stores a journey's FHIR resource under `key`; returns a result fact. */
export async function keepResource(d, key, resource, profile) {
    const validation = await validateResource(d.api, resource, profile);
    await d.records.set(key, { resource, validation });
    const name = profile.split('/').pop();
    if (validation.status === 'valid') return ['FHIR', `${resource.resourceType} valid against ${name}`];
    if (validation.status === 'pending') return ['FHIR', `${resource.resourceType} saved; validation pending (FHIR API unreachable)`];
    return ['FHIR', `${resource.resourceType} saved, incomplete for ${name}: ${validation.issues.slice(0, 3).join('; ')}`];
}
