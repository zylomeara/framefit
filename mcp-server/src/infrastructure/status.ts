import { loadConfig, DEFAULT_MCP_TRANSPORT } from './config.js';
import { multiTenantEnvGraphConflict, parseTeamIds } from './env-graph.js';
import { isMultiTenant, loadMultiTenantEnv, isEncryptionKeyHex, ENCRYPTION_KEY_HINT } from '../multi-tenant/env.js';

export type CheckResult =
  | { state: 'ok'; detail: Record<string, unknown> }
  | { state: 'fail'; reason: string; detail?: Record<string, unknown> }
  | { state: 'skipped'; reason: string };

export interface StatusDb {
  listUsers(): Promise<string[]>;
  listTeams(userId: string): Promise<string[]>;
  // `status: string`, NOT a union - must match CliDeps.getDefaultPat (cli.ts:59) or Task 5b fails.
  getDefaultPat(userId: string, encryptionKey: string):
    Promise<{ pat: string; label: string; status: string } | null>;
  tokenStats(): Promise<TokenStats>;
  graphStats(): Promise<GraphStats>;
}

export interface StatusCtx {
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** EFFECTIVE mode. `collectStatus` derives this from `env` via `effectiveMultiTenant` and
   *  OVERWRITES whatever value is set here before running any check or building the report - a
   *  value supplied here is never a second source of truth, so it can never disagree with what
   *  the checks themselves see when they look at `env` directly. */
  multiTenant: boolean;
  transport: string | undefined;   // raw MCP_TRANSPORT (undefined when unset)
  probe: boolean;
  db?: StatusDb;
  signBridgeToken: (userId: string, secretHex: string, ttlSec: number) => Promise<string>;
  verifyBridgeToken: (token: string, secretHex: string, scope: string) => Promise<string | null>;
  validatePat: (pat: string, timeoutMs?: number) =>
    Promise<{ ok: true; handle: string } | { ok: false; status: number }>;
  hostname: string;
  pid: number;
  /** Secrets discovered at RUNTIME (decrypted PATs). A check adds a value here before letting it
   *  near any call whose error might quote it; the runner redacts these too. */
  secrets: Set<string>;
}

export interface Check { id: string; run(ctx: StatusCtx): Promise<CheckResult>; }

export interface TokenStats {
  stored: number;
  // Invalid tokens that are NOT their user's default, counted in SQL. An invalid DEFAULT is already
  // named, per user, by `bad_defaults`, and the tokens check renders THIS number on that very fail
  // line - counting the same row in both places told the operator "u1 (invalid)" and
  // "invalid_non_default: 1" at once, sending them hunting a second problem that does not exist.
  invalid_non_default: number;
  users_without_default: string[];
  // Distinct from users_without_default: a user can register a Figma team and never add a token at
  // all, which a query scoped to figma_tokens rows alone can never see (there is no row to find).
  users_without_any_token: string[];
  bad_defaults: { user: string; label: string; problem: 'invalid' | 'expired'; expires_at: string | null }[];
  soonest_default_expiry: { user: string; expires_at: string; days: number } | null;
  // The OLDEST last_validated_at across all stored tokens (MIN), not the most recent (MAX): one
  // freshly re-validated token (e.g. a manual portal action) must never mask every other token
  // going stale behind a single healthy-looking timestamp.
  last_validated_at: string | null;
  // Age (SQL clock) of the timestamp above, clamped to >= 0.
  validation_age_sec: number | null;
  // Tokens never validated (last_validated_at IS NULL) or last validated more than 48h ago. MIN()
  // above silently ignores NULLs, so this count exists specifically to not ignore them.
  stale_or_unvalidated_total: number;
  // True if any stored token's last_validated_at is later than the database's own now() - a
  // visible sign the database clock is skewed, instead of a silently negative age.
  future_validation_detected: boolean;
}

export interface GraphStats {
  libraries: number; variables: number; teams: number;
  // ALL of this user's registered teams yield zero libraries - they cannot resolve anything at all.
  users_with_teams_and_no_libraries: string[];
  // SOME but not all of this user's registered teams yield zero libraries. Not a failure: a team can
  // legitimately hold no variable libraries (e.g. a prototyping-only team), and the user can still
  // resolve variables through their other, working team(s).
  users_with_partial_team_gaps: string[];
  oldest_synced_at: string | null; oldest_age_sec: number | null; newest_synced_at: string | null;
}

export interface StatusReport {
  schema: 1;
  generated_at: string;
  version: string;
  mode: { multi_tenant: boolean; transport: string | null; transport_source: 'env' | 'unset' };
  scope: { hostname: string; pid: number; env_source: 'process' };
  key_fingerprint: string | null;
  checks: ({ id: string } & CheckResult)[];
  summary: {
    total: number; ok: number; skipped: number; failed: number;
    /** False when fewer checks ran than the run asked for (the CLI's hard deadline fired mid-run).
     *  `total` then describes the COMPLETED SUBSET, not the whole run, so a consumer that reads
     *  counts without reading this field would treat an aborted run as a finished one. */
    complete: boolean;
    /** A VERDICT, not a count: it requires `complete` too. An aborted run never reached a verdict,
     *  so it can never claim one - `ok_overall: true` with `complete: false` was the false green
     *  this field pairing exists to make impossible. */
    ok_overall: boolean;
  };
}

