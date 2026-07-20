// mcp-server/src/multi-tenant/bridge-token.ts
// Short-lived, narrowly-scoped token signed by OUR server (HS256 over the existing
// 32-byte encryptionKey) — NOT a Keycloak JWT (which would over-scope to all of
// /mcp + /accounts). Used so the Figma plugin can upload a variable snapshot.
import { SignJWT, jwtVerify } from 'jose';

const ISS = 'framefit';

function secretBytes(secretHex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(secretHex, 'hex'));
}

export async function signBridgeToken(userId: string, secretHex: string, ttlSec: number): Promise<string> {
  return new SignJWT({ scope: 'variables:snapshot' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
    .sign(secretBytes(secretHex));
}

/** Returns the userId (sub) iff the token is valid, unexpired, our-issuer, and carries requiredScope. Else null. */
export async function verifyBridgeToken(token: string, secretHex: string, requiredScope: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretBytes(secretHex), { issuer: ISS });
    if (payload.scope !== requiredScope) return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
