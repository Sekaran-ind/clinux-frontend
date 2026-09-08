import { describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { actionResult, actionStatus, buildPlanDefinitionRunnerMachine, readyActionIds } from './planDefinitionRunner.js';

// Fixture matches the REAL shape local-extractor.js produces for
// clinuxflow-api/samples/workflow-definition-v1.draft.yaml's worked example (verified there via
// workflow-definition-draft.test.js) — same five rooms, same relatedAction dependencies — not a
// fabricated shape, copied from the real, already-tested extraction output. Cross-repo, can't
// literally import the extractor from clinux-frontend, so the fixture is the honest substitute.
const FIVE_ROOM_PLAN = {
  resourceType: 'PlanDefinition',
  id: 'clinic-visit-workflow-v1',
  title: 'Clinic Visit Workflow',
  action: [
    { id: 'facility_registration', title: 'Facility Registration' },
    { id: 'provider_registration', title: 'Provider Registration', relatedAction: [{ actionId: 'facility_registration', relationship: 'after-start' }] },
    { id: 'front_desk', title: 'Front Desk', relatedAction: [{ actionId: 'facility_registration', relationship: 'after-end' }] },
    {
      id: 'consultation_desk',
      title: 'Consultation Desk',
      relatedAction: [
        { actionId: 'front_desk', relationship: 'after-end' },
        { actionId: 'provider_registration', relationship: 'after-start' },
      ],
    },
    { id: 'checkout', title: 'Checkout', relatedAction: [{ actionId: 'consultation_desk', relationship: 'after-end' }] },
  ],
};

describe('buildPlanDefinitionRunnerMachine', () => {
  it('rooms with no dependency start ready; dependent rooms start pending', () => {
    const actor = createActor(buildPlanDefinitionRunnerMachine(FIVE_ROOM_PLAN)).start();
    const snapshot = actor.getSnapshot();

    expect(actionStatus(snapshot, 'facility_registration')).toBe('ready');
    expect(actionStatus(snapshot, 'provider_registration')).toBe('pending');
    expect(actionStatus(snapshot, 'front_desk')).toBe('pending');
    expect(actionStatus(snapshot, 'consultation_desk')).toBe('pending');
    expect(actionStatus(snapshot, 'checkout')).toBe('pending');
    expect(readyActionIds(snapshot, FIVE_ROOM_PLAN)).toEqual(['facility_registration']);
  });

  it('completing facility_registration auto-unblocks BOTH its dependents (after-start AND after-end), no explicit re-evaluation step needed — this IS the closed loop', () => {
    const actor = createActor(buildPlanDefinitionRunnerMachine(FIVE_ROOM_PLAN)).start();

    actor.send({ type: 'FOCUS', actionId: 'facility_registration' });
    expect(actionStatus(actor.getSnapshot(), 'facility_registration')).toBe('active');

    actor.send({ type: 'COMPLETE', actionId: 'facility_registration' });
    const snapshot = actor.getSnapshot();

    expect(actionStatus(snapshot, 'facility_registration')).toBe('done');
    expect(actionStatus(snapshot, 'provider_registration')).toBe('ready'); // after-start on facility_registration
    expect(actionStatus(snapshot, 'front_desk')).toBe('ready'); // after-end on facility_registration
    expect(actionStatus(snapshot, 'consultation_desk')).toBe('pending'); // still needs front_desk AND provider_registration
  });

  it('consultation_desk requires BOTH its dependencies (AND-gated) — neither alone is enough', () => {
    const actor = createActor(buildPlanDefinitionRunnerMachine(FIVE_ROOM_PLAN)).start();

    actor.send({ type: 'FOCUS', actionId: 'facility_registration' });
    actor.send({ type: 'COMPLETE', actionId: 'facility_registration' });
    actor.send({ type: 'FOCUS', actionId: 'front_desk' });
    actor.send({ type: 'COMPLETE', actionId: 'front_desk' });
    expect(actionStatus(actor.getSnapshot(), 'consultation_desk')).toBe('pending'); // front_desk alone isn't enough

    actor.send({ type: 'FOCUS', actionId: 'provider_registration' }); // -> 'active', not 'done' yet
    // consultation_desk's relatedAction on provider_registration is labeled "after-start" — by
    // FHIR's own semantics that arguably should mean "provider_registration merely needs to have
    // STARTED (active), not finished" — but this machine doesn't distinguish relationship values
    // yet (flagged in this file's header comment) and gates every dependency on 'done' uniformly.
    // So this correctly stays pending here even though the relationship name suggests it shouldn't
    // have to — documenting the real current behavior, not the eventually-correct one.
    expect(actionStatus(actor.getSnapshot(), 'consultation_desk')).toBe('pending');

    actor.send({ type: 'COMPLETE', actionId: 'provider_registration' });
    expect(actionStatus(actor.getSnapshot(), 'consultation_desk')).toBe('ready'); // both satisfied now
  });

  it('a FOCUS/COMPLETE event only affects the region whose actionId matches — broadcast to all regions, guarded per-region (verified this is how parallel machines deliver events)', () => {
    const actor = createActor(buildPlanDefinitionRunnerMachine(FIVE_ROOM_PLAN)).start();
    actor.send({ type: 'FOCUS', actionId: 'facility_registration' });

    // front_desk is still 'pending' (not even 'ready' yet) — a COMPLETE meant for a different
    // action must not affect it.
    actor.send({ type: 'COMPLETE', actionId: 'front_desk' });
    expect(actionStatus(actor.getSnapshot(), 'front_desk')).toBe('pending');
    expect(actionStatus(actor.getSnapshot(), 'facility_registration')).toBe('active'); // untouched by the other event too
  });

  it('throws on a PlanDefinition with no actions rather than silently producing an empty machine', () => {
    expect(() => buildPlanDefinitionRunnerMachine({ action: [] })).toThrow();
  });

  // Real bug found live via GetStarted/Cübo testing, not hypothetical: a second login attempt in
  // the same session silently did nothing — no API call, no error. Root cause: `done` was always
  // `type: 'final'`, an XState terminal state that never accepts another event, correct for a
  // genuinely one-shot action (register) but wrong for one a user legitimately redoes (login
  // again after logging out).
  describe('action.repeatable', () => {
    const REPEATABLE_PLAN = {
      id: 'repeatable-test',
      action: [
        { id: 'once', title: 'Once' }, // repeatable defaults to false/undefined
        { id: 'again', title: 'Again', repeatable: true },
      ],
    };

    it('a non-repeatable action\'s done state is final — a second FOCUS is silently dropped (the real bug, confirmed reproducible)', () => {
      const actor = createActor(buildPlanDefinitionRunnerMachine(REPEATABLE_PLAN)).start();
      actor.send({ type: 'FOCUS', actionId: 'once' });
      actor.send({ type: 'COMPLETE', actionId: 'once' });
      expect(actionStatus(actor.getSnapshot(), 'once')).toBe('done');

      actor.send({ type: 'FOCUS', actionId: 'once' }); // should be dropped, done is final
      expect(actionStatus(actor.getSnapshot(), 'once')).toBe('done'); // never moved to 'active'
    });

    it('a repeatable action accepts FOCUS again after done, re-entering active — the actual fix', () => {
      const actor = createActor(buildPlanDefinitionRunnerMachine(REPEATABLE_PLAN)).start();
      actor.send({ type: 'FOCUS', actionId: 'again' });
      actor.send({ type: 'COMPLETE', actionId: 'again' });
      expect(actionStatus(actor.getSnapshot(), 'again')).toBe('done');

      actor.send({ type: 'FOCUS', actionId: 'again' });
      expect(actionStatus(actor.getSnapshot(), 'again')).toBe('active'); // accepted this time

      actor.send({ type: 'COMPLETE', actionId: 'again' });
      expect(actionStatus(actor.getSnapshot(), 'again')).toBe('done'); // and can complete again too
    });
  });

  // SPEC-21 §5's role-based next-action triggering needs to know what an action actually
  // resolved to (e.g. login's real { user: { role } }) — previously discarded once 'done' fired.
  describe('actionResult', () => {
    it("captures an invoke's real resolved value (event.output) into context, keyed per action", async () => {
      const plan = { id: 'result-test', action: [{ id: 'login', title: 'Login' }] };
      const service = vi.fn(async () => ({ user: { id: 'acc1', role: 'hospital_admin' } }));
      const actor = createActor(buildPlanDefinitionRunnerMachine(plan, { services: { login: service } })).start();

      actor.send({ type: 'FOCUS', actionId: 'login', payload: { email: 'a@b.com', password: 'x' } });
      await vi.waitFor(() => expect(actionStatus(actor.getSnapshot(), 'login')).toBe('done'));

      expect(actionResult(actor.getSnapshot(), 'login')).toEqual({ user: { id: 'acc1', role: 'hospital_admin' } });
    });

    it('returns null for an action with no service (COMPLETE-driven) or one that has not resolved yet', () => {
      const actor = createActor(buildPlanDefinitionRunnerMachine(FIVE_ROOM_PLAN)).start();
      expect(actionResult(actor.getSnapshot(), 'facility_registration')).toBeNull();

      actor.send({ type: 'FOCUS', actionId: 'facility_registration' });
      actor.send({ type: 'COMPLETE', actionId: 'facility_registration' });
      expect(actionResult(actor.getSnapshot(), 'facility_registration')).toBeNull(); // COMPLETE carries no output
    });
  });
});
