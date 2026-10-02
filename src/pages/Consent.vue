<script setup>
// Shown after sign-in until both consents are given for the current terms version — clinux-cubo's
// src/views/Consent.vue in the workspace's styles. Each term is accepted explicitly (its own
// checkbox); the Consent resources are validated by fhir-api before they are stored on this
// device. Outside the workspace shell on purpose: the workspace stays closed until this is done.
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CONSENTS, TERMS_VERSION } from '../consent/terms.js';
import { useConsentStore } from '../stores/consent.js';
import { useAuthStore } from '../stores/auth.js';
import { useEntryWorkflowStore } from '../stores/entryWorkflow.js';
import SiteFooter from '../components/SiteFooter.vue';

const auth = useAuthStore();
const consent = useConsentStore();
const entryWorkflow = useEntryWorkflowStore();
const route = useRoute();
const router = useRouter();
const accepted = ref(Object.fromEntries(CONSENTS.map((t) => [t.key, false])));
const busy = ref(false);
const errors = ref([]);
const allTicked = computed(() => CONSENTS.every((t) => accepted.value[t.key]));

// Back to where they were headed (an internal path only), else the workspace.
const next = computed(() => {
  const r = String(route.query.next || '');
  return r.startsWith('/') && !r.startsWith('//') && r !== '/consent' ? r : '/dashboard';
});

async function submit() {
  busy.value = true;
  errors.value = [];
  const result = await consent.grantAll(auth.currentUser);
  busy.value = false;
  if (!result.ok) return (errors.value = result.errors.length ? result.errors : ['The consent could not be validated.']);
  router.replace(next.value);
}

function signOut() {
  entryWorkflow.logout();
  consent.reset();
  router.replace('/');
}
</script>

<template>
  <div class="consent-root">
    <main class="page" style="max-width:760px">
      <div class="page-header">
        <div>
          <h1 class="page-title">Before you start</h1>
          <p class="page-subtitle">Signed in as {{ auth.currentUser?.email }} · Terms version {{ TERMS_VERSION }}. The workspace opens once you’ve agreed to both.</p>
        </div>
        <div class="page-actions">
          <RouterLink to="/legal" class="ui-btn"><i class="fas fa-scale-balanced"></i> Full terms and privacy</RouterLink>
          <button class="ui-btn" @click="signOut"><i class="fas fa-arrow-right-from-bracket"></i> Sign out</button>
        </div>
      </div>

      <section v-for="term in CONSENTS" :key="term.key" class="panel consent-card" :data-consent="term.key">
        <h2 class="panel-title" style="font-size:.95rem">{{ term.title }}</h2>
        <p class="panel-sub" style="margin-top:.2rem">{{ term.summary }}</p>
        <ul><li v-for="p in term.points" :key="p">{{ p }}</li></ul>
        <p v-if="term.notice" class="notice">{{ term.notice }}</p>
        <label class="agree">
          <input v-model="accepted[term.key]" type="checkbox" :name="term.key" />
          <span>I agree to the {{ term.title.toLowerCase() }} terms</span>
        </label>
      </section>

      <div v-if="errors.length" class="panel" style="padding:1rem;margin-top:1rem">
        <p v-for="e in errors" :key="e" style="margin:0;color:#b91c1c;font-size:.85rem">{{ e }}</p>
      </div>

      <div style="display:flex;justify-content:flex-end;margin-top:1.25rem">
        <button class="ui-btn ui-btn-primary" :disabled="!allTicked || busy" @click="submit">
          <i v-if="busy" class="fas fa-spinner fa-spin"></i> Agree and continue
        </button>
      </div>
    </main>
    <SiteFooter />
  </div>
</template>

<style scoped>
.consent-root { min-height: 100vh; display: flex; flex-direction: column; background: var(--shell-bg); }
.consent-root main { flex: 1; }
.consent-card { padding: 1.25rem; }
.consent-card ul { margin: .75rem 0; padding-left: 1.2rem; list-style: disc; display: flex; flex-direction: column; gap: .4rem; font-size: .85rem; line-height: 1.55; color: var(--shell-text-strong); }
.notice { font-size: .72rem; color: var(--shell-text-muted); background: var(--shell-bg); border-radius: .5rem; padding: .75rem; margin: 0; }
.agree { display: flex; align-items: flex-start; gap: .5rem; margin-top: .875rem; font-weight: 600; font-size: .88rem; color: var(--shell-text-strong); cursor: pointer; }
.agree input { margin-top: .2rem; width: 16px; height: 16px; }
</style>
