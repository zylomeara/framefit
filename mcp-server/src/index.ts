#!/usr/bin/env node
import pino from 'pino';
import { loadConfig } from './infrastructure/config.js';
import { createLogger, type Logger } from './infrastructure/logger.js';
import { startServer } from './infrastructure/server.js';
import { isMultiTenant, loadMultiTenantEnv } from './multi-tenant/env.js';
import { hostname } from 'node:os';
import { initDb, ensureSchema, closeDb, getDefaultPat, listUsers, tokenStats } from './multi-tenant/db.js';
import { ensureCodeConnectSchema } from './multi-tenant/code-connect-db.js';
import { ensureVariableSnapshotSchema } from './multi-tenant/variable-snapshot-db.js';
import { ensureLibraryRegistrySchema, addTeam, listTeams, removeTeam, setLibraries } from './multi-tenant/library-registry-db.js';
import { ensureLibraryGraphSchema, replaceLibrary, graphStats, type GraphVar, type GraphColl } from './multi-tenant/library-graph-db.js';
import { syncUser } from './multi-tenant/library-sync.js';
import { FigmaRestAdapter } from './adapters/driven/figma-rest.js';
import { initJwt } from './multi-tenant/jwt.js';
import { signBridgeToken, verifyBridgeToken } from './multi-tenant/bridge-token.js';
import { validatePat } from './multi-tenant/validate-pat.js';
import { startNightlyValidation } from './multi-tenant/nightly-validation.js';
import { ensureAuditSchema, startAuditRetention } from './multi-tenant/audit-db.js';
import { ensureUsageSchema, startUsageRetention } from './multi-tenant/usage-db.js';
import { multiTenantEnvGraphConflict, createEnvGraph } from './infrastructure/env-graph.js';
import { isCliCommand, runCli, type CliDeps } from './infrastructure/cli.js';

async function main(): Promise<void> {
  // Boot guard: DS_TEAM_IDS (single-tenant env graph) and MULTI_TENANT are mutually exclusive —
  // MT builds the variable-library graph per-user from the DB, so a process-wide DS_TEAM_IDS would
  // be silently ignored. Fail loud BEFORE any server start rather than run misconfigured.
  const envGraphConflict = multiTenantEnvGraphConflict();
  if (envGraphConflict) {
    process.stderr.write(`fatal: ${envGraphConflict}\n`);
    process.exit(1);
  }

  const config = loadConfig();
  // stdio transport reserves stdout for the JSON-RPC protocol, so logs must go
  // to stderr; HTTP mode keeps the default stdout destination.
  const logger = createLogger({
    level: config.LOG_LEVEL,
    destination:
      config.MCP_TRANSPORT === 'stdio'
        ? pino.destination({ dest: 2, sync: true })
        : undefined,
  });

  let mt: import('./infrastructure/server.js').MultiTenantContext | undefined;
  let stopNightly: (() => void) | undefined;
  let stopAuditRetention: (() => void) | undefined;
  let stopUsageRetention: (() => void) | undefined;
  if (config.MCP_TRANSPORT === 'http' && isMultiTenant()) {
    const env = loadMultiTenantEnv();
    initDb(env.databaseUrl, (err) => logger.error({ err: err.message }, 'pg.pool_error'));
    await ensureSchema();
    await ensureCodeConnectSchema();
    await ensureVariableSnapshotSchema();
    await ensureLibraryRegistrySchema();
    await ensureLibraryGraphSchema();
    await ensureAuditSchema();
    await ensureUsageSchema();
    initJwt(env.keycloakJwksUrl, env.oauthAuthorizationServer);
    stopNightly = startNightlyValidation({ encryptionKey: env.encryptionKey, logger });
    stopAuditRetention = startAuditRetention({ logger });
    stopUsageRetention = startUsageRetention({ logger });
    mt = { env };
    logger.info({ mcp_host: env.mcpHost }, 'multi_tenant.enabled');
  }

  const handle = await startServer(config, logger, mt);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'server.shutdown');
    const timer = setTimeout(() => process.exit(1), 5000);
    try {
      await handle.close();
      stopNightly?.();
      stopAuditRetention?.();
      stopUsageRetention?.();
      await closeDb();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'server.shutdown_error');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message }, 'uncaughtException');
    process.exit(1);
  });
}

