import { describe, it, expect, vi } from 'vitest';
import { runCli, isCliCommand, type CliDeps } from '../../src/infrastructure/cli.js';
import { signBridgeToken, verifyBridgeToken } from '../../src/multi-tenant/bridge-token.js';
// makeDeps lives in the shared fixture module: cli.test.ts and the status gates inject the SAME
// CliDeps surface, so a new required field is added in one place, not two that can drift.
import { makeDeps, libraryApi, emptyApi, SINGLE_KEY, MULTI_KEY } from './status-fixtures.js';

const DB_ENV = { DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'ab'.repeat(32) };

describe('isCliCommand', () => {
  it('recognises the allowlisted first arg only', () => {
    expect(isCliCommand(['teams'])).toBe(true);
    expect(isCliCommand(['sync'])).toBe(true);
    expect(isCliCommand(['users'])).toBe(true);
    expect(isCliCommand(['graph'])).toBe(true);
    expect(isCliCommand(['bridge-token'])).toBe(true);
    expect(isCliCommand([])).toBe(false);
    expect(isCliCommand(['serve'])).toBe(false);
    expect(isCliCommand(['--help'])).toBe(false);
  });
});

describe('teams command', () => {
  it('teams add 123 --user u1 → addTeam("u1","123"), exit 0', async () => {
    const { deps, out } = makeDeps({ env: { ...DB_ENV } });
    const code = await runCli(['teams', 'add', '123', '--user', 'u1'], deps);
    expect(code).toBe(0);
    expect(deps.addTeam).toHaveBeenCalledWith('u1', '123');
    expect(out()).toContain('123');
  });

  it('accepts --user=u1 form', async () => {
    const { deps } = makeDeps({ env: { ...DB_ENV } });
    const code = await runCli(['teams', 'add', '123', '--user=u1'], deps);
    expect(code).toBe(0);
    expect(deps.addTeam).toHaveBeenCalledWith('u1', '123');
  });

  it('extracts the id from a /team/<id> URL', async () => {
    const { deps } = makeDeps({ env: { ...DB_ENV } });
    const code = await runCli(['teams', 'add', 'https://www.figma.com/files/x/team/789012?y=1', '--user', 'u1'], deps);
    expect(code).toBe(0);
    expect(deps.addTeam).toHaveBeenCalledWith('u1', '789012');
  });

  it('without --user → exit 1 + usage on stderr, addTeam NOT called', async () => {
    const { deps, err } = makeDeps({ env: { ...DB_ENV } });
    const code = await runCli(['teams', 'add', '123'], deps);
    expect(code).toBe(1);
    expect(deps.addTeam).not.toHaveBeenCalled();
    expect(err()).toMatch(/usage/i);
  });

  it('garbage team id → exit 1 naming the bad token', async () => {
    const { deps, err } = makeDeps({ env: { ...DB_ENV } });
    const code = await runCli(['teams', 'add', 'not-an-id', '--user', 'u1'], deps);
    expect(code).toBe(1);
    expect(deps.addTeam).not.toHaveBeenCalled();
    expect(err()).toMatch(/not-an-id/);
  });

  it('teams list --user u1 → prints the registered teams', async () => {
    const { deps, out } = makeDeps({ env: { ...DB_ENV }, listTeams: vi.fn(async () => ['111', '222']) });
    const code = await runCli(['teams', 'list', '--user', 'u1'], deps);
    expect(code).toBe(0);
    expect(deps.listTeams).toHaveBeenCalledWith('u1');
    expect(out()).toContain('111');
    expect(out()).toContain('222');
  });

  it('teams remove 123 --user u1 → removeTeam("u1","123")', async () => {
    const { deps } = makeDeps({ env: { ...DB_ENV } });
    const code = await runCli(['teams', 'remove', '123', '--user', 'u1'], deps);
    expect(code).toBe(0);
    expect(deps.removeTeam).toHaveBeenCalledWith('u1', '123');
  });

  it('bootstraps + tears down the DB (all three ensureSchema, closeDb in finally)', async () => {
    const { deps } = makeDeps({ env: { ...DB_ENV } });
    await runCli(['teams', 'add', '123', '--user', 'u1'], deps);
    expect(deps.initDb).toHaveBeenCalledTimes(1);
    expect(deps.ensureSchema).toHaveBeenCalledTimes(1);
    expect(deps.ensureLibraryRegistrySchema).toHaveBeenCalledTimes(1);
    expect(deps.ensureLibraryGraphSchema).toHaveBeenCalledTimes(1);
    expect(deps.closeDb).toHaveBeenCalledTimes(1);
  });

  it('closeDb still runs when the command throws', async () => {
    const { deps } = makeDeps({ env: { ...DB_ENV }, addTeam: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(runCli(['teams', 'add', '123', '--user', 'u1'], deps)).rejects.toThrow('boom');
    expect(deps.closeDb).toHaveBeenCalledTimes(1);
  });

  it('no DATABASE_URL → exit 1, initDb never called', async () => {
    const { deps, err } = makeDeps({ env: {} });
    const code = await runCli(['teams', 'add', '123', '--user', 'u1'], deps);
    expect(code).toBe(1);
    expect(deps.initDb).not.toHaveBeenCalled();
    expect(err()).toMatch(/DATABASE_URL/);
  });

  it('a usage error (missing --user) is returned WITHOUT opening the DB, even when DATABASE_URL is set', async () => {
    // Ordering gate: argument validation must precede the DB bootstrap. If withDb ran first, initDb
    // (here a throwing spy, mimicking a bad DATABASE_URL) would mask the usage error with a pg crash.
    const { deps, err } = makeDeps({
      env: { ...DB_ENV },
      initDb: vi.fn(() => { throw new Error('should not connect'); }),
    });
    const code = await runCli(['teams', 'add', '123'], deps);
    expect(code).toBe(1);
    expect(deps.initDb).not.toHaveBeenCalled();
    expect(deps.ensureSchema).not.toHaveBeenCalled();
    expect(err()).toMatch(/usage/i);
  });
});

describe('users command', () => {
  it('prints the distinct keycloak user ids', async () => {
    const { deps, out } = makeDeps({ env: { ...DB_ENV }, listUsers: vi.fn(async () => ['alice', 'bob']) });
    const code = await runCli(['users'], deps);
    expect(code).toBe(0);
    expect(deps.listUsers).toHaveBeenCalledTimes(1);
    expect(out()).toContain('alice');
    expect(out()).toContain('bob');
  });
});

describe('sync command', () => {
  it('no default PAT → exit 1 with a message, syncUser NOT called', async () => {
    const syncSpy = vi.fn(async () => ({ libraries: 0, variables: 0, skipped: 0 }));
    const { deps, err } = makeDeps({
      env: { ...DB_ENV },
      getDefaultPat: vi.fn(async () => null),
      syncUser: syncSpy,
    });
    const code = await runCli(['sync', '--user', 'u1'], deps);
    expect(code).toBe(1);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(err()).toMatch(/PAT/i);
  });

  it('nonzero result → exit 0 + summary on stdout + restart note on stderr', async () => {
    const syncSpy = vi.fn(async () => ({ libraries: 3, variables: 42, skipped: 1 }));
    const { deps, out, err } = makeDeps({
      env: { ...DB_ENV },
      getDefaultPat: vi.fn(async () => ({ pat: 'figd_secret', label: 'default', status: 'active' as const })),
      syncUser: syncSpy,
    });
    const code = await runCli(['sync', '--user', 'u1'], deps);
    expect(code).toBe(0);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(out()).toContain('3');
    expect(out()).toContain('42');
    expect(err()).toMatch(/restart|life of the process/i);
  });

  it('valid PAT but {0,0,0} result (legitimate empty account) → exit 0, distinct from the no-PAT path', async () => {
    const syncSpy = vi.fn(async () => ({ libraries: 0, variables: 0, skipped: 0 }));
    const { deps, out } = makeDeps({
      env: { ...DB_ENV },
      getDefaultPat: vi.fn(async () => ({ pat: 'figd_secret', label: 'default', status: 'active' as const })),
      syncUser: syncSpy,
    });
    const code = await runCli(['sync', '--user', 'u1'], deps);
    expect(code).toBe(0); // a PAT exists and sync ran cleanly — empty is honest, not a failure
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(out()).toContain('0 libraries');
  });

  it('sync without --user → exit 1 usage', async () => {
    const { deps, err } = makeDeps({ env: { ...DB_ENV } });
    const code = await runCli(['sync'], deps);
    expect(code).toBe(1);
    expect(err()).toMatch(/usage/i);
  });

  it('a usage error (missing --user) is returned WITHOUT opening the DB, even when DATABASE_URL is set', async () => {
    // Ordering gate (analogous to teams add): arg validation precedes the DB bootstrap, so a throwing
    // initDb (mimicking a bad DATABASE_URL) can never mask the usage error with a pg crash.
    const { deps, err } = makeDeps({
      env: { ...DB_ENV },
      initDb: vi.fn(() => { throw new Error('should not connect'); }),
    });
    const code = await runCli(['sync'], deps);
    expect(code).toBe(1);
    expect(deps.initDb).not.toHaveBeenCalled();
    expect(deps.ensureSchema).not.toHaveBeenCalled();
    expect(err()).toMatch(/usage/i);
  });
});

describe('graph check (no DB)', () => {
  it('runs with DATABASE_URL unset, prints teams/libraries/variables, exit 0', async () => {
    const { deps, out } = makeDeps({
      env: { FIGMA_TOKEN: 'figd_x', DS_TEAM_IDS: '123' },
      buildApi: () => libraryApi(),
    });
    const code = await runCli(['graph', 'check'], deps);
    expect(code).toBe(0);
    // NO DB path — the bootstrap must never touch the database.
    expect(deps.initDb).not.toHaveBeenCalled();
    expect(deps.closeDb).not.toHaveBeenCalled();
    expect(out()).toMatch(/teams:\s*1/);
    expect(out()).toMatch(/libraries:\s*1/);
    expect(out()).toMatch(/variables:\s*2/);
  });

  it('resolves an optional variable key argument', async () => {
    const { deps, out } = makeDeps({
      env: { FIGMA_TOKEN: 'figd_x', DS_TEAM_IDS: '123' },
      buildApi: () => libraryApi(),
    });
    const code = await runCli(['graph', 'check', SINGLE_KEY], deps);
    expect(code).toBe(0);
    expect(out()).toContain('#ffffff');
    expect(out()).toContain('[good]'); // sourceLibrary surfaced via the resolver wrapper
  });

  it('surfaces modesByName for a multi-mode key (via the resolver wrapper)', async () => {
    const { deps, out } = makeDeps({
      env: { FIGMA_TOKEN: 'figd_x', DS_TEAM_IDS: '123' },
      buildApi: () => libraryApi(),
    });
    const code = await runCli(['graph', 'check', MULTI_KEY], deps);
    expect(code).toBe(0);
    expect(out()).toMatch(/modes=/);
    expect(out()).toContain('Light');
    expect(out()).toContain('Dark');
  });

  it('empty graph (0 libraries) → exit 1', async () => {
    const { deps } = makeDeps({
      env: { FIGMA_TOKEN: 'figd_x', DS_TEAM_IDS: '123' },
      buildApi: () => emptyApi(),
    });
    const code = await runCli(['graph', 'check'], deps);
    expect(code).toBe(1);
  });

  it('missing FIGMA_TOKEN → exit 1', async () => {
    const { deps, err } = makeDeps({ env: { DS_TEAM_IDS: '123' } });
    const code = await runCli(['graph', 'check'], deps);
    expect(code).toBe(1);
    expect(err()).toMatch(/FIGMA_TOKEN/);
  });

  it('missing DS_TEAM_IDS → exit 1', async () => {
    const { deps, err } = makeDeps({ env: { FIGMA_TOKEN: 'figd_x' } });
    const code = await runCli(['graph', 'check'], deps);
    expect(code).toBe(1);
    expect(err()).toMatch(/DS_TEAM_IDS/);
  });

  it('unknown graph subcommand → exit 1 usage', async () => {
    const { deps, err } = makeDeps({ env: { FIGMA_TOKEN: 'figd_x', DS_TEAM_IDS: '123' } });
    const code = await runCli(['graph', 'wat'], deps);
    expect(code).toBe(1);
    expect(err()).toMatch(/usage/i);
  });
});

describe('bridge-token command', () => {
  it('mints a token: bare token on stdout, scope/expiry advice on stderr, exit 0', async () => {
    const sign = vi.fn(async (u: string, _k: string, ttl: number) => `tok.${u}.${ttl}`);
    const { deps, out, err } = makeDeps({ env: { ENCRYPTION_KEY: 'ab'.repeat(32) }, signBridgeToken: sign });
    const code = await runCli(['bridge-token', '--user', 'u1'], deps);
    expect(code).toBe(0);
    // stdout carries ONLY the token (pipes cleanly into a file).
    expect(out()).toBe('tok.u1.1800\n');
    expect(sign).toHaveBeenCalledWith('u1', 'ab'.repeat(32), 1800);
    expect(err()).toMatch(/variables:snapshot/);
    expect(err()).toMatch(/api\/variables\/snapshot/);
  });

  it('honours --ttl', async () => {
    const sign = vi.fn(async (u: string, _k: string, ttl: number) => `tok.${ttl}`);
    const { deps, out } = makeDeps({ env: { ENCRYPTION_KEY: 'ab'.repeat(32) }, signBridgeToken: sign });
    const code = await runCli(['bridge-token', '--user', 'u1', '--ttl', '600'], deps);
    expect(code).toBe(0);
    expect(out()).toBe('tok.600\n');
    expect(sign).toHaveBeenCalledWith('u1', 'ab'.repeat(32), 600);
  });

  it('rejects a non-positive / over-cap / non-integer --ttl without signing', async () => {
    for (const bad of ['0', '-5', '99999999', 'abc']) {
      const sign = vi.fn();
      const { deps, err } = makeDeps({ env: { ENCRYPTION_KEY: 'ab'.repeat(32) }, signBridgeToken: sign as any });
      const code = await runCli(['bridge-token', '--user', 'u1', '--ttl', bad], deps);
      expect(code).toBe(1);
      expect(err()).toMatch(/ttl/i);
      expect(sign).not.toHaveBeenCalled();
    }
  });

  it('missing --user → exit 1 usage, nothing signed', async () => {
    const sign = vi.fn();
    const { deps, err, out } = makeDeps({ env: { ENCRYPTION_KEY: 'ab'.repeat(32) }, signBridgeToken: sign as any });
    const code = await runCli(['bridge-token'], deps);
    expect(code).toBe(1);
    expect(err()).toMatch(/--user/);
    expect(out()).toBe('');
    expect(sign).not.toHaveBeenCalled();
  });

  it('missing ENCRYPTION_KEY → exit 1 with a clear message', async () => {
    const { deps, err } = makeDeps({ env: {} });
    const code = await runCli(['bridge-token', '--user', 'u1'], deps);
    expect(code).toBe(1);
    expect(err()).toMatch(/ENCRYPTION_KEY/);
  });

  // Unverifiable-token lock, with the REAL HS256 signer (not the spy) so the shape guard is what has
  // to hold. Every case below is unusable AS A KEY, but they fail in different ways: too short and
  // non-hex make jose throw a raw DataError/DOMException; wrong-length hex mints a token no server
  // can ever verify (the operator sees only a bare 403); a trailing space truncates during hex decode,
  // so the bytes silently differ from what the operator pasted. All are rejected loudly instead, and
  // nothing may reach stdout in any of them.
  it('malformed ENCRYPTION_KEY + real signer → exit 1, /ENCRYPTION_KEY/ on stderr, nothing on stdout', async () => {
    for (const bad of ['short', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(32)} `]) {
      const { deps, out, err } = makeDeps({ env: { ENCRYPTION_KEY: bad }, signBridgeToken });
      const code = await runCli(['bridge-token', '--user', 'u1'], deps);
      expect(code).toBe(1);
      expect(err()).toMatch(/ENCRYPTION_KEY/);
      expect(out()).toBe('');
    }
  });

  // Positive control on the same real signer: a well-formed key still mints a token that verifies back
  // to the signed user under the snapshot scope, so the guard above rejects only unusable keys.
  it('well-formed ENCRYPTION_KEY + real signer → the token verifies back to the signed user', async () => {
    const key = 'ab'.repeat(32);
    const { deps, out } = makeDeps({ env: { ENCRYPTION_KEY: key }, signBridgeToken });
    const code = await runCli(['bridge-token', '--user', 'u1'], deps);
    expect(code).toBe(0);
    expect(await verifyBridgeToken(out().trim(), key, 'variables:snapshot')).toBe('u1');
  });

  it('stderr advice names the signed id caveat and that tokens cannot be revoked', async () => {
    const { deps, err } = makeDeps({ env: { ENCRYPTION_KEY: 'ab'.repeat(32) } });
    expect(await runCli(['bridge-token', '--user', 'u1'], deps)).toBe(0);
    expect(err()).toMatch(/framefit users/);
    expect(err()).toMatch(/cannot be revoked/);
  });

  // Machine gate: signing is pure crypto — the command must never open a DB connection
  // (mirrors the graph-check no-DB lock).
  it('never opens the database', async () => {
    const initDb = vi.fn(() => { throw new Error('should not connect'); });
    const { deps } = makeDeps({ env: { ENCRYPTION_KEY: 'ab'.repeat(32), DATABASE_URL: 'postgres://x' }, initDb });
    const code = await runCli(['bridge-token', '--user', 'u1'], deps);
    expect(code).toBe(0);
    expect(initDb).not.toHaveBeenCalled();
  });
});

// A COMPLETE multi-tenant environment: loadMultiTenantEnv must accept it, or configCheck fails for a
// reason unrelated to whatever the case is actually about.
const MT_ENV = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x',
  ENCRYPTION_KEY: 'a'.repeat(64), KEYCLOAK_JWKS_URL: 'https://x/certs',
  OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com' };

/** A logger that records what was written to it, for the paths whose only observable output IS a log
 *  line (the pool-error callback and the pool-close fallbacks). */
function capturingLogger(): { logger: CliDeps['logger']; lines: () => string } {
  const seen: string[] = [];
  const logger = { info() {}, debug() {},
    warn: (o: unknown, m: string) => seen.push(`${JSON.stringify(o)} ${m}`),
    error: (o: unknown, m: string) => seen.push(`${JSON.stringify(o)} ${m}`),
    child() { return logger; } } as never;
  return { logger, lines: () => seen.join('\n') };
}

describe('status command', () => {
  it('is a reserved bareword', () => {
    expect(isCliCommand(['status'])).toBe(true);
  });

  it('exits 0 with no failures and always prints the summary', async () => {
    const { deps, out } = makeDeps({ env: {} });
    expect(await runCli(['status', '--no-probe'], deps)).toBe(0);
    expect(out()).toMatch(/\d+ ok, \d+ skipped, 0 failed/);
  });

  it('exits 1 when a check fails', async () => {
    const { deps } = makeDeps({ env: { LOG_LEVEL: 'verbose' } });
    expect(await runCli(['status', '--no-probe'], deps)).toBe(1);
  });

  it('exits 2 when a flag is given a value', async () => {
    const { deps } = makeDeps({ env: {} });
    expect(await runCli(['status', '--json=maybe'], deps)).toBe(2);
  });

  it('exits 2 on an unexpected positional', async () => {
    const { deps } = makeDeps({ env: {} });
    expect(await runCli(['status', 'wat'], deps)).toBe(2);
  });

  it('rejects a misspelled flag rather than silently doing the opposite of what was asked', async () => {
    // --no-prob accepted as "unknown, ignore" would PERFORM the network probe the operator asked to
    // suppress, at exit 0 - a silent inversion of intent, which is worse than a refusal because
    // nothing in the output says the flag was not understood.
    const a = makeDeps({ env: { FIGMA_TOKEN: 'figd_x' } });
    expect(await runCli(['status', '--no-prob'], a.deps)).toBe(2);
    expect(a.deps.validatePat).not.toHaveBeenCalled();
    expect(a.out()).toBe('');
    expect(a.err()).toMatch(/unknown flag --no-prob/);
    // --jsom would hand human text to a JSON consumer, also at exit 0.
    const b = makeDeps({ env: {} });
    expect(await runCli(['status', '--jsom', '--no-probe'], b.deps)).toBe(2);
    expect(b.out()).toBe('');
    expect(b.err()).toMatch(/unknown flag --jsom/);
  });

  it('names the positional a valueless flag swallowed, not just "takes no value"', async () => {
    // parseFlags reads `wat` as the value of --probe, so a message about the flag alone would leave
    // the operator staring at an argument it never mentions.
    const { deps, err } = makeDeps({ env: {} });
    expect(await runCli(['status', '--probe', 'wat'], deps)).toBe(2);
    expect(err()).toMatch(/wat/);
    expect(err()).toMatch(/positional/);
  });

  it('honours --probe under multi-tenant, where the default is OFF, despite parseFlags giving a valueless flag an empty string', async () => {
    // Multi-tenant ON PURPOSE: single-tenant already probes by default, so the single-tenant version
    // of this test stayed green under a mutation that ignored --probe entirely and proved nothing
    // about the flag. Here the default is off, so only the flag can produce the call.
    // --probe is also NOT the last argv token, which is the parseFlags branch that assigns '' because
    // the NEXT token starts with '--' - the empty string this test's title is about.
    const listUsers = vi.fn(async () => ['u1']);
    const getDefaultPat = vi.fn(async () => ({ pat: 'p', label: 'l', status: 'active' }));
    const { deps, out } = makeDeps({ env: MT_ENV, listUsers, getDefaultPat });
    await runCli(['status', '--probe', '--json'], deps);
    expect(deps.validatePat).toHaveBeenCalledTimes(1);
    const figma = JSON.parse(out()).checks.find((c: { id: string }) => c.id === 'figma');
    expect(figma.state).toBe('ok');           // it PROBED, it did not skip
  });

  it('derives the mode with the DEFAULTED transport: MULTI_TENANT + stdio is single-tenant, so it probes', async () => {
    // MULTI_TENANT=true with MCP_TRANSPORT=stdio is NOT multi-tenant - the server would boot
    // single-tenant with no auth layer, which is why configCheck fails on it. Both the probe DEFAULT
    // and the report header must follow that derived mode; an inline `MULTI_TENANT === 'true'` (i.e.
    // not going through effectiveMultiTenant) gets both wrong and this is what catches it.
    const { deps, out } = makeDeps({ env: { MULTI_TENANT: 'true', MCP_TRANSPORT: 'stdio', FIGMA_TOKEN: 'figd_x' } });
    expect(await runCli(['status'], deps)).toBe(1);        // configCheck fails on the mode conflict
    expect(deps.validatePat).toHaveBeenCalledTimes(1);     // probe defaulted ON, i.e. single-tenant
    expect(out()).toContain('single-tenant');
  });

  it('probes by default in single-tenant; --no-probe turns it off and still exits 0', async () => {
    const a = makeDeps({ env: { FIGMA_TOKEN: 'figd_x' } });
    await runCli(['status'], a.deps);
    expect(a.deps.validatePat).toHaveBeenCalledTimes(1);
    const b = makeDeps({ env: { FIGMA_TOKEN: 'figd_x' } });
    expect(await runCli(['status', '--no-probe'], b.deps)).toBe(0);
    expect(b.deps.validatePat).not.toHaveBeenCalled();
  });

  it('does NOT probe by default in multi-tenant, but --probe turns it on', async () => {
    const env = MT_ENV;
    const listUsers = vi.fn(async () => ['u1']);
    const getDefaultPat = vi.fn(async () => ({ pat: 'p', label: 'l', status: 'active' }));
    const off = makeDeps({ env, listUsers, getDefaultPat });
    await runCli(['status'], off.deps);
    expect(off.deps.validatePat).not.toHaveBeenCalled();
    const on = makeDeps({ env, listUsers, getDefaultPat });
    await runCli(['status', '--probe'], on.deps);
    expect(on.deps.validatePat).toHaveBeenCalledTimes(1);
  });

  it('--json puts exactly one document on stdout and the caveat on stderr', async () => {
    const { deps, out, err } = makeDeps({ env: {} });
    await runCli(['status', '--json', '--no-probe'], deps);
    const parsed = JSON.parse(out());
    expect(parsed.checks).toHaveLength(6);
    expect(parsed.checks.map((c: { id: string }) => c.id))
      .toEqual(['config', 'db', 'key', 'tokens', 'library_graph', 'figma']);
    expect(err()).toMatch(/does not see/i);
  });

  it('never opens the database when DATABASE_URL is unset, and always closes it when set', async () => {
    const a = makeDeps({ env: {} });
    await runCli(['status', '--no-probe'], a.deps);
    expect(a.deps.initDb).not.toHaveBeenCalled();
    const b = makeDeps({ env: { DATABASE_URL: 'postgres://x' } });
    await runCli(['status', '--no-probe'], b.deps);
    expect(b.deps.closeDb).toHaveBeenCalledTimes(1);
  });

  it('never runs schema DDL', async () => {
    const { deps } = makeDeps({ env: { DATABASE_URL: 'postgres://x' } });
    await runCli(['status', '--no-probe'], deps);
    expect(deps.ensureSchema).not.toHaveBeenCalled();
    expect(deps.ensureLibraryRegistrySchema).not.toHaveBeenCalled();
    expect(deps.ensureLibraryGraphSchema).not.toHaveBeenCalled();
  });

  it('prints the partial report and exits 2 when the hard deadline fires', async () => {
    const { deps, out, err } = makeDeps({
      env: { DATABASE_URL: 'postgres://x' }, deadlineMs: 50,
      listUsers: () => new Promise<string[]>(() => {}),
    });
    expect(await runCli(['status', '--no-probe'], deps)).toBe(2);
    expect(out()).toMatch(/\[(OK|SKIP|FAIL)\]/);          // whatever finished is still shown
    expect(out()).toMatch(/INCOMPLETE/);                   // and stdout itself admits it was cut short
    expect(err()).toMatch(/did not finish within 50ms/);   // the EFFECTIVE deadline, not the default
  });

  it('marks the exit-2 document incomplete, so --json cannot read as healthy on an aborted run', async () => {
    const { deps, out } = makeDeps({
      env: { DATABASE_URL: 'postgres://x' }, deadlineMs: 50,
      listUsers: () => new Promise<string[]>(() => {}),
    });
    expect(await runCli(['status', '--json', '--no-probe'], deps)).toBe(2);
    const s = JSON.parse(out()).summary;
    expect(s.complete).toBe(false);
    expect(s.ok_overall).toBe(false);   // every per-check field is true; only this says "not a verdict"
  });

  // The hard deadline bounds the CHECKS, not the teardown: pool.end() waits for the clients an
  // abandoned check left mid-query, and initDb builds the pool with no connect timeout, so an
  // unbounded close turned "a dependency is not answering" into a command that never returns at all -
  // verified against a TCP blackhole DSN. The existing deadline test cannot catch this: its fixture
  // closeDb resolves instantly.
  it('still settles with 2 when the pool refuses to close', async () => {
    const { deps, err } = makeDeps({
      env: { DATABASE_URL: 'postgres://x' }, deadlineMs: 30, closeBudgetMs: 20,
      listUsers: () => new Promise<string[]>(() => {}),
      closeDb: vi.fn(() => new Promise<void>(() => {})),
    });
    expect(await runCli(['status', '--no-probe'], deps)).toBe(2);
    expect(err()).toMatch(/did not finish within 30ms/);
  });

  it('does not let a pool that will not close overwrite a verdict it already reached', async () => {
    const { logger, lines } = capturingLogger();
    const { deps, out } = makeDeps({
      env: { DATABASE_URL: 'postgres://x' }, closeBudgetMs: 20, logger,
      closeDb: vi.fn(() => new Promise<void>(() => {})),
    });
    expect(await runCli(['status', '--no-probe'], deps)).toBe(0);   // the report was reached and printed
    expect(out()).toMatch(/0 failed/);
    expect(lines()).toMatch(/pool_close_timed_out/);                // the teardown problem is logged
  });

  it('logs a close FAILURE instead of turning a printed verdict into exit 2, and masks the DSN in it', async () => {
    const { logger, lines } = capturingLogger();
    const { deps } = makeDeps({
      env: { DATABASE_URL: 'postgres://u:SENTINEL_PASS@h/db' }, logger,
      closeDb: vi.fn(async () => { throw new Error('end() failed for postgres://u:SENTINEL_PASS@h/db'); }),
    });
    expect(await runCli(['status', '--no-probe'], deps)).toBe(0);
    expect(lines()).toMatch(/pool_close_failed/);
    expect(lines()).not.toContain('SENTINEL_PASS');
  });

  it('closes the pool even when initDb itself throws', async () => {
    // pg can build the pool before rejecting a malformed DSN, so the close must be reachable from a
    // throwing initDb too. The throw itself stays a throw - the entry point maps it to exit 2.
    const { deps } = makeDeps({
      env: { DATABASE_URL: 'postgres://x' },
      initDb: vi.fn(() => { throw new Error('bad DSN'); }),
    });
    await expect(runCli(['status', '--no-probe'], deps)).rejects.toThrow('bad DSN');
    expect(deps.closeDb).toHaveBeenCalledTimes(1);
  });

  it('redacts a DSN password that arrives through the pool error logger', async () => {
    const { logger, lines } = capturingLogger();
    const { deps } = makeDeps({
      env: { DATABASE_URL: 'postgres://u:SENTINEL_PASS@h/db' }, logger,
      initDb: (url: string, onError?: (e: Error) => void) => { onError?.(new Error(`connect ECONNREFUSED ${url}`)); },
    });
    await runCli(['status', '--no-probe'], deps);
    expect(lines().length).toBeGreaterThan(0);         // the logger really was written to
    expect(lines()).not.toContain('SENTINEL_PASS');
  });
});

describe('unknown command', () => {
  it('returns exit 1 with usage', async () => {
    const { deps, err } = makeDeps({ env: {} });
    const code = await runCli(['frobnicate'], deps);
    expect(code).toBe(1);
    expect(err()).toMatch(/usage|unknown/i);
  });
});
