<script setup>
// Folds TeamChat.vue's real P2P conversation view into Cübo's THREE_PANE middle pane — "It will
// have contacts with whom the current user can select and send messages (using the center pane)"
// (explicit instruction). Same real primitives TeamChat.vue already used (p2pChat.js's
// P2PChatSession/CHAT_STATES, userChats.js's local-only message history, sessionShare.js's
// clinic-profile transfer format) — this is a genuine port of that logic into Cübo's own layout,
// not a new mechanism. TeamChat.vue itself is left as-is (still reachable from ClinicHome.vue);
// duplicated capability, not removed, per this whole effort's "nothing removed, only dispatcher
// changes" rule.
//
// Reactive to its `contact` prop (not a `contact` param on an imperative `open()` method) since
// Cubo.vue's own left-pane Contacts list just sets a ref and lets this component react — connects
// on mount/prop-change, disconnects the OLD session first so switching contacts quickly can't
// leave two P2P sessions open at once.
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useLiveQuery } from '@tanstack/vue-db';
import { useOnboardingStore } from '../../stores/onboarding.js';
import { userChats } from '../../data/collections/userChats.js';
import { P2PChatSession, CHAT_STATES } from '../../data/p2pChat.js';
import { buildProviderProfileSharePayload, decodeProviderProfileShareKey, isSameClinic } from '../../data/sessionShare.js';

const props = defineProps({ contact: { type: Object, required: true } });
const onboarding = useOnboardingStore();

const { data: allChats } = useLiveQuery((q) => q.from({ t: userChats }));

const session = ref(null);
const sessionState = ref(CHAT_STATES.IDLE);
const draft = ref('');

const activeMessages = computed(() => allChats.value.find((c) => c.id === props.contact.id)?.messages || []);

function openConversation(contact) {
  session.value?.disconnect();
  sessionState.value = CHAT_STATES.IDLE;
  session.value = new P2PChatSession(contact.id, contact.name, {
    onStateChange: (s) => { sessionState.value = s; },
  });
  session.value.connect();
}
watch(() => props.contact.id, () => openConversation(props.contact), { immediate: true });
onBeforeUnmount(() => session.value?.disconnect());

function sendDraft() {
  if (!draft.value.trim() || !session.value) return;
  session.value.send(draft.value.trim());
  draft.value = '';
}

// --- Chat-based clinic-profile propagation (SPEC-09 §4), verbatim from TeamChat.vue -----------
const TRANSFER_PREFIX = 'cfx1.';
function isTransferKey(text) {
  return typeof text === 'string' && text.startsWith(TRANSFER_PREFIX);
}
const sharingProfile = ref(false);
async function shareProviderProfile() {
  if (sharingProfile.value || sessionState.value !== 'connected') return;
  sharingProfile.value = true;
  try {
    const record = onboarding.getProviderRecord();
    if (!record) return;
    const { key } = await buildProviderProfileSharePayload(record, onboarding.branding);
    session.value.send(key);
  } finally {
    sharingProfile.value = false;
  }
}
const transferImportState = ref({});
async function importTransferKey(message) {
  transferImportState.value = { ...transferImportState.value, [message.id]: 'importing' };
  const result = await decodeProviderProfileShareKey(message.text);
  if (!result.ok) {
    transferImportState.value = { ...transferImportState.value, [message.id]: 'error' };
    return;
  }
  const payload = result.data;
  if (!isSameClinic(payload)) {
    transferImportState.value = { ...transferImportState.value, [message.id]: 'rejected' };
    return;
  }
  onboarding.importProviderProfile(payload);
  transferImportState.value = { ...transferImportState.value, [message.id]: 'imported' };
}