/**
 * The CLI's own logger, which must NEVER be the thing that decides whether a command can run: pino
 * throws for any level outside its enum — the same values loadConfig's zod schema rejects — so
 * building it from a bad LOG_LEVEL used to kill the process with a pino stack trace before `status`
 * could report that very misconfiguration (its headline example). Fall back to 'info' and let the
 * config check name the offending value on stdout, where an operator can act on it.
 */
function buildCliLogger(): Logger {
  const destination = pino.destination({ dest: 2, sync: true });
  const level = process.env.LOG_LEVEL ?? 'info';
  try {
    return createLogger({ level, destination });
  } catch {
    // Say so, once, on stderr. `status` names the offending value on stdout via its config check, but
    // the other five commands never look at LOG_LEVEL at all - for them this fallback used to be a
    // silent downgrade of a setting the operator deliberately set (before it existed, pino crashed
    // loudly instead). ASCII and stderr-only, so it cannot corrupt a `--json` stdout document.
    process.stderr.write(`warning: LOG_LEVEL "${level}" is not a valid log level - falling back to "info" (run "framefit status" for the full config verdict)\n`);
    return createLogger({ level: 'info', destination });
  }
}

// Assemble the operator-CLI dependency surface from the real modules. The CLI logger is pinned to
// fd 2 (stderr) so — like the stdio server path — a CLI invocation writes ZERO diagnostic bytes to
// stdout; only genuine command RESULTS reach stdout via `out`. buildApi builds a bare (un-cached)
// REST adapter: a one-shot CLI command has no cache to reuse.
function buildCliDeps(): CliDeps {
  const logger = buildCliLogger();
  return {
    env: process.env,
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s); },
    logger,
    buildApi: (pat, timeoutMs) => new FigmaRestAdapter(pat, logger, 4, timeoutMs ?? 90000),
    syncUser,
    createEnvGraph,
    initDb,
    closeDb,
    ensureSchema,
    ensureLibraryRegistrySchema,
    ensureLibraryGraphSchema,
    addTeam,
    listTeams,
    removeTeam,
    listUsers,
    getDefaultPat,
    setLibraries,
    // SyncDeps.replaceLibrary takes vars/colls as unknown[]; the graph-db impl wants GraphVar[]/
    // GraphColl[]. Same narrowing cast the MT server applies at its syncUser call site.
    replaceLibrary: (u, fk, vars, colls) => replaceLibrary(u, fk, vars as GraphVar[], colls as GraphColl[]),
    signBridgeToken,
    // status only: read-only aggregates, the verify half of the key self-test, and the process facts
    // the report's scope header names (so a reader can tell WHICH box answered).
    tokenStats,
    graphStats,
    validatePat,
    verifyBridgeToken,
    now: () => Date.now(),
    hostname: () => hostname(),
    pid: () => process.pid,
  };
}

// argv dispatch. An allowlisted first arg ({status,teams,sync,users,graph,bridge-token}) runs a CLI command and exits —
// it must NEVER fall through to main(), or the command would ALSO boot the MCP server. Any other
// argv (the empty/normal case) is the server path: main() writes nothing to stdout (the stdio
// transport owns it — the stdio-smoke gate). All CLI/boot-error output goes to stderr.
const argv = process.argv.slice(2);
if (isCliCommand(argv)) {
  // buildCliDeps() is constructed INSIDE the chain, not as an argument evaluated outside it: any
  // throw while assembling the deps (a pino/adapter constructor rejecting the environment) would
  // otherwise escape the .catch() below and take Node's default exit 1 — the code reserved for "a
  // check failed" — for something that never got to run a check at all.
  Promise.resolve()
    .then(() => runCli(argv, buildCliDeps()))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${(err as Error)?.stack ?? (err as Error)?.message ?? String(err)}\n`);
      // 2 = "could not run" for status ONLY (its documented contract: 0 nothing failed, 1 a check
      // failed, 2 could not run). The other commands keep their historical 1 - widening this to every
      // command would silently redefine their exit contract.
      process.exit(argv[0] === 'status' ? 2 : 1);
    });
} else {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
