<script setup>
// WhatsApp-style direct messaging between staff/affiliates — true P2P (see p2pChat.js), works
// identically regardless of connectivity tier since the signaling relay it depends on isn't
// tier-gated. Deliberately a separate panel rather than folded into Cübo.vue's own thread UI —
// Cübo already carries real complexity (slot-fill highlighting, pacer/throttle, slash shortcuts,
// encounter-thread routing) that this shouldn't risk destabilizing; this mirrors its
// thread-list-plus-conversation visual language instead, so it feels like the same family of
// panel without touching that component at all.
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useLiveQuery } from '@tanstack/vue-db';
import { useAuthStore } from '../stores/auth.js';
import { useOnboardingStore } from '../stores/onboarding.js';
import { userChats, listConversations } from '../data/collections/userChats.js';
import { P2PChatSession, CHAT_STATES } from '../data/p2pChat.js';
import { buildProviderProfileSharePayload, decodeProviderProfileShareKey, isSameClinic } from '../data/sessionShare.js';

const onboarding = useOnboardingStore();

const props = defineProps({ show: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const auth = useAuthStore();

const contacts = ref([]);
const contactsLoaded = ref(false);
async function loadContacts() {
  const [teamRes, affiliatesRes] = await Promise.all([auth.fetchTeam(), auth.fetchAffiliates()]);
  const team = (teamRes.accounts || []).map((a) => ({ id: a.id, name: a.adminName || a.email, kind: 'staff' }));
  const affiliates = (affiliatesRes.affiliates || []).map((a) => ({ id: a.accountId, name: a.practitionerName || a.practitionerEmail, kind: 'affiliate' }));
  contacts.value = [...team, ...affiliates].filter((c) => c.id !== auth.currentUser?.id);
  contactsLoaded.value = true;
}

// Loads on open, not on first click inside the panel — the panel should be ready to use the
// moment it's visible, not require an incidental click first.
watch(() => props.show, (visible) => {
  if (visible && !contactsLoaded.value) loadContacts();
});

const { data: allChats } = useLiveQuery((q) => q.from({ t: userChats }));

// Sorted contacts, most-recently-messaged first, each with its last message preview if one
// exists — the WhatsApp-style bit of "WhatsApp-style messaging". listConversations() already
// does the id-keyed lookup + sort; this just joins it back onto the real contact list (team +
// affiliates) rather than showing raw peerAccountId placeholders for anyone not yet messaged.
const sortedContacts = computed(() => {
  const lastByPeer = new Map(listConversations().map((c) => [c.id, c]));
  return [...contacts.value].sort((a, b) => (lastByPeer.get(b.id)?.lastMessageAt || 0) - (lastByPeer.get(a.id)?.lastMessageAt || 0))
    .map((c) => {
      const convo = lastByPeer.get(c.id);
      const last = convo?.messages?.[convo.messages.length - 1];
      return { ...c, lastMessageText: last?.text || '', lastMessageAt: convo?.lastMessageAt || null };
    });
});

const activeContact = ref(null);
const session = ref(null);
const sessionState = ref(CHAT_STATES.IDLE);
const draft = ref('');

const activeMessages = computed(() => {
  if (!activeContact.value) return [];
  return allChats.value.find((c) => c.id === activeContact.value.id)?.messages || [];
});

function openConversation(contact) {
  session.value?.disconnect();
  activeContact.value = contact;
  sessionState.value = CHAT_STATES.IDLE;
  session.value = new P2PChatSession(contact.id, contact.name, {
    onStateChange: (s) => { sessionState.value = s; },
  });
  session.value.connect();
}

function sendDraft() {
  if (!draft.value.trim() || !session.value) return;
  session.value.send(draft.value.trim());
  draft.value = '';
}

// --- Chat-based clinic-profile propagation (SPEC-09 §4) --------------------------------------
// Reuses the EXISTING QR/text-key transfer format (sessionShare.js/sessionTransfer.js, already
// built for Phase C's device-sync/QR flow) verbatim — a chat message carrying that same
// self-contained encoded string, not a new protocol. This is deliberately why it works even when
// the recipient is offline at the moment of sending: the encoded key is meaningful on its own,
// so it still works via the existing QR/paste path (SessionShareModal/SessionImportModal) if
// live chat delivery isn't possible right now — chat is an added transport, not the only one.
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
    if (!record) return; // nothing to share yet -- no Hospital Profile saved on this device
    const { key } = await buildProviderProfileSharePayload(record, onboarding.branding);
    session.value.send(key);
  } finally {
    sharingProfile.value = false;
  }
}

// Per-message import outcome, keyed by message id -- not persisted, just local UI state so a
// clicked card shows its result without needing a full re-render of the whole thread.
const transferImportState = ref({}); // messageId -> 'importing' | 'imported' | 'rejected' | 'error'

