// tests/unit/status.test.ts
import { describe, it, expect, vi } from 'vitest';
import { collectStatus, buildReport, withDeadline, renderText, renderJson, keyFingerprint,
         configCheck, keyCheck, CHECKS, CHECK_IDS, type Check, type StatusDb } from '../../src/infrastructure/status.js';
import { baseCtx } from './status-fixtures.js';
import { multiTenantEnvGraphConflict } from '../../src/infrastructure/env-graph.js';
import { ENCRYPTION_KEY_HINT } from '../../src/multi-tenant/env.js';

const okCheck: Check = { id: 'config', run: async () => ({ state: 'ok', detail: { a: 1 } }) };

describe('collectStatus', () => {
  it('turns a throwing check into fail, never a missing line', async () => {
    const throwing: Check = { id: 'db', run: async () => { throw new Error('boom'); } };
    const r = await collectStatus(baseCtx(), [okCheck, throwing]);
    expect(r.checks.map((c) => c.id)).toEqual(['config', 'db']);
    expect(r.checks[1]).toMatchObject({ state: 'fail' });
    expect((r.checks[1] as { reason: string }).reason).toContain('boom');
  });

  it('turns a timeout into fail, not skipped', async () => {
    const hanging: Check = { id: 'key', run: () => new Promise(() => {}) };
    const r = await collectStatus(baseCtx(), [hanging], { perCheckTimeoutMs: 20 });
    expect(r.checks[0]).toMatchObject({ state: 'fail' });
    expect((r.checks[0] as { reason: string }).reason).toMatch(/timed out/i);
  });

  it('turns a check that rejects with a non-Error into fail, never a rejected collectStatus', async () => {
    // `throw null` (or `throw undefined`) means `e instanceof Error` is false - `(e as Error).message`
    // would itself throw here and take the whole report down with it.
    const throwsNull: Check = { id: 'db', run: async () => { throw null; } };
    const r = await collectStatus(baseCtx(), [okCheck, throwsNull]);
    expect(r.checks.map((c) => c.id)).toEqual(['config', 'db']);
    expect(r.checks[1]).toMatchObject({ state: 'fail', reason: 'null' });
  });

  it('runs checks sequentially, never concurrently', async () => {
    let live = 0; let peak = 0;
    const slow = (id: string): Check => ({ id, run: async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 10));
      live--; return { state: 'ok', detail: {} };
    } });
    await collectStatus(baseCtx(), [slow('a'), slow('b'), slow('c')]);
    expect(peak).toBe(1);
  });

  it('fills the sink as it goes, so a caller can render a partial report', async () => {
    const sink: unknown[] = [];
    const hanging: Check = { id: 'key', run: () => new Promise(() => {}) };
    const work = collectStatus(baseCtx(), [okCheck, hanging], { perCheckTimeoutMs: 5_000, sink: sink as never });
    await new Promise((r) => setTimeout(r, 30));
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ id: 'config', state: 'ok' });
    void work;
  });

  it('summarises, and ok_overall is false as soon as anything failed', async () => {
    const bad: Check = { id: 'db', run: async () => ({ state: 'fail', reason: 'unreachable' }) };
    const skip: Check = { id: 'figma', run: async () => ({ state: 'skipped', reason: 'off' }) };
    const green = await collectStatus(baseCtx(), [okCheck, skip]);
    expect(green.summary).toEqual({ total: 2, ok: 1, skipped: 1, failed: 0, ok_overall: true });
    const red = await collectStatus(baseCtx(), [okCheck, bad, skip]);
    expect(red.summary).toEqual({ total: 3, ok: 1, skipped: 1, failed: 1, ok_overall: false });
  });

  it('stamps generated_at from the injected clock, not the wall clock', async () => {
    const r = await collectStatus(baseCtx(), [okCheck]);
    expect(r.generated_at).toBe('2023-11-14T22:13:20.000Z');
  });

  it('reports the effective mode and where the transport came from', async () => {
    const unset = await collectStatus(baseCtx(), [okCheck]);
    expect(unset.mode).toEqual({ multi_tenant: false, transport: null, transport_source: 'unset' });
    // multi_tenant is now DERIVED from env (collectStatus overwrites ctx.multiTenant), so the mode
    // must be expressed through the environment, not just the ctx.multiTenant/transport fields -
    // a caller passing multiTenant: true with no MULTI_TENANT in env would no longer see it reflected.
    const env = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http' };
    const mt = await collectStatus(baseCtx({ env, multiTenant: true, transport: 'http' }), [okCheck]);
    expect(mt.mode).toEqual({ multi_tenant: true, transport: 'http', transport_source: 'env' });
  });

  it('wires key_fingerprint from the environment', async () => {
    const env = { ENCRYPTION_KEY: 'ab'.repeat(32) };
    const r = await collectStatus(baseCtx({ env }), [okCheck]);
    expect(r.key_fingerprint).toBe(keyFingerprint(env.ENCRYPTION_KEY));
    expect(r.key_fingerprint).not.toBeNull();
  });
});

