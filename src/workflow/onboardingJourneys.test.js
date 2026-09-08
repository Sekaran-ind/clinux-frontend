import { describe, expect, it } from 'vitest';
import { ONBOARDING_JOURNEYS, visibleOnboardingJourneys } from './onboardingJourneys.js';

// Real onboarding-UI rebuild — "for 3 onboarding journeys no plan definition or workflow is
// required" (explicit instruction). These role-gating tests are the direct replacement for what
// used to live in entryWorkflow.test.js's primaryActionIds/secondaryActionIds describe block
// (facility_registration/staff_registration were tracked ENTRY_PLAN_DEFINITION actions there);
// same real-world scenarios, now against the plain function that owns them.
describe('visibleOnboardingJourneys', () => {
  it('returns nothing for a signed-out visitor', () => {
    expect(visibleOnboardingJourneys(null)).toEqual([]);
  });

  it('hospital_admin sees Register Your Facility, not Add My Details', () => {
    const visible = visibleOnboardingJourneys({ id: 'acc1', role: 'hospital_admin' });
    expect(visible.map((j) => j.id)).toEqual(['facility_registration']);
  });

  it('health_professional sees Add My Details, not Register Your Facility', () => {
    const visible = visibleOnboardingJourneys({ id: 'acc1', role: 'health_professional' });
    expect(visible.map((j) => j.id)).toEqual(['staff_registration']);
  });

  it('admin_and_health_professional sees BOTH journeys', () => {
    const visible = visibleOnboardingJourneys({ id: 'acc1', role: 'admin_and_health_professional' });
    expect(visible.map((j) => j.id).sort()).toEqual(['facility_registration', 'staff_registration']);
  });

  it('every journey carries a real page route, never a component-mount-only entry', () => {
    ONBOARDING_JOURNEYS.forEach((j) => {
      expect(typeof j.route).toBe('string');
      expect(j.route.startsWith('/')).toBe(true);
    });
  });
});
