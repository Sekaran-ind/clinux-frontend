<script setup>
// Bridge component for LHC-Forms (lforms npm package — an Angular Elements custom element +
// Zone.js runtime, previously loaded from lforms-static.nlm.nih.gov via CDN). LForms is an
// imperative, non-Vue API (addFormToPage/mergeFHIRDataIntoLForms/getFormFHIRData against a
// container id) — rather than fight that, this component wraps it exactly like clinixflow's
// system-forms.js already did, just called from onMounted/watch instead of Alpine's x-init.
//
// LForms only properly tracks one "live" form instance per page for extraction purposes — do
// not render two simultaneous LhcFormHost instances into different containers at once (ported
// rule from system-forms.js's renderBlank/renderWithRecord comments).
import { onMounted, watch } from 'vue';
import { renderBlank, renderWithRecord, extractResponse } from '../data/useSystemForms.js';
import { useSlotFillHighlightsStore } from '../stores/slotFillHighlights.js';

const props = defineProps({
  questionnaire: { type: Object, default: null },
  record: { type: Object, default: null },
  containerId: { type: String, default: 'lhcFormContainer' },
  // linkIds Cubo's slot-fill (NLP or /shortcut) just wrote — see slotFillHighlights.js. Kept as
  // its own watcher below, separate from the render-triggering one above, so a highlight change
  // never forces a full LForms re-render.
  highlightLinkIds: { type: Array, default: () => [] },
});

const slotFillHighlights = useSlotFillHighlightsStore();
const HIGHLIGHT_TIMEOUT_MS = 30000;

// LForms gives each leaf field a stable id of `${linkId}/1/1` (confirmed via live testing) — no
// need to scope the querySelector to this component's own container since only one LForms
// instance is ever "live" on a page at a time (this file's own top-of-file rule).
function applyHighlight(linkId) {
  const el = document.getElementById(`${linkId}/1/1`);
  if (!el) return;
  el.classList.add('slotfill-highlight');
  const clear = () => {
    el.classList.remove('slotfill-highlight');
    slotFillHighlights.clear(linkId);
  };
  const timer = setTimeout(clear, HIGHLIGHT_TIMEOUT_MS);
  // Implicit confirm — the user interacting with the field at all counts as "reviewed", matching
  // how the rest of this app has no separate accept/reject affordance anywhere else.
  el.addEventListener('focus', () => { clearTimeout(timer); clear(); }, { once: true });
}

function applyHighlights() {
  (props.highlightLinkIds || []).forEach((linkId) => applyHighlight(linkId));
}

// LForms (Angular Elements + Zone.js) does its own DOM insertion outside Vue's render cycle and
// exposes no "render complete" callback/promise — a short delay after calling into it is what
// the rest of this app already relies on (matches the fixed short waits this same LForms
// integration needed during live testing elsewhere). Covers both a fresh mount that already has
// pending highlights (e.g. a field got filled while its drawer was closed, then reopened) and a
// record/questionnaire prop change that re-renders the same instance.
function render() {
  if (props.record) {
    renderWithRecord(props.questionnaire, props.record, props.containerId);
  } else {
    renderBlank(props.questionnaire, props.containerId);
  }
  setTimeout(applyHighlights, 50);
}

onMounted(render);
watch(() => [props.questionnaire, props.record], render);

// A NEW fill arriving while this exact form instance is already sitting on screen (no
// render()/re-mount involved) — the DOM node already exists, so no delay needed here.
watch(() => props.highlightLinkIds, applyHighlights, { flush: 'post' });

function extract() {
  return extractResponse(props.containerId);
}

defineExpose({ extract });
</script>

<template>
  <div :id="containerId"></div>
</template>
