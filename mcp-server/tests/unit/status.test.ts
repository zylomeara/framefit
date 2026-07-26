// tests/unit/status.test.ts
import { describe, it, expect } from 'vitest';
import { collectStatus, buildReport, withDeadline, renderText, renderJson, keyFingerprint,
         type Check } from '../../src/infrastructure/status.js';
import { baseCtx } from './status-fixtures.js';

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
    const mt = await collectStatus(baseCtx({ multiTenant: true, transport: 'http' }), [okCheck]);
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
