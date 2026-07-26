// tests/unit/status.test.ts
import { describe, it, expect, vi } from 'vitest';
import { collectStatus, buildReport, withDeadline, renderText, renderJson, keyFingerprint,
         configCheck, keyCheck, dbCheck, tokensCheck, libraryGraphCheck, figmaCheck,
         CHECKS, CHECK_IDS, PER_CHECK_TIMEOUT_MS,
         type Check, type StatusDb, type TokenStats, type GraphStats } from '../../src/infrastructure/status.js';
import { baseCtx } from './status-fixtures.js';
import { multiTenantEnvGraphConflict } from '../../src/infrastructure/env-graph.js';
import { ENCRYPTION_KEY_HINT } from '../../src/multi-tenant/env.js';
import { signBridgeToken, verifyBridgeToken } from '../../src/multi-tenant/bridge-token.js';

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

  it('fails on a hex key of the wrong length - jose (HS256) signs/verifies happily with any byte length, but aes-256-gcm needs exactly 32 bytes', async () => {
    const r = await run({ env: { ENCRYPTION_KEY: 'deadbeef' } });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toBe(ENCRYPTION_KEY_HINT);
  });

  it('fails WITHOUT any database when sign/verify does not round-trip', async () => {
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, verifyBridgeToken: async () => null });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/round-trip/i);
  });

  it('fails when verify returns a DIFFERENT subject than was signed, not just falsy', async () => {
    // A verifier that returns ANY truthy string (but not the one that was signed) must still fail -
    // truthiness alone is not proof the token round-tripped to the SAME identity.
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, verifyBridgeToken: async () => 'someone-else' });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/round-trip/i);
  });

  it('round-trips a REAL bridge token end to end, not the fixture stub', async () => {
    // status-fixtures.ts stubs both signBridgeToken and verifyBridgeToken to ignore their
    // arguments entirely - wiring the REAL jose-backed pair here is the only thing that proves the
    // check actually exercises sign+verify, not just calls two functions that always agree.
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, signBridgeToken, verifyBridgeToken });
    expect(r.state).toBe('ok');
  });

  it('fails when the ctx signer signs with a DIFFERENT key than env.ENCRYPTION_KEY (real jose catches the drift)', async () => {
    const OTHER_KEY = 'b'.repeat(64);
    const r = await run({
      env: { ENCRYPTION_KEY: KEY },
      // Simulates a wiring bug: the injected signer ignores the secretHex it's handed and always
      // signs with a stale/different key, while verify uses the real env key.
      signBridgeToken: (userId: string, _key: string, ttl: number) => signBridgeToken(userId, OTHER_KEY, ttl),
      verifyBridgeToken,
    });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/round-trip/i);
  });

  it('still runs the sign/verify round-trip when a database IS present (Part 1 must not be skipped)', async () => {
    const db = { listUsers: async () => [], getDefaultPat: async () => null } as unknown as StatusDb;
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, db, verifyBridgeToken: async () => null });
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
      .toMatch(new RegExp(`fingerprint ${keyFingerprint(KEY)}.*cannot authenticate.*1 of 2 users: u2`));
  });

  it('does not blame the key for a pool error', async () => {
    const db = {
      listUsers: async () => ['u1'],
      getDefaultPat: async () => { throw new Error('Database not initialized. Call initDb() first.'); },
    } as unknown as StatusDb;
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, db });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).not.toMatch(/cannot authenticate/);
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

  it('does not dress up zero decrypt evidence as success when no user has a default PAT', async () => {
    // getDefaultPat returns null (not a throw) for a user who has tokens but none marked default
    // (db.ts:183/getDefaultPat). Counting that null as a decrypt success - or even just reporting
    // "0 of 5" with no further comment - reads as a benign zero rather than what it is: NO decrypt
    // attempt actually produced evidence the key works.
    const db = {
      listUsers: async () => ['u1', 'u2', 'u3', 'u4', 'u5'],
      getDefaultPat: async () => null,
    } as unknown as StatusDb;
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, db });
    expect(r).toMatchObject({
      state: 'ok',
      detail: {
        decrypted: '0 of 5',
        no_default: 5,
        decrypt: 'no evidence - no user has a default PAT (the tokens check reports this)',
      },
    });
  });

  it('reports both counts in a mixed case: one user decrypts, one has no default', async () => {
    const db = {
      listUsers: async () => ['u1', 'u2'],
      getDefaultPat: async (u: string) => (u === 'u1' ? { pat: 'figd_x', label: 'l', status: 'active' } : null),
    } as unknown as StatusDb;
    const r = await run({ env: { ENCRYPTION_KEY: KEY }, db });
    expect(r).toMatchObject({ state: 'ok', detail: { decrypted: '1 of 2', no_default: 1 } });
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

const TOKENS: TokenStats = { stored: 1, invalid_total: 0, users_without_default: [], bad_defaults: [],
  soonest_default_expiry: null, last_validated_at: '2026-07-26T00:00:00.000Z', validation_age_sec: 3600 };
const GRAPH: GraphStats = { libraries: 2, variables: 100, teams: 1, users_with_teams_and_no_libraries: [],
  oldest_synced_at: '2026-07-26T00:00:00.000Z', oldest_age_sec: 3600, newest_synced_at: '2026-07-26T01:00:00.000Z' };
// Multi-tenant must be expressed in the ENV: the runner derives the effective mode and ignores a
// caller-supplied `multiTenant` (see the AMENDMENT near the top of this plan).
const MT_MIN = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x' };
const first = (c: Check, over: Parameters<typeof baseCtx>[0]) =>
  collectStatus(baseCtx(over), [c]).then((r) => r.checks[0]);

describe('db check', () => {
  it('is skipped without DATABASE_URL', async () => {
    const r = await first(dbCheck, {});
    expect(r.state).toBe('skipped');
    // Pinned so rewriting the reason to false text goes red - not just the state.
    expect((r as { reason: string }).reason).toMatch(/DATABASE_URL/);
  });
  it('is skipped when DATABASE_URL is set but no db handle was provided', async () => {
    const r = await first(dbCheck, { env: { DATABASE_URL: 'postgres://x' } });
    expect(r.state).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/database handle/);
  });
  it('fails with the Postgres relation name when a table is missing', async () => {
    const db = { listUsers: async () => { throw new Error('relation "figma_tokens" does not exist'); } } as unknown as StatusDb;
    const r = await first(dbCheck, { env: { DATABASE_URL: 'postgres://x' }, db });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/figma_tokens/);
  });
  it('counts users and teams when reachable', async () => {
    const db = { listUsers: async () => ['u1'], listTeams: async () => ['t1', 't2'] } as unknown as StatusDb;
    expect(await first(dbCheck, { env: { DATABASE_URL: 'postgres://x' }, db })).toMatchObject({ state: 'ok', detail: { users: 1, teams: 2 } });
  });
});

