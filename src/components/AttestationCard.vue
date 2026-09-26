<script setup>
// The one moment in a registration journey that carries real legal weight — first built for
// FacilityHfrPanel.vue's own Submit step. Deliberately styled apart from the ambient teal/
// --cf-bg-alt card language every other panel in this app uses, so its gravity reads correctly and
// never gets confused with routine data entry. Confirmed live gap: ProviderHprPanel.vue's own
// Aadhaar-OTP capture — the closest existing "identity action" in this app — uses the identical
// plain .cf-input styling as any mundane text field (mobile number, password); there is no
// precedent anywhere in this codebase for signaling "this one's different" until now.
//
// Kept generic (no ABDM/HFR knowledge baked in — summary rows, declaration text, and the signing
// gate are all caller-supplied) so the Provider/HPR journey coming next can reuse this same
// component for its own attestation moments, not just this one.
defineProps({
  title: { type: String, default: 'Declaration & Signature' },
  // [{ label, value }] — the facts actually being attested, pulled from the already-captured
  // record by the caller. Shown as a real read-only summary, not a checkbox in a vacuum.
  summary: { type: Array, default: () => [] },
  declarationText: { type: String, required: true },
  canSign: { type: Boolean, default: false },
  // Shown next to the Sign button when canSign is false — e.g. "Log in with your Facility
  // Manager HPR ID first."
  cannotSignReason: { type: String, default: '' },
  signingAsLabel: { type: String, default: '' }, // e.g. "Signing as: <name> (HPR ID ...)"
  loading: { type: Boolean, default: false },
});
const consented = defineModel('consented', { default: false });
const emit = defineEmits(['sign']);
</script>

<template>
  <div class="ac-root">
    <div class="ac-header">
      <i class="fas fa-file-signature"></i>
      <h3>{{ title }}</h3>
    </div>

    <div v-if="summary.length" class="ac-summary">
      <div v-for="row in summary" :key="row.label" class="ac-summary-row">
        <span class="ac-summary-label">{{ row.label }}</span>
        <span class="ac-summary-value">{{ row.value || '—' }}</span>
      </div>
    </div>

    <p class="ac-declaration">{{ declarationText }}</p>

    <label class="ac-consent">
      <input type="checkbox" v-model="consented" />
      <span>I have read and confirm the declaration above.</span>
    </label>

    <p v-if="signingAsLabel" class="ac-signing-as"><i class="fas fa-shield-halved"></i>{{ signingAsLabel }}</p>
    <p v-else-if="!canSign && cannotSignReason" class="ac-cannot-sign"><i class="fas fa-circle-info"></i>{{ cannotSignReason }}</p>

    <button
      type="button"
      class="ac-sign-btn"
      :disabled="!consented || !canSign || loading"
      @click="emit('sign')"
    >
      <i class="fas" :class="loading ? 'fa-spinner fa-spin' : 'fa-signature'"></i>
      {{ loading ? 'Signing & submitting…' : 'Sign & Submit' }}
    </button>
  </div>
</template>

<style scoped>
.ac-root {
  background: var(--color-secondary);
  border: 1px solid var(--color-secondary);
  border-radius: 1rem;
  padding: 1.25rem 1.25rem 1.4rem;
  color: rgba(255, 255, 255, .92);
}
.dark .ac-root { background: #061423; border-color: #0d2f52; }

.ac-header { display: flex; align-items: center; gap: .55rem; margin-bottom: .85rem; }
.ac-header i { color: var(--color-primary); font-size: 1.05rem; }
.ac-header h3 { font-family: 'Poppins', sans-serif; font-weight: 700; font-size: 1rem; color: #fff; margin: 0; }

.ac-summary {
  background: rgba(255, 255, 255, .06);
  border: 1px solid rgba(255, 255, 255, .12);
  border-radius: .6rem;
  padding: .6rem .85rem;
  margin-bottom: .9rem;
}
.ac-summary-row { display: flex; justify-content: space-between; gap: 1rem; padding: .28rem 0; font-size: .82rem; }
.ac-summary-row + .ac-summary-row { border-top: 1px solid rgba(255, 255, 255, .08); }
.ac-summary-label { color: rgba(255, 255, 255, .6); }
.ac-summary-value { color: #fff; font-weight: 600; text-align: right; }

.ac-declaration {
  font-size: .82rem; line-height: 1.55; color: rgba(255, 255, 255, .78);
  margin: 0 0 1rem; max-width: 62ch;
}

.ac-consent {
  display: flex; align-items: flex-start; gap: .55rem; cursor: pointer;
  font-size: .85rem; color: #fff; font-weight: 600; margin-bottom: .9rem;
}
.ac-consent input { margin-top: .2rem; accent-color: var(--color-primary); width: 16px; height: 16px; flex: none; }

.ac-signing-as, .ac-cannot-sign {
  display: flex; align-items: center; gap: .4rem; font-size: .78rem; margin: 0 0 .8rem;
}
.ac-signing-as { color: var(--color-primary); }
.ac-cannot-sign { color: #fca5a5; }

.ac-sign-btn {
  display: inline-flex; align-items: center; gap: .5rem;
  background: var(--color-primary); color: var(--color-secondary);
  font-family: 'Poppins', sans-serif; font-weight: 700; font-size: .88rem;
  padding: .7rem 1.4rem; border: none; border-radius: .6rem; cursor: pointer; transition: all .15s;
}
.ac-sign-btn:hover:not(:disabled) { background: var(--color-primary-hover); transform: translateY(-1px); }
.ac-sign-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
