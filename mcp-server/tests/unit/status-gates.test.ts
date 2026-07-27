// tests/unit/status-gates.test.ts
//
// The GATES for `framefit status`: the assertions whose whole job is to go red when the command grows
// a false green. Everything here is written against the SHIPPED surface - collectStatus, the two
// renderers, docs/status.md and the CLI - never against a check's run() in isolation, because the
// throw-to-fail conversion, the effective-mode derivation and secret redaction all live in the runner.
//
// Every gate in this file was confirmed red against a deliberately wrong implementation before being
// committed (see .superpowers/sdd/2026-07-26-framefit-status/task-8-report.md for the table).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CHECKS, CHECK_IDS, collectStatus, buildReport, renderText, renderJson,
  type Check, type StatusCtx, type StatusDb, type StatusReport,
  type TokenStats, type GraphStats,
} from '../../src/infrastructure/status.js';
import { runCli } from '../../src/infrastructure/cli.js';
import { baseCtx, makeDeps } from './status-fixtures.js';

// A LITERAL list, written here and nowhere else. Asserting CHECKS against CHECK_IDS would be
// self-referential: deleting a check plus its id keeps every gate green while the output gets
// strictly greener.
const EXPECTED_IDS = ['config', 'db', 'key', 'tokens', 'library_graph', 'figma'];

describe('the registry', () => {
  it('is exactly the expected set, in order', () => {
    expect(CHECKS.map((c) => c.id)).toEqual(EXPECTED_IDS);
    expect([...CHECK_IDS]).toEqual(EXPECTED_IDS);
  });
});

// Multi-tenant is derived from the ENVIRONMENT by the runner (effectiveMultiTenant), which OVERWRITES
// whatever ctx.multiTenant a caller passed - so a fixture that means "multi-tenant" has to say so in
// env with BOTH MULTI_TENANT and the http transport, or it silently exercises single-tenant instead.
const MT = {
  MULTI_TENANT: 'true', MCP_TRANSPORT: 'http', DATABASE_URL: 'postgres://x',
  ENCRYPTION_KEY: 'a'.repeat(64), KEYCLOAK_JWKS_URL: 'https://x/certs',
  OAUTH_AUTHORIZATION_SERVER: 'https://x', MCP_HOST: 'f.example.com',
};

// The PRODUCTION default shape, and the reason it gets its own fixture: the compose full profile
// sets MULTI_TENANT=true and NEVER sets MCP_TRANSPORT (docker/docker-compose.yml), so every real
// multi-tenant box relies on the transport DEFAULT ('http', config.ts) to be read as multi-tenant at
// all. MT above states the transport explicitly, which means it exercises none of that defaulting.
const { MCP_TRANSPORT: _MT_TRANSPORT, ...MT_DEFAULT_TRANSPORT } = MT;

// Typed against the REAL aggregate interfaces, never `as never`: a field added to TokenStats or
// GraphStats (a staleness counter, a clock-skew fact) must fail to compile here rather than arrive as
// `undefined` and turn every green fixture into an accidental TypeError-shaped `fail`.
const TOKENS_OK: TokenStats = {
  stored: 1, invalid_non_default: 0, users_without_default: [], users_without_any_token: [],
  bad_defaults: [], soonest_default_expiry: null,
  last_validated_at: '2026-07-26T00:00:00.000Z', validation_age_sec: 3600,
  stale_or_unvalidated_total: 0, future_validation_detected: false,
};
const GRAPH_OK: GraphStats = {
  libraries: 1, variables: 5, teams: 1,
  users_with_teams_and_no_libraries: [], users_with_partial_team_gaps: [],
  oldest_synced_at: '2026-07-26T00:00:00.000Z', oldest_age_sec: 3600,
  newest_synced_at: '2026-07-26T00:00:00.000Z',
};
const okDb: StatusDb = {
  listUsers: async () => ['u1'],
  listTeams: async () => ['t1'],
  getDefaultPat: async () => ({ pat: 'p', label: 'l', status: 'active' }),
  tokenStats: async () => TOKENS_OK,
  graphStats: async () => GRAPH_OK,
};

const MT_DB: Partial<StatusCtx> = { env: MT, multiTenant: true, transport: 'http', db: okDb };

