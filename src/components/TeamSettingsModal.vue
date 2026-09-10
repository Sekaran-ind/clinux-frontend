<script setup>
// docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md — replaces the old two-flow design (Staff: admin
// invents+shares a password via POST /api/auth/invite; Affiliates: admin looks the practitioner
// up by email via POST /api/facility/affiliates, 404s if they have no account yet) with ONE
// consistent, self-service, token-based mechanism for both relationship types. The joining person
// now sets their OWN password (or, for an affiliate, just redeems with their existing account) —
// no password ever passes through an admin's hands again.
import { ref, watch, reactive } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { useOnboardingStore } from '../stores/onboarding.js';
import { checkAffiliatePractitionerConformance } from '../data/control/affiliatePractitionerConformance.js';
import { issueJoinToken, listJoinTokens, renewJoinToken } from '../data/control/joinTokenAdapter.js';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);
const auth = useAuthStore();
const onboarding = useOnboardingStore();

const activeTab = ref('staff'); // 'staff' | 'affiliates'

const accounts = ref([]);
const loading = ref(false);
const loadError = ref('');

async function loadTeam() {
  loading.value = true;
  loadError.value = '';
  const { accounts: list, error } = await auth.fetchTeam();
  loading.value = false;
  if (error) { loadError.value = error; return; }
  accounts.value = list;
}

// Affiliates: an EXISTING independent practitioner's own account, linked here as a visiting
// consultant -- deliberately a SEPARATE relationship from staff (never a login on THIS clinic's
// own subscription). See clinuxflow-api's GET/DELETE /api/facility/affiliates and migrations/0005.
const affiliates = ref([]);
const affiliatesLoading = ref(false);
const affiliatesLoadError = ref('');

async function loadAffiliates() {
  affiliatesLoading.value = true;
  affiliatesLoadError.value = '';
  const { affiliates: list, error } = await auth.fetchAffiliates();
  affiliatesLoading.value = false;
  if (error) { affiliatesLoadError.value = error; return; }
  affiliates.value = list;
}

async function removeAffiliate(accountId) {
  await auth.revokeAffiliate(accountId);
  await loadAffiliates();
}

// --- Join Links (SPEC-26 §4/§8/§9) — one panel, reused for both tabs via linkKind ---------------
const tokens = reactive({ staff: [], affiliate: [] });
const tokensLoading = ref(false);
const issuing = ref(false);
const issueError = ref('');
const renewingToken = ref(null);

async function loadTokens() {
  tokensLoading.value = true;
  const { tokens: list, error } = await listJoinTokens();
  tokensLoading.value = false;
  if (error) return; // silent — the member list above is the primary content, this is supplementary
  tokens.staff = (list || []).filter((t) => t.link_kind === 'staff');
  tokens.affiliate = (list || []).filter((t) => t.link_kind === 'affiliate');
}

async function generateLink(linkKind) {
  issueError.value = '';
  issuing.value = true;
  const result = await issueJoinToken(linkKind);
  issuing.value = false;
  if (result.error) { issueError.value = result.error; return; }
  await loadTokens();
}

async function renewLink(token) {
  renewingToken.value = token;
  await renewJoinToken(token);
  renewingToken.value = null;
  await loadTokens();
}

const copiedToken = ref('');
function copyToken(token) {
  navigator.clipboard?.writeText(token).then(() => {
    copiedToken.value = token;
    setTimeout(() => { if (copiedToken.value === token) copiedToken.value = ''; }, 2000);
  });
}

function isExpired(token) {
  return new Date(token.expires_at) <= new Date();
}
const STATUS_LABELS = { issued: 'Waiting for someone to redeem', redeemed: 'Redeemed — pending your approval in Cübo', approved: 'Approved', rejected: 'Rejected', expired: 'Expired', revoked: 'Revoked' };

// SPEC-24 §7 step 6 — the same on-demand "FHIR Conformance" check Onboarding.vue's Facility/
// Provider cards already have, adapted for an entity with no drawer/save action of its own (see
// affiliatePractitionerConformance.js's own header): this whole tab already captures everything
// needed, so "Check" is the only new control this entity needs.
const conformanceLoading = ref(false);
const conformanceResult = ref(null); // { hasOrganization, affiliates, nextActions } | { error } | null
async function checkAffiliateConformance() {
  conformanceLoading.value = true;
  conformanceResult.value = await checkAffiliatePractitionerConformance();
  conformanceLoading.value = false;
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    activeTab.value = 'staff';
    issueError.value = '';
    conformanceResult.value = null;
    loadTeam();
    loadAffiliates();
    loadTokens();
  }
});
</script>

