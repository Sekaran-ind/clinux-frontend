// HFR (Health Facility Registry) journey: register facilities with ABDM through
// clinuxflow-abdm-gateway's /hfr routes. An account can register many facilities (hfrFacilities.js).
//
//   begin --any facility--> facilities --view--> view (read-only)
//                                      --continue a draft--> its next section
//                                      --new--> (sign-in) -> loadBasics ...
//         --none---------> needLogin? --> managerLogin
//                          -> loadBasics -> facility -> loadDependent -> classify
//                          -> loadLocation -> location (+ duplicate search) -> hours -> review (Basic
//                          Information: the draft) -> additional -> detailed -> submit -> done
//
// Basic Information and Submit need the Facility Manager's own HPR token (x-hprid-auth). If this
// session already signed in to HPR (Cübo's profile), that token is reused.
import spec from './specs/hfr.journey.json' with { type: 'json' };
import { toOptions } from './gateway.js';
import { PROFILE, facilityResource, keepResource } from './fhir.js';
import { HFR_FACILITIES, facilityLine, facilityResourceKey, isSubmitted, loadFacilities, saveFacility } from './hfrFacilities.js';

// Facilities are a list now (hfrFacilities.js); these are the single-facility keys it migrates from.
export const HFR_RECORD = 'abdm:hfr';
export const FACILITY_RESOURCE = 'fhir:facility';
export { HFR_FACILITIES };
const post = (gateway, path, body, headers) => gateway(path, { method: 'POST', body, headers });
const q = encodeURIComponent;
// The HPR journey's record of this account's linked HPR ID (hprJourney.js HPR_RECORD) — the
// Cübo profile's HPR identity. Named here rather than imported to keep the journeys independent.
const HPR_LINK_RECORD = 'abdm:hpr';
const labelOf = (options, value) => (options || []).find((o) => o.value === value)?.label || '';
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

// Type of service (HFR get-master-data type=TYPE-SERVICE; also clinuxflow-fhir-api's
// CodeSystem hfr-type-service). Sent comma-joined, like systems of medicine. HFR requires it
// (HIS-1070 "Required Facility TypeOfService code", live 2026-10-02) except for the facility types
// its field spec (HFR-037) exempts.
export const SERVICE_TYPES = [
    { value: 'OPD', label: 'OPD' },
    { value: 'DAY', label: 'Daycare' },
    { value: 'IPD', label: 'IPD' },
];
const NO_SERVICE_TYPE = /pharmacy|blood\s*bank|diagnostic|lab|imaging|cath|dialysis/i;

// Working days as HFR's timingsOfFacility takes them: one { workingDays, openingHours } entry per
// day, hours "10:00 AM - 2:00 PM" or "24*7" (HFR-021; HIS-1070 "Required Facility Timings" when
// empty, live 2026-10-02). Day spelling follows a live-tested HFR integration.
export const WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LABELS = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

/** "09:00" (an <input type=time> value) -> "9:00 AM". */
export function hfrTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    const h = Number(m[1]);
    if (h > 23 || Number(m[2]) > 59) return null;
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

// Board and building photographs (HFR-027/028: PNG or JPEG, at most 5 MB; HIS-4050 without them).
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Checks an uploaded photo ({ name, value: base64 }) is what HFR takes; returns { name, value }. */
export function hfrPhoto(photo, label) {
    if (!photo?.value) throw new Error(`Add the ${label}.`);
    let bytes;
    try {
        bytes = atob(photo.value.slice(0, 16));
    } catch {
        throw new Error(`The ${label} could not be read. Choose the file again.`);
    }
    const isJpeg = bytes.startsWith('\xff\xd8\xff');
    const isPng = bytes.startsWith('\x89PNG');
    if (!isJpeg && !isPng) throw new Error(`The ${label} must be a PNG or JPEG image.`);
    if (Math.floor((photo.value.length * 3) / 4) > PHOTO_MAX_BYTES) throw new Error(`The ${label} must be 5 MB or smaller.`);
    return { name: photo.name || `${label.replace(/\W+/g, '-')}.${isPng ? 'png' : 'jpg'}`, value: photo.value };
}

