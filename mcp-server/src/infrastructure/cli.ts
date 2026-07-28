// mcp-server/src/infrastructure/cli.ts
// Operator CLI for the single-tenant/local stack. `framefit <command> …` never starts the MCP
// server (index.ts dispatches on argv[0] and only the empty/non-CLI path calls main()). All command
// logic lives here behind an injected-deps surface (CliDeps) so every path is unit-testable without
// spawning a process, opening a socket, or touching Postgres.
//
// stdout hygiene: the STDIO server transport owns stdout for the JSON-RPC protocol, so a CLI command
// that also emitted to stdout would be a regression the stdio-smoke gate catches. Here that risk is
// structural — the server and the CLI are mutually exclusive branches — but the contract still holds:
// only genuine command RESULTS go to `out` (stdout); everything advisory/diagnostic goes to `err`
// (stderr). index.ts wires `out`→process.stdout, `err`→process.stderr, and the CLI logger to fd 2.
import type { Logger } from './logger.js';
import type { FigmaApi } from '../ports/figma-api.js';
import type { SyncDeps } from '../multi-tenant/library-sync.js';
import { parseTeamIds, createEnvGraph } from './env-graph.js';
import { signBridgeToken } from '../multi-tenant/bridge-token.js';
import { isEncryptionKeyHex, ENCRYPTION_KEY_HINT } from '../multi-tenant/env.js';
import {
  collectStatus, buildReport, renderText, renderJson, withDeadline, HARD_DEADLINE_MS, effectiveMultiTenant,
  maskDsnCredentials, type StatusCtx, type StatusDb, type TokenStats, type GraphStats, type CheckResult,
} from './status.js';

/**
 * The allowlist of first-arg CLI commands. Anything else → the server boot path (main()).
 * NOTE: {status, teams, sync, users, graph, bridge-token} are RESERVED argv barewords — a bare first
 * arg matching one of these routes to the CLI, never to the server. Any future server-side flag must
 * stay `--`-prefixed: isCliCommand only matches barewords in this set, so a `--foo` first arg always
 * falls through to main(). Never introduce a bareword server flag that could collide with these.
 */
export const CLI_COMMANDS = new Set(['status', 'teams', 'sync', 'users', 'graph', 'bridge-token']);

export function isCliCommand(argv: string[]): boolean {
  return argv.length > 0 && CLI_COMMANDS.has(argv[0]);
}

