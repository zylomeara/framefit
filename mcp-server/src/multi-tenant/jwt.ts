import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let issuer: string | null = null;

export function initJwt(jwksUrl: string, iss: string): void {
  jwks = createRemoteJWKSet(new URL(jwksUrl));
  issuer = iss;
}

export interface AuthUser {
  userId: string;
  payload: JWTPayload;
}

export async function validateJwt(token: string, expectedAudience?: string): Promise<AuthUser> {
  if (!jwks || !issuer) {
    throw new Error('JWT not initialized. Call initJwt() first.');
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    // Enforce audience only when a non-empty expectedAudience is provided; omitting it
    // (or passing '') skips the check so legacy aud-less tokens still verify in soft rollout.
    ...(expectedAudience ? { audience: expectedAudience } : {}),
  });

  const userId = payload.sub;
  if (!userId) {
    throw new Error('JWT missing "sub" claim');
  }

  return { userId, payload };
}

export function assertAzp(payload: JWTPayload, expectedAzp: string): void {
  if (payload.azp !== expectedAzp) {
    throw new Error('Unauthorized client');
  }
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}