import { createHash } from 'node:crypto';
import { VERSION } from './version.js';

// Exported so `figmaCheck` can derive a PER-USER share of the same budget the runner enforces
// around the whole check (see figmaCheck's multi-tenant branch) - two independently maintained
// constants with the same value would be free to drift apart silently.
export const PER_CHECK_TIMEOUT_MS = 10_000;
export const HARD_DEADLINE_MS = 30_000;

export function keyFingerprint(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length % 2 !== 0) return null;
  const bytes = Buffer.from(trimmed, 'hex');
  if (bytes.length === 0) return null;
  // Hash the DECODED bytes: '655B..' and '655b..', or a trailing newline from
  // ENCRYPTION_KEY=$(cat secret), are the same key and must fingerprint the same.
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

// Secrets reach `reason` through messages nobody writes by hand: pg puts the connection URL into
// ECONNREFUSED, and a stored PAT can be quoted by a failing HTTP client. Redaction lives HERE so
// every present and future check inherits it. DS_TEAM_IDS is deliberately NOT a secret: team ids
// are public identifiers and parseTeamIds' message must keep naming the bad one.
const SECRET_VARS = ['ENCRYPTION_KEY', 'FIGMA_TOKEN'] as const;

// The ONE credential mask for a DSN-shaped string. Exported because the CLI's pg pool-error logger
// sits OUTSIDE this module's redactor - that callback fires independently of any check, so it cannot
// go through makeRedactor - and a hand copy of this regex at that call site would be a second
// implementation free to rot. Credentials only: the HOST of a DATABASE_URL is the diagnostic value.
export function maskDsnCredentials(s: string): string {
  return s.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1<redacted>@');
}

// DATABASE_URL carries its password inline (scheme://user:pass@host/db). The credentials are the
// only secret part of it - a bare password can also leak OUTSIDE the URL shape entirely (e.g. a
// driver's own "password authentication failed for user ..." message), so the decoded password
// gets its own substitution entry instead of relying on the URL-shaped mask above to catch it.
function extractUrlPassword(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@/\s]*:([^@\s]*)@/.exec(raw.trim());
  if (!m || !m[1]) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// Code points, not literal glyphs, so this source file stays ASCII-only too: em dash, en dash,
// minus sign, ellipsis, curly single/double quotes (incl. low-9 variants), no-break space, bullet.
const ASCII_FOLD_MAP: Record<string, string> = {
  '\u2014': '-', '\u2013': '-', '\u2212': '-',
  '\u2026': '...',
  '\u2018': "'", '\u2019': "'", '\u201a': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"',
  '\u00a0': ' ',
  '\u2022': '*',
};
const ASCII_FOLD_RE = /[\u2014\u2013\u2212\u2026\u2018\u2019\u201a\u201c\u201d\u201e\u00a0\u2022]/g;
const COMBINING_DIACRITICS_RE = /[\u0300-\u036f]/g;

// Global constraint: ASCII only in every user-visible string. Real pg/undici/OS error text carries
// typographic characters (em dash, curly quotes, an actual ellipsis glyph) that a check author never
// typed - fold them here, alongside redaction, so every present and future check inherits it too.
function foldToAscii(s: string): string {
  const mapped = s.replace(ASCII_FOLD_RE, (ch) => ASCII_FOLD_MAP[ch] ?? '');
  // Strip diacritics NFKD can decompose (e.g. an accented e -> plain e), then drop whatever
  // non-ASCII still survives so a user-visible string can never carry it.
  return mapped.normalize('NFKD').replace(COMBINING_DIACRITICS_RE, '').replace(/[^\x00-\x7F]/g, '?');
}

function makeRedactor(ctx: StatusCtx): (s: string) => string {
  const envValues: [string, string][] = [];
  for (const name of SECRET_VARS) {
    const v = ctx.env[name];
    if (v && v.length >= 8) envValues.push([v, `<redacted:${name}>`]);
  }
  const dbPassword = extractUrlPassword(ctx.env.DATABASE_URL);
  // Same >= 8 gate as every other entry: a value shorter than this is NOT redacted by substring
  // substitution, because blind substring replacement of a very short string mangles unrelated
  // text (e.g. a 2-char password could clobber the middle of "table"). The postgres URL regex
  // below still masks a short password when it appears in its URL form, regardless of length.
  if (dbPassword && dbPassword.length >= 8) envValues.push([dbPassword, '<redacted:DATABASE_URL>']);
  return (s) => {
    let out = s;
    for (const [needle, mask] of envValues) out = out.split(needle).join(mask);
    // ctx.secrets is read HERE, on every call - NOT snapshotted once when the closure is built.
    // A check adds its decrypted PAT to ctx.secrets DURING its own run(), which happens after this
    // redactor already exists; capturing the set once up front would miss every such addition.
    for (const v of ctx.secrets) if (v.length >= 8) out = out.split(v).join('<redacted:secret>');
    return foldToAscii(maskDsnCredentials(out));
  };
}

