<script setup>
// Account → Records: the FHIR records this account keeps on this device — modelled on
// cubo-diary's RecordsPanel (documents, FHIR export) and clinux-cubo's journey records:
//   - Consents       the FHIR Consents behind the consent gate (stores/consent.js)
//   - Practitioner   from the HPR journey   (journeys: 'fhir:provider', ClinuxFlowProvider)
//   - Organization   from the HFR journey   (journeys: 'fhir:facility', ClinuxFlowFacility)
// each with its fhir-api validation status and a "check again", plus a FHIR Bundle export.
// Patient records live on the Patients page (they're the clinic's, not this account's).
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { useConsentStore } from '../stores/consent.js';
import { accountRecords } from '../journeys/accountRecords.js';
import { PROFILE, validateResource } from '../journeys/fhir.js';
import { PROVIDER_RESOURCE } from '../journeys/hprJourney.js';
import { facilityResourceKey, loadFacilities } from '../journeys/hfrFacilities.js';
import { PATIENT_FORM_ID } from '../journeys/patientRecord.js';
import { api } from '../journeys/fhirApi.js';
import { listDataRecords } from '../data/useSystemForms.js';
import { CONSENTS } from '../consent/terms.js';
import { provenanceLog } from '../provenance/store.js';
import { revalidatePending } from '../journeys/revalidate.js';

const auth = useAuthStore();
const consent = useConsentStore();
const journeyRecords = ref({});
const open = ref(null);
const checking = ref(null);
const msg = ref('');

// The HPR Practitioner, and one Organization per HFR facility (an account can register many).
const HPR_RESOURCE = { key: PROVIDER_RESOURCE, title: 'Your HPR identity', source: 'HPR journey', profile: PROFILE.provider, link: '/registries/hpr' };
const JOURNEY_RESOURCES = ref([HPR_RESOURCE]);

async function loadJourneyRecords() {
  if (!auth.currentUser?.id) return;
  const r = accountRecords(auth.currentUser.id);
  const facilities = await loadFacilities(r);
  JOURNEY_RESOURCES.value = [
    HPR_RESOURCE,
    ...facilities.map((f) => ({ key: facilityResourceKey(f.trackingId), title: f.facilityName, source: `HFR journey · ${f.facilityId || `draft ${f.trackingId}`}`, profile: PROFILE.facility, link: '/registries/hfr' })),
  ];
  const out = {};
  for (const j of JOURNEY_RESOURCES.value) out[j.key] = await r.get(j.key);
  journeyRecords.value = out;
}
// Anything saved while the FHIR API was unreachable is checked again now, then shown.
onMounted(async () => {
  await loadJourneyRecords();
  if (rows.value.some((r) => r.journeyKey && r.validation?.status === 'pending')) {
    const checked = await revalidatePending(auth.currentUser?.id);
    if (checked) {
      await loadJourneyRecords();
      msg.value = `Checked ${checked} record${checked === 1 ? '' : 's'} that ${checked === 1 ? 'was' : 'were'} waiting for the FHIR API.`;
    }
  }
});

// Digital provenance kept on this device (src/provenance/): newest first. Published to
// clinuxflow-api on the paid plan only.
const provenance = ref([]);
const paid = computed(() => auth.currentUser?.tier === 'paid');
async function loadProvenance() {
  if (!auth.currentUser?.id) return;
  provenance.value = (await provenanceLog(auth.currentUser.id).list()).slice().reverse();
}
onMounted(loadProvenance);
const provTarget = (r) => r.target?.map((t) => t.reference || `${t.identifier?.system?.split('/').pop()} ${t.identifier?.value}`).join(', ');
const provWho = (r) => r.agent?.[0]?.who?.identifier ? `${r.agent[0].who.display || ''} (${r.agent[0].who.identifier.system.includes('doctor.ndhm') ? 'HPR ' : ''}${r.agent[0].who.identifier.value})` : '';
const unpublished = computed(() => provenance.value.filter((e) => !e.published).length);
async function publishNow() {
  const sent = await provenanceLog(auth.currentUser.id).publishPending({ paid: paid.value });
  msg.value = sent ? `Published ${sent} provenance record${sent === 1 ? '' : 's'} to ClinuxFlow.` : 'Nothing was published — the server could not be reached, or there was nothing new.';
  await loadProvenance();
}

