// Generic encrypt-to-string / decrypt-from-string transfer format, used for QR-code and
// paste-able "session key" transfer between devices (see sessionShare.js for the encounter-
// specific packing on top of this). Replaces the unwired AES-GCM+gzip prototype that used to
// sit at the bottom of main.js.
//
// Deliberately DIFFERENT from that prototype's KEY_REGISTRY design in one important way: this
// generates a fresh random AES-256 key PER TRANSFER and embeds it directly in the output string,
// rather than encrypting with a shared app-wide secret that every device would need to already
// possess. A pre-shared/derived secret sounds more "secure", but it silently breaks the actual
// requirement — cross-clinic sharing needs the RECEIVING device (a different clinic, with no
// prior relationship to the sender) to be able to decrypt something it was never given a key
// for in advance. There's no server here to broker that (explicit "no server storage" decision),
// so the only way an offline QR/text-key handoff can work at all — for same-clinic OR cross-
// clinic transfers alike — is "whoever holds the string can open it", the same trust model as a
// Wi-Fi QR code or a Signal device-linking QR. What this format actually buys you is tamper-
// evidence (AES-GCM's auth tag makes any edited character fail loudly instead of decrypting into
// garbage) and no-plaintext-at-rest — not access control. Access control is handled one layer up,
// in sessionShare.js's clinicId consent gate, which runs AFTER a successful decrypt.
const PREFIX = 'cfx1';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // AES-GCM standard nonce size
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours, same default the old prototype used

function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(base64Url) {
  let base64 = String(base64Url).replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return new Uint8Array(atob(base64).split('').map((c) => c.charCodeAt(0)));
}

async function gzip(text) {
  const stream = new Response(text).body.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * Encrypts + compresses `payloadObject` into a self-contained, copy-paste-able (and QR-able)
 * string. Anyone holding the returned string can decode it — see the module comment above for
 * why that's the correct tradeoff here, not an oversight.
 */
export async function encodeSessionTransfer(payloadObject, ttlMs = DEFAULT_TTL_MS) {
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const wrapped = { exp: Date.now() + ttlMs, data: payloadObject };
  const compressed = await gzip(JSON.stringify(wrapped));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, compressed));

  const body = new Uint8Array(iv.length + ciphertext.length);
  body.set(iv, 0);
  body.set(ciphertext, iv.length);

  return `${PREFIX}.${bytesToBase64Url(rawKey)}.${bytesToBase64Url(body)}`;
}

/**
 * Reverses encodeSessionTransfer(). Never throws — always resolves to { ok, data|error } so
 * callers (UI code fed whatever a user pasted or a camera scanned) don't need a try/catch.
 */
export async function decodeSessionTransfer(rawString) {
  try {
    const trimmed = String(rawString ?? '').trim();
    const parts = trimmed.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) {
      return { ok: false, error: "That doesn't look like a ClinüxFlow session key." };
    }
    const [, keyB64, bodyB64] = parts;
    const rawKey = base64UrlToBytes(keyB64);
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const body = base64UrlToBytes(bodyB64);
    const iv = body.slice(0, IV_BYTES);
    const ciphertext = body.slice(IV_BYTES);

    const compressed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext));
    const wrapped = JSON.parse(await gunzip(compressed));

    if (Date.now() > wrapped.exp) {
      return { ok: false, error: 'This session key has expired — ask the other device to generate a fresh one.' };
    }
    return { ok: true, data: wrapped.data };
  } catch (e) {
    // Wrong/edited key, truncated paste, garbage input, decompression failure, etc. all land
    // here — AES-GCM's auth tag check is what turns "someone tampered with one character" into
    // this same clean failure instead of silently decrypting into corrupted JSON.
    return { ok: false, error: 'Could not read this session key — it may be incomplete, mistyped, or corrupted.' };
  }
}