function redactDeep(value: unknown, r: (s: string) => string): unknown {
  if (typeof value === 'string') return r(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, r));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, r)]));
  }
  return value;
}

function redactResult(result: CheckResult, r: (s: string) => string): CheckResult {
  if (result.state === 'ok') return { state: 'ok', detail: redactDeep(result.detail, r) as Record<string, unknown> };
  if (result.state === 'skipped') return { state: 'skipped', reason: r(result.reason) };
  return {
    state: 'fail', reason: r(result.reason),
    ...(result.detail ? { detail: redactDeep(result.detail, r) as Record<string, unknown> } : {}),
  };
}

async function runOne(check: Check, ctx: StatusCtx, timeoutMs: number, redact: (s: string) => string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      check.run(ctx),
      new Promise<CheckResult>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'fail', reason: `timed out after ${timeoutMs}ms` }), timeoutMs);
        timer.unref?.();   // a check that never settles must not hold the event loop open
      }),
    ]);
    return { id: check.id, ...redactResult(result, redact) };
  } catch (e) {
    // A swallowed error is a false green: surface it as a failure with its message. `e` may not be
    // an Error at all (a check can `throw null` or `throw "x"`) - `(e as Error).message` would
    // itself throw in that case and take the whole collectStatus loop down with it, which is
    // exactly the "missing line" this conversion exists to prevent.
    const reason = e instanceof Error ? e.message : String(e);
    return { id: check.id, ...redactResult({ state: 'fail', reason }, redact) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `expectedTotal` is how many checks the run ASKED for; fewer results than that means the run was cut
 * short (the CLI's hard deadline) and the report is a partial one. It is a parameter rather than a
 * `results.length < CHECK_IDS.length` comparison because a deliberate subset run - `collectStatus(ctx,
 * [oneCheck])`, which every check's own tests use - is COMPLETE for what it asked, and marking it
 * incomplete/not-ok would make both fields meaningless for anything but a full registry run.
 * Defaults to the default registry, which is what the CLI runs.
 *
 * ZERO expected checks is never complete, no matter how the caller got there. `results.length >=
 * expectedTotal` alone is vacuously TRUE for 0 >= 0, so a run over an empty check list used to report
 * `complete: true, ok_overall: true` over no evidence at all - a green earned by asking nothing. The
 * only honest verdict for a run that examined nothing is "no verdict", which is exactly what
 * `complete: false` says.
 */
export function buildReport(
  ctx: StatusCtx,
  results: ({ id: string } & CheckResult)[],
  expectedTotal: number = CHECKS.length,
): StatusReport {
  const ok = results.filter((r) => r.state === 'ok').length;
  const skipped = results.filter((r) => r.state === 'skipped').length;
  const failed = results.filter((r) => r.state === 'fail').length;
  const complete = expectedTotal > 0 && results.length >= expectedTotal;
  return {
    schema: 1,
    generated_at: new Date(ctx.now()).toISOString(),
    version: VERSION,
    mode: {
      multi_tenant: ctx.multiTenant,
      transport: ctx.transport ?? null,
      transport_source: ctx.transport ? 'env' : 'unset',
    },
    scope: { hostname: ctx.hostname, pid: ctx.pid, env_source: 'process' },
    key_fingerprint: keyFingerprint(ctx.env.ENCRYPTION_KEY),
    checks: results,
    // ok_overall requires `complete`: a run the deadline cut short never reached a verdict, and a
    // consumer reading only `.summary.ok_overall` must not see "healthy" for it.
    summary: { total: results.length, ok, skipped, failed, complete, ok_overall: complete && failed === 0 },
  };
}

// The ONE place the transport default is applied, read by BOTH the mode derivation below and
// configCheck's declared-vs-effective comparison. Two copies of `env.MCP_TRANSPORT ?? 'http'` were
// two things that had to stay in step; the default itself comes from config.ts's schema, so this
// cannot drift from what the server would really boot with either. Dropping the default here is
// load-bearing, not cosmetic: the compose full profile sets MULTI_TENANT=true and never sets
// MCP_TRANSPORT, so a raw comparison reads every production box as stdio -> single-tenant.
export function effectiveTransport(env: NodeJS.ProcessEnv): string {
  return env.MCP_TRANSPORT ?? DEFAULT_MCP_TRANSPORT;
}

// The ONE derivation of "is this process multi-tenant" - env alone, never a caller-supplied flag.
// Compares the DEFAULTED transport, exactly as index.ts:47 does via config.MCP_TRANSPORT (zod
// default 'http', config.ts) - comparing the raw MCP_TRANSPORT value would treat every box that
// simply does not set it (the compose default) as if it had chosen stdio.
export function effectiveMultiTenant(env: NodeJS.ProcessEnv): boolean {
  return isMultiTenant(env) && effectiveTransport(env) === 'http';
}

export async function collectStatus(
  ctx: StatusCtx,
  checks: Check[] = CHECKS,
  opts: { perCheckTimeoutMs?: number; sink?: ({ id: string } & CheckResult)[] } = {},
): Promise<StatusReport> {
  // Derive the effective mode ONCE, here, from `env` alone, and run every check plus buildReport
  // against a context carrying that derived value - never whatever `ctx.multiTenant` the caller
  // passed in. Before this, a check that reads `ctx.env` directly (like configCheck) and
  // `buildReport` (which reads `ctx.multiTenant`) could compute DIFFERENT effective modes from a
  // caller's stale/wrong flag, so the header and a check's own detail could disagree about which
  // mode the box is actually in. Deriving once and overwriting makes that divergence structurally
  // impossible rather than a thing every caller and test has to get right on its own.
  const effectiveCtx: StatusCtx = { ...ctx, multiTenant: effectiveMultiTenant(ctx.env) };
  const timeoutMs = opts.perCheckTimeoutMs ?? PER_CHECK_TIMEOUT_MS;
  const redact = makeRedactor(effectiveCtx);
  // SEQUENTIAL on purpose: the checks share one pg pool and the probe makes one network call per
  // user. `sink` is filled as results arrive so a caller whose deadline fires can still render
  // what completed.
  const results = opts.sink ?? [];
  for (const check of checks) results.push(await runOne(check, effectiveCtx, timeoutMs, redact));
  // The expectation is what THIS run asked for, not the registry: a subset run that finished its
  // subset is complete. Only a caller that abandons this promise (withDeadline) renders a partial
  // report, and it builds that one itself from the sink.
  return buildReport(effectiveCtx, results, checks.length);
}

/** Resolves null if `work` outlives the deadline; the caller renders the sink and exits 2. This
 *  timer is the guard of LAST resort, so unlike the per-check timer it stays ref'd: it is always
 *  cleared - on EITHER settlement path of `work`, fulfilled or rejected, via `.finally()` rather
 *  than `.then()` - so it can never delay a normal exit or outlive `work` itself. But if every
 *  check-level timeout somehow failed to fire, this is what still forces the process to observe a
 *  deadline instead of a silent, un-terminated hang. */
export function withDeadline<T>(work: Promise<T>, ms = HARD_DEADLINE_MS): Promise<T | null> {
  let timer: NodeJS.Timeout;
  // `.finally()`, not `.then()`: a REJECTING `work` must clear this timer too, or the now ref'd
  // deadline timer stays pending for the full `ms` even though `work` already settled.
  const guarded = work.finally(() => clearTimeout(timer));
  return Promise.race([
    guarded,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]);
}

const STATE_TAG: Record<CheckResult['state'], string> = { ok: '[OK]  ', fail: '[FAIL]', skipped: '[SKIP]' };
const ID_COL = 16;
const INDENT = ' '.repeat(7 + ID_COL);   // 23 - continuation lines never shadow the state column

function detailLine(entry: { id: string } & CheckResult): string {
  if (entry.state === 'ok') return Object.entries(entry.detail).map(([k, v]) => `${k}=${String(v)}`).join('  ');
  return entry.reason;
}

function wrap(prefix: string, body: string, width: number): string {
  const room = Math.max(24, width - prefix.length);
  const parts: string[] = [];
  let rest = body;
  while (rest.length > room) {
    const cut = rest.lastIndexOf(' ', room);
    // Break on whitespace only - never mid-token, or a user id gets split in half.
    const at = cut > 0 ? cut : rest.indexOf(' ', room) > 0 ? rest.indexOf(' ', room) : rest.length;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).trim();
  }
  parts.push(rest);
  return prefix + parts.join(`\n${INDENT}`);
}

export function renderText(report: StatusReport, width = 100): string {
  const fp = report.key_fingerprint ? `  key ${report.key_fingerprint}` : '';
  const transport = report.mode.transport_source === 'env'
    ? `transport: ${report.mode.transport} (from MCP_TRANSPORT; hosts set it per launch)`
    : 'transport: unset (hosts set MCP_TRANSPORT per launch)';
  const head = [
    `framefit ${report.version}  ${report.mode.multi_tenant ? 'multi-tenant' : 'single-tenant'}  ${transport}${fp}`,
    'env: process environment only (this command does not read .env)',
    '',
  ];
  const lines = report.checks.map((c) => wrap(`${STATE_TAG[c.state]} ${c.id.padEnd(ID_COL)}`, detailLine(c), width));
  const s = report.summary;
  // The human surface must not read as a finished run either: stdout is what gets pasted into a
  // ticket, and the stderr line explaining the abort does not travel with it.
  const cut = s.complete ? '' : ' - INCOMPLETE: the run was cut short, not every check ran';
  return [...head, ...lines, '', `${s.ok} ok, ${s.skipped} skipped, ${s.failed} failed${cut}`, ''].join('\n');
}

export function renderJson(report: StatusReport): string { return `${JSON.stringify(report)}\n`; }

export const configCheck: Check = {
  id: 'config',
  async run(ctx) {
    // 1. Hard boot abort (index.ts:26-30): the container restart-loops and /health is unreachable,
    // so `status` under docker exec is the only thing that can still answer. Checked first.
    const conflict = multiTenantEnvGraphConflict(ctx.env);
    if (conflict) return { state: 'fail', reason: conflict };

    // 2. The real zod schema - enums, coercions, cross-field refinements. A name list cannot catch
    // LOG_LEVEL=verbose or a limits relationship, and both crash-loop the box.
    try { loadConfig(ctx.env); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { state: 'fail', reason: `loadConfig rejected the environment: ${msg}` };
    }

    // 3. Declared vs effective mode. Compare the DEFAULTED transport, through the SAME
    // `effectiveTransport` the mode derivation uses - an inline second copy of that defaulting was
    // free to drift from it, and dropping it here fails every box that simply does not set
    // MCP_TRANSPORT, which is the compose default.
    const transport = effectiveTransport(ctx.env);
    if (isMultiTenant(ctx.env) && transport !== 'http') {
      return { state: 'fail', reason: `MULTI_TENANT is set but MCP_TRANSPORT is "${transport}" - the server would boot single-tenant with no auth layer; multi-tenant requires the http transport` };
    }

    // 4. `ctx.multiTenant` here is `effectiveMultiTenant(ctx.env)` - collectStatus derives it from
    // `env` and overwrites whatever the caller passed before this check ever runs (see
    // collectStatus), so it is trustworthy by construction and provably equals isMultiTenant(env)
    // at this point (the transport guard above already returned fail on any mismatch). Reading it
    // here instead of recomputing isMultiTenant(ctx.env) is what keeps this check and the report
    // header (buildReport, which reads the SAME field) structurally unable to disagree.
    if (ctx.multiTenant) {
      // Delegate the required list AND the ENCRYPTION_KEY shape check (env.ts:41-53).
      try { loadMultiTenantEnv(ctx.env); }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { state: 'fail', reason: msg };
      }
      return { state: 'ok', detail: { mode: 'multi-tenant', loaders: 'loadConfig+loadMultiTenantEnv' } };
    }

    // 5. Single-tenant. FIGMA_TOKEN is optional BY DESIGN (config.ts:6-11) and stdio-smoke proves a
    // healthy handshake without it. But DS_TEAM_IDS without a token cannot sync (cli.ts:258-273).
    const token = ctx.env.FIGMA_TOKEN;
    const raw = ctx.env.DS_TEAM_IDS;
    let teamCount = 0;
    // `raw?.trim()`, not raw truthiness: production gates DS_TEAM_IDS on trimmed length
    // (env-graph.ts:206,233), so a whitespace-only value must be treated as unset, not as a
    // misconfiguration.
    if (raw?.trim()) {
      try { teamCount = parseTeamIds(raw).length; }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { state: 'fail', reason: msg };
      }
      if (!token) return { state: 'fail', reason: 'DS_TEAM_IDS is set but FIGMA_TOKEN is not - the env graph cannot sync without a token' };
    }
    return { state: 'ok', detail: {
      mode: 'single-tenant',
      figma_token: token ? 'set' : 'not set (fine: callers may pass a per-call figma_token)',
      ds_team_ids: teamCount,
    } };
  },
};

