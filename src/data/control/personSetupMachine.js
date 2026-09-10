// docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md §5 — the mirrored gate for the REDEEMING PERSON,
// alongside facilitySetupMachine.js's facility-side gate. Same idiom (pure createMachine,
// `always` transitions off context, never registered into workflowRuntime.js's tracked runtime —
// see facilitySetupMachine.js's own header for why), but genuinely different stages: there is no
// per-person "publish" action in this app (an individual staff/affiliate record is just a
// section_staff group instance inside the ONE shared Provider composition document, not its own
// document with a save/publish step) — so this machine classifies ACCOUNT + IDENTITY signals
// instead of a publish click.
//
// Role-aware by construction, not a single universal bar (SPEC-26 §5's own reasoning): a staff
// hire may be purely administrative and will never hold an HPR ID, so requiring one would
// incorrectly block most real hires; an affiliate is by definition a licensed practitioner, so
// its 'published' bar is the stricter, real-government-verified one — reusing
// ProviderHprPanel.vue's already-built "log in as yourself" step (myToken set via
// buildHprPasswordLoginBody) as genuine authenticity evidence, not inventing a new identity check.
import { createActor, createMachine } from 'xstate';

export const personSetupMachine = createMachine({
  id: 'personSetup',
  context: ({ input }) => ({
    linkKind: input?.linkKind === 'affiliate' ? 'affiliate' : 'staff',
    hasBasics: !!input?.hasBasics, // admin_name + a reachable contact channel (email/mobile)
    hprVerified: !!input?.hprVerified, // ProviderHprPanel.vue's own "log in as yourself" success
  }),
  initial: 'draft',
  states: {
    draft: {
      always: { target: 'basics_saved', guard: ({ context }) => context.hasBasics },
    },
    basics_saved: {
      always: {
        target: 'published',
        // Staff: basics_saved IS the published bar (see this file's own header). Affiliate: only
        // once a real verified HPR login exists.
        guard: ({ context }) => (context.linkKind === 'staff' ? true : context.hprVerified),
      },
    },
    published: { type: 'final' },
  },
});

export function derivePersonSetupState({ linkKind, hasBasics, hprVerified } = {}) {
  const actor = createActor(personSetupMachine, { input: { linkKind, hasBasics, hprVerified } });
  actor.start();
  const stage = actor.getSnapshot().value;
  actor.stop();
  return stage;
}

// The eligibility bar for REDEEMING a facility join token (SPEC-26 §5/§9) — 'published' only,
// same "default bar everyone in this role can actually reach" reasoning
// canAcceptFacilityJoinToken uses on the facility side.
export function canRedeemFacilityJoinToken(stage) {
  return stage === 'published';
}

export const PERSON_SETUP_STAGE_LABELS = {
  draft: 'Draft — profile not started',
  basics_saved: 'Basic profile saved',
  published: 'Ready to redeem a join link',
};
