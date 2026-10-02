import { describe, expect, it } from 'vitest';
import { addressFor, chatAnswer, check, initialValues, summarise } from './promptForm.js';

const choices = { text: 'Link or register?', choices: [{ value: 'login', label: 'I have an HPR ID' }, { value: 'register', label: 'Register a new HPR ID' }] };
const mobile = { text: 'Your mobile', fields: [{ name: 'mobile', label: 'Mobile', pattern: '^[6-9]\\d{9}$', required: true }] };

describe('initialValues', () => {
  it('starts each field at its type’s empty value or its given value', () => {
    const p = { fields: [{ name: 'a' }, { name: 'b', type: 'checkbox' }, { name: 'c', type: 'multiselect' }, { name: 'd', type: 'geo' }, { name: 'e', value: 'x' }] };
    expect(initialValues(p)).toEqual({ a: '', b: false, c: [], d: null, e: 'x' });
  });
  it('keeps what was entered on a re-ask, except secrets', () => {
    const p = { fields: [{ name: 'hprId' }, { name: 'password', secret: true }] };
    expect(initialValues(p, { hprId: 'asha@hpr.abdm', password: 'p' })).toEqual({ hprId: 'asha@hpr.abdm', password: '' });
  });
});

describe('check', () => {
  it('reports required and pattern problems', () => {
    expect(check(mobile, { mobile: '' })).toBe('Mobile is required.');
    expect(check(mobile, { mobile: '12345' })).toMatch(/doesn't look right/);
    expect(check(mobile, { mobile: '9876543210' })).toBe('');
  });
});

describe('summarise', () => {
  it('masks secrets and last-4 fields', () => {
    const p = { fields: [{ name: 'otp', label: 'OTP', secret: true }, { name: 'aadhaar', label: 'Aadhaar', mask: 'last4' }] };
    expect(summarise(p, { otp: '123456', aadhaar: '123412341234' })).toBe('OTP: ••••••\nAadhaar: ••••••1234');
  });
  it('shows a choice by its label and a resend as such', () => {
    expect(summarise(choices, { choice: 'register' })).toBe('Register a new HPR ID');
    expect(summarise(mobile, { resend: true })).toBe('Resend OTP');
  });
});

describe('chatAnswer', () => {
  it('picks a choice by number, label, value, or a unique part of a label', () => {
    expect(chatAnswer(choices, '2')).toEqual({ value: { choice: 'register' } });
    expect(chatAnswer(choices, 'i have an hpr id')).toEqual({ value: { choice: 'login' } });
    expect(chatAnswer(choices, 'LOGIN')).toEqual({ value: { choice: 'login' } });
    expect(chatAnswer(choices, 'register a')).toEqual({ value: { choice: 'register' } });
  });
  it('lists the choices when nothing matches (or the match is ambiguous)', () => {
    expect(chatAnswer(choices, 'hpr').reason).toMatch(/1\. I have an HPR ID · 2\. Register/);
  });
  it('answers a one-field form, checked like the form would be', () => {
    expect(chatAnswer(mobile, ' 9876543210 ')).toEqual({ value: { mobile: '9876543210' } });
    expect(chatAnswer(mobile, '123').reason).toMatch(/doesn't look right/);
  });
  it('never takes a secret or masked field from the chat', () => {
    expect(chatAnswer({ fields: [{ name: 'otp', label: 'OTP', secret: true }] }, '123456').reason).toMatch(/needs the form/);
    expect(chatAnswer({ fields: [{ name: 'aadhaar', label: 'Aadhaar', mask: 'last4' }] }, '123412341234').reason).toMatch(/needs the form/);
  });
  it('sends multi-field steps to the form', () => {
    expect(chatAnswer({ fields: [{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }] }, 'x').reason).toMatch(/needs the form/);
  });
  it('matches a select field by its option label', () => {
    const p = { fields: [{ name: 'state', label: 'State', type: 'select', options: [{ value: '27', label: 'Maharashtra' }] }] };
    expect(chatAnswer(p, 'maharashtra')).toEqual({ value: { state: '27' } });
  });
  it('says so when nothing is being asked', () => {
    expect(chatAnswer(null, 'hi').reason).toMatch(/not waiting/);
  });
});

describe('addressFor', () => {
  const prompt = {
    fields: [
      { name: 'subdistrict', type: 'select', options: [{ value: '4321', label: 'Haveli' }] },
      { name: 'addressLine1' }, { name: 'city' }, { name: 'pincode' },
      { name: 'geo', type: 'geo', near: { fields: ['addressLine1', 'city', 'subdistrict', 'pincode'], context: ['Pune District', 'Maharashtra'] } },
    ],
  };
  const geo = prompt.fields[4];
  it('builds the address from the entered fields (selects by label) plus the context', () => {
    const a = addressFor(prompt, geo, { addressLine1: '12 MG Road', city: 'Pune', subdistrict: '4321', pincode: '411001' });
    expect(a.parts).toEqual({ addressLine1: '12 MG Road', city: 'Pune', subdistrict: 'Haveli', pincode: '411001' });
    expect(a.text).toBe('12 MG Road, Pune, Haveli, 411001, Pune District, Maharashtra');
  });
  it('is empty until something is entered', () => {
    expect(addressFor(prompt, geo, { addressLine1: '', city: '', subdistrict: '', pincode: '' }).text).toBe('');
  });
});