// Additional Information's general facilities (HFR-039..047): open to all patients, to in-house
// patients only, or not available.
const GENERAL_OPTIONS = [
    { value: 'N', label: 'No' },
    { value: 'YALL', label: 'Yes, for all patients' },
    { value: 'YIN', label: 'Yes, in-house patients only' },
];
const GENERAL_FACILITIES = [
    ['hasPharmacy', 'Pharmacy'],
    ['hasDiagnosticLab', 'Diagnostic lab'],
    ['hasImagingCenter', 'Imaging centre'],
    ['hasBloodBank', 'Blood bank'],
    ['hasDialysisCenter', 'Dialysis centre'],
    ['hasCathLab', 'Cath lab'],
];
// Linked programme ids (all optional).
const PROGRAM_IDS = [
    ['nin', 'NIN (National Identification Number)'],
    ['abpmjayId', 'AB PM-JAY id'],
    ['rohiniId', 'ROHINI id'],
    ['cghsId', 'CGHS id'],
    ['echsId', 'ECHS id'],
    ['nhrrId', 'NHRR id'],
    ['ceaRegistration', 'Clinical Establishments Act registration'],
    ['stateInsuranceSchemeId', 'State insurance scheme id'],
];
// Detailed Information's bed counts (HFR-050..063: 0-99 each), by the services the facility offers.
const BEDS = {
    IPD: [
        ['countIPDBedsWithoutOxygen', 'IPD beds without oxygen'],
        ['countIPDBedsWithOxygen', 'IPD beds with oxygen'],
        ['countICUBedsWithVentilators', 'ICU beds with ventilators'],
        ['countICUBedsWithoutVentilators', 'ICU beds without ventilators'],
        ['countHDUBedsWithVentilators', 'HDU beds with ventilators'],
        ['countHDUBedsWithoutVentilators', 'HDU beds without ventilators'],
    ],
    DAY: [
        ['countDayCareBedsWithoutOxygen', 'Daycare beds without oxygen'],
        ['countDayCareBedsWithOxygen', 'Daycare beds with oxygen'],
    ],
};
const ALL_COUNTS = [...BEDS.IPD, ...BEDS.DAY, ['countDentalChairs', 'Dental chairs']];
// HFR takes medical infrastructure only from a facility with beds: "Medical Infrastructure are not
// required for TypeOfService - OPD" (refused live, 2026-10-02, for an OPD-only facility).
export const hasBeds = (typesOfService = []) => typesOfService.includes('IPD') || typesOfService.includes('DAY');

/** The Additional Information body (linked programme ids + general facilities). */
export function buildAdditionalInformation(trackingId, a) {
    return {
        trackingId,
        linkedProgramIds: Object.fromEntries(PROGRAM_IDS.map(([k]) => [k, String(a[k] || '').trim()])),
        generalInformation: {
            ...Object.fromEntries(GENERAL_FACILITIES.map(([k]) => [k, a[k] || 'N'])),
            servicesByImagingCenter: [],
        },
    };
}

/**
 * The Detailed Information body. Totals are derived the way HFR checks them (HIS-1070, per a
 * live-tested integration): total beds = IPD + HDU beds; ventilators = ICU + HDU with ventilators.
 * Specialities are sent without get-specialities' "M-" prefix ("M-S1" -> "S1").
 */
export function buildDetailedInformation(trackingId, { systemsOfMedicine = [], typesOfService = [], specialities = {}, counts = {}, pharmacy = null }) {
    const n = (k) => Number(counts[k]) || 0;
    const body = {
        trackingId,
        specialities: systemsOfMedicine.map((system) => {
            const codes = (specialities[system] || []).map((c) => String(c).replace(new RegExp(`^${system}-`), ''));
            return { systemOfMedicineCode: system, isSpecializationAvalaible: codes.length ? 'Y' : 'N', specialities: codes };
        }),
    };
    if (hasBeds(typesOfService)) {
        body.medicalInfrastructure = {
            ...Object.fromEntries(ALL_COUNTS.map(([k]) => [k, n(k)])),
            totalNumberOfVentilators: n('countICUBedsWithVentilators') + n('countHDUBedsWithVentilators'),
            totalNumberOfBeds: n('countIPDBedsWithoutOxygen') + n('countIPDBedsWithOxygen') + n('countHDUBedsWithVentilators') + n('countHDUBedsWithoutVentilators'),
        };
    }
    if (pharmacy) body.pharmacyDetails = pharmacy;
    return body;
}

