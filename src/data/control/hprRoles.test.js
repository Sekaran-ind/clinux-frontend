import { describe, it, expect } from 'vitest';
import { HPR_ROLES, HPR_ROLE_LABELS, hprRoleLabel, HPR_ROLE_CODE_CHOICES } from './hprRoles.js';

describe('hprRoles — single source of truth for the HPR role vocabulary', () => {
  it('covers exactly the 3 real HPR-bound account roles, once each', () => {
    const accountRoles = HPR_ROLES.map((r) => r.accountRole).sort();
    expect(accountRoles).toEqual(['admin_and_health_professional', 'health_professional', 'hospital_admin']);
  });

  it('every entry has a real, non-empty label and description', () => {
    HPR_ROLES.forEach((r) => {
      expect(r.label).toBeTruthy();
      expect(r.description).toBeTruthy();
    });
  });

  it('hprRoleLabel() resolves the real HPR-master wording for each account role', () => {
    expect(hprRoleLabel('health_professional')).toBe('Healthcare Professional');
    expect(hprRoleLabel('hospital_admin')).toBe('Facility Manager');
    expect(hprRoleLabel('admin_and_health_professional')).toBe('Healthcare Professional and Facility Manager');
  });

  it('hprRoleLabel() falls back to the raw value for an unknown role rather than throwing', () => {
    expect(hprRoleLabel('something_else')).toBe('something_else');
  });

  it('HPR_ROLE_LABELS has one entry per HPR_ROLES row, matching hprRoleLabel()', () => {
    HPR_ROLES.forEach((r) => expect(HPR_ROLE_LABELS[r.accountRole]).toBe(r.label));
  });

  it('HPR_ROLE_CODE_CHOICES is the plain label list, HPR-code order (1/2/3) — what ProviderBasicsHost.vue\'s HPR Role field renders', () => {
    expect(HPR_ROLE_CODE_CHOICES).toEqual([
      'Healthcare Professional',
      'Facility Manager',
      'Healthcare Professional and Facility Manager',
    ]);
  });
});
