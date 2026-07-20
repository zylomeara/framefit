import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK, type JWTPayload } from 'jose';
import { initJwt, validateJwt, extractBearerToken, assertAzp } from '../../src/multi-tenant/jwt.js';

const ISSUER = 'https://auth.test/realms/mcp';

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  initJwt('https://auth.test/realms/mcp/protocol/openid-connect/certs', ISSUER);
});

afterAll(() => vi.unstubAllGlobals());

async function sign(
  opts: { sub?: string; issuer?: string; exp?: string; aud?: string | string[]; azp?: string } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.aud !== undefined) claims.aud = opts.aud;
  if (opts.azp !== undefined) claims.azp = opts.azp;
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m');
  if (opts.sub !== undefined) jwt = jwt.setSubject(opts.sub);
  return jwt.sign(privateKey);
}

describe('validateJwt', () => {
  it('returns userId from sub claim for a valid token', async () => {
    const token = await sign({ sub: 'keycloak-user-42' });
    const auth = await validateJwt(token);
    expect(auth.userId).toBe('keycloak-user-42');
  });

  it('rejects token without sub', async () => {
    const token = await sign({});
    await expect(validateJwt(token)).rejects.toThrow(/sub/);
  });

  it('rejects wrong issuer', async () => {
    const token = await sign({ sub: 'u', issuer: 'https://evil.example' });
    await expect(validateJwt(token)).rejects.toThrow();
  });

  it('rejects expired token', async () => {
    const token = await sign({ sub: 'u', exp: '-5m' });
    await expect(validateJwt(token)).rejects.toThrow();
  });
});

describe('extractBearerToken', () => {
  it('extracts token from Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });
  it('returns null for missing/malformed header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Basic xyz')).toBeNull();
  });
});

const AUDIENCE = 'https://figma.mcp.example.com/mcp';

describe('validateJwt audience', () => {
  it('string aud equal -> passes', async () => {
    const token = await sign({ sub: 'u', aud: AUDIENCE });
    const auth = await validateJwt(token, AUDIENCE);
    expect(auth.userId).toBe('u');
  });
  it('array aud containing expected -> passes', async () => {
    const token = await sign({ sub: 'u', aud: ['other', AUDIENCE] });
    const auth = await validateJwt(token, AUDIENCE);
    expect(auth.userId).toBe('u');
  });
  it('array aud WITHOUT expected -> throws', async () => {
    const token = await sign({ sub: 'u', aud: ['other', 'https://other-service.example.com/mcp'] });
    await expect(validateJwt(token, AUDIENCE)).rejects.toThrow();
  });
  it('aud absent + audience expected -> throws', async () => {
    const token = await sign({ sub: 'u' });
    await expect(validateJwt(token, AUDIENCE)).rejects.toThrow();
  });
  it('migration-guard: aud absent passes when audience NOT enforced (undefined arg)', async () => {
    const token = await sign({ sub: 'u' });
    const auth = await validateJwt(token);
    expect(auth.userId).toBe('u');
  });
});

describe('assertAzp', () => {
  it('azp === figma-portal -> ok', () => {
    expect(() => assertAzp({ sub: 'u', azp: 'figma-portal' } as JWTPayload, 'figma-portal')).not.toThrow();
  });
  it('azp === claude -> throws Unauthorized client', () => {
    expect(() => assertAzp({ sub: 'u', azp: 'claude' } as JWTPayload, 'figma-portal')).toThrow(/Unauthorized client/);
  });
  it('azp absent -> throws (fail-closed)', () => {
    expect(() => assertAzp({ sub: 'u' } as JWTPayload, 'figma-portal')).toThrow(/Unauthorized client/);
  });
});
