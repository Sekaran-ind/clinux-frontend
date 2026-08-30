import { assign, createMachine, fromPromise, stateIn } from 'xstate';

// SPEC-13 (docs/SPEC-13-FHIR-WORKFLOW-DOCUMENTS-AND-CONFORMANCE.md) §2's "PlanDefinition compiles
// into an XState machine config" — made real. A real PlanDefinition (produced by
// clinuxflow-api's local-extractor.js from an authored workflow-definition.yaml, per SPEC-18) in,
// a running machine config out. Each PlanDefinition.action becomes one parallel region (not a
// sequential chain) — every action is independently pending/ready/active/done, and
// PlanDefinition.action.relatedAction becomes a guard gating pending->ready, not a hand-authored
// sequence. This is SPEC-13 §2.3's "closed loop" made concrete: relatedAction re-evaluation isn't
// something a separate step has to trigger — it's just what `always` transitions already do the
// moment a sibling region's state changes, verified empirically against the real xstate package
// this session (relatedAction.relationship is intentionally not distinguished yet — every
// relationship value gates on the target simply reaching 'done'; before-start/after-end/etc.
// timing nuances are a real follow-on, not built here, see this file's own open item below).
//
// Each region's states:
//   pending  — not yet eligible. Auto-advances to `ready` the instant its dependencies (if any)
//              are all `done`, via an `always` transition + `stateIn` guard — no explicit event
//              needed, this IS the closed loop.
//   ready    — eligible, not yet the focus of any actor/UI. Advances to `active` on a `FOCUS`
//              event carrying this exact action's id (guarded, so a broadcast FOCUS event only
//              activates the region it's actually meant for — verified this session that a
//              parallel machine delivers one sent event to every region, each region's own guard
//              decides whether it applies).
//   active   — currently being worked (a Task, in SPEC-13 §2's sense). Two ways to leave here,
//              chosen per-action by whether a real `services[action.id]` was supplied:
//                - No service: manual `COMPLETE` event carrying this action's id (the shape every
//                  action had before this session's register/login/change-password slice — right
//                  for a room whose "completion" means "its own child workflow finished", not one
//                  async call).
//                - A service given: an XState `invoke` (verified empirically against the real
//                  xstate package this session — `fromPromise` + `onDone`/`onError`, not a
//                  synchronous action, since these are real async calls) runs it automatically on
//                  entry. Success advances to `done`; failure returns to `ready` with the error
//                  recorded in context, so the same FOCUS event can retry rather than needing a
//                  whole new machine.
//   done     — final for this region. What relatedAction re-evaluation is checking for.
//
// Other side effects (extraction, Composition assembly, notifying the next Task's owner) still
// don't live here — this file only wires the ONE invoked call an action's own definition names;
// anything that needs to react to a completed action from OUTSIDE it (the next Task becoming
// ready, a notification) belongs in the dispatcher, reacting to state changes, not here.
export function buildPlanDefinitionRunnerMachine(planDefinition, { services = {} } = {}) {
  const actions = planDefinition.action || [];
  if (actions.length === 0) {
    throw new Error('buildPlanDefinitionRunnerMachine: PlanDefinition has no action entries.');
  }

  const states = {};
  actions.forEach((action) => {
    const dependsOn = (action.relatedAction || [])
      .map((ra) => ra.actionId)
      .filter(Boolean);

    const dependencyStateMap = {};
    dependsOn.forEach((id) => { dependencyStateMap[id] = 'done'; });

    const service = services[action.id];

    states[action.id] = {
      initial: 'pending',
      states: {
        pending: {
          always: dependsOn.length > 0
            ? { target: 'ready', guard: stateIn(dependencyStateMap) }
            : { target: 'ready' },
        },
        ready: {
          on: {
            FOCUS: { target: 'active', guard: ({ event }) => event.actionId === action.id },
          },
        },
        active: service
          ? {
              // Clearing the error belongs HERE (entering active — a fresh attempt starting), not
              // on `ready`'s entry — found by a real failing test: `ready` is also the target of
              // onError below, and a target state's entry actions run AFTER the transition's own
              // actions in XState's statechart semantics, so a `ready`-entry reset was silently
              // wiping the very error onError had just set, one step later. Entering `active` only
              // ever means "a new attempt is starting", never "an attempt just failed" — the right
              // place to clear.
              entry: assign({ [`error_${action.id}`]: () => null }),
              invoke: {
                src: fromPromise(({ input }) => service(input)),
                input: ({ event }) => event.payload,
                onDone: { target: 'done' },
                onError: {
                  target: 'ready',
                  actions: assign({ [`error_${action.id}`]: ({ event }) => event.error?.message || 'Failed.' }),
                },
              },
            }
          : {
              on: {
                COMPLETE: { target: 'done', guard: ({ event }) => event.actionId === action.id },
              },
            },
        done: { type: 'final' },
      },
      meta: { title: action.title, dependsOn, hasService: !!service },
    };
  });

  return createMachine({
    id: `plan-${planDefinition.id || 'runner'}`,
    type: 'parallel',
    context: {},
    states,
  });
}

// `error_<actionId>` is a flat context key per action (a parallel machine's context is one
// shared object across every region, not one-per-region) — this selector hides that detail.
export function actionError(snapshot, actionId) {
  return snapshot.context[`error_${actionId}`] || null;
}

// Selector helpers so callers (the dispatcher, the eventual left-pane navigator per SPEC-16 §5)
// don't need to know this machine's internal shape.
export function actionStatus(snapshot, actionId) {
  const value = snapshot.value[actionId];
  return value || null; // 'pending' | 'ready' | 'active' | 'done' | null if unknown actionId
}
export function readyActionIds(snapshot, planDefinition) {
  return (planDefinition.action || [])
    .map((a) => a.id)
    .filter((id) => actionStatus(snapshot, id) === 'ready');
}