describe('tokens check', () => {
  const run = (over: Partial<TokenStats>, multiTenant = true) =>
    first(tokensCheck, { env: multiTenant ? MT_MIN : { DATABASE_URL: 'postgres://x' }, multiTenant, transport: 'http',
      db: { tokenStats: async () => ({ ...TOKENS, ...over }) } as unknown as StatusDb });

  it('fails when a user holds tokens but no default', async () => {
    const r = await run({ users_without_default: ['u1'] });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toContain('u1');
  });
  it('fails on an INVALID default PAT', async () => {
    const r = await run({ bad_defaults: [{ user: 'u1', label: 'ci', problem: 'invalid', expires_at: null }] });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/u1 \(invalid\)/);
  });
  it('fails on an EXPIRED default PAT', async () => {
    const r = await run({ bad_defaults: [{ user: 'u2', label: 'ci', problem: 'expired', expires_at: '2026-01-01' }] });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/u2 \(expired\)/);
  });
  it('does NOT fail on non-default invalid rows, but reports the count', async () => {
    const r = await run({ invalid_total: 3 });
    expect(r).toMatchObject({ state: 'ok', detail: { invalid_non_default: 3 } });
  });
  it('fails in multi-tenant when validation never ran', async () => {
    const r = await run({ last_validated_at: null, validation_age_sec: null });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/never run/i);
  });
  it('fails when validation is older than twice the nightly interval', async () => {
    expect((await run({ validation_age_sec: 60 * 60 * 49 })).state).toBe('fail');
  });
  it('does not judge validation age in single-tenant, and says why the field is empty', async () => {
    const r = await run({ last_validated_at: null, validation_age_sec: null }, false);
    expect(r).toMatchObject({ state: 'ok' });
    expect(JSON.stringify(r)).toMatch(/multi-tenant server process/);
  });
  it('is skipped when nothing is registered yet', async () => {
    const r = await run({ stored: 0 });
    expect(r.state).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/no PATs registered/i);
  });
  it('is skipped without DATABASE_URL', async () => {
    const r = await first(tokensCheck, {});
    expect(r.state).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/DATABASE_URL/);
  });
  it('is skipped when DATABASE_URL is set but no db handle was provided', async () => {
    const r = await first(tokensCheck, { env: { DATABASE_URL: 'postgres://x' } });
    expect(r.state).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/database handle/);
  });
});

