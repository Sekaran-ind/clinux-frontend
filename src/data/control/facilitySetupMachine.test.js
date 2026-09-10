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
});

describe('canAcceptFacilityJoinToken', () => {
  it('is false for draft and basics_saved', () => {
    expect(canAcceptFacilityJoinToken('draft')).toBe(false);
    expect(canAcceptFacilityJoinToken('basics_saved')).toBe(false);
  });

  it('is true for published and hfr_registered', () => {
    expect(canAcceptFacilityJoinToken('published')).toBe(true);
    expect(canAcceptFacilityJoinToken('hfr_registered')).toBe(true);
  });
});

describe('FACILITY_SETUP_STAGE_LABELS', () => {
  it('has a label for every real stage the machine can be in', () => {
    ['draft', 'basics_saved', 'published', 'hfr_registered'].forEach((stage) => {
      expect(typeof FACILITY_SETUP_STAGE_LABELS[stage]).toBe('string');
      expect(FACILITY_SETUP_STAGE_LABELS[stage].length).toBeGreaterThan(0);
    });
  });
});
