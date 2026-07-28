// The multi-tenant audience gate is OPT-IN and OFF by default. docs/deployment.md now says so
// instead of advertising "OIDC (external Keycloak)" flat, and this file is what keeps the sentence
// and the code from drifting apart.
//
// It is written so that changing the BEHAVIOUR turns it red, not only changing the sentence - a
// test that greps a document for a word proves nothing about the server:
//   - the default is read out of loadMultiTenantEnv, not out of the page;
//   - "while it is off, any valid same-realm token is accepted on /accounts" is asserted by
//     admitting one against a running server, at the enforcement value the SHIPPED compose file
//     produces;
//   - "turning it on before the mapper exists 401s every /accounts call" is asserted by refusing a
//     token that has no framefit `aud` - which is exactly what the mapper is for;
//   - the grep needle the page hands the operator is READ OUT OF THE PAGE and matched against the
//     line this server actually writes at boot, so renaming the log event goes red while the page
//     still contains every word it did before;
//   - /mcp staying soft even under ENFORCE_AUDIENCE=true is asserted live, because that asymmetry
//     (server.ts: Claude dynamic-client tokens carry an azp framefit cannot predict) is the part of
//     the page a reader is most likely to disbelieve, and the part a future edit is most likely to
//     "fix" by deleting.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { startServer, type ServerHandle } from '../../src/infrastructure/server.js';
import { initJwt } from '../../src/multi-tenant/jwt.js';
import { loadMultiTenantEnv, type MultiTenantEnv } from '../../src/multi-tenant/env.js';
import { collectStatus, renderJson, renderText } from '../../src/infrastructure/status.js';
import { baseCtx } from './status-fixtures.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const deployment = readFileSync(join(repoRoot, 'docs', 'deployment.md'), 'utf8');
const compose = readFileSync(join(repoRoot, 'docker', 'docker-compose.yml'), 'utf8');
const envExample = readFileSync(join(repoRoot, 'mcp-server', '.env.example'), 'utf8');

const ISSUER = 'https://auth.test/realms/mcp';
const MCP_HOST = 'figma.mcp.example.com';
const AUDIENCE = `https://${MCP_HOST}/mcp`;

let privateKey: CryptoKey;
let publicJwk: JWK;

/** A token this realm really issued: signed by the realm key, valid `iss`, valid `sub`. What varies
 *  is only whether it was minted FOR framefit (`aud`/`azp`) or for some other client in the realm. */
