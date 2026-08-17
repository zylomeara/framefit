// MODE-AWARE public base URL chains. One resolve per mode, locked per mode:
//   stdio            → the actual ephemeral loopback browser bridge origin; configured
//                      PUBLIC_BASE_URL does not replace that process-owned endpoint.
//   single-tenant http → config.PUBLIC_BASE_URL ?? http://127.0.0.1:${actual bound port}
//                      (resolved in the http caller, NOT in the shared buildToolDeps).
//   multi-tenant http  → env.publicBaseUrl (new optional PUBLIC_BASE_URL MT field) ??
//                      https://${env.mcpHost} — prod without PUBLIC_BASE_URL stays byte-for-byte
//                      (locked by the untouched mt-http-server.test.ts fixtures).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { startServer, type ServerHandle } from '../../src/infrastructure/server.js';
import { initJwt } from '../../src/multi-tenant/jwt.js';
import { loadMultiTenantEnv, type MultiTenantEnv } from '../../src/multi-tenant/env.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { DomSnapshotStore } from '../../src/infrastructure/dom-snapshot-store.js';
import type { Logger } from '../../src/infrastructure/logger.js';
import type { StdioBrowserBridge } from '../../src/infrastructure/stdio-browser-bridge.js';

const logger = createLogger({ level: 'silent' });

// ── deps capture (stdio lock): wrap the real registerAllTools so the ACTUAL wiring of every
// started server records the ToolDeps it registered with — behavior stays real for http tests.
const captured: ToolDeps[] = [];
const bridgeControl = vi.hoisted(() => ({
  start: undefined as undefined | ((logger: unknown) => Promise<unknown>),
}));
const stdioControl = vi.hoisted(() => ({
  closeCalls: 0,
  closeError: undefined as unknown,
}));

vi.mock('../../src/infrastructure/stdio-browser-bridge.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/infrastructure/stdio-browser-bridge.js')>();
  return {
    ...orig,
    startStdioBrowserBridge: (logger: Logger) => bridgeControl.start
      ? bridgeControl.start(logger) as Promise<StdioBrowserBridge>
      : orig.startStdioBrowserBridge(logger),
  };
});

vi.mock('../../src/adapters/driving/tools/register-all.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/adapters/driving/tools/register-all.js')>();
  return {
    ...orig,
    registerAllTools: (server: unknown, deps: ToolDeps) => {
      captured.push(deps);
      return orig.registerAllTools(server as Parameters<typeof orig.registerAllTools>[0], deps);
    },
  };
});

// stdio transport must not attach to the vitest worker's real stdin/stdout.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    onclose?: () => void;
    onerror?: (e: Error) => void;
    onmessage?: (m: unknown) => void;
    async start(): Promise<void> {}
    async send(_m: unknown): Promise<void> {}
    async close(): Promise<void> {
      stdioControl.closeCalls += 1;
      if (stdioControl.closeError) throw stdioControl.closeError;
      this.onclose?.();
    }
  },
}));

// ── canned Figma /nodes payload for live get_layout_spec calls over real HTTP ──
const doc: RawSceneNode = {
  id: '1:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 800 },
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [{ id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: { x: 16, y: 0, width: 300, height: 24 } }],
};

const ISSUER = 'https://auth.test/realms/mcp';
let privateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'k1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('auth.test')) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('api.figma.com')) {
      return new Response(JSON.stringify({ nodes: { '1:1': { document: doc } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url as string, init);
  }));
});

afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  bridgeControl.start = undefined;
  stdioControl.closeCalls = 0;
  stdioControl.closeError = undefined;
  vi.restoreAllMocks();
});

async function jwt(sub: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

/** POST a single tools/call to /mcp (stateless streamable transport) and unwrap the JSON-RPC result. */
async function callTool(base: string, name: string, args: unknown, auth?: string): Promise<{ text: string; isError?: boolean }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const bodyText = await res.text();
  expect(res.status).toBe(200);
  // Streamable HTTP may answer as SSE (event/data lines) or plain JSON.
  const dataLines = bodyText.split('\n').filter((l) => l.startsWith('data:'));
  const payload = dataLines.length ? dataLines[dataLines.length - 1].slice(5).trim() : bodyText;
  const rpc = JSON.parse(payload);
  expect(rpc.error).toBeUndefined();
  return { text: rpc.result.content[0].text as string, isError: rpc.result.isError };
}

