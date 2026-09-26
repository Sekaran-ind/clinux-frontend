<script setup>
// A vertical, numbered, gated stepper for a genuinely SEQUENTIAL multi-stage submission — first
// built for FacilityHfrPanel.vue's real 7-stage ABDM HFR journey (Search -> Basic Info ->
// Additional Info -> Detailed Info -> Public Display -> Attestation & e-Sign -> Submitted), where
// stage N literally cannot start before stage N-1 returns real data (a trackingId, a facilityId).
//
// Deliberately NOT Designer.vue's own `.step-dot`/`.step-connector` row (its "room-designer" 2-step
// flow): that pattern free-jumps between steps with zero completeness/gating logic — right for
// reordering two independent authoring steps, wrong here, where jumping ahead of an ungated stage
// would just 400 against the real ABDM API. This component adds the one thing neither existing
// precedent in this app has: a visible LOCKED state with a reason, so the whole journey stays
// legible up front instead of only revealing the next step once you arrive at it.
//
// Built generic on purpose (stage state driven entirely by the caller, no ABDM-specific logic
// here) so the Provider/HPR journey — ProviderHprPanel.vue's own real but never-visualized
// `not_started -> aadhaar_verified -> account_checked -> ... -> account_created` chain — can mount
// this same component once that redesign lands, rather than a third bespoke stepper getting built.
//
// Visual language intentionally borrows Designer.vue's already-proven token usage (--color-primary
// teal = done, --color-secondary navy ring = active) so it reads as native to this app, not a
// disconnected new style — but is properly `scoped` with distinctly-prefixed `.rl-*` class names;
// Designer.vue's own dot/connector classes are UNSCOPED globals, so reusing their bare names
// anywhere else would silently collide with that file's own styling.
import { ref } from 'vue';
import { selectStage as pureSelectStage } from './registrationLedger.js';

const props = defineProps({
  // [{ id, label, icon?, state: 'done'|'active'|'blocked'|'pending', lockedReason? }]
  // 'blocked' stages refuse navigation and reveal `lockedReason` on click instead.
  // 'pending' stages (no hard gate, just "not reached yet") navigate freely, same as done/active —
  // supported for a future caller whose stages aren't all strictly sequential; the Facility HFR
  // journey itself never emits 'pending', every unstarted stage has a real lockedReason.
  stages: { type: Array, required: true },
});
const activeId = defineModel('activeId', { default: null });

// Which blocked stage (if any) currently has its reason revealed — a plain local toggle, not
// persisted; re-clicking the same blocked stage (or picking a different one) closes/switches it.
const revealedBlockedId = ref(null);

function selectStage(stage) {
  const { nextActiveId, nextRevealedBlockedId } = pureSelectStage(stage, { revealedBlockedId: revealedBlockedId.value });
  revealedBlockedId.value = nextRevealedBlockedId;
  if (nextActiveId !== undefined) activeId.value = nextActiveId;
}
</script>

<template>
  <div class="rl-root">
    <ol class="rl-list">
      <li v-for="(stage, i) in stages" :key="stage.id" class="rl-rung">
        <div class="rl-rung-head">
          <button
            type="button"
            class="rl-dot"
            :class="[`rl-dot--${stage.state}`, { 'rl-dot--current': activeId === stage.id }]"
            :aria-current="activeId === stage.id ? 'step' : undefined"
            :aria-expanded="stage.state === 'blocked' ? revealedBlockedId === stage.id : activeId === stage.id"
            @click="selectStage(stage)"
          >
            <i v-if="stage.state === 'done'" class="fas fa-check"></i>
            <i v-else-if="stage.state === 'blocked'" class="fas fa-lock"></i>
            <span v-else>{{ i + 1 }}</span>
          </button>
          <button type="button" class="rl-label" :class="{ 'rl-label--current': activeId === stage.id }" @click="selectStage(stage)">
            <i v-if="stage.icon" :class="['fas', stage.icon]"></i>{{ stage.label }}
          </button>
        </div>

        <p v-if="stage.state === 'blocked' && revealedBlockedId === stage.id" class="rl-locked-reason">
          <i class="fas fa-circle-info"></i>{{ stage.lockedReason || 'Complete the previous step first.' }}
        </p>

        <div v-if="activeId === stage.id" class="rl-content">
          <slot :name="stage.id" />
        </div>

        <div v-if="i < stages.length - 1" class="rl-connector" :class="{ 'rl-connector--done': stage.state === 'done' }"></div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.rl-root { display: flex; }
.rl-list { list-style: none; margin: 0; padding: 0; width: 100%; }
.rl-rung { position: relative; }

.rl-rung-head { display: flex; align-items: center; gap: .625rem; }

.rl-dot {
  flex: none; width: 30px; height: 30px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-family: 'Poppins', sans-serif; font-weight: 700; font-size: .78rem;
  border: 2px solid var(--cf-border); background: var(--cf-bg-alt); color: var(--cf-text);
  cursor: pointer; transition: all .2s; padding: 0;
}
.rl-dot--done { background: var(--color-primary); color: var(--color-secondary); border-color: var(--color-primary); }
.rl-dot--blocked { background: var(--cf-bg-alt); color: var(--cf-text); border-color: var(--cf-border); cursor: pointer; opacity: .7; }
.rl-dot--current { border-color: var(--color-secondary); box-shadow: 0 0 0 3px rgba(10, 37, 64, .15); }
.dark .rl-dot--current { border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(0, 212, 178, .18); }

.rl-label {
  background: none; border: none; padding: .35rem 0; margin: 0; text-align: left; cursor: pointer;
  font-family: 'Poppins', sans-serif; font-weight: 600; font-size: .88rem; color: var(--cf-text);
  display: flex; align-items: center; gap: .4rem; flex: 1;
}
.rl-label i { font-size: .78rem; color: var(--cf-text); }
.rl-label--current { color: var(--cf-text-strong); }

.rl-locked-reason {
  margin: .3rem 0 0 42px; font-size: .78rem; color: var(--cf-text);
  display: flex; align-items: center; gap: .4rem; max-width: 46ch;
}
.rl-locked-reason i { color: #b45309; }

.rl-content { margin: .75rem 0 .5rem 42px; }

.rl-connector {
  width: 2px; height: 1.4rem; background: var(--cf-border); border-radius: 2px;
  margin: .15rem 0 .15rem 14px; transition: background .25s;
}
.rl-connector--done { background: var(--color-primary); }

@media (max-width: 480px) {
  .rl-content, .rl-locked-reason { margin-left: 0; }
}
</style>
