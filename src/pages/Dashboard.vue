<script setup>
// The old Onboarding.vue "Review & Publish" screen's real content (entity counts, raw JSON
// preview) — removed as a gate a few passes back (publishIfReady() made the separate publish
// step redundant), but the content itself was worth keeping, just not as a forced step. This is
// that content, given its own real destination: linked from ClinicHome's user menu (explicit
// instruction), not from anywhere inside the onboarding flow itself.
//
// The JSON view is a genuine upgrade over the old fhirPreview, not a straight port: that used to
// show the raw captured QuestionnaireResponse (form-shaped answers); this calls the real
// POST /api/workflow/extract (ComprehensiveLocalExtractor, the same extractor local-extractor.js
// hardened this whole session) and shows the actual extracted FHIR resources — Organization,
// every Location/HealthcareService/Practitioner/PractitionerRole/OrganizationAffiliation/Consent
// this record has produced. That's the real "organisation graph" the GraphDefinition work this
// session was about, not a stand-in for it.
import { ref, computed, onMounted } from 'vue';
import { useOnboardingStore } from '../stores/onboarding.js';
import { activeQuestionnaire, getGroupInstances } from '../data/useSystemForms.js';
import { API_BASE, apiFetch } from '../config.js';

const onboarding = useOnboardingStore();

const counts = computed(() => {
  onboarding.dataVersion; // reactive dependency, same convention every other count in this app uses
  const record = onboarding.getProviderRecord();
  return [
    { label: 'Branches', icon: 'fa-map-marker-alt', value: getGroupInstances(record, 'section_location').length },
    { label: 'Staff', icon: 'fa-user-md', value: getGroupInstances(record, 'section_staff').length },
    { label: 'Services', icon: 'fa-stethoscope', value: getGroupInstances(record, 'section_services_matrix').length },
    { label: 'Office Hours Entries', icon: 'fa-clock', value: getGroupInstances(record, 'section_hours').length },
    { label: 'Consents', icon: 'fa-file-signature', value: getGroupInstances(record, 'section_consent').length },
    { label: 'Affiliate Organizations', icon: 'fa-handshake', value: getGroupInstances(record, 'section_affiliate_organization').length },
  ];
});

const graphLoading = ref(false);
const graphError = ref('');
const resources = ref(null); // FHIR resource[] | null

async function loadGraph() {
  const questionnaireJson = activeQuestionnaire(onboarding.PROVIDER_FORM_ID);
  const responseJson = onboarding.getProviderRecord()?.data;
  if (!questionnaireJson || !responseJson) { graphError.value = 'Save your Hospital Profile first.'; return; }
  graphLoading.value = true;
  graphError.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/api/workflow/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionnaireJson, responseJson }),
    }).then((r) => r.json());
    if (!res.success) { graphError.value = res.error || 'Could not load the organisation graph.'; return; }
    resources.value = res.resources;
  } catch (e) {
    graphError.value = 'Could not reach clinuxflow-api — ' + e.message;
  } finally {
    graphLoading.value = false;
  }
}
onMounted(loadGraph);

// A quick per-type breakdown above the raw JSON — the resource TYPES present, at a glance,
// before scrolling a (potentially long) JSON blob to find them.
const resourceTypeCounts = computed(() => {
  if (!resources.value) return [];
  const counts = new Map();
  resources.value.forEach((r) => counts.set(r.resourceType, (counts.get(r.resourceType) || 0) + 1));
  return [...counts.entries()].map(([type, count]) => ({ type, count }));
});

const graphJson = computed(() => (resources.value ? JSON.stringify(resources.value, null, 2) : ''));
const copied = ref(false);
function copyGraphJson() {
  navigator.clipboard.writeText(graphJson.value).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  });
}
</script>

<template>
  <main style="flex:1;overflow-y:auto">
    <div style="max-width:960px;margin:0 auto;padding:2rem 1.5rem 4rem">
      <span class="section-eyebrow" style="display:block;margin-bottom:.5rem">Dashboard</span>
      <h1 style="font-size:1.75rem;font-weight:800;color:var(--cf-text-strong);margin-bottom:.5rem">Your clinic, at a glance</h1>
      <p style="font-size:.9rem;color:var(--cf-text);margin-bottom:2rem">
        How much of your profile is filled in, and the real data behind it.
      </p>

      <div class="cf-form-field-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:2rem">
        <div v-for="c in counts" :key="c.label" class="cf-card" style="border-radius:1rem;padding:1.25rem;text-align:center">
          <i class="fas" :class="c.icon" style="color:var(--color-primary);font-size:1.1rem;margin-bottom:.5rem"></i>
          <div style="font-size:1.75rem;font-weight:800;color:var(--cf-text-strong);font-family:'Poppins',sans-serif">{{ c.value }}</div>
          <div style="font-size:.75rem;color:var(--cf-text)">{{ c.label }}</div>
        </div>
      </div>

      <div class="cf-card" style="border-radius:1rem;padding:1.25rem">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.875rem">
          <div>
            <h3 style="font-size:.95rem;font-weight:700;color:var(--cf-text-strong)">Organisation Graph</h3>
            <p style="font-size:.75rem;color:var(--cf-text)">The real FHIR resources extracted from your profile — Organization, Locations, Staff, Services and more, exactly as they'd be stored.</p>
          </div>
          <div style="display:flex;gap:.5rem;flex-shrink:0">
            <button class="btn-ghost text-xs px-2 py-1" :disabled="graphLoading" @click="loadGraph()">
              <i class="fas" :class="graphLoading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> Refresh
            </button>
            <button v-if="resources" class="btn-ghost text-xs px-2 py-1" @click="copyGraphJson()">
              <i class="fas" :class="copied ? 'fa-check' : 'fa-copy'"></i> {{ copied ? 'Copied' : 'Copy JSON' }}
            </button>
          </div>
        </div>

        <p v-if="graphError" class="text-xs" style="color:#b91c1c">{{ graphError }}</p>
        <template v-else-if="resources">
          <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.875rem">
            <span v-for="rt in resourceTypeCounts" :key="rt.type" class="tag-chip">{{ rt.type }} ({{ rt.count }})</span>
          </div>
          <pre style="font-family:'JetBrains Mono',monospace;font-size:.72rem;color:var(--color-primary);background:var(--cf-bg);border:1px solid var(--cf-border);border-radius:.5rem;padding:1rem;overflow-x:auto;max-height:440px;white-space:pre-wrap">{{ graphJson }}</pre>
        </template>
      </div>
    </div>
  </main>
</template>
