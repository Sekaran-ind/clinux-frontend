import { describe, it, expect } from 'vitest';
import { buildNavGroups, activeNavKey } from './appNav.js';

const keys = (groups) => groups.flatMap((g) => g.items.map((i) => i.key));

describe('buildNavGroups', () => {
  it('gives a hospital admin facility items but not the professional ones', () => {
    const k = keys(buildNavGroups({ role: 'hospital_admin' }));
    expect(k).toContain('dashboard');
    expect(k).toContain('facility-profile');
    expect(k).toContain('designer');
    expect(k).not.toContain('practitioner-home');
    expect(k).not.toContain('professional-profile');
  });

  it('gives a health professional their own profile/HPR items and no facility admin items', () => {
    const k = keys(buildNavGroups({ role: 'health_professional' }));
    expect(k).toContain('practitioner-home');
    expect(k).toContain('professional-profile');
    expect(k).toContain('dashboard'); // everyone's landing page
    expect(k).not.toContain('facility-profile');
    expect(k).not.toContain('designer');
  });

  it('gives a dual-role account both sets', () => {
    const k = keys(buildNavGroups({ role: 'admin_and_health_professional' }));
    expect(k).toEqual(expect.arrayContaining(['dashboard', 'facility-profile', 'practitioner-home', 'professional-profile']));
  });

  it('shows both journeys when the role is missing', () => {
    const k = keys(buildNavGroups({}));
    expect(k).toEqual(expect.arrayContaining(['facility-profile', 'professional-profile']));
  });

  it('clinic operations are journey pages: Checkout lists its visits, so it is never disabled', () => {
    const ops = buildNavGroups({ role: 'hospital_admin' }).find((g) => g.label === 'Clinic operations').items;
    expect(ops.map((i) => [i.key, i.to])).toEqual([
      ['clinic', '/clinic'], ['front-desk', '/clinic/front-desk'], ['consultation-desk', '/clinic/consultation'], ['checkout', '/clinic/checkout'], ['patients', '/patient-home'],
    ]);
    expect(ops.find((i) => i.key === 'checkout').disabled).toBeFalsy();
  });

  it('shows every registry journey to every role', () => {
    for (const role of ['hospital_admin', 'health_professional', 'admin_and_health_professional', undefined]) {
      const registries = buildNavGroups({ role }).find((g) => g.label === 'Registries').items.map((i) => i.key);
      expect(registries).toEqual(['registries', 'registry-hpr', 'registry-hfr', 'registry-abha', 'registry-scan-share', 'registry-roster']);
    }
  });

  it('shows the Operations screens to every role', () => {
    for (const role of ['hospital_admin', 'health_professional', 'admin_and_health_professional', undefined]) {
      const ops = buildNavGroups({ role }).find((g) => g.label === 'Operations').items.map((i) => i.to);
      expect(ops).toEqual(['/operations/activity', '/operations/abdm-transactions', '/operations/access']);
    }
  });

  it('never returns an empty group', () => {
    for (const role of ['hospital_admin', 'health_professional', 'admin_and_health_professional', undefined]) {
      buildNavGroups({ role }).forEach((g) => expect(g.items.length).toBeGreaterThan(0));
    }
  });
});

describe('activeNavKey', () => {
  const groups = buildNavGroups({ role: 'admin_and_health_professional', hasActiveEncounter: true });

  it('matches a route item by path', () => {
    expect(activeNavKey(groups, { routePath: '/designer', routeName: 'designer' })).toBe('designer');
  });

  it('matches a ClinicHome view item by the current view', () => {
    expect(activeNavKey(groups, { routePath: '/clinic-home', routeName: 'clinic-home', clinicView: 'public' })).toBe('clinic-page');
  });

  it('matches a clinic journey page by its path', () => {
    expect(activeNavKey(groups, { routePath: '/clinic/consultation', routeName: 'clinic' })).toBe('consultation-desk');
  });

  it('returns null for an unknown route', () => {
    expect(activeNavKey(groups, { routePath: '/nowhere', routeName: 'x' })).toBeNull();
  });
});
