<script setup>
// Affiliations, terms and privacy in full — clinux-cubo's src/views/Legal.vue in the workspace's
// styles. Public: readable before signing in (its own header) and inside the workspace (the
// shell's chrome instead). Never behind the consent gate.
import { computed, nextTick, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import SiteFooter from '../components/SiteFooter.vue';
import { AFFILIATIONS, CONTACT, OPERATOR, PRIVACY, PRODUCT, TERMS, UPDATED } from '../legal/legal.js';

const route = useRoute();
const auth = useAuthStore();
const inWorkspace = computed(() => !!auth.currentUser);

async function scrollToHash() {
  await nextTick();
  if (route.hash) document.querySelector(route.hash)?.scrollIntoView({ block: 'start' });
}
onMounted(scrollToHash);
watch(() => route.hash, scrollToHash);

const groups = [
  ['National programmes', AFFILIATIONS.programmes],
  ['Standards and terminologies', AFFILIATIONS.standards],
  ['Built with', AFFILIATIONS.builtWith],
];
</script>

<template>
  <div class="legal-root" :class="{ bare: !inWorkspace }">
    <header v-if="!inWorkspace" class="legal-header">
      <RouterLink to="/" class="legal-logo" aria-label="Back to ClinüxFlow">CÜ</RouterLink>
      <div style="flex:1;min-width:0">
        <strong style="display:block;color:var(--cf-text-strong)">{{ PRODUCT }}</strong>
        <span style="font-size:.75rem;color:var(--cf-text)">Affiliations, terms and privacy · updated {{ UPDATED }}</span>
      </div>
      <RouterLink to="/" class="ui-btn">Back</RouterLink>
    </header>

    <main class="page" style="max-width:820px">
      <div class="page-header">
        <div>
          <h1 class="page-title">Affiliations, terms and privacy</h1>
          <p class="page-subtitle">Updated {{ UPDATED }}. Data fiduciary: {{ OPERATOR }}.</p>
        </div>
        <nav class="page-actions" aria-label="On this page">
          <a href="#affiliations" class="ui-btn">Affiliations</a><a href="#terms" class="ui-btn">Terms</a><a href="#privacy" class="ui-btn">Privacy</a>
        </nav>
      </div>

      <section id="affiliations" class="legal-section">
        <h2 class="legal-h1">Affiliations</h2>
        <p class="page-subtitle" style="margin-top:0">{{ AFFILIATIONS.intro }}</p>
        <div v-for="[title, list] in groups" :key="title" class="legal-group">
          <h3 class="legal-h2">{{ title }}</h3>
          <div v-for="a in list" :key="a.name" class="panel legal-card">
            <a :href="a.url" target="_blank" rel="noopener" style="font-weight:600">{{ a.name }}</a>
            <p>{{ a.detail }}</p>
          </div>
        </div>
      </section>

      <section id="terms" class="legal-section">
        <h2 class="legal-h1">Terms of use</h2>
        <p class="page-subtitle" style="margin-top:0">{{ TERMS.summary }}</p>
        <div v-for="s in TERMS.sections" :key="s.title" class="panel legal-card">
          <h3 class="legal-h2" style="margin-top:0">{{ s.title }}</h3>
          <ul><li v-for="p in s.points" :key="p">{{ p }}</li></ul>
        </div>
      </section>

      <section id="privacy" class="legal-section">
        <h2 class="legal-h1">Privacy notice</h2>
        <p class="page-subtitle" style="margin-top:0">{{ PRIVACY.summary }}</p>
        <div v-for="s in PRIVACY.sections" :key="s.title" class="panel legal-card">
          <h3 class="legal-h2" style="margin-top:0">{{ s.title }}</h3>
          <ul><li v-for="p in s.points" :key="p">{{ p }}</li></ul>
        </div>
        <p style="font-size:.85rem">Data fiduciary: {{ OPERATOR }}. Contact for requests and grievances: <a :href="`mailto:${CONTACT}`">{{ CONTACT }}</a>.</p>
      </section>
    </main>
    <SiteFooter v-if="!inWorkspace" />
  </div>
</template>

<style scoped>
.legal-root.bare { min-height: 100vh; display: flex; flex-direction: column; background: var(--cf-bg); }
.legal-root.bare main { flex: 1; }
.legal-header { display: flex; align-items: center; gap: .75rem; padding: .6rem 1.25rem; background: var(--cf-bg-alt); border-bottom: 1px solid var(--cf-border); }
.legal-logo { width: 32px; height: 32px; border-radius: .5rem; display: flex; align-items: center; justify-content: center; background: var(--color-primary); color: var(--color-on-primary); font-family: 'JetBrains Mono', monospace; font-weight: 800; font-size: .78rem; text-decoration: none; }
.legal-section { display: flex; flex-direction: column; gap: .75rem; margin-bottom: 2.5rem; scroll-margin-top: 72px; }
.legal-h1 { font-size: 1.15rem; font-weight: 700; color: var(--cf-text-strong); margin: 0; }
.legal-h2 { font-size: .92rem; font-weight: 700; color: var(--cf-text-strong); margin: .5rem 0 0; }
.legal-group { display: flex; flex-direction: column; gap: .5rem; }
.legal-card { padding: .875rem 1rem; }
.legal-card + .legal-card { margin-top: 0; }
.legal-card p { margin: .3rem 0 0; font-size: .84rem; color: var(--cf-text); line-height: 1.55; }
.legal-card ul { margin: .5rem 0 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: .35rem; font-size: .84rem; line-height: 1.55; color: var(--cf-text-strong); list-style: disc; }
.legal-root a { color: var(--color-primary-text, var(--color-primary)); }
</style>
