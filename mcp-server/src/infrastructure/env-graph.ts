// mcp-server/src/infrastructure/env-graph.ts
// Portal-free variables-graph initialisation for single-tenant (env-configured) deployments.
// Parses DS_TEAM_IDS, then lazily builds the library variable graph IN-MEMORY by driving the
// same headless syncUser mechanism the multi-tenant server uses — but with in-memory SyncDeps
// (no DB): replaceLibrary accumulates a local Lib[], which buildGraph turns into the resolver Graph.
// The returned EnvGraph mirrors the ToolDeps.variableGraph wrapper composition (server.ts:632-645)
// plus ensureReady(), which is idempotent, concurrency-safe (one build for N parallel callers),
// fail-soft (a failed build degrades to no graph, retried only after retryIntervalMs), and
// TTL-refreshed.
import { syncUser, type SyncDeps } from '../multi-tenant/library-sync.js';
import {
  buildGraph, resolveKey, resolveKeyModes, resolveKeyInMode, keyIsMultiMode,
  graphCssEvidenceView, type Graph, type Lib, type GraphCssView } from '../domain/variable-graph.js';
import { isMultiTenant } from '../multi-tenant/env.js';
import type { FigmaApi } from '../ports/figma-api.js';
import type { Logger } from './logger.js';
import type { ModeEvidenceStack } from '../domain/mode-resolve.js';
import type { ResolvedToken } from '../domain/design-context/resolved-token.js';

/** Library/variable/skipped counts from the sync that produced the currently-served graph. */
export interface EnvGraphStats { libraries: number; variables: number; skipped: number }