// A wrong key throws a node crypto GCM message; a pool failure throws something else entirely.
// Blaming the key for a dead pool sends an operator to rotate secrets over a network problem.
const DECRYPT_ERROR = /unable to authenticate data|unsupported state|bad decrypt/i;

export const keyCheck: Check = {
  id: 'key',
  async run(ctx) {
    const key = ctx.env.ENCRYPTION_KEY;
    if (!key) return { state: 'skipped', reason: 'ENCRYPTION_KEY is not set' };

    // Shape first: aes-256-gcm rejects a key of the wrong length outright, but jose's HS256 (the
    // bridge-token signer below) signs and verifies happily with a key of ANY byte length - so a
    // short/malformed key would sail through Part 1's round-trip and, with no DATABASE_URL to
    // reach Part 2, report ok for a key nothing else validates in single-tenant mode (configCheck's
    // shape check only runs under multi-tenant, via loadMultiTenantEnv). Same predicate used
    // everywhere else this key's shape is checked (env.ts:33), so this can never drift from it.
    if (!isEncryptionKeyHex(key)) return { state: 'fail', reason: ENCRYPTION_KEY_HINT };

    // Part 1 - EVERY mode, no database. The incident this command exists for (a bare 403 from the
    // ingest endpoint) happened on exactly this path, where a DB-only check is skipped.
    try {
      const token = await ctx.signBridgeToken('status-selftest', key, 60);
      if (await ctx.verifyBridgeToken(token, key, 'variables:snapshot') !== 'status-selftest') {
        return { state: 'fail', reason: 'ENCRYPTION_KEY did not round-trip a bridge token (sign+verify) - tokens signed with it cannot be verified' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { state: 'fail', reason: `ENCRYPTION_KEY cannot sign a bridge token: ${message}` };
    }

    if (!ctx.db) return { state: 'ok', detail: { self_test: 'sign+verify round-trip passed', decrypt: 'not checked (no DATABASE_URL)' } };

    // Part 2 - EVERY user, not a sample: listUsers is ORDER BY keycloak_user_id (db.ts:104), so a
    // capped sample makes the verdict an alphabetical accident after a key rotation.
    const users = await ctx.db.listUsers();
    if (users.length === 0) return { state: 'ok', detail: { self_test: 'sign+verify round-trip passed', decrypt: 'no users registered' } };

    let decrypted = 0;
    // getDefaultPat returns null for a user who has tokens but none marked default (db.ts:183) -
    // that is an ABSENCE of decrypt evidence, never a decrypt success, and must never be counted
    // into `decrypted` or dressed up as an `ok` with nothing behind it.
    let noDefault = 0;
    const mismatched: string[] = [];
    const other: string[] = [];
    for (const user of users) {
      try {
        const pat = await ctx.db.getDefaultPat(user, key);
        if (pat) decrypted++; else noDefault++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (DECRYPT_ERROR.test(message)) mismatched.push(user); else other.push(`${user}: ${message}`);
      }
    }
    if (mismatched.length > 0) {
      // "cannot authenticate", not "does not match": a row encrypted under a different user's AAD
      // (crypto.ts - decrypt() passes userId as AAD) throws this SAME GCM message even when the key
      // itself is right, so "does not match the stored data" would over-claim what one failed GCM
      // tag actually proves.
      return { state: 'fail',
        reason: `ENCRYPTION_KEY (fingerprint ${keyFingerprint(key)}) cannot authenticate the stored data for ${mismatched.length} of ${users.length} users: ${mismatched.join(', ')}`,
        detail: { decrypted: `${decrypted} of ${users.length}`, users: users.length } };
    }
    if (other.length > 0) return { state: 'fail', reason: `could not read stored PATs: ${other.join('; ')}` };

    const detail: Record<string, unknown> = { self_test: 'sign+verify round-trip passed', decrypted: `${decrypted} of ${users.length}` };
    if (noDefault > 0) detail.no_default = noDefault;
    // Zero of the attempts above are decrypt SUCCESSES: every user has tokens but none marked
    // default, so this line is not silent success, it is an absence of evidence. The `tokens`
    // check (later task) reports the users-without-a-default fact itself - this only has to say
    // the decrypt count here proves nothing, not repeat that fact.
    if (noDefault === users.length) detail.decrypt = 'no evidence - no user has a default PAT (the tokens check reports this)';
    return { state: 'ok', detail };
  },
};

// Exported so db.ts's tokenStats() query can derive its own staleness/exemption thresholds from
// this SAME value (passed in as a query parameter) - a second, hand-copied `interval '48 hours'`
// literal in SQL would be free to drift from this constant silently.
export const NIGHTLY_INTERVAL_SEC = 24 * 60 * 60;

export const dbCheck: Check = {
  id: 'db',
  async run(ctx) {
    if (!ctx.env.DATABASE_URL) return { state: 'skipped', reason: 'DATABASE_URL is not set' };
    if (!ctx.db) return { state: 'skipped', reason: 'no database handle was provided to status' };
    // No catalog probe: the calls below ARE the presence test, and a missing relation arrives as
    // a Postgres error naming it (the throw becomes `fail` in the runner). A hardcoded table list
    // would be a second hand-maintained truth. This only probes what it actually calls, though:
    // with zero users, `listTeams` is never invoked, so exactly one relation (the users table) is
    // exercised here - a missing `figma_tokens`-style relation that only `listTeams` touches would
    // not surface until a user exists.
    const users = await ctx.db.listUsers();
    let teams = 0;
    for (const user of users) teams += (await ctx.db.listTeams(user)).length;
    // Named `team_registrations`, not `teams`: this sums registrations PER token-holding user (a
    // team shared by two users, or registered by a user with no token, counts differently here than
    // in `library_graph`, which reports the DISTINCT team count across everyone). Two different
    // measures under the same key would let a reader compare them as if they had to agree.
    return { state: 'ok', detail: {
      users: users.length, team_registrations: teams,
      hint: 'framefit users lists them; team_registrations is a per-user sum (library_graph reports the distinct team count instead)',
    } };
  },
};

export const tokensCheck: Check = {
  id: 'tokens',
  async run(ctx) {
    if (!ctx.env.DATABASE_URL) return { state: 'skipped', reason: 'DATABASE_URL is not set' };
    if (!ctx.db) return { state: 'skipped', reason: 'no database handle was provided to status' };
    const s = await ctx.db.tokenStats();

    // Checked BEFORE the stored===0 skip below: a user can register a Figma team and never add a
    // token at all, which leaves `stored` at 0 for the whole install while that user's every
    // request still fails. Skipping "nothing registered yet" in that case would hide a real problem
    // behind the message reserved for a truly untouched fresh install.
    // Gated on ctx.multiTenant: registered_teams is a multi-tenant-only concept - single-tenant
    // authenticates via FIGMA_TOKEN directly and never populates or reads that table. Without this
    // gate, a single-tenant box whose DATABASE_URL happens to point at a database carrying old or
    // shared registered_teams rows would fail on a condition that mode structurally cannot have.
    if (ctx.multiTenant && s.users_without_any_token.length > 0) {
      return { state: 'fail', reason: `these users have a registered Figma team but hold no PAT at all, so every request of theirs fails: ${s.users_without_any_token.join(', ')}` };
    }
    if (s.stored === 0) return { state: 'skipped', reason: 'no PATs registered yet' };

    if (s.users_without_default.length > 0) {
      return { state: 'fail', reason: `these users hold tokens but no DEFAULT token, so every request of theirs fails: ${s.users_without_default.join(', ')}` };
    }
    if (s.bad_defaults.length > 0) {
      return { state: 'fail', reason: `default PAT unusable for: ${s.bad_defaults.map((b) => `${b.user} (${b.problem})`).join(', ')}`,
        // NON-default invalids only (the SQL filters on is_default), so this number never re-counts
        // the very defaults the reason above just named by user.
        detail: { invalid_non_default: s.invalid_non_default } };
    }
    // "0 invalid" means nothing if the validator is dead: nightly runs only inside the multi-tenant
    // server process and swallows per-row failures (nightly-validation.ts:37-39), so a key rotation
    // silences it entirely.
    if (ctx.multiTenant) {
      if (s.validation_age_sec === null) return { state: 'fail', reason: 'token validation has never run - nightly validation runs only inside the multi-tenant server process' };
      if (s.validation_age_sec > 2 * NIGHTLY_INTERVAL_SEC) return { state: 'fail', reason: `token validation last ran ${Math.round(s.validation_age_sec / 3600)}h ago (expected daily)` };
      // validation_age_sec is the OLDEST validation, and MIN() ignores NULLs - a token added and
      // never validated even once can hide behind an older-but-non-null row elsewhere.
      // stale_or_unvalidated_total counts NULLs explicitly and catches exactly that gap.
      if (s.stale_or_unvalidated_total > 0) {
        return { state: 'fail', reason: `${s.stale_or_unvalidated_total} token(s) have never been validated or were last checked more than ${2 * NIGHTLY_INTERVAL_SEC / 3600}h ago - the nightly validator is not covering every token` };
      }
    }
    // A last_validated_at later than the database's own now() means the clock is skewed relative to
    // wherever that timestamp was written - every age computation above is then unreliable, so
    // surface the skew itself rather than silently clamping it into a healthy-looking number.
    if (s.future_validation_detected) {
      return { state: 'fail', reason: 'a token has a validation timestamp in the future - the database clock is skewed, so age-based checks here cannot be trusted until it is fixed' };
    }
    return { state: 'ok', detail: {
      stored: s.stored, invalid_non_default: s.invalid_non_default, validated_age_sec: s.validation_age_sec,
      // Single-tenant never runs the nightly validator at all (it lives only in the multi-tenant
      // server process, same as the comment above) - a bare `validated_age_sec=null` here reads
      // like a gap in the data rather than what it is: a field this mode never populates.
      ...(!ctx.multiTenant ? { validation_note: 'not checked here - nightly validation only runs inside the multi-tenant server process' } : {}),
      soonest_expiry: s.soonest_default_expiry
        ? `${s.soonest_default_expiry.user} in ${s.soonest_default_expiry.days}d (${s.soonest_default_expiry.expires_at})`
        : 'none set',
    } };
  },
};

export const libraryGraphCheck: Check = {
  id: 'library_graph',
  async run(ctx) {
    if (!ctx.multiTenant) {
      return { state: 'skipped', reason: 'single-tenant: the graph lives in the server process and this CLI cannot see it - "framefit graph check" REBUILDS it instead (minutes on a large design system)' };
    }
    if (!ctx.env.DATABASE_URL) return { state: 'skipped', reason: 'DATABASE_URL is not set' };
    if (!ctx.db) return { state: 'skipped', reason: 'no database handle was provided to status' };
    const g = await ctx.db.graphStats();
    if (g.teams === 0 && g.libraries === 0) {
      return { state: 'ok', detail: { libraries: 0, teams: 0, note: 'nothing registered yet - start with "framefit teams add <team-id> --user <id>"' } };
    }
    // Named-user branch BEFORE the generic libraries===0 branch: `users_with_teams_and_no_libraries`
    // can be populated even when `libraries` is globally zero (every registered team's owner has
    // nothing synced), and that is the MORE specific fact - checking libraries===0 first would make
    // this branch unreachable exactly in that case, silently downgrading a named list to a generic
    // "<id>" placeholder.
    if (g.users_with_teams_and_no_libraries.length > 0) {
      const who = g.users_with_teams_and_no_libraries;
      return { state: 'fail',
        reason: `these users have registered teams but zero synced libraries across ALL of them (their tokens resolve nothing): ${who.join(', ')} - run "framefit sync --user ${who[0]}"`,
        detail: {
          libraries: g.libraries, variables: g.variables,
          // A DIFFERENT user's partial gap does not make this fail any more failed - reported
          // alongside, not folded into the same list, so a reader does not conflate "cannot resolve
          // anything" with "one team out of several is legitimately empty".
          ...(g.users_with_partial_team_gaps.length > 0 ? { partial_team_gaps: g.users_with_partial_team_gaps } : {}),
        } };
    }
    if (g.libraries === 0) {
      // teams > 0 but no individual user is named (a data-model gap upstream, not this check's) -
      // fall back to the generic placeholder guidance.
      return { state: 'fail', reason: 'teams are registered but no libraries are synced - run "framefit sync --user <id>" for the affected user' };
    }
    // Staleness is REPORTED, not judged: a design system that never changes is not broken. Likewise
    // a PARTIAL per-team gap (some but not all of a user's teams are empty) is reported as a fact,
    // not failed: a team can legitimately hold no variable libraries, and the user can still resolve
    // through their other team(s) - see users_with_teams_and_no_libraries above for the case that
    // genuinely blocks them.
    return { state: 'ok', detail: {
      libraries: g.libraries, variables: g.variables, teams: g.teams,
      oldest_synced_at: g.oldest_synced_at, oldest_age_sec: g.oldest_age_sec,
      ...(g.users_with_partial_team_gaps.length > 0 ? { partial_team_gaps: g.users_with_partial_team_gaps } : {}),
    } };
  },
};

export const figmaCheck: Check = {
  id: 'figma',
  async run(ctx) {
    if (!ctx.probe) {
      return { state: 'skipped', reason: ctx.multiTenant
        ? 'network probe is off by default in multi-tenant (one call per user) - pass --probe'
        : 'network probe turned off with --no-probe' };
    }
    if (!ctx.multiTenant) {
      const token = ctx.env.FIGMA_TOKEN;
      if (!token) return { state: 'skipped', reason: 'no FIGMA_TOKEN to probe (callers may pass a per-call figma_token)' };
      // Single probe, so it gets the WHOLE per-check budget - there is no second user to share it with.
      const result = await ctx.validatePat(token, PER_CHECK_TIMEOUT_MS);
      if (!result.ok) return { state: 'fail', reason: `Figma refused the token (HTTP ${result.status})` };
      return { state: 'ok', detail: { handle: result.handle } };
    }
    // Named separately, the way dbCheck does: a combined "needs X and Y" reason forces an operator
    // to go check both even when only one is actually missing.
    if (!ctx.env.DATABASE_URL) return { state: 'skipped', reason: 'DATABASE_URL is not set' };
    if (!ctx.db) return { state: 'skipped', reason: 'no database handle was provided to status' };
    if (!ctx.env.ENCRYPTION_KEY) return { state: 'skipped', reason: 'ENCRYPTION_KEY is not set' };
    const users = await ctx.db.listUsers();
    if (users.length === 0) return { state: 'skipped', reason: 'no users registered' };
    // Share the runner's per-check budget across N per-user probes: the multi-tenant branch below
    // makes ONE network call per user inside that single budget, so letting every probe claim the
    // full PER_CHECK_TIMEOUT_MS (as a fixed constant would) means a healthy multi-user install, or
    // just one hanging user, drives the WHOLE check to `fail: timed out after <budget>ms` and throws
    // away the per-user attribution this loop exists to produce. Floored at 1s so a very large user
    // count still gets an actionable window per probe rather than one too small to ever succeed.
    const perUserTimeoutMs = Math.max(1_000, Math.floor(PER_CHECK_TIMEOUT_MS / Math.max(1, users.length)));
    let probed = 0; let accepted = 0;
    const bad: string[] = [];
    for (const user of users) {
      const row = await ctx.db.getDefaultPat(user, ctx.env.ENCRYPTION_KEY);
      if (!row) continue;   // reported by the tokens check, not here
      // The decrypted PAT can be quoted by a failing HTTP client; register it so the runner's
      // redactor knows about a value that never appears in the environment.
      ctx.secrets.add(row.pat);
      probed++;
      const result = await ctx.validatePat(row.pat, perUserTimeoutMs);
      if (result.ok) accepted++; else bad.push(`${user} (HTTP ${result.status})`);
    }
    // Nobody has a default PAT to probe: `probed` stayed 0, so NOTHING was actually called. Reporting
    // `ok` here (accepted: "0 of 0", as this used to) renders a green [OK] line for a check that never
    // reached Figma at all - `skipped` is correct because the precondition (a default PAT to probe) is
    // absent, exactly like the `users.length === 0` guard above. The `tokens` check is where "nobody
    // has a default" becomes a hard `fail`; this check only probes what tokens says is usable.
    if (probed === 0) return { state: 'skipped', reason: 'no user has a default PAT to probe - see the tokens check' };
    if (bad.length > 0) return { state: 'fail', reason: `Figma refused the stored PAT of: ${bad.join(', ')}`, detail: { accepted: `${accepted} of ${probed}` } };
    return { state: 'ok', detail: { accepted: `${accepted} of ${probed}` } };
  },
};

// MUST stay the last statement: `collectStatus`'s default parameter references CHECKS, and any
// check const declared BELOW this line throws ReferenceError at module load (TDZ) - hidden until
// the first real invocation.
export const CHECK_IDS = ['config', 'db', 'key', 'tokens', 'library_graph', 'figma'] as const;
export const CHECKS: Check[] = [configCheck, dbCheck, keyCheck, tokensCheck, libraryGraphCheck, figmaCheck];