describe('stdio: publicBaseUrl and snapshot store come from the loopback browser bridge', () => {
  it('registers the actual bridge origin and store even when PUBLIC_BASE_URL is configured', async () => {
    captured.length = 0;
    const configuredPublicBaseUrl = 'http://127.0.0.1:9999';
    const config = loadConfig({
      MCP_TRANSPORT: 'stdio', NODE_ENV: 'test', PORT: '3846',
      PUBLIC_BASE_URL: configuredPublicBaseUrl, // even explicit config must NOT leak into stdio deps
    });
    const handle = await startServer(config, logger);
    try {
      expect(captured).toHaveLength(1);
      expect(captured[0].publicBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(captured[0].publicBaseUrl).not.toBe(configuredPublicBaseUrl);
      expect(captured[0].snapshotStore).toBeInstanceOf(DomSnapshotStore);
      expect(captured[0].tenantId).toBe('local');
      const extractor = await fetch(`${captured[0].publicBaseUrl}/api/dom-snapshots/extractor.js`);
      expect(extractor.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('logs bridge startup failure and registers only the exact fail-soft receipt', async () => {
    captured.length = 0;
    bridgeControl.start = async () => { throw new Error('bind failed'); };
    const warn = vi.spyOn(logger, 'warn');
    const config = loadConfig({ MCP_TRANSPORT: 'stdio', NODE_ENV: 'test' });

    const handle = await startServer(config, logger);
    try {
      expect(warn).toHaveBeenCalledWith(
        { err: 'bind failed' },
        'server.stdio_browser_bridge_unavailable',
      );
      expect(captured).toHaveLength(1);
      expect(captured[0].snapshotStore).toBeUndefined();
      expect(captured[0].publicBaseUrl).toBeUndefined();
      expect(captured[0].browserBridgeDegraded).toEqual({
        status: 'unavailable',
        reason: 'loopback bridge could not start; using inline extractor',
      });
    } finally {
      await handle.close();
    }
  });

  it('attempts transport, MCP server, and bridge close before surfacing a shutdown error', async () => {
    const bridgeClose = vi.fn(async () => { throw new Error('bridge close failed'); });
    bridgeControl.start = async () => ({
      store: new DomSnapshotStore(),
      publicBaseUrl: 'http://127.0.0.1:3846',
      address: '127.0.0.1',
      port: 3846,
      close: bridgeClose,
    });
    stdioControl.closeError = new Error('transport close failed');
    const mcpClose = vi.spyOn(McpServer.prototype, 'close')
      .mockRejectedValueOnce(new Error('mcp close failed'));
    const config = loadConfig({ MCP_TRANSPORT: 'stdio', NODE_ENV: 'test' });
    const handle = await startServer(config, logger);

    await expect(handle.close()).rejects.toThrow('transport close failed');
    expect(stdioControl.closeCalls).toBe(1);
    expect(mcpClose).toHaveBeenCalledTimes(1);
    expect(bridgeClose).toHaveBeenCalledTimes(1);
  });
});

describe('single-tenant http: config.PUBLIC_BASE_URL ?? actual bound loopback origin', () => {
  it('no PUBLIC_BASE_URL → upload_url + loader point at http://127.0.0.1:<actual port> (live end-to-end)', async () => {
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', FIGMA_TOKEN: 'figd_test' });
    const handle = await startServer(config, logger);
    const base = `http://127.0.0.1:${handle.port}`;
    try {
      const { text, isError } = await callTool(base, 'get_layout_spec', { file: 'abc', node_ids: ['1:1'], include_extractor: true });
      expect(isError).toBeFalsy();
      const out = JSON.parse(text);
      // actual bound port, not config.PORT (0 here) — the URL is a REAL endpoint of this process
      expect(out.upload_url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${handle.port}/api/dom-snapshots/`));
      expect(out.extractor_js).toContain(`${base}/api/dom-snapshots/extractor.js`); // loader mode is live, not inline-fallback
      expect(out.extractor_note).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('explicit PUBLIC_BASE_URL wins over the loopback fallback (?? order locked)', async () => {
    const config = loadConfig({
      MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', FIGMA_TOKEN: 'figd_test',
      PUBLIC_BASE_URL: 'https://cfg.example',
    });
    const handle = await startServer(config, logger);
    try {
      const { text } = await callTool(`http://127.0.0.1:${handle.port}`, 'get_layout_spec', { file: 'abc', node_ids: ['1:1'], include_extractor: true });
      const out = JSON.parse(text);
      expect(out.upload_url).toMatch(/^https:\/\/cfg\.example\/api\/dom-snapshots\//);
    } finally {
      await handle.close();
    }
  });
});

describe('multi-tenant http: env.publicBaseUrl ?? https://mcpHost — all four points from ONE resolve', () => {
  // localhost-MT fixture: an http:// base — every point still carrying a `https://${mcpHost}`
  // literal goes RED here (mutation "https literal" → RED). The prod fallback (no publicBaseUrl)
  // stays locked byte-for-byte by the untouched mt-http-server.test.ts.
  const PUB = 'http://localhost:3846';
  const mtEnv: MultiTenantEnv = {
    databaseUrl: 'postgresql://unused',
    encryptionKey: 'a'.repeat(64),
    keycloakJwksUrl: 'https://auth.test/certs',
    oauthAuthorizationServer: ISSUER,
    mcpHost: 'localhost:3846',
    publicBaseUrl: PUB,
    expectedAudience: `${PUB}/mcp`,
    expectedAzp: 'figma-portal',
    enforceAudience: false,
  };
  let handle: ServerHandle;
  let base: string;

  beforeAll(async () => {
    initJwt(mtEnv.keycloakJwksUrl, ISSUER);
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' });
    handle = await startServer(config, logger, {
      env: mtEnv,
      resolvePat: async (userId) => (userId === 'user-with-pat' ? { pat: 'figd_X', label: 'work', status: 'active' } : null),
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

  it(':480 OAuth PRM resource identity uses publicBaseUrl exactly', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect((await res.json()).resource).toBe(`${PUB}/mcp`);
  });

  it(':411 WWW-Authenticate resource_metadata uses publicBaseUrl (no https literal)', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate')!;
    expect(www).toContain(`${PUB}/.well-known/oauth-protected-resource`);
    expect(www).not.toContain('https://localhost:3846');
  });

  it(':538 portal-hint in the no-token tool error uses publicBaseUrl', async () => {
    const { text, isError } = await callTool(base, 'get_comments', { file: 'abc' }, await jwt('user-without-pat'));
    expect(isError).toBe(true);
    expect(text).toContain(`${PUB}/portal`);
    expect(text).not.toContain('https://localhost:3846');
  });

  it(':590 minted upload_url is built on publicBaseUrl (live tools/call with PAT)', async () => {
    const { text, isError } = await callTool(base, 'get_layout_spec',
      { file: 'abc', node_ids: ['1:1'], include_extractor: true }, await jwt('user-with-pat'));
    expect(isError).toBeFalsy();
    const out = JSON.parse(text);
    expect(out.upload_url).toMatch(new RegExp(`^${PUB.replace(/[/:.]/g, '\\$&')}/api/dom-snapshots/`));
  });
});

describe('loadMultiTenantEnv: optional PUBLIC_BASE_URL field', () => {
  const VALID = {
    DATABASE_URL: 'postgresql://mcp:x@db:5432/figma_mcp',
    ENCRYPTION_KEY: 'a'.repeat(64),
    KEYCLOAK_JWKS_URL: 'https://auth.example.com/realms/mcp/protocol/openid-connect/certs',
    OAUTH_AUTHORIZATION_SERVER: 'https://auth.example.com/realms/mcp',
    MCP_HOST: 'figma.mcp.example.com',
  };

  it('absent → publicBaseUrl undefined (prod .env untouched, fallback chain applies)', () => {
    expect(loadMultiTenantEnv(VALID).publicBaseUrl).toBeUndefined();
  });

  it('empty string → undefined (compose env-substitution passes "" when unset)', () => {
    expect(loadMultiTenantEnv({ ...VALID, PUBLIC_BASE_URL: '' }).publicBaseUrl).toBeUndefined();
  });

  it('set → loaded verbatim, and the expectedAudience DEFAULT follows it (OAuth identity coherence)', () => {
    const env = loadMultiTenantEnv({ ...VALID, PUBLIC_BASE_URL: 'http://localhost:3846' });
    expect(env.publicBaseUrl).toBe('http://localhost:3846');
    expect(env.expectedAudience).toBe('http://localhost:3846/mcp');
  });

  it('explicit EXPECTED_AUDIENCE still beats the PUBLIC_BASE_URL-derived default', () => {
    const env = loadMultiTenantEnv({
      ...VALID, PUBLIC_BASE_URL: 'http://localhost:3846', EXPECTED_AUDIENCE: 'https://custom/aud',
    });
    expect(env.expectedAudience).toBe('https://custom/aud');
  });
});
