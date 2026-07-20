// mcp-server/tests/unit/mt-code-connect-wiring.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { startServer, type ServerHandle } from '../../src/infrastructure/server.js';
import { initJwt } from '../../src/multi-tenant/jwt.js';
import type { MultiTenantEnv } from '../../src/multi-tenant/env.js';

const ISSUER = 'https://auth.test/realms/mcp';
const logger = createLogger({ level: 'silent' });

let handle: ServerHandle;
let base: string;
let privateKey: CryptoKey;
let calls: { replace?: { userId: string; count: number }; created?: { userId: string; label: string } };

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
    codeConnect: {
      resolveCiKey: async (k) => (k === 'fmcp_ci_good' ? 'u-ci' : null),
      replaceMappings: async (userId, mappings) => { calls.replace = { userId, count: mappings.length }; },
      createCiKey: async (userId, label) => { calls.created = { userId, label }; return { id: 7, plaintext: 'fmcp_ci_new' }; },
      listCiKeys: async () => [],
      revokeCiKey: async () => true,
      lookupMappings: async () => new Map(),
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => { await handle.close(); vi.unstubAllGlobals(); });

async function jwt(sub: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

describe('multi-tenant Code Connect wiring', () => {
  it('POST /api/code-connect/mappings ingests with X-CI-Key (no JWT)', async () => {
    const res = await fetch(`${base}/api/code-connect/mappings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ci-key': 'fmcp_ci_good' },
      body: JSON.stringify({ docs: [{ figmaNode: 'https://figma.com/file/F/Lib?node-id=1-5', component: 'Button' }] }),
    });
    expect(res.status).toBe(200);
    expect(calls.replace).toEqual({ userId: 'u-ci', count: 1 });
  });

  it('POST /api/code-connect/mappings rejects an unknown CI key with 403', async () => {
    const res = await fetch(`${base}/api/code-connect/mappings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ci-key': 'fmcp_ci_bad' },
      body: JSON.stringify({ docs: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /accounts/ci-keys creates a CI key under JWT', async () => {
    const res = await fetch(`${base}/accounts/ci-keys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await jwt('u-acct')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'ci' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).ci_key).toBe('fmcp_ci_new');
    expect(calls.created).toEqual({ userId: 'u-acct', label: 'ci' });
  });

  it('POST /accounts/ci-keys still requires JWT', async () => {
    const res = await fetch(`${base}/accounts/ci-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'ci' }),
    });
    expect(res.status).toBe(401);
  });
});
