import { describe, expect, it } from 'vitest';
import { createRunner } from './runtime.js';
import { GatewayError } from './gateway.js';
import { FIND_SCOPE, abhaPerson, birthDate, cardKey, dashedAbhaNumber, findReturning, namesMatch, parseAbhaQr, patientAbhaJourney } from './patientAbhaJourney.js';
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
  const store = new Map();
  return {
    gateway,
    records: { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) },
    _store: store,
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
  const PATIENTS = [
    { value: 'rec-1', label: 'Asha Rao', mobile: '9876543210' },
    { value: 'rec-2', label: 'Ravi Kumar', mobile: '9000000001', abhaNumber: '91-1111-2222-3333', abhaAddress: 'ravi@sbx' },
  ];

  it('starts with how, and offers every M1 lane', async () => {
    const v = await createRunner(patientAbhaJourney, deps(fakeGateway({}).gateway)).start();
    expect(v.prompt.step).toBe('mode');
    expect(v.prompt.choices.map((c) => c.value)).toEqual(['find', 'number', 'address', 'qr', 'create', 'face', 'dl']);
    const preset = await createRunner(patientAbhaJourney, deps(fakeGateway({}).gateway)).start({ patientId: 'rec-1' });
    expect(preset.prompt.text).toMatch(/Asha Rao/);
  });

  it('finds an ABHA by mobile, verifies the OTP and records it on the given patient, then hands over the card', async () => {
    const { gateway, calls } = fakeGateway({
      'POST /abha/find/search': { success: true, txnId: 't1', matches: [{ index: 1, abhaNumber: 'xx-xxxx-xxxx-3333', name: 'Asha Rao', gender: 'F', kycVerified: true }] },
      'POST /abha/login/request-otp': { success: true, txnId: 't2', message: 'OTP sent to ******3210' },
      'POST /abha/login/verify-otp': { success: true, abhaToken: 'abha-tok', accounts: [ACCOUNT] },
      'GET /abha/session/profile': ({ headers }) => ({ success: true, profile: { abhaNumber: '91-1111-2222-3333', name: 'Asha Rao', gender: 'F', yearOfBirth: '1990', monthOfBirth: '4', dayOfBirth: '9', kind: headers['X-ABHA-Kind'] } }),
      'GET /abha/session/card': { success: true, contentType: 'image/png', data: 'iVBOR' },
    });
    const d = deps(gateway);
    const run = createRunner(patientAbhaJourney, d);
    await run.start({ patientId: 'rec-1' });
    expect((await run.answer({ choice: 'find' })).prompt.step).toBe('findMobile');
    const pick = await run.answer({ mobile: '9876543210', consent: true });
    expect(pick.prompt.choices[0].detail).toMatch(/KYC verified/);
    await run.answer({ choice: '1' });
    expect(calls.find((c) => c.path === '/abha/login/request-otp').body).toEqual({ scope: FIND_SCOPE, loginHint: 'index', loginId: '1', otpSystem: 'abdm' });
    const confirm = await run.answer({ otp: '123456' });
    expect(confirm.prompt.step).toBe('confirm');
    expect(confirm.prompt.warning).toBeUndefined();
    const after = await run.answer({ choice: 'save' });
    expect(after.prompt.step).toBe('after');
    expect(after.prompt.download).toEqual({ href: 'data:image/png;base64,iVBOR', filename: 'ABHA-91111122223333.png', label: 'Download ABHA card' });
    expect(d._store.get(cardKey({ abhaNumber: '91-1111-2222-3333' }))).toMatchObject({ contentType: 'image/png', data: 'iVBOR' });
    const done = await run.answer({ choice: 'done' });
    expect(done.result).toMatchObject({ ok: true, readonly: true, title: 'ABHA verified · new patient' });
    expect(done.result.download.href).toMatch(/^data:image\/png/);
    expect(d._saved).toEqual([{ id: 'rec-1', person: expect.objectContaining({ abhaNumber: '91-1111-2222-3333', abhaAddress: 'asha.rao@sbx', gender: 'female', birthDate: '1990-04-09' }) }]);
    expect(d._journal[0].title).toMatch(/ABHA recorded/);
  });

  it('a search with no match asks again instead of failing', async () => {
    const { gateway } = fakeGateway({ 'POST /abha/find/search': { success: true, txnId: 't1', matches: [] } });
    const run = createRunner(patientAbhaJourney, deps(gateway));
    await run.start();
    await run.answer({ choice: 'find' });
    const again = await run.answer({ mobile: '9876543210', consent: true });
    expect(again.prompt.step).toBe('findMobile');
    expect(again.prompt.error).toMatch(/no ABHA/);
  });

  it('recognises a returning patient by their ABHA number', async () => {
    const { gateway } = fakeGateway({
      'POST /abha/login/request-otp': { success: true, txnId: 't1' },
      'POST /abha/login/verify-otp': { success: true, abhaToken: 'tok', accounts: [{ ABHANumber: '91-1111-2222-3333', name: 'Ravi Kumar' }] },
      'GET /abha/session/profile': { success: true, profile: { abhaNumber: '91-1111-2222-3333', name: 'Ravi Kumar', gender: 'M' } },
      'GET /abha/session/card': () => { throw new GatewayError('ABDM is down'); },
    });
    const d = deps(gateway, PATIENTS);
    const run = createRunner(patientAbhaJourney, d);
    await run.start();
    await run.answer({ choice: 'number' });
    const sent = await run.answer({ abhaNumber: '91111122223333', otpSystem: 'abdm', consent: true });
    expect(sent.prompt.step).toBe('numberOtp');
    const confirm = await run.answer({ otp: '654321' });
    expect(confirm.prompt.text).toMatch(/^Returning patient: Ravi Kumar/);
    const after = await run.answer({ choice: 'save' });
    expect(after.prompt.warning).toMatch(/couldn’t be downloaded: ABDM is down/);
    const done = await run.answer({ choice: 'done' });
    expect(done.result.title).toBe('ABHA verified · returning patient');
    expect(d._saved[0].id).toBe('rec-2');
  });

  it('warns when the ABHA name does not look like the given patient', async () => {
    const { gateway } = fakeGateway({
      'POST /abha/login/request-otp': { success: true, txnId: 't1' },
      'POST /abha/login/verify-otp': { success: true, abhaToken: 'tok', accounts: [{ ABHANumber: '91-9999-2222-3333', name: 'Ravi Kumar' }] },
      'GET /abha/session/profile': { success: true, profile: {} },
    });
    const run = createRunner(patientAbhaJourney, deps(gateway));
    await run.start({ patientId: 'rec-1' });
    await run.answer({ choice: 'number' });
    await run.answer({ abhaNumber: '91-9999-2222-3333', otpSystem: 'aadhaar', consent: true });
    expect((await run.answer({ otp: '654321' })).prompt.warning).toMatch(/doesn’t look like Asha Rao/);
  });

  it('a new patient can be attached to an existing record that has no ABHA yet', async () => {
    const { gateway } = fakeGateway({
      'POST /abha/login/address/request-otp': { success: true, txnId: 'a1', message: 'OTP sent' },
      'POST /abha/login/address/verify-otp': { success: true, abhaToken: 'phr', tokenKind: 'phr', account: { abhaAddress: 'asha.r@sbx', fullName: 'Asha Rao' } },
      'GET /abha/session/profile': ({ headers }) => { expect(headers['X-ABHA-Kind']).toBe('phr'); return { success: true, profile: { abhaAddress: 'asha.r@sbx', name: 'Asha Rao', gender: 'F' } }; },
      'GET /abha/session/card': { success: true, contentType: 'application/pdf', data: 'JVBER' },
    });
    const d = deps(gateway, PATIENTS);
    const run = createRunner(patientAbhaJourney, d);
    await run.start();
    await run.answer({ choice: 'address' });
    await run.answer({ abhaAddress: 'Asha.R@sbx', consent: true });
    const confirm = await run.answer({ otp: '111111' });
    expect(confirm.prompt.text).toMatch(/^New patient/);
    const pick = await run.answer({ choice: 'attach' });
    expect(pick.prompt.step).toBe('pickPatient');
    expect(pick.prompt.fields[0].options.map((o) => o.value)).toEqual(['rec-1']); // rec-2 already has an ABHA
    const after = await run.answer({ patientId: 'rec-1' });
    expect(after.prompt.download.filename).toBe('ABHA-asha.r@sbx.pdf');
    // An ABHA-address (PHR) session can't change the ABHA profile.
    expect((await run.answer({ choice: 'mobile' })).prompt.error).toMatch(/can’t be changed here/);
    expect(d._saved[0]).toMatchObject({ id: 'rec-1', person: { abhaAddress: 'asha.r@sbx' } });
  });

  it('scans the patient’s ABHA QR, then verifies it by OTP', async () => {
    const { gateway, calls } = fakeGateway({
      'POST /abha/login/request-otp': { success: true, txnId: 't1' },
      'POST /abha/login/verify-otp': { success: true, abhaToken: 'tok', accounts: [{ ABHANumber: '91-5555-6666-7777', name: 'Mala Devi' }] },
      'GET /abha/session/profile': { success: true, profile: {} },
    });
    const run = createRunner(patientAbhaJourney, deps(gateway, []));
    await run.start();
    await run.answer({ choice: 'qr' });
    const bad = await run.answer({ qr: 'https://example.com' });
    expect(bad.prompt.error).toMatch(/isn’t an ABHA card’s/);
    const login = await run.answer({ qr: JSON.stringify({ hidn: '91-5555-6666-7777', hid: 'mala@sbx', name: 'Mala Devi', gender: 'F', dob: '1/1/1980' }) });
    expect(login.prompt.step).toBe('numberLogin');
    expect(login.prompt.fields[0].value).toBe('91-5555-6666-7777');
    await run.answer({ abhaNumber: '91-5555-6666-7777', otpSystem: 'abdm', consent: true });
    const confirm = await run.answer({ otp: '123456' });
    expect(confirm.prompt.text).toMatch(/Scanned from their ABHA QR and verified by OTP/);
    expect(calls.map((c) => c.path)).toContain('/abha/login/verify-otp');
  });

  it('takes a Scan & Share patient from the queue without an OTP', async () => {
    const { gateway, calls } = fakeGateway({
      'POST /abha/scan-share/queue/s-1/claim': { success: true, share: { id: 's-1', facilityId: 'IN3310002300', context: '2', tokenNumber: 7, patient: { abhaNumber: 91000011112222, abhaAddress: 'kiran@sbx', name: 'Kiran S', gender: 'M', dayOfBirth: '5', monthOfBirth: '6', yearOfBirth: '1988', phoneNumber: '9811111111' } } },
    });
    const d = deps(gateway, PATIENTS);
    const run = createRunner(patientAbhaJourney, d);
    const confirm = await run.start({ shareId: 's-1' });
    expect(confirm.prompt.step).toBe('confirm');
    expect(confirm.prompt.text).toMatch(/^New patient.*facility QR/);
    expect(confirm.prompt.list).toEqual(expect.arrayContaining([{ name: 'Token', detail: '7 (counter 2)' }, { name: 'ABHA number', detail: '91-0000-1111-2222' }]));
    const done = await run.answer({ choice: 'new' }); // no ABHA session: no card / update step
    expect(done.result).toMatchObject({ title: 'ABHA verified · new patient', text: 'A new patient record was created from the ABHA.' });
    expect(d._saved[0]).toEqual({ id: null, person: expect.objectContaining({ abhaNumber: '91-0000-1111-2222', birthDate: '1988-06-05', mobile: '9811111111', gender: 'male' }) });
    expect(calls).toHaveLength(1);
  });

  it('creates an ABHA with Aadhaar OTP, verifies a different mobile, sets the address and creates the patient', async () => {
    const { gateway, calls } = fakeGateway({
      'POST /abha/enrollment/aadhaar-otp': { success: true, txnId: 'e1', message: 'OTP sent' },
      'POST /abha/enrollment/verify-aadhaar-otp': { success: true, txnId: 'e1', abhaToken: 'tok', isNew: true, profile: { ABHANumber: '91-4444-5555-6666', firstName: 'Meera', lastName: 'Iyer', gender: 'F', dob: '02-03-1985', phrAddress: ['91444455556666@sbx'] } },
      'POST /abha/enrollment/mobile-otp': { success: true, txnId: 'e1' },
      'POST /abha/enrollment/verify-mobile-otp': { success: true, txnId: 'e1', authResult: 'success' },
      'GET /abha/enrollment/address-suggestions': { success: true, suggestions: ['meera.iyer', 'meera1985'] },
      'POST /abha/enrollment/address': { success: true },
      'GET /abha/session/card': { success: true, contentType: 'image/png', data: 'x' },
      'POST /abha/profile/mobile/request-otp': ({ headers }) => { expect(headers['X-ABHA-Token']).toBe('tok'); return { success: true, txnId: 'u1' }; },
      'POST /abha/profile/mobile/verify-otp': { success: true },
      'POST /abha/enrollment/email-verification-link': { success: true },
    });
    const d = deps(gateway, []);
    const run = createRunner(patientAbhaJourney, d);
    await run.start();
    await run.answer({ choice: 'create' });
    const otp = await run.answer({ aadhaar: '1234 5678 9012', consent: true });
    expect(otp.prompt.step).toBe('aadhaarOtp');
    expect(calls[0].body).toEqual({ aadhaar: '123456789012' });
    expect((await run.answer({ otp: '111111', mobile: '9123456789' })).prompt.step).toBe('mobileOtp');
    const address = await run.answer({ otp: '222222' });
    expect(address.prompt.fields[0].options.map((o) => o.value)).toEqual(['meera.iyer', 'meera1985']);
    const confirm = await run.answer({ suggestion: 'meera.iyer', custom: '', keep: false });
    expect(confirm.prompt.text).toMatch(/^New patient: no record in this clinic has ABHA 91-4444-5555-6666/);
    await run.answer({ choice: 'new' });
    // Profile update: mobile, then email.
    await run.answer({ choice: 'mobile' });
    await run.answer({ mobile: '9333333333' });
    const back = await run.answer({ otp: '333333' });
    expect(back.prompt.step).toBe('after');
    expect(back.prompt.text).toMatch(/now uses mobile ••••3333/);
    await run.answer({ choice: 'email' });
    expect((await run.answer({ email: 'meera@example.in' })).prompt.text).toMatch(/verification link to meera@example.in/);
    const done = await run.answer({ choice: 'done' });
    expect(done.result.title).toBe('ABHA created · new patient');
    expect(d._saved[0]).toEqual({ id: null, person: expect.objectContaining({ abhaNumber: '91-4444-5555-6666', abhaAddress: 'meera.iyer@sbx', birthDate: '1985-03-02', mobile: '9123456789' }) });
    expect(JSON.stringify(calls.slice(1))).not.toContain('123456789012');
  });

  it('creates an ABHA by face authentication: QR for the ABHA app, poll, then Aadhaar', async () => {
    let status = 'PENDING';
    const { gateway, calls } = fakeGateway({
      'POST /abha/enrollment/face/init': { success: true, txnId: 'f1', qrUrl: 'https://phrsbx.abdm.gov.in/face-auth?txnId=f1' },
      'POST /abha/enrollment/face/status': () => ({ success: true, status, txnId: 'f1' }),
      'POST /abha/enrollment/face/enrol': { success: true, txnId: 'f1', abhaToken: 'tok', profile: { ABHANumber: '91-7777-8888-9999', firstName: 'Nilam', lastName: 'Jadhav', gender: 'F', mobile: '9123456789', phrAddress: ['nilam@sbx'] } },
      'GET /abha/enrollment/address-suggestions': { success: true, suggestions: [] },
      'GET /abha/session/card': { success: true, contentType: 'image/png', data: 'x' },
    });
    const run = createRunner(patientAbhaJourney, deps(gateway, []));
    await run.start();
    await run.answer({ choice: 'face' });
    const wait = await run.answer({ mobile: '9123456789', consent: true });
    expect(wait.prompt).toMatchObject({ step: 'faceWait', qr: 'https://phrsbx.abdm.gov.in/face-auth?txnId=f1' });
    expect((await run.answer({ choice: 'check' })).prompt.detail).toMatch(/still waiting/);
    status = 'COMPLETE';
    const aadhaar = await run.answer({ choice: 'check' });
    expect(aadhaar.prompt.step).toBe('faceAadhaar');
    const address = await run.answer({ aadhaar: '123412341234' });
    expect(address.prompt.step).toBe('address'); // mobile matched Aadhaar's: no extra OTP
    expect(calls.find((c) => c.path === '/abha/enrollment/face/enrol').body).toEqual({ txnId: 'f1', aadhaar: '123412341234', mobile: '9123456789' });
    const confirm = await run.answer({ keep: true });
    expect(confirm.prompt.text).toMatch(/face authentication/);
  });

  it('creates an ABHA with a driving licence', async () => {
    const { gateway, calls } = fakeGateway({
      'POST /abha/enrollment/dl/mobile-otp': { success: true, txnId: 'd1', message: 'OTP sent' },
      'POST /abha/enrollment/dl/verify-mobile-otp': { success: true, txnId: 'd1' },
      'POST /abha/enrollment/dl/document': { success: true, enrolment: { enrolmentNumber: '91-6087-5423-0001', enrolmentState: 'VERIFIED', firstName: 'Anand', lastName: 'S', dob: '1996-7-15', gender: 'M', mobile: '******3603', phrAddress: ['91608754230001@abdm'] } },
    });
    const d = deps(gateway, []);
    const run = createRunner(patientAbhaJourney, d);
    await run.start();
    await run.answer({ choice: 'dl' });
    await run.answer({ mobile: '9876543603', consent: true });
    const doc = await run.answer({ otp: '123456' });
    expect(doc.prompt.step).toBe('dlDocument');
    const photo = { name: 'f.jpg', value: 'AAA', type: 'image/jpeg' };
    const confirm = await run.answer({ documentId: 'mh13 20140019054', dob: '1996-07-15', firstName: 'Anand', lastName: 'S', gender: 'M', address: 'Pune', district: 'Pune', state: 'Maharashtra', pinCode: '413005', frontSidePhoto: photo, backSidePhoto: { ...photo, value: 'BBB' } });
    expect(calls.at(-1).body).toMatchObject({ txnId: 'd1', documentId: 'MH1320140019054', frontSidePhoto: 'AAA', backSidePhoto: 'BBB', dob: '1996-07-15' });
    expect(confirm.prompt.list).toEqual(expect.arrayContaining([{ name: 'Enrolment number', detail: '91-6087-5423-0001' }]));
    const done = await run.answer({ choice: 'new' });
    expect(done.result.title).toBe('ABHA created · new patient');
    expect(d._saved[0].person).toMatchObject({ birthDate: '1996-07-15', mobile: '9876543603', abhaAddress: '91608754230001@abdm' });
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

  it('a patient whose ABHA is already recorded opens read-only, with the card kept on this device', async () => {
    const calls = [];
    const gateway = async (path) => { calls.push(path); throw new Error('no call expected'); };
    const d = deps(gateway, [{ value: 'rec-1', label: 'Asha Rao', abhaNumber: '91-1111-2222-3333', abhaAddress: 'asha@sbx' }]);
    d._store.set(cardKey({ abhaNumber: '91-1111-2222-3333' }), { contentType: 'image/png', data: 'x' });
    const view = await createRunner(patientAbhaJourney, d).start({ patientId: 'rec-1' });
    expect(view.result).toMatchObject({ ok: true, readonly: true, againFresh: true });
    expect(view.result.download.href).toBe('data:image/png;base64,x');
    expect(view.result.facts).toEqual(expect.arrayContaining([['ABHA number', '91-1111-2222-3333'], ['ABHA address', 'asha@sbx']]));
    expect(calls).toEqual([]);
  });
});