describe('withDeadline', () => {
  it('resolves null when the work outlives it', async () => {
    expect(await withDeadline(new Promise(() => {}), 20)).toBeNull();
  });
  it('passes the value through otherwise', async () => {
    expect(await withDeadline(Promise.resolve('x'), 1_000)).toBe('x');
  });

  it('propagates a rejection promptly and clears its own timer, leaving nothing pending', async () => {
    // A `.then()`-only implementation clears the timer on the fulfilled path but not the rejected
    // one - the returned promise still rejects promptly (Promise.race rejects as soon as any
    // input does), but the now ref'd deadline timer is left dangling for the full `ms`, which
    // would keep a real process alive well past when `work` already settled.
    vi.useFakeTimers();
    try {
      const result = withDeadline(Promise.reject(new Error('boom')), 5_000);
      await expect(result).rejects.toThrow('boom');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('keyFingerprint', () => {
  it('ignores hex case and surrounding whitespace', () => {
    expect(keyFingerprint('AABB'.repeat(16))).toBe(keyFingerprint(` ${'aabb'.repeat(16)}\n`));
  });
  it('DISCRIMINATES different keys', () => {
    expect(keyFingerprint('aa'.repeat(32))).not.toBe(keyFingerprint('bb'.repeat(32)));
  });
  it('is null for absent or non-hex input', () => {
    expect(keyFingerprint(undefined)).toBeNull();
    expect(keyFingerprint('zz')).toBeNull();
  });
});

describe('redaction', () => {
  it('removes env secrets that leak in through an error message', async () => {
    const env = { FIGMA_TOKEN: 'SENTINEL_TOKEN', ENCRYPTION_KEY: 'de'.repeat(32) };
    const leaky: Check = { id: 'db', run: async () => { throw new Error(`bad token SENTINEL_TOKEN key ${'de'.repeat(32)}`); } };
    const r = await collectStatus(baseCtx({ env }), [leaky]);
    const reason = (r.checks[0] as { reason: string }).reason;
    expect(reason).not.toContain('SENTINEL_TOKEN');
    expect(reason).not.toContain('de'.repeat(32));
    expect(reason).toContain('<redacted:FIGMA_TOKEN>');   // positive control
    expect(reason).toContain('bad token');                 // the message stays useful
  });

  it('strips only the credentials of a DATABASE_URL, keeping the host', async () => {
    const env = { DATABASE_URL: 'postgres://user:SENTINEL_PASS@db.internal:5432/framefit' };
    const leaky: Check = { id: 'db', run: async () => { throw new Error('connect ECONNREFUSED postgres://user:SENTINEL_PASS@db.internal:5432/framefit'); } };
    const r = await collectStatus(baseCtx({ env }), [leaky]);
    const reason = (r.checks[0] as { reason: string }).reason;
    expect(reason).not.toContain('SENTINEL_PASS');
    expect(reason).toContain('db.internal');   // the host is the diagnostic value
  });

  it('redacts a DATABASE_URL password even when it appears bare, outside any URL shape', async () => {
    // A driver reports "password authentication failed for user ...: <password>" with no URL
    // in sight - the password must still be masked because it was decoded out of DATABASE_URL.
    const env = { DATABASE_URL: 'postgres://user:SENTINEL_PASS@db.internal:5432/framefit' };
    const leaky: Check = { id: 'db', run: async () => { throw new Error('password authentication failed for user "user": SENTINEL_PASS'); } };
    const r = await collectStatus(baseCtx({ env }), [leaky]);
    const reason = (r.checks[0] as { reason: string }).reason;
    expect(reason).not.toContain('SENTINEL_PASS');
    expect(reason).toContain('<redacted:DATABASE_URL>');
  });

  it('does not corrupt unrelated text when the DATABASE_URL password is too short to safely substring-replace', async () => {
    // A short dev password (e.g. "ab") gated in like every other secret would still get pushed
    // into the substitution list without a length check, and blind `.split(needle).join(mask)`
    // then clobbers any unrelated occurrence of that 2-character substring anywhere in the text.
    const env = { DATABASE_URL: 'postgres://appuser:ab@db.internal:5432/framefit' };
    const leaky: Check = { id: 'db', run: async () => ({ state: 'fail', reason: 'table "users" does not exist' }) };
    const r = await collectStatus(baseCtx({ env }), [leaky]);
    expect((r.checks[0] as { reason: string }).reason).toBe('table "users" does not exist');
  });

  it('does NOT redact DS_TEAM_IDS - team ids are not secrets and the message must stay actionable', async () => {
    const env = { DS_TEAM_IDS: '1234567890123456789' };
    const leaky: Check = { id: 'config', run: async () => ({ state: 'fail', reason: 'invalid team id: 1234567890123456789' }) };
    const r = await collectStatus(baseCtx({ env }), [leaky]);
    expect((r.checks[0] as { reason: string }).reason).toContain('1234567890123456789');
  });

  it('redacts a runtime secret the check adds to ctx.secrets DURING its own run(), and walks nested detail', async () => {
    // The redactor must not be built from a snapshot of ctx.secrets taken before any check has
    // run: a check adds its decrypted PAT to ctx.secrets mid-flight, then lets it near a call
    // whose error can quote it. Pre-seeding ctx.secrets before collectStatus (the old version of
    // this test) cannot catch a redactor that only reads the set once, up front.
    const ctx = baseCtx();
    const leaky: Check = { id: 'figma', run: async () => {
      ctx.secrets.add('SENTINEL_PAT');
      return {
        state: 'fail' as const, reason: 'call failed for SENTINEL_PAT',
        detail: { nested: { token: 'SENTINEL_PAT' }, list: ['SENTINEL_PAT'] },
      };
    } };
    const r = await collectStatus(ctx, [leaky]);
    expect(JSON.stringify(r.checks[0])).not.toContain('SENTINEL_PAT');
  });

  it('folds non-ASCII typographic characters in a reason down to ASCII', async () => {
    // Real pg/undici/OS error text carries characters like these that no check author typed by
    // hand; the ASCII-only global constraint has to hold for them too.
    const reason = 'connection refused — retrying… “please wait”';
    const leaky: Check = { id: 'db', run: async () => ({ state: 'fail', reason }) };
    const r = await collectStatus(baseCtx(), [leaky]);
    const got = (r.checks[0] as { reason: string }).reason;
    expect(got).not.toMatch(/[^\x00-\x7F]/);
    expect(got).toBe('connection refused - retrying... "please wait"');
  });
});

describe('renderText', () => {
  it('uses ASCII-only bracketed states at column 0 and always prints the summary', async () => {
    const bad: Check = { id: 'db', run: async () => ({ state: 'fail', reason: 'unreachable' }) };
    const text = renderText(await collectStatus(baseCtx(), [okCheck, bad]), 80);
    expect(text).toMatch(/^\[OK\]  {2}config/m);
    expect(text).toMatch(/^\[FAIL\] db/m);
    expect(text).toMatch(/1 ok, 0 skipped, 1 failed/);
    expect(text).not.toMatch(/[^\x00-\x7F]/);
  });

  it('prints the key fingerprint in the header - the human path is where keys get compared', async () => {
    const text = renderText(await collectStatus(baseCtx({ env: { ENCRYPTION_KEY: 'ab'.repeat(32) } }), [okCheck]));
    expect(text).toContain(keyFingerprint('ab'.repeat(32))!);
  });

  it('never truncates a user id and never splits it across a wrap', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const bad: Check = { id: 'tokens', run: async () => ({ state: 'fail', reason: `these users hold tokens but no default token, so every request of theirs fails: ${uuid}` }) };
    const text = renderText(await collectStatus(baseCtx(), [bad]), 60);
    expect(text.split('\n').some((l) => l.includes(uuid))).toBe(true);   // contiguous on ONE line
    const continuation = text.split('\n').filter((l) => /^\s{23}\S/.test(l));
    expect(continuation.length).toBeGreaterThan(0);                      // it did wrap
    expect(text).not.toContain('...');                                   // and did not truncate
  });

  it('actually wraps: no rendered check line exceeds the requested width, barring a single unsplittable token', async () => {
    // A "wrap" that just prepends the indent without ever breaking the body (e.g. `prefix + '\n' +
    // INDENT + body`) would still pass every other assertion in this file - nothing else checks
    // that a line actually fits inside `width`. (The header/footer lines are never wrapped by
    // design, so only the check lines - state-tagged or continuation-indented - are in scope.)
    const long = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua';
    const bad: Check = { id: 'db', run: async () => ({ state: 'fail', reason: long }) };
    const width = 60;
    const text = renderText(await collectStatus(baseCtx(), [bad]), width);
    const checkLines = text.split('\n').filter((l) => /^\[(OK|FAIL|SKIP)\]/.test(l) || /^ {23}\S/.test(l));
    expect(checkLines.length).toBeGreaterThan(1);   // sanity: it actually wrapped into multiple lines
    for (const line of checkLines) {
      const hasUnsplittableOverlongToken = line.split(/\s+/).some((tok) => tok.length > width);
      if (!hasUnsplittableOverlongToken) expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});

describe('renderJson', () => {
  it('emits exactly one parseable document carrying schema and scope', async () => {
    const parsed = JSON.parse(renderJson(await collectStatus(baseCtx(), [okCheck])));
    expect(parsed.schema).toBe(1);
    expect(parsed.scope).toEqual({ hostname: 'box', pid: 7, env_source: 'process' });
    expect(parsed.summary.total).toBe(1);
  });
});

describe('config check', () => {
  // Route through collectStatus, not check.run: redaction and throw->fail live in the runner, and
  // the shipped behaviour is what these must pin.
  const run = (over: Parameters<typeof baseCtx>[0]) =>
    collectStatus(baseCtx(over), [configCheck]).then((r) => r.checks[0]);

  it('fails on the DS_TEAM_IDS + MULTI_TENANT boot conflict', async () => {
    const r = await run({ env: { MULTI_TENANT: 'true', DS_TEAM_IDS: '123', MCP_TRANSPORT: 'http' }, multiTenant: true, transport: 'http' });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/DS_TEAM_IDS/);
  });

  it("fails with loadConfig's own message on an invalid enum", async () => {
    const r = await run({ env: { LOG_LEVEL: 'verbose' } });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/LOG_LEVEL/);
  });

  it('accepts multi-tenant with MCP_TRANSPORT unset (http is the zod default)', async () => {
    const env = { MULTI_TENANT: 'true', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64),
                  KEYCLOAK_JWKS_URL: 'https://x/certs', OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com' };
    const r = await run({ env, multiTenant: true, transport: undefined });
    expect(r.state).toBe('ok');
  });

  it('fails when multi-tenant is declared with a non-http transport', async () => {
    const r = await run({ env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'stdio' }, multiTenant: false, transport: 'stdio' });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/stdio/);
  });

  it("fails with loadMultiTenantEnv's message when MCP_HOST is missing", async () => {
    const env = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64), KEYCLOAK_JWKS_URL: 'https://x/certs', OAUTH_AUTHORIZATION_SERVER: 'https://x' };
    const r = await run({ env, multiTenant: true, transport: 'http' });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/MCP_HOST/);
  });

  it('does NOT require PUBLIC_BASE_URL', async () => {
    const env = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64), KEYCLOAK_JWKS_URL: 'https://x/certs', OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com' };
    expect((await run({ env, multiTenant: true, transport: 'http' })).state).toBe('ok');
  });

  it('treats an absent FIGMA_TOKEN in single-tenant as ok with the per-call nuance', async () => {
    const r = await run({ env: {} });
    expect(r.state).toBe('ok');
    expect(JSON.stringify(r)).toMatch(/per-call/);
  });

  it('fails when DS_TEAM_IDS is set without FIGMA_TOKEN', async () => {
    const r = await run({ env: { DS_TEAM_IDS: '1234567890123456789' } });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/FIGMA_TOKEN/);
  });

  it("fails with parseTeamIds' message, naming the bad id (not redacted)", async () => {
    const r = await run({ env: { FIGMA_TOKEN: 'figd_x', DS_TEAM_IDS: 'not-a-team' } });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toContain('not-a-team');
  });

  it('branches on the EFFECTIVE mode (isMultiTenant(ctx.env)), not the caller-supplied ctx.multiTenant', async () => {
    // A stale/wrong ctx.multiTenant must not paper over an env that would actually crash-loop the
    // box: index.ts decides multi-tenant purely from isMultiTenant(env), so the check must too.
    const env = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http' };
    const r = await run({ env, multiTenant: false, transport: 'http' });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/Missing required multi-tenant env vars/);
  });

  it("fails with loadMultiTenantEnv's own wording on a non-hex ENCRYPTION_KEY", async () => {
    const env = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x',
                  ENCRYPTION_KEY: 'not-hex-and-not-64-chars',
                  KEYCLOAK_JWKS_URL: 'https://x/certs', OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com' };
    const r = await run({ env, multiTenant: true, transport: 'http' });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toBe(ENCRYPTION_KEY_HINT);
  });

  it('treats MULTI_TENANT case-insensitively (isMultiTenant, not an exact string compare)', async () => {
    const env = { MULTI_TENANT: 'TRUE', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64),
                  KEYCLOAK_JWKS_URL: 'https://x/certs', OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com' };
    const r = await run({ env, multiTenant: false, transport: 'http' });
    expect(r.state).toBe('ok');
    expect(JSON.stringify(r)).toMatch(/"mode":"multi-tenant"/);
  });

  it("accepts a figma.com/team/<id> URL in DS_TEAM_IDS, pinning the real parseTeamIds (not a bare digit/comma regex)", async () => {
    const r = await run({ env: { FIGMA_TOKEN: 'figd_x', DS_TEAM_IDS: 'https://www.figma.com/team/123456789/My-Team' } });
    expect(r.state).toBe('ok');
    expect(JSON.stringify(r)).toMatch(/"ds_team_ids":1/);
  });

  it('fails on the boot conflict even with an otherwise-complete multi-tenant env, matching multiTenantEnvGraphConflict verbatim', async () => {
    const env = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DS_TEAM_IDS: '123',
                  DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64),
                  KEYCLOAK_JWKS_URL: 'https://x/certs', OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com' };
    const r = await run({ env, multiTenant: true, transport: 'http' });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toBe(multiTenantEnvGraphConflict(env));
  });

  it('treats a blank DS_TEAM_IDS (whitespace only) as unset, matching the production trim gate', async () => {
    const r = await run({ env: { DS_TEAM_IDS: '   ' } });
    expect(r.state).toBe('ok');
  });
});

