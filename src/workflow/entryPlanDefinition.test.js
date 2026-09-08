import { describe, expect, it, vi } from 'vitest';
import { createWorkflowRuntime } from './workflowRuntime.js';
import { actionStatus, actionError, readyActionIds } from './planDefinitionRunner.js';
import { ENTRY_PLAN_DEFINITION, buildEntryServices } from './entryPlanDefinition.js';

// SPEC-20 (docs/SPEC-20-REFERENCE-PATTERN-JOURNEY-WORKBENCH-AND-UNAUTH-CUBO-ENTRY.md) §3-4's real
// unauthenticated entry point — same real-runtime-driven-through-the-bus discipline
// authPlanDefinition.test.js already established, extended to prove the actual structural
// difference this file's own header comment claims: none of these four actions gate on each
// other, so a returning user reaches 'login' as 'ready' immediately, without registering first.
function mockAuthStore({ registerFails = false, loginFails = false, changePasswordFails = false, resetFails = false } = {}) {
  return {
    register: vi.fn(async (payload) => {
      if (registerFails) return { error: 'An account with this email already exists.' };
      return { user: { id: 'acc1', email: payload.email, role: payload.role } };
    }),
    login: vi.fn(async (email, password) => {
      if (loginFails) return { error: 'Invalid email or password.' };
      return { user: { id: 'acc1', email, role: 'hospital_admin' } };
    }),
    changePassword: vi.fn(async (currentPassword, newPassword) => {
      if (changePasswordFails) return { error: 'Current password is incorrect.' };
      return { success: true };
    }),
    resetPassword: vi.fn(async (email, securityAnswer, newPassword) => {
      if (resetFails) return { error: 'That answer is incorrect.' };
      return { success: true };
    }),
  };
}

describe('ENTRY_PLAN_DEFINITION — the real menu-not-pipeline structure', () => {
  it('register, login, forgot_password, logout, AND change_password are all ready immediately — none gated behind another', () => {
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(ENTRY_PLAN_DEFINITION.id, ENTRY_PLAN_DEFINITION, { services: buildEntryServices(mockAuthStore()) });

    // logout (SPEC-22 §5.8's addition) is still structurally a menu, not a pipeline — it declares
    // no relatedAction either. facility_registration/staff_registration used to be tracked here
    // too; moved to workflow/onboardingJourneys.js's plain ONBOARDING_JOURNEYS list instead ("no
    // plan definition or workflow is required" for the 3 onboarding entities, explicit
    // instruction) — this plan no longer carries them at all. Role/auth eligibility (requiresAuth)
    // is deliberately NOT enforced at this layer (the real machine has no concept of "who's logged
    // in") — that's entryWorkflow.js's own isVisible filter, covered separately in
    // entryWorkflow.test.js.
    const ready = readyActionIds(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), ENTRY_PLAN_DEFINITION);
    expect(ready.sort()).toEqual(['change_password', 'forgot_password', 'login', 'logout', 'register']);

    runtime.dispose();
  });

  it('a returning user can go straight to login WITHOUT registering first — the real bug AUTH_PLAN_DEFINITION would have had here', async () => {
    const authStore = mockAuthStore();
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(ENTRY_PLAN_DEFINITION.id, ENTRY_PLAN_DEFINITION, { services: buildEntryServices(authStore) });

    runtime.emit({ type: 'FOCUS', planId: ENTRY_PLAN_DEFINITION.id, actionId: 'login', payload: { email: 'a@b.com', password: 'password123' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('done'));
    expect(authStore.login).toHaveBeenCalledWith('a@b.com', 'password123');
    expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'register')).toBe('ready'); // untouched, never forced through

    runtime.dispose();
  });

  it('login can be focused a SECOND time after already reaching done — real bug found live: a second login attempt after logout silently did nothing (XState final-state semantics dropped the event, no API call, no error)', async () => {
    const authStore = mockAuthStore();
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(ENTRY_PLAN_DEFINITION.id, ENTRY_PLAN_DEFINITION, { services: buildEntryServices(authStore) });

    runtime.emit({ type: 'FOCUS', planId: ENTRY_PLAN_DEFINITION.id, actionId: 'login', payload: { email: 'a@b.com', password: 'password123' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('done'));

    // Simulates logging out and logging back in — a second real FOCUS, same runtime, same plan.
    runtime.emit({ type: 'FOCUS', planId: ENTRY_PLAN_DEFINITION.id, actionId: 'login', payload: { email: 'c@d.com', password: 'password123' } });
    await vi.waitFor(() => expect(authStore.login).toHaveBeenCalledTimes(2));
    expect(authStore.login).toHaveBeenLastCalledWith('c@d.com', 'password123');
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('done'));

    runtime.dispose();
  });

  it('forgot_password succeeding calls authStore.resetPassword with email/securityAnswer/newPassword, independent of register/login', async () => {
    const authStore = mockAuthStore();
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(ENTRY_PLAN_DEFINITION.id, ENTRY_PLAN_DEFINITION, { services: buildEntryServices(authStore) });

    runtime.emit({
      type: 'FOCUS', planId: ENTRY_PLAN_DEFINITION.id, actionId: 'forgot_password',
      payload: { email: 'a@b.com', securityAnswer: 'Rex', newPassword: 'brandNew123' },
    });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'forgot_password')).toBe('done'));
    expect(authStore.resetPassword).toHaveBeenCalledWith('a@b.com', 'Rex', 'brandNew123');

    runtime.dispose();
  });

  it('a failed forgot_password returns to ready with the real error, and does not touch login/register/change_password', async () => {
    const authStore = mockAuthStore({ resetFails: true });
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(ENTRY_PLAN_DEFINITION.id, ENTRY_PLAN_DEFINITION, { services: buildEntryServices(authStore) });

    runtime.emit({
      type: 'FOCUS', planId: ENTRY_PLAN_DEFINITION.id, actionId: 'forgot_password',
      payload: { email: 'a@b.com', securityAnswer: 'wrong', newPassword: 'brandNew123' },
    });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'forgot_password')).toBe('ready'));
    expect(actionError(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'forgot_password')).toBe('That answer is incorrect.');
    expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('ready');
    expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'register')).toBe('ready');

    runtime.dispose();
  });

  it('change_password is structurally ungated (always ready) — the real gate is the backend requireUser() check, exercised via a failing call here', async () => {
    const authStore = mockAuthStore({ changePasswordFails: true }); // simulates the real 401 an unauthenticated caller would get
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(ENTRY_PLAN_DEFINITION.id, ENTRY_PLAN_DEFINITION, { services: buildEntryServices(authStore) });

    expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'change_password')).toBe('ready'); // no relatedAction dependency at all

    runtime.emit({ type: 'FOCUS', planId: ENTRY_PLAN_DEFINITION.id, actionId: 'change_password', payload: { currentPassword: 'x', newPassword: 'brandNew123' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'change_password')).toBe('ready'));
    expect(actionError(runtime.getPlanActor(ENTRY_PLAN_DEFINITION.id).getSnapshot(), 'change_password')).toBe('Current password is incorrect.');

    runtime.dispose();
  });
});
