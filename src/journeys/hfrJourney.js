// HFR (Health Facility Registry) journey: register a facility with ABDM through
// clinuxflow-abdm-gateway's /hfr routes.
//
//   begin --draft saved--> resume --submit--> submit
//         --otherwise----> needLogin? --> managerLogin
//                          -> loadBasics -> facility -> loadDependent -> classify
//                          -> loadLocation -> location (+ duplicate search) -> review -> submit -> done
//
// HFR creation needs the Facility Manager's own HPR token (x-hprid-auth) for Basic Information
// and Submit. If this session already signed in to HPR (the HPR journey), that token is reused.
//
// This covers Basic Information and Submit, which is what HFR needs to issue a facility id.
// Additional and Detailed Information (infrastructure, pharmacy, blood bank, linked programmes)
// are optional follow-ups and stay in clinux-frontend's Facility page for now.
import spec from './specs/hfr.journey.json' with { type: 'json' };
import { toOptions } from './gateway.js';
import { PROFILE, facilityResource, keepResource } from './fhir.js';

export const HFR_RECORD = 'abdm:hfr';
export const FACILITY_RESOURCE = 'fhir:facility';

const post = (gateway, path, body, headers) => gateway(path, { method: 'POST', body, headers });
const q = encodeURIComponent;
export const FACILITY_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9 ]*$';
/** A clinic name in the form HFR accepts: apostrophes go, other punctuation becomes a space ("Dr. Rao's Clinic" -> "Dr Raos Clinic"). */
export const hfrName = (name = '') => String(name).replace(/['’]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:[^A-Za-z]\S*\s*)+/, '');

const SPECIALITY_TYPES = [
    { value: 'SINGLE', label: 'Single speciality' },
    { value: 'MULTI', label: 'Multi speciality' },
];
// Ownership has two levels. Level 1 (ownershipSubTypeCode) is a fixed code per ownership; the
// sandbox serves no master for it (get-master-data type=OWNER-SUBTYPE answers HIS-4056) and
// get-owner-subtype says "It should be one of C, P, or NP". "S" (state government) comes from the
// HFR API doc's own basic-information sample. Level 2 (ownershipSubTypeCode2) is what
// get-owner-subtype returns for (ownershipCode, level 1): ministries for G+C, PROFIT-TYPE for P,
// NON-PROFIT-TYPE for NP. State government has no level 2. All checked live on 2026-09-30.
const FOR_PROFIT = [
    { value: 'P', label: 'For profit' },
    { value: 'NP', label: 'Not for profit' },
];
export const OWNERSHIP_SUBTYPES = {
    G: [
        { value: 'C', label: 'Central government' },
        { value: 'S', label: 'State government' },
    ],
    P: FOR_PROFIT,
    PP: FOR_PROFIT,
};

const REGIONS = [
    { value: 'U', label: 'Urban' },
    { value: 'R', label: 'Rural' },
];

/** The Basic Information body HFR expects, from the answers collected in this journey. */
export function buildBasicInformation(f) {
    return {
        facilityInformation: {
            facilityName: f.facilityName,
            facilityAddressDetails: {
                country: 'India',
                stateLGDCode: f.state,
                districtLGDCode: f.district,
                subDistrictLGDCode: f.subdistrict,
                facilityRegion: f.region || 'U',
                villageCityTownLGDCode: '',
                addressLine1: f.addressLine1,
                addressLine2: f.city || '',
                pincode: f.pincode,
                latitude: f.latitude,
                longitude: f.longitude,
            },
            facilityContactInformation: {
                facilityEmailId: f.email || '',
                facilityContactNumber: f.phone || '',
                websiteLink: '',
                facilityLandlineNumber: '',
                facilityStdCode: '',
            },
            ownershipCode: f.ownership,
            ownershipSubTypeCode: f.ownershipSubType,
            ownershipSubTypeCode2: f.ownershipSubType2 || undefined,
            specialityTypeCode: f.specialityType || 'SINGLE',
            // HFR wants one comma-joined string, e.g. "M,D".
            systemOfMedicineCode: (f.systemsOfMedicine || []).join(','),
            facilityTypeCode: f.facilityType,
            facilitySubType: f.facilitySubType || undefined,
            facilityUploads: { facilityBoardPhoto: { name: '', value: '' }, facilityBuildingPhoto: { name: '', value: '' } },
            facilityAddressProof: [],
            facilityOperationalStatus: 'F',
            timingsOfFacility: [],
            abdmCompliantSoftware: [{ existingSoftwares: [], anyOther: 'ClinuxFlow' }],
        },
    };
}

function hprHeader(d) {
    const t = d.vault.hpr(d.account.id);
    if (!t) throw new Error('Your HPR sign-in has expired. Start this journey again to sign in.');
    return { 'X-HPRID-Auth-Token': t.token };
}

// The journey: its JSON (steps and transitions) plus the named handlers below, run by engine.js
// on XState. id/title/summary/icon come from the JSON.
export const hfrJourney = {
    spec,
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    icon: spec.icon,
    roles: ['hospital_admin', 'admin_and_health_professional'],

    prompts: {
        resume: (s) => ({
            text: `You have an HFR draft for ${s.data.saved.facilityName} (tracking id ${s.data.saved.trackingId}) that has not been submitted.`,
            choices: [
                { value: 'submit', label: 'Submit the draft', detail: 'Needs your Facility Manager HPR sign-in' },
                { value: 'new', label: 'Start a new facility' },
            ],
        }),
        managerLogin: () => ({
            text: 'HFR registration is done by the facility manager. Sign in with the HPR ID that holds the Facility Manager role.',
            fields: [
                { name: 'hprId', label: 'HPR ID', placeholder: 'name@hpr.abdm', required: true },
                { name: 'password', label: 'HPR password', type: 'password', secret: true, required: true },
            ],
            submitLabel: 'Sign in',
        }),
        facility: (s) => ({
            text: 'About the facility.',
            fields: [
                // HFR takes only letters, digits and spaces, starting with a letter (its doc; search answers
                // HIS-4029 for anything else, checked live 2026-10-01).
                { name: 'facilityName', label: 'Facility name', value: hfrName(s.data.clinicName), pattern: FACILITY_NAME_PATTERN, hint: 'Letters, numbers and spaces only, starting with a letter (HFR rule)', required: true },
                { name: 'ownership', label: 'Ownership', type: 'select', options: s.data.owners, required: true },
                { name: 'systemsOfMedicine', label: 'Systems of medicine', type: 'multiselect', options: s.data.medicines, required: true },
                { name: 'state', label: 'State', type: 'select', options: s.data.states, required: true },
            ],
            submitLabel: 'Continue',
        }),
        classify: (s) => ({
            text: 'How HFR classifies the facility.',
            fields: [
                { name: 'ownershipSubType', label: 'Ownership type', type: 'select', options: OWNERSHIP_SUBTYPES[s.data.form.ownership] || [], required: true },
                { name: 'facilityType', label: 'Facility type', type: 'select', options: s.data.facilityTypes, required: true },
                { name: 'specialityType', label: 'Speciality', type: 'select', options: SPECIALITY_TYPES, value: 'SINGLE', required: true },
                { name: 'district', label: 'District', type: 'select', options: s.data.districts, required: true },
            ],
            submitLabel: 'Continue',
        }),
        location: (s) => ({
            text: 'Where the facility is, and how to reach it.',
            fields: [
                ...(s.data.ownerSubtypes2.length ? [{ name: 'ownershipSubType2', label: 'Ownership sub-type', type: 'select', options: s.data.ownerSubtypes2, required: true }] : []),
                { name: 'facilitySubType', label: 'Facility sub-type', type: 'select', options: s.data.facilitySubtypes, required: true },
                { name: 'subdistrict', label: 'Sub-district', type: 'select', options: s.data.subdistricts, required: true },
                { name: 'region', label: 'Region', type: 'select', options: REGIONS, value: 'U', required: true },
                { name: 'addressLine1', label: 'Address', required: true },
                { name: 'city', label: 'City or town', required: true },
                { name: 'pincode', label: 'PIN code', inputmode: 'numeric', pattern: '^\\d{6}$', required: true },
                { name: 'geo', label: 'Pin the facility on the map (HFR records its coordinates)', type: 'geo', required: true },
                { name: 'phone', label: 'Facility phone', inputmode: 'tel', pattern: '^[6-9]\\d{9}$', required: true },
                { name: 'email', label: 'Facility email', type: 'email' },
            ],
            submitLabel: 'Check HFR for duplicates',
        }),
        review: (s) => ({
            text: s.data.matches.length
                ? `HFR already has ${s.data.matches.length} facilit${s.data.matches.length === 1 ? 'y' : 'ies'} with a similar name here. If one is yours, don't create another.`
                : 'No facility with this name is registered in HFR here. Create the draft?',
            ...(s.data.nameAsTyped && s.data.nameAsTyped !== s.data.form.facilityName
                ? { detail: `HFR takes only letters, numbers and spaces, so the name is sent as "${s.data.form.facilityName}".` }
                : {}),
            list: s.data.matches.map((m) => ({ name: m.facilityName || m.name, detail: [m.facilityId, m.address || m.districtName].filter(Boolean).join(' · ') })),
            // Your pin is the highlighted marker; HFR's possible duplicates are around it.
            map: {
                selected: 'yours',
                markers: [
                    { id: 'yours', lat: Number(s.data.form.latitude), lng: Number(s.data.form.longitude), label: `${s.data.form.facilityName} (yours)` },
                    ...s.data.matches.map((m, i) => ({ id: `m${i}`, lat: Number(m.latitude), lng: Number(m.longitude), label: `${m.facilityName} · ${m.facilityId}` })),
                ],
            },
            choices: [
                { value: 'create', label: 'Create the HFR draft', detail: 'Sends Basic Information to HFR and returns a tracking id' },
                { value: 'stop', label: 'Stop here' },
            ],
        }),
        submit: (s) => ({
            text: `Submit ${s.data.form?.facilityName || s.data.saved?.facilityName} (tracking id ${s.data.trackingId}) to HFR?`,
            detail: 'By submitting, you as Facility Manager attest that the information is correct. HFR then issues the facility id; verification by the state follows.',
            choices: [
                { value: 'submit', label: 'I attest, submit to HFR' },
                { value: 'later', label: 'Keep the draft, submit later' },
            ],
        }),
    },

    // The step handlers the journey JSON names (specs/<id>.journey.json). Same bodies as the
    // LangGraph nodes they replace: an ask's (answer, state, deps), an auto/final's (state, deps).
    actions: {
        // begin
        loadSaved: async (s, d) => {
                const saved = (await d.records.get(HFR_RECORD)) || null;
                return { data: { saved, clinicName: d.account?.clinicName, hasHpr: !!d.vault.hpr(d.account.id) } };
            },
        // resume
        chooseResume: async (a, s) => ({ data: { resume: a.choice === 'submit', trackingId: a.choice === 'submit' ? s.data.saved.trackingId : null } }),
        // managerLogin
        managerLogin: async (a, s, d) => {
                const res = await post(d.gateway, '/hpr/auth/password-login', { hprId: a.hprId.trim(), password: a.password });
                d.vault.setHpr(d.account.id, { token: res.token, hprId: a.hprId.trim(), expiresIn: res.expiresIn });
                return { data: { hasHpr: true } };
            },
        // loadBasics
        loadBasics: async (s, d) => {
                const [owners, medicines, states] = await Promise.all([
                    d.gateway('/hfr/master/data?type=OWNER').then((r) => toOptions(r.data)),
                    d.gateway('/hfr/master/data?type=MEDICINE').then((r) => toOptions(r.data)),
                    d.gateway('/hfr/master/lgd/states').then((r) => toOptions(r.data)),
                ]);
                if (!owners.length || !medicines.length || !states.length) throw new Error('HFR did not return its master lists. Try again shortly.');
                return { data: { owners, medicines, states } };
            },
        // facility
        describeFacility: async (a) => {
                const systems = [].concat(a.systemsOfMedicine || []).filter(Boolean);
                if (!systems.length) throw new Error('Choose at least one system of medicine.');
                return { data: { form: { facilityName: a.facilityName.trim(), ownership: a.ownership, systemsOfMedicine: systems, state: a.state } } };
            },
        // loadDependent
        loadDependent: async (s, d) => {
                const f = s.data.form;
                const [facilityTypes, districts] = await Promise.all([
                    d.gateway(`/hfr/master/facility-types?ownershipCode=${q(f.ownership)}&systemOfMedicineCode=${q(f.systemsOfMedicine[0])}`).then((r) => toOptions(r.data)),
                    d.gateway(`/hfr/master/lgd/districts?stateCode=${q(f.state)}`).then((r) => toOptions(r.data)),
                ]);
                if (!districts.length) throw new Error('HFR did not return districts for that state.');
                if (!facilityTypes.length) throw new Error('HFR has no facility types for that ownership and system of medicine.');
                return { data: { facilityTypes, districts } };
            },
        // classify
        classifyFacility: async (a, s) => ({
                data: { form: { ...s.data.form, ownershipSubType: a.ownershipSubType, facilityType: a.facilityType, specialityType: a.specialityType, district: a.district } },
            }),
        // loadLocation
        loadLocation: async (s, d) => {
                const f = s.data.form;
                const [subdistricts, facilitySubtypes, ownerSubtypes2] = await Promise.all([
                    d.gateway(`/hfr/master/lgd/subdistricts?districtCode=${q(f.district)}`).then((r) => toOptions(r.data)),
                    // Includes "No Applicable Subtype" where a type has none.
                    d.gateway(`/hfr/master/facility-sub-types?facilityTypeCode=${q(f.facilityType)}`).then((r) => toOptions(r.data)),
                    f.ownershipSubType === 'S'
                        ? []
                        : d.gateway(`/hfr/master/owner-subtypes?ownershipCode=${q(f.ownership)}&ownerSubtypeCode=${q(f.ownershipSubType)}`).then((r) => toOptions(r.data)),
                ]);
                if (!subdistricts.length) throw new Error('HFR did not return sub-districts for that district.');
                if (!facilitySubtypes.length) throw new Error('HFR did not return sub-types for that facility type.');
                return { data: { subdistricts, facilitySubtypes, ownerSubtypes2 } };
            },
        // location
        locateFacility: async (a, s, d) => {
                const { geo, ...rest } = a;
                if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) throw new Error('Pin the facility on the map, or enter its coordinates.');
                const form = { ...s.data.form, ...rest, latitude: String(geo.lat), longitude: String(geo.lng), facilityName: hfrName(s.data.form.facilityName) };
                if (!form.facilityName) throw new Error('HFR needs a facility name with letters. Start the journey again and enter one.');
                const res = await post(d.gateway, '/hfr/facility/search', {
                    ownershipCode: form.ownership,
                    stateLGDCode: form.state,
                    districtLGDCode: form.district,
                    facilityName: form.facilityName,
                    page: 1,
                    resultsPerPage: 10,
                });
                return { data: { form, nameAsTyped: s.data.form.facilityName, matches: res.facilities || res.data || [] } };
            },
        // review
        saveDraft: async (a, s, d) => {
                if (a.choice !== 'create') return { data: { stopped: true } };
                const res = await post(d.gateway, '/hfr/facility/basic-information', buildBasicInformation(s.data.form), hprHeader(d));
                if (!res.trackingId) throw new Error('HFR did not return a tracking id.');
                await d.records.set(HFR_RECORD, { facilityName: s.data.form.facilityName, trackingId: res.trackingId, createdAt: new Date().toISOString() });
                const facilityTypeLabel = s.data.facilityTypes.find((o) => o.value === s.data.form.facilityType)?.label;
                const resource = facilityResource(s.data.form, { clinicId: d.account.clinicId, facilityTypeLabel, trackingId: res.trackingId });
                const fhir = await keepResource(d, FACILITY_RESOURCE, resource, PROFILE.facility);
                await d.journal?.add({
                    journey: 'hfr',
                    group: 'HFR',
                    title: `HFR draft for ${s.data.form.facilityName}`,
                    text: 'Basic Information sent to the Health Facility Registry.',
                    facts: [['Tracking id', res.trackingId]],
                    location: { lat: Number(s.data.form.latitude), lng: Number(s.data.form.longitude), label: `${s.data.form.facilityName}, ${s.data.form.city}` },
                });
                return { data: { trackingId: res.trackingId, fhir } };
            },
        // submit
        submitToHfr: async (a, s, d) => {
                if (a.choice !== 'submit') return { data: { later: true } };
                const res = await post(d.gateway, '/hfr/facility/submit', { trackingId: s.data.trackingId }, hprHeader(d));
                if (!res.facilityId) throw new Error(res.message || 'HFR did not issue a facility id.');
                const saved = (await d.records.get(HFR_RECORD)) || {};
                const record = { ...saved, facilityName: s.data.form?.facilityName || saved.facilityName, trackingId: s.data.trackingId, facilityId: res.facilityId, status: res.status, submittedAt: new Date().toISOString() };
                await d.records.set(HFR_RECORD, record);
                // Add the HFR facility id to the Organization kept when the draft was created.
                const kept = await d.records.get(FACILITY_RESOURCE);
                let fhir = null;
                if (kept?.resource) {
                    const resource = { ...kept.resource, identifier: [...kept.resource.identifier.filter((i) => i.system !== 'https://facility.ndhm.gov.in'), { type: kept.resource.identifier[0].type, system: 'https://facility.ndhm.gov.in', value: res.facilityId }] };
                    fhir = await keepResource(d, FACILITY_RESOURCE, resource, PROFILE.facility);
                }
                const org = (await d.records.get(FACILITY_RESOURCE))?.resource;
                const lat = org?.extension?.find((e) => e.url.endsWith('hfr-geolocation-latitude'))?.valueDecimal;
                const lng = org?.extension?.find((e) => e.url.endsWith('hfr-geolocation-longitude'))?.valueDecimal;
                await d.journal?.add({
                    journey: 'hfr',
                    group: 'HFR',
                    title: `${record.facilityName} submitted to HFR`,
                    text: 'Attested and submitted by the facility manager.',
                    facts: [['Facility id', record.facilityId], ['Tracking id', record.trackingId]],
                    ...(Number.isFinite(lat) && Number.isFinite(lng) ? { location: { lat, lng, label: record.facilityName } } : {}),
                });
                return { data: { submitted: record, fhir } };
            },
        // done
        result: async (s) => {
                if (s.data.stopped) return { result: { ok: true, title: 'Nothing was sent to HFR', text: 'No draft was created.' } };
                if (s.data.later) {
                    return { result: { ok: true, title: 'Draft saved', text: 'Open this journey again to submit it.', facts: [['Tracking id', s.data.trackingId], ...(s.data.fhir ? [s.data.fhir] : [])] } };
                }
                const r = s.data.submitted;
                return {
                    result: {
                        ok: true,
                        title: 'Submitted to HFR',
                        text: 'HFR has your facility. It becomes verified after review by the state authority.',
                        facts: [['Facility', r.facilityName], ['Facility id', r.facilityId], ['Tracking id', r.trackingId], ...(r.status ? [['Status', r.status]] : []), ...(s.data.fhir ? [s.data.fhir] : [])],
                    },
                };
            },
    },
};
