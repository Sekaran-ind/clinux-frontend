// The small, deliberately-simple closed loop this session picked to validate the new
// PlanDefinition/Task runtime (planDefinitionRunner.js, workflowRuntime.js) against something
// real and already well understood, before trusting it on the bigger five-room clinical workflow.
// register -> login -> change_password, each backed by a REAL API call (clinuxflow-api's
// POST /api/auth/register, POST /api/auth/login, and PATCH /api/auth/change-password — the last
// of which didn't exist anywhere in this app before this session, built alongside this file).
//
// Not a FHIR PlanDefinition produced by the SPEC-18 authoring pipeline (that pipeline is for
// clinical/facility workflows — YAML -> Questionnaire -> extraction) — this one is hand-authored,
// same shape, because the whole point of this slice is testing the RUNTIME configuration on a
// small, real case, not re-running the authoring pipeline too.
export const AUTH_PLAN_DEFINITION = {
  resourceType: 'PlanDefinition',
  id: 'user-account-v1',
  title: 'User Account',
  status: 'active',
  type: 'workflow-definition',
  action: [
    { id: 'register', title: 'Register' },
    { id: 'login', title: 'Login', relatedAction: [{ actionId: 'register', relationship: 'after-end' }] },
    { id: 'change_password', title: 'Change Password', relatedAction: [{ actionId: 'login', relationship: 'after-end' }] },
  ],
};

// Bridges the auth store's existing {error}-returning convention (register/login/changePassword
// never throw, they resolve with an `error` string on failure) to the invoke mechanism's
// promise-rejection convention (verified empirically this session: onDone/onError route on
// resolve vs. reject, not on an `error` field in a resolved value) — a thin adapter, not a
// reimplementation of any of these calls.
export function buildAuthServices(authStore) {
  async function callOrThrow(promise) {
    const result = await promise;
    if (result.error) throw new Error(result.error);
    return result;
  }

  return {
    register: (payload) => callOrThrow(authStore.register(payload)),
    login: (payload) => callOrThrow(authStore.login(payload.email, payload.password)),
    change_password: (payload) => callOrThrow(authStore.changePassword(payload.currentPassword, payload.newPassword)),
  };
}
