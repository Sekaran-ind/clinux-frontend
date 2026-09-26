import { describe, it, expect } from 'vitest';
import { deriveLedgerStages, nextStageAfter, currentStageFor, parseAbdmErrorDetails } from './facilityHfrJourney.js';

function byId(stages, id) {
  return stages.find((s) => s.id === id);
}

describe('deriveLedgerStages', () => {
  it('blocks Basic Information on manager login only — nothing else gates it', () => {
    const stages = deriveLedgerStages({ managerToken: false });
    expect(byId(stages, 'basic').state).toBe('blocked');
    expect(byId(stages, 'basic').lockedReason).toMatch(/facility manager/i);
  });

  it('unlocks Basic Information the moment the manager is logged in, with no other prerequisite', () => {
    const stages = deriveLedgerStages({ managerToken: 'tok-1' });
    expect(byId(stages, 'basic').state).toBe('active');
  });

  it('Additional and Detailed Information are BOTH blocked only on a missing tracking id — never on each other', () => {
    const noTracking = deriveLedgerStages({ managerToken: 'tok-1', trackingId: null });
    expect(byId(noTracking, 'additional').state).toBe('blocked');
    expect(byId(noTracking, 'detailed').state).toBe('blocked');

    const withTracking = deriveLedgerStages({ managerToken: 'tok-1', trackingId: 'TRK-1' });
    expect(byId(withTracking, 'additional').state).toBe('active');
    expect(byId(withTracking, 'detailed').state).toBe('active');
  });

  it('Detailed Information can be completed before Additional Information, and vice versa', () => {
    const detailedFirst = deriveLedgerStages({ managerToken: 'tok-1', trackingId: 'TRK-1', detailedInfoDone: true, additionalInfoDone: false });
    expect(byId(detailedFirst, 'detailed').state).toBe('done');
    expect(byId(detailedFirst, 'additional').state).toBe('active');

    const additionalFirst = deriveLedgerStages({ managerToken: 'tok-1', trackingId: 'TRK-1', additionalInfoDone: true, detailedInfoDone: false });
    expect(byId(additionalFirst, 'additional').state).toBe('done');
    expect(byId(additionalFirst, 'detailed').state).toBe('active');
  });

  it('Public Display Settings is never blocked — it has no ABDM API of its own', () => {
    expect(byId(deriveLedgerStages({}), 'public_display').state).not.toBe('blocked');
    expect(byId(deriveLedgerStages({ managerToken: false, trackingId: null }), 'public_display').state).not.toBe('blocked');
  });

  it('Attestation & e-Sign is blocked only on a missing tracking id, regardless of Additional/Detailed/Public Display status', () => {
    const stages = deriveLedgerStages({ managerToken: 'tok-1', trackingId: null });
    expect(byId(stages, 'attestation').state).toBe('blocked');

    const readyDespiteIncompleteExtras = deriveLedgerStages({
      managerToken: 'tok-1', trackingId: 'TRK-1', additionalInfoDone: false, detailedInfoDone: false, publicDisplayConfirmed: false,
    });
    expect(byId(readyDespiteIncompleteExtras, 'attestation').state).toBe('active');
  });

  it('marks everything done and Submitted terminal once a facilityId exists', () => {
    const stages = deriveLedgerStages({
      managerToken: 'tok-1', trackingId: 'TRK-1', additionalInfoDone: true, detailedInfoDone: true,
      publicDisplayConfirmed: true, facilityId: 'IN0910000001',
    });
    expect(stages.filter((s) => s.state !== 'done')).toEqual([]);
  });

  it('there is no separate Search stage — it is folded into Basic Information', () => {
    const stages = deriveLedgerStages({ managerToken: 'tok-1' });
    expect(stages.find((s) => s.id === 'search')).toBeUndefined();
    expect(stages.map((s) => s.id)).toEqual(['basic', 'additional', 'detailed', 'public_display', 'attestation', 'submitted']);
  });
});

describe('nextStageAfter', () => {
  it('walks the real sequence forward', () => {
    expect(nextStageAfter('basic')).toBe('additional');
    expect(nextStageAfter('public_display')).toBe('attestation');
    expect(nextStageAfter('attestation')).toBe('submitted');
  });

  it('stays put once already at the terminal stage', () => {
    expect(nextStageAfter('submitted')).toBe('submitted');
  });
});

describe('currentStageFor', () => {
  it('opens a fresh session on Basic Information', () => {
    expect(currentStageFor({})).toBe('basic');
  });

  it('opens a returning session on the real frontier, ignoring the transient manager-login signal', () => {
    expect(currentStageFor({ trackingId: 'TRK-1', additionalInfoDone: true, detailedInfoDone: true })).toBe('public_display');
  });

  it('opens an already-submitted facility on the terminal stage', () => {
    expect(currentStageFor({ trackingId: 'TRK-1', additionalInfoDone: true, detailedInfoDone: true, publicDisplayConfirmed: true, facilityId: 'IN1' })).toBe('submitted');
  });
});

describe('parseAbdmErrorDetails', () => {
  it('matches the real live-found HIS-1070 OwnershipCode error back to the Basic Information stage', () => {
    const res = {
      success: false, error: 'ABDM request failed', abdmStatus: 422,
      abdmBody: { code: 'HIS-422', message: 'Unable to process the current request due to some wrong data entered.',
        details: [{ message: 'Required OwnershipCode Field is empty.', code: 'HIS-1070', attribute: null }] },
    };
    const parsed = parseAbdmErrorDetails(res);
    expect(parsed).toEqual([{ message: 'Required OwnershipCode Field is empty.', stageId: 'basic', label: 'Ownership' }]);
  });

  it('returns every detail message even when several are present', () => {
    const res = {
      abdmBody: { details: [
        { message: 'Required OwnershipCode Field is empty.' },
        { message: 'Required StateLGDCode Field is empty.' },
      ] },
    };
    const parsed = parseAbdmErrorDetails(res);
    expect(parsed.map((p) => p.message)).toEqual(['Required OwnershipCode Field is empty.', 'Required StateLGDCode Field is empty.']);
    expect(parsed[1].stageId).toBe('basic');
  });

  it('falls back to the flat error/abdmBody.message when there is no details array, with no field match forced', () => {
    const withAbdmMessage = parseAbdmErrorDetails({ abdmBody: { message: 'Something went wrong.' } });
    expect(withAbdmMessage).toEqual([{ message: 'Something went wrong.' }]);

    const withPlainError = parseAbdmErrorDetails({ error: 'Network error contacting the ABDM gateway.' });
    expect(withPlainError).toEqual([{ message: 'Network error contacting the ABDM gateway.' }]);
  });

  it('never throws on a missing/malformed response', () => {
    expect(parseAbdmErrorDetails(undefined)).toEqual([]);
    expect(parseAbdmErrorDetails({})).toEqual([]);
  });
});
