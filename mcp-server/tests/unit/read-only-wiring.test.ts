// The defect is NOT in assertWritable - tests/unit/read-only-gate.test.ts already proves that
// refuses with an injected gate, and write-comments-tools.test.ts already proves a tool refuses
// with a hand-built deps.readOnly. Both are green today. The defect is one layer up:
// buildToolDeps never populates deps.readOnly, so a gate written at the injected-dep level can
// never be shown red. Every assertion here is therefore at the WIRING boundary.
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { buildToolDeps, startServer, type ServerHandle } from '../../src/infrastructure/server.js';
import { registerWriteCommentsTools } from '../../src/adapters/driving/tools/write-comments-tools.js';
import { initJwt } from '../../src/multi-tenant/jwt.js';
import type { MultiTenantEnv } from '../../src/multi-tenant/env.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
const deps = (env: Record<string, string>) =>
  buildToolDeps(loadConfig({ NODE_ENV: 'test', FIGMA_TOKEN: 'figd_test', ...env }), logger);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('the flag reaches the single-tenant container', () => {
  // A variable the process supports, documents and refuses on is still absent from the deployment
  // if compose does not forward it: `FRAMEFIT_READ_ONLY=true docker compose --profile local config`
  // rendered four variables and not this one, so the feature worked everywhere except the container
  // its own documentation describes. And it cannot ride mcp-server/.env.example, where it IS
  // documented, because that file is the env_file of the MULTI-TENANT service, which ignores the
  // flag entirely.
  //
  // This asserts over the compose SOURCE rather than over `docker compose config`, deliberately:
  // the unit suite must not require a docker binary, and a test that skips when docker is missing
  // would be green-by-absence in exactly the environment (CI) where it matters most. The rendered
  // proof is in the task report; what is locked here is the one line that produces it.
  const compose = readFileSync(join(repoRoot, 'docker', 'docker-compose.yml'), 'utf8');

  /** The `environment:` entries of one compose service, by indentation. */
  function environmentOf(service: string): string[] {
    const body = compose.split(new RegExp(`^  ${service}:$`, 'm'))[1] ?? '';
    const upToNextService = body.split(/\n {2}\w[\w-]*:\n/)[0];
    const env = upToNextService.split(/\n {4}environment:\n/)[1] ?? '';
    return [...env.matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1].trim());
  }

  it('the parser actually reads the compose file (guards against a vacuous match)', () => {
    expect(environmentOf('framefit-local'), 'no environment entries parsed').toContain('FIGMA_TOKEN');
    expect(environmentOf('framefit')).toContain('MULTI_TENANT=true');
  });

  it('framefit-local forwards FRAMEFIT_READ_ONLY, bare so unset means absent', () => {
    const env = environmentOf('framefit-local');
    expect(
      env,
      'the local container cannot be put in read-only mode: compose does not forward the flag',
    ).toContain('FRAMEFIT_READ_ONLY');
    // `- FRAMEFIT_READ_ONLY=${FRAMEFIT_READ_ONLY:-}` would inject '' when the host var is unset.
    // The config coerces '' to undefined, so it would still behave - but the honest shape for an
    // optional flag is omission, and this service has no env_file for a bare entry to wipe.
    expect(env.filter((e) => e.startsWith('FRAMEFIT_READ_ONLY'))).toEqual(['FRAMEFIT_READ_ONLY']);
  });

  it('framefit-local still has no env_file, which is what makes the bare entry safe', () => {
    // The compose file's own rule block: `environment` beats `env_file`, and a BARE entry whose
    // host var is unset does not fall through to env_file - it REMOVES the variable. So the moment
    // this service gains an env_file, three bare entries here (FIGMA_TOKEN, DS_TEAM_IDS,
    // FRAMEFIT_READ_ONLY) silently start wiping it. The assertion above would stay green through
    // that change; this one does not.
    const block = compose.split(/^ {2}framefit-local:$/m)[1].split(/\n {2}\w[\w-]*:\n/)[0];
    expect(block, 'framefit-local gained an env_file - the bare pass-throughs now wipe it').not.toMatch(/^ {4}env_file:/m);
    // ...and the multi-tenant service still has one, so the check is reading real structure.
    const mt = compose.split(/^ {2}framefit:$/m)[1].split(/\n {2}\w[\w-]*:\n/)[0];
    expect(mt).toMatch(/^ {4}env_file:/m);
  });
});

