// Ported from clinux-cubo's test/journeys.test.js (HPR, HFR, NHA checklist, FHIR output, runtime):
// the journeys here are the same modules, so they keep Cübo's tests. UHI and the assistant aren't
// part of the workspace, so their cases were dropped, as was journeysFor(role) — the workspace
// lists every journey (see index.js).
import { beforeEach, describe, expect, it } from 'vitest';
import { createRunner } from './runtime.js';
import { HPR_RECORD, hprJourney } from './hprJourney.js';
import { FACILITY_NAME_PATTERN, HFR_RECORD, buildBasicInformation, hfrJourney, hfrName, hfrPhoto, hfrTime } from './hfrJourney.js';
import { HFR_FACILITIES, facilityResourceKey } from './hfrFacilities.js';
import { vault } from './vault.js';
import { GatewayError, toOptions } from './gateway.js';
import { PROFILE } from './fhir.js';
import { AADHAAR_CONSENT_RECORD } from './hprJourney.js';
import { HPR_AADHAAR_CONSENT, OTP_RESEND, afterSend, resendState } from './hprConsent.js';

const account = { id: 'acc-1', clinicId: 'clinic-1', clinicName: "Asha's Clinic", email: 'asha@example.in', role: 'admin_and_health_professional' };

/** A fake gateway: `routes` maps "METHOD /path" (query stripped) to a handler or a value. */
function fakeGateway(routes) {
    const calls = [];
    const gateway = async (path, { method = 'GET', body, headers } = {}) => {
        calls.push({ method, path, body, headers });
        const key = `${method} ${path.split('?')[0]}`;
        const route = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
        if (route === undefined) throw new GatewayError(`no fake for ${key}`, { status: 404 });
        return typeof route === 'function' ? route({ path, body, headers, calls }) : route;
    };
    return { gateway, calls };
}

/** A fake fhir-api: $validate answers with no issues unless `issues` says otherwise. */
function fakeApi(issues = []) {
    const calls = [];
    const api = async (path, { body } = {}) => {
        calls.push({ path, body });
        return { ok: true, status: 200, data: { resourceType: 'OperationOutcome', issue: issues } };
    };
    api.calls = calls;
    return api;
}

function deps(gateway, records = new Map(), api = fakeApi()) {
    const journal = [];
    return {
        journal: { add: async (e) => journal.push(e), list: async () => journal },
        _journal: journal,
        account,
        api,
        gateway,
        vault,
        records: { get: async (k) => records.get(k), set: async (k, v) => records.set(k, v) },
        sleep: async () => {},
        _records: records,
    };
}

beforeEach(() => vault.clear());

