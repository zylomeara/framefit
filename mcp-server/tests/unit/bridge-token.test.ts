import { describe, it, expect } from 'vitest';
import { signBridgeToken, verifyBridgeToken } from '../../src/multi-tenant/bridge-token.js';

const SECRET = 'a'.repeat(64); // 32-byte hex, like ENCRYPTION_KEY

describe('bridge-token', () => {
  it('signs and verifies a scoped token → returns userId', async () => {
    const tok = await signBridgeToken('user-1', SECRET, 3600);
    expect(await verifyBridgeToken(tok, SECRET, 'variables:snapshot')).toBe('user-1');
  });
  it('rejects a token with the wrong scope', async () => {
    const tok = await signBridgeToken('user-1', SECRET, 3600);
    expect(await verifyBridgeToken(tok, SECRET, 'figma:write')).toBeNull();
  });
  it('rejects a tampered/garbage token', async () => {
    expect(await verifyBridgeToken('not.a.jwt', SECRET, 'variables:snapshot')).toBeNull();
  });
  it('rejects a token signed with a different secret', async () => {
    const tok = await signBridgeToken('user-1', SECRET, 3600);
    expect(await verifyBridgeToken(tok, 'b'.repeat(64), 'variables:snapshot')).toBeNull();
  });
  it('rejects an expired token', async () => {
    const tok = await signBridgeToken('user-1', SECRET, -1); // already expired
    expect(await verifyBridgeToken(tok, SECRET, 'variables:snapshot')).toBeNull();
  });
});