/**
 * Every side-effecting capability a CLI command needs, injected so tests substitute spies. Env is
 * read POINTWISE (deps.env.DATABASE_URL / ENCRYPTION_KEY / FIGMA_TOKEN / DS_TEAM_IDS) — never through
 * loadMultiTenantEnv, whose all-or-nothing validation would reject the single-tenant graph-check path
 * (which needs no DB, no Keycloak) outright.
 */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  out: (s: string) => void; // stdout — command RESULTS only
  err: (s: string) => void; // stderr — usage, notes, errors
  logger: Logger;
  buildApi: (pat: string, timeoutMs?: number) => FigmaApi;
  syncUser: (userId: string, deps: SyncDeps, opts?: { teamId?: string }) => Promise<{ libraries: number; variables: number; skipped: number }>;
  // Single-tenant env graph builder — graph check reuses the exact resolver createEnvGraphFromConfig
  // wires into the server, so its counts/resolution match the running server's behaviour byte-for-byte.
  createEnvGraph: typeof createEnvGraph;
  // DB lifecycle — wrapped around teams/sync/users ONLY (graph check runs with no DB).
  initDb: (url: string, onError?: (e: Error) => void) => void;
  closeDb: () => Promise<void>;
  ensureSchema: () => Promise<void>;
  ensureLibraryRegistrySchema: () => Promise<void>;
  ensureLibraryGraphSchema: () => Promise<void>;
  // Registry / users / graph persistence.
  addTeam: (userId: string, teamId: string) => Promise<void>;
  listTeams: (userId: string) => Promise<string[]>;
  removeTeam: (userId: string, teamId: string) => Promise<void>;
  listUsers: () => Promise<string[]>;
  getDefaultPat: (userId: string, encryptionKey: string) => Promise<{ pat: string; label: string; status: string } | null>;
  setLibraries: SyncDeps['setLibraries'];
  replaceLibrary: SyncDeps['replaceLibrary'];
  // Mints the scoped upload token for the variable-snapshot ingest contract. Same signer the
  // server's POST /accounts/bridge-token uses, so a CLI-minted token is interchangeable with a
  // portal-minted one.
  signBridgeToken: typeof signBridgeToken;
  // ── status only ───────────────────────────────────────────────────────────────────────────────
  // Read-only aggregates. The TYPES come from status.ts (never restated here): a field added there
  // — a staleness counter, a clock-skew fact — must break every fixture that has not caught up,
  // not be silently absent from what the CLI hands to the checks.
  tokenStats: () => Promise<TokenStats>;
  graphStats: () => Promise<GraphStats>;
  // Must stay identical to StatusCtx.validatePat (status.ts), optional `reason` included: that is
  // Figma's own refusal text, and figmaCheck prints it instead of a bare status code.
  validatePat: (pat: string, timeoutMs?: number) => Promise<{ ok: true; handle: string } | { ok: false; status: number; reason?: string }>;
  // The verify half of the ENCRYPTION_KEY self-test; signBridgeToken above is the sign half.
  verifyBridgeToken: (token: string, secretHex: string, scope: string) => Promise<string | null>;
  now: () => number;
  hostname: () => string;
  pid: () => number;
  /** Optional; defaults to HARD_DEADLINE_MS. A dep, not a flag - testable without public surface. */
  deadlineMs?: number;
  /** Optional; defaults to CLOSE_BUDGET_MS. Same reasoning as deadlineMs: a test must be able to
   *  reach the "the pool will not close" path in milliseconds, not in seconds. */
  closeBudgetMs?: number;
}

const USAGE = `usage: framefit <command>

  status [--json] [--probe|--no-probe]                  diagnose this instance (no prerequisites)
  teams add <team-id|url> --user <keycloak-user-id>     register a DS team for a user
  teams remove <team-id> --user <keycloak-user-id>      unregister a team (+ its synced libs)
  teams list --user <keycloak-user-id>                  list a user's registered teams
  sync --user <keycloak-user-id>                        re-sync a user's library variable graph
  users                                                 list users with a registered PAT
  graph check [<variable-key>]                          single-tenant env-graph diagnostics (no DB)
  bridge-token --user <keycloak-user-id> [--ttl <sec>]  mint a variable-snapshot upload token (no DB)

status needs nothing - it uses whatever is configured and honestly reports the rest as skipped.
Commands teams/sync/users need DATABASE_URL (+ ENCRYPTION_KEY for sync).
graph check needs FIGMA_TOKEN + DS_TEAM_IDS and touches no database.
bridge-token needs ENCRYPTION_KEY (it signs with the same key) and touches no database.
`;

/** Default upload-token lifetime, mirroring the server's POST /accounts/bridge-token (30 min). */
const BRIDGE_TOKEN_TTL_SEC = 30 * 60;
/** Upper bound so a hand-minted token cannot become a long-lived credential. */
const BRIDGE_TOKEN_MAX_TTL_SEC = 24 * 60 * 60;

/** Minimal flag parser: `--user u1` and `--user=u1`; everything else is a positional. */
function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else { flags[key] = ''; }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function usageErr(deps: CliDeps, line: string): number {
  deps.err(`error: ${line}\n\n${USAGE}`);
  return 1;
}

