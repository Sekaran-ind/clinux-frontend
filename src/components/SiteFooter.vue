<script setup>
// The footer: affiliations, terms and privacy — clinux-cubo's src/components/SiteFooter.vue in
// the workspace's styles. Full on the landing, legal and consent pages; a single line of links
// at the bottom of the signed-in workspace. The full text is on /legal (src/legal/legal.js).
import { AFFILIATIONS, CONTACT, OPERATOR, PRIVACY, TERMS, UPDATED } from '../legal/legal.js';

defineProps({ compact: { type: Boolean, default: false } });
const year = new Date(UPDATED).getFullYear();
</script>

<template>
  <footer v-if="compact" class="footer-compact" data-testid="site-footer-compact">
    <RouterLink to="/legal#affiliations">Affiliations</RouterLink>
    <RouterLink to="/legal#terms">Terms</RouterLink>
    <RouterLink to="/legal#privacy">Privacy</RouterLink>
    <span>© {{ year }} {{ OPERATOR }}</span>
  </footer>

  <footer v-else class="footer-full" data-testid="site-footer">
    <div class="footer-grid">
      <section aria-labelledby="f-aff">
        <h2 id="f-aff" class="footer-h">Affiliations</h2>
        <ul class="footer-list">
          <li v-for="a in AFFILIATIONS.programmes" :key="a.name"><a :href="a.url" target="_blank" rel="noopener">{{ a.name.split(',')[0] }}</a></li>
        </ul>
        <p class="footer-muted">{{ AFFILIATIONS.intro }}</p>
        <RouterLink class="footer-more" to="/legal#affiliations">Standards and credits</RouterLink>
      </section>
      <section aria-labelledby="f-terms">
        <h2 id="f-terms" class="footer-h">Terms</h2>
        <p class="footer-text">{{ TERMS.summary }}</p>
        <RouterLink class="footer-more" to="/legal#terms">Read the terms</RouterLink>
      </section>
      <section aria-labelledby="f-privacy">
        <h2 id="f-privacy" class="footer-h">Privacy</h2>
        <p class="footer-text">{{ PRIVACY.summary }}</p>
        <p class="footer-muted">Requests and grievances: <a :href="`mailto:${CONTACT}`">{{ CONTACT }}</a></p>
        <RouterLink class="footer-more" to="/legal#privacy">Read the privacy notice</RouterLink>
      </section>
    </div>
    <p class="footer-bottom">© {{ year }} {{ OPERATOR }} · ClinuxFlow is not affiliated with or endorsed by the National Health Authority.</p>
  </footer>
</template>

<style scoped>
.footer-full { width: 100%; border-top: 1px solid var(--cf-border); background: var(--cf-bg-alt); }
.footer-grid { max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem; display: grid; gap: 2rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 760px) { .footer-grid { grid-template-columns: 1fr; } }
.footer-h { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--cf-text); margin: 0 0 .6rem; }
.footer-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .35rem; font-size: .85rem; }
.footer-text { font-size: .85rem; margin: 0; color: var(--cf-text-strong); line-height: 1.55; }
.footer-muted { font-size: .75rem; margin: .5rem 0 0; color: var(--cf-text); line-height: 1.5; }
.footer-more { display: inline-block; margin-top: .5rem; font-size: .75rem; font-weight: 600; }
.footer-full a, .footer-compact a { color: var(--color-primary-text, var(--color-primary)); text-decoration: none; }
.footer-full a:hover, .footer-compact a:hover { text-decoration: underline; }
.footer-bottom { font-size: .72rem; color: var(--cf-text); text-align: center; margin: 0; padding: 0 1.5rem 1.5rem; }
.footer-compact { display: flex; flex-wrap: wrap; gap: .25rem .9rem; padding: .6rem 1.5rem; border-top: 1px solid var(--shell-border, var(--cf-border)); font-size: .72rem; color: var(--shell-text-muted, var(--cf-text)); }
</style>
