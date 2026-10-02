<script setup>
// Account → Consents: the consents on record for this account, with withdrawal — clinux-cubo's
// AccountPanel "Consents" card. Withdrawing one closes the workspace (the router guard sends you
// to /consent) until you agree again, exactly as in Cübo.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { CONSENTS, TERMS_VERSION } from '../consent/terms.js';
import { useConsentStore } from '../stores/consent.js';
import { useOnboardingStore } from '../stores/onboarding.js';
import { getGroupInstances } from '../data/useSystemForms.js';

const consent = useConsentStore();
const onboarding = useOnboardingStore();
const router = useRouter();
const open = ref(null); // term key whose FHIR JSON is shown

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const VALIDATION = {
  valid: { text: 'Validated as a FHIR Consent', cls: 'ok' },
  pending: { text: 'Validation pending (FHIR API unreachable)', cls: 'warn' },
};

// The consent forms this facility asks its patients to sign (Facility profile → Legal Consents).
const patientConsentForms = computed(() => {
  onboarding.dataVersion;
  return getGroupInstances(onboarding.getProviderRecord(), 'section_consent').length;
});

async function withdraw(key) {
  if (!confirm('Withdraw this consent? The workspace will close for your account until you consent again.')) return;
  await consent.withdraw(key);
  router.replace({ path: '/consent', query: { next: '/account/consents' } });
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Consents</h1>
        <p class="page-subtitle">What you agreed to before the workspace opened, stored on this device as FHIR Consent resources. Terms version {{ TERMS_VERSION }}.</p>
      </div>
      <div class="page-actions"><RouterLink to="/legal#terms" class="ui-btn"><i class="fas fa-scale-balanced"></i> Terms and privacy</RouterLink></div>
    </div>

    <section class="panel" data-testid="consents">
      <div class="panel-head">
        <div>
          <div class="panel-title">Your consents</div>
          <div class="panel-sub">Withdrawing one closes the workspace for your account until you agree again. Data already stored stays until you ask for it to be erased.</div>
        </div>
      </div>
      <div v-for="t in CONSENTS" :key="t.key" class="consent-row">
        <div class="consent-main">
          <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
            <strong>{{ t.title }}</strong>
            <span class="pill" :class="consent.granted[t.key] ? 'ok' : 'off'">{{ consent.granted[t.key] ? 'Active' : (consent.records[t.key] ? 'Withdrawn' : 'Not given') }}</span>
          </div>
          <p class="panel-sub" style="margin:.2rem 0 0">{{ t.summary }}</p>
          <p v-if="consent.records[t.key]" class="meta">
            <template v-if="consent.granted[t.key]">
              Given {{ when(consent.records[t.key].resource.dateTime) }} ·
              <span :class="VALIDATION[consent.records[t.key].validation.status]?.cls">{{ VALIDATION[consent.records[t.key].validation.status]?.text || consent.records[t.key].validation.status }}</span>
            </template>
            <template v-else>Withdrawn {{ when(consent.records[t.key].resource.provision?.period?.end) }}</template>
          </p>
          <button v-if="consent.records[t.key]" class="ui-link" style="margin-top:.35rem" @click="open = open === t.key ? null : t.key">{{ open === t.key ? 'Hide' : 'View' }} FHIR Consent</button>
          <pre v-if="open === t.key" class="json">{{ JSON.stringify(consent.records[t.key].resource, null, 2) }}</pre>
        </div>
        <button v-if="consent.granted[t.key]" class="ui-btn danger" @click="withdraw(t.key)">Withdraw</button>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">Patients’ consents</div>
          <div class="panel-sub">The consent forms your facility asks patients to sign are part of the facility profile.</div>
        </div>
        <RouterLink :to="{ path: '/onboarding', query: { section: 'section_consent' } }" class="ui-btn" style="flex-shrink:0">Manage</RouterLink>
      </div>
      <div class="panel-row">
        <span>{{ patientConsentForms }} consent form{{ patientConsentForms === 1 ? '' : 's' }} set up</span>
        <span class="panel-row-muted">ABDM consent requests (M3: asking a patient to share records from other hospitals) need ClinuxFlow registered as a health information user — planned, not yet available.</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.consent-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: .875rem 1rem; border-top: 1px solid var(--shell-border); }
.consent-row:first-of-type { border-top: none; }
.consent-main { min-width: 0; flex: 1; font-size: .85rem; color: var(--shell-text-strong); }
.meta { margin: .35rem 0 0; font-size: .75rem; color: var(--shell-text-muted); }
.meta .ok { color: #15803d; }
.meta .warn { color: #b45309; }
.pill { font-size: .66rem; font-weight: 700; padding: .1rem .45rem; border-radius: 99px; }
.pill.ok { background: #dcfce7; color: #166534; }
.pill.off { background: var(--shell-hover); color: var(--shell-text-muted); }
.json { margin-top: .5rem; font-family: 'JetBrains Mono', monospace; font-size: .7rem; background: var(--shell-bg); border: 1px solid var(--shell-border); border-radius: .5rem; padding: .75rem; max-height: 320px; overflow: auto; white-space: pre-wrap; color: var(--shell-text-strong); }
.ui-btn.danger { color: #b91c1c; border-color: #fecaca; flex-shrink: 0; }
.ui-btn.danger:hover { background: #fef2f2; }
</style>
