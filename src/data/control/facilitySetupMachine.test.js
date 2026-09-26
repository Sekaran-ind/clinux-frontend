import { describe, it, expect } from 'vitest';
import { deriveFacilitySetupState, canAcceptFacilityJoinToken, FACILITY_SETUP_STAGE_LABELS } from './facilitySetupMachine.js';

describe('deriveFacilitySetupState', () => {
  it('is draft when nothing has been captured', () => {
    expect(deriveFacilitySetupState({})).toBe('draft');
    expect(deriveFacilitySetupState({ hasBasics: false, everPublished: false, hfrFacilityId: null })).toBe('draft');
  });

  it('is basics_saved once a profile exists but was never published', () => {
    expect(deriveFacilitySetupState({ hasBasics: true, everPublished: false })).toBe('basics_saved');
  });

  it('is published once everPublished is true, regardless of HFR', () => {
    expect(deriveFacilitySetupState({ hasBasics: true, everPublished: true })).toBe('published');
  });

  it('is hfr_registered only once BOTH published and a real facilityId exist', () => {
    expect(deriveFacilitySetupState({ hasBasics: true, everPublished: true, hfrFacilityId: 'HFR12345' })).toBe('hfr_registered');
  });

  it('does not skip ahead to hfr_registered off a facilityId alone if never published', () => {
    // Shouldn't happen in real data (FacilityHfrPanel needs a saved record first), but the guard
    // chain itself must not shortcut basics_saved -> hfr_registered without passing through
    // published — verifies the machine's own ordering, not just its end states.
    expect(deriveFacilitySetupState({ hasBasics: true, everPublished: false, hfrFacilityId: 'HFR12345' })).toBe('basics_saved');
  });

  it('treats a missing/empty hasBasics as draft even with everPublished somehow set', () => {
    expect(deriveFacilitySetupState({ hasBasics: false, everPublished: true })).toBe('draft');
  });

  it('is hfr_in_progress once a tracking id exists but there is no facilityId yet', () => {
    expect(deriveFacilitySetupState({ hasBasics: true, everPublished: true, hfrTrackingId: 'TRK123' })).toBe('hfr_in_progress');
  });

  it('still resolves straight to hfr_registered off a facilityId alone, with no tracking id given', () => {
    // Preserves the machine's original direct published -> hfr_registered path — a facilityId is
    // the strongest signal and should never regress to hfr_in_progress just because a caller
    // didn't also pass hfrTrackingId.
    expect(deriveFacilitySetupState({ hasBasics: true, everPublished: true, hfrFacilityId: 'HFR1' })).toBe('hfr_registered');
  });

  it('prefers hfr_registered over hfr_in_progress when BOTH a tracking id and a facilityId exist', () => {
    expect(deriveFacilitySetupState({ hasBasics: true, everPublished: true, hfrTrackingId: 'TRK1', hfrFacilityId: 'HFR1' })).toBe('hfr_registered');
  });
});

describe('canAcceptFacilityJoinToken', () => {
  it('is false for draft and basics_saved', () => {
    expect(canAcceptFacilityJoinToken('draft')).toBe(false);
    expect(canAcceptFacilityJoinToken('basics_saved')).toBe(false);
  });

  it('is true for published, hfr_in_progress, and hfr_registered', () => {
    expect(canAcceptFacilityJoinToken('published')).toBe(true);
    expect(canAcceptFacilityJoinToken('hfr_in_progress')).toBe(true);
    expect(canAcceptFacilityJoinToken('hfr_registered')).toBe(true);
  });
});

describe('FACILITY_SETUP_STAGE_LABELS', () => {
  it('has a label for every real stage the machine can be in', () => {
    ['draft', 'basics_saved', 'published', 'hfr_in_progress', 'hfr_registered'].forEach((stage) => {
      expect(typeof FACILITY_SETUP_STAGE_LABELS[stage]).toBe('string');
      expect(FACILITY_SETUP_STAGE_LABELS[stage].length).toBeGreaterThan(0);
    });
  });
});
