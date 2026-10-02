import { describe, expect, it } from 'vitest';
import { journalToAudit } from './operations.js';

describe('journalToAudit', () => {
  it('maps the ported HPR/HFR journeys’ journal events', () => {
    expect(journalToAudit({ journey: 'hpr', title: 'HPR ID linked', facts: [['HPR ID', 'asha@hpr.abdm']] }))
      .toEqual({ action: 'hpr.linked', objectId: 'asha@hpr.abdm', metadata: { hprId: 'asha@hpr.abdm', via: 'sign-in' } });
    expect(journalToAudit({ journey: 'hpr', title: 'HPR ID created', facts: [['HPR ID', 'a@hpr.abdm'], ['HPR number', '71-1']] }).action).toBe('hpr.registered');
    expect(journalToAudit({ journey: 'hfr', title: 'HFR draft for Asha Clinic', facts: [['Tracking id', 'TRK-1']] }))
      .toEqual({ action: 'hfr.draft_saved', objectId: 'TRK-1', metadata: { trackingId: 'TRK-1' } });
    expect(journalToAudit({ journey: 'hfr', title: 'Asha Clinic submitted to HFR', facts: [['Facility id', 'IN29'], ['Tracking id', 'TRK-1']] }))
      .toEqual({ action: 'hfr.submitted', objectId: 'IN29', metadata: { facilityId: 'IN29', trackingId: 'TRK-1' } });
  });

  it('maps the patient ABHA journey, with the patient record as the object', () => {
    const e = { journey: 'abha', recordId: 'rec-1', title: 'ABHA recorded on a patient', facts: [['ABHA number', '91-1111-2222-3333'], ['ABHA address', 'a@sbx']] };
    expect(journalToAudit(e)).toEqual({ action: 'abha.recorded', objectId: 'rec-1', metadata: { abhaNumber: '91-1111-2222-3333', abhaAddress: 'a@sbx', recordId: 'rec-1' } });
    expect(journalToAudit({ ...e, title: 'Patient created from ABHA' }).action).toBe('abha.patient_created');
  });

  it('ignores anything else (UHI, unknown titles)', () => {
    expect(journalToAudit({ journey: 'uhi', title: 'Booked X' })).toBeNull();
    expect(journalToAudit({ journey: 'hpr', title: 'Something else' })).toBeNull();
    expect(journalToAudit(null)).toBeNull();
  });
});