// 2 = "could not run" (usage, internal throw, deadline). 1 stays reserved for "a check failed", so
// a cron wrapper can tell a typo from an unhealthy instance. Only `status` uses this.
function usageErr2(deps: CliDeps, line: string): number {
  deps.err(`error: ${line}\n\n${USAGE}`);
  return 2;
}

/**
 * Per-command DB bootstrap: initDb + the three schemas (main + library-registry + library-graph),
 * closeDb ALWAYS in finally (even on throw/reject). teams/sync/users call this ONLY for the actual
 * DB-touching portion — AFTER argument validation, so a usage error (e.g. missing --user) never
 * requires a live database. graph check never calls it at all. DATABASE_URL is read pointwise here —
 * absent → a clear error, never a crash inside pg.
 */
type DbRunner = (fn: () => Promise<number>) => Promise<number>;

function makeDbRunner(deps: CliDeps): DbRunner {
  return async (fn) => {
    const url = deps.env.DATABASE_URL;
    if (!url) {
      deps.err('error: DATABASE_URL is not set (required for teams/sync/users)\n');
      return 1;
    }
    deps.initDb(url, (e) => deps.logger.error({ err: e.message }, 'pg.pool_error'));
    try {
      await deps.ensureSchema();
      await deps.ensureLibraryRegistrySchema();
      await deps.ensureLibraryGraphSchema();
      return await fn();
    } finally {
      await deps.closeDb();
    }
  };
}

// ── teams ───────────────────────────────────────────────────────────────────────────────────────
async function cmdTeams(args: string[], deps: CliDeps, withDb: DbRunner): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const [sub, idArg] = positionals;
  const user = flags.user;

  if (sub === 'list') {
    if (!user) return usageErr(deps, 'teams list requires --user');
    return withDb(async () => {
      const teams = await deps.listTeams(user);
      if (teams.length === 0) deps.out(`no teams registered for ${user}\n`);
      else deps.out(`${teams.join('\n')}\n`);
      return 0;
    });
  }

  if (sub === 'add' || sub === 'remove') {
    // Argument validation FIRST — no DB connection for a usage/parse error.
    if (!user) return usageErr(deps, `teams ${sub} requires --user`);
    if (!idArg) return usageErr(deps, `teams ${sub} requires a <team-id|url>`);
    // Reuse the boot-time team-id parser: it unwraps a figma.com/team/<id> URL and validates
    // all-digits, THROWING (naming the bad token) on garbage — exactly the guard we want here.
    let teamId: string;
    try {
      const ids = parseTeamIds(idArg);
      if (ids.length === 0) { deps.err(`error: no valid team id in "${idArg}"\n`); return 1; }
      teamId = ids[0];
    } catch (e) {
      deps.err(`error: ${(e as Error).message}\n`);
      return 1;
    }
    return withDb(async () => {
      if (sub === 'add') {
        await deps.addTeam(user, teamId);
        deps.out(`added team ${teamId} for user ${user}\n`);
      } else {
        await deps.removeTeam(user, teamId);
        deps.out(`removed team ${teamId} for user ${user}\n`);
      }
      return 0;
    });
  }

  return usageErr(deps, 'teams <add|remove|list>');
}

// ── users ───────────────────────────────────────────────────────────────────────────────────────
async function cmdUsers(_args: string[], deps: CliDeps, withDb: DbRunner): Promise<number> {
  return withDb(async () => {
    const users = await deps.listUsers();
    if (users.length === 0) deps.out('no users have a registered PAT\n');
    else deps.out(`${users.join('\n')}\n`);
    return 0;
  });
}