/** HFR can answer 200 with its refusal in errorStatus; a saved section returns its trackingId. */
function savedSection(res, what) {
    const errors = [].concat(res?.errorStatus || res?.errors || []).map((e) => (typeof e === 'string' ? e : e?.message || e?.errorMessage)).filter(Boolean);
    if (errors.length) throw new Error(errors.join(' '));
    if (!res?.trackingId) throw new Error(res?.message || `HFR did not save the ${what}.`);
    return res.trackingId;
}

const REGIONS = [
    { value: 'U', label: 'Urban' },
    { value: 'R', label: 'Rural' },
];

/** The Basic Information body HFR expects, from the answers collected in this journey. */
export function buildBasicInformation(f) {
    return {
        // Empty creates a draft; the draft's own tracking id updates it (going back to change an
        // answer after the draft exists must not create a second facility).
        trackingId: f.trackingId || '',
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
            ...(f.typesOfService?.length ? { typeOfServiceCode: f.typesOfService.join(',') } : {}),
            // HFR wants one comma-joined string, e.g. "M,D".
            systemOfMedicineCode: (f.systemsOfMedicine || []).join(','),
            facilityTypeCode: f.facilityType,
            facilitySubType: f.facilitySubType || undefined,
            facilityUploads: {
                facilityBoardPhoto: f.boardPhoto || { name: '', value: '' },
                facilityBuildingPhoto: f.buildingPhoto || { name: '', value: '' },
            },
            facilityAddressProof: [],
            facilityOperationalStatus: 'F',
            timingsOfFacility: (f.workingDays || []).map((day) => ({ workingDays: day, openingHours: f.openingHours })),
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
        // Every visit starts here when the account has any HFR facility: submitted ones can only
        // be viewed (read-only), drafts continued, or another facility registered.
        facilities: (s) => ({
            text: `Your HFR facilities (${s.data.facilities.length}).`,
            detail: 'Registered facilities are read-only here. Each facility is registered separately.',
            list: s.data.facilities.map((f) => ({ name: f.facilityName, detail: facilityLine(f).slice(f.facilityName.length + 3) })),
            choices: [
                ...s.data.facilities.filter((f) => !isSubmitted(f)).map((f) => ({ value: `continue:${f.trackingId}`, label: `Continue draft ${f.trackingId}`, detail: facilityLine(f) })),
                ...s.data.facilities.filter(isSubmitted).map((f) => ({ value: `view:${f.trackingId}`, label: `View ${f.facilityName}`, detail: `${f.facilityId} · read-only` })),
                { value: 'new', label: 'Register a new facility', detail: 'A separate HFR registration' },
            ],
        }),
        managerLogin: (s) => ({
            text: 'HFR registration is done by the facility manager. Sign in with the HPR ID that holds the Facility Manager role.',
            // The HPR ID already on this account's Cübo profile, when there is one.
            ...(s.data.profileHprId ? { detail: `Your Cübo profile has HPR ID ${s.data.profileHprId}. The sign-in is kept on your profile for this session.` } : {}),
            fields: [
                { name: 'hprId', label: 'HPR ID', placeholder: 'name@hpr.abdm', value: s.data.profileHprId || '', required: true },
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
                { name: 'typesOfService', label: 'Type of service', type: 'multiselect', options: SERVICE_TYPES, value: ['OPD'], hint: 'Not needed for a pharmacy, lab, imaging centre, blood bank, cath lab or dialysis centre' },
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
                // `near`: "Find the address on the map" looks up these fields (plus the district and
                // state chosen earlier) and drops the pin there (GeoPicker.vue, geocode.js).
                { name: 'geo', label: 'Pin the facility on the map (HFR records its coordinates)', type: 'geo', required: true,
                  near: { fields: ['addressLine1', 'city', 'pincode'], context: [labelOf(s.data.districts, s.data.form.district), labelOf(s.data.states, s.data.form.state)] } },
                { name: 'phone', label: 'Facility phone', inputmode: 'tel', pattern: '^[6-9]\\d{9}$', required: true },
                { name: 'email', label: 'Facility email', type: 'email' },
            ],
            submitLabel: 'Check HFR for duplicates',
        }),
        hours: () => ({
            text: 'When the facility is open, and two photographs HFR needs: its name board and its building.',
            fields: [
                { name: 'workingDays', label: 'Working days', type: 'multiselect', options: WORKING_DAYS.map((d) => ({ value: d, label: DAY_LABELS[d] })), value: WORKING_DAYS.slice(0, 6), required: true },
                { name: 'allDay', label: 'Open 24 hours on these days (24×7)', type: 'checkbox' },
                { name: 'opensAt', label: 'Opens at', type: 'time', value: '09:00', hiddenWhen: 'allDay' },
                { name: 'closesAt', label: 'Closes at', type: 'time', value: '18:00', hiddenWhen: 'allDay' },
                { name: 'boardPhoto', label: 'Photo of the facility’s name board', type: 'image', required: true, hint: 'PNG or JPEG, up to 5 MB' },
                { name: 'buildingPhoto', label: 'Photo of the building', type: 'image', required: true, hint: 'PNG or JPEG, up to 5 MB' },
            ],
            submitLabel: 'Continue',
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
                s.data.trackingId
                    ? { value: 'create', label: 'Update the HFR draft', detail: `Sends the changes to draft ${s.data.trackingId}` }
                    : { value: 'create', label: 'Create the HFR draft', detail: 'Sends Basic Information to HFR and returns a tracking id' },
                { value: 'stop', label: 'Stop here' },
            ],
        }),
        additional: (s) => ({
            text: 'HFR also needs the programmes the facility is part of, and which general services it has.',
            detail: `Draft ${s.data.trackingId}. The programme ids are optional; leave blank what doesn't apply.`,
            fields: [
                ...GENERAL_FACILITIES.map(([name, label]) => ({ name, label, type: 'select', options: GENERAL_OPTIONS, value: 'N', required: true })),
                ...PROGRAM_IDS.map(([name, label]) => ({ name, label })),
            ],
            submitLabel: 'Save to HFR',
        }),
        detailed: (s) => {
            const systems = s.data.form.systemsOfMedicine || [];
            const services = s.data.form.typesOfService || [];
            const beds = hasBeds(services);
            const label = (code) => s.data.medicines?.find((o) => o.value === code)?.label || code;
            return {
                text: beds ? 'Last section: specialities and beds.' : 'Last section: specialities.',
                detail: beds
                    ? 'Leave specialities empty if the facility has none. Bed counts are 0–99; HFR works out the totals.'
                    : services.length
                      ? 'Leave specialities empty if the facility has none. HFR takes no bed counts for an OPD-only facility.'
                      : 'Leave specialities empty if the facility has none.',
                fields: [
                    // A draft saved before its systems of medicine / type of service were kept on this device: ask again.
                    ...(systems.length ? [] : [{ name: 'systemsOfMedicine', label: 'Systems of medicine (as in the draft)', type: 'multiselect', options: s.data.medicines || [], required: true }]),
                    ...(services.length ? [] : [{ name: 'typesOfService', label: 'Type of service (as in the draft)', type: 'multiselect', options: SERVICE_TYPES, value: ['OPD'], hint: 'Bed counts are sent only for IPD or Daycare' }]),
                    ...systems.map((code) => ({ name: `spec_${code}`, label: `Specialities — ${label(code)}`, type: 'multiselect', options: s.data.specialityOptions?.[code] || [] })),
                    ...[...(services.includes('IPD') ? BEDS.IPD : []), ...(services.includes('DAY') ? BEDS.DAY : []), ...(beds ? [['countDentalChairs', 'Dental chairs']] : [])]
                        .map(([name, lbl]) => ({ name, label: lbl, type: 'number', inputmode: 'numeric', pattern: '^\\d{1,2}$', hint: '0–99', value: '0' })),
                    ...(s.data.hasPharmacy ? [
                        { name: 'drugLicenseNumber', label: 'Pharmacy drug licence number', required: true },
                        { name: 'pharmacistRegistrationNumber', label: 'Pharmacist registration number', required: true },
                        { name: 'pharmacyGstinNumber', label: 'Pharmacy GSTIN' },
                        { name: 'janAushadhiKendraId', label: 'Jan Aushadhi Kendra id (if it is one)' },
                    ] : []),
                ],
                submitLabel: 'Save to HFR',
            };
        },
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
                const facilities = await loadFacilities(d.records);
                const linked = await d.records.get(HPR_LINK_RECORD);
                // The Facility profile's name (when filled in) is the new facility's default name.
                const profileName = (await d.facilityProfile?.())?.name || '';
                return { data: { facilities, hasFacilities: facilities.length > 0, clinicName: profileName || d.account?.clinicName, hasHpr: !!d.vault.hpr(d.account.id), profileHprId: linked?.hprId || '' } };
            },
        // facilities
        chooseFacility: async (a, s) => {
                const [pick, trackingId] = String(a.choice).split(':');
                if (pick === 'new') return { data: { pick: 'new', trackingId: null, stage: null } };
                const f = s.data.facilities.find((x) => x.trackingId === trackingId);
                if (!f) throw new Error('That facility is no longer on this device.');
                if (pick === 'view') return { data: { pick: 'view', viewing: f } };
                // What the later sections need from the draft (kept with it — never the photos).
                const form = { facilityName: f.facilityName, systemsOfMedicine: f.systemsOfMedicine || [], typesOfService: f.typesOfService || [] };
                return { data: { pick: 'continue', trackingId: f.trackingId, stage: f.stage || 'basic', form } };
            },
        // view: a submitted facility, read-only.
        viewFacility: async (s, d) => {
                const f = s.data.viewing;
                const fhir = await d.records.get(facilityResourceKey(f.trackingId));
                const v = fhir?.validation?.status;
                return {
                    result: {
                        ok: true,
                        readonly: true,
                        title: f.facilityName,
                        text: 'Registered with HFR. Submitted facilities can’t be changed here; changes go through HFR.',
                        facts: [
                            ['Facility id', f.facilityId],
                            ['Tracking id', f.trackingId],
                            ...(f.status ? [['Status', f.status]] : []),
                            ...(f.address ? [['Address', f.address]] : []),
                            ...(f.typesOfService?.length ? [['Type of service', f.typesOfService.join(', ')]] : []),
                            ...(f.submittedAt ? [['Submitted', new Date(f.submittedAt).toLocaleString()]] : []),
                            ...(v ? [['FHIR', v === 'valid' ? 'Organization valid against ClinuxFlowFacility' : v === 'pending' ? 'Organization saved; validation pending' : 'Organization incomplete for ClinuxFlowFacility']] : []),
                        ],
                        again: 'Back to your facilities',
                    },
                };
            },
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
        classifyFacility: async (a, s) => {
                const typesOfService = [].concat(a.typesOfService || []).filter(Boolean);
                const typeLabel = s.data.facilityTypes.find((o) => o.value === a.facilityType)?.label || '';
                if (!typesOfService.length && !NO_SERVICE_TYPE.test(typeLabel)) throw new Error(`HFR needs the type of service (OPD, Daycare or IPD) for a ${typeLabel || 'facility of this type'}.`);
                return { data: { form: { ...s.data.form, ownershipSubType: a.ownershipSubType, facilityType: a.facilityType, specialityType: a.specialityType, district: a.district, typesOfService } } };
            },
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
        // hours
        describeHours: async (a, s) => {
                const workingDays = WORKING_DAYS.filter((day) => [].concat(a.workingDays || []).includes(day));
                if (!workingDays.length) throw new Error('Choose at least one working day.');
                let openingHours = '24*7';
                if (!a.allDay) {
                    const opens = hfrTime(a.opensAt);
                    const closes = hfrTime(a.closesAt);
                    if (!opens || !closes) throw new Error('Enter the opening and closing times, or tick 24×7.');
                    if (a.opensAt === a.closesAt) throw new Error('Opening and closing times are the same. Tick 24×7 if the facility never closes.');
                    openingHours = `${opens} - ${closes}`;
                }
                const boardPhoto = hfrPhoto(a.boardPhoto, 'name board photo');
                const buildingPhoto = hfrPhoto(a.buildingPhoto, 'building photo');
                return { data: { form: { ...s.data.form, workingDays, openingHours, boardPhoto, buildingPhoto } } };
            },
        saveDraft: async (a, s, d) => {
                if (a.choice !== 'create') return { data: { stopped: true } };
                const res = await post(d.gateway, '/hfr/facility/basic-information', buildBasicInformation({ ...s.data.form, trackingId: s.data.trackingId }), hprHeader(d));
                savedSection(res, 'basic information');
                const before = (await loadFacilities(d.records)).find((f) => f.trackingId === res.trackingId);
                const same = !!before;
                const f = s.data.form;
                // Enough to resume the later sections from another visit (`stage` = the last section HFR has).
                await saveFacility(d.records, {
                    facilityName: f.facilityName,
                    trackingId: res.trackingId,
                    // An update keeps how far the draft already got.
                    stage: same ? before.stage || 'basic' : 'basic',
                    systemsOfMedicine: f.systemsOfMedicine,
                    typesOfService: f.typesOfService,
                    address: [f.addressLine1, f.city, f.pincode].filter(Boolean).join(', '),
                    createdAt: same ? before.createdAt : new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
                const facilityTypeLabel = s.data.facilityTypes.find((o) => o.value === f.facilityType)?.label;
                const resource = facilityResource(f, { clinicId: d.account.clinicId, facilityTypeLabel, trackingId: res.trackingId });
                const fhir = await keepResource(d, facilityResourceKey(res.trackingId), resource, PROFILE.facility);
                await d.journal?.add({
                    journey: 'hfr',
                    group: 'HFR',
                    title: `HFR draft ${same ? 'updated' : 'created'} for ${s.data.form.facilityName}`,
                    text: 'Basic Information sent to the Health Facility Registry.',
                    facts: [['Tracking id', res.trackingId]],
                    location: { lat: Number(s.data.form.latitude), lng: Number(s.data.form.longitude), label: `${s.data.form.facilityName}, ${s.data.form.city}` },
                });
                return { data: { trackingId: res.trackingId, stage: 'basic', fhir } };
            },
        // submit
        // loadDetails: the specialities HFR lists for each system of medicine.
        loadDetails: async (s, d) => {
                const systems = s.data.form.systemsOfMedicine || [];
                const [medicines, ...lists] = await Promise.all([
                    d.gateway('/hfr/master/data?type=MEDICINE').then((r) => toOptions(r.data)).catch(() => []),
                    ...systems.map((code) => d.gateway(`/hfr/master/specialities?systemOfMedicineCode=${q(code)}`).then((r) => toOptions(r.data)).catch(() => [])),
                ]);
                return { data: { medicines, specialityOptions: Object.fromEntries(systems.map((code, i) => [code, lists[i]])) } };
            },
        // additional
        saveAdditional: async (a, s, d) => {
                if (a.stateInsuranceSchemeId && !/^[A-Za-z0-9]*$/.test(a.stateInsuranceSchemeId.trim())) throw new Error('The state insurance scheme id takes letters and digits only.');
                const res = await post(d.gateway, '/hfr/facility/additional-information', buildAdditionalInformation(s.data.trackingId, a));
                savedSection(res, 'additional information');
                await saveFacility(d.records, { trackingId: s.data.trackingId, stage: 'additional', updatedAt: new Date().toISOString() });
                return { data: { stage: 'additional', hasPharmacy: a.hasPharmacy !== 'N' } };
            },
        // detailed
        saveDetailed: async (a, s, d) => {
                const systems = s.data.form.systemsOfMedicine?.length ? s.data.form.systemsOfMedicine : [].concat(a.systemsOfMedicine || []).filter(Boolean);
                if (!systems.length) throw new Error('Choose the systems of medicine the draft was created with.');
                const counts = {};
                for (const [k, label] of ALL_COUNTS) {
                    if (a[k] === undefined || a[k] === '') continue;
                    if (!/^\d{1,2}$/.test(String(a[k]).trim())) throw new Error(`${label}: enter a number from 0 to 99.`);
                    counts[k] = Number(a[k]);
                }
                const specialities = Object.fromEntries(systems.map((code) => [code, [].concat(a[`spec_${code}`] || [])]));
                const pharmacy = s.data.hasPharmacy
                    ? {
                        isJanAushadhiKendra: a.janAushadhiKendraId ? 'Y' : 'N',
                        janAushadhiKendraId: a.janAushadhiKendraId || '',
                        drugLicenseNumber: a.drugLicenseNumber || '',
                        pharmacyGstinNumber: a.pharmacyGstinNumber || '',
                        pharmacistRegistrationNumber: a.pharmacistRegistrationNumber || '',
                    }
                    : null;
                const typesOfService = s.data.form.typesOfService?.length ? s.data.form.typesOfService : [].concat(a.typesOfService || []).filter(Boolean);
                const res = await post(d.gateway, '/hfr/facility/detailed-information', buildDetailedInformation(s.data.trackingId, { systemsOfMedicine: systems, typesOfService, specialities, counts, pharmacy }));
                savedSection(res, 'detailed information');
                await saveFacility(d.records, { trackingId: s.data.trackingId, stage: 'detailed', systemsOfMedicine: systems, typesOfService, updatedAt: new Date().toISOString() });
                return { data: { stage: 'detailed', form: { ...s.data.form, systemsOfMedicine: systems, typesOfService } } };
            },
        // checkSignIn: submit needs the manager's HPR session; it may have ended since the draft.
        checkSignIn: async (s, d) => ({ data: { hasHpr: !!d.vault.hpr(d.account.id) } }),
        submitToHfr: async (a, s, d) => {
                if (a.choice !== 'submit') return { data: { later: true } };
                const res = await post(d.gateway, '/hfr/facility/submit', { trackingId: s.data.trackingId }, hprHeader(d));
                if (!res.facilityId) throw new Error(res.message || 'HFR did not issue a facility id.');
                const record = await saveFacility(d.records, { trackingId: s.data.trackingId, ...(s.data.form?.facilityName ? { facilityName: s.data.form.facilityName } : {}), facilityId: res.facilityId, status: res.status, submittedAt: new Date().toISOString() });
                // Add the HFR facility id to the Organization kept when the draft was created.
                const key = facilityResourceKey(s.data.trackingId);
                const kept = await d.records.get(key);
                let fhir = null;
                if (kept?.resource) {
                    const resource = { ...kept.resource, identifier: [...kept.resource.identifier.filter((i) => i.system !== 'https://facility.ndhm.gov.in'), { type: kept.resource.identifier[0].type, system: 'https://facility.ndhm.gov.in', value: res.facilityId }] };
                    fhir = await keepResource(d, key, resource, PROFILE.facility);
                }
                const org = (await d.records.get(key))?.resource;
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
                        readonly: true,
                        again: 'Register another facility',
                        title: 'Submitted to HFR',
                        text: 'HFR has your facility. It becomes verified after review by the state authority. It is read-only here from now on.',
                        facts: [['Facility', r.facilityName], ['Facility id', r.facilityId], ['Tracking id', r.trackingId], ...(r.status ? [['Status', r.status]] : []), ...(s.data.fhir ? [s.data.fhir] : [])],
                    },
                };
            },
    },
};
