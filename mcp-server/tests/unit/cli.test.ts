import { describe, it, expect, vi } from 'vitest';
import { runCli, isCliCommand } from '../../src/infrastructure/cli.js';
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

  it('honours --probe even though parseFlags gives valueless flags an empty string', async () => {
    const validatePat = vi.fn(async () => ({ ok: true as const, handle: 'h' }));
    const { deps, out } = makeDeps({ env: { FIGMA_TOKEN: 'figd_x' }, validatePat });
    await runCli(['status', '--probe'], deps);
    expect(validatePat).toHaveBeenCalledTimes(1);
    expect(out()).not.toMatch(/\[SKIP\] figma/);
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
    const env = { MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x',
      ENCRYPTION_KEY: 'a'.repeat(64), KEYCLOAK_JWKS_URL: 'https://x/certs',
      OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com' };
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
    expect(err()).toMatch(/did not finish within 50ms/);   // the EFFECTIVE deadline, not the default
  });

  it('redacts a DSN password that arrives through the pool error logger', async () => {
    const seen: string[] = [];
    const logger = { info() {}, debug() {}, warn: (o: unknown, m: string) => seen.push(JSON.stringify(o) + m),
      error: (o: unknown, m: string) => seen.push(JSON.stringify(o) + m), child() { return logger; } } as never;
    const { deps } = makeDeps({
      env: { DATABASE_URL: 'postgres://u:SENTINEL_PASS@h/db' }, logger,
      initDb: (url: string, onError?: (e: Error) => void) => { onError?.(new Error(`connect ECONNREFUSED ${url}`)); },
    });
    await runCli(['status', '--no-probe'], deps);
    expect(seen.length).toBeGreaterThan(0);            // the logger really was written to
    expect(seen.join('\n')).not.toContain('SENTINEL_PASS');
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
