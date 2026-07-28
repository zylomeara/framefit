// A browser page whose domain rebinds to 127.0.0.1 reaches a loopback-bound server same-origin.
// The ONLY thing that distinguishes it from the legitimate MCP client is the Origin header, so the
// gate is asserted over live HTTP against a real started server at BOTH /mcp sites - a unit test of
// the predicate alone would stay green with the middleware wired at one site or neither.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { startServer, type ServerHandle } from '../../src/infrastructure/server.js';
import { allowedOriginSet, isOriginAllowed } from '../../src/infrastructure/origin-guard.js';
import { initJwt } from '../../src/multi-tenant/jwt.js';
import type { MultiTenantEnv } from '../../src/multi-tenant/env.js';

const logger = createLogger({ level: 'silent' });

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

async function post(base: string, origin?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(INIT),
  });
}

describe('allowedOriginSet / isOriginAllowed (pure)', () => {
  it('always admits the loopback origins the server itself advertises', () => {
    const s = allowedOriginSet({ bindHost: '127.0.0.1', port: 3846 });
    expect([...s].sort()).toEqual(['http://127.0.0.1:3846', 'http://localhost:3846']);
  });
  it('admits PUBLIC_BASE_URL and the multi-tenant MCP_HOST origin', () => {
    const s = allowedOriginSet({ bindHost: '0.0.0.0', port: 3846, publicBaseUrl: 'https://mcp.example', mcpHost: 'mcp.example' });
    expect(s.has('https://mcp.example')).toBe(true);
  });
  it('ALLOWED_ORIGINS is comma-separated and trailing slashes are normalised away', () => {
    const s = allowedOriginSet({ bindHost: '127.0.0.1', port: 1, extra: 'https://a.example/, https://b.example' });
    expect(s.has('https://a.example')).toBe(true);
    expect(s.has('https://b.example')).toBe(true);
  });
  it('an absent Origin is allowed (non-browser MCP clients send none) but a foreign one is not', () => {
    const s = allowedOriginSet({ bindHost: '127.0.0.1', port: 3846 });
    expect(isOriginAllowed(undefined, s)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3846', s)).toBe(true);
    expect(isOriginAllowed('https://evil.example', s)).toBe(false);
    expect(isOriginAllowed('null', s)).toBe(false);       // sandboxed iframe / file://
    expect(isOriginAllowed('', s)).toBe(false);
  });
});

describe('single-tenant /mcp', () => {
  let handle: ServerHandle; let base: string;
  beforeAll(async () => {
    handle = await startServer(loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', FIGMA_TOKEN: 'figd_test' }), logger);
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => { await handle.close(); });

  it('no Origin -> the MCP client still works (regression lock)', async () => {
    const res = await post(base);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('serverInfo');
  });

  it('own origin -> allowed', async () => {
    expect((await post(base, base)).status).toBe(200);
  });

  it('foreign origin -> 403 with NO CORS header, so the page cannot read the answer either', async () => {
    const res = await post(base, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await res.json()).toEqual({ error: 'origin not allowed' });
  });

  it('the preflight from a foreign origin is refused too', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('single-tenant /mcp with PUBLIC_BASE_URL and ALLOWED_ORIGINS', () => {
  it('the configured public origin and an explicit extra are both admitted', async () => {
    const handle = await startServer(loadConfig({
      MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', FIGMA_TOKEN: 'figd_test',
      PUBLIC_BASE_URL: 'https://mcp.example', ALLOWED_ORIGINS: 'https://studio.example',
    }), logger);
    const base = `http://127.0.0.1:${handle.port}`;
    try {
      expect((await post(base, 'https://mcp.example')).status).toBe(200);
      expect((await post(base, 'https://studio.example')).status).toBe(200);
      expect((await post(base, 'https://evil.example')).status).toBe(403);
    } finally { await handle.close(); }
  });
});

describe('multi-tenant /mcp is guarded too (mutation "wire one site" -> RED)', () => {
  const mtEnv: MultiTenantEnv = {
    databaseUrl: 'postgresql://unused', encryptionKey: 'a'.repeat(64),
    keycloakJwksUrl: 'https://auth.test/certs', oauthAuthorizationServer: 'https://auth.test/realms/mcp',
    mcpHost: 'localhost:3846', publicBaseUrl: 'http://localhost:3846',
    expectedAudience: 'http://localhost:3846/mcp', expectedAzp: 'figma-portal', enforceAudience: false,
  };
  let handle: ServerHandle; let base: string;
  beforeAll(async () => {
    initJwt(mtEnv.keycloakJwksUrl, mtEnv.oauthAuthorizationServer);
    handle = await startServer(loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' }), logger, {
      env: mtEnv, resolvePat: async () => null,
      accountsDb: {
        listTokens: async () => [], addToken: async () => { throw new Error('unused'); },
        removeToken: async () => false, setDefaultToken: async () => false,
        getTokenWithPat: async () => null, updateValidation: async () => {},
      },
      pingDb: async () => {},
    });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => { await handle.close(); });

  it('foreign origin is refused BEFORE the JWT layer (403, not 401)', async () => {
    const res = await post(base, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin not allowed' });
  });
});