const rows = computed(() => [
  ...CONSENTS.filter((t) => consent.records[t.key]).map((t) => ({
    id: `consent:${t.key}`, title: t.title, source: 'Consent gate', resource: consent.records[t.key].resource,
    validation: consent.records[t.key].validation, profile: null,
  })),
  ...JOURNEY_RESOURCES.value.filter((j) => journeyRecords.value[j.key]).map((j) => ({
    id: j.key, title: j.title, source: j.source, resource: journeyRecords.value[j.key].resource,
    validation: journeyRecords.value[j.key].validation, profile: j.profile, journeyKey: j.key,
  })),
]);
const missingJourneys = computed(() => [HPR_RESOURCE, { key: 'hfr', title: 'Your facility', source: 'HFR journey', link: '/registries/hfr' }].filter((j) => (j.key === 'hfr' ? JOURNEY_RESOURCES.value.length === 1 : !journeyRecords.value[j.key])));
const patientCount = computed(() => listDataRecords(PATIENT_FORM_ID).length);

const STATUS = { valid: ['Valid', 'ok'], invalid: ['Incomplete', 'bad'], pending: ['Not checked yet', 'warn'] };
const profileName = (p) => (p ? p.split('/').pop() : 'core FHIR');

async function checkAgain(row) {
  checking.value = row.id;
  msg.value = '';
  if (row.journeyKey) {
    const validation = await validateResource(api, row.resource, row.profile);
    await accountRecords(auth.currentUser.id).set(row.journeyKey, { resource: row.resource, validation });
    await loadJourneyRecords();
    if (validation.status === 'pending') msg.value = 'The FHIR API couldn’t be reached; try again when it’s running.';
  } else {
    await consent.load(auth.currentUser.id); // re-validates pending consents
  }
  checking.value = null;
}