// Each id gets BOTH a green and a red fixture. Red alone is satisfiable by a check hardcoded to
// fail; the pair proves the red is attributable to the fixture delta and to nothing else.
//
// `mode` is a DECLARED expectation, not a description: the row below asserts the report's own
// mode.multi_tenant against it for BOTH halves. The effective mode is derived from env and
// overwrites ctx.multiTenant, so a fixture missing MULTI_TENANT or MCP_TRANSPORT=http silently runs
// single-tenant while reading as multi-tenant - three earlier rounds shipped exactly that, and the
// check then exercises a branch nobody meant to test.
type Fixture = { mode: 'single-tenant' | 'multi-tenant'; green: Partial<StatusCtx>; red: Partial<StatusCtx> };
const FIXTURES: Record<string, Fixture> = {
  config: { mode: 'single-tenant', green: { env: {} }, red: { env: { LOG_LEVEL: 'verbose' } } },
  db: {
    mode: 'multi-tenant',
    green: MT_DB,
    red: { ...MT_DB, db: { ...okDb, listUsers: async () => { throw new Error('relation "figma_tokens" does not exist'); } } },
  },
  key: {
    mode: 'single-tenant',
    green: { env: { ENCRYPTION_KEY: 'a'.repeat(64) } },
    red: { env: { ENCRYPTION_KEY: 'a'.repeat(64) }, verifyBridgeToken: async () => null },
  },
  tokens: {
    mode: 'multi-tenant',
    green: MT_DB,
    red: { ...MT_DB, db: { ...okDb, tokenStats: async () => ({ ...TOKENS_OK, users_without_default: ['u1'] }) } },
  },
  library_graph: {
    mode: 'multi-tenant',
    green: MT_DB,
    red: { ...MT_DB, db: { ...okDb, graphStats: async () => ({ ...GRAPH_OK, libraries: 0, variables: 0, teams: 2 }) } },
  },
  figma: {
    mode: 'single-tenant',
    green: { env: { FIGMA_TOKEN: 'figd_x' }, probe: true },
    red: { env: { FIGMA_TOKEN: 'figd_x' }, probe: true, validatePat: async () => ({ ok: false, status: 401 }) },
  },
};

const checkById = (id: string): Check => {
  const check = CHECKS.find((c) => c.id === id);
  if (!check) throw new Error(`no check registered with id "${id}"`);
  return check;
};

// Through the runner: throw->fail, the effective-mode derivation and redaction live there, not in
// the checks themselves.
const runCheckReport = (id: string, over: Partial<StatusCtx>) =>
  collectStatus(baseCtx(over), [checkById(id)]);

describe.each(EXPECTED_IDS)('%s', (id) => {
  it('has a red path attributable to its fixture, in the mode that fixture claims', async () => {
    const wantMultiTenant = FIXTURES[id].mode === 'multi-tenant';
    // The mode is asserted per HALF, not once for the pair: the two halves differ by a db/dep
    // override, and nothing else stops a future edit from changing the env of only one of them.
    const red = await runCheckReport(id, FIXTURES[id].red);
    expect(red.mode.multi_tenant, `the RED fixture for "${id}" ran in the wrong mode`).toBe(wantMultiTenant);
    expect(red.checks[0].state).toBe('fail');
    const green = await runCheckReport(id, FIXTURES[id].green);
    expect(green.mode.multi_tenant, `the GREEN fixture for "${id}" ran in the wrong mode`).toBe(wantMultiTenant);
    expect(green.checks[0].state).not.toBe('fail');
  });
});

// Per-mode matrix: single-tenant cannot run three of the six checks at all, so the three that CAN run
// there must each have a real red path, and the skipped set must be exactly what we claim.
describe('single-tenant mode', () => {
  it.each(['config', 'key', 'figma'])('%s can fail in single-tenant', async (id) => {
    const report = await runCheckReport(id, { ...FIXTURES[id].red, multiTenant: false, transport: undefined });
    // The mode this row claims to exercise, asserted rather than assumed: ctx.multiTenant is
    // overwritten from env, so without this line a fixture that quietly said multi-tenant would
    // still pass and the row would test the wrong branch.
    expect(report.mode.multi_tenant).toBe(false);
    expect(report.checks[0].state).toBe('fail');
  });

  it('skips exactly db, tokens and library_graph - and runs the other three', async () => {
    // A fully-configured single-tenant box: a token to probe and a key to self-test, so nothing is
    // skipped for want of configuration. What remains skipped is skipped BY CONSTRUCTION.
    const report = await collectStatus(baseCtx({
      env: { FIGMA_TOKEN: 'figd_x', ENCRYPTION_KEY: 'a'.repeat(64) }, probe: true,
    }));
    expect(report.mode.multi_tenant).toBe(false);
    const skipped = report.checks.filter((c) => c.state === 'skipped').map((c) => c.id);
    const ran = report.checks.filter((c) => c.state !== 'skipped').map((c) => c.id);
    // Both directions: a check that silently starts skipping leaves the first list short AND the
    // second one long, so neither assertion alone has to carry the gate.
    expect(skipped.sort()).toEqual(['db', 'library_graph', 'tokens']);
    expect(ran.sort()).toEqual(['config', 'figma', 'key']);
  });

  it('skips library_graph in single-tenant even WITH a database - the graph lives in the server process', async () => {
    // db and tokens both come alive as soon as DATABASE_URL and a handle exist; library_graph does
    // not, and that guard is the one thing keeping this CLI from reporting on a graph it cannot see.
    const report = await collectStatus(baseCtx({ env: { DATABASE_URL: 'postgres://x' }, db: okDb }));
    const byId = new Map(report.checks.map((c) => [c.id, c.state]));
    expect(byId.get('library_graph')).toBe('skipped');
    expect(byId.get('db')).toBe('ok');
    expect(byId.get('tokens')).toBe('ok');
  });
});

