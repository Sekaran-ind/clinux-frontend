// Facility/Provider/Patient registration, deliberately NOT a PlanDefinition — "for 3 onboarding
// journeys no plan definition or workflow is required — state machine will be used only for
// clinical journeys, not for onboarding of this 3 entities" (explicit instruction). These used to
// be tracked actions in entryPlanDefinition.js's ENTRY_PLAN_DEFINITION (facility_registration/
// staff_registration, with pending->ready->active->done status via planDefinitionRunner.js's
// XState actor) — moved here as a plain, role-gated list of links instead. Each journey lives on
// its own real page route (/onboarding, /staff-onboarding, and Patient Registration's own route
// once it exists) with its own internal flow (hub/review/publish, a drawer) — clicking one is
// real navigation, not a tracked Task; nothing here needs focus()/complete()/an audit trail entry.
//
// Cubo.vue reads this alongside entryWorkflow's own (still real, still tracked) auth actions —
// see its own activateJourney()/journeyLinks — for the "page routes vs component-mount routes"
// distinction (explicit instruction): every entry here is a page-route redirect (real
// router.push(route), full page width), never rendered inline in Cübo's right-pane content tab.
export const ONBOARDING_JOURNEYS = [
  { id: 'facility_registration', title: 'Register Your Facility', icon: 'fa-hospital', route: '/onboarding', roles: ['hospital_admin', 'admin_and_health_professional'] },
  { id: 'staff_registration', title: 'Add My Details', icon: 'fa-id-badge', route: '/staff-onboarding', roles: ['health_professional', 'admin_and_health_professional'] },
  // Patient Registration — not yet built. Joins this plain list, not a PlanDefinition, when it is.
];

// Same eligibility shape entryWorkflow.js's own isVisible() already established for requiresAuth/
// roles — every journey here requires a signed-in account (there's no unauthenticated case; an
// unauthenticated visitor's own registration is register/login, not one of these) and a matching
// role.
export function visibleOnboardingJourneys(currentUser) {
  if (!currentUser) return [];
  return ONBOARDING_JOURNEYS.filter((j) => !j.roles || j.roles.includes(currentUser.role));
}
