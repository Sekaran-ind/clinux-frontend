// SPEC-20 (docs/SPEC-20-REFERENCE-PATTERN-JOURNEY-WORKBENCH-AND-UNAUTH-CUBO-ENTRY.md) §3-4's real
// unauthenticated entry point — the four actions Index.vue's own user (register / log in /
// recover a forgotten password / change a known one) actually needs. A DELIBERATELY SEPARATE
// PlanDefinition from authPlanDefinition.js's AUTH_PLAN_DEFINITION, not a reuse of it — that one
// exists specifically to validate the runtime's relatedAction sequencing mechanics on a small,
// well-understood test case (register -> login -> change_password, each gated on the previous),
// which is the RIGHT shape for a closed-loop test but the WRONG shape for the real entry point: a
// returning user must be able to log in without re-registering first, which AUTH_PLAN_DEFINITION's
// `login` depending on `register` reaching 'done' would wrongly block.
//
// Real structural difference from AUTH_PLAN_DEFINITION, stated precisely (SPEC-20 §4 point 4):
// NONE of these four actions declare a relatedAction dependency. register/login/forgot_password
// are genuinely independent entry choices (a real menu, not a pipeline) — there's no natural
// "comes after" relationship between them. change_password's real gate is "the caller is
// currently authenticated," which PATCH /api/auth/change-password's requireUser() middleware
// already enforces server-side regardless of what this client-side graph declares — modeling that
// as a relatedAction dependency on register OR login would need OR-dependency support
// planDefinitionRunner.js doesn't have (its stateIn guard is AND-only across every listed
// dependency); leaving change_password ungated here and trusting the real backend check is the
// honest choice, not a workaround. Each action's own pending->ready->active->done/error status is
// still real, meaningful Task state (SPEC-13 §2/§9's mapping applies to each one individually) —
// just not sequenced relative to each other, and the left-pane UI should present it as a menu of
// independently-tracked actions, not a numbered stepper implying an order that doesn't exist.
// UPDATE — a "fifth room" was added here (logout, plus facility_registration/staff_registration
// replacing Cubo.vue's old ROLE_SUGGESTIONS hardcoded map) and then partly REVERTED: "for 3
// onboarding journeys no plan definition or workflow is required — state machine will be used
// only for clinical journeys, not for onboarding of this 3 entities" (explicit instruction).
// Facility/Provider/Patient registration are real, dense, many-part journeys living on their own
// real page routes (/onboarding, /staff-onboarding) with their own internal flow (hub/review/
// publish, a drawer) — none of that benefits from tracked pending->ready->active->done status, an
// XState actor, or persistence snapshots; they moved to workflow/onboardingJourneys.js instead, a
// plain role-gated list of links, not a PlanDefinition. logout stays here — a real auth action,
// not one of the 3 onboarding entities, and it genuinely benefits from tracked COMPLETE-driven
// status the same way register/login below do. `roles` (kept) is the pragmatic (not full FHIR
// useContext-encoded) per-action eligibility field logout could still use if a future action
// here needs it — a plain array of account roles; absent means universal.
export const ENTRY_PLAN_DEFINITION = {
  resourceType: 'PlanDefinition',
  id: 'unauth-entry-v1',
  title: 'Get Started',
  status: 'active',
  type: 'workflow-definition',
  action: [
    // register is genuinely one-shot (an email can only register once) — no repeatable flag,
    // defaults to planDefinitionRunner.js's normal final `done` state.
    { id: 'register', title: 'Register' },
    // login/forgot_password/change_password are real, legitimate repeat actions within one
    // session (log out then log in again, possibly as someone else; reset a password more than
    // once) — repeatable: true, a real bug fix (see planDefinitionRunner.js's own comment on
    // `action.repeatable`): without it, a second attempt after the first `done` was silently
    // dropped by XState's final-state semantics — no API call, no error, exactly what "I can't
    // log in, nothing happens" looks like from the outside. Found live, not hypothetical.
    { id: 'login', title: 'Log In', repeatable: true },
    { id: 'forgot_password', title: 'Forgot Password', repeatable: true },
    { id: 'change_password', title: 'Change Password', repeatable: true },
    // requiresAuth (new) — the inverse of login's own hardcoded post-auth exclusion below: an
    // action that should never be OFFERED until someone is actually signed in. Not invoke-driven
    // (auth.logout() is synchronous, never fails) — COMPLETE-driven, focus+complete fire together
    // the moment it's clicked, same immediate pattern staff_registration below uses.
    { id: 'logout', title: 'Log Out', repeatable: true, requiresAuth: true },
  ],
};

// Same {error}-to-promise-rejection bridge authPlanDefinition.js's buildAuthServices already
// established — not reimplemented differently here, just extended with forgot_password's own
// two-field payload (securityAnswer + newPassword; the "show me the question first" half of that
// flow is a plain, un-tracked authStore.getSecurityQuestion() call the UI makes directly, not part
// of this action — see entryPlanDefinition's own header comment on why not everything needs to be
// a tracked Task).
export function buildEntryServices(authStore) {
  async function callOrThrow(promise) {
    const result = await promise;
    if (result.error) throw new Error(result.error);
    return result;
  }

  return {
    register: (payload) => callOrThrow(authStore.register(payload)),
    login: (payload) => callOrThrow(authStore.login(payload.email, payload.password)),
    forgot_password: (payload) => callOrThrow(authStore.resetPassword(payload.email, payload.securityAnswer, payload.newPassword)),
    change_password: (payload) => callOrThrow(authStore.changePassword(payload.currentPassword, payload.newPassword)),
  };
}