function exportBundle() {
  const bundle = {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: rows.value.map((r) => ({ fullUrl: `urn:uuid:${r.resource.id}`, resource: r.resource })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/fhir+json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `clinuxflow-records-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
  msg.value = `Exported ${bundle.entry.length} resource${bundle.entry.length === 1 ? '' : 's'} as a FHIR Bundle. The file is not encrypted: keep it somewhere safe.`;
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Records</h1>
        <p class="page-subtitle">The FHIR records your account keeps on this device: your consents, and what the HPR and HFR journeys produced, each checked against its ClinuxFlow profile by the FHIR API.</p>
      </div>
      <div class="page-actions">
        <button class="ui-btn ui-btn-primary" :disabled="!rows.length" @click="exportBundle"><i class="fas fa-download"></i> Export as FHIR</button>
      </div>
    </div>

    <p v-if="msg" class="ui-banner" role="status" style="font-size:.82rem">{{ msg }}</p>

    <section class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">FHIR resources</div>
          <div class="panel-sub">Kept on this device for your account only.</div>
        </div>
      </div>
      <div v-if="!rows.length" class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-file-medical"></i></div>
        <div class="empty-state-title">No records yet</div>
        <p class="empty-state-text">Your consents, an HPR ID or an HFR registration show up here as FHIR resources.</p>
      </div>
      <div v-for="r in rows" :key="r.id" class="rec-row">
        <div class="rec-main">
          <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
            <span class="type">{{ r.resource.resourceType }}</span>
            <strong>{{ r.title }}</strong>
            <span class="pill" :class="(STATUS[r.validation?.status] || STATUS.pending)[1]">{{ (STATUS[r.validation?.status] || STATUS.pending)[0] }}</span>
          </div>
          <p class="meta">From the {{ r.source }} · profile {{ profileName(r.profile) }}<span v-if="r.validation?.checkedAt"> · checked {{ new Date(r.validation.checkedAt).toLocaleString() }}</span></p>
          <ul v-if="r.validation?.issues?.length" class="issues"><li v-for="i in r.validation.issues.slice(0, 5)" :key="i">{{ i }}</li></ul>
          <button class="ui-link" style="margin-top:.35rem" @click="open = open === r.id ? null : r.id">{{ open === r.id ? 'Hide' : 'View' }} FHIR</button>
          <pre v-if="open === r.id" class="json">{{ JSON.stringify(r.resource, null, 2) }}</pre>
        </div>
        <button class="ui-btn" style="flex-shrink:0" :disabled="checking === r.id" @click="checkAgain(r)">
          <i class="fas" :class="checking === r.id ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> Check again
        </button>
      </div>
      <div v-for="j in missingJourneys" :key="j.key" class="panel-row">
        <span class="panel-row-muted">{{ j.title }}: not created yet</span>
        <RouterLink :to="j.link" class="ui-link">Run the {{ j.source }} →</RouterLink>
      </div>
    </section>

    <section class="panel" data-testid="provenance">
      <div class="panel-head">
        <div>
          <div class="panel-title">Provenance</div>
          <div class="panel-sub">Who made each change, on whose behalf, and when — a FHIR Provenance for every saved record and registry outcome. {{ paid ? 'Kept on this device and published to ClinuxFlow.' : 'Kept on this device only. The cloud plan also publishes it to ClinuxFlow, so it survives the device.' }}</div>
        </div>
        <button v-if="paid && unpublished" class="ui-btn" style="flex-shrink:0" @click="publishNow"><i class="fas fa-cloud-arrow-up"></i> Publish {{ unpublished }}</button>
      </div>
      <div v-if="!provenance.length" class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-fingerprint"></i></div>
        <div class="empty-state-title">No provenance yet</div>
        <p class="empty-state-text">Saving a form or completing a registry journey records one here.</p>
      </div>
      <div v-for="e in provenance.slice(0, 20)" :key="e.resource.id" class="panel-row" style="align-items:flex-start">
        <div style="min-width:0">
          <div style="font-weight:600">{{ e.resource.activity?.coding?.[0]?.display }} · <span class="type">{{ provTarget(e.resource) }}</span></div>
          <div class="panel-row-muted">{{ provWho(e.resource) }} on behalf of {{ e.resource.agent?.[0]?.onBehalfOf?.display }}<span v-if="e.resource.reason?.[0]?.text"> · {{ e.resource.reason[0].text }}</span></div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="panel-row-muted">{{ new Date(e.resource.recorded).toLocaleString() }}</div>
          <span class="pill" :class="e.published ? 'ok' : 'warn'">{{ e.published ? 'Published' : 'On this device' }}</span>
        </div>
      </div>
      <div v-if="provenance.length > 20" class="panel-row"><span class="panel-row-muted">{{ provenance.length - 20 }} older entries are kept on this device.</span></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">Patient records</div>
          <div class="panel-sub">The clinic’s patients, kept on this device (and your clinic server in Live Server mode).</div>
        </div>
        <RouterLink to="/patient-home" class="ui-btn" style="flex-shrink:0">Open Patients</RouterLink>
      </div>
      <div class="panel-row"><span>{{ patientCount }} patient record{{ patientCount === 1 ? '' : 's' }} on this device</span></div>
    </section>

    <section class="panel" data-testid="documents">
      <div class="panel-head"><div><div class="panel-title">Documents</div><div class="panel-sub">Visit summaries are shared with patients as a PDF with a QR from Checkout.</div></div></div>
      <div class="panel-row">
        <span class="panel-row-muted">Fetching patients’ health records from other hospitals and labs over ABDM needs ClinuxFlow to be registered with ABDM as a health information user; it is planned, not yet available.</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rec-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: .875rem 1rem; border-top: 1px solid var(--shell-border); }
.rec-row:first-of-type { border-top: none; }
.rec-main { min-width: 0; flex: 1; font-size: .85rem; color: var(--shell-text-strong); }
.type { font-family: 'JetBrains Mono', monospace; font-size: .64rem; font-weight: 700; border: 1px solid var(--shell-border); border-radius: .3rem; padding: 0 .35rem; color: var(--color-primary-text); }
.meta { margin: .3rem 0 0; font-size: .74rem; color: var(--shell-text-muted); }
.issues { margin: .4rem 0 0; padding-left: 1.1rem; font-size: .74rem; color: #b45309; list-style: disc; }
.pill { font-size: .66rem; font-weight: 700; padding: .1rem .45rem; border-radius: 99px; }
.pill.ok { background: #dcfce7; color: #166534; }
.pill.bad { background: #fee2e2; color: #991b1b; }
.pill.warn { background: #fef3c7; color: #92400e; }
.json { margin-top: .5rem; font-family: 'JetBrains Mono', monospace; font-size: .7rem; background: var(--shell-bg); border: 1px solid var(--shell-border); border-radius: .5rem; padding: .75rem; max-height: 320px; overflow: auto; white-space: pre-wrap; color: var(--shell-text-strong); }
</style>