describe('buildToolDeps populates the read-only gate from the environment', () => {
  it('unset -> no gate at all (today\'s behaviour, byte-for-byte, and now itself gated)', () => {
    expect(deps({}).readOnly).toBeUndefined();
  });

  it('FRAMEFIT_READ_ONLY=true -> a gate that answers true', async () => {
    const gate = deps({ FRAMEFIT_READ_ONLY: 'true' }).readOnly;
    expect(gate).toBeDefined();
    expect(await gate!.isReadOnly()).toBe(true);
  });

  it('the read is lenient and case-insensitive: a malformed value is ignored, never fatal', () => {
    expect(deps({ FRAMEFIT_READ_ONLY: 'TRUE' }).readOnly).toBeDefined();
    expect(deps({ FRAMEFIT_READ_ONLY: 'false' }).readOnly).toBeUndefined();
    expect(deps({ FRAMEFIT_READ_ONLY: '1' }).readOnly).toBeUndefined();     // not a crash
    expect(deps({ FRAMEFIT_READ_ONLY: 'yes' }).readOnly).toBeUndefined();   // not a crash
    expect(deps({ FRAMEFIT_READ_ONLY: '' }).readOnly).toBeUndefined();
  });

  it('a malformed value does not abort loadConfig (index.ts has no catch; on stdio a throw reaches the user as "server failed to start")', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', FRAMEFIT_READ_ONLY: 'sometimes' })).not.toThrow();
  });
});

// The refusal path must not reach buildApi at all - assertWritable runs before it - so these cases
// keep the WIRED deps (readOnly still comes from buildToolDeps, which is the whole point) and swap
// only the api factory for one that throws. Two reasons, both measured: deleting the wiring made
// these rows fail with "[forbidden] Figma denied access (403)", i.e. the write really did go out on
// the wire to api.figma.com under the placeholder token - so a regression would have this unit
// suite talking to Figma; and a stub that throws turns "refused" and "refused after doing it" into
// two visibly different outcomes.
const refusingDeps = (env: Record<string, string>) => ({
  ...deps(env),
  buildApi: (() => { throw new Error('a write reached the Figma adapter despite the read-only gate'); }) as never,
});

describe('the refusal ends at a command the reader can actually run, per mode', () => {
  it('single-tenant names the env var and never mentions a portal that does not exist here', async () => {
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, refusingDeps({ FRAMEFIT_READ_ONLY: 'true' }));
    const res = await call('resolve_comment', { file: 'abc123', comment_id: 'c-1' });
    expect(res.isError).toBe(true);
    const text = textOf(res.content[0]);
    expect(text).toMatch(/read-only/i);
    expect(text).toMatch(/FRAMEFIT_READ_ONLY/);
    expect(text, 'the admin portal UI is not in this repository (docs/deployment.md)').not.toMatch(/portal/i);
  });

  it('post_comment and reply_to_comment are refused the same way', async () => {
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, refusingDeps({ FRAMEFIT_READ_ONLY: 'true' }));
    for (const [name, args] of [
      ['post_comment', { file: 'abc123', message: 'x' }],
      ['reply_to_comment', { file: 'abc123', comment_id: 'c-1', message: 'x' }],
    ] as const) {
      const res = await call(name, args as Record<string, unknown>);
      expect(res.isError, name).toBe(true);
      expect(textOf(res.content[0])).toMatch(/FRAMEFIT_READ_ONLY/);
    }
  });

  it('with the gate unset, writes still proceed', async () => {
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, { ...deps({}), buildApi: () => ({ resolveComment: async () => undefined }) as never });
    const res = await call('resolve_comment', { file: 'abc123', comment_id: 'c-1' });
    expect(res.isError).toBeFalsy();
  });
});

// The OTHER half of "mode-aware", and it lives here rather than next to the multi-tenant server
// tests on purpose: a claim about two modes rots exactly when its two halves are asserted in two
// files. Nothing above would go red if server.ts's multi-tenant deps were handed the single-tenant
// remediation, because that site is reached only through a booted multi-tenant server - so this
// boots one, over the real /mcp path, with a settings source that answers read_only:true.
describe('the multi-tenant refusal still names the portal, over the real /mcp path', () => {
  const ISSUER = 'https://auth.test/realms/mcp';
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
  let handle: ServerHandle;
  let base: string;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey as CryptoKey;
    const jwk: JWK = await exportJWK(pair.publicKey);
    jwk.kid = 'k1'; jwk.alg = 'RS256'; jwk.use = 'sig';
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => (
      String(url).includes('auth.test')
        ? new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : realFetch(url as string, init)
    )));
    initJwt(mtEnv.keycloakJwksUrl, ISSUER);
    handle = await startServer(loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' }), logger, {
      env: mtEnv,
      resolvePat: async () => ({ pat: 'figd_X', label: 'work', status: 'active' }),
      accountsDb: {
        listTokens: async () => [],
        addToken: async () => { throw new Error('unused'); },
        removeToken: async () => false,
        setDefaultToken: async () => false,
        getTokenWithPat: async () => null,
        updateValidation: async () => {},
      },
      pingDb: async () => {},
      settings: { getUserSettings: async () => ({ read_only: true }), setReadOnly: async () => {} },
    });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.close();
    vi.unstubAllGlobals();
  });

  it('a read-only multi-tenant user is pointed at the portal, never at FRAMEFIT_READ_ONLY', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setSubject('u1').setIssuedAt().setExpirationTime('5m')
      .sign(privateKey);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'post_comment', arguments: { file: 'abc123', message: 'x' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/read-only/i);
    expect(body).toMatch(/portal/i);
    expect(body, 'the env var is the SINGLE-TENANT answer; a portal user cannot act on it')
      .not.toMatch(/FRAMEFIT_READ_ONLY/);
  });
});