describe('library_graph check', () => {
  const run = (over: Partial<GraphStats>) =>
    first(libraryGraphCheck, { env: MT_MIN, multiTenant: true, transport: 'http',
      db: { graphStats: async () => ({ ...GRAPH, ...over }) } as unknown as StatusDb });

  it('is skipped in single-tenant and names the cost of the alternative', async () => {
    const r = await first(libraryGraphCheck, {});
    expect(r.state).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/graph check/);
    expect((r as { reason: string }).reason).toMatch(/minutes/);
  });
  it('is skipped in multi-tenant without DATABASE_URL', async () => {
    // Multi-tenant must be expressed in env (see MT_MIN) - a bare `multiTenant: true`/`transport`
    // with no MULTI_TENANT/MCP_TRANSPORT in env is overwritten back to single-tenant by
    // collectStatus, so this would silently re-test the single-tenant guard above it instead of
    // the DATABASE_URL guard it claims to. Confirmed by mutation: converting EITHER multi-tenant
    // guard in libraryGraphCheck into a `fail` left this test (as originally written) green.
    const r = await first(libraryGraphCheck, { env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http' }, multiTenant: true, transport: 'http' });
    expect(r.state).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/DATABASE_URL/);
  });
  it('is skipped in multi-tenant when DATABASE_URL is set but no db handle was provided', async () => {
    const r = await first(libraryGraphCheck, { env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x' }, multiTenant: true, transport: 'http' });
    expect(r.state).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/database handle/);
  });
  it('is ok on a fresh install with nothing registered', async () => {
    expect((await run({ libraries: 0, variables: 0, teams: 0 })).state).toBe('ok');
  });
  it('fails when teams are registered but nothing synced', async () => {
    const r = await run({ libraries: 0, variables: 0, teams: 2 });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/framefit sync/);
  });
  it('names the actual user when one has teams but zero libraries', async () => {
    const r = await run({ users_with_teams_and_no_libraries: ['11111111-2222-3333-4444-555555555555'] });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toContain('framefit sync --user 11111111-2222-3333-4444-555555555555');
  });
  it('names the actual users even when libraries is GLOBALLY zero, instead of falling back to the generic <id> placeholder', async () => {
    // users_with_teams_and_no_libraries can be populated in the SAME object as libraries===0 (every
    // registered team's owner has nothing synced) - the libraries===0 branch must not shadow the
    // named-user branch in that case.
    const r = await run({ libraries: 0, variables: 0, users_with_teams_and_no_libraries: ['11111111-2222-3333-4444-555555555555'] });
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toContain('framefit sync --user 11111111-2222-3333-4444-555555555555');
    expect((r as { reason: string }).reason).not.toContain('--user <id>');
  });
  it('reports staleness without judging it', async () => {
    expect((await run({ oldest_age_sec: 60 * 60 * 24 * 90 })).state).toBe('ok');
  });
});

