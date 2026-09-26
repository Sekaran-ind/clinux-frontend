import { describe, it, expect } from 'vitest';
import { selectStage } from './registrationLedger.js';

describe('RegistrationLedger stage selection', () => {
  it('navigates to a done stage and closes any open locked-reason reveal', () => {
    const result = selectStage({ id: 'basic', state: 'done' }, { revealedBlockedId: 'additional' });
    expect(result).toEqual({ nextActiveId: 'basic', nextRevealedBlockedId: null });
  });

  it('navigates to an active stage the same way', () => {
    expect(selectStage({ id: 'search', state: 'active' }, {})).toEqual({ nextActiveId: 'search', nextRevealedBlockedId: null });
  });

  it('navigates to a pending stage the same way (no hard gate)', () => {
    expect(selectStage({ id: 'later', state: 'pending' }, {})).toEqual({ nextActiveId: 'later', nextRevealedBlockedId: null });
  });

  it('never navigates to a blocked stage — it reveals that stage\'s own locked reason instead', () => {
    const result = selectStage({ id: 'detailed', state: 'blocked' }, { revealedBlockedId: null });
    expect(result).toEqual({ nextActiveId: undefined, nextRevealedBlockedId: 'detailed' });
  });

  it('clicking the SAME already-revealed blocked stage again closes the reveal', () => {
    const result = selectStage({ id: 'detailed', state: 'blocked' }, { revealedBlockedId: 'detailed' });
    expect(result.nextRevealedBlockedId).toBeNull();
  });

  it('clicking a DIFFERENT blocked stage switches the reveal to it, not toggling the old one', () => {
    const result = selectStage({ id: 'public_display', state: 'blocked' }, { revealedBlockedId: 'detailed' });
    expect(result.nextRevealedBlockedId).toBe('public_display');
  });
});
