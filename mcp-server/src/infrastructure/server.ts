import 'express-async-errors';
import express from 'express';
import type { Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { registerAllTools } from '../adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../adapters/driving/tools/get-comments-tool.js';
import {
  PORTAL_READ_ONLY_REMEDIATION, SINGLE_TENANT_READ_ONLY_REMEDIATION, type ReadOnlyGate,
} from '../adapters/driving/tools/shared-error-handler.js';
import { CachingFigmaApiAdapter } from '../adapters/driven/caching-figma-api.js';
import type { ReadCaches } from '../adapters/driven/caching-figma-api.js';
import { FileStructureCache } from './file-structure-cache.js';
import { FigmaRestAdapter } from '../adapters/driven/figma-rest.js';
import { getFigmaSemaphore, getMaterializeGovernor } from './semaphore.js';
import { FrameHydrationStore, makeFrameHandle } from './frame-hydration-store.js';
import { TtlCache } from './node-cache.js';
import { CacheBudget } from './cache-budget.js';
import { validateJwt, extractBearerToken, assertAzp } from '../multi-tenant/jwt.js';
import { createAccountsRouter, type AccountsApiDeps } from '../multi-tenant/accounts-api.js';
import { validatePat } from '../multi-tenant/validate-pat.js';
import { getDefaultPat, pingDb as defaultPingDb, getUserSettings, setReadOnly } from '../multi-tenant/db.js';
import { createCodeConnectIngest } from '../multi-tenant/code-connect-ingest.js';
import {
  resolveCiKey as ccResolveCiKey, replaceMappings as ccReplaceMappings,
  createCiKey as ccCreateCiKey, listCiKeys as ccListCiKeys, revokeCiKey as ccRevokeCiKey,
  lookupMappings as ccLookupMappings,
} from '../multi-tenant/code-connect-db.js';
import { recordAuditEvent, listAuditEvents } from '../multi-tenant/audit-db.js';
import { recordUsage, getUsageSummary } from '../multi-tenant/usage-db.js';
import type { StoredMapping, MappingHit } from '../domain/code-connect.js';
import { createVariableSnapshotIngest } from '../multi-tenant/variable-snapshot-ingest.js';
import { DomSnapshotStore } from './dom-snapshot-store.js';
import { createDomSnapshotRoutes } from './dom-snapshot-routes.js';
import { signBridgeToken, verifyBridgeToken } from '../multi-tenant/bridge-token.js';
import { replaceSnapshot, lookupSnapshot, type SnapshotHit } from '../multi-tenant/variable-snapshot-db.js';
import { userGraphPort } from './user-graph-port.js';
import type { Graph } from '../domain/variable-graph.js';
import type { SnapshotEntry } from '../domain/variable-snapshot.js';
import type { MultiTenantEnv } from '../multi-tenant/env.js';
import { addTeam, listTeams, removeTeam, setLibraries, listLibraries, hasLibraryFile } from '../multi-tenant/library-registry-db.js';
import { replaceLibrary, type GraphVar, type GraphColl } from '../multi-tenant/library-graph-db.js';
import { discoverLibraries } from '../multi-tenant/team-discovery.js';
import { syncUser } from '../multi-tenant/library-sync.js';
import { createEnvGraphFromConfig } from './env-graph.js';
import type { FigmaApi } from '../ports/figma-api.js';
import type { Request, Response, NextFunction } from 'express';
import { allowedOriginSet, makeOriginGuard } from './origin-guard.js';
import { SERVER_INFO } from './version.js';
import { startStdioBrowserBridge, type StdioBrowserBridge } from './stdio-browser-bridge.js';

export type ServerHandle = {
  port: number;
  /**
   * The address the socket ACTUALLY bound, read back from server.address(). Exposed because the
   * only sound assertion about a bind is over this value: a config default is true with zero
   * wiring, and this server has two listen sites.
   */
  address: string;
  close: () => Promise<void>;
};

/**
 * The host a BROWSER can dial for a server bound to `bindHost`. A wildcard is not a dialable
 * origin, so it maps to loopback; a concrete address is used as-is, which is what makes
 * BIND_HOST=<lan-address> produce a working upload_url without PUBLIC_BASE_URL. IPv6 literals are
 * bracketed for URL use.
 */
export function dialableHost(bindHost: string): string {
  if (bindHost === '0.0.0.0' || bindHost === '::') return '127.0.0.1';
  return isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost;
}

/**
 * Is this bind address a loopback address - one that answers ONLY inside its own network namespace?
 * A container bound to loopback has a dead published port, which is exactly what the image
 * healthcheck needs to know and cannot observe from outside.
 *
 * This lives in application code, and it NORMALISES before it classifies, because the alternative -
 * pattern-matching the BIND_HOST string in shell - produced three separate false-green holes in
 * review (`127.0.0.2`, then `0:0:0:0:0:0:0:1`, then the `::ffff:` family in four more spellings).
 * A literal list reads complete and is not: `::1` alone has at least six spellings and the v4-mapped
 * loopback block has both a dotted and a hex rendering.
 *
 * The WHATWG URL parser is a total, spec-defined IPv6 canonicaliser that ships with Node: every
 * spelling of one address collapses to exactly one string (v4-mapped renders hex, so
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` both become `::ffff:7f00:1`). Over canonical values the
 * loopback space is finite and provable - 127.0.0.0/8, `::1`, and that block mapped into IPv6 - so
 * the classification below is complete rather than merely long.
 *
 * Unparseable input answers `true` (loopback), deliberately: the only caller is a health signal,
 * where an unknown bind must degrade to a visible alarm and never to a silent pass.
 */
export function isLoopbackBind(address: string): boolean {
  let host: string;
  try {
    host = new URL(isIP(address) === 6 ? `http://[${address}]/` : `http://${address}/`).hostname;
  } catch {
    return true;
  }
  if (host === 'localhost' || host.startsWith('127.') || host === '[::1]') return true;
  // 127.0.0.0/8 mapped into IPv6, in the URL parser's hex rendering (::ffff:7f00:0 ..
  // ::ffff:7fff:ffff). Anchored at the start of the host, so a global address that merely CONTAINS
  // those bytes - 2001:db8::ffff:7f00:1, 7f00::1, 2001:7fab::5 - is not caught.
  return /^\[::ffff:7f[0-9a-f]{2}:/.test(host);
}

/**
 * The `bind` block of the /health payload: the CANONICAL address the socket bound (read back from
 * server.address(), so the kernel has already normalised the operator's spelling) plus the loopback
 * verdict computed here. The container healthcheck reads this instead of interpreting BIND_HOST,
 * which is what keeps address classification out of shell patterns for good.
 */
function healthBind(address: string): { address: string; loopback: boolean } {
  return { address, loopback: isLoopbackBind(address) };
}

/**
 * The port/address the socket ACTUALLY bound. There is deliberately NO fallback to config.PORT /
 * config.BIND_HOST: an else-branch that echoes configuration reintroduces the very false green the
 * `address` field exists to close (a handle reporting the value we ASKED for, whatever the socket
 * did). Unreachable for a TCP listener - inside the 'listening' callback address() is an
 * AddressInfo - so the impossible branch fails loudly instead of degrading into a config echo.
 */
function boundAddressInfo(server: Server): AddressInfo {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error(`server.address() is not an AddressInfo after listening: ${JSON.stringify(address)}`);
  }
  return address;
}

export interface MultiTenantContext {
  env: MultiTenantEnv;
  /** Overridable for tests; defaults to db.getDefaultPat. */
  resolvePat?: (userId: string) => Promise<{ pat: string; label: string; status: 'active' | 'invalid' } | null>;
  /** Overridable for tests; defaults to real db functions. */
  accountsDb?: AccountsApiDeps['db'];
  pingDb?: () => Promise<void>;
  /** Overridable for tests; defaults to real code-connect-db functions. */
  codeConnect?: {
    resolveCiKey: (k: string) => Promise<string | null>;
    replaceMappings: (userId: string, mappings: StoredMapping[]) => Promise<void>;
    createCiKey: (userId: string, label: string) => Promise<{ id: number; plaintext: string }>;
    listCiKeys: (userId: string) => Promise<{ id: number; label: string; created_at: Date; last_used_at: Date | null }[]>;
    revokeCiKey: (userId: string, id: number) => Promise<boolean>;
    lookupMappings: (userId: string, refs: { file_key: string; node_id: string }[]) => Promise<Map<string, MappingHit>>;
  };
  /** Overridable for tests; defaults to real bridge-token + variable-snapshot-db functions. */
  variableSnapshot?: {
    verifyToken: (t: string) => Promise<string | null>;
    replaceSnapshot: (userId: string, lib: string, entries: SnapshotEntry[]) => Promise<void>;
    issue: (userId: string) => Promise<{ token: string; expires_at: string; scope: string }>;
    lookup: (userId: string, subscribedIds: string[]) => Promise<Map<string, SnapshotHit>>;
  };
  /** Overridable for tests; when set, the /mcp deps resolve cross-library aliases via this headless library graph instead of loading the per-user graph from the DB. */
  variableGraph?: { resolve: (userId: string, key: string) => { value: string; name?: string; sourceLibrary?: string } | undefined };
  /** Overridable for tests; defaults to real library-registry-db + team-discovery (built from the user's default PAT). */
  libraryRegistry?: AccountsApiDeps['registry'];
  /** Overridable for tests; defaults to a real syncUser closure. Returns sync counts.
   * Optional teamId scopes the sync to a single registered team (all teams when omitted). */
  librarySync?: (userId: string, teamId?: string) => Promise<{ libraries: number; variables: number; skipped: number }>;
  settings?: AccountsApiDeps['settings'];
  /** Overridable for tests; defaults to real audit-db functions. */
  audit?: AccountsApiDeps['audit'];
  /** Overridable for tests; defaults to real usage-db functions. */
  usage?: AccountsApiDeps['usage'];
}

// Sent to the host in the MCP `initialize` response. This is the only channel that reaches
// agents on hosts WITHOUT a skills mechanism, so it carries the minimal design-QA contract:
// the tool cycle and the done-gate. The full branching workflow lives in
// docs/agents/design-qa-skill.md (progressively loaded by hosts that support skills).
//
// THE CYCLE IS DEFINED IN docs/tools/design-qa.md ("The cycle"), and this string is a compression of
// that list, not a fourth opinion about it. The three-tool version it used to carry
// (get_layout_spec -> suggest_pairs -> compare_node_to_dom) disagreed with both documentation pages
// in two ways that cost a first-time reader real time: it omitted the browser capture, which is the
// step no tool here can perform and the one that dominates the wall clock, and it made suggest_pairs
// look mandatory when the code treats it as the answer to "I do not know the node ids".
export const SERVER_INSTRUCTIONS = [
  'Framefit is a verification-first Figma server: it measures a rendered UI against its Figma',
  'frame and reports a machine-checkable verdict. The design-QA cycle, five steps:',
  '(1) find_breakpoint_variant picks the frame matching your render width - skip it when you already',
  'know the frame id; (2) get_layout_spec {include_extractor: true} returns the Figma side and the',
  'DOM extractor; (3) YOU run that extractor in the browser over your CSS selectors - no tool here',
  'can, it needs a rendered page; (4) suggest_pairs proposes node_id/selector pairs from the',
  'frame-root snapshot - skip it when you already know the node ids; (5) compare_node_to_dom',
  'measures and returns the verdict. Treat the returned `verification.complete` as the done-gate:',
  'never claim the UI matches the design while it is false or `blocking[]` is non-empty — each',
  'blocking item names the action that fixes coverage. `complete: false` with an EMPTY',
  '`blocking[]` and ZERO ❌ rows means only inherent caveats remain (demotes, out-of-reach axes,',
  'a depth-ceiling tail) — verify those by eye, then you may proceed. A response-budget omission is',
  'red only when its note says omitted pairs carry FAILing rows; replay those exact submitted pairs with',
  '`originalArgs.pairs[i]` for each zero-based i in `omitted_pair_indices`. Clean omitted pairs are already',
  'included in the aggregate verdict and may stay complete; `omitted_pair_ids` is display-only and may repeat.',
  'If a comparator instead returns `code:"response_budget"` with `pairs:[]`, the prefix-preserving',
  'clamp retained no complete pair detail; a later pair may still fit unchanged when replayed alone.',
  'That compact receipt is always incomplete. Replay every `omitted_pair_indices` position in smaller',
  'calls or re-extract smaller DOM roots before retrying; the clean-omission exception does not apply.',
  'The cycle is stated once in docs/tools/design-qa.md; the full agent workflow is',
  'docs/agents/design-qa-skill.md.',
  'Separately from the cycle: compare_dom_to_dom measures two DOM states of ONE screen against',
  'each other (skeleton vs loaded, before vs after an edit) - no Figma side, no figma_token.',
].join('\n');

export function makeReadCaches(config: AppConfig, logger?: Logger, budget?: CacheBudget,
  frameStore?: FrameHydrationStore, owner?: string): ReadCaches {
  const ttl = config.FILE_STRUCTURE_TTL_SEC * 1000;
  // Library content (team libraries, component sets/meta) is low-churn and keyed
  // without a version, so a short file-style TTL just forces expensive Tier-3
  // re-fetches; give it its own longer TTL.
  const dsTtl = config.DS_LIBRARY_TTL_SEC * 1000;
  // Per-entry byte ceiling — an oversized raw response (e.g. ~110MB whole-file doc) is delivered but
  // not cached. Small/aggregated caches never approach it (untagged → sizeOf 0), so it's a no-op there.
  // The shared byte-budget bounds the AGGREGATE across all these caches (only weighted entries count).
  const cap = config.CACHE_MAX_ENTRY_BYTES;
  return {
    nodeCache: new TtlCache(ttl, 1000, cap, logger, budget),
    variablesCache: new TtlCache(ttl, 1000, cap, logger, budget),
    variablesErrorCache: new TtlCache(600_000, 1000, cap, logger, budget),
    versionCache: new TtlCache(Math.min(ttl, 60_000), 1000, cap, logger, budget),
    librariesCache: new TtlCache(dsTtl, 1000, cap, logger, budget),
    componentCache: new TtlCache(dsTtl, 1000, cap, logger, budget),
    componentSetsCache: new TtlCache(dsTtl, 1000, cap, logger, budget),
    imageFillsCache: new TtlCache(ttl, 1000, cap, logger, budget),
    docCache: new TtlCache(ttl, 1000, cap, logger, budget),
    // Owner-bound reference to the SHARED store — never a new store per user (see spec Section 1).
    ...(frameStore ? { frameCache: makeFrameHandle(frameStore, owner ?? 'local') } : {}),
  };
}

/**
 * Build the shared tool dependencies. The file-structure cache lives here so a
 * single instance is reused across requests (HTTP) or for the process lifetime
 * (stdio).
 *
 * `snapshotStore` is optional and passed in by the caller. Single-tenant HTTP and stdio bridge
 * callers mint one instance up front and reuse it — see startHttpServer/startStdioServer —
 * so tool-issued capTokens resolve against the SAME store the upload endpoint
 * reads from. `publicBaseUrl` is deliberately NOT set here — it is MODE-AWARE
 * and resolved by each caller:
 *   stdio             → assigned from its ephemeral loopback browser bridge after
 *                       that bridge starts;
 *   single-tenant http → config.PUBLIC_BASE_URL ?? the actual bound loopback origin
 *                       (assigned in startHttpServer's listen callback, where the
 *                       real port is known);
 *   multi-tenant http  → env.publicBaseUrl ?? `https://${env.mcpHost}` (its own deps
 *                       are built per request in startMultiTenantHttpServer).
 */
export function buildToolDeps(config: AppConfig, logger: Logger, snapshotStore?: DomSnapshotStore): ToolDeps {
  const budget = new CacheBudget(config.CACHE_MAX_BYTES, logger);
  const fileStructureCache = new FileStructureCache(config.FILE_STRUCTURE_TTL_SEC * 1000); // count-capped, no budget
  const frameStore = new FrameHydrationStore(
    config.FRAME_RAM_GLOBAL_BYTES, config.FRAME_RAM_PER_TENANT_BYTES, config.FRAME_CACHE_TTL_SEC * 1000, undefined, logger);
  const materializeGovernor = getMaterializeGovernor(config.HYDRATION_MAX_MATERIALIZE);
  const readCaches = makeReadCaches(config, logger, budget, frameStore, 'local');
  const buildApi: ToolDeps['buildApi'] = (token, timeoutMs, deadlineAt) =>
    new CachingFigmaApiAdapter(
      new FigmaRestAdapter(token, logger, config.FILE_STRUCTURE_DEPTH, timeoutMs ?? config.FIGMA_TIMEOUT_MS, undefined, getFigmaSemaphore(config.FIGMA_MAX_CONCURRENT_REQUESTS), deadlineAt, config.MAX_FETCH_BYTES),
      fileStructureCache,
      logger,
      readCaches,
      // timeoutMs stamps this instance's cap onto negative-cache markers (capMs) so a larger-budget
      // escalation (get_variables' timeout_ms) bypasses a marker written under a shorter cap — see
      // the cap-aware READ + WRITE rule in getVariablesLocal (latency cap: capMs-semantics, no
      // shortened-cap suppression).
      { timeoutMs: timeoutMs ?? config.FIGMA_TIMEOUT_MS,
        frameMaxParseBytes: config.FRAME_MAX_PARSE_BYTES, frameParseMultiplier: config.FRAME_PARSE_MULTIPLIER, materializeGovernor },
    );
  // Single-tenant env graph (DS_TEAM_IDS): sync the configured teams' published library variables
  // into an in-memory graph ONCE (lazily, on the first tool read via ensureReady) so cross-library
  // aliases resolve headless — resolved_via:"graph" — with no portal/DB. Reuses `buildApi` above so
  // the sync goes through the same caching adapter. Undefined (no DS_TEAM_IDS, or DS_TEAM_IDS set but
  // no token) → the field is omitted and ToolDeps is byte-for-byte the prior no-graph shape.
  const variableGraph = createEnvGraphFromConfig(config, logger, buildApi);
  // Read-only gate, single-tenant. This is the ONE place the stdio path can acquire one: without
  // it assertWritable is handed undefined on every call and "Disabled in read-only mode", printed
  // in three tool descriptions, is simply false. Absent unless the value is exactly "true" (any
  // case), so an unset or mistyped value leaves today's behaviour byte-for-byte unchanged - and
  // that default is itself locked by read-only-wiring.test.ts, so it cannot be flipped quietly.
  const readOnly: ReadOnlyGate | undefined =
    config.FRAMEFIT_READ_ONLY?.toLowerCase() === 'true'
      ? { isReadOnly: async () => true, remediation: SINGLE_TENANT_READ_ONLY_REMEDIATION }
      : undefined;

  return {
    buildApi,
    defaultToken: config.FIGMA_TOKEN,
    logger,
    maxResultChars: config.MAX_RESULT_CHARS,
    toolTimeBudgetMs: config.FIGMA_TOOL_TIME_BUDGET_MS,
    snapshotStore,
    tenantId: 'local',
    ...(readOnly ? { readOnly } : {}),
    ...(variableGraph ? { variableGraph } : {}),
  };
}

export async function startServer(
  config: AppConfig,
  logger: Logger,
  mt?: MultiTenantContext,
): Promise<ServerHandle> {
  if (config.MCP_TRANSPORT === 'stdio') return startStdioServer(config, logger);
  return mt ? startMultiTenantHttpServer(config, logger, mt) : startHttpServer(config, logger);
}

/**
 * stdio transport: a single long-lived MCP server speaks JSON-RPC over
 * stdin/stdout. The host (e.g. Claude Code) spawns and tears down the process,
 * so there is no port and no manual lifecycle. NOTE: nothing may write to
 * stdout except the protocol — the logger must target stderr (see index.ts).
 */
async function startStdioServer(
  config: AppConfig,
  logger: Logger,
): Promise<ServerHandle> {
  const mcp = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  let bridge: StdioBrowserBridge | undefined;
  let deps: ToolDeps;
  try {
    bridge = await startStdioBrowserBridge(logger);
    deps = buildToolDeps(config, logger, bridge.store);
    deps.publicBaseUrl = bridge.publicBaseUrl;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'server.stdio_browser_bridge_unavailable');
    deps = buildToolDeps(config, logger);
    deps.browserBridgeDegraded = {
      status: 'unavailable',
      reason: 'loopback bridge could not start; using inline extractor',
    };
  }
  registerAllTools(mcp, deps);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info('server.stdio_ready');

  return {
    port: 0,
    address: '', // stdio binds no socket; there is no address to report
    close: async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => transport.close()),
        Promise.resolve().then(() => mcp.close()),
        Promise.resolve().then(() => bridge?.close()),
      ]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}