async function importTransferKey(message) {
  transferImportState.value = { ...transferImportState.value, [message.id]: 'importing' };
  const result = await decodeProviderProfileShareKey(message.text);
  if (!result.ok) {
    transferImportState.value = { ...transferImportState.value, [message.id]: 'error' };
    return;
  }
  const payload = result.data;
  // No consent path for a clinic profile, same as SessionImportModal's own rule -- importing a
  // DIFFERENT clinic's profile would just overwrite this one's public page with a stranger's
  // data, not a referral worth consenting into.
  if (!isSameClinic(payload)) {
    transferImportState.value = { ...transferImportState.value, [message.id]: 'rejected' };
    return;
  }
  onboarding.importProviderProfile(payload);
  transferImportState.value = { ...transferImportState.value, [message.id]: 'imported' };
}

function close() {
  session.value?.disconnect();
  session.value = null;
  activeContact.value = null;
  emit('close');
}

function formatMsgTime(ts) {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// A plain object literal here (rather than a computed) would freeze DISCONNECTED's label at
// whatever activeContact happened to be when the component was set up — a real reactivity bug,
// not just a style choice — so this stays a function evaluated fresh on every render instead.
function stateLabel(state) {
  switch (state) {
    case CHAT_STATES.SIGNALING:
    case CHAT_STATES.CONNECTING: return 'Connecting…';
    case CHAT_STATES.CONNECTED: return 'Online';
    case CHAT_STATES.DISCONNECTED: return `${activeContact.value?.name || 'They'} left the chat`;
    case CHAT_STATES.FAILED: return 'Not reachable right now';
    default: return '';
  }
}

onBeforeUnmount(() => session.value?.disconnect());
</script>

<template>
  <div class="modal-bg" v-show="show" @click.self="close">
    <div class="modal-panel" data-testid="team-chat-panel" style="max-width:760px;width:92vw;height:70vh;display:flex;flex-direction:column;padding:0;overflow:hidden" @click.stop>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:.85rem 1.1rem;border-bottom:1px solid var(--cf-border)">
        <strong style="font-family:'Poppins',sans-serif"><i class="fas fa-comment-dots" style="margin-right:.4rem;color:var(--brand)"></i>Team Chat</strong>
        <button class="icon-btn-round" @click="close" title="Close"><i class="fas fa-xmark"></i></button>
      </div>

      <div style="flex:1;display:flex;min-height:0">
        <!-- Contact list -->
        <div style="width:260px;flex-shrink:0;border-right:1px solid var(--cf-border);overflow-y:auto">
          <p v-if="!contactsLoaded" style="padding:1rem;font-size:.8rem;color:var(--cf-text)">Loading contacts…</p>
          <p v-else-if="!contacts.length" style="padding:1rem;font-size:.8rem;color:var(--cf-text)">No colleagues or linked affiliates yet.</p>
          <button
            v-for="c in sortedContacts" :key="c.id"
            @click="openConversation(c)"
            style="display:flex;align-items:center;gap:.6rem;width:100%;text-align:left;padding:.65rem 1rem;border:none;background:transparent;cursor:pointer;border-bottom:1px solid var(--cf-border)"
            :style="activeContact?.id === c.id ? 'background:var(--cf-hover, rgba(0,212,178,.08))' : ''"
          >
            <div style="width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.75rem;background:var(--brand);color:#fff">{{ (c.name || '?').charAt(0).toUpperCase() }}</div>
            <div style="min-width:0;flex:1">
              <p style="font-size:.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ c.name }}</p>
              <p style="font-size:.7rem;color:var(--cf-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ c.lastMessageText || c.kind }}</p>
            </div>
            <span v-if="c.lastMessageAt" style="font-size:.62rem;color:var(--cf-text);flex-shrink:0">{{ formatMsgTime(c.lastMessageAt) }}</span>
          </button>
        </div>

        <!-- Active conversation -->
        <div style="flex:1;display:flex;flex-direction:column;min-width:0">
          <div v-if="!activeContact" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--cf-text);font-size:.85rem">
            Pick a colleague to start chatting
          </div>
          <template v-else>
            <div style="padding:.6rem 1rem;border-bottom:1px solid var(--cf-border);font-size:.78rem;color:var(--cf-text);display:flex;align-items:center;justify-content:space-between;gap:.5rem">
              <div>
                <strong style="color:var(--cf-text-strong)">{{ activeContact.name }}</strong>
                <span style="margin-left:.5rem" :style="sessionState === 'connected' ? 'color:#16a34a' : ''">{{ stateLabel(sessionState) }}</span>
              </div>
              <button
                type="button" @click="shareProviderProfile()"
                :disabled="sessionState !== 'connected' || sharingProfile"
                title="Send your clinic's Hospital/Staff profile to this colleague"
                style="flex-shrink:0;border:1px solid var(--cf-border);background:var(--cf-bg-alt);border-radius:.4rem;padding:.3rem .55rem;font-size:.68rem;cursor:pointer;display:flex;align-items:center;gap:.35rem;color:var(--cf-text-strong)"
              >
                <i :class="sharingProfile ? 'fas fa-spinner fa-spin' : 'fas fa-share-nodes'"></i> Share Clinic Profile
              </button>
            </div>
            <div style="flex:1;overflow-y:auto;padding:.75rem 1rem;display:flex;flex-direction:column;gap:.4rem">
              <div v-for="m in activeMessages" :key="m.id" :style="`display:flex;justify-content:${m.direction === 'sent' ? 'flex-end' : 'flex-start'}`">
                <!-- A clinic-profile transfer key, sent as a plain chat message but rendered as
                     an actionable card instead of raw ciphertext -- see importTransferKey()'s
                     own comment for why this reuses the existing QR/paste transfer format. -->
                <div v-if="isTransferKey(m.text)" style="max-width:80%;padding:.55rem .7rem;border-radius:.7rem;font-size:.78rem;background:var(--cf-surface-alt,#f1f5f9);border:1px dashed var(--cf-border);color:var(--cf-text-strong)">
                  <p style="font-weight:600;margin-bottom:.3rem"><i class="fas fa-hospital" style="margin-right:.3rem;color:var(--brand)"></i>Clinic profile transfer</p>
                  <button
                    v-if="!transferImportState[m.id] || transferImportState[m.id] === 'error'"
                    type="button" @click="importTransferKey(m)"
                    style="font-size:.72rem;padding:.3rem .6rem;border-radius:.35rem;border:1px solid var(--cf-border);background:var(--cf-bg);cursor:pointer"
                  >Import</button>
                  <span v-else-if="transferImportState[m.id] === 'importing'" style="font-size:.72rem"><i class="fas fa-spinner fa-spin"></i> Importing…</span>
                  <span v-else-if="transferImportState[m.id] === 'imported'" style="font-size:.72rem;color:#16a34a"><i class="fas fa-check"></i> Imported</span>
                  <span v-else-if="transferImportState[m.id] === 'rejected'" style="font-size:.72rem;color:#dc2626">Different clinic — not imported</span>
                  <p v-if="transferImportState[m.id] === 'error'" style="font-size:.68rem;color:#dc2626;margin-top:.25rem">Could not read this transfer key.</p>
                  <div style="font-size:.62rem;opacity:.7;margin-top:.25rem">{{ formatMsgTime(m.timestamp) }}</div>
                </div>
                <div v-else :style="`max-width:70%;padding:.4rem .7rem;border-radius:.7rem;font-size:.82rem;${m.direction === 'sent' ? 'background:var(--brand);color:#fff' : 'background:var(--cf-surface-alt,#f1f5f9);color:var(--cf-text-strong)'}`">
                  {{ m.text }}
                  <div style="font-size:.62rem;opacity:.7;margin-top:.15rem">{{ formatMsgTime(m.timestamp) }}</div>
                </div>
              </div>
            </div>
            <div style="display:flex;gap:.5rem;padding:.65rem 1rem;border-top:1px solid var(--cf-border)">
              <input
                v-model="draft" type="text" placeholder="Message…"
                :disabled="sessionState !== 'connected'"
                @keydown.enter="sendDraft"
                style="flex:1;padding:.5rem .7rem;border:1px solid var(--cf-border);border-radius:.5rem;font-size:.85rem"
              />
              <button class="btn btn-brand btn-sm" :disabled="sessionState !== 'connected' || !draft.trim()" @click="sendDraft"><i class="fas fa-paper-plane"></i></button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Self-contained, NOT inherited from ClinicHome.vue's own .modal-bg/.modal-panel — Vue's
   `scoped` styles only reach a child component's own ROOT element, never its descendants, so
   TeamChat.vue's inner .modal-panel never actually received ClinicHome's rules despite sharing
   the class name. Confirmed live: without these, the panel had no fixed positioning or opaque
   background at all, letting the page underneath show through in any area not covered by an
   inline style. Values match ClinicHome.vue's own .modal-bg/.modal-panel exactly, for the same
   look, just declared locally instead of assumed to leak in.
   The --cf-* custom properties used throughout this file's inline styles ARE safe as-is — those
   are defined on :root in style.css (global), unlike ClinicHome's --bg/--border/--brand set,
   which is itself only defined inside ClinicHome.vue's own scoped page-level selector. */
.modal-bg {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, .6);
  backdrop-filter: blur(5px);
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.modal-panel {
  background: var(--cf-bg, #fff);
  border: 1px solid var(--cf-border);
  border-radius: 1.25rem;
  box-shadow: 0 30px 60px rgba(0, 0, 0, .3);
}
</style>