async function sign(claims: { sub?: string; aud?: string | string[]; azp?: string }): Promise<string> {
  const body: Record<string, unknown> = {};
  if (claims.aud !== undefined) body.aud = claims.aud;
  if (claims.azp !== undefined) body.azp = claims.azp;
  return new SignJWT(body)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setSubject(claims.sub ?? 'realm-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
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

interface Booted {
  base: string;
  /** Everything the server wrote through the logger at boot, one serialized line per call. */
  logLines: string[];
  close: () => Promise<void>;
}

async function boot(enforceAudience: boolean): Promise<Booted> {
  const logLines: string[] = [];
  // A real pino logger over a capturing destination, not a stub: what is asserted below is the line
  // an operator reads out of `docker compose logs`, so it has to be the serialized one.
  const logger = createLogger({ level: 'warn', destination: { write: (s: string) => { logLines.push(s); } } });
  const handle: ServerHandle = await startServer(
    loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' }),
    logger,
    {
      env: mtEnv(enforceAudience),
      resolvePat: async () => ({ pat: 'figd_x', label: 'd', status: 'active' as const }),
      // Stubbed so an admitted request reaches a real 200 handler: "not 401" is a weaker claim than
      // "served", and this page's whole point is what a foreign token can actually DO.
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
  return { base: `http://127.0.0.1:${handle.port}`, logLines, close: () => handle.close() };
}

async function getAccounts(base: string, token: string): Promise<number> {
  const res = await fetch(`${base}/accounts`, { headers: { authorization: `Bearer ${token}` } });
  return res.status;
}

async function initializeMcp(base: string, token: string): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return res.status;
}

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

// ── the page ────────────────────────────────────────────────────────────────────────────────────

/** Rows of the "four shapes" table, as trimmed cells. */
function shapeTable(md: string): string[][] {
  return md
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l))
    .map((l) => l.slice(1, l.lastIndexOf('|')).split('|').map((c) => c.trim()));
}

/** The ONE bullet that owns the audience caveat. Asserting over the whole page instead is vacuous:
 *  the words survive anywhere on it, including in a sentence about something else. */
function audienceNote(md: string): string {
  const bullets = md.split(/\n(?=- )/).filter((b) => b.startsWith('- ') && /ENFORCE_AUDIENCE/.test(b));
  expect(bullets, 'exactly one bullet must own the audience caveat').toHaveLength(1);
  // Cut at the next heading: a bullet that ends a section otherwise swallows the prose after it.
  return bullets[0].split(/\n#/)[0];
}

describe('the page states the caveat, on the row it is true of', () => {
  const rows = shapeTable(deployment);

  it('the table parser reads real rows (guards against a vacuous match)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows[0]).toEqual(['Shape', 'Where', 'Auth', 'Guide']);
  });

  it('the multi-tenant Auth cell no longer advertises OIDC without the caveat', () => {
    const mt = rows.filter((r) => /multi-tenant/i.test(r[0]));
    expect(mt, 'the multi-tenant shape row moved or was renamed').toHaveLength(1);
    expect(mt[0][2], 'the Auth cell must not promise a scoped audience it does not enforce')
      .toMatch(/audience/i);
  });

  it('and does not print that caveat on the shapes it is false of', () => {
    // The trap this row exists for: a sentence that is true of one mode and printed in both is
    // false in one of them. stdio, docker-local and single-tenant have no realm and no ENFORCE_AUDIENCE.
    for (const row of rows.filter((r) => r[0] !== 'Shape' && !/multi-tenant/i.test(r[0]))) {
      expect(row.join(' '), `${row[0]} has no Keycloak realm; an audience caveat there is noise`)
        .not.toMatch(/audience|ENFORCE_AUDIENCE/i);
    }
  });

  it('the note names the flag, the consequence, and the Keycloak mapper that gates enabling it', () => {
    const note = audienceNote(deployment);
    expect(note).toMatch(/ENFORCE_AUDIENCE/);
    expect(note, 'the reader must be told what is reachable while it is off, not only what it does when on')
      .toMatch(/same[- ]realm token/i);
    expect(note, 'the reason it is opt-in rather than a default').toMatch(/audience mapper/i);
    expect(note, 'and which API a foreign token reaches').toMatch(/\/accounts/);
    expect(note, 'the /mcp asymmetry is part of the truth, not a footnote').toMatch(/\/mcp/);
  });
});

// ── the page, checked against the server ────────────────────────────────────────────────────────

/**
 * Every `... | grep <needle>` the note hands the operator, in page order, taken from inline CODE
 * SPANS only. Scanning the prose too is what a first draft of this did, and the sentence "a quiet
 * grep is an answer" yielded a third needle, `is`, which every log line contains by substring - a
 * gate that passes on a word rather than on a signal.
 */
function grepNeedles(note: string): string[] {
  const commands = [...note.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((c) => /\bgrep\s/.test(c));
  const found = commands.flatMap((c) => [...c.matchAll(/\bgrep\s+([^\s`|]+)/g)].map((m) => m[1]));
  expect(found.length, 'the note must hand the operator a runnable way to read each signal it promises')
    .toBeGreaterThan(0);
  expect(new Set(found).size, 'each signal is named once; two greps for one needle prove nothing')
    .toBe(found.length);
  return found;
}

/**
 * The page promises TWO log signals, and they are told apart by WHERE the server emits them, never
 * by their order on the page or by matching their text: one is written once at boot (the
 * enforcement verdict), one is written per admitted request (the audience mismatch). Delete either
 * emit and the needle the page names belongs to neither bucket.
 */
async function needlesByOrigin(): Promise<{ boot: string; request: string }> {
  const needles = grepNeedles(audienceNote(deployment));
  const s = await boot(false);
  try {
    const atBoot = s.logLines.join('\n');
    const before = s.logLines.length;
    await getAccounts(s.base, await sign({ aud: 'other-client', azp: 'other-client' }));
    const perRequest = s.logLines.slice(before).join('\n');
    const bootOnly = needles.filter((n) => atBoot.includes(n));
    const requestOnly = needles.filter((n) => perRequest.includes(n));
    expect(bootOnly, 'no needle on the page matches a line this server writes at boot').toHaveLength(1);
    expect(
      requestOnly,
      'no needle on the page matches a line a foreign-audience request produces - the page promises the mismatch is logged',
    ).toHaveLength(1);
    expect(bootOnly[0], 'one needle cannot be both signals').not.toBe(requestOnly[0]);
    return { boot: bootOnly[0], request: requestOnly[0] };
  } finally {
    await s.close();
  }
}

describe('the verdict the page tells the operator to look for is the one the server logs', () => {
  it('the page names exactly two signals: one written at boot, one written per request', async () => {
    const { boot: b, request: r } = await needlesByOrigin();
    expect(grepNeedles(audienceNote(deployment)).sort()).toEqual([b, r].sort());
  });

  it('with enforcement off, the boot log contains the boot needle', async () => {
    const { boot: needle } = await needlesByOrigin();
    const s = await boot(false);
    try {
      expect(
        s.logLines.join('\n'),
        `docs/deployment.md sends the operator to \`grep ${needle}\`, and no line at boot carries it`,
      ).toContain(needle);
    } finally {
      await s.close();
    }
  });

  it('and the log line says what is reachable, not merely that a flag is unset', async () => {
    const s = await boot(false);
    try {
      expect(s.logLines.join('\n')).toMatch(/accounts/);
      expect(s.logLines.join('\n')).toMatch(/same-realm token/);
    } finally {
      await s.close();
    }
  });

  it('and the page is right that `framefit status` is NOT where this shows up', async () => {
    // The page sends the reader to the boot log precisely because the command this repository
    // otherwise trains them to run does not answer this question. That is a claim about the status
    // command, so it is checked against the status command: add an audience verdict there and this
    // row goes red, which is the moment the parenthetical on the page becomes false.
    //
    // The fixture has to be a HEALTHY multi-tenant box, and that is the whole difficulty. Without
    // DATABASE_URL and a db handle, configCheck returns `fail` out of loadMultiTenantEnv before the
    // multi-tenant `ok` branch is ever built and db/tokens/library_graph all skip on the same
    // missing variable - so the render this row inspects does not contain the multi-tenant surface
    // at all, and the row stays GREEN for a mutant that adds an audience verdict to exactly that
    // branch. Measured in both directions; the assertions below are what forbid that fixture.
    const report = await collectStatus(baseCtx({
      env: {
        MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', ENCRYPTION_KEY: 'a'.repeat(64),
        DATABASE_URL: 'postgres://unused', ENFORCE_AUDIENCE: 'false',
        KEYCLOAK_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
        OAUTH_AUTHORIZATION_SERVER: ISSUER, MCP_HOST,
      },
      db: {
        listUsers: async () => ['u1'],
        listTeams: async () => ['t1'],
        getDefaultPat: async () => ({ pat: 'p', label: 'l', status: 'active' }),
        tokenStats: async () => ({
          stored: 1, invalid_non_default: 0, users_without_default: [], users_without_any_token: [],
          bad_defaults: [], soonest_default_expiry: null, validation_age_sec: 3600,
          stale_or_unvalidated_total: 0, future_validation_detected: false,
        }),
        graphStats: async () => ({
          libraries: 1, variables: 5, teams: 1,
          users_with_teams_and_no_libraries: [], users_with_partial_team_gaps: [],
          oldest_synced_at: '2026-07-26T00:00:00.000Z', oldest_age_sec: 3600,
        }),
      },
    }));
    // The guard against the vacuity described above: this has to BE the multi-tenant surface,
    // rendered, before "the word is absent from it" carries any weight.
    expect(report.mode.multi_tenant).toBe(true);
    expect(
      report.checks.find((c) => c.id === 'config'),
      'the fixture must reach the multi-tenant ok branch, not fail before it',
    ).toMatchObject({ state: 'ok', detail: { mode: 'multi-tenant' } });
    expect(
      report.checks.filter((c) => c.state === 'skipped').map((c) => c.id),
      'every multi-tenant check except the opt-in network probe must have really run',
    ).toEqual(['figma']);
    expect(renderText(report) + renderJson(report)).not.toMatch(/audience/i);
  });

  it('with enforcement on, the boot needle is absent - it is a verdict, not a banner', async () => {
    const { boot: needle } = await needlesByOrigin();
    const s = await boot(true);
    try {
      expect(
        s.logLines.join('\n'),
        'the page says the line prints when enforcement is off; an unconditional line makes it a lie',
      ).not.toContain(needle);
    } finally {
      await s.close();
    }
  });
});

// In soft mode this per-request line is the operator's ONLY signal that a foreign client is using
// their /accounts - the page says so and tells them to grep for it, so the emit is gated here.
describe('soft mode logs the mismatch and serves the request anyway - the page promises both halves', () => {
  it('a foreign-audience token is SERVED, and leaves the needle the page names in the log', async () => {
    const { request: needle } = await needlesByOrigin();
    const s = await boot(false);
    try {
      const before = s.logLines.length;
      const status = await getAccounts(s.base, await sign({ aud: 'other-client', azp: 'other-client' }));
      const emitted = s.logLines.slice(before).join('\n');
      expect(status, 'the served half').toBe(200);
      expect(
        emitted,
        `docs/deployment.md sends the operator to \`grep ${needle}\` for admitted mismatches, and this request logged none`,
      ).toContain(needle);
      // The line has to carry WHICH audience was admitted, or it cannot be acted on.
      expect(emitted, 'a bare event name names no client').toMatch(/other-client/);
    } finally {
      await s.close();
    }
  });

  it('and a framefit-scoped token leaves none - a signal, not a line on every request', async () => {
    const { request: needle } = await needlesByOrigin();
    const s = await boot(false);
    try {
      const before = s.logLines.length;
      expect(await getAccounts(s.base, await sign({ aud: AUDIENCE, azp: 'figma-portal' }))).toBe(200);
      expect(
        s.logLines.slice(before).join('\n'),
        'a mismatch line on a matching token makes the grep useless as a detection signal',
      ).not.toContain(needle);
    } finally {
      await s.close();
    }
  });

  it('the same signal covers /mcp, where the mismatch is admitted by design', async () => {
    const { request: needle } = await needlesByOrigin();
    const s = await boot(true);   // enforcement ON: /mcp is still soft, and still has to say so
    try {
      const before = s.logLines.length;
      expect(await initializeMcp(s.base, await sign({ aud: 'other-client', azp: 'other-client' }))).not.toBe(401);
      expect(s.logLines.slice(before).join('\n')).toContain(needle);
    } finally {
      await s.close();
    }
  });
});

// ── the shipped deployment, checked against the server ──────────────────────────────────────────

/** The `environment:` entries of one compose service, comments excluded (same shape as
 *  read-only-wiring.test.ts). A commented line is documentation; only an uncommented one ships. */
function activeEnvironmentOf(service: string): string[] {
  const body = compose.split(new RegExp(`^  ${service}:$`, 'm'))[1] ?? '';
  const upToNextService = body.split(/\n {2}\w[\w-]*:\n/)[0];
  const env = upToNextService.split(/\n {4}environment:\n/)[1] ?? '';
  return [...env.matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1].trim());
}

describe('the deployment this page describes really is the permissive one', () => {
  const active = activeEnvironmentOf('framefit');

  it('the compose parser reads real entries (guards against a vacuous match)', () => {
    expect(active).toContain('MULTI_TENANT=true');
  });

  /** ENFORCE_AUDIENCE as the SHIPPED full-profile container would see it, through the real loader. */
  const shippedEnforcement = (): boolean => {
    const set = active.find((e) => e.startsWith('ENFORCE_AUDIENCE='));
    return loadMultiTenantEnv({
      MULTI_TENANT: 'true',
      DATABASE_URL: 'postgresql://x',
      ENCRYPTION_KEY: 'a'.repeat(64),
      KEYCLOAK_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
      OAUTH_AUTHORIZATION_SERVER: ISSUER,
      MCP_HOST: MCP_HOST,
      ...(set ? { ENFORCE_AUDIENCE: set.slice('ENFORCE_AUDIENCE='.length) } : {}),
    }).enforceAudience;
  };

  it('unset means OFF, and the shipped compose leaves it unset', () => {
    expect(shippedEnforcement(), 'the page documents an off-by-default flag').toBe(false);
  });

  it('and at that value a token minted for another client in the realm is served on /accounts', async () => {
    // The composite the page claims. It goes red if the compose entry is activated, if the loader
    // default flips, or if the /accounts guard stops honouring the flag - three different edits,
    // each of which would make the sentence on the page false.
    const s = await boot(shippedEnforcement());
    try {
      const status = await getAccounts(s.base, await sign({ aud: 'other-client', azp: 'other-client' }));
      expect(status, 'the page says any valid same-realm token is accepted here').toBe(200);
    } finally {
      await s.close();
    }
  });

  it('the commented compose line is a valid entry the moment it is uncommented', () => {
    // "# ENFORCE_AUDIENCE=true" inside a YAML sequence is not a remediation: uncommenting it yields
    // a mapping key where a list item belongs and compose refuses to render the file at all.
    const assignments = compose.split('\n').filter((l) => /ENFORCE_AUDIENCE=/.test(l));
    expect(assignments, 'the compose file must document the flag as exactly one commented entry').toHaveLength(1);
    expect(assignments[0].trim().startsWith('#'), 'the shipped file must not ENABLE it').toBe(true);
    expect(assignments[0].replace(/^(\s*)#\s?/, '$1'), 'uncommenting this line must produce a list entry')
      .toMatch(/^ {6}- ENFORCE_AUDIENCE=true$/);
  });

  it('the compose comment states the consequence of leaving it off, where the operator edits', () => {
    const block = compose.split(/^ {2}framefit:$/m)[1].split(/\n {2}\w[\w-]*:\n/)[0];
    expect(block).toMatch(/same[- ]realm/i);
    expect(block).toMatch(/audience mapper/i);
  });

  it('.env.example says the same two things on the entry an operator would copy', () => {
    const idx = envExample.split('\n').findIndex((l) => /^#?\s*ENFORCE_AUDIENCE=/.test(l));
    expect(idx, 'the documented entry disappeared from .env.example').toBeGreaterThan(-1);
    const comment = envExample.split('\n').slice(Math.max(0, idx - 8), idx).join('\n');
    expect(comment, 'a bare "enable this" line does not tell the reader what off means')
      .toMatch(/same[- ]realm/i);
    expect(comment).toMatch(/audience mapper/i);
  });
});

// ── the two-sided contract itself ───────────────────────────────────────────────────────────────

describe('what the flag does, and what it deliberately does not do', () => {
  it('ON: a realm token with no framefit aud is refused on /accounts - the mapper is why', async () => {
    const s = await boot(true);
    try {
      expect(await getAccounts(s.base, await sign({ azp: 'figma-portal' }))).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('ON: a token minted for another client in the realm is refused on /accounts', async () => {
    const s = await boot(true);
    try {
      expect(await getAccounts(s.base, await sign({ aud: 'other-client', azp: 'other-client' }))).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('ON: the framefit-scoped token is still served, so the gate is not refusing everything', async () => {
    const s = await boot(true);
    try {
      expect(await getAccounts(s.base, await sign({ aud: AUDIENCE, azp: 'figma-portal' }))).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('ON: /mcp stays soft anyway - the page says so because the server does it', async () => {
    const s = await boot(true);
    try {
      expect(
        await initializeMcp(s.base, await sign({ aud: 'other-client', azp: 'other-client' })),
        'server.ts keeps /mcp soft for hosts whose dynamic-client azp framefit cannot predict',
      ).not.toBe(401);
    } finally {
      await s.close();
    }
  });

  it('soft is not open: an unsigned token is still refused on both paths', async () => {
    const s = await boot(false);
    try {
      expect(await getAccounts(s.base, 'not.a.jwt')).toBe(401);
      expect(await initializeMcp(s.base, 'not.a.jwt')).toBe(401);
    } finally {
      await s.close();
    }
  });
});
