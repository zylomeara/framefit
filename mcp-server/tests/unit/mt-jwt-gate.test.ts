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

// /mcp carries dynamic-client tokens (azp=UUID) → ENFORCE_AUDIENCE never reaches it, or
// legitimate connectors break. With MCP_STRICT_AUDIENCE unset it stays soft (see below).
describe('/mcp gate ignores ENFORCE_AUDIENCE (figma)', () => {
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

// MCP_STRICT_AUDIENCE: /mcp admits a token only when its `aud` is exactly this server's MCP URL
// (the PRM `resource`) - a string, or a one-element array. Off by default; while off, every token
// strict mode would refuse is still served and logs one `mt.mcp_audience_would_reject` line.
interface Hit { status: number; wwwAuth: string | null; body: string; logs: Array<Record<string, unknown>> }

async function hit(
  opts: { strict: boolean; enforce?: boolean },
  token: string,
  path: '/mcp' | '/accounts' = '/mcp',
): Promise<Hit> {
  const lines: string[] = [];
  const capture = createLogger({ level: 'warn', destination: { write: (s: string) => { lines.push(s); } } });
  const handle: ServerHandle = await startServer(
    loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' }),
    capture,
    {
      env: { ...mtEnv(opts.enforce ?? false), mcpStrictAudience: opts.strict },
      resolvePat: async () => ({ pat: 'figd_x', label: 'd', status: 'active' as const }),
      accountsDb: {
        listTokens: async () => [],
        addToken: async () => { throw new Error('unused'); },
        removeToken: async () => false,
        setDefaultToken: async () => false,
        getTokenWithPat: async () => null,
        updateValidation: async () => {},
      },
      pingDb: async () => {},
    },
  );
  try {
    const before = lines.length;
    const res = path === '/mcp'
      ? await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      : await fetch(`http://127.0.0.1:${handle.port}/accounts`, { headers: { authorization: `Bearer ${token}` } });
    return {
      status: res.status,
      wwwAuth: res.headers.get('www-authenticate'),
      body: await res.text(),
      logs: lines.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>),
    };
  } finally {
    await handle.close();
  }
}

const WOULD_REJECT = 'mt.mcp_audience_would_reject';
const SOFT_MISMATCH = 'mt.jwt_audience_soft_mismatch';
const byMsg = (h: Hit, msg: string) => h.logs.filter((l) => l.msg === msg);
// A connector token: dynamic-client azp the server cannot predict.
const CONNECTOR_AZP = 'dyn-client-7f3a';

describe('/mcp strict audience (MCP_STRICT_AUDIENCE)', () => {
  for (const strict of [true, false]) {
    it(`strict=${strict}: sole string aud is served, whatever the azp, with no audience log`, async () => {
      const h = await hit({ strict }, await sign({ sub: 'u', aud: AUDIENCE, azp: CONNECTOR_AZP }));
      expect(h.status).toBe(200);
      expect(byMsg(h, WOULD_REJECT)).toEqual([]);
      expect(byMsg(h, SOFT_MISMATCH)).toEqual([]);
    });

    it(`strict=${strict}: one-element array [expected] is served with no audience log`, async () => {
      const h = await hit({ strict }, await sign({ sub: 'u', aud: [AUDIENCE], azp: CONNECTOR_AZP }));
      expect(h.status).toBe(200);
      expect(byMsg(h, WOULD_REJECT)).toEqual([]);
      expect(byMsg(h, SOFT_MISMATCH)).toEqual([]);
    });
  }

  it('strict=true: refusal is the same 401 an invalid token gets (body and WWW-Authenticate)', async () => {
    const garbage = await hit({ strict: true }, 'not.a.jwt');
    const multi = await hit({ strict: true }, await sign({ sub: 'u', aud: [AUDIENCE, 'https://other.example.com/mcp'], azp: CONNECTOR_AZP }));
    expect(garbage.status).toBe(401);
    expect(multi.status).toBe(401);
    expect(multi.body).toBe(garbage.body);
    expect(multi.wwwAuth).toBe(garbage.wwwAuth);
    expect(multi.wwwAuth).toMatch(/resource_metadata=/);
  });

  const refused: Array<[string, string | string[] | undefined]> = [
    ['[expected, other]', [AUDIENCE, 'https://other.example.com/mcp']],
    ['another MCP server URL', 'https://other.example.com/mcp'],
    ['missing aud', undefined],
    ['trailing slash', `${AUDIENCE}/`],
    ['different case', AUDIENCE.toUpperCase()],
    ['empty array', []],
  ];
  for (const [label, aud] of refused) {
    it(`strict=true: ${label} -> 401`, async () => {
      const h = await hit({ strict: true }, await sign({ sub: 'u', aud, azp: CONNECTOR_AZP }));
      expect(h.status).toBe(401);
      expect(byMsg(h, WOULD_REJECT)).toEqual([]);
    });
  }

  const wouldReject: Array<[string, string | string[] | undefined, string, boolean]> = [
    ['[expected, other]', [AUDIENCE, 'https://other.example.com/mcp'], 'array:2', true],
    ['another MCP server URL', 'https://other.example.com/mcp', 'string', false],
    ['missing aud', undefined, 'missing', false],
  ];
  for (const [label, aud, audShape, containsExpected] of wouldReject) {
    it(`strict=false: ${label} is served and logs exactly one would-reject line, claims-minimal`, async () => {
      const token = await sign({ sub: 'u', aud, azp: CONNECTOR_AZP });
      const h = await hit({ strict: false }, token);
      expect(h.status).toBe(200);
      const lines = byMsg(h, WOULD_REJECT);
      expect(lines).toHaveLength(1);
      // Exact key set: pino's own fields plus the four named ones - no token, no other claims.
      expect(lines[0]).toEqual({
        level: 40,   // pino warn
        time: expect.any(Number),
        pid: expect.any(Number),
        hostname: expect.any(String),
        msg: WOULD_REJECT,
        azp: CONNECTOR_AZP,
        audShape,
        containsExpected,
        expectedAudience: AUDIENCE,
      });
      expect(JSON.stringify(h.logs)).not.toContain(token);
      expect(byMsg(h, SOFT_MISMATCH)).toEqual([]);
    });
  }
});

describe('/accounts is untouched by MCP_STRICT_AUDIENCE', () => {
  it('strict=true, enforce=false: a foreign token is still served and logs the soft mismatch', async () => {
    const h = await hit({ strict: true, enforce: false }, await sign({ sub: 'u', aud: 'other-client', azp: 'other-client' }), '/accounts');
    expect(h.status).toBe(200);
    expect(byMsg(h, SOFT_MISMATCH)).toHaveLength(1);
    expect(byMsg(h, WOULD_REJECT)).toEqual([]);
  });

  it('strict=true, enforce=true: aud containing the audience plus azp=portal is still served', async () => {
    const h = await hit(
      { strict: true, enforce: true },
      await sign({ sub: 'u', aud: [AUDIENCE, 'https://other.example.com/mcp'], azp: 'figma-portal' }),
      '/accounts',
    );
    expect(h.status).toBe(200);
  });

  it('strict=true, enforce=true: sole aud with a foreign azp is still refused', async () => {
    const h = await hit({ strict: true, enforce: true }, await sign({ sub: 'u', aud: AUDIENCE, azp: CONNECTOR_AZP }), '/accounts');
    expect(h.status).toBe(401);
  });
});
