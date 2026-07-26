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
  multiTenant: boolean;            // EFFECTIVE mode, decided by the caller
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
  invalid_total: number;
  users_without_default: string[];
  bad_defaults: { user: string; label: string; problem: 'invalid' | 'expired'; expires_at: string | null }[];
  soonest_default_expiry: { user: string; expires_at: string; days: number } | null;
  last_validated_at: string | null;
  validation_age_sec: number | null;
}

export interface GraphStats {
  libraries: number; variables: number; teams: number;
  users_with_teams_and_no_libraries: string[];
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
  summary: { total: number; ok: number; skipped: number; failed: number; ok_overall: boolean };
}

import { createHash } from 'node:crypto';
import { VERSION } from './version.js';

const PER_CHECK_TIMEOUT_MS = 10_000;
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

function makeRedactor(ctx: StatusCtx): (s: string) => string {
  const values: [string, string][] = [];
  for (const name of SECRET_VARS) {
    const v = ctx.env[name];
    if (v && v.length >= 8) values.push([v, `<redacted:${name}>`]);
  }
  for (const v of ctx.secrets) if (v.length >= 8) values.push([v, '<redacted:secret>']);
  return (s) => {
    let out = s;
    for (const [needle, mask] of values) out = out.split(needle).join(mask);
    // Credentials only - the HOST of a DATABASE_URL is the diagnostic value, keep it.
    return out.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1<redacted>@');
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
    // A swallowed error is a false green: surface it as a failure with its message.
    return { id: check.id, ...redactResult({ state: 'fail', reason: (e as Error).message ?? String(e) }, redact) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildReport(ctx: StatusCtx, results: ({ id: string } & CheckResult)[]): StatusReport {
  const ok = results.filter((r) => r.state === 'ok').length;
  const skipped = results.filter((r) => r.state === 'skipped').length;
  const failed = results.filter((r) => r.state === 'fail').length;
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
    summary: { total: results.length, ok, skipped, failed, ok_overall: failed === 0 },
  };
}

export async function collectStatus(
  ctx: StatusCtx,
  checks: Check[] = CHECKS,
  opts: { perCheckTimeoutMs?: number; sink?: ({ id: string } & CheckResult)[] } = {},
): Promise<StatusReport> {
  const timeoutMs = opts.perCheckTimeoutMs ?? PER_CHECK_TIMEOUT_MS;
  const redact = makeRedactor(ctx);
  // SEQUENTIAL on purpose: the checks share one pg pool and the probe makes one network call per
  // user. `sink` is filled as results arrive so a caller whose deadline fires can still render
  // what completed.
  const results = opts.sink ?? [];
  for (const check of checks) results.push(await runOne(check, ctx, timeoutMs, redact));
  return buildReport(ctx, results);
}

/** Resolves null if `work` outlives the deadline; the caller renders the sink and exits 2. */
export function withDeadline<T>(work: Promise<T>, ms = HARD_DEADLINE_MS): Promise<T | null> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work.then((v) => { clearTimeout(timer); return v; }),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); }),
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
  return [...head, ...lines, '', `${s.ok} ok, ${s.skipped} skipped, ${s.failed} failed`, ''].join('\n');
}

export function renderJson(report: StatusReport): string { return `${JSON.stringify(report)}\n`; }

// MUST stay the last statement: `collectStatus`'s default parameter references CHECKS, and any
// check const declared BELOW this line throws ReferenceError at module load (TDZ) - hidden until
// the first real invocation.
export const CHECK_IDS = ['config', 'db', 'key', 'tokens', 'library_graph', 'figma'] as const;
export const CHECKS: Check[] = [];   // Tasks 3, 4 and 5a fill this, in CHECK_IDS order
