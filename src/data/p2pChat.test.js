import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSignalingUrl, CHAT_STATES, P2PChatSession } from './p2pChat.js';

// appendMessage touches the real localStorage-backed collection, which doesn't exist under
// vitest's default (Node) environment — mocked out, same "don't exercise the actual collection"
// precedent as formData.test.js. RTCPeerConnection isn't a Node global either (WebRTC isn't
// implemented in Node) — the fakes below stand in for just enough of its surface to prove the
// signaling PROTOCOL (offer/answer/ice/ready/peer-left branching) is wired correctly, which is
// where real bugs would actually hide; the literal browser negotiation is only verifiable in a
// real browser.
vi.mock('./collections/userChats.js', () => ({ appendMessage: vi.fn((peerId, peerName, direction, text) => ({ direction, text })) }));
import { appendMessage } from './collections/userChats.js';

describe('buildSignalingUrl', () => {
  it('converts an absolute http API_BASE to ws', () => {
    const url = buildSignalingUrl('acc2', 'tok', { base: 'http://localhost:8787' });
    expect(url).toBe('ws://localhost:8787/api/chat/signal?peer=acc2&token=tok');
  });

  it('converts an absolute https API_BASE to wss', () => {
    const url = buildSignalingUrl('acc2', 'tok', { base: 'https://api.clinux.example' });
    expect(url).toBe('wss://api.clinux.example/api/chat/signal?peer=acc2&token=tok');
  });

  it('falls back to window origin (matching config.js\'s shared-server relative-URL case) when base is empty', () => {
    const url = buildSignalingUrl('acc2', 'tok', { base: '', locationOrigin: 'http://192.168.1.5:5173' });
    expect(url).toBe('ws://192.168.1.5:5173/api/chat/signal?peer=acc2&token=tok');
  });

  it('URL-encodes the peer id and token', () => {
    const url = buildSignalingUrl('acc/2', 'tok en', { base: 'http://localhost:8787' });
    expect(url).toContain('peer=acc%2F2');
    expect(url).toContain('token=tok%20en');
  });
});

// Fakes standing in for just enough of RTCPeerConnection/RTCDataChannel/WebSocket's surface.
class FakeDataChannel {
  constructor(label) { this.label = label; this.listeners = {}; this.sent = []; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  emit(type, arg) { this.listeners[type]?.(arg); }
}
class FakePeerConnection {
  constructor() { this.listeners = {}; this.localDescription = null; this.remoteDescription = null; this.iceCandidates = []; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  createDataChannel(label) { this.dataChannel = new FakeDataChannel(label); return this.dataChannel; }
  async createOffer() { return { type: 'offer', sdp: 'fake-offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'fake-answer-sdp' }; }
  async setLocalDescription(desc) { this.localDescription = desc; }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async addIceCandidate(c) { this.iceCandidates.push(c); }
  close() {}
}
class FakeWebSocket {
  constructor() { this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
}

describe('P2PChatSession signaling protocol', () => {
  let originalRTCPeerConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    originalRTCPeerConnection = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = FakePeerConnection;
  });

  afterEach(() => {
    globalThis.RTCPeerConnection = originalRTCPeerConnection;
  });

  function sessionWithFakeSocket(onStateChange = () => {}) {
    const session = new P2PChatSession('acc2', 'Dr Doc', { onStateChange });
    session.ws = new FakeWebSocket();
    return session;
  }

  it("as the INITIATOR: creates a data channel and sends an offer on 'ready'", async () => {
    const states = [];
    const session = sessionWithFakeSocket((s) => states.push(s));
    await session._onSignal({ type: 'ready', initiator: true });

    expect(session.pc).toBeInstanceOf(FakePeerConnection);
    expect(session.channel.label).toBe('chat');
    expect(session.ws.sent).toEqual([{ type: 'offer', sdp: { type: 'offer', sdp: 'fake-offer-sdp' } }]);
    expect(states).toContain(CHAT_STATES.CONNECTING);
  });

  it("as the ANSWERER: does nothing on 'ready' except prepare a peer connection", async () => {
    const session = sessionWithFakeSocket();
    await session._onSignal({ type: 'ready', initiator: false });

    expect(session.pc).toBeInstanceOf(FakePeerConnection);
    expect(session.channel).toBeNull();
    expect(session.ws.sent).toEqual([]);
  });

  it('answers an incoming offer', async () => {
    const session = sessionWithFakeSocket();
    await session._onSignal({ type: 'offer', sdp: { type: 'offer', sdp: 'their-offer' } });

    expect(session.pc.remoteDescription).toEqual({ type: 'offer', sdp: 'their-offer' });
    expect(session.ws.sent).toEqual([{ type: 'answer', sdp: { type: 'answer', sdp: 'fake-answer-sdp' } }]);
  });

  it('applies an incoming answer to the existing peer connection', async () => {
    const session = sessionWithFakeSocket();
    await session._onSignal({ type: 'ready', initiator: true }); // creates session.pc
    await session._onSignal({ type: 'answer', sdp: { type: 'answer', sdp: 'their-answer' } });

    expect(session.pc.remoteDescription).toEqual({ type: 'answer', sdp: 'their-answer' });
  });

  it('relays ICE candidates onto the peer connection', async () => {
    const session = sessionWithFakeSocket();
    await session._onSignal({ type: 'ready', initiator: true });
    await session._onSignal({ type: 'ice', candidate: { candidate: 'fake' } });

    expect(session.pc.iceCandidates).toEqual([{ candidate: 'fake' }]);
  });

  it("moves to DISCONNECTED on 'peer-left'", async () => {
    const states = [];
    const session = sessionWithFakeSocket((s) => states.push(s));
    await session._onSignal({ type: 'peer-left' });
    expect(states).toContain(CHAT_STATES.DISCONNECTED);
  });

  it('sends its own outgoing ICE candidates over the signaling socket', () => {
    const session = sessionWithFakeSocket();
    const pc = session._ensurePeerConnection();
    pc.listeners.icecandidate({ candidate: { candidate: 'mine' } });
    expect(session.ws.sent).toEqual([{ type: 'ice', candidate: { candidate: 'mine' } }]);
  });

  it('flips to CONNECTED when the data channel opens, and lets send() work once it has', async () => {
    const states = [];
    const session = sessionWithFakeSocket((s) => states.push(s));
    await session._onSignal({ type: 'ready', initiator: true });
    session.channel.emit('open');

    expect(session.state).toBe(CHAT_STATES.CONNECTED);
    const result = session.send('hello');
    expect(session.channel.sent).toEqual([{ text: 'hello' }]);
    expect(appendMessage).toHaveBeenCalledWith('acc2', 'Dr Doc', 'sent', 'hello');
    expect(result).toEqual({ direction: 'sent', text: 'hello' });
  });

  it('logs an incoming data channel message as received and notifies the caller', async () => {
    const received = [];
    const session = new P2PChatSession('acc2', 'Dr Doc', { onMessage: (m) => received.push(m) });
    session.ws = new FakeWebSocket();
    await session._onSignal({ type: 'ready', initiator: true });
    session.channel.emit('message', { data: JSON.stringify({ text: 'hi there' }) });

    expect(appendMessage).toHaveBeenCalledWith('acc2', 'Dr Doc', 'received', 'hi there');
    expect(received).toHaveLength(1);
  });

  it('send() is a no-op before the channel is connected', () => {
    const session = sessionWithFakeSocket();
    expect(session.send('too early')).toBeNull();
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
