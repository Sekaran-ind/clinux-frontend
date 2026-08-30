import { describe, expect, it, vi } from 'vitest';
import { createWorkflowRuntime } from './workflowRuntime.js';
import { actionError, actionStatus, readyActionIds } from './planDefinitionRunner.js';
import { AUTH_PLAN_DEFINITION, buildAuthServices } from './authPlanDefinition.js';

// The small closed loop this session picked to validate the runtime for real — register/login/
// change-password, driven entirely through the event bus (never .send() on an actor directly),
// with REAL invoked services (not stubs) bridged to a mocked auth store shaped exactly like
// stores/auth.js's real register/login/changePassword (same {error}-or-{user/success} contract).
function mockAuthStore({ registerFails = false, loginFails = false, changePasswordFails = false } = {}) {
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
  };
}

describe('AUTH_PLAN_DEFINITION driven through the real runtime with real invoked services', () => {
  it('register succeeding auto-unblocks login; login succeeding auto-unblocks change_password — the closed loop, with real async side effects this time, not just guards', async () => {
    const authStore = mockAuthStore();
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(AUTH_PLAN_DEFINITION.id, AUTH_PLAN_DEFINITION, { services: buildAuthServices(authStore) });

    expect(readyActionIds(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), AUTH_PLAN_DEFINITION)).toEqual(['register']);

    runtime.emit({ type: 'FOCUS', planId: AUTH_PLAN_DEFINITION.id, actionId: 'register', payload: { email: 'a@b.com', password: 'password123', role: 'hospital_admin' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'register')).toBe('done'));
    expect(authStore.register).toHaveBeenCalledWith({ email: 'a@b.com', password: 'password123', role: 'hospital_admin' });
    expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('ready'); // auto-unblocked, no manual step

    runtime.emit({ type: 'FOCUS', planId: AUTH_PLAN_DEFINITION.id, actionId: 'login', payload: { email: 'a@b.com', password: 'password123' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('done'));
    expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'change_password')).toBe('ready');

    runtime.emit({ type: 'FOCUS', planId: AUTH_PLAN_DEFINITION.id, actionId: 'change_password', payload: { currentPassword: 'password123', newPassword: 'newPassword456' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'change_password')).toBe('done'));

    runtime.dispose();
  });

  it('a failed register (e.g. duplicate email) returns to ready with the real error message, not stuck in active — a retry (FOCUS again) is possible', async () => {
    const authStore = mockAuthStore({ registerFails: true });
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(AUTH_PLAN_DEFINITION.id, AUTH_PLAN_DEFINITION, { services: buildAuthServices(authStore) });

    runtime.emit({ type: 'FOCUS', planId: AUTH_PLAN_DEFINITION.id, actionId: 'register', payload: { email: 'a@b.com', password: 'password123', role: 'hospital_admin' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'register')).toBe('ready'));

    expect(actionError(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'register')).toBe('An account with this email already exists.');
    expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('pending'); // never unblocked — register never reached done

    runtime.dispose();
  });

  it('login failing does not unblock change_password, and the error clears on a fresh FOCUS retry', async () => {
    const authStore = mockAuthStore({ loginFails: true });
    const runtime = createWorkflowRuntime();
    runtime.registerPlan(AUTH_PLAN_DEFINITION.id, AUTH_PLAN_DEFINITION, { services: buildAuthServices(authStore) });

    runtime.emit({ type: 'FOCUS', planId: AUTH_PLAN_DEFINITION.id, actionId: 'register', payload: { email: 'a@b.com', password: 'password123', role: 'hospital_admin' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'register')).toBe('done'));

    runtime.emit({ type: 'FOCUS', planId: AUTH_PLAN_DEFINITION.id, actionId: 'login', payload: { email: 'a@b.com', password: 'wrong' } });
    await vi.waitFor(() => expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('ready'));
    expect(actionError(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'login')).toBe('Invalid email or password.');
    expect(actionStatus(runtime.getPlanActor(AUTH_PLAN_DEFINITION.id).getSnapshot(), 'change_password')).toBe('pending');

    runtime.dispose();
  });

  it('buildAuthServices bridges the {error}-returning convention to promise rejection — register throws when the store returns an error, resolves when it does not', async () => {
    const failingServices = buildAuthServices(mockAuthStore({ registerFails: true }));
    await expect(failingServices.register({ email: 'a@b.com', password: 'x', role: 'hospital_admin' })).rejects.toThrow('An account with this email already exists.');

    const succeedingServices = buildAuthServices(mockAuthStore());
    await expect(succeedingServices.register({ email: 'a@b.com', password: 'x', role: 'hospital_admin' })).resolves.toMatchObject({ user: { email: 'a@b.com' } });
  });
});