// ── sync ────────────────────────────────────────────────────────────────────────────────────────
async function cmdSync(args: string[], deps: CliDeps, withDb: DbRunner): Promise<number> {
  const { flags } = parseFlags(args);
  const user = flags.user;
  if (!user) return usageErr(deps, 'sync requires --user');

  // ENCRYPTION_KEY is a pointwise env prerequisite for decrypting the PAT — validate it before the DB.
  // Same shape check bridge-token and loadMultiTenantEnv use: a mangled key would otherwise surface as
  // an opaque AES failure deep inside the sync instead of one actionable line here.
  const encryptionKey = deps.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    deps.err('error: ENCRYPTION_KEY is not set (required to decrypt the stored PAT for sync)\n');
    return 1;
  }
  if (!isEncryptionKeyHex(encryptionKey)) {
    deps.err(`error: ${ENCRYPTION_KEY_HINT}\n`);
    return 1;
  }

  return withDb(async () => {
    // getPat CLI-path = getDefaultPat, which itself decrypts the stored PAT with AAD = userId
    // (crypto.ts). A missing default PAT is the {0,0,0}-source we short-circuit on: without a token
    // nothing can sync.
    const patRow = await deps.getDefaultPat(user, encryptionKey);
    if (!patRow) {
      deps.err(`error: no default Figma PAT registered for user ${user} — cannot sync\n`);
      return 1;
    }

    const result = await deps.syncUser(user, {
      buildApi: deps.buildApi,
      getPat: async () => patRow.pat,
      listTeams: deps.listTeams,
      setLibraries: deps.setLibraries,
      replaceLibrary: deps.replaceLibrary,
      logger: deps.logger,
    });

    // Result → stdout; the operational caveat → stderr (advisory, not a result).
    deps.out(`synced user ${user}: ${result.libraries} libraries, ${result.variables} variables, ${result.skipped} skipped\n`);
    deps.err(
      'note: a running framefit server holds this graph in memory for the life of the process — ' +
      'restart it (docker compose restart framefit) for this sync to take effect.\n',
    );
    return 0;
  });
}

// ── graph check ─────────────────────────────────────────────────────────────────────────────────
// Diagnostics for the single-tenant env graph, with NO database. Reuses createEnvGraph — the very
// resolver createEnvGraphFromConfig wires into the running server — so a check's counts and
// resolution match production byte-for-byte. ensureReady() drives ONE sync; stats() surfaces the
// {libraries, variables} counts (no second fetch); resolve() serves the optional key, including
// modesByName for a multi-mode key via the same wrapper the server uses.
async function cmdGraph(args: string[], deps: CliDeps): Promise<number> {
  const { positionals } = parseFlags(args);
  const [sub, keyArg] = positionals;
  if (sub !== 'check') return usageErr(deps, 'graph check [<variable-key>]');

  const token = deps.env.FIGMA_TOKEN;
  if (!token) {
    deps.err('error: FIGMA_TOKEN is not set (the env graph needs a token to sync)\n');
    return 1;
  }
  let teamIds: string[];
  try {
    teamIds = parseTeamIds(deps.env.DS_TEAM_IDS);
  } catch (e) {
    deps.err(`error: ${(e as Error).message}\n`);
    return 1;
  }
  if (teamIds.length === 0) {
    deps.err('error: DS_TEAM_IDS is not set (no teams to check)\n');
    return 1;
  }

  const graph = deps.createEnvGraph({ teamIds, token, buildApi: deps.buildApi, logger: deps.logger });
  await graph.ensureReady();
  const stats = graph.stats();
  const libraries = stats?.libraries ?? 0;
  const variables = stats?.variables ?? 0;

  deps.out(`teams: ${teamIds.length}\nlibraries: ${libraries}\nvariables: ${variables}\n`);

  if (keyArg) {
    const r = graph.resolve(keyArg);
    if (r) {
      const src = r.sourceLibrary ? ` [${r.sourceLibrary}]` : '';
      const modes = r.modesByName ? ` modes=${JSON.stringify(r.modesByName)}` : '';
      deps.out(`resolve ${keyArg}: ${r.value}${r.name ? ` (${r.name})` : ''}${src}${modes}\n`);
    } else {
      deps.out(`resolve ${keyArg}: unresolved\n`);
    }
  }

  if (libraries === 0) {
    deps.err('error: env graph is empty — 0 libraries synced from the configured team(s)\n');
    return 1;
  }
  return 0;
}