describe('key check', () => {
  const KEY = 'a'.repeat(64);
  const run = (over: Parameters<typeof baseCtx>[0]) =>
    collectStatus(baseCtx(over), [keyCheck]).then((r) => r.checks[0]);

  it('is skipped when no ENCRYPTION_KEY is set', async () => {
    expect((await run({})).state).toBe('skipped');
  });

  it('fails WITHOUT any database when sign/verify does not round-trip', async () => {
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, verifyBridgeToken: async () => null });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/round-trip/i);
  });

  it('names the fingerprint and the failing users on a decrypt mismatch', async () => {
    const db = {
      listUsers: async () => ['u1', 'u2'],
      getDefaultPat: async (u: string) => {
        if (u === 'u2') throw new Error('Unsupported state or unable to authenticate data');
        return { pat: 'figd_x', label: 'l', status: 'active' };
      },
    } as unknown as StatusDb;
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, db });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason)
      .toMatch(new RegExp(`fingerprint ${keyFingerprint(KEY)}.*1 of 2 users: u2`));
  });

  it('does not blame the key for a pool error', async () => {
    const db = {
      listUsers: async () => ['u1'],
      getDefaultPat: async () => { throw new Error('Database not initialized. Call initDb() first.'); },
    } as unknown as StatusDb;
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, db });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).not.toMatch(/does not match/);
    expect((r as { reason: string }).reason).toMatch(/could not read/);
  });

  it('reports k of n when every stored default PAT decrypts', async () => {
    const db = {
      listUsers: async () => ['u1', 'u2'],
      getDefaultPat: async () => ({ pat: 'figd_x', label: 'l', status: 'active' }),
    } as unknown as StatusDb;
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, db });
    expect(r).toMatchObject({ state: 'ok', detail: { decrypted: '2 of 2' } });
  });
});