<template>
  <div class="modal-backdrop" v-show="open" @click.self="emit('close')">
    <div class="modal-box" style="max-width:560px">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-lg font-bold" style="color:var(--cf-text-strong)"><i class="fas fa-users mr-2" style="color:var(--color-primary)"></i>Team</h3>
          <p class="text-xs" style="color:var(--cf-text)">Everyone with a login on this clinic — up to 4 accounts share one subscription.</p>
        </div>
        <button @click="emit('close')" style="background:transparent;border:none;cursor:pointer;color:var(--cf-text);font-size:1.1rem"><i class="fas fa-times"></i></button>
      </div>

      <!-- Staff (a real login/seat on THIS clinic) vs. Affiliates (an independent practitioner's
           own account, just referenced) are deliberately two different relationships, but now
           share the SAME join-link mechanism below, not two different forms. -->
      <div class="flex gap-1 mb-4" style="border-bottom:1px solid var(--cf-border)">
        <button class="text-xs font-bold px-3 py-2" :class="activeTab === 'staff' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="activeTab = 'staff'">Staff</button>
        <button class="text-xs font-bold px-3 py-2" :class="activeTab === 'affiliates' ? 'text-(--color-primary) border-b-2 border-(--color-primary)' : 'text-gray-500'" @click="activeTab = 'affiliates'">Affiliates</button>
      </div>

      <template v-if="activeTab === 'staff'">
        <div v-if="loading" class="text-sm text-center py-4" style="color:var(--cf-text)"><i class="fas fa-spinner fa-spin mr-2"></i>Loading team...</div>
        <p v-else-if="loadError" class="text-sm text-center py-2" style="color:#b91c1c">{{ loadError }}</p>
        <div v-else class="flex flex-col gap-2 mb-5">
          <div v-for="a in accounts" :key="a.id" class="record-card flex items-center justify-between p-2.5">
            <div>
              <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ a.adminName || a.email }}</span>
              <span v-if="a.designation" class="text-xs ml-2" style="color:var(--cf-text)">{{ a.designation }}</span>
              <span v-if="a.status === 'pending'" class="text-xs ml-2" style="color:#b45309">(pending approval)</span>
              <span v-else-if="a.status === 'rejected'" class="text-xs ml-2" style="color:#b91c1c">(rejected)</span>
              <div class="text-xs" style="color:var(--cf-text)">{{ a.email }}</div>
            </div>
          </div>
        </div>
        <p v-show="!loading && accounts.length >= 4" class="text-xs text-center mb-3" style="color:var(--cf-text)">
          This clinic already has the maximum of 4 team accounts.
        </p>
      </template>

      <template v-else>
        <div v-if="affiliatesLoading" class="text-sm text-center py-4" style="color:var(--cf-text)"><i class="fas fa-spinner fa-spin mr-2"></i>Loading affiliates...</div>
        <p v-else-if="affiliatesLoadError" class="text-sm text-center py-2" style="color:#b91c1c">{{ affiliatesLoadError }}</p>
        <div v-else class="flex flex-col gap-2 mb-5">
          <div v-show="affiliates.length === 0" class="text-xs text-center py-2" style="color:var(--cf-text)">No affiliates linked yet.</div>
          <div v-for="a in affiliates" :key="a.accountId" class="record-card flex items-center justify-between p-2.5">
            <div>
              <span class="text-sm font-semibold" style="color:var(--cf-text-strong)">{{ a.adminName || a.email }}</span>
              <span v-if="a.role" class="text-xs ml-2" style="color:var(--cf-text)">{{ a.role }}</span>
              <div class="text-xs" style="color:var(--cf-text)">{{ a.email }}</div>
            </div>
            <button class="btn-ghost text-xs px-2 py-1" @click="removeAffiliate(a.accountId)"><i class="fas fa-times"></i> Remove</button>
          </div>
        </div>

        <!-- SPEC-24 §7 step 6 — real ClinuxFlowAffiliatePractitionerRole conformance, on demand
             (same tone as Onboarding.vue's own Facility/Provider panels: most clinics won't see
             every affiliate go green, e.g. before a Hospital Profile is saved, and that's fine). -->
        <div v-if="affiliates.length" class="cf-card rounded-2xl p-4 mb-4">
          <div class="flex items-center justify-between mb-2">
            <p class="cf-label mb-0">FHIR Affiliate Conformance <span style="font-weight:400">(ClinuxFlowAffiliatePractitionerRole)</span></p>
            <button class="btn-ghost text-xs px-2 py-1" :disabled="conformanceLoading" @click="checkAffiliateConformance()">
              <i class="fas" :class="conformanceLoading ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> Check
            </button>
          </div>
          <p v-if="!conformanceResult" class="text-xs" style="color:var(--cf-text)">
            Checks each linked affiliate as a real FHIR PractitionerRole against this facility's own Organization.
          </p>
          <p v-else-if="conformanceResult.error" class="text-xs" style="color:#b91c1c">{{ conformanceResult.error }}</p>
          <template v-else>
            <p v-if="!conformanceResult.hasOrganization" class="text-xs mb-2" style="color:var(--cf-text)">
              No Hospital Profile saved yet — every affiliate below will show a missing Organization link until one is.
            </p>
            <div class="flex flex-col gap-2" style="max-height:220px;overflow-y:auto">
              <div v-for="a in conformanceResult.affiliates" :key="a.role.id" class="record-card p-2">
                <p class="text-xs font-semibold mb-1" :style="a.valid ? 'color:var(--color-primary)' : 'color:var(--cf-text-strong)'">
                  <i class="fas" :class="a.valid ? 'fa-circle-check' : 'fa-circle-info'"></i>
                  {{ a.affiliate.adminName || a.affiliate.email }}
                </p>
                <ul style="font-size:.7rem;color:var(--cf-text);padding-left:1rem">
                  <li v-for="e in a.errors" :key="e.path">{{ e.message }}</li>
                </ul>
              </div>
            </div>
          </template>
        </div>
      </template>

      <!-- Join Links — SPEC-26 §4/§9. Gated on the SAME facilitySetupMachine badge Onboarding.vue's
           Review card shows: a token can't be generated for an unpublished clinic. -->
      <div class="cf-card rounded-2xl p-4">
        <p class="cf-label mb-2">Join Links</p>
        <p v-if="!onboarding.canAcceptJoinToken" class="text-xs" style="color:var(--cf-text)">
          Publish your clinic page (Onboarding &rarr; Review &amp; Publish) before generating {{ activeTab === 'staff' ? 'staff' : 'affiliate' }} join links.
          <span style="opacity:.8">Current stage: {{ onboarding.facilitySetupStageLabel }}</span>
        </p>
        <template v-else>
          <p class="text-xs mb-2" style="color:var(--cf-text)">
            Share a link with a {{ activeTab === 'staff' ? 'new teammate' : 'practitioner' }} — they redeem it{{ activeTab === 'staff' ? ' with their own email and password' : ' from their own account' }}, then you approve or reject the request from Cübo.
          </p>
          <p v-show="issueError" class="text-red-500 text-xs font-medium mb-2">{{ issueError }}</p>
          <div class="flex flex-col gap-2 mb-3" v-show="tokens[activeTab === 'staff' ? 'staff' : 'affiliate'].length">
            <div v-for="t in tokens[activeTab === 'staff' ? 'staff' : 'affiliate']" :key="t.token" class="record-card p-2 flex items-center justify-between">
              <div>
                <span class="text-sm font-mono font-semibold" style="color:var(--cf-text-strong)">{{ t.token }}</span>
                <div class="text-xs" style="color:var(--cf-text)">
                  {{ STATUS_LABELS[t.status] || t.status }}
                  <span v-if="t.status === 'issued'">&middot; {{ isExpired(t) ? 'expired' : `expires ${new Date(t.expires_at).toLocaleString()}` }}</span>
                </div>
              </div>
              <div class="flex gap-1.5 shrink-0">
                <button v-if="t.status === 'issued'" class="btn-ghost text-xs px-2 py-1" @click="copyToken(t.token)">
                  <i class="fas" :class="copiedToken === t.token ? 'fa-check' : 'fa-copy'"></i> {{ copiedToken === t.token ? 'Copied' : 'Copy' }}
                </button>
                <button v-if="t.status === 'issued'" class="btn-ghost text-xs px-2 py-1" :disabled="renewingToken === t.token" @click="renewLink(t.token)">
                  <i class="fas" :class="renewingToken === t.token ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> Renew
                </button>
              </div>
            </div>
          </div>
          <button class="btn-teal w-full text-sm" :disabled="issuing" @click="generateLink(activeTab === 'staff' ? 'staff' : 'affiliate')">
            <i class="fas" :class="issuing ? 'fa-spinner fa-spin' : 'fa-link'"></i> {{ issuing ? 'Generating...' : 'Generate Join Link' }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
