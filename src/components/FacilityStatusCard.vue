<script setup>
// The persistent cross-tab summary that finally renders facilitySetupMachine.js's own real
// lifecycle — that machine's only rendering anywhere in this app used to be one unstyled,
// opacity:.8 text line in JoinLinkPanel.vue, never surfaced in Onboarding.vue at all. Mounted
// above Onboarding.vue's page-level AdaptiveSectionNav so a facility manager can see "where does
// my facility actually stand" without switching between the Hospital Profile and ABDM
// Registration tabs — those two panels keep their own real, deliberate field boundary
// (FacilityBasicsHost.vue/FacilityHfrPanel.vue's own header comments); this only fixes
// discoverability, not the data model.
import { computed } from 'vue';
import { facilityStatusPills, canContinueHfr } from './facilityStatusCard.js';

const props = defineProps({
  stage: { type: String, default: 'draft' }, // facilitySetupMachine's own stage string
});
const emit = defineEmits(['continue-hfr']);

const pills = computed(() => facilityStatusPills(props.stage));
const showContinue = computed(() => canContinueHfr(props.stage));

function toneClass(tone) {
  return tone === 'teal' ? 'badge-teal' : tone === 'amber' ? 'badge-amber' : 'badge-muted';
}
</script>

<template>
  <div class="cf-card rounded-2xl p-3 mb-3 fsc-root">
    <div class="fsc-row">
      <i class="fas fa-hospital fsc-icon"></i>
      <span class="fsc-label">Facility Profile</span>
      <span class="badge" :class="toneClass(pills.basics.tone)">{{ pills.basics.text }}</span>
    </div>
    <div class="fsc-row">
      <i class="fas fa-landmark fsc-icon"></i>
      <span class="fsc-label">ABDM Registration (HFR)</span>
      <span class="badge" :class="toneClass(pills.abdm.tone)">{{ pills.abdm.text }}</span>
    </div>
    <button v-if="showContinue" type="button" class="fsc-continue" @click="emit('continue-hfr')">
      Continue ABDM Registration <i class="fas fa-arrow-right"></i>
    </button>
  </div>
</template>

<style scoped>
.fsc-root { display: flex; flex-direction: column; gap: .4rem; }
.fsc-row { display: flex; align-items: center; gap: .55rem; }
.fsc-icon { width: 16px; text-align: center; color: var(--cf-text); font-size: .82rem; }
.fsc-label { font-size: .82rem; font-weight: 600; color: var(--cf-text-strong); flex: 1; }
.fsc-continue {
  align-self: flex-start; margin-top: .3rem; background: none; border: none; padding: 0;
  font-family: 'Poppins', sans-serif; font-weight: 700; font-size: .78rem; color: var(--color-primary);
  cursor: pointer; display: flex; align-items: center; gap: .35rem;
}
.fsc-continue:hover { color: var(--color-primary-hover); }
</style>
