// Ported from clinux-cubo's test/journeys.test.js (HPR, HFR, NHA checklist, FHIR output, runtime):
// the journeys here are the same modules, so they keep Cübo's tests. UHI and the assistant aren't
// part of the workspace, so their cases were dropped, as was journeysFor(role) — the workspace
// lists every journey (see index.js).
import { beforeEach, describe, expect, it } from 'vitest';
import { createRunner } from './runtime.js';
import { HPR_RECORD, hprJourney } from './hprJourney.js';
import { FACILITY_NAME_PATTERN, HFR_RECORD, buildBasicInformation, hfrJourney, hfrName } from './hfrJourney.js';
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
    it('links an existing HPR ID: signs in, keeps the token in memory only, saves the link', async () => {
        const { gateway, calls } = fakeGateway({
            'POST /hpr/auth/password-login': { success: true, token: 'hpr-token', expiresIn: 600 },
            'POST /hpr/professional/fetch': { success: true, practitioner: { name: 'Dr Asha Rao' } },
        });
        const d = deps(gateway);
        const run = createRunner(hprJourney, d);
        expect((await run.start()).prompt.step).toBe('mode');
        expect((await run.answer({ choice: 'link' })).prompt.step).toBe('login');
        const end = await run.answer({ hprId: 'asha@hpr.abdm', password: 'S3cret!pass' });
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
        expect((await run.answer({ hprId: 'a@hpr.abdm', password: 'y' })).result.ok).toBe(true);
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
        const end = await run.answer({ district: '572', role: '3', council: true, password: 'Str0ng!pass', confirm: 'Str0ng!pass' });
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
    'POST /hfr/facility/submit': { success: true, facilityId: 'IN2910000001', status: 'Pending' },
    ...overrides,
});

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
        const location = (await run.answer({ ownershipSubType: 'P', facilityType: '5', specialityType: 'SINGLE', district: '572' })).prompt;
        expect(location.fields[0]).toMatchObject({ name: 'ownershipSubType2', options: [{ value: 'PP01', label: 'Sole Proprietorship' }] });
        const review = (await run.answer(LOCATION)).prompt;
        expect(review.step).toBe('review');
        expect(review.text).toMatch(/No facility/);
        expect(review.detail).toBe('HFR takes only letters, numbers and spaces, so the name is sent as "Ashas Clinic".');
        expect(calls.find((c) => c.path === '/hfr/facility/search').body.facilityName).toBe('Ashas Clinic');
        expect((await run.answer({ choice: 'create' })).prompt.step).toBe('submit');
        expect(d._records.get(HFR_RECORD)).toMatchObject({ trackingId: 'TRK-1' });
        const end = await run.answer({ choice: 'submit' });
        expect(end.result).toMatchObject({ ok: true, title: 'Submitted to HFR' });
        expect(d._records.get(HFR_RECORD)).toMatchObject({ facilityId: 'IN2910000001', trackingId: 'TRK-1' });
        const org = d._records.get('fhir:facility').resource;
        expect(org).toMatchObject({ resourceType: 'Organization', name: 'Ashas Clinic', meta: { profile: [PROFILE.facility] }, address: [{ line: ['1 MG Road'], postalCode: '560001', country: 'India' }], type: [{ coding: [{ code: 'prov' }] }] });
        expect(org.identifier.map((i) => [i.type.coding[0].code, i.system, i.value])).toEqual([
            ['PRN', 'https://clinux.yaxb.ai/fhir/sid/clinic', 'clinic-1'],
            ['PRN', 'https://facility.ndhm.gov.in', 'IN2910000001'],
        ]);
        const orgExt = org.extension.map((e) => [e.url.split('/').pop(), e.valueCode ?? e.valueDecimal]);
        expect(orgExt).toEqual(expect.arrayContaining([['hfr-facility-type', '5'], ['hfr-facility-subtype', '30'], ['hfr-system-of-medicine', 'M'], ['hfr-system-of-medicine', 'D'], ['hfr-geolocation-latitude', 12.97], ['hfr-tracking-id', 'TRK-1']]));
        expect(end.result.facts.at(-1)).toEqual(['FHIR', 'Organization valid against ClinuxFlowFacility']);
        expect(d._journal.map((e) => [e.title, e.location?.lat])).toEqual([
            ['HFR draft for Ashas Clinic', 12.97],
            ['Ashas Clinic submitted to HFR', 12.97],
        ]);
        expect(review.map.markers[0]).toMatchObject({ id: 'yours', lat: 12.97, lng: 77.59 });

        const basic = calls.find((c) => c.path === '/hfr/facility/basic-information');
        expect(basic.headers).toEqual({ 'X-HPRID-Auth-Token': 'mgr-token' });
        expect(basic.body.facilityInformation).toMatchObject({ systemOfMedicineCode: 'M,D', ownershipCode: 'P', ownershipSubTypeCode: 'P', ownershipSubTypeCode2: 'PP01', facilityTypeCode: '5', facilitySubType: '30' });
        expect(calls.find((c) => c.path.startsWith('/hfr/facility/search')).body.resultsPerPage).toBeGreaterThanOrEqual(10);
        expect(basic.body.facilityInformation.facilityAddressDetails).toMatchObject({ stateLGDCode: '29', districtLGDCode: '572', subDistrictLGDCode: '5555', pincode: '560001' });
        expect(calls.find((c) => c.path === '/hfr/facility/submit')).toMatchObject({ body: { trackingId: 'TRK-1' }, headers: { 'X-HPRID-Auth-Token': 'mgr-token' } });
    });

    it('reuses this session’s HPR sign-in and offers a saved draft for submission', async () => {
        vault.setHpr(account.id, { token: 'from-hpr-journey', hprId: 'mgr@hpr.abdm' });
        const { gateway, calls } = fakeGateway(hfrRoutes());
        const records = new Map([[HFR_RECORD, { facilityName: "Asha's Clinic", trackingId: 'TRK-9' }]]);
        const run = createRunner(hfrJourney, deps(gateway, records));
        expect((await run.start()).prompt.step).toBe('resume');
        expect((await run.answer({ choice: 'submit' })).prompt.step).toBe('submit');
        expect((await run.answer({ choice: 'submit' })).result.ok).toBe(true);
        expect(calls.map((c) => c.path)).toEqual(['/hfr/facility/submit']);
        expect(calls[0]).toMatchObject({ body: { trackingId: 'TRK-9' }, headers: { 'X-HPRID-Auth-Token': 'from-hpr-journey' } });
    });

    it('stopping at the duplicate check sends nothing to HFR', async () => {
        const { gateway, calls } = fakeGateway(hfrRoutes({ 'POST /hfr/facility/search': { success: true, facilities: [{ facilityName: "Asha's Clinic", facilityId: 'IN29X' }] } }));
        const run = createRunner(hfrJourney, deps(gateway));
        await run.start();
        await run.answer({ hprId: 'm', password: 'p' });
        await run.answer({ facilityName: "Asha's Clinic", ownership: 'P', systemsOfMedicine: ['M'], state: '29' });
        await run.answer({ ownershipSubType: 'P', facilityType: '5', specialityType: 'SINGLE', district: '572' });
        const review = (await run.answer(LOCATION)).prompt;
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
        await run.answer({ ownershipSubType: 'P', facilityType: '5', specialityType: 'SINGLE', district: '572' });
        const again = (await run.answer(LOCATION)).prompt;
        expect(again).toMatchObject({ step: 'location', error: 'Please enter valid facility Name.' });
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
        const end = await run.answer({ hprId: 'asha@hpr.abdm', password: 'x' });
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
