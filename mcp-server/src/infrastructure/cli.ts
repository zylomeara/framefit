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

/**
 * The allowlist of first-arg CLI commands. Anything else → the server boot path (main()).
 * NOTE: {teams, sync, users, graph, bridge-token} are RESERVED argv barewords — a bare first arg
 * matching one of these routes to the CLI, never to the server. Any future server-side flag must stay
 * `--`-prefixed: isCliCommand only matches barewords in this set, so a `--foo` first arg always falls
 * through to main(). Never introduce a bareword server flag that could collide with these.
 */
export const CLI_COMMANDS = new Set(['teams', 'sync', 'users', 'graph', 'bridge-token']);

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
}

const USAGE = `usage: framefit <command>

  teams add <team-id|url> --user <keycloak-user-id>     register a DS team for a user
  teams remove <team-id> --user <keycloak-user-id>      unregister a team (+ its synced libs)
  teams list --user <keycloak-user-id>                  list a user's registered teams
  sync --user <keycloak-user-id>                        re-sync a user's library variable graph
  users                                                 list users with a registered PAT
  graph check [<variable-key>]                          single-tenant env-graph diagnostics (no DB)
  bridge-token --user <keycloak-user-id> [--ttl <sec>]  mint a variable-snapshot upload token (no DB)

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

/**
 * Dispatch one CLI invocation and return its exit code (index.ts calls process.exit with it). teams/
 * sync/users run inside a per-command DB bootstrap; graph check and bridge-token deliberately do not.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const withDb = makeDbRunner(deps);
  switch (cmd) {
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
