// mcp-server/tests/unit/mt-http-server.test.ts
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
    resolvePat: async (userId) => (userId === 'user-with-pat' ? { pat: 'figd_X', label: 'work', status: 'active' } : null),
    accountsDb: {
      listTokens: async () => [],
      addToken: async () => { throw new Error('unused'); },
      removeToken: async () => false,
      setDefaultToken: async () => false,
      getTokenWithPat: async () => null,
      updateValidation: async () => {},
    },
    pingDb: async () => {},
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
  vi.unstubAllGlobals();
});

async function jwt(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setSubject(sub).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
}

describe('multi-tenant http server', () => {
  it('serves oauth-protected-resource metadata', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe('https://figma.test/mcp');
    expect(body.authorization_servers).toEqual([ISSUER]);
  });

  it('401 + WWW-Authenticate without bearer on /mcp and /accounts', async () => {
    for (const path of ['/mcp', '/accounts']) {
      const res = await fetch(`${base}${path}`, { method: path === '/mcp' ? 'POST' : 'GET' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource');
    }
  });

  it('401 for invalid bearer', async () => {
    const res = await fetch(`${base}/accounts`, { headers: { authorization: 'Bearer garbage' } });
    expect(res.status).toBe(401);
  });

  it('valid JWT: GET /accounts returns []', async () => {
    const res = await fetch(`${base}/accounts`, { headers: { authorization: `Bearer ${await jwt('u1')}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('valid JWT: MCP initialize works even without stored PAT', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await jwt('user-without-pat')}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"framefit"');
  });

  it('health includes db status', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });
});

describe('multi-tenant http server: library registry + sync wiring', () => {
  let rHandle: ServerHandle;
  let rBase: string;
  const TEAM_ID = '1234567890123456789';
  const discovered = [{ file_key: 'fk1', name: 'DS Core', vars: 42 }];
  const libraryRows = [
    { team_id: TEAM_ID, file_key: 'fk1', name: 'DS Core', vars: 42, last_synced_at: new Date('2026-01-01T00:00:00Z') },
  ];
  const addTeamSpy = vi.fn(async (_u: string, _t: string) => {});
  // A deferred fake impl: the server's background wrapper invokes it synchronously
  // (so state flips to 'running' immediately) but it only resolves when we call
  // `resolveSync`, letting us prove server-side dedup while it is still pending.
  const syncSpy = vi.fn((_u: string, _t?: string) => deferred.promise);
  let deferred: { promise: Promise<{ libraries: number; variables: number; skipped: number }>; resolve: (v: { libraries: number; variables: number; skipped: number }) => void };
  function newDeferred() {
    let resolve!: (v: { libraries: number; variables: number; skipped: number }) => void;
    const promise = new Promise<{ libraries: number; variables: number; skipped: number }>((r) => { resolve = r; });
    deferred = { promise, resolve };
  }

  beforeAll(async () => {
    newDeferred();
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' });
    rHandle = await startServer(config, logger, {
      env: mtEnv,
      resolvePat: async () => null,
      accountsDb: {
        listTokens: async () => [],
        addToken: async () => { throw new Error('unused'); },
        removeToken: async () => false,
        setDefaultToken: async () => false,
        getTokenWithPat: async () => null,
        updateValidation: async () => {},
      },
      pingDb: async () => {},
      libraryRegistry: {
        addTeam: addTeamSpy,
        listTeams: async () => [{ team_id: TEAM_ID }],
        removeTeam: async () => true,
        listLibraries: async () => libraryRows,
        discover: async () => discovered,
      },
      librarySync: syncSpy,
    });
    rBase = `http://127.0.0.1:${rHandle.port}`;
  });

  afterAll(async () => {
    await rHandle.close();
  });

  it('POST /accounts/teams registers a team instantly with 201 {team_id} (no libraries)', async () => {
    const res = await fetch(`${rBase}/accounts/teams`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await jwt('user-reg')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: TEAM_ID }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.team_id).toBe(TEAM_ID);
    expect(body.libraries).toBeUndefined();
    expect(addTeamSpy).toHaveBeenCalledWith('user-reg', TEAM_ID);
  });

  it('GET /accounts/teams returns teams + libraries from the registry', async () => {
    const res = await fetch(`${rBase}/accounts/teams`, {
      headers: { authorization: `Bearer ${await jwt('user-reg')}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teams).toEqual([{ team_id: TEAM_ID }]);
    expect(body.libraries[0]).toMatchObject({ team_id: TEAM_ID, file_key: 'fk1', name: 'DS Core', vars: 42 });
  });

  it('POST /accounts/sync kicks off the injected librarySync impl with the JWT userId, dedups, and exposes status', async () => {
    const auth = { authorization: `Bearer ${await jwt('user-sync')}`, 'content-type': 'application/json' };

    // First POST: 202 started; impl invoked with the JWT userId.
    const res1 = await fetch(`${rBase}/accounts/sync`, { method: 'POST', headers: auth });
    expect(res1.status).toBe(202);
    expect((await res1.json()).status).toBe('started');
    // All-teams sync passes the userId and an undefined teamId (per-team scoping omitted).
    expect(syncSpy).toHaveBeenCalledWith('user-sync', undefined);
    const callsAfterFirst = syncSpy.mock.calls.length;

    // While the impl is still pending, GET reflects running state.
    const resStatus = await fetch(`${rBase}/accounts/sync`, { headers: auth });
    expect(resStatus.status).toBe(200);
    expect((await resStatus.json()).state).toBe('running');

    // Second immediate POST while still running: dedup → already_running, impl NOT re-invoked.
    const res2 = await fetch(`${rBase}/accounts/sync`, { method: 'POST', headers: auth });
    expect(res2.status).toBe(202);
    expect((await res2.json()).status).toBe('already_running');
    expect(syncSpy.mock.calls.length).toBe(callsAfterFirst);

    // Resolve the deferred impl; poll GET until state flips to done with counts.
    deferred.resolve({ libraries: 1, variables: 42, skipped: 3 });
    let done: { state: string; result?: { libraries: number; variables: number; skipped: number } } | undefined;
    for (let i = 0; i < 50 && done?.state !== 'done'; i++) {
      const r = await fetch(`${rBase}/accounts/sync`, { headers: auth });
      done = await r.json();
      if (done?.state !== 'done') await new Promise((r2) => setTimeout(r2, 10));
    }
    expect(done?.state).toBe('done');
    expect(done?.result).toEqual({ libraries: 1, variables: 42, skipped: 3 });
  });

  it('POST /accounts/teams/:id/sync invokes librarySync with the JWT userId AND that teamId', async () => {
    const auth = { authorization: `Bearer ${await jwt('user-team-sync')}`, 'content-type': 'application/json' };
    const res = await fetch(`${rBase}/accounts/teams/${TEAM_ID}/sync`, { method: 'POST', headers: auth });
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('started');
    expect(syncSpy).toHaveBeenCalledWith('user-team-sync', TEAM_ID);
  });
});
