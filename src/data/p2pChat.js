// True P2P user-to-user chat — see docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md and
// clinuxflow-api's ChatSignalingRoom.js. Works identically regardless of connectivity mode
// (local-only, LAN-shared, or cloud/ABDM) because the signaling relay it depends on is
// deliberately NOT tier-gated (see GET /api/chat/signal's own comment) — the whole point raised
// when this was designed is that chat doesn't care which tier a clinic is on.
//
// The signaling WebSocket only ever carries SDP offer/answer and ICE candidates — once the
// RTCPeerConnection's DataChannel is open, actual message text flows directly browser-to-browser
// over it, never through clinuxflow-api again. Each device logs what it sent/received into
// userChats.js, its own local-only copy — "nothing stored in the interim" describes the
// transport, not local persistence on either end (same as WhatsApp's own model: no server-side
// copy after delivery, each device keeps its own history).
//
// No offline delivery: if the peer isn't actively connected to the signaling room right now,
// there's nothing to negotiate with and the message can't be sent — an accepted tradeoff of
// true P2P with no server-side queueing, not an oversight.
import { API_BASE, SESSION_TOKEN_KEY } from '../config.js';
import { appendMessage } from './collections/userChats.js';

const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// Exported for testing — handles both of API_BASE's shapes (see config.js's own comment):
// '' when this page was served by the Tauri shared server (relative, same-origin), or an
// absolute http(s):// URL otherwise.
export function buildSignalingUrl(peerAccountId, token, { base = API_BASE, locationOrigin } = {}) {
  const query = `peer=${encodeURIComponent(peerAccountId)}&token=${encodeURIComponent(token)}`;
  if (base === '') {
    const origin = locationOrigin ?? `${window.location.protocol}//${window.location.host}`;
    const wsOrigin = origin.replace(/^http/, 'ws');
    return `${wsOrigin}/api/chat/signal?${query}`;
  }
  return `${base.replace(/^http/, 'ws')}/api/chat/signal?${query}`;
}

export const CHAT_STATES = Object.freeze({
  IDLE: 'idle',
  SIGNALING: 'signaling',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
});

export class P2PChatSession {
  constructor(peerAccountId, peerName, { onMessage, onStateChange } = {}) {
    this.peerAccountId = peerAccountId;
    this.peerName = peerName;
    this.onMessage = onMessage || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.ws = null;
    this.pc = null;
    this.channel = null;
    this.state = CHAT_STATES.IDLE;
  }

  _setState(state) {
    this.state = state;
    this.onStateChange(state);
  }

  connect() {
    const token = localStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) {
      this._setState(CHAT_STATES.FAILED);
      return;
    }
    this._setState(CHAT_STATES.SIGNALING);
    this.ws = new WebSocket(buildSignalingUrl(this.peerAccountId, token));
    this.ws.addEventListener('message', (event) => this._onSignal(JSON.parse(event.data)));
    this.ws.addEventListener('close', () => {
      if (this.state !== CHAT_STATES.CONNECTED) this._setState(CHAT_STATES.FAILED);
    });
    this.ws.addEventListener('error', () => this._setState(CHAT_STATES.FAILED));
  }

  _ensurePeerConnection() {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.ws.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
    });
    pc.addEventListener('datachannel', (event) => this._bindChannel(event.channel));
    this.pc = pc;
    return pc;
  }

  _bindChannel(channel) {
    this.channel = channel;
    channel.addEventListener('open', () => this._setState(CHAT_STATES.CONNECTED));
    channel.addEventListener('close', () => this._setState(CHAT_STATES.DISCONNECTED));
    channel.addEventListener('message', (event) => {
      const { text } = JSON.parse(event.data);
      const message = appendMessage(this.peerAccountId, this.peerName, 'received', text);
      this.onMessage(message);
    });
  }

  async _onSignal(msg) {
    if (msg.type === 'ready') {
      this._setState(CHAT_STATES.CONNECTING);
      const pc = this._ensurePeerConnection();
      if (msg.initiator) {
        this._bindChannel(pc.createDataChannel('chat'));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.ws.send(JSON.stringify({ type: 'offer', sdp: offer }));
      }
      return;
    }
    if (msg.type === 'offer') {
      const pc = this._ensurePeerConnection();
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
      return;
    }
    if (msg.type === 'answer') {
      await this.pc?.setRemoteDescription(msg.sdp);
      return;
    }
    if (msg.type === 'ice') {
      await this.pc?.addIceCandidate(msg.candidate);
      return;
    }
    if (msg.type === 'peer-left') {
      this._setState(CHAT_STATES.DISCONNECTED);
    }
  }

  // Only usable once state === CONNECTED (channel is open) — callers should gate the send
  // affordance on that, same as any other "peer isn't here right now" messaging UI.
  send(text) {
    if (this.state !== CHAT_STATES.CONNECTED) return null;
    this.channel.send(JSON.stringify({ text }));
    return appendMessage(this.peerAccountId, this.peerName, 'sent', text);
  }

  disconnect() {
    this.channel?.close();
    this.pc?.close();
    this.ws?.close();
    this._setState(CHAT_STATES.IDLE);
  }
}
