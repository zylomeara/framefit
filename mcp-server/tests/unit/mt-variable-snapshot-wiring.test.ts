// mcp-server/tests/unit/mt-variable-snapshot-wiring.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { startServer, type ServerHandle } from '../../src/infrastructure/server.js';
import { initJwt } from '../../src/multi-tenant/jwt.js';
import { signBridgeToken, verifyBridgeToken } from '../../src/multi-tenant/bridge-token.js';
import type { MultiTenantEnv } from '../../src/multi-tenant/env.js';

const ISSUER = 'https://auth.test/realms/mcp';
const logger = createLogger({ level: 'silent' });

let handle: ServerHandle;
let base: string;
let privateKey: CryptoKey;
let calls: { replace?: { userId: string; lib: string; count: number }; issued?: { userId: string } };

const mtEnv: MultiTenantEnv = {
  databaseUrl: 'postgresql://unused',
  encryptionKey: 'a'.repeat(64),
  keycloakJwksUrl: 'https://auth.test/certs',
  oauthAuthorizationServer: ISSUER,
  mcpHost: 'figma.test',
  expectedAudience: 'https://figma.test/mcp',
  expectedAzp: 'figma-portal',
  enforceAudience: false,
};

beforeAll(async () => {
  calls = {};
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk: JWK = await exportJWK(pair.publicKey);
  jwk.kid = 'k1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('auth.test')) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url as string, init);
  }));
  initJwt(mtEnv.keycloakJwksUrl, ISSUER);

  const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' });
  handle = await startServer(config, logger, {
    env: mtEnv,
    resolvePat: async () => null,
    accountsDb: {
      listTokens: async () => [], addToken: async () => { throw new Error('unused'); },
      removeToken: async () => false, setDefaultToken: async () => false,
      getTokenWithPat: async () => null, updateValidation: async () => {},
    },
    pingDb: async () => {},
    variableSnapshot: {
      verifyToken: (t) => verifyBridgeToken(t, 'a'.repeat(64), 'variables:snapshot'),
      replaceSnapshot: async (userId, lib, entries) => { calls.replace = { userId, lib, count: entries.length }; },
      issue: async (userId) => { calls.issued = { userId }; return { token: 'bridge-tok', expires_at: '2026-01-01T00:00:00.000Z', scope: 'variables:snapshot' }; },
      lookup: async () => new Map(),
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => { await handle.close(); vi.unstubAllGlobals(); });

async function jwt(sub: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

describe('multi-tenant variable-snapshot wiring', () => {
  it('POST /api/variables/snapshot ingests with a bridge-token (no JWT)', async () => {
    const tok = await signBridgeToken('u-ci', 'a'.repeat(64), 3600);
    const res = await fetch(`${base}/api/variables/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        library_file_key: 'LIB',
        entries: [{ key: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', value: '#f00', resolved_type: 'COLOR', name: 'bg' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(calls.replace).toEqual({ userId: 'u-ci', lib: 'LIB', count: 1 });
  });

  it('POST /api/variables/snapshot rejects a missing bridge-token with 401', async () => {
    const res = await fetch(`${base}/api/variables/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library_file_key: 'LIB', entries: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /accounts/bridge-token issues a token under JWT', async () => {
    const res = await fetch(`${base}/accounts/bridge-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await jwt('u-acct')}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).token).toBe('bridge-tok');
    expect(calls.issued).toEqual({ userId: 'u-acct' });
  });

  it('POST /accounts/bridge-token still requires JWT', async () => {
    const res = await fetch(`${base}/accounts/bridge-token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
