import { describe, expect, it } from 'vitest';
import { createRunner } from './runtime.js';
import { GatewayError } from './gateway.js';
import { FIND_SCOPE, NEW_PATIENT, abhaPerson, birthDate, namesMatch, patientAbhaJourney } from './patientAbhaJourney.js';
import { mergeAbhaIntoPatientResponse } from './patientRecord.js';

/** A fake gateway, same shape as journeys.test.js's: "METHOD /path" (query stripped) -> handler or value. */
function fakeGateway(routes) {
  const calls = [];
  const gateway = async (path, { method = 'GET', body, headers } = {}) => {
    calls.push({ method, path, body, headers });
    const route = routes[`${method} ${path.split('?')[0]}`];
    if (route === undefined) throw new GatewayError(`no fake for ${method} ${path}`, { status: 404 });
    return typeof route === 'function' ? route({ path, body, headers }) : route;
  };
  return { gateway, calls };
}

function deps(gateway, list = [{ value: 'rec-1', label: 'Asha Rao', mobile: '9876543210' }]) {
  const saved = [];
  const journal = [];
  return {
    gateway,
    now: () => 1_000_000,
    journal: { add: async (e) => journal.push(e) },
    patients: {
      list: async () => list,
      saveAbha: async (id, person) => { saved.push({ id, person }); return id || 'rec-new'; },
    },
    _saved: saved,
    _journal: journal,
  };
}

const ACCOUNT = { ABHANumber: '91-1111-2222-3333', preferredAbhaAddress: 'asha.rao@sbx', name: 'Asha Rao', gender: 'F', yearOfBirth: 1990, monthOfBirth: 4, dayOfBirth: 9 };

