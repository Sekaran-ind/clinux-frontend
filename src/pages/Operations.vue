<script setup>
// Operations — modelled on the Swastik ABDM Connector's Operations section:
//   /operations/activity           Activity log: privacy-significant state changes (metadata only)
//   /operations/abdm-transactions  every ABDM call made through clinuxflow-abdm-gateway
//   /operations/access             your role + permissions, and what each role can do
// All read clinuxflow-api's routes/operations.js, which scopes by role: activity:clinic sees the
// whole clinic, everyone else only their own rows. Not a paid-tier feature.
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { fetchAccess, fetchAuditEvents, fetchAbdmTransactions } from '../data/operations.js';

const route = useRoute();
const section = computed(() => route.params.section || 'activity');
const PAGE = 50;

// D1's datetime('now') is UTC without a zone marker.
const parseAt = (at) => new Date(/[zZ+]/.test(at.slice(10)) ? at : at.replace(' ', 'T') + 'Z');
function ago(at) {
  const s = Math.max(1, Math.round((Date.now() - parseAt(at).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `about ${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
const exact = (at) => parseAt(at).toLocaleString();
const short = (id) => (id && id.length > 14 ? `${id.slice(0, 12)}…` : id);

// ── Activity log / ABDM transactions: one loader, cursor paging on created_at ──
const rows = ref([]);
const scope = ref('');
const loading = ref(false);
const error = ref('');
const more = ref(false);

async function load({ append = false } = {}) {
  loading.value = true;
  error.value = '';
  const before = append ? rows.value.at(-1)?.at : undefined;
  const res = section.value === 'abdm-transactions'
    ? await fetchAbdmTransactions({ limit: PAGE, before })
    : await fetchAuditEvents({ limit: PAGE, before });
  loading.value = false;
  if (res.error) { error.value = res.error; return; }
  const list = res.events || res.transactions || [];
  rows.value = append ? [...rows.value, ...list] : list;
  scope.value = res.scope;
  more.value = list.length === PAGE;
}

// ── Access & roles ──
const access = ref(null);
async function loadAccess() {
  loading.value = true;
  error.value = '';
  const res = await fetchAccess();
  loading.value = false;
  if (res.error) { error.value = res.error; return; }
  access.value = res;
}
const roleOrder = ['admin_and_health_professional', 'hospital_admin', 'health_professional'];
const permissionGroups = computed(() => {
  const groups = {};
  for (const p of access.value?.catalog.permissions || []) (groups[p.group] ||= []).push(p);
  return Object.entries(groups);
});
const has = (role, id) => access.value?.catalog.matrix[role]?.includes(id);

watch(section, (s) => {
  rows.value = [];
  if (s === 'access') loadAccess(); else load();
}, { immediate: true });

const TITLES = {
  activity: { title: 'Activity log', sub: 'Privacy-significant state changes: sign-ins, account changes, join links, and what the registry journeys completed. Metadata carries identifiers and status only — never payloads.' },
  'abdm-transactions': { title: 'ABDM transactions', sub: 'Every call this clinic made to ABDM through the ClinuxFlow gateway. This is the log to open when a registration stalls and you need to know which side went quiet.' },
  access: { title: 'Access & roles', sub: 'Your role decides which workspace screens you see and whose activity you can view.' },
};
const SERVICE = { hpr: 'HPR', hfr: 'HFR', abha: 'ABHA', uhi: 'UHI' };
</script>

<template>
  <div class="page page-wide">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ TITLES[section]?.title }}</h1>
        <p class="page-subtitle">{{ TITLES[section]?.sub }}</p>
      </div>
      <div v-if="section !== 'access'" class="page-actions">
        <span v-if="scope" class="scope-pill" :title="scope === 'clinic' ? 'Your role can see everyone’s activity in this clinic' : 'Your role sees only what you did yourself'">
          <i class="fas" :class="scope === 'clinic' ? 'fa-building' : 'fa-user'"></i> {{ scope === 'clinic' ? 'Whole clinic' : 'Only your activity' }}
        </span>
        <button class="ui-btn" :disabled="loading" @click="load()"><i class="fas" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> Refresh</button>
      </div>
    </div>

    <p v-if="error" class="ui-banner" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c"><i class="fas fa-circle-exclamation"></i> {{ error }}</p>

    <!-- ── Activity log ── -->
    <section v-if="section === 'activity'" class="panel">
      <div v-if="!loading && !rows.length && !error" class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-wave-square"></i></div>
        <div class="empty-state-title">No activity yet</div>
        <p class="empty-state-text">Sign-ins, account changes, join links and completed registry journeys appear here.</p>
      </div>
      <div v-else class="table-wrap">
        <table class="ops-table">
          <thead><tr><th>Action</th><th>Object</th><th>Actor</th><th>When</th></tr></thead>
          <tbody>
            <tr v-for="e in rows" :key="e.id">
              <td><div class="cell-strong">{{ e.label }}</div><div class="cell-code">{{ e.action }}</div></td>
              <td>
                <span v-if="e.objectType || e.objectId" class="cell-code" :title="e.objectId || ''">{{ e.objectType }}{{ e.objectId ? ' ' + short(e.objectId) : '' }}</span>
                <span v-else class="cell-muted">—</span>
                <div v-if="e.metadata" class="cell-meta">
                  <span v-for="(v, k) in e.metadata" :key="k">{{ k }}: <code>{{ v }}</code></span>
                </div>
              </td>
              <td class="cell-actor">{{ e.actor }}</td>
              <td class="cell-when" :title="exact(e.at)">{{ ago(e.at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="more" class="panel-row" style="justify-content:center"><button class="ui-btn" :disabled="loading" @click="load({ append: true })">Load older</button></div>
    </section>

    <!-- ── ABDM transactions ── -->
    <section v-else-if="section === 'abdm-transactions'" class="panel">
      <div v-if="!loading && !rows.length && !error" class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-wave-square"></i></div>
        <div class="empty-state-title">No ABDM traffic yet</div>
        <p class="empty-state-text">Calls appear here as soon as a registry journey (HPR, HFR, ABHA) reaches the gateway.</p>
      </div>
      <div v-else class="table-wrap">
        <table class="ops-table">
          <thead><tr><th>Operation</th><th>Result</th><th>ABDM REQUEST-ID</th><th>Actor</th><th>Time</th><th>When</th></tr></thead>
          <tbody>
            <tr v-for="t in rows" :key="t.id">
              <td>
                <span class="svc">{{ SERVICE[t.service] || t.service }}</span>
                <span class="cell-code">{{ t.operation }}</span>
              </td>
              <td>
                <span class="status" :class="t.ok ? 'ok' : 'bad'">{{ t.ok ? 'OK' : 'Failed' }} · {{ t.httpStatus }}</span>
                <div v-if="t.abdmStatus" class="cell-muted">ABDM {{ t.abdmStatus }}</div>
                <div v-if="t.error" class="cell-error" :title="t.error">{{ t.error }}</div>
              </td>
              <td><span v-if="t.abdmRequestId" class="cell-code" :title="t.abdmRequestId">{{ short(t.abdmRequestId) }}</span><span v-else class="cell-muted">—</span></td>
              <td class="cell-actor">{{ t.actor || '—' }}</td>
              <td class="cell-muted">{{ t.durationMs }} ms</td>
              <td class="cell-when" :title="exact(t.at)">{{ ago(t.at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="more" class="panel-row" style="justify-content:center"><button class="ui-btn" :disabled="loading" @click="load({ append: true })">Load older</button></div>
    </section>

    <!-- ── Access & roles ── -->
    <template v-else-if="section === 'access' && access">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Your access</div></div>
        <div class="panel-body">
          <div class="ui-banner" style="margin-bottom:1rem">
            <div class="ui-banner-icon"><i class="fas fa-circle-info"></i></div>
            <div class="ui-banner-text">Your role is <strong style="color:var(--shell-text-strong)">{{ access.roleLabel }}</strong>{{ access.clinicName ? ` in ${access.clinicName}` : '' }}. It decides which workspace screens you see and whose activity you can view.</div>
          </div>
          <div class="panel-sub" style="font-weight:600;color:var(--shell-text-strong);margin-bottom:.5rem">Permissions</div>
          <div class="chips">
            <span v-for="id in access.permissions" :key="id" class="chip">{{ id }}</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">What each role can do</div>
            <div class="panel-sub">“Server” means clinuxflow-api checks it on every request; “Workspace” means only the workspace’s screens apply it today.</div>
          </div>
        </div>
        <div v-for="role in roleOrder" :key="role" class="panel-row" style="justify-content:flex-start">
          <span class="role-pill" :class="{ mine: role === access.role }">{{ access.catalog.roles[role].label }}</span>
          <span class="panel-row-muted" style="font-size:.8rem">{{ access.catalog.roles[role].summary }}</span>
        </div>
        <div class="table-wrap" style="border-top:1px solid var(--shell-border)">
          <table class="ops-table matrix">
            <thead>
              <tr><th>Permission</th><th v-for="role in roleOrder" :key="role" :class="{ mine: role === access.role }">{{ access.catalog.roles[role].label }}</th><th>Enforced by</th></tr>
            </thead>
            <tbody>
              <template v-for="[group, perms] in permissionGroups" :key="group">
                <tr class="group-row"><td :colspan="roleOrder.length + 2">{{ group }}</td></tr>
                <tr v-for="p in perms" :key="p.id">
                  <td><div class="cell-strong">{{ p.label }}</div><div class="cell-code">{{ p.id }}</div></td>
                  <td v-for="role in roleOrder" :key="role" class="tick" :class="{ mine: role === access.role }">
                    <i v-if="has(role, p.id)" class="fas fa-check" style="color:#16a34a" aria-label="yes"></i>
                    <span v-else class="cell-muted" aria-label="no">—</span>
                  </td>
                  <td><span class="enforced" :class="p.enforced">{{ p.enforced === 'server' ? 'Server' : 'Workspace' }}</span></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <p v-if="loading && !rows.length && section !== 'access'" class="panel-row-muted" style="margin-top:1rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p>
  </div>
</template>

<style scoped>
.table-wrap { overflow-x: auto; }
.ops-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
.ops-table th { text-align: left; font-size: .64rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--shell-text-muted); padding: .6rem 1rem; border-bottom: 1px solid var(--shell-border); white-space: nowrap; }
.ops-table td { padding: .7rem 1rem; border-bottom: 1px solid var(--shell-border); vertical-align: top; color: var(--shell-text-strong); }
.ops-table tbody tr:last-child td { border-bottom: none; }
.cell-strong { font-weight: 600; }
.cell-code { font-family: 'JetBrains Mono', monospace; font-size: .7rem; color: var(--shell-text-muted); }
.cell-muted { color: var(--shell-text-muted); font-size: .75rem; }
.cell-actor { font-family: 'JetBrains Mono', monospace; font-size: .72rem; color: var(--shell-text); word-break: break-all; }
.cell-when { white-space: nowrap; color: var(--shell-text-muted); }
.cell-meta { display: flex; flex-wrap: wrap; gap: .2rem .6rem; margin-top: .25rem; font-size: .68rem; color: var(--shell-text-muted); }
.cell-meta code { font-family: 'JetBrains Mono', monospace; color: var(--shell-text); }
.cell-error { font-size: .72rem; color: #b91c1c; margin-top: .2rem; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svc { display: inline-block; font-family: 'JetBrains Mono', monospace; font-size: .6rem; font-weight: 700; border: 1px solid var(--shell-border); border-radius: .3rem; padding: 0 .3rem; margin-right: .4rem; color: var(--color-primary-text); }
.status { font-size: .72rem; font-weight: 600; padding: .1rem .45rem; border-radius: 99px; white-space: nowrap; }
.status.ok { background: #dcfce7; color: #166534; }
.status.bad { background: #fee2e2; color: #991b1b; }
.scope-pill { display: inline-flex; align-items: center; gap: .4rem; font-size: .75rem; font-weight: 600; color: var(--shell-text); border: 1px solid var(--shell-border); border-radius: 99px; padding: .3rem .7rem; background: var(--shell-surface); }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip { font-family: 'JetBrains Mono', monospace; font-size: .7rem; padding: .2rem .5rem; border: 1px solid var(--shell-border); border-radius: .35rem; background: var(--shell-bg); color: var(--shell-text-strong); }
.role-pill { font-size: .72rem; font-weight: 600; padding: .15rem .6rem; border-radius: 99px; border: 1px solid var(--shell-border); margin-right: .75rem; white-space: nowrap; color: var(--shell-text); }
.role-pill.mine { background: var(--color-primary-soft); border-color: var(--color-primary-ring); color: var(--color-primary-text); }
.matrix th.mine, .matrix td.mine { background: var(--color-primary-soft); }
.matrix .tick { text-align: center; }
.matrix th:not(:first-child):not(:last-child) { text-align: center; }
.group-row td { font-size: .64rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--shell-text-muted); background: var(--shell-bg); padding: .45rem 1rem; }
.enforced { font-size: .68rem; font-weight: 600; padding: .1rem .45rem; border-radius: .3rem; }
.enforced.server { background: #dcfce7; color: #166534; }
.enforced.workspace { background: var(--shell-hover); color: var(--shell-text-muted); }
:global(.dark) .status.ok, :global(.dark) .enforced.server { background: rgba(22, 163, 74, .18); color: #86efac; }
:global(.dark) .status.bad { background: rgba(220, 38, 38, .18); color: #fca5a5; }
</style>