// Shape of ToolDeps.variableGraph (resolve / resolveInMode / isMultiMode) plus ensureReady().
export interface EnvGraph {
  /** Build the graph if needed. Idempotent, concurrency-safe, fail-soft, TTL-refreshed. */
  ensureReady(): Promise<void>;
  /** Counts from the most recent sync that produced the currently-served graph (undefined before the
   * first build). Stays aligned with what resolve() serves: on stale-good retention the previous
   * stats are kept, not overwritten with the empty resync's zeros. Lets a diagnostic caller (operator
   * CLI `graph check`) surface {libraries, variables} without a second fetch. */
  stats(): EnvGraphStats | undefined;
  resolve(key: string):
    { value: string; name?: string; sourceLibrary?: string; modesByName?: Record<string, string> } | undefined;
  resolveInMode(key: string, modeByCollection: Map<string, string>, coverageComplete?: boolean, evidence?: ModeEvidenceStack):
    (ResolvedToken & { pinned_axis_used: boolean; unconfirmed_default_used: boolean }) | undefined;
  isMultiMode(key: string): boolean;
  cssEvidence(referencedKeys: string[], excludeFileKey?: string): GraphCssView | undefined;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;    // re-sync the library graph every 6h
const DEFAULT_RETRY_INTERVAL_MS = 60 * 1000;  // after a failed build, back off 60s before retrying

/**
 * Parse a comma-separated DS_TEAM_IDS value into validated team ids. OWN logic — search-design-
 * system-tool's extractTeamId is neither exported nor throwing (it silently passes garbage through),
 * so it is unusable as a boot-time guard. Pipeline: split(',') → trim → drop empties → unwrap any
 * `/team/<id>` URL wrapper → validate all-digits. Any invalid element throws, naming every bad one:
 * a boot failure is safer than silently syncing the wrong (or no) team.
 */
export function parseTeamIds(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const elements = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const ids: string[] = [];
  const bad: string[] = [];
  for (const el of elements) {
    // Unwrap a figma.com/.../team/<id> URL first, then validate the extracted id is all-digits.
    const m = el.match(/\/team\/(\d+)/);
    const id = m ? m[1] : el;
    if (/^\d+$/.test(id)) ids.push(id);
    else bad.push(el);
  }
  if (bad.length > 0) {
    throw new Error(
      `DS_TEAM_IDS contains invalid team id(s): ${bad.join(', ')} ` +
      '(each must be all-digits or a figma.com/team/<id> URL)',
    );
  }
  return ids;
}

export function createEnvGraph(opts: {
  teamIds: string[];
  token: string;
  buildApi: (pat: string, timeoutMs?: number) => FigmaApi;
  logger: Logger;
  ttlMs?: number;
  retryIntervalMs?: number;
}): EnvGraph {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  let graph: Graph | undefined;             // built resolver graph; undefined until first success
  let inflight: Promise<void> | undefined;  // in-flight build; N parallel ensureReady() share it
  let lastSuccessAt: number | undefined;    // Date.now() of last CONFIRMED (non-empty) build (TTL anchor)
  let lastAttemptAt: number | undefined;    // Date.now() of last build attempt (retry backoff anchor)
  let lastAttemptDegraded = false;          // last attempt was thrown/empty (not a confirmed success) → retry-throttled
  let lastStats: EnvGraphStats | undefined; // counts from the sync that produced the current `graph`

  async function build(): Promise<void> {
    lastAttemptAt = Date.now();
    lastAttemptDegraded = true;   // pessimistic; flipped to false only on a confirmed (non-empty) success
    const libs: Lib[] = [];
    // In-memory SyncDeps — all six fields. getPat/listTeams feed the env token + team ids;
    // replaceLibrary accumulates the parsed Lib[]; setLibraries is a no-op (no registry to maintain
    // headless); buildApi/logger are passed straight through from opts.
    const deps: SyncDeps = {
      buildApi: opts.buildApi,
      getPat: async () => opts.token,
      listTeams: async () => opts.teamIds,
      setLibraries: async () => {},
      replaceLibrary: async (_userId, fileKey, vars, colls) => {
        libs.push({ fileKey, vars: vars as Lib['vars'], colls: colls as Lib['colls'] });
      },
      logger: opts.logger,
    };
    try {
      const result = await syncUser('env', deps);
      // A total transient outage (429/DNS across every team) makes syncUser return CLEANLY with
      // libs=[] (it swallows per-team/-file errors), so zero libraries is NOT a confirmed success.
      // lastStats is updated ONLY where `graph` is (re)published, so stats() and resolve() never
      // disagree — a stale-good retention keeps the previous graph AND its previous stats.
      if (libs.length > 0) {
        graph = buildGraph(libs);
        lastStats = result;
        lastSuccessAt = Date.now();                  // confirmed success — TTL branch governs
        lastAttemptDegraded = false;
      } else if (graph !== undefined && graph.byKey.size > 0) {
        // Stale-good retention: we already hold a previous NON-empty graph. Replacing good data with
        // an empty graph would silently degrade resolution to honest-but-worse aliases — serving
        // stale-good is standard cache practice and strictly better for the user. Keep the old graph
        // (and its lastStats) and DON'T stamp lastSuccessAt; lastAttemptDegraded stays true so the
        // retryIntervalMs guard throttles re-attempts until the outage clears.
        opts.logger.warn('env-graph resync yielded 0 libraries — keeping previous graph');
      } else {
        // First-ever build with zero libraries — nothing better to keep. Publish the empty graph so
        // resolve() degrades honestly; lastSuccessAt stays unset so ensureReady() re-attempts every
        // retryIntervalMs (a genuinely-empty account then re-syncs each interval — a deliberate
        // lesser cost than freezing an empty graph for the full ttlMs).
        graph = buildGraph(libs);
        lastStats = result;
      }
    } catch (err) {
      // Fail-soft: a boot-time sync failure (e.g. rate limit) degrades to no graph rather than
      // crashing the server. The next ensureReady() past retryIntervalMs retries.
      opts.logger.warn({ err: (err as Error).message }, 'env_graph.build_failed');
    }
  }

  async function ensureReady(): Promise<void> {
    if (inflight) return inflight;   // concurrency: join the single in-flight build
    const now = Date.now();
    // (1) A CONFIRMED (non-empty) success that is still within its TTL needs no rebuild.
    if (lastSuccessAt !== undefined && now - lastSuccessAt < ttlMs) return;
    // (2) Otherwise a rebuild is due (never succeeded, thrown, empty, or a success now past its TTL).
    // But if the LAST attempt was degraded (thrown / empty), back off retryIntervalMs before
    // re-attempting. This throttles BOTH the boot-outage case (no graph yet) AND a post-TTL resync
    // outage where we're serving a stale-good graph — in the latter lastSuccessAt is still set (old),
    // so this degraded-attempt gate, not the lastSuccessAt gate, is what governs the re-attempt cadence.
    if (lastAttemptDegraded && lastAttemptAt !== undefined && now - lastAttemptAt < retryIntervalMs) return;
    inflight = build();
    try { await inflight; } finally { inflight = undefined; }
  }

  return {
    ensureReady,
    stats() { return lastStats; },
    // Mirrors the MT wrapper composition (server.ts:632-645): default-mode value + name +
    // sourceLibrary, attaching modesByName only for a genuinely multi-mode key. byKey is stored
    // lower-cased (buildGraphMaps), so the sourceLibrary lookup normalizes the key to match.
    resolve(key) {
      if (!graph) return undefined;
      const r = resolveKey(graph, key);
      if (r.value === undefined) return undefined;
      const m = resolveKeyModes(graph, key);
      const multi = m && Object.keys(m.modesByName).length > 1;
      return {
        value: r.value, name: r.name, sourceLibrary: graph.byKey.get(key.toLowerCase())?.fileKey,
        ...(multi ? { modesByName: m!.modesByName } : {}),
      };
    },
    resolveInMode(key, modeByCollection, coverageComplete, evidence) {
      if (!graph) return undefined;
      return resolveKeyInMode(graph, key, modeByCollection, coverageComplete, evidence);
    },
    isMultiMode(key) {
      if (!graph) return false;
      return keyIsMultiMode(graph, key);
    },
    cssEvidence(referencedKeys, excludeFileKey) {
      if (!graph) return undefined;
      return graphCssEvidenceView(graph, referencedKeys, excludeFileKey);
    },
  };
}

// The AppConfig fields this wiring reads — a structural subset so env-graph.ts stays free of a
// dependency on the full config module (and the test can pass a bare object).
export interface EnvGraphConfig {
  DS_TEAM_IDS?: string;
  FIGMA_TOKEN?: string;
  DS_LIBRARY_TTL_SEC: number;
}

/**
 * Decide whether the single-tenant env graph should be wired into ToolDeps.variableGraph and, if
 * so, build it. Returns undefined (no graph) when:
 *   - DS_TEAM_IDS is unset/blank → the feature is off (byte-for-byte the prior no-graph behaviour);
 *   - DS_TEAM_IDS parses to zero ids (e.g. a bare "," ) → nothing to sync;
 *   - DS_TEAM_IDS is set but FIGMA_TOKEN is absent → a graph is IMPOSSIBLE (the sync needs a token).
 *     This is a misconfiguration, but a soft one — warn ONCE at construction and degrade to no graph
 *     rather than crash-loop the server (cross-library aliases stay honestly unresolved).
 * A malformed DS_TEAM_IDS (non-digit id) makes parseTeamIds THROW — that surfaces as a hard boot
 * failure, which is the correct outcome for a garbage team-id list (fail loud, not silently mis-sync).
 * `ttlMs` is wired from DS_LIBRARY_TTL_SEC (the published-library staleness bound); retryIntervalMs
 * keeps createEnvGraph's 60s default.
 */
export function createEnvGraphFromConfig(
  config: EnvGraphConfig,
  logger: Logger,
  buildApi: (pat: string, timeoutMs?: number) => FigmaApi,
): EnvGraph | undefined {
  if (config.DS_TEAM_IDS === undefined || config.DS_TEAM_IDS.trim().length === 0) return undefined;
  const teamIds = parseTeamIds(config.DS_TEAM_IDS);   // throws on a garbage id → hard boot failure
  if (teamIds.length === 0) return undefined;
  if (config.FIGMA_TOKEN === undefined || config.FIGMA_TOKEN.length === 0) {
    logger.warn(
      { team_count: teamIds.length },
      'env_graph.disabled_no_token: DS_TEAM_IDS is set but FIGMA_TOKEN is missing — cross-library aliases will not resolve headless',
    );
    return undefined;
  }
  return createEnvGraph({
    teamIds,
    token: config.FIGMA_TOKEN,
    buildApi,
    logger,
    ttlMs: config.DS_LIBRARY_TTL_SEC * 1000,
  });
}

/**
 * Boot-time guard: the single-tenant env graph (DS_TEAM_IDS) and multi-tenant mode are mutually
 * exclusive. In MULTI_TENANT the variable-library graph is built PER USER from the database (each
 * user registers their own teams), so a process-wide DS_TEAM_IDS would be silently ignored — a
 * latent misconfiguration. Returns an explanatory message (for index.ts to print to stderr before
 * exit 1) when both are set, else null. Pure/env-injectable so it is unit-testable without a spawn.
 */
export function multiTenantEnvGraphConflict(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isMultiTenant(env) && (env.DS_TEAM_IDS ?? '').trim().length > 0) {
    return (
      'DS_TEAM_IDS is set together with MULTI_TENANT=true. In multi-tenant mode the variable ' +
      'library graph is built per-user from the database (each user registers their own teams), ' +
      'so a process-wide DS_TEAM_IDS is ignored and signals a misconfiguration. Remove DS_TEAM_IDS ' +
      '(it configures the single-tenant / local env graph only).'
    );
  }
  return null;
}