async function startHttpServer(
  config: AppConfig,
  logger: Logger,
): Promise<ServerHandle> {
  const app = express();
  // Public capability-authed DOM-snapshot upload endpoint: outside JWT, mounts
  // its own CORS + text-body middleware, so it must sit BEFORE the global json
  // parser (same precedent as the multi-tenant server's CC/variables ingests).
  const domSnapshotStore = new DomSnapshotStore();
  app.use('/api/dom-snapshots', createDomSnapshotRoutes({ store: domSnapshotStore, logger }));
  app.use(express.json({ limit: '4mb' }));

  const deps = buildToolDeps(config, logger, domSnapshotStore);

  // Assigned in the listen callback below, before the socket accepts anything, so every request
  // that can reach this handler sees the real bound address.
  let boundAddress = '';

  // `bind` reports the CANONICAL address this process bound and whether that address is loopback.
  // It exists because the container healthcheck has no other honest way to know: it runs inside the
  // container, cannot observe host-side port publication, and interpreting BIND_HOST in shell
  // patterns produced repeated false greens (a loopback bind spelled 127.0.0.2 or
  // 0:0:0:0:0:0:0:1 reported healthy while the published port was dead). The kernel normalises the
  // spelling for us; the verdict is computed in isLoopbackBind, under unit test.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', bind: healthBind(boundAddress) });
  });

  // Browser origin gate for /mcp (see origin-guard.ts). A loopback bind is exactly the deployment
  // DNS rebinding targets: a page on any domain that resolves to 127.0.0.1 reaches this socket, and
  // without this the page completes a full initialize + tools/call under the operator's FIGMA_TOKEN.
  // Built with config.PORT; when PORT=0 the advertised loopback origin is re-derived after listen
  // (below) so an ephemeral-port test still admits its own origin. The guard is rebuilt per request
  // so that re-derivation is actually seen by requests arriving after it.
  //
  // Keep this scoped to '/mcp' and keep it HERE. The tidy-looking cleanup - one path-less
  // app.use(guard) hoisted to the top so "everything is covered" - breaks the browser extractor by
  // construction: /api/dom-snapshots (mounted above) is called by the arbitrary-origin page being
  // measured, is authorised by the capability token in its own path rather than by any credential a
  // cross-origin script could carry, and deliberately answers Access-Control-Allow-Origin: *. A
  // guard in front of it refuses that upload with a 403 the page cannot even read - the developer
  // sees a bare "Failed to fetch" with nothing in it to debug.
  let mcpOrigins = allowedOriginSet({
    bindHost: config.BIND_HOST, port: config.PORT,
    publicBaseUrl: config.PUBLIC_BASE_URL, extra: config.ALLOWED_ORIGINS,
  });
  app.all('/mcp', (req, res, next) => makeOriginGuard(mcpOrigins, logger)(req, res, next));

  app.all('/mcp', async (req, res) => {
    const mcp = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

    registerAllTools(mcp, deps);

    const transport = new StreamableHTTPServerTransport({
      // Stateless: each request creates its own transport, which is torn down
      // on response close. No cross-request session resumption.
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'mcp.request_failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal error' });
      }
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    let server: Server;
    server = app.listen(config.PORT, config.BIND_HOST, () => {
      let info: AddressInfo;
      try {
        info = boundAddressInfo(server);
      } catch (err) {
        reject(err as Error);
        return;
      }
      const { port, address: bound } = info;
      boundAddress = bound;
      // Single-tenant http chain: explicit PUBLIC_BASE_URL wins; otherwise the
      // ACTUAL bound origin — a real endpoint this same process serves, so the extractor
      // loader + browser-direct upload work on localhost out of the box. Resolved HERE, not in
      // the shared buildToolDeps: the fallback needs the bound port (PORT=0 → ephemeral), and
      // stdio shares buildToolDeps but must NOT inherit any fallback (dead-URL hazard). Assigning
      // before resolve() is race-free — connections are only accepted once 'listening' fired.
      // dialableHost keeps a wildcard bind advertising loopback (0.0.0.0 is not an origin a
      // browser can reach) while a concrete LAN bind advertises itself, so an operator who binds
      // a LAN address no longer gets an upload_url pointing at the browser's own machine.
      deps.publicBaseUrl =
        config.PUBLIC_BASE_URL ?? `http://${dialableHost(config.BIND_HOST)}:${port}`;
      // Re-derived against the port the socket ACTUALLY got: with PORT=0 the set built above
      // advertises :0, which is nobody's origin, and the server would refuse its own page.
      mcpOrigins = allowedOriginSet({
        bindHost: config.BIND_HOST, port,
        publicBaseUrl: config.PUBLIC_BASE_URL, extra: config.ALLOWED_ORIGINS,
      });
      logger.info({ port, bind_host: bound }, 'server.listening');
      resolve({
        port,
        address: bound,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
    server.on('error', reject);
  });
}

async function startMultiTenantHttpServer(
  config: AppConfig,
  logger: Logger,
  mt: MultiTenantContext,
): Promise<ServerHandle> {
  const { env } = mt;
  // Assigned in the listen callback below, before the socket accepts anything (see /health).
  let boundAddress = '';
  const resolvePat = mt.resolvePat ?? ((userId: string) => getDefaultPat(userId, env.encryptionKey));
  const ping = mt.pingDb ?? defaultPingDb;
  const accountsDb: AccountsApiDeps['db'] = mt.accountsDb ?? {
    listTokens: (u) => import('../multi-tenant/db.js').then((m) => m.listTokens(u)),
    addToken: (u, i, k) => import('../multi-tenant/db.js').then((m) => m.addToken(u, i, k)),
    removeToken: (u, l) => import('../multi-tenant/db.js').then((m) => m.removeToken(u, l)),
    setDefaultToken: (u, l) => import('../multi-tenant/db.js').then((m) => m.setDefaultToken(u, l)),
    getTokenWithPat: (u, l, k) => import('../multi-tenant/db.js').then((m) => m.getTokenWithPat(u, l, k)),
    updateValidation: (id, s, u) => import('../multi-tenant/db.js').then((m) => m.updateValidation(id, s, u)),
  };
  const cc = mt.codeConnect ?? {
    resolveCiKey: ccResolveCiKey, replaceMappings: ccReplaceMappings,
    createCiKey: ccCreateCiKey, listCiKeys: ccListCiKeys, revokeCiKey: ccRevokeCiKey,
    lookupMappings: ccLookupMappings,
  };
  const TTL = 30 * 60;
  const vs = mt.variableSnapshot ?? {
    verifyToken: (t: string) => verifyBridgeToken(t, env.encryptionKey, 'variables:snapshot'),
    replaceSnapshot: (u: string, lib: string, e: SnapshotEntry[]) => replaceSnapshot(u, lib, e),
    issue: async (u: string) => {
      const token = await signBridgeToken(u, env.encryptionKey, TTL);
      return { token, expires_at: new Date((Math.floor(Date.now() / 1000) + TTL) * 1000).toISOString(), scope: 'variables:snapshot' };
    },
    lookup: (u: string, ids: string[]) => lookupSnapshot(u, ids),
  };

  // Per-user headless library graph, materialised lazily from the DB. Relocated above the
  // /accounts mount so the sync closure can evict a user's entry; the /mcp deps share this
  // same instance. Unbounded for MVP — invalidated on process restart or post-sync.
  const graphCache = new Map<string, Graph>();
  async function getUserGraph(userId: string): Promise<Graph> {
    let g = graphCache.get(userId);
    if (!g) {
      g = await (await import('../multi-tenant/library-graph-db.js')).loadGraph(userId);
      graphCache.set(userId, g);
    }
    return g;
  }

  const getPat = async (userId: string): Promise<string | null> => (await resolvePat(userId))?.pat ?? null;
  // Raw REST adapter for sync/discovery (no read-cache needed; honor the per-call timeout the sync passes).
  const buildSyncApi = (pat: string, timeoutMs?: number, onRequest?: () => void): FigmaApi =>
    new FigmaRestAdapter(pat, logger, config.FILE_STRUCTURE_DEPTH, timeoutMs ?? config.FIGMA_TIMEOUT_MS, onRequest, getFigmaSemaphore(config.FIGMA_MAX_CONCURRENT_REQUESTS), undefined, config.MAX_FETCH_BYTES);

  const registry: AccountsApiDeps['registry'] = mt.libraryRegistry ?? {
    addTeam: (u, t) => addTeam(u, t),
    listTeams: (u) => listTeams(u).then((ts) => ts.map((team_id) => ({ team_id }))),
    removeTeam: (u, t) => removeTeam(u, t).then(() => { graphCache.delete(u); return true; }),
    listLibraries: (u) => listLibraries(u),
    discover: async (u, teamId) => {
      const resolved = await resolvePat(u);
      if (!resolved?.pat) return [];
      return discoverLibraries(buildSyncApi(resolved.pat, undefined, makeUsageSink(u, resolved.label)), teamId);
    },
  };
  // Raw sync impl (injectable for tests). Does the full discovery + variable pull
  // and returns counts. The fire-and-forget + dedup wrapper lives below.
  const runSync: (userId: string, teamId?: string) => Promise<{ libraries: number; variables: number; skipped: number }> =
    mt.librarySync ??
    (async (userId, teamId) => {
      const resolved = await resolvePat(userId);
      const syncSink = makeUsageSink(userId, resolved?.label ?? '(default)');
      const out = await syncUser(userId, {
        buildApi: (pat: string, timeoutMs?: number) => buildSyncApi(pat, timeoutMs, syncSink),
        getPat,
        listTeams,
        setLibraries,
        replaceLibrary: (u, fk, vars, colls) => replaceLibrary(u, fk, vars as GraphVar[], colls as GraphColl[]),
        logger,
      }, teamId ? { teamId } : undefined);
      graphCache.delete(userId); // freshly synced → drop stale cached graph so next /mcp reloads (full eviction is fine for a single-team sync too)
      return out;
    });

  const settings: NonNullable<AccountsApiDeps['settings']> = mt.settings ?? {
    getUserSettings: (u) => getUserSettings(u),
    setReadOnly: (u, b) => setReadOnly(u, b),
  };
  const audit: NonNullable<AccountsApiDeps['audit']> = mt.audit ?? {
    record: (u, e) => recordAuditEvent(u, e),
    list: (u, o) => listAuditEvents(u, o),
  };
  const usage: NonNullable<AccountsApiDeps['usage']> = mt.usage ?? {
    summary: (u) => getUsageSummary(u),
  };
  // Per-(user,label) usage sink: fire-and-forget increment on every Figma network call.
  const makeUsageSink = (uid: string, label: string): (() => void) =>
    () => { void recordUsage(uid, label).catch(() => { /* never break the request path */ }); };

  // In-memory, per-process sync state (lost on restart, not shared across replicas).
  // A DB-backed job is tracked as backlog.
  type SyncState = {
    state: 'running' | 'done' | 'error';
    startedAt: number;
    finishedAt?: number;
    result?: { libraries: number; variables: number; skipped: number };
    error?: string;
  };
  const syncState = new Map<string, SyncState>();
  const sync = {
    // teamId optional: scopes the fired sync to one registered team (all teams when omitted).
    // Dedup + status remain per-user (one running sync per user).
    start(userId: string, teamId?: string): { status: 'started' | 'already_running'; startedAt?: number } {
      const cur = syncState.get(userId);
      if (cur?.state === 'running') return { status: 'already_running', startedAt: cur.startedAt };
      const startedAt = Date.now();
      syncState.set(userId, { state: 'running', startedAt });
      logger.info({ userId, teamId }, 'mt.sync_started');
      // fire-and-forget; runSync is invoked synchronously so a fake is recorded immediately
      runSync(userId, teamId)
        .then((result) => {
          syncState.set(userId, { state: 'done', startedAt, finishedAt: Date.now(), result });
          logger.info({ userId, ...result }, 'mt.sync_done');
        })
        .catch((err) => {
          syncState.set(userId, { state: 'error', startedAt, finishedAt: Date.now(), error: (err as Error).message });
          logger.error({ userId, err: (err as Error).message }, 'mt.sync_error');
        });
      return { status: 'started', startedAt };
    },
    status(userId: string): SyncState | { state: 'idle' } {
      return syncState.get(userId) ?? { state: 'idle' };
    },
  };

  const app = express();
  // CI ingest mounts its own 8mb json parser and authenticates via X-CI-Key, so
  // it must sit BEFORE the global 4mb json parser and outside requireJwt.
  app.use('/api/code-connect', createCodeConnectIngest({ resolveCiKey: cc.resolveCiKey, replaceMappings: cc.replaceMappings }));
  // Same rationale as the CC ingest: scoped bridge-token auth + its own 16mb json
  // parser, so it must sit BEFORE the global 4mb parser and outside requireJwt.
  app.use('/api/variables', createVariableSnapshotIngest({ verifyToken: vs.verifyToken, replaceSnapshot: vs.replaceSnapshot }));
  // Public capability-authed DOM-snapshot upload (opaque capToken minted by
  // get_layout_spec, not a Bearer JWT — an arbitrary browser page can't do
  // OAuth). Same rationale as the two ingests above: own CORS + text-body
  // middleware, so it must sit BEFORE the global 4mb parser and outside requireJwt.
  const domSnapshotStore = new DomSnapshotStore();
  app.use('/api/dom-snapshots', createDomSnapshotRoutes({ store: domSnapshotStore, logger }));
  app.use(express.json({ limit: '4mb' }));

  // Multi-tenant chain: ONE resolve feeds every externally-visible URL below —
  // OAuth PRM resource identity + WWW-Authenticate resource_metadata (the identity Keycloak
  // audience/realm was provisioned against), the portal hint, and the dom-snapshot upload base.
  // env.publicBaseUrl (optional PUBLIC_BASE_URL, e.g. http://localhost:3846 in the local
  // full-profile) wins; unset (prod .env untouched) → the historical https form, byte-for-byte.
  const publicBaseUrl = env.publicBaseUrl ?? `https://${env.mcpHost}`;

  const metadataUrl = `${publicBaseUrl}/.well-known/oauth-protected-resource`;

  const unauthorized = (res: Response, message: string): void => {
    res
      .status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`)
      .json({ error: message });
  };

  // Path-specific JWT gate. `/accounts` carries portal tokens (azp=<svc>-portal, aud
  // present once Keycloak audience-mappers exist) → hard-enforce is meaningful and
  // closes the cross-portal threat. `/mcp` carries Claude dynamic-client tokens (azp=UUID,
  // no per-service aud — Claude omits the `resource` param, so there is no audience to
  // match against), so it MUST stay soft (log mismatch, never reject) or legitimate connectors break.
  const makeRequireJwt = (enforce: boolean) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const bearer = extractBearerToken(req.headers.authorization);
      if (!bearer) {
        unauthorized(res, 'Authorization required');
        return;
      }
      try {
        const auth = await validateJwt(bearer, enforce ? env.expectedAudience : undefined);
        if (enforce) {
          assertAzp(auth.payload, env.expectedAzp);
        } else {
          const aud = auth.payload.aud;
          const audOk = Array.isArray(aud) ? aud.includes(env.expectedAudience) : aud === env.expectedAudience;
          if (!audOk || auth.payload.azp !== env.expectedAzp) {
            logger.warn(
              { aud, azp: auth.payload.azp, expectedAudience: env.expectedAudience, expectedAzp: env.expectedAzp },
              'mt.jwt_audience_soft_mismatch',
            );
          }
        }
        res.locals.userId = auth.userId;
        next();
      } catch (err) {
        const msg = (err as Error).message;
        const key = /audience|Unauthorized client/i.test(msg)
          ? 'mt.jwt_audience_reject'
          : 'mt.jwt_invalid';
        logger.warn({ err: msg }, key);
        unauthorized(res, 'Invalid JWT');
      }
    };

  // /accounts: hard-enforce gated by ENFORCE_AUDIENCE (rollout flag). /mcp: always soft.
  if (!env.enforceAudience) {
    logger.warn(
      { enforceAudience: false },
      'mt.audience_enforcement_disabled: /accounts currently accepts any valid same-realm token; ' +
        'set ENFORCE_AUDIENCE=true once a Keycloak audience mapper issues figma-scoped tokens',
    );
  }
  const requireJwtAccounts = makeRequireJwt(env.enforceAudience);
  const requireJwtMcp = makeRequireJwt(false);

  // `bind` carries the same meaning as in the single-tenant server (see that handler): the canonical
  // bound address plus the loopback verdict, for the container healthcheck. It rides BOTH branches -
  // a degraded database does not change which interface the socket is on.
  app.get('/health', async (_req, res) => {
    const bind = healthBind(boundAddress);
    try {
      await ping();
      res.json({ status: 'ok', bind });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'unreachable', bind });
    }
  });

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: `${publicBaseUrl}/mcp`,
      authorization_servers: [env.oauthAuthorizationServer],
      bearer_methods_supported: ['header'],
    });
  });

  app.use('/accounts', requireJwtAccounts, createAccountsRouter({
    encryptionKey: env.encryptionKey,
    validatePat,
    db: accountsDb,
    ciKeys: { createCiKey: cc.createCiKey, listCiKeys: cc.listCiKeys, revokeCiKey: cc.revokeCiKey },
    bridgeToken: { issue: vs.issue },
    registry,
    sync,
    settings,
    audit,
    usage,
  }));

  // ONE process-wide byte budget shared across ALL per-user read caches (forward-compat aggregate
  // ceiling over N tenants). Per-user FileStructureCache is count-capped by itself (not budget-wired).
  const budget = new CacheBudget(config.CACHE_MAX_BYTES, logger);
  // ONE process-wide frame store shared across ALL tenants (owner-keyed internally), like the
  // shared CacheBudget above and the DomSnapshotStore. readCachesFor(userId) hands an owner-bound
  // reference, never a new store — the real process-wide RAM ceiling (spec Section 1).
  const frameStore = new FrameHydrationStore(
    config.FRAME_RAM_GLOBAL_BYTES, config.FRAME_RAM_PER_TENANT_BYTES, config.FRAME_CACHE_TTL_SEC * 1000, undefined, logger);
  const materializeGovernor = getMaterializeGovernor(config.HYDRATION_MAX_MATERIALIZE);
  const userCaches = new Map<string, FileStructureCache>();
  const cacheFor = (userId: string): FileStructureCache => {
    let cache = userCaches.get(userId);
    if (!cache) {
      cache = new FileStructureCache(config.FILE_STRUCTURE_TTL_SEC * 1000);
      userCaches.set(userId, cache);
    }
    return cache;
  };
  const userReadCaches = new Map<string, ReadCaches>();
  const readCachesFor = (userId: string): ReadCaches => {
    let rc = userReadCaches.get(userId);
    if (!rc) {
      rc = makeReadCaches(config, logger, budget, frameStore, userId);
      userReadCaches.set(userId, rc);
    }
    return rc;
  };

  // Browser origin gate, mounted BEFORE requireJwtMcp on purpose: a rebinding page carries no JWT,
  // so leaving the JWT layer to answer would turn every refusal into a 401 that confirms the
  // endpoint exists. Same set-rebuild-per-request shape as the single-tenant site, and scoped to
  // '/mcp' for the same reason: hoisting a path-less app.use above the /api/dom-snapshots mount
  // refuses the arbitrary-origin extractor upload with an unreadable 403 (see that comment).
  let mcpOrigins = allowedOriginSet({
    bindHost: config.BIND_HOST, port: config.PORT,
    publicBaseUrl: env.publicBaseUrl, mcpHost: env.mcpHost, extra: config.ALLOWED_ORIGINS,
  });
  app.all('/mcp', (req, res, next) => makeOriginGuard(mcpOrigins, logger)(req, res, next));

  app.all('/mcp', requireJwtMcp, async (req, res) => {
    const userId = res.locals.userId as string;
    let stored: Awaited<ReturnType<typeof resolvePat>> = null;
    try {
      stored = await resolvePat(userId);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'mt.resolve_pat_failed');
      res.status(500).json({ error: 'internal error' });
      return;
    }

    const portalUrl = `${publicBaseUrl}/portal`;
    const hint =
      stored?.status === 'invalid'
        ? `Your default Figma token "${stored.label}" is invalid or expired. Update it in the portal: ${portalUrl}`
        : `Add your Figma token in the portal: ${portalUrl}`;

    // Pre-load the user's library graph once per request so the tool's sync resolve(key)
    // can close over it. When mt.variableGraph is injected (tests), skip the DB load.
    // Fail-soft: if the graph can't be loaded (DB down, no libraries synced), get_variables
    // simply degrades to honest aliases rather than failing the whole /mcp request.
    // Only attach the loaded graph when it actually has variables: an empty graph (no
    // libraries synced yet) would otherwise suppress the variableSnapshot fallback.
    let userGraph: Graph | undefined;
    if (!mt.variableGraph) {
      try {
        const g = await getUserGraph(userId);
        if (g.byKey.size > 0) userGraph = g;
      } catch (err) {
        logger.info({ err: (err as Error).message }, 'mt.library_graph_unavailable');
      }
    }

    const deps: ToolDeps = {
      buildApi: (token, timeoutMs, deadlineAt) => {
        const label = token === stored?.pat ? (stored?.label ?? '(default)') : '(custom)';
        return new CachingFigmaApiAdapter(
          new FigmaRestAdapter(token, logger, config.FILE_STRUCTURE_DEPTH, timeoutMs ?? config.FIGMA_TIMEOUT_MS, makeUsageSink(userId, label), getFigmaSemaphore(config.FIGMA_MAX_CONCURRENT_REQUESTS), deadlineAt, config.MAX_FETCH_BYTES),
          cacheFor(userId),
          logger,
          readCachesFor(userId),
          // timeoutMs stamps this instance's cap onto negative-cache markers (capMs) so a larger-budget
          // escalation (get_variables' timeout_ms) bypasses a marker written under a shorter cap — see
          // the cap-aware READ + WRITE rule in getVariablesLocal (latency cap: capMs-semantics, no
          // shortened-cap suppression).
          { timeoutMs: timeoutMs ?? config.FIGMA_TIMEOUT_MS,
            frameMaxParseBytes: config.FRAME_MAX_PARSE_BYTES, frameParseMultiplier: config.FRAME_PARSE_MULTIPLIER, materializeGovernor },
        );
      },
      defaultToken: stored?.status === 'invalid' ? undefined : stored?.pat,
      logger,
      maxResultChars: config.MAX_RESULT_CHARS,
      toolTimeBudgetMs: config.FIGMA_TOOL_TIME_BUDGET_MS,
      noTokenHint: hint,
      readOnly: {
        isReadOnly: async () => (await settings.getUserSettings(userId)).read_only,
        remediation: PORTAL_READ_ONLY_REMEDIATION,
      },
      registeredTeams: { list: () => listTeams(userId) },
      libraryFiles: { has: (fk: string) => hasLibraryFile(userId, fk) },
      codeConnect: { lookup: (refs) => cc.lookupMappings(userId, refs) },
      variableSnapshot: { lookup: (ids: string[]) => vs.lookup(userId, ids) },
      // dom-diff-dx browser-direct upload flow: this /mcp handler builds deps fresh per request
      // (see `userId` above), so the capToken get_layout_spec mints is bound to the JWT-authenticated
      // caller of THIS request, not a process-global identity.
      snapshotStore: domSnapshotStore,
      publicBaseUrl,
      tenantId: userId,
      // source_library is set to the source node's fileKey for MVP (we have it on the graph
      // node; mapping fileKey→library name via the registry is a later task). When neither an
      // injected graph nor a loaded graph is available, omit variableGraph so the tool falls
      // back to the variableSnapshot path (preserving the v2a behaviour).
      ...(mt.variableGraph
        ? { variableGraph: { resolve: (key: string) => mt.variableGraph!.resolve(userId, key) } }
        : userGraph
          // Extracted to user-graph-port.ts (unit-tested): the wave caught this exact branch
          // shipping WITHOUT the cssEvidence method while everything else stayed green.
          ? { variableGraph: userGraphPort(userGraph) }
          : {}),
    };

    const mcp = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
    registerAllTools(mcp, deps);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'mcp.request_failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal error' });
      }
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: (err as Error).message }, 'mt.unhandled');
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal error' });
    }
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    let server: Server;
    server = app.listen(config.PORT, config.BIND_HOST, () => {
      let info: AddressInfo;
      try {
        info = boundAddressInfo(server);
      } catch (err) {
        reject(err as Error);
        return;
      }
      const { port, address: bound } = info;
      boundAddress = bound;
      // See the single-tenant listen callback: PORT=0 makes the pre-listen set advertise :0.
      mcpOrigins = allowedOriginSet({
        bindHost: config.BIND_HOST, port,
        publicBaseUrl: env.publicBaseUrl, mcpHost: env.mcpHost, extra: config.ALLOWED_ORIGINS,
      });
      logger.info({ port, bind_host: bound, multi_tenant: true }, 'server.listening');
      resolve({
        port,
        address: bound,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
          }),
      });
    });
    server.on('error', reject);
  });
}