describe('patient ABHA journey', () => {
  it('asks whose ABHA it is, unless a patient was given', async () => {
    const run = createRunner(patientAbhaJourney, deps(fakeGateway({}).gateway));
    expect((await run.start()).prompt.step).toBe('pickPatient');

    const preset = createRunner(patientAbhaJourney, deps(fakeGateway({}).gateway));
    const v = await preset.start({ patientId: 'rec-1' });
    expect(v.prompt.step).toBe('mode');
    expect(v.prompt.text).toMatch(/Asha Rao/);
  });

  it('finds an ABHA by mobile, verifies the OTP and records it on the patient', async () => {
    const { gateway, calls } = fakeGateway({
      'POST /abha/find/search': { success: true, txnId: 't1', matches: [{ index: 1, abhaNumber: 'xx-xxxx-xxxx-3333', name: 'Asha Rao', gender: 'F', kycVerified: true }] },
      'POST /abha/login/request-otp': { success: true, txnId: 't2', message: 'OTP sent to ******3210' },
      'POST /abha/login/verify-otp': { success: true, abhaToken: 'abha-tok', accounts: [ACCOUNT] },
    });
    const d = deps(gateway);
    const run = createRunner(patientAbhaJourney, d);
    await run.start({ patientId: 'rec-1' });
    expect((await run.answer({ choice: 'find' })).prompt.step).toBe('findMobile');
    const pick = await run.answer({ mobile: '9876543210', consent: true });
    expect(pick.prompt.step).toBe('pickMatch');
    expect(pick.prompt.choices[0].detail).toMatch(/KYC verified/);
    const otp = await run.answer({ choice: '1' });
    expect(otp.prompt.step).toBe('findOtp');
    expect(calls.find((c) => c.path === '/abha/login/request-otp').body).toEqual({ scope: FIND_SCOPE, loginHint: 'index', loginId: '1', otpSystem: 'abdm' });
    const confirm = await run.answer({ otp: '123456' });
    expect(confirm.prompt.step).toBe('confirm');
    expect(confirm.prompt.warning).toBeUndefined();
    const done = await run.answer({ choice: 'save' });
    expect(done.done).toBe(true);
    expect(done.result.ok).toBe(true);
    expect(d._saved).toEqual([{ id: 'rec-1', person: expect.objectContaining({ abhaNumber: '91-1111-2222-3333', abhaAddress: 'asha.rao@sbx', gender: 'female', birthDate: '1990-04-09' }) }]);
    expect(d._journal[0].title).toMatch(/ABHA recorded/);
  });

  it('a search with no match asks again instead of failing', async () => {
    const { gateway } = fakeGateway({ 'POST /abha/find/search': { success: true, txnId: 't1', matches: [] } });
    const run = createRunner(patientAbhaJourney, deps(gateway));
    await run.start({ patientId: 'rec-1' });
    await run.answer({ choice: 'find' });
    const again = await run.answer({ mobile: '9876543210', consent: true });
    expect(again.prompt.step).toBe('findMobile');
    expect(again.prompt.error).toMatch(/no ABHA/);
  });

  it('verifies an ABHA number with the profile call, and warns when the name does not match', async () => {
    const { gateway, calls } = fakeGateway({
      'POST /abha/login/request-otp': { success: true, txnId: 't1' },
      'POST /abha/login/verify-otp': { success: true, abhaToken: 'tok', accounts: [{ ABHANumber: '91-1111-2222-3333', name: 'Ravi Kumar' }] },
      'GET /abha/profile': ({ headers }) => {
        expect(headers['X-ABHA-Token']).toBe('tok');
        return { success: true, ABHANumber: '91-1111-2222-3333', name: 'Ravi Kumar', gender: 'M' };
      },
    });
    const run = createRunner(patientAbhaJourney, deps(gateway));
    await run.start({ patientId: 'rec-1' });
    await run.answer({ choice: 'number' });
    await run.answer({ abhaNumber: '91-1111-2222-3333', otpSystem: 'abdm', consent: true });
    expect(calls[0].body).toEqual({ scope: ['abha-login', 'mobile-verify'], loginHint: 'abha-number', loginId: '91111122223333', otpSystem: 'abdm' });
    const confirm = await run.answer({ otp: '654321' });
    expect(confirm.prompt.step).toBe('confirm');
    expect(confirm.prompt.warning).toMatch(/doesn’t look like Asha Rao/);
  });

  it('creates an ABHA with Aadhaar, verifies a different mobile, sets the address and creates the patient', async () => {
    const { gateway, calls } = fakeGateway({
      'POST /abha/enrollment/aadhaar-otp': { success: true, txnId: 'e1', message: 'OTP sent' },
      'POST /abha/enrollment/verify-aadhaar-otp': { success: true, txnId: 'e1', abhaToken: 'tok', isNew: true, profile: { ABHANumber: '91-4444-5555-6666', firstName: 'Meera', lastName: 'Iyer', gender: 'F', dob: '02-03-1985', phrAddress: ['91444455556666@sbx'] } },
      'POST /abha/enrollment/mobile-otp': { success: true, txnId: 'e1' },
      'POST /abha/enrollment/verify-mobile-otp': { success: true, txnId: 'e1', authResult: 'success' },
      'GET /abha/enrollment/address-suggestions': { success: true, suggestions: ['meera.iyer', 'meera1985'] },
      'POST /abha/enrollment/address': { success: true },
    });
    const d = deps(gateway, []);
    const run = createRunner(patientAbhaJourney, d);
    await run.start();
    await run.answer({ patientId: NEW_PATIENT });
    await run.answer({ choice: 'create' });
    const otp = await run.answer({ aadhaar: '1234 5678 9012', consent: true });
    expect(otp.prompt.step).toBe('aadhaarOtp');
    // The Aadhaar went out once and is not in any later call.
    expect(calls[0].body).toEqual({ aadhaar: '123456789012' });
    const mobile = await run.answer({ otp: '111111', mobile: '9123456789' });
    expect(mobile.prompt.step).toBe('mobileOtp'); // no profile.mobile -> ABDM must verify it
    const address = await run.answer({ otp: '222222' });
    expect(address.prompt.step).toBe('address');
    expect(address.prompt.fields[0].options.map((o) => o.value)).toEqual(['meera.iyer', 'meera1985']);
    const confirm = await run.answer({ suggestion: 'meera.iyer', custom: '', keep: false });
    expect(confirm.prompt.text).toMatch(/Create a patient record for Meera Iyer/);
    const done = await run.answer({ choice: 'save' });
    expect(done.result.title).toBe('ABHA created and recorded');
    expect(d._saved[0]).toEqual({ id: null, person: expect.objectContaining({ abhaNumber: '91-4444-5555-6666', abhaAddress: 'meera.iyer@sbx', birthDate: '1985-03-02', mobile: '9123456789' }) });
    expect(JSON.stringify(calls.slice(1))).not.toContain('123456789012');
  });

  it('rejects a malformed Aadhaar before anything is sent', async () => {
    const { gateway, calls } = fakeGateway({});
    const run = createRunner(patientAbhaJourney, deps(gateway));
    await run.start({ patientId: 'rec-1' });
    await run.answer({ choice: 'create' });
    const again = await run.answer({ aadhaar: '1234', consent: true });
    expect(again.prompt.step).toBe('aadhaar');
    expect(again.prompt.error).toMatch(/12 digits/);
    expect(calls).toEqual([]);
  });

  it('records nothing when the staff member declines', async () => {
    const { gateway } = fakeGateway({
      'POST /abha/find/search': { success: true, txnId: 't', matches: [{ index: 0, name: 'Asha Rao' }] },
      'POST /abha/login/request-otp': { success: true, txnId: 't2' },
      'POST /abha/login/verify-otp': { success: true, accounts: [ACCOUNT] },
    });
    const d = deps(gateway);
    const run = createRunner(patientAbhaJourney, d);
    await run.start({ patientId: 'rec-1' });
    await run.answer({ choice: 'find' });
    await run.answer({ mobile: '9876543210', consent: true });
    await run.answer({ choice: '0' });
    await run.answer({ otp: '123456' });
    const done = await run.answer({ choice: 'no' });
    expect(done.result.title).toBe('Nothing was recorded');
    expect(d._saved).toEqual([]);
  });
});