function formatMsgTime(ts) {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// A function (not a computed) — same reasoning TeamChat.vue's own version had: a plain object
// literal would freeze DISCONNECTED's label at whatever contact happened to be active when this
// evaluated, a real reactivity bug, not a style choice.
function stateLabel(state) {
  switch (state) {
    case CHAT_STATES.SIGNALING:
    case CHAT_STATES.CONNECTING: return 'Connecting…';
    case CHAT_STATES.CONNECTED: return 'Online';
    case CHAT_STATES.DISCONNECTED: return `${props.contact.name || 'They'} left the chat`;
    case CHAT_STATES.FAILED: return 'Not reachable right now';
    default: return '';
  }
}
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col">
    <div class="flex items-center justify-between gap-2 p-3 border-b border-gray-100 dark:border-slate-800 text-xs">
      <div class="min-w-0">
        <strong class="text-gray-800 dark:text-slate-200">{{ contact.name }}</strong>
        <span class="ml-2" :class="sessionState === 'connected' ? 'text-green-600 dark:text-green-400' : 'text-gray-400'">{{ stateLabel(sessionState) }}</span>
      </div>
      <button
        type="button" @click="shareProviderProfile()"
        :disabled="sessionState !== 'connected' || sharingProfile"
        title="Send your clinic's Hospital/Staff profile to this colleague"
        class="shrink-0 border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 rounded px-2 py-1 text-[11px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-gray-700 dark:text-slate-200"
      >
        <i :class="sharingProfile ? 'fas fa-spinner fa-spin' : 'fas fa-share-nodes'"></i> Share Clinic Profile
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 space-y-2">
      <div v-for="m in activeMessages" :key="m.id" class="flex" :class="m.direction === 'sent' ? 'justify-end' : 'justify-start'">
        <!-- A clinic-profile transfer key, sent as a plain chat message but rendered as an
             actionable card instead of raw ciphertext — see importTransferKey's own comment. -->
        <div v-if="isTransferKey(m.text)" class="max-w-[80%] p-2.5 rounded-xl text-xs bg-gray-50 dark:bg-slate-900 border border-dashed border-gray-300 dark:border-slate-700 text-gray-800 dark:text-slate-200">
          <p class="font-semibold mb-1"><i class="fas fa-hospital mr-1" style="color:var(--color-primary)"></i>Clinic profile transfer</p>
          <button v-if="!transferImportState[m.id] || transferImportState[m.id] === 'error'" type="button" @click="importTransferKey(m)"
                  class="text-[11px] px-2 py-1 rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 cursor-pointer">Import</button>
          <span v-else-if="transferImportState[m.id] === 'importing'" class="text-[11px]"><i class="fas fa-spinner fa-spin"></i> Importing…</span>
          <span v-else-if="transferImportState[m.id] === 'imported'" class="text-[11px] text-green-600"><i class="fas fa-check"></i> Imported</span>
          <span v-else-if="transferImportState[m.id] === 'rejected'" class="text-[11px] text-red-600">Different clinic — not imported</span>
          <p v-if="transferImportState[m.id] === 'error'" class="text-[10px] text-red-600 mt-1">Could not read this transfer key.</p>
          <div class="text-[10px] opacity-70 mt-1">{{ formatMsgTime(m.timestamp) }}</div>
        </div>
        <div v-else class="max-w-[70%] px-3 py-1.5 rounded-xl text-xs"
             :class="m.direction === 'sent' ? 'bg-blue-600 text-white' : 'bg-gray-50 dark:bg-slate-900 text-gray-800 dark:text-slate-200'">
          {{ m.text }}
          <div class="text-[10px] opacity-70 mt-0.5">{{ formatMsgTime(m.timestamp) }}</div>
        </div>
      </div>
    </div>

    <div class="flex gap-2 p-3 border-t border-gray-100 dark:border-slate-800 shrink-0 z-10 shadow-[0_-6px_16px_-4px_rgba(0,0,0,0.12)] dark:shadow-[0_-6px_16px_-4px_rgba(0,0,0,0.4)]">
      <input v-model="draft" type="text" placeholder="Message…" :disabled="sessionState !== 'connected'"
             @keydown.enter="sendDraft"
             class="flex-1 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-white" />
      <button :disabled="sessionState !== 'connected' || !draft.trim()" @click="sendDraft"
              class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold transition"><i class="fas fa-paper-plane"></i></button>
    </div>
  </div>
</template>
