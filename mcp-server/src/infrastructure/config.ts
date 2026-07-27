import { z } from 'zod';
import { isIP } from 'node:net';

// The transport a process actually gets when MCP_TRANSPORT is unset - which is the PRODUCTION shape
// (the compose full profile sets MULTI_TENANT=true and never sets MCP_TRANSPORT). Exported because
// status.ts must reproduce this defaulting to derive the effective mode without booting the server;
// a hand-copied 'http' over there would be free to drift from the schema default here.
export const DEFAULT_MCP_TRANSPORT = 'http' as const;

// The interface app.listen() binds when BIND_HOST is unset. Loopback, deliberately: the
// single-tenant server has no authentication of its own and wires FIGMA_TOKEN into every call, so
// an unset value must never mean "every interface". Exported so the literal has exactly one home
// for any caller that needs to name the default rather than restate it.
export const DEFAULT_BIND_HOST = '127.0.0.1' as const;

const ConfigSchema = z.object({
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default(DEFAULT_MCP_TRANSPORT),
  PORT: z.coerce.number().int().min(0).default(3846),
  // BIND_HOST is the LOCAL INTERFACE this process listens on. It is NOT MCP_HOST, which is the
  // PUBLIC hostname the multi-tenant server advertises itself at (multi-tenant/env.ts builds
  // `https://${MCP_HOST}` from it). The two sit one prefix apart and mean opposite things, so the
  // value is validated here rather than at bind time: a hostname would otherwise surface as an
  // EADDRNOTAVAIL crash inside `restart: unless-stopped`, i.e. a restart loop instead of a named
  // reason. Empty-string preprocess mirrors FIGMA_TOKEN: `BIND_HOST=` in a copied .env reaches the
  // process as '' via docker env_file / dotenv, z.string().default() does NOT fire on '', and Node
  // treats a falsy host as UNSPECIFIED - net.listen(0, '') binds '::'. Without the preprocess a
  // blank assignment silently restores the wide bind this setting exists to close.
  // The .default() sits INSIDE the preprocess, not outside it: an outer
  // `z.preprocess(...).default()` is a ZodDefault wrapping a ZodEffects, and ZodDefault only
  // substitutes when its OWN input is undefined - '' is not, so the default never fires and the
  // blank assignment fails with "Required" instead of falling back to loopback.
  BIND_HOST: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().refine((v) => v === 'localhost' || isIP(v) !== 0, {
      message: 'BIND_HOST must be an IP literal or "localhost" - it is the bind interface, not the public hostname (that is MCP_HOST)',
    }).default(DEFAULT_BIND_HOST),
  ),
  // Empty string coerces to undefined BEFORE validation: `FIGMA_TOKEN=` (no value) in a
  // copied .env reaches the process as '' via docker env_file / dotenv, and for an
  // OPTIONAL credential an empty assignment must mean "not configured", never a crash
  // (fresh-clone stranger path: cp .env.example .env → crash-loop without this).
  // Mirrors the `|| undefined` pattern in multi-tenant/env.ts for PUBLIC_BASE_URL.
  FIGMA_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  FILE_STRUCTURE_TTL_SEC: z.coerce.number().int().min(0).default(300),
  // Published design-system library content (team libraries, component sets/meta) is
  // low-churn and cached without a version key, so it gets its own longer TTL (default 24h)
  // to avoid expensive Tier-3 re-fetches (and the rate limits they trigger). Without a
  // LIBRARY_PUBLISH webhook (backlog), TTL is the only staleness bound — keep it ≤ a day.
  DS_LIBRARY_TTL_SEC: z.coerce.number().int().min(0).default(86400),
  // Single-tenant (env-configured) design-system team ids: a comma-separated list (bare digits
  // or figma.com/team/<id> URLs) whose published variable libraries are synced ONCE into an
  // in-memory graph, so cross-library aliases resolve headless (resolved_via:"graph") without a
  // portal/DB. Unset → no env graph (aliases stay honestly unresolved). MULTI-TENANT ignores this
  // (that mode builds a per-user graph from the DB); setting BOTH is a boot error (see index.ts).
  DS_TEAM_IDS: z.string().optional(),
  FILE_STRUCTURE_DEPTH: z.coerce.number().int().min(1).max(10).default(4),
  FIGMA_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90000),
  // Per-call time budget for get_design_context stage degradation: enrichment stages that do
  // not fit the remaining budget are skipped (listed in degraded_stages); the core subtree
  // fetch fail-fasts instead of burning the client's timeout. Floor 5s (below that every
  // enrichment stage would always be shed). Ceiling 10min (R7-F2): every capMs derived from this
  // budget (loop fetch / trailing chain fetch in discoverAncestorModes, and the tool's own stage
  // caps) is itself clamped to <=90s, but a wildly oversized configured budget serves no purpose
  // and is rejected outright as a sanity bound rather than relying solely on those downstream clamps.
  FIGMA_TOOL_TIME_BUDGET_MS: z.coerce.number().int().min(5000).max(600_000).default(90000),
  // Cap concurrent heavy subtree fetches (whole-file / node subtrees). A single whole-file
  // tree can exceed 100MB; several in flight starve the event loop and risk OOM on the
  // no-swap prod box. Default 2 (one heavy + one). Set to 1 on memory-constrained hosts.
  FIGMA_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).default(2),
  MAX_RESULT_CHARS: z.coerce.number().int().min(1000).default(40000),
  // High OOM-backstop on a single whole-file REST fetch (~110MB legit passes; >128MB
  // pathology aborts mid-stream with a too_large error). min 1MB guards against a footgun value.
  MAX_FETCH_BYTES: z.coerce.number().int().min(1_000_000).default(128 * 1024 * 1024),
  // Per-entry cache byte ceiling — a raw response bigger than this is delivered but NOT cached
  // (cuts the ~110MB whole-file doc from resident memory). min 1MB guards a footgun value.
  CACHE_MAX_ENTRY_BYTES: z.coerce.number().int().min(1_000_000).default(64 * 1024 * 1024),
  // Aggregate resident cache byte ceiling across ALL read caches (one process-wide budget).
  // Over this, globally-LRU weighted entries are evicted. min 16MB guards a footgun value.
  CACHE_MAX_BYTES: z.coerce.number().int().min(16_000_000).default(256 * 1024 * 1024),
  // --- Frame hydration (v1: deepest-raw-per-frame RAM cache). Frame node_ids only, never
  // file-root — the ~110MB whole-file monster is unreachable by construction. ---
  // A fetched frame whose WIRE size exceeds this is delivered once but NOT held (hydrated:false),
  // tighter than MAX_FETCH_BYTES (128MB) so a heavy frame degrades honestly instead of pinning RAM.
  FRAME_MAX_PARSE_BYTES: z.coerce.number().int().min(1_000_000).default(3 * 1024 * 1024),
  // Global RESIDENT (parsed) ceiling for the shared FrameHydrationStore across ALL tenants
  // (wire × FRAME_PARSE_MULTIPLIER). Bounds the anonymous heap this line adds on the no-swap box.
  FRAME_RAM_GLOBAL_BYTES: z.coerce.number().int().min(8_000_000).default(48 * 1024 * 1024),
  // Per-tenant RESIDENT ceiling (stage-1 owner LRU before the global stage-2 sweep).
  FRAME_RAM_PER_TENANT_BYTES: z.coerce.number().int().min(4_000_000).default(16 * 1024 * 1024),
  // Wire→resident multiplier: parsed Figma JSON retains ~3-10× its wire bytes; the store accounts
  // each held frame as wire × this so the byte ceilings bound real RSS, not a 3-10× understatement
  // (same "measure the resident reality" lesson as the clamp pretty-calibration fix). Conservative 5.
  FRAME_PARSE_MULTIPLIER: z.coerce.number().min(1).default(5),
  // Process-wide cap on concurrent parse-into-heap hydrations (a singleton governor, like the Figma
  // semaphore). 1 on the RAM-tight prod box mirrors FIGMA_MAX_CONCURRENT_REQUESTS.
  HYDRATION_MAX_MATERIALIZE: z.coerce.number().int().min(1).default(1),
  // TTL (seconds) for a held frame raw; pull-based lazy expiry on access (no active timer), like the
  // read caches. A held frame is only as fresh as the version cache anyway. Default 300s.
  FRAME_CACHE_TTL_SEC: z.coerce.number().int().min(1).default(300),
  // Public base URL (e.g. 'https://figma.mcp.example.com', no trailing slash) that
  // get_layout_spec's minted upload_url / extractor loader are built against. Mode-aware
  // (resolved in server.ts): single-tenant http falls back to the actual bound
  // loopback origin (http://127.0.0.1:<port>) when unset — localhost deploys work out of the
  // box; stdio ALWAYS keeps publicBaseUrl undefined (no HTTP endpoint exists in-process, a URL
  // here would be dead) → upload_url is honestly never emitted; multi-tenant reads the same
  // variable via MultiTenantEnv.publicBaseUrl with `https://${mcpHost}` as its fallback.
  PUBLIC_BASE_URL: z.string().optional(),
}).refine((c) => c.CACHE_MAX_BYTES >= c.CACHE_MAX_ENTRY_BYTES, {
  // A per-entry cap ABOVE the aggregate ceiling is contradictory: a single legit ≤entry-cap response would
  // persistently overshoot the whole budget (the protect-guard keeps it honest/terminating, but the
  // config is a footgun). Fail-fast instead. Defaults (256MB ≥ 64MB) pass; lower BOTH knobs together.
  message: 'CACHE_MAX_BYTES must be >= CACHE_MAX_ENTRY_BYTES',
  path: ['CACHE_MAX_BYTES'],
}).refine((c) => c.FRAME_RAM_GLOBAL_BYTES >= c.FRAME_RAM_PER_TENANT_BYTES, {
  message: 'FRAME_RAM_GLOBAL_BYTES must be >= FRAME_RAM_PER_TENANT_BYTES',
  path: ['FRAME_RAM_GLOBAL_BYTES'],
}).refine((c) => c.FRAME_RAM_PER_TENANT_BYTES >= c.FRAME_MAX_PARSE_BYTES * c.FRAME_PARSE_MULTIPLIER, {
  // One held frame's resident weight (parse-cap × multiplier) must fit under the per-tenant ceiling,
  // else the very first hold overshoots its own budget and immediately self-evicts (thrash / never-hold).
  // Ties the resident-accounting unit to the eviction unit.
  message: 'FRAME_RAM_PER_TENANT_BYTES must be >= FRAME_MAX_PARSE_BYTES * FRAME_PARSE_MULTIPLIER',
  path: ['FRAME_RAM_PER_TENANT_BYTES'],
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid env config: ${issues}`);
  }
  return result.data;
}
