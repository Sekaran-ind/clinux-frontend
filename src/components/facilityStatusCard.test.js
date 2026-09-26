import { describe, it, expect } from 'vitest';
import { facilityStatusPills, canContinueHfr } from './facilityStatusCard.js';

describe('facilityStatusPills', () => {
  it('shows both pills as not-started for draft', () => {
    expect(facilityStatusPills('draft')).toEqual({
      basics: { text: 'Not started', tone: 'muted' },
      abdm: { text: 'Not started', tone: 'muted' },
    });
  });

  it('shows the profile as saved-but-unpublished, ABDM still not started', () => {
    const { basics, abdm } = facilityStatusPills('basics_saved');
    expect(basics).toEqual({ text: 'Saved — not published', tone: 'amber' });
    expect(abdm).toEqual({ text: 'Not started', tone: 'muted' });
  });

  it('shows the profile as published, ABDM still not started', () => {
    const { basics, abdm } = facilityStatusPills('published');
    expect(basics.text).toBe('Published');
    expect(abdm).toEqual({ text: 'Not started', tone: 'muted' });
  });

  it('shows ABDM as in-progress once a tracking id exists', () => {
    expect(facilityStatusPills('hfr_in_progress').abdm).toEqual({ text: 'In progress', tone: 'amber' });
  });

  it('shows ABDM as registered once a facilityId exists', () => {
    expect(facilityStatusPills('hfr_registered').abdm).toEqual({ text: 'Registered', tone: 'teal' });
  });

  it('falls back to the draft pills for an unrecognized stage rather than throwing', () => {
    expect(facilityStatusPills('not-a-real-stage')).toEqual(facilityStatusPills('draft'));
  });
});

describe('canContinueHfr', () => {
  it('is false before any profile exists', () => {
    expect(canContinueHfr('draft')).toBe(false);
  });

  it('is true once a profile exists and ABDM registration is not yet complete', () => {
    expect(canContinueHfr('basics_saved')).toBe(true);
    expect(canContinueHfr('published')).toBe(true);
    expect(canContinueHfr('hfr_in_progress')).toBe(true);
  });

  it('is false once ABDM registration is already complete — nothing left to continue', () => {
    expect(canContinueHfr('hfr_registered')).toBe(false);
  });
});
