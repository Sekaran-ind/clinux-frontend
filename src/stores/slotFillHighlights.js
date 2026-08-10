import { defineStore } from 'pinia';
import { ref } from 'vue';

// The shared surface between Cubo.vue (writer — doesn't own any rendered form) and each page's
// <LhcFormHost> (reader — does own the rendered DOM) for the "please confirm" visual cue on a
// field formSlotEngine.js's applyFills() (NLP path or the /shortcut path) just wrote. See
// clinux-cubo-slot-fill-highlight memory note — the recognition/fill mechanism itself already
// shipped; this is the remaining visual piece.
export const useSlotFillHighlightsStore = defineStore('slotFillHighlights', () => {
  const recentlyFilled = ref([]); // [{ linkId, timestamp }]

  function markFilled(linkIds) {
    const now = Date.now();
    linkIds.forEach((linkId) => {
      const existing = recentlyFilled.value.find((f) => f.linkId === linkId);
      if (existing) existing.timestamp = now;
      else recentlyFilled.value.push({ linkId, timestamp: now });
    });
  }

  function clear(linkId) {
    recentlyFilled.value = recentlyFilled.value.filter((f) => f.linkId !== linkId);
  }

  return { recentlyFilled, markFilled, clear };
});
