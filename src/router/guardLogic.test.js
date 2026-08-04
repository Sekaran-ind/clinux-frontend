import { describe, it, expect } from 'vitest';
import { resolveGuard } from './guardLogic.js';

describe('resolveGuard', () => {
  it('always allows a route with no requiresAuth meta', () => {
    expect(resolveGuard({}, null)).toBe(true);
    expect(resolveGuard({ requiresAuth: false }, null)).toBe(true);
  });

  it('redirects to index when requiresAuth is true and there is no current user', () => {
    expect(resolveGuard({ requiresAuth: true }, null)).toEqual({ name: 'index' });
  });

  it('allows a requiresAuth route through when there is a current user', () => {
    expect(resolveGuard({ requiresAuth: true }, { id: '1', email: 'a@b.com' })).toBe(true);
  });
});