/**
 * `bridge-token --user <id> [--ttl <sec>]` — mints the scoped token the variable-snapshot ingest
 * contract requires (POST /api/variables/snapshot, documented in docs/snapshot-ingest.md). Without
 * this command the only way to obtain one is the portal or a hand-rolled JWT-authed call to
 * POST /accounts/bridge-token, which is exactly the friction the operator CLI exists to remove.
 *
 * No DB: signing is pure crypto over ENCRYPTION_KEY, and the server's own issue() does not check the
 * user either (its id comes from the verified JWT). The user id is therefore taken on trust here —
 * uploads land under whatever id is signed, so pass one that `framefit users` lists.
 *
 * The token itself is the command RESULT (stdout, bare, newline-terminated) so it pipes cleanly:
 *   TOKEN=$(framefit bridge-token --user u1)
 * (pipe it, don't redirect it into the checkout — it is a live credential). Expiry/scope/next-step
 * advice, the signed-id caveat, and the "cannot be revoked" caveat go to stderr.
 */
async function cmdBridgeToken(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseFlags(args);
  const user = flags.user;
  if (!user) return usageErr(deps, 'bridge-token requires --user <keycloak-user-id>');
  const key = deps.env.ENCRYPTION_KEY;
  if (!key) {
    deps.err('error: ENCRYPTION_KEY is not set (the upload token is signed with it)\n');
    return 1;
  }
  // Shape-check with the SAME predicate loadMultiTenantEnv uses (env.ts), which this CLI otherwise
  // bypasses: a mangled/short/non-hex key would either throw a raw DOMException out of the HS256
  // signer or, worse, mint a token no server can ever verify — the operator would only see a bare 403.
  if (!isEncryptionKeyHex(key)) {
    deps.err(`error: ${ENCRYPTION_KEY_HINT} — the current value cannot sign a verifiable token\n`);
    return 1;
  }
  let ttl = BRIDGE_TOKEN_TTL_SEC;
  if (flags.ttl !== undefined) {
    const parsed = Number(flags.ttl);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > BRIDGE_TOKEN_MAX_TTL_SEC) {
      return usageErr(deps, `--ttl must be a positive integer up to ${BRIDGE_TOKEN_MAX_TTL_SEC} seconds`);
    }
    ttl = parsed;
  }
  const token = await deps.signBridgeToken(user, key, ttl);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  deps.out(`${token}\n`);
  deps.err(
    `scope: variables:snapshot — expires ${expiresAt} (${ttl}s)\n` +
    'upload with: POST <base>/api/variables/snapshot, header "Authorization: Bearer <token>",\n' +
    'body {"library_file_key": "<key>", "entries": [...]} — see docs/snapshot-ingest.md\n' +
    `note: uploads land under exactly the signed id "${user}" (no FK is checked) — cross-check it with "framefit users".\n` +
    'note: bridge-tokens cannot be revoked; they only expire (rotating ENCRYPTION_KEY invalidates every stored PAT too).\n',
  );
  return 0;
}

// ── status ──────────────────────────────────────────────────────────────────────────────────────
/** The complete flag vocabulary of `status`. An unknown flag is a usage error, never ignored:
 *  `--no-prob` silently accepted would PERFORM the network probe the operator asked to suppress,
 *  and `--jsom` would hand human text to a JSON consumer - both at exit 0, which is worse than a
 *  refusal because the caller has no way to notice. */
const STATUS_FLAGS = ['json', 'probe', 'no-probe'] as const;

/** How long `status` waits for the pg pool to drain before giving up on it. pool.end() waits for
 *  the clients an abandoned check left mid-query, and initDb builds the pool with no connect or
 *  statement timeout, so an UNBOUNDED close turns "a dependency is not answering" into "status
 *  never exits" - defeating the hard deadline in exactly the situation it exists for. Short on
 *  purpose: the process is about to exit anyway, and the OS reclaims the sockets. */
