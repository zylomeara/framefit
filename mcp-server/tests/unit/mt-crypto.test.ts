import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/multi-tenant/crypto.js';

const KEY = 'a'.repeat(64); // 32 bytes hex
const OTHER_KEY = 'b'.repeat(64);

describe('multi-tenant crypto', () => {
  it('roundtrips plaintext with AAD', () => {
    const ct = encrypt('figd_secret_token', KEY, 'user-1');
    expect(ct).not.toContain('figd_');
    expect(decrypt(ct, KEY, 'user-1')).toBe('figd_secret_token');
  });

  it('produces different ciphertexts for same plaintext (random nonce)', () => {
    expect(encrypt('x', KEY)).not.toBe(encrypt('x', KEY));
  });

  it('fails on AAD mismatch (token stolen across users)', () => {
    const ct = encrypt('figd_secret_token', KEY, 'user-1');
    expect(() => decrypt(ct, KEY, 'user-2')).toThrow();
  });

  it('fails on wrong key', () => {
    const ct = encrypt('figd_secret_token', KEY, 'user-1');
    expect(() => decrypt(ct, OTHER_KEY, 'user-1')).toThrow();
  });

  it('fails on tampered ciphertext', () => {
    const ct = encrypt('figd_secret_token', KEY, 'user-1');
    const buf = Buffer.from(ct, 'base64');
    buf[14] ^= 0xff; // flip a ciphertext byte
    expect(() => decrypt(buf.toString('base64'), KEY, 'user-1')).toThrow();
  });
});
