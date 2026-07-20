import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { startServer, type ServerHandle } from '../../src/infrastructure/server.js';
import { initJwt } from '../../src/multi-tenant/jwt.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { MultiTenantEnv } from '../../src/multi-tenant/env.js';

const ISSUER = 'https://auth.test/realms/mcp';
const MCP_HOST = 'figma.mcp.example.com';
const AUDIENCE = `https://${MCP_HOST}/mcp`;

let privateKey: CryptoKey;
let publicJwk: JWK;

async function sign(claims: { sub?: string; aud?: string | string[]; azp?: string }): Promise<string> {
  const body: Record<string, unknown> = {};
  if (claims.aud !== undefined) body.aud = claims.aud;
  if (claims.azp !== undefined) body.azp = claims.azp;
  let jwt = new SignJWT(body)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER).setIssuedAt().setExpirationTime('5m');
  if (claims.sub) jwt = jwt.setSubject(claims.sub);
  return jwt.sign(privateKey);
}

function mtEnv(enforceAudience: boolean): MultiTenantEnv {
  return {
    databaseUrl: 'postgresql://unused',
    encryptionKey: 'a'.repeat(64),
    keycloakJwksUrl: `${ISSUER}/protocol/openid-connect/certs`,
    oauthAuthorizationServer: ISSUER,
    mcpHost: MCP_HOST,
    expectedAudience: AUDIENCE,
    expectedAzp: 'figma-portal',
    enforceAudience,
  };
}

const logger = createLogger({ level: 'silent' });

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'test-key'; publicJwk.alg = 'RS256'; publicJwk.use = 'sig';
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('auth.test')) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url as string, init);
  }));
  initJwt(`${ISSUER}/protocol/openid-connect/certs`, ISSUER);
});
afterAll(() => vi.unstubAllGlobals());

async function bootAndReq(
  enforceAudience: boolean,
  token: string,
  path: '/mcp' | '/accounts',
  method = 'POST',
): Promise<number> {
  const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' });
  const handle: ServerHandle = await startServer(config, logger, {
    env: mtEnv(enforceAudience),
    resolvePat: async () => ({ pat: 'figd_x', label: 'd', status: 'active' as const }),
    pingDb: async () => {},
  });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      ...(method === 'POST'
        ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }
        : {}),
    });
    return res.status;
  } finally {
    await handle.close();
  }
}

// /mcp carries Claude dynamic-client tokens (azp=UUID, no per-service aud) → ALWAYS soft,
// even when ENFORCE_AUDIENCE=true, or legitimate connectors break.
describe('/mcp gate is always soft (figma)', () => {
  it('aud-less token is NOT 401 even with enforce=true', async () => {
    expect(await bootAndReq(true, await sign({ sub: 'claude-user' }), '/mcp')).not.toBe(401);
  });
  it('wrong azp is NOT 401 with enforce=true (soft)', async () => {
    expect(await bootAndReq(true, await sign({ sub: 'u', aud: AUDIENCE, azp: 'claude' }), '/mcp')).not.toBe(401);
  });
  it('garbage/invalid-signature token still 401', async () => {
    expect(await bootAndReq(true, 'not.a.jwt', '/mcp')).toBe(401);
  });
});

// /accounts carries portal tokens (azp=figma-portal, aud from Keycloak mapper) → hard-enforce
// gated by ENFORCE_AUDIENCE closes the cross-portal threat.
describe('/accounts gate is hard when enforce=true (figma)', () => {
  it('enforce=true: aud-less portal token -> 401', async () => {
    expect(await bootAndReq(true, await sign({ sub: 'u' }), '/accounts', 'GET')).toBe(401);
  });
  it('enforce=true: wrong azp -> 401', async () => {
    expect(await bootAndReq(true, await sign({ sub: 'u', aud: AUDIENCE, azp: 'claude' }), '/accounts', 'GET')).toBe(401);
  });
  it('enforce=true: correct aud + azp -> NOT 401', async () => {
    expect(await bootAndReq(true, await sign({ sub: 'u', aud: AUDIENCE, azp: 'figma-portal' }), '/accounts', 'GET')).not.toBe(401);
  });
  it('enforce=false (soft): aud-less -> NOT 401', async () => {
    expect(await bootAndReq(false, await sign({ sub: 'u' }), '/accounts', 'GET')).not.toBe(401);
  });
});