const LINK = 'https://healthidbeta.abdm.gov.in/abdm/aadhaar/gateway/auth?link_id=x';
/** The gateway's Aadhaar-link routes; `state.authenticated` says whether NHA's page was completed. */
function linkRoutes(state = { authenticated: true }, details = {}) {
    return {
        'POST /hpr/registration/aadhaar-link': ({ calls }) => ({ success: true, txnId: `L${calls.filter((c) => c.path === '/hpr/registration/aadhaar-link').length}`, url: LINK, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        'POST /hpr/registration/aadhaar-link/status': () => ({ success: true, authenticated: state.authenticated }),
        'POST /hpr/registration/aadhaar-link/details': ({ body }) => ({ success: true, txnId: body.txnId, maskedMobile: '******1234', name: 'Asha Kumari Rao', photo: 'KYCPHOTO', ...details }),
    };
}

describe('HPR journey', () => {
    it('a linked HPR ID is read-only: view it, or sign in to that same ID for the session', async () => {
        const { gateway } = fakeGateway({ 'POST /hpr/auth/password-login': { success: true, token: 't' }, 'POST /hpr/professional/fetch': { success: true, name: 'Asha' } });
        const records = new Map([[HPR_RECORD, { hprId: 'asha@hpr.abdm', name: 'Asha', linkedAt: '2026-10-01T10:00:00Z', via: 'sign-in' }]]);
        let run = createRunner(hprJourney, deps(gateway, records));
        const mode = (await run.start()).prompt;
        expect(mode.choices.map((c) => c.value)).toEqual(['profile', 'view', 'link']); // no "register a new one"
        const view = await run.answer({ choice: 'view' });
        expect(view.result).toMatchObject({ ok: true, readonly: true, title: 'HPR ID asha@hpr.abdm' });
        run = createRunner(hprJourney, deps(gateway, records));
        await run.start();
        const login = (await run.answer({ choice: 'link' })).prompt;
        expect(login.fields[0]).toMatchObject({ name: 'hprId', value: 'asha@hpr.abdm', readonly: true });
        expect((await run.answer({ hprId: 'other@hpr.abdm', password: 'p' })).prompt.error).toMatch(/linked to asha@hpr.abdm/);
        expect((await run.answer({ hprId: 'asha@hpr.abdm', password: 'p' })).prompt.step).toBe('afterId');
        expect((await run.answer({ choice: 'later' })).result).toMatchObject({ ok: true, readonly: true });
    });

    it('links an existing HPR ID: signs in, keeps the token in memory only, saves the link', async () => {
        const { gateway, calls } = fakeGateway({
            'POST /hpr/auth/password-login': { success: true, token: 'hpr-token', expiresIn: 600 },
            'POST /hpr/professional/fetch': { success: true, practitioner: { name: 'Dr Asha Rao' } },
        });
        const d = deps(gateway);
        const run = createRunner(hprJourney, d);
        expect((await run.start()).prompt.step).toBe('mode');
        expect((await run.answer({ choice: 'link' })).prompt.step).toBe('login');
        const offer = await run.answer({ hprId: 'asha@hpr.abdm', password: 'S3cret!pass' });
        expect(offer.prompt.step).toBe('afterId'); // the professional profile is offered next
        const end = await run.answer({ choice: 'later' });
        expect(end.done).toBe(true);
        expect(end.result).toMatchObject({ ok: true, title: 'HPR ID linked' });
        expect(calls[0].body).toEqual({ hprId: 'asha@hpr.abdm', password: 'S3cret!pass' });
        expect(vault.hpr(account.id).token).toBe('hpr-token');
        const saved = d._records.get(HPR_RECORD);
        expect(saved).toMatchObject({ hprId: 'asha@hpr.abdm', name: 'Dr Asha Rao', via: 'sign-in' });
        expect(JSON.stringify(saved)).not.toContain('S3cret');
    });

    it('a failed sign-in asks again with ABDM’s message', async () => {
        let n = 0;
        const { gateway } = fakeGateway({
            'POST /hpr/auth/password-login': () => {
                if (n++ === 0) throw new GatewayError('Invalid credentials', { status: 502 });
                return { success: true, token: 't' };
            },
            'POST /hpr/professional/fetch': () => {
                throw new GatewayError('down', { status: 502 });
            },
        });
        const run = createRunner(hprJourney, deps(gateway));
        await run.start();
        await run.answer({ choice: 'link' });
        const again = await run.answer({ hprId: 'a@hpr.abdm', password: 'x' });
        expect(again.prompt).toMatchObject({ step: 'login', error: 'Invalid credentials' });
        // A profile lookup failure does not undo the sign-in.
        expect((await run.answer({ hprId: 'a@hpr.abdm', password: 'y' })).prompt.step).toBe('afterId');
        expect((await run.answer({ choice: 'later' })).result.ok).toBe(true);
    });

    it('registers through Aadhaar on NHA’s page, falling back to a mobile OTP when the number does not match', async () => {
        const link = { authenticated: false };
        const { gateway, calls } = fakeGateway({
            ...linkRoutes(link),
            'POST /hpr/registration/check-account-exists': { success: true, hpidExists: false, demographics: { name: 'Asha Kumari Rao' } },
            'POST /hpr/registration/demographic-auth-mobile': () => {
                throw new GatewayError('Mobile number does not match', { status: 502 });
            },
            'POST /hpr/registration/mobile-otp': { success: true, txnId: 't3' },
            'POST /hpr/registration/verify-mobile-otp': { success: true, txnId: 't4' },
            'GET /hpr/registration/hpid-suggestions': { success: true, suggestions: { hpIdSuggestion: ['asha.rao', 'asha.rao1'] } },
            // Shapes as the live sandbox returns them (2026-09-30).
            'GET /hpr/master/system-of-medicine': {
                success: true,
                data: [
                    { id: 1, hprType: 'doctor', medicalSystem: 'Modern Medicine', code: 'modern_medicine' },
                    { id: 3, hprType: 'doctor', medicalSystem: 'Homeopathy', code: 'homeopathy' },
                    { id: 9, hprType: 'nurse', medicalSystem: 'registered nurse (RN)', code: 'rn' },
                ],
            },
            'GET /hpr/master/states': { success: true, data: [{ id: 17, name: 'Karnataka', isoCode: '29' }] },
            'GET /hpr/master/districts/17': { success: true, data: [{ id: 300, stateId: 17, districtName: 'Bengaluru Urban', isoCode: '572' }] },
            'POST /hpr/registration/create': { success: true, hprId: 'asha.rao@hpr.abdm', hprIdNumber: '71-1234-5678-9012', name: 'Asha Kumari Rao', token: 'new-token' },
        });
        const d = deps(gateway);
        const run = createRunner(hprJourney, d);
        await run.start();
        await run.answer({ choice: 'register' });
        const linkPrompt = (await run.answer({ consent: { agreed: true, language: 'en' } })).prompt;
        expect(linkPrompt).toMatchObject({ step: 'aadhaarLink', link: { href: LINK } });
        expect(linkPrompt.choices.map((c) => c.value)).toEqual(['done', 'renew']);
        // Not finished on NHA's page yet: told so, asked again.
        expect((await run.answer({ choice: 'done' })).prompt).toMatchObject({ step: 'aadhaarLink', error: expect.stringMatching(/hasn’t confirmed your Aadhaar yet/) });
        link.authenticated = true;
        expect((await run.answer({ choice: 'done' })).prompt.step).toBe('mobile');
        expect(calls.find((c) => c.path === '/hpr/registration/check-account-exists').body).toEqual({ txnId: 'L1', preverifiedCheck: true });
        expect((await run.answer({ mobile: '9876543210' })).prompt.step).toBe('mobileOtp');
        const identity = (await run.answer({ otp: '654321' })).prompt;
        expect(identity.step).toBe('identity');
        const byName = Object.fromEntries(identity.fields.map((f) => [f.name, f]));
        expect(byName.firstName.value).toBe('Asha');
        expect(byName.middleName.value).toBe('Kumari');
        expect(byName.lastName.value).toBe('Rao');
        expect(byName.hprId.options.map((o) => o.value)).toEqual(['asha.rao', 'asha.rao1']);
        expect(byName.category.options.map((o) => o.label)).toEqual(['Doctor', 'Nurse', 'Pharmacist']);
        const juris = (await run.answer({ hprId: 'asha.rao', firstName: 'Asha', middleName: 'Kumari', lastName: 'Rao', email: 'asha@example.in', category: '1' })).prompt;
        // Doctors see only doctor systems of medicine; the value is the master's numeric id.
        expect(juris.fields[0].options.map((o) => [o.value, o.label])).toEqual([['1', 'Modern Medicine'], ['3', 'Homeopathy']]);
        const finish = (await run.answer({ subCategory: '3', state: '17' })).prompt;
        expect(finish.fields[0].options).toEqual([{ value: '572', label: 'Bengaluru Urban' }]);
        expect(finish.fields.find((f) => f.name === 'role').value).toBe('3');
        expect((await run.answer({ district: '572', role: '3', council: true, password: 'weak', confirm: 'weak' })).prompt.error).toMatch(/8\+ characters/);
        expect((await run.answer({ district: '572', role: '3', council: true, password: 'Str0ng!pass', confirm: 'Str0ng!pass' })).prompt.step).toBe('afterId');
        const end = await run.answer({ choice: 'later' });
        expect(end.result).toMatchObject({ ok: true, title: 'HPR ID created' });

        const create = calls.find((c) => c.path === '/hpr/registration/create').body;
        // stateCode/districtCode are LGD codes; districts were fetched by the state's internal id.
        // HPR-019: the KYC photo from Aadhaar goes on the HPR ID.
        expect(create).toMatchObject({ txnId: 't4', hprId: 'asha.rao', hpCategoryCode: '1', hpSubCategoryCode: '3', stateCode: '29', districtCode: '572', role: 3, council: true, profilePhotoBase64: 'KYCPHOTO' });
        expect(calls.find((c) => c.path === '/hpr/registration/mobile-otp').body).toEqual({ txnId: 'L1', mobile: '9876543210' });
        // No Aadhaar number is ever asked for or sent: it is entered on NHA's page.
        expect(JSON.stringify(calls)).not.toMatch(/"aadhaar"/);
        expect(vault.hpr(account.id).token).toBe('new-token');
        const saved = JSON.stringify(d._records.get(HPR_RECORD));
        expect(saved).toContain('71-1234-5678-9012');
        expect(saved).not.toContain('Str0ng!pass');

        // The Practitioner on ClinuxFlowProvider, validated and kept.
        expect(end.result.facts.at(-1)).toEqual(['FHIR', 'Practitioner valid against ClinuxFlowProvider']);
        expect(d.api.calls[0].path).toBe(`/$validate?profile=${encodeURIComponent(PROFILE.provider)}`);
        const { resource, validation } = d._records.get('fhir:provider');
        expect(validation.status).toBe('valid');
        expect(resource).toMatchObject({ resourceType: 'Practitioner', active: true, meta: { profile: [PROFILE.provider] }, identifier: [{ system: 'https://doctor.ndhm.gov.in', value: '71-1234-5678-9012' }] });
        expect(resource.name[0]).toMatchObject({ given: ['Asha', 'Kumari'], family: 'Rao' });
        const ext = Object.fromEntries(resource.extension.map((e) => [e.url.split('/').pop(), e.valueCode ?? e.valueBoolean]));
        expect(ext).toMatchObject({ 'hpr-category-code': '1', 'hpr-subcategory-code': '3', 'hpr-jurisdiction-state-code': '29', 'hpr-jurisdiction-district-code': '572', 'hpr-registered-with-council': true });
        expect(resource.telecom).toEqual([{ system: 'email', value: 'asha@example.in' }, { system: 'phone', value: '9876543210', use: 'mobile' }]);
    });

    it('stops when ABDM already has an HPR ID for the Aadhaar', async () => {
        const { gateway } = fakeGateway({
            ...linkRoutes(),
            'POST /hpr/registration/check-account-exists': { success: true, hpidExists: true, demographics: { hprId: 'asha@hpr.abdm' } },
        });
        const run = createRunner(hprJourney, deps(gateway));
        await run.start();
        await run.answer({ choice: 'register' });
        await run.answer({ consent: { agreed: true, language: 'en' } });
        const end = await run.answer({ choice: 'done' });
        expect(end.result).toMatchObject({ ok: false, title: 'You already have an HPR ID', facts: [['HPR ID', 'asha@hpr.abdm']] });
    });
});

const hfrRoutes = (overrides = {}) => ({
    'POST /hpr/auth/password-login': { success: true, token: 'mgr-token' },
    'GET /hfr/master/data': ({ path }) => ({ success: true, data: path.includes('OWNER') ? [{ code: 'P', value: 'Private' }] : [{ code: 'M', value: 'Modern Medicine' }, { code: 'D', value: 'Ayurveda' }] }),
    'GET /hfr/master/lgd/states': { success: true, data: [{ code: '29', name: 'Karnataka' }] },
    'GET /hfr/master/owner-subtypes': ({ path }) => {
        if (!path.includes('ownerSubtypeCode=P')) throw new GatewayError('ownerSubtypeCode cannot be null or blank.', { status: 502 });
        return { success: true, data: { type: 'PROFIT-TYPE', data: [{ code: 'PP01', value: 'Sole Proprietorship' }] } };
    },
    'GET /hfr/master/facility-types': { success: true, data: [{ code: '5', value: 'Clinic' }] },
    'GET /hfr/master/lgd/districts': { success: true, data: [{ code: '572', name: 'Bengaluru Urban' }] },
    'GET /hfr/master/lgd/subdistricts': { success: true, data: [{ code: '5555', name: 'Bengaluru North' }] },
    'GET /hfr/master/facility-sub-types': { success: true, data: { type: 'FACILITY-SUB-TYPE', data: [{ code: '30', value: 'No Applicable Subtype' }] } },
    'POST /hfr/facility/search': { success: true, facilities: [] },
    'POST /hfr/facility/basic-information': { success: true, trackingId: 'TRK-1' },
    'GET /hfr/master/specialities': ({ path }) => ({ success: true, data: path.includes('=M') ? [{ code: 'M-S1', value: 'General Medicine' }, { code: 'M-S2', value: 'Paediatrics' }] : [{ code: 'D-S9', value: 'Panchakarma' }] }),
    'POST /hfr/facility/additional-information': { success: true, trackingId: 'TRK-1', status: 'Saved' },
    'POST /hfr/facility/detailed-information': { success: true, trackingId: 'TRK-1', status: 'Saved' },
    'POST /hfr/facility/submit': { success: true, facilityId: 'IN2910000001', status: 'Pending' },
    ...overrides,
});

// Tiny "images": the PNG / JPEG signatures are what hfrPhoto checks.
const PNG = btoa('\x89PNG\r\n\x1a\n' + 'board'.repeat(8));
const JPEG = btoa('\xff\xd8\xff\xe0' + 'building'.repeat(8));
// The facility with this tracking id in the journey's facility list.
const facilityAt = (d, trackingId) => (d._records.get(HFR_FACILITIES) || []).find((f) => f.trackingId === trackingId);
const HOURS = { workingDays: ['Mon', 'Tue', 'Sat'], allDay: false, opensAt: '09:00', closesAt: '18:30', boardPhoto: { name: 'board.png', value: PNG }, buildingPhoto: { name: 'building.jpg', value: JPEG } };
const LOCATION = { ownershipSubType2: 'PP01', facilitySubType: '30', subdistrict: '5555', region: 'U', addressLine1: '1 MG Road', city: 'Bengaluru', pincode: '560001', geo: { lat: 12.97, lng: 77.59 }, phone: '9876543210', email: '' };

describe('HFR journey', () => {
    it('signs the manager in, collects the facility, checks for duplicates, drafts and submits with x-hprid-auth', async () => {
        const { gateway, calls } = fakeGateway(hfrRoutes());
        const d = deps(gateway);
        const run = createRunner(hfrJourney, d);
        expect((await run.start()).prompt.step).toBe('managerLogin');
        const facility = (await run.answer({ hprId: 'mgr@hpr.abdm', password: 'p' })).prompt;
        expect(facility.fields[0]).toMatchObject({ value: 'Ashas Clinic', pattern: FACILITY_NAME_PATTERN });
        expect((await run.answer({ facilityName: "Asha's Clinic", ownership: 'P', systemsOfMedicine: [], state: '29' })).prompt.error).toMatch(/system of medicine/);
        await run.answer({ facilityName: "Asha's Clinic", ownership: 'P', systemsOfMedicine: ['M', 'D'], state: '29' });
        expect(calls.find((c) => c.path.startsWith('/hfr/master/facility-types')).path).toContain('systemOfMedicineCode=M');
        const location = (await run.answer({ ownershipSubType: 'P', facilityType: '5', specialityType: 'SINGLE', district: '572', typesOfService: ['OPD', 'IPD'] })).prompt;
        expect(location.fields[0]).toMatchObject({ name: 'ownershipSubType2', options: [{ value: 'PP01', label: 'Sole Proprietorship' }] });
        expect((await run.answer(LOCATION)).prompt.step).toBe('hours');
        expect((await run.answer({ ...HOURS, workingDays: [] })).prompt.error).toMatch(/working day/);
        expect((await run.answer({ ...HOURS, buildingPhoto: { name: 'x.pdf', value: btoa('%PDF-1.7 not an image') } })).prompt.error).toMatch(/PNG or JPEG/);
        const review = (await run.answer(HOURS)).prompt;
        expect(review.step).toBe('review');
        expect(review.text).toMatch(/No facility/);
        expect(review.detail).toBe('HFR takes only letters, numbers and spaces, so the name is sent as "Ashas Clinic".');
        expect(calls.find((c) => c.path === '/hfr/facility/search').body.facilityName).toBe('Ashas Clinic');
        const additional = (await run.answer({ choice: 'create' })).prompt;
        expect(additional.step).toBe('additional');
        expect(facilityAt(d, 'TRK-1')).toMatchObject({ trackingId: 'TRK-1', stage: 'basic', systemsOfMedicine: ['M', 'D'], typesOfService: ['OPD', 'IPD'], address: '1 MG Road, Bengaluru, 560001' });
        const detailed = (await run.answer({ hasPharmacy: 'N', hasDiagnosticLab: 'YIN', hasImagingCenter: 'N', hasBloodBank: 'N', hasDialysisCenter: 'N', hasCathLab: 'N', nin: ' 1234 ' })).prompt;
        expect(detailed.step).toBe('detailed');
        expect(facilityAt(d, 'TRK-1').stage).toBe('additional');
        expect(detailed.fields.find((f) => f.name === 'spec_M').options).toEqual([{ value: 'M-S1', label: 'General Medicine' }, { value: 'M-S2', label: 'Paediatrics' }]);
        expect(detailed.fields.some((f) => f.name === 'countIPDBedsWithOxygen')).toBe(true); // IPD offered
        expect(detailed.fields.some((f) => f.name === 'countDayCareBedsWithOxygen')).toBe(false); // daycare not
        expect((await run.answer({ spec_M: ['M-S1'], spec_D: [], countIPDBedsWithOxygen: '120' })).prompt.error).toMatch(/0 to 99/);
        expect((await run.answer({ spec_M: ['M-S1'], spec_D: [], countIPDBedsWithoutOxygen: '10', countIPDBedsWithOxygen: '5', countICUBedsWithVentilators: '2', countHDUBedsWithVentilators: '1', countDentalChairs: '0' })).prompt.step).toBe('submit');
        expect(facilityAt(d, 'TRK-1').stage).toBe('detailed');
        const add = calls.find((c) => c.path === '/hfr/facility/additional-information').body;
        expect(add).toMatchObject({ trackingId: 'TRK-1', linkedProgramIds: { nin: '1234', abpmjayId: '' }, generalInformation: { hasDiagnosticLab: 'YIN', hasPharmacy: 'N', servicesByImagingCenter: [] } });
        const det = calls.find((c) => c.path === '/hfr/facility/detailed-information').body;
        expect(det.specialities).toEqual([
            { systemOfMedicineCode: 'M', isSpecializationAvalaible: 'Y', specialities: ['S1'] },
            { systemOfMedicineCode: 'D', isSpecializationAvalaible: 'N', specialities: [] },
        ]);
        expect(det.medicalInfrastructure).toMatchObject({ countIPDBedsWithoutOxygen: 10, totalNumberOfBeds: 16, totalNumberOfVentilators: 3, countDayCareBedsWithOxygen: 0 });
        expect(det.pharmacyDetails).toBeUndefined();
        const end = await run.answer({ choice: 'submit' });
        expect(end.result).toMatchObject({ ok: true, title: 'Submitted to HFR' });
        expect(facilityAt(d, 'TRK-1')).toMatchObject({ facilityId: 'IN2910000001', trackingId: 'TRK-1' });
        expect(end.result).toMatchObject({ readonly: true, again: 'Register another facility' });
        const org = d._records.get(facilityResourceKey('TRK-1')).resource;
        expect(org).toMatchObject({ resourceType: 'Organization', name: 'Ashas Clinic', meta: { profile: [PROFILE.facility] }, address: [{ line: ['1 MG Road'], postalCode: '560001', country: 'India' }], type: [{ coding: [{ code: 'prov' }] }] });
        expect(org.identifier.map((i) => [i.type.coding[0].code, i.system, i.value])).toEqual([
            ['PRN', 'https://clinux.yaxb.ai/fhir/sid/clinic', 'clinic-1'],
            ['PRN', 'https://facility.ndhm.gov.in', 'IN2910000001'],
        ]);
        const orgExt = org.extension.map((e) => [e.url.split('/').pop(), e.valueCode ?? e.valueDecimal]);
        expect(orgExt).toEqual(expect.arrayContaining([['hfr-facility-type', '5'], ['hfr-facility-subtype', '30'], ['hfr-system-of-medicine', 'M'], ['hfr-system-of-medicine', 'D'], ['hfr-geolocation-latitude', 12.97], ['hfr-tracking-id', 'TRK-1']]));
        expect(end.result.facts.at(-1)).toEqual(['FHIR', 'Organization valid against ClinuxFlowFacility']);
        expect(d._journal.map((e) => [e.title, e.location?.lat])).toEqual([
            ['HFR draft created for Ashas Clinic', 12.97],
            ['Ashas Clinic submitted to HFR', 12.97],
        ]);
        expect(review.map.markers[0]).toMatchObject({ id: 'yours', lat: 12.97, lng: 77.59 });

        const basic = calls.find((c) => c.path === '/hfr/facility/basic-information');
        expect(basic.headers).toEqual({ 'X-HPRID-Auth-Token': 'mgr-token' });
        expect(basic.body.facilityInformation).toMatchObject({ systemOfMedicineCode: 'M,D', typeOfServiceCode: 'OPD,IPD', ownershipCode: 'P', ownershipSubTypeCode: 'P', ownershipSubTypeCode2: 'PP01', facilityTypeCode: '5', facilitySubType: '30' });
        // HIS-1070 / HIS-4050 (live 2026-10-02): timings, and both photographs, are required.
        expect(basic.body.facilityInformation.timingsOfFacility).toEqual([
            { workingDays: 'Mon', openingHours: '9:00 AM - 6:30 PM' },
            { workingDays: 'Tue', openingHours: '9:00 AM - 6:30 PM' },
            { workingDays: 'Sat', openingHours: '9:00 AM - 6:30 PM' },
        ]);
        expect(basic.body.facilityInformation.facilityUploads).toEqual({ facilityBoardPhoto: { name: 'board.png', value: PNG }, facilityBuildingPhoto: { name: 'building.jpg', value: JPEG } });
        // The photos go to HFR only — not into what the journey keeps on this device.
        expect(JSON.stringify(d._records.get(HFR_FACILITIES))).not.toContain(PNG);
        expect(calls.find((c) => c.path.startsWith('/hfr/facility/search')).body.resultsPerPage).toBeGreaterThanOrEqual(10);
        expect(basic.body.facilityInformation.facilityAddressDetails).toMatchObject({ stateLGDCode: '29', districtLGDCode: '572', subDistrictLGDCode: '5555', pincode: '560001' });
        expect(calls.find((c) => c.path === '/hfr/facility/submit')).toMatchObject({ body: { trackingId: 'TRK-1' }, headers: { 'X-HPRID-Auth-Token': 'mgr-token' } });
    });

    it('reuses this session’s HPR sign-in and offers a saved draft for submission', async () => {
        vault.setHpr(account.id, { token: 'from-hpr-journey', hprId: 'mgr@hpr.abdm' });
        const { gateway, calls } = fakeGateway(hfrRoutes());
        const records = new Map([[HFR_RECORD, { facilityName: "Asha's Clinic", trackingId: 'TRK-9', stage: 'detailed' }]]);
        const run = createRunner(hfrJourney, deps(gateway, records));
        // The old single-facility record is migrated into the facility list.
        expect((await run.start()).prompt.step).toBe('facilities');
        expect((await run.answer({ choice: 'continue:TRK-9' })).prompt.step).toBe('submit');
        expect((await run.answer({ choice: 'submit' })).result.ok).toBe(true);
        expect(calls.map((c) => c.path)).toEqual(['/hfr/facility/submit']);
        expect(calls[0]).toMatchObject({ body: { trackingId: 'TRK-9' }, headers: { 'X-HPRID-Auth-Token': 'from-hpr-journey' } });
    });

    it('going back to an earlier step re-runs from there and updates the same draft', async () => {
        const { gateway, calls } = fakeGateway(hfrRoutes());
        const d = deps(gateway);
        const run = createRunner(hfrJourney, d);
        await run.start();
        await run.answer({ hprId: 'mgr@hpr.abdm', password: 'p' });
        await run.answer({ facilityName: 'Ashas Clinic', ownership: 'P', systemsOfMedicine: ['M'], state: '29' });
        await run.answer({ ownershipSubType: 'P', facilityType: '5', specialityType: 'SINGLE', district: '572', typesOfService: ['OPD'] });
        await run.answer(LOCATION);
        await run.answer(HOURS);
        const additional = await run.answer({ choice: 'create' });
        expect(additional.prompt.step).toBe('additional');
        expect(calls.filter((c) => c.path === '/hfr/facility/basic-information')[0].body.trackingId).toBe('');
        // Not revisitable: the sign-in. Revisitable: Location.
        expect(additional.ledger.find((st) => st.id === 'managerLogin').revisit).toBeUndefined();
        expect(additional.ledger.find((st) => st.id === 'location')).toMatchObject({ revisit: true, state: 'done' });
        await expect(run.back('managerLogin')).rejects.toThrow(/can’t be changed/);
        const location = await run.back('location');
        expect(location.prompt.step).toBe('location');
        expect(location.ledger.find((st) => st.id === 'location').state).toBe('active');
        expect(location.ledger.find((st) => st.id === 'hours').state).toBe('pending');
        expect((await run.answer({ ...LOCATION, addressLine1: '2 MG Road' })).prompt.step).toBe('hours');
        const review = (await run.answer(HOURS)).prompt;
        expect(review.choices[0]).toMatchObject({ value: 'create', label: 'Update the HFR draft' });
        expect((await run.answer({ choice: 'create' })).prompt.step).toBe('additional');
        const basics = calls.filter((c) => c.path === '/hfr/facility/basic-information');
        expect(basics).toHaveLength(2);
        expect(basics[1].body.trackingId).toBe('TRK-1'); // the same draft, updated — not a second facility
        expect(basics[1].body.facilityInformation.facilityAddressDetails.addressLine1).toBe('2 MG Road');
        expect(d._journal.map((e) => e.title)).toEqual(['HFR draft created for Ashas Clinic', 'HFR draft updated for Ashas Clinic']);
    });

    it('lists every facility: submitted ones are view-only, drafts continue, and another can be registered', async () => {
        vault.setHpr(account.id, { token: 'from-hpr-journey', hprId: 'mgr@hpr.abdm' });
        const { gateway, calls } = fakeGateway(hfrRoutes());
        const records = new Map([[HFR_FACILITIES, [
            { facilityName: 'Main Clinic', trackingId: '11', facilityId: 'IN331', status: 'Created', stage: 'detailed', submittedAt: '2026-10-01T10:00:00Z', address: '1 MG Road' },
            { facilityName: 'Branch Clinic', trackingId: '12', stage: 'additional', createdAt: '2026-10-02T10:00:00Z' },
        ]]]);
        const d = deps(gateway, records);
        let run = createRunner(hfrJourney, d);
        const list = (await run.start()).prompt;
        expect(list.choices.map((c) => c.value)).toEqual(['continue:12', 'view:11', 'update:11', 'new']);
        const view = await run.answer({ choice: 'view:11' });
        expect(view.result).toMatchObject({ ok: true, readonly: true, title: 'Main Clinic' });
        expect(view.result.facts).toEqual(expect.arrayContaining([['Facility id', 'IN331'], ['Address', '1 MG Road']]));
        expect(calls).toEqual([]); // viewing sends nothing
        // A new registration doesn't touch the others.
        run = createRunner(hfrJourney, d);
        await run.start();
        expect((await run.answer({ choice: 'new' })).prompt.step).toBe('facility');
    });

    it('updates a submitted facility: one section, sent with the facility id, no new submit', async () => {
        const submitted = { facilityName: 'Main Clinic', trackingId: '11', facilityId: 'IN2910000001', status: 'Created', stage: 'detailed', systemsOfMedicine: ['M'], typesOfService: ['OPD'], submittedAt: '2026-10-01T10:00:00Z' };
        // What the gateway's registry route answers (HFR's own record); the device copy is older.
        const registry = { facilityId: 'IN2910000001', facilityName: 'Main Clinic Renamed', ownershipCode: 'P', systemsOfMedicine: ['M'], facilityTypeCode: 'CL', facilityType: 'Clinic', stateLGDCode: '29', districtLGDCode: '572', subDistrictLGDCode: '5555', addressLine1: '1 MG Road', addressLine2: 'Bengaluru', pincode: '560001', latitude: '12.97', longitude: '77.59', contactNumber: '9345121505', contactEmailMasked: 'ma***@x.in' };
        const { gateway, calls } = fakeGateway(hfrRoutes({ 'GET /hfr/facility/IN2910000001/registry': { success: true, facility: registry } }));
        const d = deps(gateway, new Map([[HFR_FACILITIES, [submitted]]]));
        let run = createRunner(hfrJourney, d);
        await run.start();
        const what = await run.answer({ choice: 'update:11' });
        expect(what.prompt.step).toBe('updateWhat');
        const detailed = await run.answer({ choice: 'detailed' });
        expect(detailed.prompt.step).toBe('detailed');
        const done = await run.answer({ spec_M: ['M-S1'], totalBeds: '0' });
        expect(done.result).toMatchObject({ ok: true, readonly: true, title: 'Main Clinic Renamed updated in HFR' });
        const sent = calls.find((c) => c.path === '/hfr/facility/detailed-information').body;
        expect(sent.trackingId).toBe('IN2910000001'); // the facility id where the tracking id goes
        expect(calls.some((c) => c.path === '/hfr/facility/submit')).toBe(false);
        expect(d._records.get(HFR_FACILITIES)).toHaveLength(1); // the same facility, not a new entry
        expect(facilityAt(d, '11')).toMatchObject({ facilityId: 'IN2910000001', stage: 'detailed' });

        // Basic information: the manager signs in, and HFR's own record prefills the form.
        run = createRunner(hfrJourney, d);
        await run.start();
        await run.answer({ choice: 'update:11' });
        expect((await run.answer({ choice: 'basic' })).prompt.step).toBe('managerLogin');
        const facility = await run.answer({ hprId: 'mgr@hpr.abdm', password: 'p' });
        expect(facility.prompt.step).toBe('facility');
        expect(facility.prompt.fields.find((f) => f.name === 'ownership').value).toBe('P');
        expect(facility.prompt.fields.find((f) => f.name === 'systemsOfMedicine').value).toEqual(['M']);
        expect(facility.prompt.fields.find((f) => f.name === 'facilityName').value).toBe('Main Clinic Renamed');
        expect(facility.prompt.fields.find((f) => f.name === 'state').value).toBe('29');
        const classify = await run.answer({ facilityName: 'Main Clinic', ownership: 'P', systemsOfMedicine: ['M'], state: '29' });
        expect(classify.prompt.fields.find((f) => f.name === 'facilityType').value).toBe('5');
        expect(classify.prompt.fields.find((f) => f.name === 'district').value).toBe('572');
        const location = await run.answer({ ownershipSubType: 'P', facilityType: '5', specialityType: 'SINGLE', typesOfService: ['OPD'], district: '572' });
        const field = (n) => location.prompt.fields.find((f) => f.name === n);
        expect([field('addressLine1').value, field('city').value, field('pincode').value, field('subdistrict').value, field('phone').value]).toEqual(['1 MG Road', 'Bengaluru', '560001', '5555', '9345121505']);
        expect(field('geo').value).toEqual({ lat: 12.97, lng: 77.59 });
        expect(field('email').hint).toMatch(/masked \(ma\*\*\*@x.in\)/);
        await run.answer(LOCATION);
        const review = await run.answer(HOURS);
        expect(review.prompt.choices[0]).toMatchObject({ value: 'create', label: 'Send the update to HFR' });
        const end = await run.answer({ choice: 'create' });
        expect(end.result.title).toBe('Main Clinic Renamed updated in HFR');
        const basic = calls.filter((c) => c.path === '/hfr/facility/basic-information').at(-1);
        expect(basic.body.trackingId).toBe('IN2910000001');
        expect(basic.headers['X-HPRID-Auth-Token']).toBe('mgr-token');
    });

    it('a draft resumes at the first section HFR does not have yet', async () => {
        const { gateway, calls } = fakeGateway(hfrRoutes());
        // Saved after Basic Information only, by an earlier visit (no HPR session now).
        const records = new Map([[HFR_RECORD, { facilityName: 'Ashas Clinic', trackingId: 'TRK-7', stage: 'basic', systemsOfMedicine: ['M'], typesOfService: ['OPD'] }]]);
        const d = deps(gateway, records);
        const run = createRunner(hfrJourney, d);
        const list = (await run.start()).prompt;
        expect(list.step).toBe('facilities');
        expect(list.choices[0]).toMatchObject({ value: 'continue:TRK-7' });
        expect(list.choices[0].detail).toMatch(/programmes and services next/);
        expect((await run.answer({ choice: 'continue:TRK-7' })).prompt.step).toBe('additional');
        const detailed = (await run.answer({ hasPharmacy: 'YALL', hasDiagnosticLab: 'N', hasImagingCenter: 'N', hasBloodBank: 'N', hasDialysisCenter: 'N', hasCathLab: 'N' })).prompt;
        // OPD only: no bed counts at all (HFR refuses Medical Infrastructure for OPD, live 2026-10-02).
        expect(detailed.fields.map((f) => f.name)).toEqual(['spec_M', 'drugLicenseNumber', 'pharmacistRegistrationNumber', 'pharmacyGstinNumber', 'janAushadhiKendraId']);
        // No HPR session: sign in, then straight to submit (not back to a new facility).
        expect((await run.answer({ spec_M: [], drugLicenseNumber: 'DL-1', pharmacistRegistrationNumber: 'PR-1' })).prompt.step).toBe('managerLogin');
        expect((await run.answer({ hprId: 'mgr@hpr.abdm', password: 'p' })).prompt.step).toBe('submit');
        const det = calls.find((c) => c.path === '/hfr/facility/detailed-information').body;
        expect(det).toMatchObject({ trackingId: 'TRK-7', pharmacyDetails: { drugLicenseNumber: 'DL-1', isJanAushadhiKendra: 'N' } });
        expect(det.medicalInfrastructure).toBeUndefined();
        expect(calls.some((c) => c.path === '/hfr/facility/basic-information')).toBe(false);
    });

    it('a draft saved before its systems of medicine were kept asks for them', async () => {
        const { gateway, calls } = fakeGateway(hfrRoutes());
        const records = new Map([[HFR_RECORD, { facilityName: 'Ashas Clinic', trackingId: '98065' }]]);
        const run = createRunner(hfrJourney, deps(gateway, records));
        await run.start();
        await run.answer({ choice: 'continue:98065' });
        const detailed = (await run.answer({ hasPharmacy: 'N', hasDiagnosticLab: 'N', hasImagingCenter: 'N', hasBloodBank: 'N', hasDialysisCenter: 'N', hasCathLab: 'N' })).prompt;
        expect(detailed.fields[0]).toMatchObject({ name: 'systemsOfMedicine', type: 'multiselect', required: true });
        expect(detailed.fields[1]).toMatchObject({ name: 'typesOfService', type: 'multiselect', value: ['OPD'] });
        expect((await run.answer({ systemsOfMedicine: ['M'], typesOfService: ['OPD'] })).prompt.step).toBe('managerLogin');
        expect(calls.find((c) => c.path === '/hfr/facility/detailed-information').body.medicalInfrastructure).toBeUndefined();
    });

    it('HFR refusing a section in its 200 answer is shown and asked again', async () => {
        const { gateway } = fakeGateway(hfrRoutes({ 'POST /hfr/facility/additional-information': { success: true, trackingId: null, errorStatus: [{ message: 'Invalid NIN' }] } }));
        const records = new Map([[HFR_RECORD, { facilityName: 'X', trackingId: '1', stage: 'basic', systemsOfMedicine: ['M'] }]]);
        const run = createRunner(hfrJourney, deps(gateway, records));
        await run.start();
        await run.answer({ choice: 'continue:1' });
        const again = (await run.answer({ hasPharmacy: 'N', hasDiagnosticLab: 'N', hasImagingCenter: 'N', hasBloodBank: 'N', hasDialysisCenter: 'N', hasCathLab: 'N', nin: 'x' })).prompt;
        expect(again).toMatchObject({ step: 'additional', error: 'Invalid NIN' });
    });

    it('stopping at the duplicate check sends nothing to HFR', async () => {
        const { gateway, calls } = fakeGateway(hfrRoutes({ 'POST /hfr/facility/search': { success: true, facilities: [{ facilityName: "Asha's Clinic", facilityId: 'IN29X' }] } }));
        const run = createRunner(hfrJourney, deps(gateway));
        await run.start();
        await run.answer({ hprId: 'm', password: 'p' });
        await run.answer({ facilityName: "Asha's Clinic", ownership: 'P', systemsOfMedicine: ['M'], state: '29' });
        await run.answer({ ownershipSubType: 'P', facilityType: '5', specialityType: 'SINGLE', district: '572', typesOfService: ['OPD', 'IPD'] });
        await run.answer(LOCATION);
        const review = (await run.answer(HOURS)).prompt;
        expect(review.list).toEqual([{ name: "Asha's Clinic", detail: 'IN29X' }]);
        expect((await run.answer({ choice: 'stop' })).result.title).toBe('Nothing was sent to HFR');
        expect(calls.some((c) => c.path === '/hfr/facility/basic-information')).toBe(false);
    });

    it('hfrName gives the name in the form HFR accepts', () => {
        const ok = new RegExp(FACILITY_NAME_PATTERN);
        for (const [typed, sent] of [["Dr. Rao's Clinic", 'Dr Raos Clinic'], ['Sri Clinic (Main), Chennai', 'Sri Clinic Main Chennai'], ['24x7 Care & Cure', 'Care Cure'], ['Clinic 24x7', 'Clinic 24x7']]) {
            expect(hfrName(typed)).toBe(sent);
            expect(ok.test(sent)).toBe(true);
        }
        expect(ok.test('Sri-Clinic')).toBe(false);
    });

    it('a refused duplicate check asks again with the error', async () => {
        const { gateway } = fakeGateway(hfrRoutes({ 'POST /hfr/facility/search': () => { throw new GatewayError('Please enter valid facility Name.', { status: 502 }); } }));
        const run = createRunner(hfrJourney, deps(gateway));
        await run.start();
        await run.answer({ hprId: 'm', password: 'p' });
        await run.answer({ facilityName: 'Ashas Clinic', ownership: 'P', systemsOfMedicine: ['M'], state: '29' });
        await run.answer({ ownershipSubType: 'P', facilityType: '5', specialityType: 'SINGLE', district: '572', typesOfService: ['OPD', 'IPD'] });
        const again = (await run.answer(LOCATION)).prompt;
        expect(again).toMatchObject({ step: 'location', error: 'Please enter valid facility Name.' });
    });

    it('prefills the manager sign-in from the HPR ID on the Cübo profile, and marks it a sign-in step', async () => {
        const { gateway } = fakeGateway(hfrRoutes());
        const records = new Map([['abdm:hpr', { hprId: 'asha@hpr.abdm' }]]);
        const first = await createRunner(hfrJourney, deps(gateway, records)).start();
        expect(first.prompt.fields[0]).toMatchObject({ name: 'hprId', value: 'asha@hpr.abdm' });
        expect(first.prompt.detail).toMatch(/Cübo profile has HPR ID asha@hpr.abdm/);
        expect(first.ledger.find((st) => st.id === 'managerLogin')).toMatchObject({ signIn: 'hpr', state: 'active' });
    });

    it('asks for the type of service unless the facility type is exempt', async () => {
        const { gateway } = fakeGateway(hfrRoutes({ 'GET /hfr/master/facility-types': { success: true, data: [{ code: '5', value: 'Clinic' }, { code: '9', value: 'Pharmacy' }] } }));
        const run = createRunner(hfrJourney, deps(gateway));
        await run.start();
        await run.answer({ hprId: 'm', password: 'p' });
        await run.answer({ facilityName: 'Ashas Clinic', ownership: 'P', systemsOfMedicine: ['M'], state: '29' });
        const classify = { ownershipSubType: 'P', specialityType: 'SINGLE', district: '572', typesOfService: [] };
        expect((await run.answer({ ...classify, facilityType: '5' })).prompt.error).toMatch(/type of service/);
        expect((await run.answer({ ...classify, facilityType: '9' })).prompt.step).toBe('location');
    });

    it('24×7 and the time format HFR takes', async () => {
        expect(hfrTime('09:05')).toBe('9:05 AM');
        expect(hfrTime('00:00')).toBe('12:00 AM');
        expect(hfrTime('12:30')).toBe('12:30 PM');
        expect(hfrTime('23:59')).toBe('11:59 PM');
        expect(hfrTime('')).toBeNull();
        const info = buildBasicInformation({ systemsOfMedicine: ['M'], workingDays: ['Sun'], openingHours: '24*7' }).facilityInformation;
        expect(info.timingsOfFacility).toEqual([{ workingDays: 'Sun', openingHours: '24*7' }]);
        expect(() => hfrPhoto(null, 'board photo')).toThrow(/Add the board photo/);
        expect(() => hfrPhoto({ name: 'big.png', value: PNG + 'A'.repeat(7 * 1024 * 1024) }, 'board photo')).toThrow(/5 MB/);
    });

    it('buildBasicInformation defaults what the journey does not ask', () => {
        const info = buildBasicInformation({ facilityName: 'X', systemsOfMedicine: ['M'] }).facilityInformation;
        expect(info).toMatchObject({ specialityTypeCode: 'SINGLE', facilityOperationalStatus: 'F', systemOfMedicineCode: 'M' });
        expect(info.facilityAddressDetails.facilityRegion).toBe('U');
    });
});

describe('NHA HPR checklist', () => {
    const aadhaarRoutes = (extra = {}) => ({
        ...linkRoutes(),
        'POST /hpr/registration/check-account-exists': { success: true, hpidExists: false, demographics: { firstName: 'Asha', middleName: 'Kumari', lastName: 'Rao', address: '12 MG Road', districtName: 'Bengaluru Urban', stateName: 'Karnataka', pincode: '560001' } },
        'POST /hpr/registration/demographic-auth-mobile': { success: true, txnId: 'tm' },
        'POST /hpr/registration/mobile-otp': ({ calls }) => ({ success: true, txnId: `m${calls.length}` }),
        'POST /hpr/registration/verify-mobile-otp': ({ body }) => ({ success: true, txnId: body.txnId }),
        'GET /hpr/registration/hpid-suggestions': { success: true, suggestions: ['asha.rao'] },
        'GET /hpr/master/system-of-medicine': { success: true, data: [{ id: 1, hprType: 'doctor', medicalSystem: 'Modern Medicine' }] },
        'GET /hpr/master/states': { success: true, data: [{ id: 17, name: 'Karnataka', isoCode: '29' }] },
        ...extra,
    });

    it('HPR-003/004: shows NHA consent verbatim in English and Hindi, and records the agreement; no link before it', async () => {
        const { gateway, calls } = fakeGateway(aadhaarRoutes());
        const d = deps(gateway);
        const run = createRunner(hprJourney, d);
        await run.start();
        const p = (await run.answer({ choice: 'register' })).prompt;
        expect(p.fields.map((f) => f.name)).toEqual(['consent']); // the Aadhaar number is entered on NHA's page
        const consent = p.fields[0];
        expect(consent.texts.en.paragraphs[0]).toMatch(/^I, hereby declare that I am voluntarily sharing my Aadhaar Number/);
        expect(consent.texts.hi.paragraphs[0]).toMatch(/^इसके द्वारा मैं यह स्पष्ट करता हूं/);
        expect((await run.answer({ consent: { agreed: false, language: 'hi' } })).prompt.error).toMatch(/agree to the consent/);
        expect(calls).toHaveLength(0);
        await run.answer({ consent: { agreed: true, language: 'hi' } });
        expect(d._records.get(AADHAAR_CONSENT_RECORD)).toMatchObject({ language: 'hi', version: expect.any(String), at: expect.any(String) });
        expect(calls.map((c) => c.path)).toEqual(['/hpr/registration/aadhaar-link']);
    });

    it('an expired or unopened link can be replaced with a new one', async () => {
        let t = Date.now();
        const state = { authenticated: false };
        const { gateway, calls } = fakeGateway(aadhaarRoutes({ ...linkRoutes(state) }));
        const run = createRunner(hprJourney, { ...deps(gateway), now: () => t });
        await run.start();
        await run.answer({ choice: 'register' });
        await run.answer({ consent: { agreed: true, language: 'en' } });
        t += 6 * 60_000;
        expect((await run.answer({ choice: 'done' })).prompt.error).toMatch(/link has expired/);
        const renewed = (await run.answer({ choice: 'renew' })).prompt;
        expect(renewed).toMatchObject({ step: 'aadhaarLink', detail: expect.stringMatching(/A new link has been made/) });
        state.authenticated = true;
        await run.answer({ choice: 'done' });
        // Status and details are asked about the newest link's transaction.
        expect(calls.filter((c) => c.path === '/hpr/registration/aadhaar-link/details').map((c) => c.body.txnId)).toEqual(['L2']);
    });

    it('HPR-008: the mobile OTP resend waits 60 s, allows 2 resends, then blocks for 30 minutes', async () => {
        let t = 1_000_000;
        const { gateway, calls } = fakeGateway(aadhaarRoutes({ 'POST /hpr/registration/demographic-auth-mobile': () => { throw new GatewayError('no match', { status: 502 }); } }));
        const d = { ...deps(gateway), now: () => t };
        const run = createRunner(hprJourney, d);
        await run.start();
        await run.answer({ choice: 'register' });
        await run.answer({ consent: { agreed: true, language: 'en' } });
        await run.answer({ choice: 'done' });
        let p = (await run.answer({ mobile: '9876543210' })).prompt;
        expect(p).toMatchObject({ step: 'mobileOtp', resend: { ok: false, availableAt: t + 60_000, remaining: 2 } });
        expect((await run.answer({ resend: true })).prompt.error).toMatch(/s after the last one/);
        t += 60_000;
        p = (await run.answer({ resend: true })).prompt;
        expect(p).toMatchObject({ step: 'mobileOtp', error: null, detail: 'A new OTP has been sent.' });
        t += 60_000;
        p = (await run.answer({ resend: true })).prompt;
        expect(p.resend).toMatchObject({ ok: false, blockedUntil: t + OTP_RESEND.blockMs });
        expect(calls.filter((c) => c.path === '/hpr/registration/mobile-otp')).toHaveLength(3);
    });

    it('doc v2.0: a mobile check answering verified: false goes to the mobile OTP; the account-check photo is used when the Aadhaar page gave none', async () => {
        const { gateway, calls } = fakeGateway(
            aadhaarRoutes({
                ...linkRoutes({ authenticated: true }, { photo: null }),
                'POST /hpr/registration/check-account-exists': { success: true, hpidExists: false, photo: 'ACCOUNT_PHOTO', demographics: { firstName: 'Asha', lastName: 'Rao' } },
                'POST /hpr/registration/demographic-auth-mobile': { success: true, verified: false },
                'GET /hpr/master/districts/17': { success: true, data: [{ id: 300, districtName: 'Bengaluru Urban', isoCode: '572' }] },
                'POST /hpr/registration/create': { success: true, hprId: 'asha.rao@hpr.abdm' },
            }),
        );
        const run = createRunner(hprJourney, deps(gateway));
        await run.start();
        await run.answer({ choice: 'register' });
        await run.answer({ consent: { agreed: true, language: 'en' } });
        await run.answer({ choice: 'done' });
        expect((await run.answer({ mobile: '9876543210' })).prompt.step).toBe('mobileOtp');
        await run.answer({ otp: '654321' });
        await run.answer({ hprId: 'asha.rao', firstName: 'Asha', lastName: 'Rao', email: 'a@example.in', category: '1' });
        await run.answer({ subCategory: '1', state: '17' });
        await run.answer({ district: '572', role: '1', council: false, password: 'Str0ng!pass', confirm: 'Str0ng!pass' });
        expect(calls.find((c) => c.path === '/hpr/registration/create').body.profilePhotoBase64).toBe('ACCOUNT_PHOTO');
    });

    it('HPR-027/028/029/037: names and address from Aadhaar are read-only, and edits are ignored', async () => {
        const { gateway, calls } = fakeGateway(
            aadhaarRoutes({
                'GET /hpr/master/districts/17': { success: true, data: [{ id: 300, districtName: 'Bengaluru Urban', isoCode: '572' }] },
                'POST /hpr/registration/create': ({ body }) => ({ success: true, hprId: `${body.hprId}@hpr.abdm`, name: `${body.firstName} ${body.lastName}` }),
            }),
        );
        const run = createRunner(hprJourney, deps(gateway));
        await run.start();
        await run.answer({ choice: 'register' });
        await run.answer({ consent: { agreed: true, language: 'en' } });
        await run.answer({ choice: 'done' });
        const identity = (await run.answer({ mobile: '9876543210' })).prompt;
        const f = Object.fromEntries(identity.fields.map((x) => [x.name, x]));
        expect([f.firstName.readonly, f.middleName.readonly, f.lastName.readonly]).toEqual([true, true, true]);
        expect(f.kycAddress).toMatchObject({ readonly: true, value: '12 MG Road, Bengaluru Urban, Karnataka, 560001' });
        await run.answer({ hprId: 'asha.rao', firstName: 'Mallory', middleName: '', lastName: 'Forged', email: 'a@example.in', category: '1' });
        await run.answer({ subCategory: '1', state: '17' });
        await run.answer({ district: '572', role: '1', council: false, password: 'Str0ng!pass', confirm: 'Str0ng!pass' });
        expect(calls.find((c) => c.path === '/hpr/registration/create').body).toMatchObject({ firstName: 'Asha', middleName: 'Kumari', lastName: 'Rao' });
    });

    it('resendState and afterSend', () => {
        let sends = afterSend(null, 0, false);
        expect(resendState(sends, 59_999)).toMatchObject({ ok: false, remaining: 2 });
        expect(resendState(sends, 60_000)).toMatchObject({ ok: true, remaining: 2 });
        sends = afterSend(sends, 60_000, true);
        sends = afterSend(sends, 120_000, true);
        expect(resendState(sends, 180_000)).toMatchObject({ ok: false, blockedUntil: 120_000 + OTP_RESEND.blockMs });
        expect(resendState(sends, 120_000 + OTP_RESEND.blockMs)).toMatchObject({ ok: true, remaining: 2 });
        expect(afterSend(sends, 120_000 + OTP_RESEND.blockMs, true).resends).toBe(1);
        expect(Object.keys(HPR_AADHAAR_CONSENT)).toEqual(['en', 'hi']);
    });
});

describe('FHIR output and roles', () => {
    it('an incomplete Practitioner is kept and the missing parts are reported', async () => {
        const { gateway } = fakeGateway({
            'POST /hpr/auth/password-login': { success: true, token: 't' },
            'POST /hpr/professional/fetch': { success: true, practitioner: { name: 'Dr Asha Rao' } },
        });
        const api = fakeApi([{ severity: 'error', diagnostics: "slice 'hpCategoryCode' requires at least 1, found 0" }]);
        const d = deps(gateway, new Map(), api);
        const run = createRunner(hprJourney, d);
        await run.start();
        await run.answer({ choice: 'link' });
        await run.answer({ hprId: 'asha@hpr.abdm', password: 'x' });
        const end = await run.answer({ choice: 'later' });
        expect(end.result.ok).toBe(true);
        expect(end.result.facts.at(-1)[1]).toMatch(/incomplete for ClinuxFlowProvider: .*hpCategoryCode/);
        expect(d._records.get('fhir:provider').validation.status).toBe('invalid');
    });

    it('an unreachable FHIR API leaves the resource pending, not lost', async () => {
        const { gateway } = fakeGateway({ 'POST /hpr/auth/password-login': { success: true, token: 't' }, 'POST /hpr/professional/fetch': {} });
        const api = async () => {
            throw new TypeError('fetch failed');
        };
        const d = deps(gateway, new Map(), api);
        const run = createRunner(hprJourney, d);
        await run.start();
        await run.answer({ choice: 'link' });
        await run.answer({ hprId: 'a@hpr.abdm', password: 'x' });
        expect(d._records.get('fhir:provider').validation.status).toBe('pending');
    });

});

describe('runtime and helpers', () => {
    it('cancel forgets the run', async () => {
        const { gateway } = fakeGateway(linkRoutes());
        const run = createRunner(hprJourney, deps(gateway));
        await run.start();
        await run.answer({ choice: 'register' });
        await run.answer({ consent: { agreed: true, language: 'en' } });
        await run.cancel();
        await expect(run.answer({ choice: 'done' })).rejects.toThrow(/ended/);
    });

    it('vault tokens expire and are per account', () => {
        vault.setHpr('a', { token: 't', expiresIn: 60 }, 0);
        expect(vault.hpr('a', 59_000).token).toBe('t');
        expect(vault.hpr('a', 60_000)).toBeNull();
        expect(vault.hpr('b', 0)).toBeNull();
    });

    it('toOptions trims HFR’s space-padded codes', () => {
        expect(toOptions({ type: 'OWNER', data: [{ code: 'G         ', value: 'Government      ' }] })).toEqual([{ value: 'G', label: 'Government' }]);
    });

    it('toOptions normalises ABDM master shapes', () => {
        expect(toOptions({ data: [{ id: 1, name: 'A', children: [{ code: 'x', value: 'X' }] }, 'B'] })).toEqual([
            { value: '1', label: 'A', children: [{ value: 'x', label: 'X' }] },
            { value: 'B', label: 'B' },
        ]);
        expect(toOptions(null)).toEqual([]);
    });

});