describe('effective mode consistency (header vs. config check)', () => {
  it('reports multi-tenant in BOTH the report header and the config check detail, even when the caller passes multiTenant: false', async () => {
    // Before effectiveMultiTenant() centralised the derivation, buildReport read the caller's
    // ctx.multiTenant while configCheck read ctx.env directly - a caller passing a stale/wrong
    // flag could make these two disagree in one report (header says single-tenant, the config
    // line says multi-tenant, or vice versa). Deriving the mode once in collectStatus and
    // overwriting ctx.multiTenant before either runs makes that divergence structurally
    // impossible; this test pins the observable guarantee end to end, through renderText too.
    const env = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64),
                  KEYCLOAK_JWKS_URL: 'https://x/certs', OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com' };
    const report = await collectStatus(baseCtx({ env, multiTenant: false, transport: 'http' }), [configCheck]);
    expect(report.mode.multi_tenant).toBe(true);
    expect(report.checks[0]).toMatchObject({ state: 'ok', detail: { mode: 'multi-tenant' } });
    const text = renderText(report);
    expect(text).toMatch(/^framefit \S+ {2}multi-tenant {2}/m);
    expect(text).toMatch(/mode=multi-tenant/);
  });
});

describe('CHECKS registry', () => {
  it('registers the config check', () => {
    // Anchored to a fixed id, NOT to CHECKS.length: `CHECKS.map(c=>c.id)` equals
    // `CHECK_IDS.slice(0, CHECKS.length)` trivially when CHECKS is [] (both sides are []), so that
    // comparison alone would leave a reverted `export const CHECKS = []` green. This must go red
    // whenever `config` is missing, regardless of what else CHECKS does or does not contain yet.
    expect(CHECKS.map((c) => c.id)).toContain('config');
  });

  it('registers checks in CHECK_IDS order, with no duplicate ids', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const knownIds: readonly string[] = CHECK_IDS;
    const positions = ids.map((id) => knownIds.indexOf(id));
    expect(positions).not.toContain(-1);   // every registered id is a known CHECK_ID
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);     // and they appear in CHECK_IDS order
  });
});
