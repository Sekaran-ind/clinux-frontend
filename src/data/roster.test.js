import { describe, expect, it } from 'vitest';
import { facilityOptions } from './roster.js';
import { ageFrom, shareQrUrl, suggestHipName } from './scanShare.js';

describe('facilityOptions', () => {
  it('merges HFR, roster and Scan & Share facilities by id, leaving drafts out', () => {
    const out = facilityOptions({
      hfr: [{ facilityId: 'IN3310002300', facilityName: 'tsekaran1949s Clinic' }, { trackingId: '98065', facilityName: 'Draft only' }],
      roster: [{ facilityId: 'IN3310002300', facilityName: 'old name' }, { facilityId: 'IN0610090166', facilityName: 'NHA ABDM Facility' }],
      scanShare: [{ facilityId: 'IN0610090166', facilityName: '' }],
    });
    expect(out).toEqual([
      { facilityId: 'IN0610090166', facilityName: 'NHA ABDM Facility', sources: ['roster', 'scan-share'] },
      { facilityId: 'IN3310002300', facilityName: 'tsekaran1949s Clinic', sources: ['hfr', 'roster'] },
    ]);
    expect(facilityOptions()).toEqual([]);
  });
});

describe('Scan & Share helpers', () => {
  it('builds the counter QR and a HIP name HFR accepts', () => {
    expect(shareQrUrl('https://phrsbx.abdm.gov.in', 'IN3310002300', '2')).toBe('https://phrsbx.abdm.gov.in/share-profile?hipid=IN3310002300&counterid=2');
    expect(suggestHipName('tsekaran1949’s Clinic & Hospital')).toBe('tsekaran1949s C');
    expect(ageFrom('1990', new Date('2026-10-02'))).toBe(36);
    expect(ageFrom(null)).toBeNull();
  });
});
