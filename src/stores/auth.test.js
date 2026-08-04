import { describe, it, expect } from 'vitest';
import { mergeAccountWithLocalProfile } from './auth.js';

describe('mergeAccountWithLocalProfile', () => {
  it('preserves local-only fields (services/phone/city/careTeam/address) from the existing row', () => {
    const account = { id: '1', email: 'a@b.com', clinicName: 'City Clinic', tier: 'free' };
    const existingLocalRow = { id: '1', services: 'General', phone: '555-1234', city: 'Springfield', careTeam: 'x', address: '1 Main St' };
    const merged = mergeAccountWithLocalProfile(account, existingLocalRow);
    expect(merged).toMatchObject({
      id: '1', email: 'a@b.com', clinicName: 'City Clinic', tier: 'free',
      services: 'General', phone: '555-1234', city: 'Springfield', careTeam: 'x', address: '1 Main St',
    });
  });

  it('server identity fields always win over a stale local copy of the same field', () => {
    const account = { id: '1', clinicName: 'New Name', tier: 'paid' };
    const existingLocalRow = { id: '1', clinicName: 'Stale Old Name', tier: 'free', phone: '555-1234' };
    const merged = mergeAccountWithLocalProfile(account, existingLocalRow);
    expect(merged.clinicName).toBe('New Name');
    expect(merged.tier).toBe('paid');
    expect(merged.phone).toBe('555-1234');
  });

  it('defaults local-only fields to "" on a brand-new registration (no existing local row)', () => {
    const account = { id: '1', email: 'a@b.com', tier: 'free' };
    const merged = mergeAccountWithLocalProfile(account, null);
    expect(merged).toMatchObject({
      id: '1', email: 'a@b.com', tier: 'free',
      services: '', phone: '', city: '', careTeam: '', address: '',
    });
  });
});
