import { describe, it, expect } from 'vitest';
import { homeDestination } from './homeDestination.js';

describe('homeDestination', () => {
  it('routes to /clinic-home when a clinic profile exists', () => {
    expect(homeDestination('hospital_admin', true)).toBe('/clinic-home');
  });

  it('routes to / when no clinic profile exists', () => {
    expect(homeDestination('hospital_admin', false)).toBe('/');
  });

  it('routes a health_professional to /practitioner-home even when a clinic profile exists on the device', () => {
    expect(homeDestination('health_professional', true)).toBe('/practitioner-home');
  });

  it('routes a health_professional to /practitioner-home when no clinic profile exists', () => {
    expect(homeDestination('health_professional', false)).toBe('/practitioner-home');
  });

  it('routes admin_and_health_professional the same as hospital_admin', () => {
    expect(homeDestination('admin_and_health_professional', true)).toBe('/clinic-home');
    expect(homeDestination('admin_and_health_professional', false)).toBe('/');
  });
});
