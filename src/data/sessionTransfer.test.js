import { describe, it, expect } from 'vitest';
import { encodeSessionTransfer, decodeSessionTransfer } from './sessionTransfer.js';

describe('encodeSessionTransfer / decodeSessionTransfer', () => {
  it('round-trips an arbitrary JSON payload', async () => {
    const payload = { hello: 'world', nested: { n: 42, arr: [1, 2, 3] } };
    const key = await encodeSessionTransfer(payload);
    expect(typeof key).toBe('string');
    expect(key.startsWith('cfx1.')).toBe(true);
    expect(await decodeSessionTransfer(key)).toEqual({ ok: true, data: payload });
  });

  // Confirms this format doesn't rely on a shared/derived secret every device must already
  // possess — each transfer carries its own random key, so two encodes of the same payload
  // never produce the same string (also rules out ciphertext-reuse attacks on the IV).
  it('produces a different key on every call, even for the same payload', async () => {
    const payload = { a: 1 };
    const key1 = await encodeSessionTransfer(payload);
    const key2 = await encodeSessionTransfer(payload);
    expect(key1).not.toBe(key2);
  });

  it('rejects an already-expired key', async () => {
    const key = await encodeSessionTransfer({ a: 1 }, -1000); // expired 1 second ago
    const result = await decodeSessionTransfer(key);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  // AES-GCM's auth tag is what makes this a clean rejection instead of silently returning
  // corrupted data — a single edited character anywhere in the body must fail loudly.
  it('rejects a tampered key instead of silently decrypting garbage', async () => {
    const key = await encodeSessionTransfer({ a: 1 });
    const [prefix, keyPart, body] = key.split('.');
    const flippedBody = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    const result = await decodeSessionTransfer([prefix, keyPart, flippedBody].join('.'));
    expect(result.ok).toBe(false);
  });

  it('rejects garbage/empty/missing input cleanly, never throwing', async () => {
    expect((await decodeSessionTransfer('not-a-key')).ok).toBe(false);
    expect((await decodeSessionTransfer('')).ok).toBe(false);
    expect((await decodeSessionTransfer(null)).ok).toBe(false);
    expect((await decodeSessionTransfer(undefined)).ok).toBe(false);
  });
});
