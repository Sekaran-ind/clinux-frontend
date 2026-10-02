<script setup>
// The rich part of a registry journey's message in its Cübo thread (sessions.js writes them):
// 'journey-step' — what came with a question (detail, list, map, warning, error, link);
// 'journey-result' — how the run ended. Rendered by Cubo.vue under the message's text bubble.
import MapView from './MapView.vue';

defineProps({
  kind: { type: String, required: true },
  data: { type: Object, default: () => ({}) },
});
</script>

<template>
  <div v-if="kind === 'journey-step'" class="jm jm-step">
    <p v-if="data.error" class="jm-error" role="alert"><i class="fas fa-circle-exclamation"></i> {{ data.error }}</p>
    <p v-if="data.detail" class="jm-detail">{{ data.detail }}</p>
    <p v-if="data.warning" class="jm-warning"><i class="fas fa-triangle-exclamation"></i> {{ data.warning }}</p>
    <ul v-if="data.list?.length" class="jm-list">
      <li v-for="(i, n) in data.list" :key="n"><strong>{{ i.name }}</strong> <span>{{ i.detail }}</span></li>
    </ul>
    <a v-if="data.link" :href="data.link.href" target="_blank" rel="noopener noreferrer" class="jm-link"><i class="fas fa-up-right-from-square"></i> {{ data.link.label }}</a>
    <MapView v-if="data.map" style="margin-top:.4rem" :markers="data.map.markers" :selected="data.map.selected" height="160px" />
  </div>
  <div v-else-if="kind === 'journey-result'" class="jm jm-result" :class="data.ok ? 'ok' : 'bad'" data-testid="journey-chat-result">
    <p v-if="data.text" class="jm-detail" style="margin-top:0">{{ data.text }}</p>
    <dl v-if="data.facts?.length" class="jm-facts">
      <template v-for="[k, v] in data.facts" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
    </dl>
  </div>
</template>

<style scoped>
.jm { max-width: 85%; margin-top: .3rem; font-size: .72rem; line-height: 1.5; }
.jm-detail { margin: .2rem 0 0; color: var(--shell-text-muted, #6b7280); }
.jm-error { margin: 0; color: #b91c1c; }
.jm-warning { margin: .2rem 0 0; color: #b45309; }
.jm-list { margin: .3rem 0 0; padding-left: 1rem; display: flex; flex-direction: column; gap: .1rem; }
.jm-list span { color: var(--shell-text-muted, #6b7280); }
.jm-link { display: inline-flex; align-items: center; gap: .35rem; margin-top: .3rem; color: var(--color-primary-text, #0f766e); font-weight: 600; }
.jm-result { border-left: 3px solid; padding: .1rem 0 .1rem .6rem; }
.jm-result.ok { border-color: #16a34a; }
.jm-result.bad { border-color: #dc2626; }
.jm-facts { margin: .2rem 0 0; display: grid; grid-template-columns: max-content 1fr; gap: .1rem .75rem; }
.jm-facts dt { color: var(--shell-text-muted, #6b7280); }
.jm-facts dd { margin: 0; font-family: 'JetBrains Mono', monospace; overflow-wrap: anywhere; }
</style>