const CLOSE_BUDGET_MS = 2_000;

/**
 * Close the read-only pool without ever changing an exit code the report already earned. Both the
 * timeout and a rejection are logged, not propagated: a verdict that was reached and printed must
 * not be overwritten by a teardown problem (a rejecting closeDb used to turn a printed, complete
 * report into exit 2). Bounded per CLOSE_BUDGET_MS above.
 */
async function closeStatusPool(deps: CliDeps): Promise<void> {
  const budgetMs = deps.closeBudgetMs ?? CLOSE_BUDGET_MS;
  try {
    const closed = await withDeadline(deps.closeDb().then(() => true), budgetMs);
    if (closed === null) {
      deps.logger.warn({ budget_ms: budgetMs }, 'status.pool_close_timed_out');
    }
  } catch (e) {
    // The pool's own error text can quote the DSN; same masker the checks' redactor uses.
    deps.logger.warn({ err: maskDsnCredentials(e instanceof Error ? e.message : String(e)) }, 'status.pool_close_failed');
  }
}

/**
 * `status [--json] [--probe|--no-probe]` — instance self-diagnosis. Unlike teams/sync/users this
 * does NOT run the DB bootstrap (makeDbRunner): a diagnostic that migrates the schema it inspects is
 * not a diagnostic. It opens the pool only to SELECT, and always closes it — under a bounded budget
 * (closeStatusPool), so the command remains bounded END TO END and not just up to the last check.
 *
 * Exit codes are the machine surface: 0 = nothing failed, 1 = a check failed, 2 = the command could
 * not run at all (usage error, internal throw, deadline). Nothing here calls `check.run()` directly:
 * every check goes through `collectStatus`, which owns BOTH the throw-to-fail conversion and secret
 * redaction — bypassing it would hand back an unredacted reason and let this command's idea of the
 * mode drift from the report header's.
 */
