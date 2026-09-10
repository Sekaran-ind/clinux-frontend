// Facility setup-completion lifecycle, as a real XState machine — same package/idiom
// src/workflow/planDefinitionRunner.js already uses (single-arg createMachine, guards inlined as
// ({context}) => boolean), but deliberately NOT registered into workflowRuntime.js's tracked
// Task/PlanDefinition runtime. That runtime is reserved for clinical journeys — facility/staff
// registration was explicitly pulled OUT of it (see clinux-known-bugs.../SPEC-23's "state machine
// only for clinical journeys" boundary). This machine is a different shape of thing: it never
// receives events, is never persisted, and has no actor a UI sends FOCUS/COMPLETE to — it just
// classifies a snapshot of already-stored data into a lifecycle stage, the instant it's created,
// via `always` transitions gated purely on the context it's handed. Think "pure function shaped
// like a state chart because the stages and their ordering are the interesting part", not "tracked
// process."
//
// Built as the first piece of the facility/provider join-token linking design (see the token/
// gating discussion this session): a facility can only accept a staff/affiliate join-token
// redemption once it's past a real readiness bar, not the instant an account exists. The
// provider/person side of that same idea (personSetupMachine) and the admin-approval step
// (joinRequestMachine) are documented, not built yet — see docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md.
import { createActor, createMachine } from 'xstate';

export const facilitySetupMachine = createMachine({
  id: 'facilitySetup',
  context: ({ input }) => ({
    hasBasics: !!input?.hasBasics,
    everPublished: !!input?.everPublished,
    hfrFacilityId: input?.hfrFacilityId || null,
  }),
  initial: 'draft',
  states: {
    // No Hospital/Practice Profile saved yet (buildClinicProfile().name is still empty) —
    // nothing to publish, let alone register with HFR.
    draft: {
      always: { target: 'basics_saved', guard: ({ context }) => context.hasBasics },
    },
    // A real profile exists but "Publish Clinic Page" was never clicked (onboarding.js's
    // everPublished) — real data, not yet a live clinic.
    basics_saved: {
      always: { target: 'published', guard: ({ context }) => context.everPublished },
    },
    // Published and live. This is the DEFAULT eligibility bar for accepting a facility-join-token
    // redemption — see canAcceptFacilityJoinToken below. Deliberately not gated on HFR: HFR/ABDM
    // registration is optional supplementary registration everywhere else in this product
    // (checkConformance()'s own "most clinics won't see this go green... that's expected, not
    // required to publish" precedent) — requiring it here too would lock every free-tier clinic
    // out of inviting staff at all.
    published: {
      always: { target: 'hfr_registered', guard: ({ context }) => !!context.hfrFacilityId },
    },
    // FacilityHfrPanel.vue's submit step returned a real ABDM facilityId (persisted onto the
    // record as hospital_facility_id). The strictest bar — a caller wanting "Enterprise tier,
    // real HFR-registered facilities only" join-token gating compares the stage itself for this
    // exact value rather than using canAcceptFacilityJoinToken's default.
    hfr_registered: { type: 'final' },
  },
});

// Pure classification helper — real callers (Onboarding.vue's status badge today; the eventual
// join-token redemption route/UI) never touch the machine or an actor directly, just this.
// Snapshot of real stored-data signals in, lifecycle stage string out. No events, no persistence,
// no side effects — safe to call on every render.
export function deriveFacilitySetupState({ hasBasics, everPublished, hfrFacilityId } = {}) {
  const actor = createActor(facilitySetupMachine, { input: { hasBasics, everPublished, hfrFacilityId } });
  actor.start();
  const stage = actor.getSnapshot().value;
  actor.stop();
  return stage;
}

// 'published' or 'hfr_registered' — the default eligibility bar (see the 'published' state's own
// comment above for why HFR completion isn't required).
export function canAcceptFacilityJoinToken(stage) {
  return stage === 'published' || stage === 'hfr_registered';
}

// Display copy for the stage badge — kept alongside the machine so a new stage can't be added
// without a label for it going stale elsewhere.
export const FACILITY_SETUP_STAGE_LABELS = {
  draft: 'Draft — profile not started',
  basics_saved: 'Profile saved — not yet published',
  published: 'Published — can accept team join links',
  hfr_registered: 'HFR-registered — published + ABDM facility ID',
};