// The production-default env shape gets its own gates because NOTHING else in the suite exercises the
// transport default: every other multi-tenant fixture sets MCP_TRANSPORT=http explicitly. Turning
// `env.MCP_TRANSPORT ?? 'http'` into a raw `env.MCP_TRANSPORT ===` comparison (in effectiveTransport,
// which both the mode derivation and configCheck now read) left the entire unit suite green while a
// real box reported single-tenant. Each assertion below is one of the four false greens that mutant
// bought: the header, the config branch, the skipped library_graph, and the dead multi-tenant gates.
describe('the production default shape (MULTI_TENANT set, MCP_TRANSPORT unset)', () => {
  it('is multi-tenant end to end: report header, config branch, and library_graph actually runs', async () => {
    const report = await collectStatus(baseCtx({ env: MT_DEFAULT_TRANSPORT, db: okDb, multiTenant: true, transport: undefined }));
    expect(report.mode.multi_tenant).toBe(true);
    // The human header too: it is what an operator reads off a pasted terminal.
    expect(renderText(report)).toMatch(/^framefit \S+ {2}multi-tenant {2}/m);
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get('config')).toMatchObject({ state: 'ok', detail: { mode: 'multi-tenant' } });
    // library_graph is SKIPPED in single-tenant by construction - so "not skipped" is exactly the
    // fact the mutant destroys, and it cannot be satisfied by any single-tenant run.
    expect(byId.get('library_graph')!.state).not.toBe('skipped');
  });

  it('keeps the multi-tenant-only gates live: a registered team with no PAT fails, a missing MCP_HOST fails', async () => {
    // Gate 1 - the tokens check's users_without_any_token branch is `ctx.multiTenant &&` guarded, so
    // under the mutant this same fixture reports ok: a dead validator behind a green line.
    const noPat = await collectStatus(baseCtx({
      env: MT_DEFAULT_TRANSPORT, transport: undefined,
      db: { ...okDb, tokenStats: async () => ({ ...TOKENS_OK, users_without_any_token: ['u1'] }) },
    }), [checkById('tokens')]);
    expect(noPat.mode.multi_tenant).toBe(true);
    expect(noPat.checks[0].state).toBe('fail');

    // Gate 2 - loadMultiTenantEnv only runs on the multi-tenant branch of configCheck, so under the
    // mutant an env that cannot boot multi-tenant at all reports [OK] config.
    const { MCP_HOST: _host, ...withoutHost } = MT_DEFAULT_TRANSPORT;
    const missingHost = await collectStatus(baseCtx({ env: withoutHost, transport: undefined }), [checkById('config')]);
    expect(missingHost.checks[0].state).toBe('fail');
    expect((missingHost.checks[0] as { reason: string }).reason).toMatch(/MCP_HOST/);
  });
});

describe('the verdict fields', () => {
  // A report that examined NOTHING must not claim a verdict. `results.length >= expectedTotal` is
  // vacuously true for 0 >= 0, which made an empty run report complete: true, ok_overall: true - a
  // green earned by asking no questions.
  it('a run over zero checks is neither complete nor ok', async () => {
    const report = await collectStatus(baseCtx(), []);
    expect(report.checks).toHaveLength(0);
    expect(report.summary.total).toBe(0);
    expect(report.summary.complete).toBe(false);
    expect(report.summary.ok_overall).toBe(false);
    expect(renderText(report)).toMatch(/INCOMPLETE/);
  });

  it('ok_overall: true always implies complete: true, on reports reached four different ways', async () => {
    const reports: StatusReport[] = [
      await collectStatus(baseCtx({ ...MT_DB, probe: true })),                      // full registry, all green
      await collectStatus(baseCtx({ ...MT_DB, probe: true, validatePat: async () => ({ ok: false, status: 401 }) })),
      buildReport(baseCtx(), [{ id: 'config', state: 'ok', detail: {} }]),          // deadline-truncated
      await collectStatus(baseCtx(), []),                                          // empty
    ];
    for (const r of reports) {
      if (r.summary.ok_overall) expect(r.summary.complete).toBe(true);
    }
    // Non-vacuity in BOTH directions: without these the implication above holds trivially over a
    // corpus where nothing is ok_overall, or where everything is complete.
    expect(reports.filter((r) => r.summary.ok_overall)).toHaveLength(1);
    expect(reports.filter((r) => !r.summary.complete)).toHaveLength(2);
  });
});