describe('ABHA profile helpers', () => {
  it('reads both ABDM date shapes', () => {
    expect(birthDate({ dob: '09-04-1990' })).toBe('1990-04-09');
    expect(birthDate({ yearOfBirth: 1990, monthOfBirth: 4, dayOfBirth: 9 })).toBe('1990-04-09');
    expect(birthDate({ yearOfBirth: 1990 })).toBeUndefined();
  });

  it('normalises enrolment and login profiles', () => {
    expect(abhaPerson({ ABHANumber: '1', firstName: 'Meera', lastName: 'Iyer', phrAddress: ['m@sbx'], gender: 'F' })).toMatchObject({ abhaNumber: '1', name: 'Meera Iyer', abhaAddress: 'm@sbx', gender: 'female' });
    expect(abhaPerson({ name: 'Asha Rao', preferredAbhaAddress: 'a@sbx' })).toMatchObject({ firstName: 'Asha', lastName: 'Rao', abhaAddress: 'a@sbx' });
  });

  it('matches names on a shared part of 3+ letters', () => {
    expect(namesMatch('Asha Rao', 'ASHA R.')).toBe(true);
    expect(namesMatch('Ravi Kumar', 'Asha Rao')).toBe(false);
  });
});

describe('mergeAbhaIntoPatientResponse', () => {
  const answers = (qr) => Object.fromEntries(qr.item[0].item.map((i) => [i.linkId, Object.values(i.answer[0])[0]]));

  it('builds a new patient from the ABHA', () => {
    const qr = mergeAbhaIntoPatientResponse(null, { abhaNumber: '91-1', abhaAddress: 'a@sbx', firstName: 'Asha', lastName: 'Rao', gender: 'female', birthDate: '1990-04-09', mobile: '98' });
    expect(qr.resourceType).toBe('QuestionnaireResponse');
    expect(answers(qr)).toEqual({
      patient_abha_number: '91-1', patient_abha_address: 'a@sbx', patient_first_name: 'Asha', patient_last_name: 'Rao',
      patient_gender: 'female', patient_birthdate: '1990-04-09', patient_mobile: '98', patient_active: true, patient_name: 'Asha Rao',
    });
  });

  it('overwrites the ABHA fields but never what the clinic typed in', () => {
    const existing = { resourceType: 'QuestionnaireResponse', status: 'completed', item: [{ linkId: 'section_patient', item: [
      { linkId: 'patient_first_name', answer: [{ valueString: 'Aasha' }] },
      { linkId: 'patient_mobile', answer: [{ valueString: '9000000000' }] },
      { linkId: 'patient_abha_number', answer: [{ valueString: 'old' }] },
    ] }] };
    const a = answers(mergeAbhaIntoPatientResponse(existing, { abhaNumber: '91-1', firstName: 'Asha', lastName: 'Rao', mobile: '98' }));
    expect(a.patient_first_name).toBe('Aasha');
    expect(a.patient_mobile).toBe('9000000000');
    expect(a.patient_abha_number).toBe('91-1');
    expect(a.patient_last_name).toBe('Rao');
    expect(a.patient_name).toBe('Aasha Rao');
  });

  it('a patient whose ABHA is already recorded opens read-only, without asking ABDM anything', async () => {
    const calls = [];
    const gateway = async (path) => { calls.push(path); throw new Error('no call expected'); };
    const run = createRunner(patientAbhaJourney, deps(gateway, [{ value: 'rec-1', label: 'Asha Rao', mobile: '9876543210', abhaNumber: '91-1111-2222-3333', abhaAddress: 'asha@sbx' }]));
    await run.start();
    const view = await run.answer({ patientId: 'rec-1' });
    expect(view.result).toMatchObject({ ok: true, readonly: true, againFresh: true });
    expect(view.result.facts).toEqual(expect.arrayContaining([['ABHA number', '91-1111-2222-3333'], ['ABHA address', 'asha@sbx']]));
    expect(calls).toEqual([]);
    // Opened for that patient directly (PatientHome's "Set up ABHA"): straight to the view.
    expect((await createRunner(patientAbhaJourney, deps(gateway, [{ value: 'rec-1', label: 'Asha Rao', abhaNumber: '91-1111-2222-3333' }])).start({ patientId: 'rec-1' })).result.readonly).toBe(true);
  });
});
