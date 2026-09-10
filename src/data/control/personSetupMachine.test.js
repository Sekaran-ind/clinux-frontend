import { describe, it, expect } from 'vitest';
import { derivePersonSetupState, canRedeemFacilityJoinToken, PERSON_SETUP_STAGE_LABELS } from './personSetupMachine.js';

describe('derivePersonSetupState — staff', () => {
  it('is draft with no basics captured', () => {
    expect(derivePersonSetupState({ linkKind: 'staff' })).toBe('draft');
  });
  it('is published as soon as basics are saved — no HPR bar for staff', () => {
    expect(derivePersonSetupState({ linkKind: 'staff', hasBasics: true, hprVerified: false })).toBe('published');
  });
});

describe('derivePersonSetupState — affiliate', () => {
  it('is draft with no basics captured', () => {
    expect(derivePersonSetupState({ linkKind: 'affiliate' })).toBe('draft');
  });
  it('stalls at basics_saved without a verified HPR login', () => {
    expect(derivePersonSetupState({ linkKind: 'affiliate', hasBasics: true, hprVerified: false })).toBe('basics_saved');
  });
  it('reaches published only once HPR-verified too', () => {
    expect(derivePersonSetupState({ linkKind: 'affiliate', hasBasics: true, hprVerified: true })).toBe('published');
  });
  it('does not let a stray hprVerified flag skip basics_saved', () => {
    expect(derivePersonSetupState({ linkKind: 'affiliate', hasBasics: false, hprVerified: true })).toBe('draft');
  });
});

describe('canRedeemFacilityJoinToken', () => {
  it('true only for published', () => {
    expect(canRedeemFacilityJoinToken('draft')).toBe(false);
    expect(canRedeemFacilityJoinToken('basics_saved')).toBe(false);
    expect(canRedeemFacilityJoinToken('published')).toBe(true);
  });
});

describe('PERSON_SETUP_STAGE_LABELS', () => {
  it('has a label for every stage', () => {
    ['draft', 'basics_saved', 'published'].forEach((s) => expect(typeof PERSON_SETUP_STAGE_LABELS[s]).toBe('string'));
  });
});
