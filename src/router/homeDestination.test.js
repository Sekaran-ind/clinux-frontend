import { describe, it, expect } from 'vitest';
import { homeDestination } from './homeDestination.js';

describe('homeDestination', () => {
  it('routes to /clinic-home when a clinic profile exists', () => {
    expect(homeDestination(true)).toBe('/clinic-home');
  });

  it('routes to / when no clinic profile exists', () => {
    expect(homeDestination(false)).toBe('/');
  });
});