describe('renderers and docs', () => {
  // Read LAZILY, inside each test that needs it. At describe-body scope a missing or renamed
  // docs/status.md throws during collection and fails all 21 tests with one ENOENT, hiding which
  // gates actually broke - the two doc gates are the ones that should speak.
  const readDoc = () => readFileSync(new URL('../../../docs/status.md', import.meta.url), 'utf8');

  it('renders every check with a non-empty body, in both formats', async () => {
    const report = await collectStatus(baseCtx({
      ...MT_DB, probe: true, validatePat: async () => ({ ok: false, status: 401 }),
    }));
    const text = renderText(report);
    for (const id of EXPECTED_IDS) {
      // state + id + at least one non-space character of body, ON THE SAME LINE. Literal ` +`, never
      // `\s+`: in multiline mode `\s` matches the newline too, so `\s+\S` happily crosses into the
      // NEXT check's line and a renderer that emitted an empty body would still match. Proven by
      // mutation - a detailLine() returning '' passed the `\s+` form of this assertion.
      expect(text, `renderText emitted no body for the "${id}" check`)
        .toMatch(new RegExp(`^\\[(OK|FAIL|SKIP)\\] +${id} +\\S`, 'm'));
    }
    const parsed = JSON.parse(renderJson(report)) as StatusReport;
    expect(parsed.checks.map((c) => c.id)).toEqual(EXPECTED_IDS);
    // CONTENT, not just ids and order: a renderJson that emitted `{id, state}` and dropped every
    // reason and detail passed the id/order assertion above - and the entire suite, because nothing
    // else anywhere reads a check's reason or detail through JSON. The machine surface would then
    // carry six verdicts and not one word of why.
    for (const c of parsed.checks) {
      if (c.state === 'ok') {
        expect(Object.keys(c.detail ?? {}), `the JSON ok row "${c.id}" carries no detail`).not.toHaveLength(0);
      } else {
        expect(c.reason ?? '', `the JSON ${c.state} row "${c.id}" carries no reason`).not.toBe('');
      }
    }
  });

  it('documents exactly the check ids, as its own headings, in registry order', () => {
    // The RAW heading text, not an id-shaped capture: `^###\s+([a-z_]+)\s*$` cannot see `### Redis`
    // (so an invented check stays green) and cannot even match `### redis-cache`. Whatever a stray
    // `###` heading looks like, it has to show up here.
    const documented = [...readDoc().matchAll(/^###[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]);
    // UNSORTED, so it pins order too: the doc presents the checks as the registry runs them, and
    // sorting both sides let the `### config` and `### figma` sections be swapped silently.
    expect(documented).toEqual(EXPECTED_IDS);
  });

  it('documents the fields of the JSON contract, including the ones a consumer must read to spot an aborted run', () => {
    // summary.complete is the field that keeps ok_overall honest; a consumer who never learns of it
    // reads counts alone and treats a deadline-aborted run as a finished one.
    //
    // Each field must appear as a WHOLE WORD INSIDE A BACKTICKED SPAN, not merely as a substring of
    // the prose: bare `toContain('mode')` is satisfied by the word "mode" in a sentence, and
    // `toContain('complete')` by "completed" - so a doc that names three fields out of eleven passes.
    const doc = readDoc();
    for (const field of ['schema', 'generated_at', 'version', 'mode', 'transport_source', 'scope',
                         'key_fingerprint', 'checks', 'summary', 'total', 'ok', 'skipped', 'failed',
                         'complete', 'ok_overall']) {
      expect(doc, `docs/status.md does not document the JSON field "${field}" in a code span`)
        .toMatch(new RegExp(`\`[^\`\n]*\\b${field}\\b[^\`\n]*\``));
    }
  });

  it('emits ASCII only, across every state of every real check', async () => {
    const reports = await Promise.all([
      collectStatus(baseCtx({ ...MT_DB, probe: true })),
      collectStatus(baseCtx({ env: {}, probe: false })),
      collectStatus(baseCtx({
        ...MT_DB, probe: true,
        db: { ...okDb, listUsers: async () => { throw new Error('relation "figma_tokens" does not exist'); } },
        validatePat: async () => ({ ok: false, status: 401 }),
      })),
    ]);
    for (const r of reports) expect(renderText(r) + renderJson(r)).not.toMatch(/[^\x00-\x7F]/);
    // status.ts's own SOURCE, so a non-ASCII string added to a branch none of the reports above reach
    // still goes red. Comment LINES are stripped first - both `//` and the `*`-prefixed body of a
    // block comment, so prose may keep its typography and a JSDoc em dash never fails under a message
    // about output. What remains is code, where a typographic character must be a \u escape.
    const src = readFileSync(new URL('../../src/infrastructure/status.ts', import.meta.url), 'utf8');
    const code = src.replace(/^\s*(?:\/\/|\/?\*+\/?).*$/gm, '');
    expect(code, 'a non-ASCII glyph in status.ts code (use a \\u escape)').not.toMatch(/[^\x00-\x7F]/);
    // The documentation is a user-visible string too, and it is the one artifact no renderer folds.
    expect(readDoc()).not.toMatch(/[^\x00-\x7F]/);
  });
});

describe('secrets', () => {
  it('redacts env secrets that reach a reason, and proves the leak path was live', async () => {
    const env = { ...MT, FIGMA_TOKEN: 'SENTINEL_FIGMA', ENCRYPTION_KEY: 'de'.repeat(32) };
    const leak: Check = { id: 'config', run: async () => { throw new Error(`boom ${env.FIGMA_TOKEN} ${env.ENCRYPTION_KEY}`); } };
    const raw = await (async () => { try { await leak.run(baseCtx({ env })); } catch (e) { return (e as Error).message; } })();
    expect(raw).toContain('SENTINEL_FIGMA');                       // positive control: it WAS there
    const report = await collectStatus(baseCtx({ env }), [leak]);
    const blob = renderText(report) + renderJson(report);
    expect(blob).not.toContain('SENTINEL_FIGMA');
    expect(blob).not.toContain('de'.repeat(32));
    expect(blob).toContain('<redacted:FIGMA_TOKEN>');
  });

  it('redacts a decrypted PAT discovered at runtime', async () => {
    const db: StatusDb = { ...okDb, getDefaultPat: async () => ({ pat: 'SENTINEL_PAT', label: 'l', status: 'active' }) };
    const report = await collectStatus(baseCtx({
      ...MT_DB, probe: true, db,
      validatePat: async (p: string) => { throw new Error(`upstream echoed ${p}`); },
    }));
    const blob = renderText(report) + renderJson(report);
    expect(blob).toContain('<redacted:secret>');    // positive control
    expect(blob).not.toContain('SENTINEL_PAT');
  });

  it('keeps the DSN password out of stdout, stderr and the logger', async () => {
    const seen: string[] = [];
    const logger = { info() {}, debug() {}, warn: (o: unknown, m: string) => seen.push(JSON.stringify(o) + m),
      error: (o: unknown, m: string) => seen.push(JSON.stringify(o) + m), child() { return logger; } } as never;
    const { deps, out, err } = makeDeps({
      env: { DATABASE_URL: 'postgres://u:SENTINEL_PASS@h/db' }, logger,
      initDb: (url: string, onError?: (e: Error) => void) => { onError?.(new Error(`connect ECONNREFUSED ${url}`)); },
      listUsers: async () => { throw new Error('connect ECONNREFUSED postgres://u:SENTINEL_PASS@h/db'); },
    });
    await runCli(['status', '--no-probe'], deps);
    expect(seen.length).toBeGreaterThan(0);                        // the logger really was written to
    const blob = out() + err() + seen.join('\n');
    expect(blob).not.toContain('SENTINEL_PASS');
    expect(blob).toContain('h/db');                                // the host survives, only creds go
    // ASCII on BOTH streams of the real command, not just on what the renderers produce: the status
    // path's own advisory text lives in cli.ts (the scope note, the deadline line, usage errors), which
    // the status.ts source assertion cannot see. Without this, an em dash planted in that note passes
    // every other gate and the whole suite.
    expect(err(), 'the status path wrote a non-ASCII byte to stderr').not.toMatch(/[^\x00-\x7F]/);
    expect(out(), 'the status path wrote a non-ASCII byte to stdout').not.toMatch(/[^\x00-\x7F]/);
    expect(err(), 'nothing reached stderr, so the assertion above proved nothing').not.toBe('');
  });
});