describe('figma check', () => {
  it('is skipped with a mode-specific reason when the probe is off', async () => {
    const single = await first(figmaCheck, { env: { FIGMA_TOKEN: 'figd_x' }, probe: false });
    expect((single as { reason: string }).reason).toMatch(/--no-probe/);
    // Multi-tenant must be expressed in env (see MT_MIN above) - a bare `multiTenant: true` with no
    // MULTI_TENANT/MCP_TRANSPORT in env is overwritten back to single-tenant by collectStatus and
    // would silently test the single-tenant branch instead of the multi-tenant one it claims to.
    const mt = await first(figmaCheck, { env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http' }, multiTenant: true, transport: 'http', probe: false });
    expect((mt as { reason: string }).reason).toMatch(/pass --probe/);
  });
  it('reports the HTTP status rather than calling a 429 a rejection', async () => {
    const r = await first(figmaCheck, { env: { FIGMA_TOKEN: 'figd_x' }, probe: true, validatePat: async () => ({ ok: false, status: 429 }) });
    expect((r as { reason: string }).reason).toMatch(/HTTP 429/);
  });
  it('registers the stored PAT as a runtime secret before probing it', async () => {
    const db = { listUsers: async () => ['u1'], getDefaultPat: async () => ({ pat: 'SENTINEL_PAT', label: 'l', status: 'active' }) } as unknown as StatusDb;
    const r = await collectStatus(baseCtx({ env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64) },
      multiTenant: true, transport: 'http', probe: true, db,
      validatePat: async (p) => { throw new Error(`upstream said ${p}`); } }), [figmaCheck]);
    expect(JSON.stringify(r)).not.toContain('SENTINEL_PAT');
  });
  it('counts only users who actually have a default PAT', async () => {
    const db = { listUsers: async () => ['u1', 'u2'], getDefaultPat: async (u: string) => u === 'u1' ? { pat: 'p', label: 'l', status: 'active' } : null } as unknown as StatusDb;
    const r = await first(figmaCheck, { env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64) }, multiTenant: true, transport: 'http', probe: true, db });
    expect(r).toMatchObject({ state: 'ok', detail: { accepted: '1 of 1' } });
  });
  it('is SKIPPED, not a green "0 of 0", when users exist but none has a default PAT', async () => {
    // Nothing was actually probed here - reporting `ok` would render a false [OK] line for a check
    // that never reached Figma at all, and combined with `tokens` being `skipped` at stored===0,
    // a fresh multi-tenant install with zero PATs registered would show ok_overall: true while it
    // cannot call Figma at all.
    const db = { listUsers: async () => ['u1', 'u2'], getDefaultPat: async () => null } as unknown as StatusDb;
    const r = await first(figmaCheck, { env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64) }, multiTenant: true, transport: 'http', probe: true, db });
    expect(r.state).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/tokens check/);
  });
  it('shares the per-check timeout budget across N users instead of handing each one the whole budget', async () => {
    const users = ['u1', 'u2', 'u3', 'u4'];
    const db = {
      listUsers: async () => users,
      getDefaultPat: async () => ({ pat: 'p', label: 'l', status: 'active' }),
    } as unknown as StatusDb;
    const seenTimeouts: (number | undefined)[] = [];
    const validatePat = async (_pat: string, timeoutMs?: number) => { seenTimeouts.push(timeoutMs); return { ok: true as const, handle: 'h' }; };
    await first(figmaCheck, {
      env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'a'.repeat(64) },
      multiTenant: true, transport: 'http', probe: true, db, validatePat,
    });
    const expectedShare = Math.max(1_000, Math.floor(PER_CHECK_TIMEOUT_MS / users.length));
    expect(seenTimeouts).toHaveLength(users.length);
    for (const t of seenTimeouts) expect(t).toBe(expectedShare);
    expect(expectedShare).toBeLessThan(PER_CHECK_TIMEOUT_MS);   // sanity: this is actually a SHARE
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

  it('registers the key check', () => {
    // Same shape of pin as the config-check test above, and for the same reason: `toContain`
    // survives later tasks appending more checks to CHECKS (tokens, library_graph, figma), unlike
    // an exact-array-equality or CHECKS.length assertion would.
    expect(CHECKS.map((c) => c.id)).toContain('key');
  });

  it('registers all six ids, going red if any one is left unregistered', () => {
    // CHECK_IDS is the full intended roster; asserting CHECKS against ITSELF (e.g. a slice of its
    // own ids) is tautological and stays green even if a check is missing from CHECKS entirely.
    // Comparing against the independent CHECK_IDS constant is what makes an unregistered check
    // (e.g. forgetting to add figmaCheck to the CHECKS array literal) go red here.
    expect(CHECKS.map((c) => c.id)).toEqual([...CHECK_IDS]);
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
