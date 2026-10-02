import { describe, it, expect } from 'vitest';
import { buildSetupChecklist } from './dashboardChecklist.js';

const done = (r) => r.steps.filter((s) => s.done).map((s) => s.key);

describe('buildSetupChecklist', () => {
  it('only has the account step done for a brand-new clinic', () => {
    const r = buildSetupChecklist();
    expect(done(r)).toEqual(['account']);
    expect(r.doneCount).toBe(1);
    expect(r.total).toBe(8);
  });

  it('marks facility saved but not published at basics_saved', () => {
    const r = buildSetupChecklist({ stage: 'basics_saved' });
    expect(done(r)).toEqual(['account', 'facility']);
  });

  it('treats HFR-in-progress as published but not registered', () => {
    const r = buildSetupChecklist({ stage: 'hfr_in_progress' });
    expect(done(r)).toEqual(['account', 'facility', 'publish']);
    expect(r.steps.find((s) => s.key === 'hfr').text).toMatch(/Finish it/);
  });

  it('completes everything once registered with every section filled in', () => {
    const r = buildSetupChecklist({ stage: 'hfr_registered', counts: { staff: 2, services: 3, hours: 7, consents: 1 } });
    expect(r.doneCount).toBe(r.total);
  });

  it('gives every incomplete step a section to open', () => {
    buildSetupChecklist().steps.filter((s) => !s.done).forEach((s) => expect(s.section).toMatch(/^section_/));
  });
});
