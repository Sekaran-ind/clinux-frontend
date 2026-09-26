<script setup>
// The "consistent method" for Staff/Affiliate Practitioner/Affiliate Partner join-link issuance —
// extracted out of TeamSettingsModal.vue (now retired) so Care Team, Affiliate Practitioners, and
// Affiliate Partners in the Data View (Onboarding.vue) can each embed the SAME issue/copy/renew
// panel instead of three near-duplicate blocks (or a separate modal unrelated to the Page View/
// Data View pattern every other Organisation entity already follows). Purely the issuing side —
// redeeming is JoinTokenRedeemForm.vue, deciding is CuboContactConversation.vue; this component
// doesn't touch either.
import { ref, onMounted } from 'vue';
import { useOnboardingStore } from '../../stores/onboarding.js';
import { issueJoinToken, listJoinTokens, renewJoinToken } from '../../data/control/joinTokenAdapter.js';

const props = defineProps({
  linkKind: { type: String, required: true }, // 'staff' | 'affiliate' | 'organization'
  audienceLabel: { type: String, required: true }, // e.g. 'new teammate', 'practitioner', "partner organization's admin"
  redeemedByLabel: { type: String, required: true }, // e.g. ' with their own email and password', ' from their own account'
});

const onboarding = useOnboardingStore();
const tokens = ref([]);
const loading = ref(false);
const issuing = ref(false);
const issueError = ref('');
const renewingToken = ref(null);
const copiedToken = ref('');

async function loadTokens() {
  loading.value = true;
  const { tokens: list, error } = await listJoinTokens();
  loading.value = false;
  if (error) return; // silent — same reasoning TeamSettingsModal's own version had: supplementary, not primary, content
  tokens.value = (list || []).filter((t) => t.link_kind === props.linkKind);
}
onMounted(loadTokens);

async function generateLink() {
  issueError.value = '';
  issuing.value = true;
  const result = await issueJoinToken(props.linkKind);
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

const STATUS_LABELS = { issued: 'Waiting for someone to redeem', redeemed: 'Redeemed — pending your approval in Cübo', approved: 'Approved', rejected: 'Rejected', expired: 'Expired', revoked: 'Revoked' };
function isExpired(t) { return new Date(t.expires_at) <= new Date(); }
function copyToken(token) {
  navigator.clipboard?.writeText(token).then(() => {
    copiedToken.value = token;
    setTimeout(() => { if (copiedToken.value === token) copiedToken.value = ''; }, 2000);
  });
}
</script>

<template>
  <div class="cf-card rounded-2xl p-4">
    <p class="cf-label mb-2">Join Links</p>
    <p v-if="!onboarding.canAcceptJoinToken" class="text-xs" style="color:var(--cf-text)">
      Publish your Hospital Profile before generating join links.
      <span style="opacity:.8">Current stage: {{ onboarding.facilitySetupStageLabel }}</span>
    </p>
    <template v-else>
      <p class="text-xs mb-2" style="color:var(--cf-text)">
        Share a link with a {{ audienceLabel }} — they redeem it{{ redeemedByLabel }}, then you approve or reject the request from Cübo.
      </p>
      <p v-show="issueError" class="text-red-500 text-xs font-medium mb-2">{{ issueError }}</p>
      <div class="flex flex-col gap-2 mb-3" v-show="tokens.length">
        <div v-for="t in tokens" :key="t.token" class="record-card p-2 flex items-center justify-between">
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
      <button class="btn-teal w-full text-sm" :disabled="issuing" @click="generateLink()">
        <i class="fas" :class="issuing ? 'fa-spinner fa-spin' : 'fa-link'"></i> {{ issuing ? 'Generating...' : 'Generate Join Link' }}
      </button>
    </template>
  </div>
</template>
