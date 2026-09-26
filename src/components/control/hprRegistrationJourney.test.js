import { describe, it, expect } from 'vitest';
import { deriveLedgerStages, nextStageAfter, currentStageFor, parseAbdmErrorDetails } from './hprRegistrationJourney.js';

function byId(stages, id) {
  return stages.find((s) => s.id === id);
}

describe('deriveLedgerStages', () => {
  it('blocks Identity Verification until HP Category/Sub-Category/State/District are saved', () => {
    const stages = deriveLedgerStages({ categoryReady: false });
    expect(byId(stages, 'identity').state).toBe('blocked');
    expect(byId(stages, 'identity').lockedReason).toMatch(/personal details/i);
  });

  it('unlocks Identity Verification once category/state/district are ready, with no other prerequisite', () => {
    const stages = deriveLedgerStages({ categoryReady: true });
    expect(byId(stages, 'identity').state).toBe('active');
  });

  it('Create HPR Account is blocked until HPID suggestions exist, independent of an already-created account', () => {
    const noSuggestions = deriveLedgerStages({ categoryReady: true, hpidSuggestionsReady: false });
    expect(byId(noSuggestions, 'account').state).toBe('blocked');

    const withSuggestions = deriveLedgerStages({ categoryReady: true, hpidSuggestionsReady: true });
    expect(byId(withSuggestions, 'account').state).toBe('active');
  });

  it('a reload with an already-created HPR ID marks Identity done even with no in-memory suggestions', () => {
    const stages = deriveLedgerStages({ categoryReady: true, hpidSuggestionsReady: false, createdHprId: '71-1234-5678-9012' });
    expect(byId(stages, 'identity').state).toBe('done');
    expect(byId(stages, 'account').state).toBe('done');
  });

  it('Preview Profile is blocked only on a missing HPR ID', () => {
    expect(byId(deriveLedgerStages({ createdHprId: null }), 'preview').state).toBe('blocked');
    expect(byId(deriveLedgerStages({ createdHprId: '71-1' }), 'preview').state).toBe('active');
  });

  it('Attestation & e-Sign is blocked until Preview is explicitly confirmed', () => {
    const stages = deriveLedgerStages({ createdHprId: '71-1', previewConfirmed: false });
    expect(byId(stages, 'attestation').state).toBe('blocked');

    const confirmed = deriveLedgerStages({ createdHprId: '71-1', previewConfirmed: true });
    expect(byId(confirmed, 'attestation').state).toBe('active');
  });

  it('marks everything done and Submitted terminal once the full profile is submitted', () => {
    const stages = deriveLedgerStages({
      categoryReady: true, hpidSuggestionsReady: true, createdHprId: '71-1', previewConfirmed: true, fullProfileSubmitted: true,
    });
    expect(stages.filter((s) => s.state !== 'done')).toEqual([]);
  });

  it('has exactly the 5 real stages, in order', () => {
    expect(deriveLedgerStages({}).map((s) => s.id)).toEqual(['identity', 'account', 'preview', 'attestation', 'submitted']);
  });
});

describe('nextStageAfter', () => {
  it('walks the real sequence forward', () => {
    expect(nextStageAfter('identity')).toBe('account');
    expect(nextStageAfter('preview')).toBe('attestation');
    expect(nextStageAfter('attestation')).toBe('submitted');
  });

  it('stays put once already at the terminal stage', () => {
    expect(nextStageAfter('submitted')).toBe('submitted');
  });
});

describe('currentStageFor', () => {
  it('opens a fresh session on Identity Verification', () => {
    expect(currentStageFor({})).toBe('identity');
  });

  it('opens a returning session on the real frontier — category readiness is a persisted fact, not a transient login', () => {
    expect(currentStageFor({ categoryReady: true, createdHprId: '71-1' })).toBe('preview');
  });

  it('opens an already-submitted professional on the terminal stage', () => {
    expect(currentStageFor({ categoryReady: true, createdHprId: '71-1', previewConfirmed: true, fullProfileSubmitted: true })).toBe('submitted');
  });
});

describe('parseAbdmErrorDetails', () => {
  it('matches an Aadhaar/OTP error back to Identity Verification', () => {
    const res = { abdmBody: { details: [{ message: 'Aadhaar OTP verification failed.' }] } };
    expect(parseAbdmErrorDetails(res)).toEqual([{ message: 'Aadhaar OTP verification failed.', stageId: 'identity', label: 'Identity Verification' }]);
  });

  it('matches a password/HPID error back to Create HPR Account', () => {
    const res = { abdmBody: { details: [{ message: 'Password does not meet the required policy.' }] } };
    expect(parseAbdmErrorDetails(res)).toEqual([{ message: 'Password does not meet the required policy.', stageId: 'account', label: 'Create HPR Account' }]);
  });

  it('leaves an error about a field on another page tab unmatched — no stage in this panel owns it', () => {
    const res = { abdmBody: { details: [{ message: 'hpCategoryCode is required.' }] } };
    expect(parseAbdmErrorDetails(res)).toEqual([{ message: 'hpCategoryCode is required.' }]);
  });

  it('falls back to the flat error/abdmBody.message when there is no details array', () => {
    expect(parseAbdmErrorDetails({ abdmBody: { message: 'Something went wrong.' } })).toEqual([{ message: 'Something went wrong.' }]);
    expect(parseAbdmErrorDetails({ error: 'Network error contacting the ABDM gateway.' })).toEqual([{ message: 'Network error contacting the ABDM gateway.' }]);
  });

  it('never throws on a missing/malformed response', () => {
    expect(parseAbdmErrorDetails(undefined)).toEqual([]);
    expect(parseAbdmErrorDetails({})).toEqual([]);
  });
});
