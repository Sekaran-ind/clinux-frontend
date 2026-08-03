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

const props = defineProps({
  questionnaire: { type: Object, default: null },
  record: { type: Object, default: null },
  containerId: { type: String, default: 'lhcFormContainer' },
});

function render() {
  if (props.record) {
    renderWithRecord(props.questionnaire, props.record, props.containerId);
  } else {
    renderBlank(props.questionnaire, props.containerId);
  }
}

onMounted(render);
watch(() => [props.questionnaire, props.record], render);

function extract() {
  return extractResponse(props.containerId);
}

defineExpose({ extract });
</script>

<template>
  <div :id="containerId"></div>
</template>