async function cmdStatus(args: string[], deps: CliDeps): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  if (positionals.length > 0) return usageErr2(deps, `status takes no positional arguments (got "${positionals[0]}")`);
  for (const name of Object.keys(flags)) {
    if (!(STATUS_FLAGS as readonly string[]).includes(name)) {
      return usageErr2(deps, `unknown flag --${name} (status accepts ${STATUS_FLAGS.map((f) => `--${f}`).join(', ')})`);
    }
  }
  // parseFlags assigns '' to a valueless flag (see parseFlags above), so truthiness is ALWAYS false
  // for --json/--probe/--no-probe. Presence (!== undefined) is the signal; a value is a usage error.
  for (const name of STATUS_FLAGS) {
    const value = flags[name];
    if (value === undefined || value === '') continue;
    // `--probe wat` and `--probe=wat` are DIFFERENT mistakes: in the first, parseFlags swallowed a
    // bare argument as the flag's value, so "--probe takes no value" alone would name the wrong
    // problem and leave the operator staring at an argument the message never mentions.
    const attached = args.some((a) => a.startsWith(`--${name}=`));
    return usageErr2(deps, attached
      ? `--${name} takes no value (got "${value}")`
      : `--${name} takes no value - "${value}" was read as its value, and status takes no positional arguments either`);
  }
  if (flags.probe !== undefined && flags['no-probe'] !== undefined) {
    return usageErr2(deps, '--probe and --no-probe are mutually exclusive');
  }
  const json = flags.json !== undefined;
  const transport = deps.env.MCP_TRANSPORT;
  // effectiveMultiTenant(env) is the ONE derivation of the mode — the same function collectStatus
  // uses to overwrite ctx.multiTenant before any check runs. Recomputing the expression inline here
  // would give the probe default a second, independently maintained source of truth, free to drift
  // from the mode the checks and the report header actually report.
  const multiTenant = effectiveMultiTenant(deps.env);
  // Single-tenant probes by default: without it a stdio run is one green line and five skips, i.e.
  // no evidence about the token, which is the newcomer's actual question. Multi-tenant does not:
  // there it is one network call per user.
  const probe = flags['no-probe'] !== undefined ? false : flags.probe !== undefined ? true : !multiTenant;

  const hasDb = Boolean(deps.env.DATABASE_URL);
  try {
    // INSIDE the try: a throwing initDb (a malformed DSN) must still reach the close below - pg can
    // have built the pool before throwing, and closeDb is a no-op when it did not.
    if (hasDb) {
      deps.initDb(deps.env.DATABASE_URL as string, (e) => {
        // pg puts the whole DSN (password included) in ECONNREFUSED; never log it raw. This callback
        // fires outside collectStatus's redactor, so the mask has to be applied at this call site -
        // via the same exported masker the redactor itself uses.
        deps.logger.error({ err: maskDsnCredentials(e.message) }, 'pg.pool_error');
      });
    }
    const db: StatusDb | undefined = hasDb ? {
      listUsers: deps.listUsers,
      listTeams: deps.listTeams,
      getDefaultPat: deps.getDefaultPat,
      tokenStats: deps.tokenStats,
      graphStats: deps.graphStats,
    } : undefined;

    const ctx: StatusCtx = {
      env: deps.env, now: deps.now, multiTenant, transport, probe, db,
      signBridgeToken: deps.signBridgeToken, verifyBridgeToken: deps.verifyBridgeToken,
      validatePat: deps.validatePat, hostname: deps.hostname(), pid: deps.pid(),
      secrets: new Set<string>(),
    };
    // The sink lets the deadline path print what completed instead of nothing.
    const sink: ({ id: string } & CheckResult)[] = [];
    const deadlineMs = deps.deadlineMs ?? HARD_DEADLINE_MS;
    const report = await withDeadline(collectStatus(ctx, undefined, { sink }), deadlineMs);

    if (!report) {
      // Print the PARTIAL report, not just an error line: the checks that did finish are exactly the
      // evidence that narrows down which dependency is hanging. buildReport's default expectation is
      // the default registry - the very list collectStatus just ran - so a short sink is reported as
      // summary.complete: false with ok_overall: false, and no consumer reads an aborted run as green.
      const partial = buildReport(ctx, sink);
      deps.out(json ? renderJson(partial) : renderText(partial));
      deps.err(`error: status did not finish within ${deadlineMs}ms - a dependency is not answering\n`);
      return 2;
    }
    deps.out(json ? renderJson(report) : renderText(report));
    // Scope caveat to stderr, ALWAYS: with --json, stdout must carry exactly one JSON document and
    // nothing else, so a consumer can pipe it straight into a parser.
    deps.err('note: status reports what THIS process sees with this environment and database; it does not see a running server\'s memory.\n');
    return report.summary.failed > 0 ? 1 : 0;
  } finally {
    if (hasDb) await closeStatusPool(deps);
  }
}

/**
 * Dispatch one CLI invocation and return its exit code (index.ts calls process.exit with it). teams/
 * sync/users run inside a per-command DB bootstrap; status, graph check and bridge-token deliberately
 * do not (status opens the pool itself, read-only, and closes it).
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const withDb = makeDbRunner(deps);
  switch (cmd) {
    case 'status': return cmdStatus(rest, deps);
    case 'teams': return cmdTeams(rest, deps, withDb);
    case 'sync': return cmdSync(rest, deps, withDb);
    case 'users': return cmdUsers(rest, deps, withDb);
    case 'graph': return cmdGraph(rest, deps);
    case 'bridge-token': return cmdBridgeToken(rest, deps);
    default:
      deps.err(`error: unknown command "${cmd ?? ''}"\n\n${USAGE}`);
      return 1;
  }
}