describe('ABHA QR codes and matching', () => {
  it('reads ABDM’s QR JSON and plain text', () => {
    expect(parseAbhaQr('{"hidn":"91-5555-6666-7777","hid":"Mala@SBX","name":"Mala","gender":"F","dob":"1/1/1980","mobile":"9000000000"}'))
      .toEqual({ abhaNumber: '91-5555-6666-7777', abhaAddress: 'mala@sbx', name: 'Mala', gender: 'F', dob: '1/1/1980', mobile: '9000000000' });
    expect(parseAbhaQr('{"ABHA Number":"91555566667777"}').abhaNumber).toBe('91-5555-6666-7777');
    expect(parseAbhaQr('ABHA 91-5555-6666-7777 mala@sbx')).toMatchObject({ abhaNumber: '91-5555-6666-7777', abhaAddress: 'mala@sbx' });
    expect(parseAbhaQr('hello')).toBeNull();
    expect(parseAbhaQr('')).toBeNull();
  });

  it('finds a returning patient by ABHA number or address', () => {
    const list = [{ value: 'a', abhaNumber: '91-1111-2222-3333' }, { value: 'b', abhaAddress: 'Ravi@sbx' }, { value: 'c' }];
    expect(findReturning(list, { abhaNumber: '91111122223333' })?.value).toBe('a');
    expect(findReturning(list, { abhaAddress: 'ravi@sbx' })?.value).toBe('b');
    expect(findReturning(list, { abhaNumber: '91-0000-0000-0000', abhaAddress: 'x@sbx' })).toBeNull();
  });

  it('dashes 14-digit ABHA numbers', () => {
    expect(dashedAbhaNumber(91178386101251)).toBe('91-1783-8610-1251');
    expect(dashedAbhaNumber('91-1')).toBe('91-1');
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
});
