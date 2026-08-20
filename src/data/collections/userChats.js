import { createLocalCollection } from '../collectionFactory.js';

// Each device's own local history of its P2P chats with colleagues — see
// docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md and p2pChat.js. Messages never touch any server
// (see clinuxflow-api's ChatSignalingRoom.js — it only ever relays SDP/ICE, never message
// content) — this collection is what makes them durable at all, on THIS device only. Unlike
// formData.js's clinical records, there is no cloud/LAN mirror layered on top: each side of a
// conversation only ever has its own local copy of what it sent and received, by design, not as
// a not-yet-built feature.
//
// One row per PEER, not per message — id is the peer's accountId, since a device only ever has
// one ongoing conversation with a given colleague:
// { id: peerAccountId, peerName, messages: [{ id, direction: 'sent'|'received', text, timestamp }], lastMessageAt }
export const userChats = createLocalCollection('cf_user_chats_v1');

export function getConversation(peerAccountId) {
  return userChats.get(peerAccountId) || null;
}

// direction: 'sent' (this device composed it) | 'received' (arrived over the DataChannel).
// peerName is only used to seed/refresh the display name — pass null to leave whatever's
// already stored untouched (e.g. when logging a message for a peer whose name isn't known here).
export function appendMessage(peerAccountId, peerName, direction, text) {
  const message = { id: Date.now(), direction, text, timestamp: Date.now() };
  if (userChats.has(peerAccountId)) {
    userChats.update(peerAccountId, (draft) => {
      draft.messages.push(message);
      draft.lastMessageAt = message.timestamp;
      if (peerName) draft.peerName = peerName;
    });
  } else {
    userChats.insert({
      id: peerAccountId,
      peerName: peerName || peerAccountId,
      messages: [message],
      lastMessageAt: message.timestamp,
    });
  }
  return message;
}

// Pure sort step, split out from listConversations() below so it's testable without touching
// the actual localStorage-backed collection (see formData.test.js's own comment on this — the
// established pattern in this codebase is to keep the collection itself untested and unit-test
// whatever real logic sits around it instead).
export function sortByLastMessage(conversations) {
  return conversations.slice().sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
}

// Most-recently-active conversation first — the WhatsApp-style contact list's own ordering.
export function listConversations() {
  return sortByLastMessage(userChats.toArray);
}
