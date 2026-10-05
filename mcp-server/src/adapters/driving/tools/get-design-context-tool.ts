// NOTE: getVariablesLocal failures are negative-cached by the caching adapter
// (caching-figma-api.ts, variablesErrorCache: version-keyed, short TTL) and
// rethrown as FigmaApiError(kind, status, 'cached: ' + message), so repeat calls
// to a genuinely-broken endpoint fail fast with the original kind preserved. Only
// TOKEN-INDEPENDENT evidence is ever cached (R8-F3): 'upstream' (5xx),
// 'unknown_4xx' (400), and a full-cap timeout. On non-Enterprise files a 403
// (forbidden) is a per-TOKEN verdict and is NEVER cached — every call reaches the
// real API. rate_limited is never cached either. The 'cached: ' message prefix is
// a contract — the degraded-stage classifier below keys on it (reason
// 'cached_error').
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { serializeForDelivery } from './serialize.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, normalizeScopedResponseRoot, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { simplify } from '../../../domain/design-context/simplify.js';
import { buildVariableIndex, resolveBoundVariable, resolveBoundVariableInMode, boundVariableId, type VariableIndex } from '../../../domain/variables.js';
import {
  collectSubtreeModes, collectSubtreeChains, buildModeByCollection, buildExactModeEvidence, buildGraphModeEvidence,
  documentaryAncestorChain, sceneIdEquals,
  modeIds, effectiveMode, type DocumentaryChainFailure, type ModeEvidenceStack, type ModeStack,
} from '../../../domain/mode-resolve.js';
import { sizeOf } from '../../../infrastructure/response-size.js';
import { extractLibraryKey } from '../../../domain/variable-snapshot.js';
import { FigmaApiError, TOO_LARGE_REASON_RE } from '../../../ports/errors.js';
import type { FigmaApi } from '../../../ports/figma-api.js';
import type { Logger } from '../../../infrastructure/logger.js';
import type { ResolvedToken } from '../../../domain/design-context/resolved-token.js';
import type { RawSceneNode, RawPaint, RawVariableAlias, PublishedComponentMeta } from '../../../domain/figma-raw.js';
import type { DesignContext, ComponentDoc, SimplifiedNode } from '../../../domain/design-context/types.js';
import { collectInstanceKeys, indexSnippetsByNodeId, buildComponentDocs, type CodeConnectSnippet } from '../../../domain/code-connect-enrich.js';
import { fitToBudget } from '../../../domain/design-context/auto-degrade.js';
import { findComponentInstances } from '../../../application/find-component-instances.js';

// CSS var() name segment: escape chars that would prematurely close the function or
// be read as the fallback separator. Figma names are free-form (e.g. "button(default)").
const cssVarName = (n: string): string => n.replace(/[(),]/g, '\\$&');

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42", or a nested-instance id like "I12:340;56:7890"')
    .describe('The node to extract design context for (a frame/component/instance)'),
  depth: z.number().int().min(1).max(8).default(4)
    .describe('Subtree depth to extract (default 4). When the result exceeds the size budget the server auto-reduces depth (down to 1) instead of refusing; check degraded/depth in the response.'),
  include_component_docs: z.boolean().default(true)
    .describe('Include human-authored component descriptions/documentation links as a deduped `components` map keyed by component id. Default true (cheap - reuses the Code Connect component fetch); set false to shrink output.'),
  include_screenshot: z.boolean().default(false)
    .describe('When true, also attach a short-lived signed PNG `screenshot` URL of the node for visual context (token-light - a URL string, never inline base64; default false to keep responses lean). Use get_screenshot for inline/SVG/scale control.'),
  screenshot_scale: z.number().min(0.25).max(4).default(2)
    .describe('Raster scale for the include_screenshot PNG (default 2).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

// Property keys whose bound variables the simplifier resolves to a value (fills/strokes).
const BOUND_PAINT_KEYS = ['fills', 'strokes'] as const;

// Walk the node tree and collect bound-variable alias ids that the LOCAL index
// cannot name (external library variables). These are the only ids worth a
// snapshot lookup — locally-resolvable bindings already get a token name.
// When idx is undefined (variables endpoint unavailable) every bound id is external.
function collectExternalAliasIds(root: RawSceneNode, idx: VariableIndex | undefined): string[] {
  const ids = new Set<string>();
  const visit = (n: RawSceneNode): void => {
    if (n.visible === false) return;
    for (const key of BOUND_PAINT_KEYS) {
      const id = boundVariableId(n.boundVariables, key);
      if (id && !(idx?.byId.has(id))) ids.add(id);
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(root);
  return [...ids];
}

// --- Ancestor-mode discovery ---------------------------------------------------------------
// Targeted file projections retain the documentary path to every requested id without pulling the
// unrelated file tree. The three-rung ladder is shared by get_design_context and compare.
const ANCESTOR_START_DEPTH = 4;
const ANCESTOR_MAX_DEPTH = 16;
const ANCESTOR_MAX_ATTEMPTS = 3;
const ANCESTOR_BYTE_BUDGET = 24 * 1024 * 1024;

export type AncestorDiscoveryReason = DocumentaryChainFailure
  | 'missing_version'
  | 'version_mismatch'
  | 'byte_budget'
  | 'time_budget'
  | 'depth_cap'
  | 'error';

export interface AncestorDiscovery {
  stack: ModeStack;
  nodesRootToParent: RawSceneNode[];
  coverageComplete: boolean;
  reason?: AncestorDiscoveryReason;
}

export interface AncestorDiscoveryConfig {
  startDepth?: number;
  maxDepth?: number;
  byteBudget?: number;
  deadlineAt?: number;
  makeCappedApi?: (capMs: number) => Pick<FigmaApi, 'getDocumentByIdsRaw'>;
}

const emptyDiscovery = (reason: AncestorDiscoveryReason): AncestorDiscovery => ({
  stack: new Map(), nodesRootToParent: [], coverageComplete: false, reason,
});

const isTimeoutAbort = (err: unknown): boolean =>
  err instanceof FigmaApiError && err.kind === 'network' && err.message.includes('timed out');

const isTooLarge = (err: unknown): boolean => err instanceof FigmaApiError
  && (err.kind === 'too_large'
    || (err.kind === 'unknown_4xx' && err.status === 400 && TOO_LARGE_REASON_RE.test(err.upstreamReason ?? '')));

function canonicalSceneIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) if (!out.some((kept) => sceneIdEquals(kept, id))) out.push(id);
  return out;
}

function projectionBytes(value: unknown): number {
  const tagged = sizeOf(value);
  if (tagged > 0) return tagged;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

/** Resolve a batch with at most one targeted projection at each depth (4 -> 8 -> 16). */
export async function discoverAncestorModesBatch(
  api: Pick<FigmaApi, 'getDocumentByIdsRaw'>,
  fileKey: string,
  nodeIds: readonly string[],
  version: string | undefined,
  logger: Logger,
  cfg: AncestorDiscoveryConfig = {},
): Promise<Map<string, AncestorDiscovery>> {
  const ids = canonicalSceneIds(nodeIds);
  const results = new Map<string, AncestorDiscovery>();
  if (!version) {
    for (const id of ids) results.set(id, emptyDiscovery('missing_version'));
    return results;
  }

  const maxDepth = cfg.maxDepth ?? ANCESTOR_MAX_DEPTH;
  const depths: number[] = [];
  let depth = Math.min(cfg.startDepth ?? ANCESTOR_START_DEPTH, maxDepth);
  while (depths.length < ANCESTOR_MAX_ATTEMPTS) {
    depths.push(depth);
    if (depth >= maxDepth) break;
    depth = Math.min(depth * 2, maxDepth);
  }

  let unresolved = [...ids];
  for (const attemptedDepth of depths) {
    if (unresolved.length === 0) break;
    if (cfg.deadlineAt !== undefined && Date.now() >= cfg.deadlineAt) {
      for (const id of unresolved) results.set(id, emptyDiscovery('time_budget'));
      unresolved = [];
      break;
    }
    const remaining = cfg.deadlineAt === undefined ? undefined : cfg.deadlineAt - Date.now();
    const fetchApi = remaining !== undefined && cfg.makeCappedApi
      ? cfg.makeCappedApi(Math.min(Math.max(1, remaining), 90_000))
      : api;

    let raw: Awaited<ReturnType<FigmaApi['getDocumentByIdsRaw']>>;
    try {
      raw = await fetchApi.getDocumentByIdsRaw(fileKey, unresolved, attemptedDepth, version);
    } catch (err) {
      if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
      const reason: AncestorDiscoveryReason = isTimeoutAbort(err) ? 'time_budget' : isTooLarge(err) ? 'byte_budget' : 'error';
      for (const id of unresolved) results.set(id, emptyDiscovery(reason));
      unresolved = [];
      break;
    }

    const bytes = projectionBytes(raw);
    if (bytes > (cfg.byteBudget ?? ANCESTOR_BYTE_BUDGET)) {
      for (const id of unresolved) results.set(id, emptyDiscovery('byte_budget'));
      unresolved = [];
      break;
    }
    if (!raw || typeof raw !== 'object' || raw.document?.type !== 'DOCUMENT') {
      for (const id of unresolved) results.set(id, emptyDiscovery('invalid_projection'));
      unresolved = [];
      break;
    }
    if (typeof raw.version !== 'string' || raw.version.length === 0) {
      for (const id of unresolved) results.set(id, emptyDiscovery('missing_version'));
      unresolved = [];
      break;
    }
    if (raw.version !== version) {
      for (const id of unresolved) results.set(id, emptyDiscovery('version_mismatch'));
      unresolved = [];
      break;
    }

    const next: string[] = [];
    for (const id of unresolved) {
      const chain = documentaryAncestorChain(raw.document, id);
      if (chain.ok) {
        results.set(id, {
          stack: buildModeByCollection(chain.nodesRootToParent),
          nodesRootToParent: chain.nodesRootToParent,
          coverageComplete: true,
        });
      } else if (chain.reason === 'missing_target') {
        next.push(id);
      } else {
        results.set(id, emptyDiscovery(chain.reason));
      }
    }
    unresolved = next;
  }

  for (const id of unresolved) results.set(id, emptyDiscovery('depth_cap'));
  for (const id of ids) {
    const result = results.get(id)!;
    logger.info({ file_key_prefix: fileKey.slice(0, 8), node_id: id,
      coverage_complete: result.coverageComplete, reason: result.reason }, 'design_context.ancestor_discovery');
  }
  return results;
}

/** Singleton wrapper retained for get_design_context. */
export async function discoverAncestorModes(
  api: Pick<FigmaApi, 'getDocumentByIdsRaw'>,
  fileKey: string,
  nodeId: string,
  version: string | undefined,
  logger: Logger,
  cfg: AncestorDiscoveryConfig = {},
): Promise<AncestorDiscovery> {
  return (await discoverAncestorModesBatch(api, fileKey, [nodeId], version, logger, cfg)).get(nodeId)
    ?? emptyDiscovery('missing_target');
}

export function registerGetDesignContextTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_design_context',
    {
      description: 'Extract a descriptive, code-oriented representation of a Figma node: layout, sizing, fills/strokes/effects (deduplicated into globalVars), text, typography, and component instances. A multi-mode bound variable emits {token, default_value, effective_rendered_value, value, effective_modes, effective_mode_source, mode_dependent}. value aliases effective_rendered_value. default_value is diagnostic only and is never substituted for a rendered color. effective_mode_source is explicit_node, ancestor_chain, confirmed_default, or unverifiable; when it is unverifiable, effective_rendered_value and value are null and the hint says not to use the default as the rendered color. Each effective_modes axis includes its mode and source, plus node_id for explicit or ancestor evidence. A top-level mode_context marker may be present: "library_default_modes" means this file is a registered component library rendered in its default variable modes; "default_modes" means every shown mode-dependent value is its confirmed axis default. The marker appears only with positive evidence; its absence claims nothing. Single-mode variables keep their compact inline form. Human-authored component documentation is returned as a deduped components map (disable with include_component_docs:false). Set include_screenshot:true to attach a short-lived signed PNG URL. Truncated containers carry truncated:true and childCount; request that node directly, raise depth (max 8), or use get_metadata. Enrichment stages that exceed the server time budget are listed in degraded_stages; the core subtree is never time-degraded. Use get_metadata first to pick a node_id.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, extra) =>
      runTool('get_design_context', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        // Heartbeat (best-effort): MCP progress notifications at stage boundaries, so a client
        // watching a long call can tell "alive" from "hung". Driven entirely by the client's
        // request-level `_meta.progressToken` (RequestHandlerExtra, MCP SDK ^1.0.0) — absent
        // token, or a legacy call site that never passes `extra` (pre-existing unit tests), is a
        // strict no-op. Never throws, never awaited by the caller, never slows the tool: the send
        // is fire-and-forget and any rejection (client gone, transport closed) is swallowed.
        const progressToken = extra?._meta?.progressToken;
        const progress = (message: string, pct: number): void => {
          if (progressToken === undefined) return;
          // R8-F2: `.catch()` only guards a REJECTED promise — a non-async (plain function)
          // sendNotification that throws SYNCHRONOUSLY never returns a promise to attach `.catch`
          // to at all; that throw would propagate straight out of progress() and fail the whole
          // tool call over a best-effort heartbeat. Wrap the call itself in try/catch so a
          // synchronous throw is swallowed exactly like an asynchronous rejection.
          try {
            void extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: pct, total: 100, message },
            }).catch(() => { /* heartbeat is best-effort — must never fail or slow the tool */ });
          } catch {
            /* heartbeat is best-effort — a synchronously-throwing sendNotification must never fail the tool */
          }
        };

        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const id = normalizeCompoundNodeId(args.node_id);

        // Time budget (spec): deadline for the WHOLE call. Enrichment stages check remaining()
        // and skip honestly into degraded_stages; every skip lands on an EXISTING honesty path
        // (no idx -> honest labels; coverageComplete=false -> honest 'default').
        const deadlineAt = Date.now() + (deps.toolTimeBudgetMs ?? 90_000);
        const remaining = () => deadlineAt - Date.now();
        type DegradedStage = NonNullable<DesignContext['degraded_stages']>[number];
        const degradedStages: DegradedStage[] = [];
        const stageDegraded = (stage: DegradedStage['stage'], reason: DegradedStage['reason'], detail?: string): void => {
          degradedStages.push({ stage, reason, ...(detail ? { detail } : {}) });
          deps.logger.info({ stage, reason, detail, remaining_ms: remaining() }, 'design_context.stage_degraded');
        };
        // Fetch depth+1 so boundary containers reveal whether children were cut (accurate
        // truncated/childCount); simplify stops at args.depth so the extra level is count-only.
        // The core subtree fetch is never skipped — without it there is no answer — but it
        // FAIL-FASTS with an actionable error instead of burning the client's timeout (spec p.2).
        // REAL capped api (like every other stage): buildApi(token, capMs) hands the adapter a fresh
        // AbortController capped at the remaining budget (clamped 1s..90s), so an over-budget fetch
        // aborts INSIDE FigmaRestAdapter as a SETTLED FigmaApiError('network', '… timed out …') and
        // the process-wide concurrency slot is freed immediately on that rejection (Semaphore.run
        // releases in its finally). No orphaned race keeps a slot pinned for up to 90s. A 429
        // arriving before the cap rethrows as genuine rate_limited and surfaces as a back-off signal.
        // R9-F1 (closed): passing the ABSOLUTE `deadlineAt` into buildApi makes the adapter clamp its
        // abort window to the remaining budget at DISPATCH (after any semaphore queue wait), so the
        // old 'unbounded queue wait runs a stale capMs in full' residual is gone — a request dequeued
        // past the deadline exits in ~1ms without a fetch and frees the slot, so the queue drains
        // instead of compounding. Overshoot is now bounded by the ACTIVE holder's remaining cap. The
        // R5-F3 getFileVersion-preflight ~2x note is likewise closed: the preflight round trip shares
        // the same deadlineAt, so both round trips together are bounded by the deadline, not 2x a cap.
        const coreCapMs = Math.min(Math.max(remaining() - 5_000, 1_000), 90_000);
        const coreApi = deps.buildApi(token, coreCapMs, deadlineAt);
        let nodes: Awaited<ReturnType<FigmaApi['getNodesRaw']>>;
        // Heartbeat: the core fetch is the LONGEST stage (up to ~85s of silence at a 90s budget) and
        // was previously the only stage with no progress ping BEFORE it started — a client watching
        // the call had nothing to distinguish "alive and fetching" from "hung" until the first
        // ping fired 20% in, after the fetch already completed. Emit one right before dispatch.
        progress('fetching subtree', 5);
        try {
          nodes = await coreApi.getNodesRaw(parsed.value, [id], args.depth + 1);
        } catch (err) {
          if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
          if (err instanceof FigmaApiError && err.kind === 'network' && err.message.includes('timed out')) {
            // Honest about uncertainty: a timeout does not prove the node is heavy — Figma may be
            // slow or rate-limiting. This is now a settled abort, not a race, so there is no late
            // rejection to log; a 429 arriving first rethrew above as rate_limited.
            throw new Error(
              `subtree fetch for node ${id} exceeded the time budget at depth ${args.depth} — the node may be too heavy, or Figma may be slow or rate-limiting right now.`
              + (args.depth > 2
                ? ` Retry with depth <= ${args.depth - 2}, or request child nodes directly (use get_metadata to pick them).`
                : ` Request child nodes directly (use get_metadata to pick them), or retry shortly.`),
            );
          }
          throw err;
        }
        const entry = nodes.nodes[id];
        if (!entry) throw new Error(`node ${id} not found in file`);
        const scopedDoc = normalizeScopedResponseRoot(entry.document, id);
        if (!scopedDoc) throw new Error(`node ${id} returned a malformed scoped root`);
        progress('subtree fetched', 20);

        // We fetched args.depth + 1 so we can tell a depth-cut container (children exist one level
        // below the requested depth) from a genuinely empty one. Use that extra level ONLY to count
        // cut children, then prune it away immediately so EVERY downstream consumer — needsAncestors,
        // collectExternalAliasIds, collectSubtreeModes/Chains, and simplify — sees exactly the
        // requested depth, byte-identical to a plain depth-N fetch. The pruned tree is built from
        // shallow copies along the kept path: the scoped root shares its descendants with the cached
        // API response, which must never be mutated. This keeps mode resolution and
        // ancestor-discovery gating unaffected by a node that is never rendered in the result.
        const boundaryChildCounts = new Map<string, number>();
        const pruneToRequestedDepth = (n: RawSceneNode, depth: number): RawSceneNode => {
          if (!n.children) return n;
          if (depth >= args.depth) {
            const visibleKids = n.children.filter((c) => c.visible !== false);
            if (visibleKids.length) boundaryChildCounts.set(n.id, visibleKids.length);
            const { children: _cut, ...rest } = n;
            return rest as RawSceneNode;
          }
          return { ...n, children: n.children.map((c) => pruneToRequestedDepth(c, depth + 1)) };
        };
        const doc = pruneToRequestedDepth(scopedDoc, 0);

        progress('resolving variables', 35);
        // Best-effort variable resolution; absent on non-Enterprise → raw hex. Capped at
        // min(25s, remaining) and skipped outright when under 5s remains — every exit lands
        // on the existing idx-undefined honesty path (raw hex, mode_context suppressed).
        let idx: VariableIndex | undefined;
        let resolveToken: ((bv: typeof doc.boundVariables, key: string) => string | null) | undefined;
        if (remaining() < 5_000) {
          stageDegraded('variables', 'time_budget');
        } else {
          try {
            // REAL per-call timeout instead of a race: buildApi(token, timeoutMs) hands the adapter
            // a fresh AbortController capped at the remaining budget (clamped 1s..25s), so the abort
            // happens INSIDE FigmaRestAdapter and every exit is a settled outcome — an over-budget
            // fetch throws the adapter's timeout FigmaApiError ('… timed out …'), and a 429 arriving
            // before the cap rethrows as rate_limited. A late 429 can therefore never be swallowed
            // into a quiet degraded success (the round-2 race bug). Trade-off: a real abort means a
            // late success no longer warms the variables read cache — the negative cache (which must
            // NOT cache rate_limited) covers the broken-endpoint case instead. Read caches are shared
            // across buildApi instances (single factory in server.ts), so this extra instance reuses them.
            const varsApi = deps.buildApi(token, Math.max(1_000, Math.min(25_000, remaining())), deadlineAt);
            idx = buildVariableIndex(await varsApi.getVariablesLocal(parsed.value));
            resolveToken = (bv, key) => resolveBoundVariable(bv, key, idx!);
          } catch (err) {
            // Variables are optional enrichment — degrade to raw hex on any failure
            // EXCEPT rate limiting, which must surface so the agent backs off (and
            // the node tree is already cached, so a retry is cheap).
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            deps.logger.info({ err: (err as Error).message }, 'design_context.variables_unavailable');
            stageDegraded('variables',
              (err as Error).message.startsWith('cached: ') ? 'cached_error'
              : (err as Error).message.includes('timed out') ? 'time_budget' : 'error');
          }
        }

        // Build the single-tenant env library graph before ANY variableGraph read below. This one
        // await DOMINATES every read site — the up-front resolve block, needsAncestors, the
        // mode-context scan (bindingIsUntracked), and resolveTokenMode — NOT merely the first, so a
        // cross-library binding reachable ONLY via a late path (e.g. a node-scalar in the mode-context
        // scan) still resolves. Idempotent/fail-soft; a no-op for the MT wrappers and when no env
        // graph is configured. Placed after the core subtree + variables fetches so the lazy library
        // sync overlaps naturally rather than serializing ahead of the answer's core fetch.
        await deps.variableGraph?.ensureReady?.();

        // Cross-library bound vars: resolve to a hex up-front and hand the simplifier a
        // sync lookup. Graph-first (sync); for keys the graph misses, fall back to the
        // snapshot (async DB lookup — covers too-large files REST can't serve). Best-effort.
        let resolveSnapshot: ((bv: typeof doc.boundVariables, key: string) => string | null) | undefined;
        if (deps.variableGraph || deps.variableSnapshot) {
          try {
            const externalIds = collectExternalAliasIds(doc, idx);
            const keys = [...new Set(externalIds.map(extractLibraryKey).filter((k): k is string => k !== null))];
            if (keys.length) {
              const graphHits = new Map<string, { value: string; name?: string }>();
              if (deps.variableGraph) {
                for (const k of keys) {
                  const hit = deps.variableGraph.resolve(k);
                  if (hit) graphHits.set(k, { value: hit.value, name: hit.name });
                }
              }
              const missed = keys.filter((k) => !graphHits.has(k));
              const snapHits = deps.variableSnapshot && missed.length ? await deps.variableSnapshot.lookup(missed) : undefined;
              if (graphHits.size || (snapHits && snapHits.size)) {
                resolveSnapshot = (bv, key) => {
                  const id = boundVariableId(bv, key);
                  if (!id) return null;
                  const k = extractLibraryKey(id);
                  if (!k) return null;
                  const g = graphHits.get(k);
                  if (g !== undefined) return g.name ? `var(--${cssVarName(g.name)}, ${g.value})` : g.value;
                  const s = snapHits?.get(k)?.value;
                  return s != null ? String(s) : null;
                };
              }
            }
          } catch (err) {
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            deps.logger.info({ err: (err as Error).message }, 'design_context.alias_resolution_unavailable');
          }
        }

        // --- node-mode resolution (pointer #1) ---
        const subtreeModes = collectSubtreeModes(doc);                 // nodeId -> modes inherited from doc down
        const nodeStack = (nodeId: string): ModeStack => subtreeModes.get(nodeId) ?? new Map();

        // First bound-variable alias id for a paint key: node-level, else paint-level (fills[].boundVariables.color).
        const paintAliasId = (paints: RawPaint[] | undefined): string | undefined =>
          paints?.map((p) => p.boundVariables?.color?.id).find((x): x is string => !!x);
        const aliasIdFor = (n: RawSceneNode, key: 'fills' | 'strokes'): string | undefined =>
          boundVariableId(n.boundVariables, key) ?? paintAliasId(n[key]);

        // Does the subtree bind any fill/stroke whose mode the subtree alone can't pin down?
        // (a local multi-mode collection with no explicit mode in the subtree, or ANY cross-library binding)
        // Raw above-root ancestor nodes (root→parent), lib-key-folded WITH the subtree chain below
        // to build the graph resolver's nearest-wins-by-library-key stack (see graphStackFor).
        let ancestorNodesRootToParent: RawSceneNode[] = [];
        const needsAncestors = (): boolean => {
          let need = false;
          const visit = (n: RawSceneNode): void => {
            if (need) return;   // decided — stop walking (avoids further resolve() lookups)
            if (n.visible === false) return;
            for (const key of BOUND_PAINT_KEYS) {
              const aliasId = aliasIdFor(n, key);
              if (!aliasId) continue;
              const v = idx?.byId.get(aliasId);
              if (v) {
                const modes = idx!.collectionModes.get(v.variableCollectionId) ?? [];
                if (modes.length > 1 && effectiveMode(nodeStack(n.id), v.variableCollectionId, undefined) === null) need = true;
              } else if (deps.variableGraph) {
                // cross-library: ancestors matter ONLY when the top collection is multi-mode. A
                // single-mode top binding renders inline (mode_dependent stays false) regardless of
                // any ancestor mode, so targeted projection for it is pure waste.
                // isMultiMode counts modes by existence (exact mirror of resolveInMode's mode-object
                // condition, robust to a partial-sync collection with an unresolvable mode); when
                // that signal is absent, fall back to resolve().modesByName (present iff multi-mode).
                const libKey = extractLibraryKey(aliasId);
                const vg = deps.variableGraph;
                if (libKey && (vg.isMultiMode?.(libKey) ?? vg.resolve(libKey)?.modesByName != null)) need = true;
              }
            }
            for (const c of n.children ?? []) visit(c);
          };
          visit(doc);
          return need;
        };

        // coverageComplete threads to the mode resolvers. It is true ONLY when
        // discovery actually RAN and confirmed the request node's full ancestor chain. A SKIPPED
        // discovery cannot claim complete coverage: needsAncestors() only inspects each binding's
        // DIRECTLY-bound collection, never its downstream alias hops, so a directly-pinned binding
        // may still alias into a multi-mode collection that nothing in the subtree pins. Defaulting
        // to false keeps such a downstream fallback honestly 'default' — never a false 'node'.
        progress('discovering ancestor modes', 55);
        let coverageComplete = false;
        const ancestorDiscoveryWanted = needsAncestors();
        if (ancestorDiscoveryWanted) {
          try {
            // Bounded, size-guarded ancestor discovery: one targeted batch ladder (4 -> 8 -> 16)
            // stops when the request node is proven or a depth/byte/time bound is hit, then degrades
            // honestly (coverageComplete=false -> resolvers stay at honest 'default').
            // The leading positional `api` arg is discoverAncestorModes' no-deadline fallback,
            // exercised directly by its own unit tests; THIS call always passes both `deadlineAt`
            // and `makeCappedApi` below, so every fetch inside always resolves through the fresh
            // capped instance and the fallback branch is structurally unreachable here. Passing the
            // already-built `coreApi` (rather than constructing a separate, genuinely unused plain
            // instance) avoids an extra dead buildApi call purely to satisfy the required parameter.
            const disc = await discoverAncestorModes(coreApi, parsed.value, id, nodes.version, deps.logger,
              { deadlineAt, makeCappedApi: (capMs) => deps.buildApi(token, capMs, deadlineAt) });
            ancestorNodesRootToParent = disc.nodesRootToParent;
            coverageComplete = disc.coverageComplete;
            if (disc.reason) stageDegraded('ancestor_discovery', disc.reason === 'time_budget' ? 'time_budget' : 'error', disc.reason);
          } catch (err) {
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            deps.logger.info({ err: (err as Error).message }, 'design_context.ancestor_modes_unavailable');
            stageDegraded('ancestor_discovery', 'error');
          }
        }

        // Effective stack for the LOCAL (exact-id) resolver = ancestors (above the request root)
        // overridden by the subtree chain. Local (in-file) collection ids have no "/" so they never
        // de-dupe by library key and a file's subscribed collection uses a consistent instance id —
        // an exact-id merge stays correct here. (effectiveMode does an exact stack.get(collectionId).)
        const subtreeChains = collectSubtreeChains(doc);   // nodeId -> [request-root … node]
        const fullChainFor = (n: RawSceneNode): RawSceneNode[] =>
          [...ancestorNodesRootToParent, ...(subtreeChains.get(n.id) ?? [n])];
        const exactEvidenceFor = (n: RawSceneNode): ModeEvidenceStack =>
          buildExactModeEvidence(fullChainFor(n), n.id);
        const graphEvidenceFor = (n: RawSceneNode): ModeEvidenceStack =>
          buildGraphModeEvidence(fullChainFor(n), n.id);
        const stackFor = (n: RawSceneNode): ModeStack => modeIds(exactEvidenceFor(n));
        const graphStackFor = (n: RawSceneNode): ModeStack => modeIds(graphEvidenceFor(n));

        // mode_context accumulators: positive-evidence tracking across ALL bindings.
        const modeCtxStats = { pinnedAxisUsed: false, untrackedBinding: false, unconfirmedDefaultUsed: false, untrackedKinds: [] as string[] };

        // Pins in the fetched scope (post-prune subtree + discovered ancestors) and
        // gradient-stop bindings (never reach resolveTokenMode → structurally untracked). Pins
        // BELOW the depth cut cannot affect shown nodes — their stacks fold only in-scope ancestors.
        let pinsInScope = ancestorNodesRootToParent.some((a) => Object.keys(a.explicitVariableModes ?? {}).length > 0);
        // The only bound-variable paths this tool tracks through resolveTokenMode are
        // node/paint-level fills and strokes. Any other binding — a scalar prop (cornerRadius,
        // opacity, strokeWeight, layout gap/padding, text props), an effect (shadow) color, or a
        // gradient stop — renders RAW from the Figma payload; a "clean" scan must not claim
        // positive evidence when such a binding could be mode-dependent and branded.
        const TRACKED_BV_KEYS = new Set<string>(BOUND_PAINT_KEYS);
        // Granular: a binding OUTSIDE the tracked fills/strokes paths is safe iff its
        // variable is provably SINGLE-mode (one value — cannot vary by brand). Multi-mode or
        // unresolvable (dangling id, key not in graph, no graph) stays untracked: no positive
        // evidence. Multiplicity only — never the value or mode; sync lookups, no new fetches.
        const bindingIsUntracked = (a: RawVariableAlias | undefined): boolean => {
          const bindId = a?.id;
          if (!bindId) return false;                                   // not a binding
          const v = idx?.byId.get(bindId);
          if (v) {
            const modes = idx!.collectionModes.get(v.variableCollectionId);
            return modes ? modes.length > 1 : true;                    // unknown collection → conservative
          }
          const libKey = extractLibraryKey(bindId);
          const vg = deps.variableGraph;
          if (libKey && vg) {
            const hit = vg.resolve(libKey);
            if (!hit) return true;                                     // key not in the graph → unresolvable
            // isMultiMode counts modes by existence; hit.modesByName is the legacy multi signal.
            return vg.isMultiMode?.(libKey) ?? (hit.modesByName != null);
          }
          return true;                                                 // no idx entry, no graph → unresolvable
        };
        const aliasList = (val: RawVariableAlias | RawVariableAlias[] | undefined): RawVariableAlias[] =>
          Array.isArray(val) ? val : val ? [val] : [];
        const markUntracked = (kind: string): void => {
          modeCtxStats.untrackedBinding = true;
          if (!modeCtxStats.untrackedKinds.includes(kind)) modeCtxStats.untrackedKinds.push(kind);
        };
        const scanModeContextScope = (n: RawSceneNode): void => {
          if (Object.keys(n.explicitVariableModes ?? {}).length > 0) pinsInScope = true;
          for (const p of [...(n.fills ?? []), ...(n.strokes ?? [])]) {
            if (p.gradientStops?.some((s) => bindingIsUntracked(s.boundVariables?.color))) markUntracked('gradient-stop');
            // Paint-level bindings other than `color` (e.g. the layer-opacity slider) feed the
            // rendered hex's alpha channel; safe only when the bound variable is single-mode.
            for (const [k, val] of Object.entries(p.boundVariables ?? {})) {
              if (k !== 'color' && aliasList(val).some(bindingIsUntracked)) markUntracked('paint-prop');
            }
          }
          // Bindings outside the mode-tracked fills/strokes paths (scalar props, text
          // props) — safe only when the bound variable is single-mode.
          for (const [k, val] of Object.entries(n.boundVariables ?? {})) {
            if (!TRACKED_BV_KEYS.has(k) && aliasList(val).some(bindingIsUntracked)) markUntracked('node-scalar');
          }
          for (const e of n.effects ?? []) {
            for (const val of Object.values(e.boundVariables ?? {})) {
              if (aliasList(val).some(bindingIsUntracked)) markUntracked('effect');
            }
          }
          for (const c of n.children ?? []) scanModeContextScope(c);
        };
        scanModeContextScope(doc);

        // Tool boundary only: when mode evidence is incomplete, attach the exact warning that
        // prevents consumers from treating the diagnostic default as the rendered value.
        // Domain resolvers (resolveKeyInMode/resolveBoundVariableInMode) stay pure and never set this.
        const withModeHint = (t: ResolvedToken): ResolvedToken =>
          t.effective_mode_source === 'unverifiable'
            ? { ...t, hint: 'mode evidence incomplete - default_value is diagnostic only; do not use it as the rendered color' }
            : t;

        // Emit a ResolvedToken OBJECT iff the resolved value is mode-dependent; otherwise
        // return null so the legacy resolveToken (local name) / resolveSnapshot (var(--name, value)) /
        // raw-hex precedence renders it exactly as it did before. Also classifies EVERY binding
        // exit as tracked/untracked into modeCtxStats — an out-of-band observation only;
        // rendering behavior is byte-identical to the earlier version.
        const resolveTokenMode = (n: RawSceneNode, key: 'fills' | 'strokes'): ResolvedToken | null => {
          const aliasId = aliasIdFor(n, key);
          if (!aliasId) return null;
          const bv = { [key]: { type: 'VARIABLE_ALIAS' as const, id: aliasId } };
          // local (in-file): return the object ONLY when it's mode-dependent; single-mode local
          // stays null so the legacy resolveToken name path renders it inline.
          // Uses the exact-id stack — safe for local ids (no "/", never de-duped by library key).
          if (idx) {
            const local = resolveBoundVariableInMode(
              bv, key, idx, stackFor(n), coverageComplete, exactEvidenceFor(n), modeCtxStats,
            );
            if (local) return local.mode_dependent ? withModeHint(local) : null;   // resolved (tracked) → don't fall through
          }
          // cross-library: object ONLY when mode-dependent. pinned_axis_used is read
          // BEFORE the mode_dependent-gated discard and never copied onto the interned token.
          const libKey = extractLibraryKey(aliasId);
          const inMode = libKey ? deps.variableGraph?.resolveInMode?.(
            libKey, graphStackFor(n), coverageComplete, graphEvidenceFor(n),
          ) : undefined;
          if (inMode) {
            if (inMode.pinned_axis_used) modeCtxStats.pinnedAxisUsed = true;
            if (inMode.unconfirmed_default_used) modeCtxStats.unconfirmedDefaultUsed = true;
            if (inMode.mode_dependent) {
              const { pinned_axis_used: _pinned, unconfirmed_default_used: _unconfirmed, ...token } = inMode;
              return withModeHint(token);
            }
            return null;   // single-mode cross-lib, TRACKED → legacy resolveSnapshot (var(--name, value))
          }
          // Binding exists but no tracked resolver accounted for it (dangling local id, unsynced
          // key, idx unavailable, no graph): the rendered value is Figma's raw output, so no
          // mode_context claim is allowed for this response.
          modeCtxStats.untrackedBinding = true;
          return null;
        };

        const { node, globalVars } = simplify(doc, { resolveToken, resolveSnapshot, resolveTokenMode, truncatedChildCounts: boundaryChildCounts });

        // A component definition with no rendered children is not useful design context by itself.
        // Its root shape is authoritative only after simplify (which removes hidden children and
        // carries the boundary truncation signal); a best-effort bounded scan may then point to a
        // concrete INSTANCE without ever replacing the core response.
        let concreteInstances: DesignContext['concrete_instances'];
        let resolutionHints: DesignContext['resolution_hints'];
        const rootWasTruncated = (doc as RawSceneNode & { truncated?: boolean }).truncated === true;
        const isEmptyComponentDefinition = node.type === 'COMPONENT'
          && !node.truncated && !rootWasTruncated && !(node.children?.length);
        if (isEmptyComponentDefinition) {
          resolutionHints = {
            reason: 'definition_has_no_rendered_children',
            next_call: {
              tool: 'find_nodes',
              arguments: { file: parsed.value, query: node.name, type: 'INSTANCE', depth: 8, limit: 20 },
            },
          };
          const instanceApi = deps.buildApi(token, Math.max(1_000, Math.min(remaining(), 90_000)), deadlineAt);
          const discovered = await findComponentInstances(instanceApi, parsed.value, node.id, { deadlineAt });
          if (discovered.candidates.length) concreteInstances = discovered.candidates;
          if (!discovered.partial && discovered.candidates.length === 1) {
            resolutionHints = {
              reason: 'definition_has_no_rendered_children',
              next_call: {
                tool: 'get_design_context',
                arguments: { file: parsed.value, node_id: discovered.candidates[0].node_id, depth: args.depth },
              },
            };
          }
          if (discovered.partial) {
            deps.logger.info(
              { file_key_prefix: parsed.value.slice(0, 8), node_id: id, candidates: discovered.candidates.length },
              'design_context.component_instance_scan_degraded',
            );
          }
        }

        progress('component docs / code connect', 75);
        // Component-instance enrichment, shared by Code Connect snippets and component docs:
        // both need getComponent(key), so resolve each distinct key once. Best-effort — never
        // fails the tool (except rate_limited, which surfaces). Docs are on by default and work
        // in single-tenant too (decoupled from Code Connect).
        const wantDocs = args.include_component_docs !== false;
        let codeConnect: Record<string, CodeConnectSnippet> | undefined;
        let componentDocs: Record<string, ComponentDoc> | undefined;
        // Time gate: only skip a HOPELESS start (<3s). The real protection is the capped
        // enrichApi below — a started stage either finishes or degrades honestly at the deadline.
        // Prod acceptance showed a 10s gate needlessly dropping ~4s of docs work with 9.3s left.
        if ((deps.codeConnect || wantDocs) && remaining() < 3_000) {
          if (deps.codeConnect) stageDegraded('code_connect', 'time_budget');
          if (wantDocs) stageDegraded('component_docs', 'time_budget');
        } else if (deps.codeConnect || wantDocs) {
          // R5-F1: the 10s gate above is go/no-go only — the fetches themselves must be capped too,
          // or a slow (not failing) getComponent/getFileComponentSets runs up to the adapter's flat
          // FIGMA_TIMEOUT_MS (~90s) each, decoupled from this call's declared budget. All Figma
          // calls in this block go through a fresh instance capped at the remaining budget
          // (the DB-backed deps.codeConnect.lookup never touches Figma and stays uncapped).
          const enrichApi = deps.buildApi(token, Math.max(1_000, Math.min(remaining() - 2_000, 90_000)), deadlineAt);
          // R10-F1: CC resolution and docs resolution are INDEPENDENT stages once the shared prefix
          // below (pairs + the keyToMeta getComponent fan-out) completes — each gets its OWN
          // try/catch so a code_connect failure can never falsely mark component_docs degraded (or
          // vice versa), and a docs-eligible fetch still runs even when CC blew up first.
          try {
            const pairs = collectInstanceKeys(doc, entry.components);
            if (pairs.length) {
              const keyToMeta = new Map<string, PublishedComponentMeta>();
              // No concurrency cap: componentCache hits dominate after the first cold call,
              // and per-key rate_limited is surfaced. Add a limiter if Tier-3 429s appear in prod.
              // Per-key failures are swallowed here (skip that key) — the ONLY way this fan-out
              // itself throws is rate_limited or a capped-budget timeout abort, both rethrown below,
              // since every sibling fetch shares the same cap and continuing is pointless.
              await Promise.all([...new Set(pairs.map((p) => p.componentKey))].map(async (key) => {
                try {
                  keyToMeta.set(key, await enrichApi.getComponent(key));
                } catch (e) {
                  if (e instanceof FigmaApiError && e.kind === 'rate_limited') throw e;
                  if (isTimeoutAbort(e)) throw e;
                }
              }));

              if (deps.codeConnect) {
                try {
                  const keyToRef = new Map<string, { file_key: string; node_id: string }>(
                    [...keyToMeta].map(([k, m]) => [k, { file_key: m.file_key, node_id: m.node_id }]),
                  );
                  const refs = [...keyToRef.values()];
                  const mappingByRef = refs.length ? await deps.codeConnect.lookup(refs) : new Map();
                  const snippets = indexSnippetsByNodeId(pairs, keyToRef, mappingByRef);
                  if (Object.keys(snippets).length) codeConnect = snippets;
                } catch (err) {
                  if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
                  deps.logger.info({ err: (err as Error).message }, 'design_context.enrichment_unavailable');
                  stageDegraded('code_connect', isTimeoutAbort(err) ? 'time_budget' : 'error');
                }
              }

              if (wantDocs) {
                try {
                  // Component-SET descriptions: a variant's rich description + search tags live on
                  // its SET. componentSetId is on the per-node components ref (Figma's Component
                  // object), not on getComponent's meta. Resolve each set's description from its
                  // source library (cached), keyed by set node id.
                  const setFileKeys = new Set<string>();
                  for (const ref of Object.values(entry.components ?? {})) {
                    if (ref?.componentSetId && ref.key) {
                      const fk = keyToMeta.get(ref.key)?.file_key;
                      if (fk) setFileKeys.add(fk);
                    }
                  }
                  const setByNodeId = new Map<string, { name?: string; description?: string }>();
                  await Promise.all([...setFileKeys].map(async (fk) => {
                    for (const s of await enrichApi.getFileComponentSets(fk)) {
                      setByNodeId.set(s.node_id, { name: s.name, description: s.description });
                    }
                  }));
                  const docs = buildComponentDocs(entry.components, keyToMeta, setByNodeId);
                  if (Object.keys(docs).length) componentDocs = docs;
                } catch (err) {
                  if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
                  deps.logger.info({ err: (err as Error).message }, 'design_context.enrichment_unavailable');
                  stageDegraded('component_docs', isTimeoutAbort(err) ? 'time_budget' : 'error');
                }
              }
            }
          } catch (err) {
            // Shared-prefix failure: collectInstanceKeys is pure (never throws) and per-key
            // getComponent failures are swallowed above, so the ONLY realistic arrival here is the
            // fan-out's rate_limited/timeout rethrow — a genuine shared dependency both stages need,
            // so both degrade together (rate_limited itself always rethrows past this point).
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            deps.logger.info({ err: (err as Error).message }, 'design_context.enrichment_unavailable');
            const reason = isTimeoutAbort(err) ? 'time_budget' : 'error';
            if (deps.codeConnect) stageDegraded('code_connect', reason);
            if (wantDocs) stageDegraded('component_docs', reason);
          }
        }

        // Optional visual context: a short-lived signed PNG URL (never inline base64 — opt-in to keep responses lean).
        let screenshot: string | undefined;
        if (args.include_screenshot) {
          if (remaining() < 3_000) {
            stageDegraded('screenshot', 'time_budget');
          } else {
            // R5-F2: same as the docs/CC block — the gate is go/no-go only; cap the actual fetch
            // to the remaining budget so a slow getImages cannot run past the call's deadline.
            const shotApi = deps.buildApi(token, Math.max(1_000, Math.min(remaining() - 2_000, 90_000)), deadlineAt);
            try {
              const { images } = await shotApi.getImages(parsed.value, [id], { format: 'png', scale: args.screenshot_scale ?? 2 });
              if (images[id]) screenshot = images[id]!;
            } catch (err) {
              if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
              deps.logger.info({ err: (err as Error).message }, 'design_context.screenshot_unavailable');
              stageDegraded('screenshot', isTimeoutAbort(err) ? 'time_budget' : 'error');
            }
          }
        }

        // Measure == delivery (the "measure the delivered serialization" invariant): all 5 measurements below (sizeOf for fitToBudget
        // + 4 rungs of the shed-ladder) go through serializeForDelivery — the same function jsonResult
        // delivers with. The pretty measurement (×~2.2 on a dense tree) with compact delivery USED TO drop
        // responses in the (compact, pretty] window into a false depth-degrade / shed of screenshot-docs-globalVars,
        // even though they fit whole. There are no post-measurement additions: each return delivers EXACTLY
        // the measured object (context / noShot / noDocs / lean), so no stub reserve is needed.
        const budget = deps.maxResultChars ?? 40000;
        const sizeOf = (n: typeof node): number =>
          serializeForDelivery({ file: parsed.value, node: n, globalVars, ...(codeConnect ? { codeConnect } : {}), ...(componentDocs ? { components: componentDocs } : {}), ...(screenshot ? { screenshot } : {}), ...(concreteInstances ? { concrete_instances: concreteInstances } : {}), ...(resolutionHints ? { resolution_hints: resolutionHints } : {}), depth: 0, degraded: false }).length;

        const fit = fitToBudget(node, args.depth, budget, sizeOf, (out, count) => { out.childCount = count; });

        // Surface an accurate, top-level pointer whenever ANY node in the result was cut — either
        // by the depth-boundary signal (simplify's truncatedChildCounts) or by the auto-degrade size
        // fit above — so the consumer knows to request that node_id directly, raise depth, or use
        // get_metadata. The two causes need different advice (raising depth only helps the first),
        // so the wording covers both honestly instead of always blaming the depth limit.
        const hasTruncated = (n: SimplifiedNode): boolean =>
          !!n.truncated || (n.children?.some(hasTruncated) ?? false);
        const truncationHint = hasTruncated(fit.node)
          ? 'Some container nodes were cut (marked "truncated" with childCount) — their child layers and fills are NOT in this result. To see them, request that node_id directly or call get_metadata for the full structure. If `degraded` is true the result was also shrunk to fit the size budget (a higher depth will not help then); otherwise you may raise `depth` (max 8).'
          : undefined;

        // mode_context (spec): emitted ONLY on positive evidence — idx loaded, every binding
        // tracked, no pin consumed, no pin in the fetched scope. Absence claims nothing.
        let modeContext: 'library_default_modes' | 'default_modes' | undefined;
        // (C2): "no pins anywhere" is only positive knowledge under complete ancestor coverage; if
        // discovery was needed but failed, the resolvers' own hints already say "⚠️ mode-default"
        // — the marker must stay silent. When discovery wasn't wanted at all AND no pins are in
        // scope, there are no unpinned multi-mode bindings to begin with — trivially honest without
        // coverage.
        if (idx !== undefined && !modeCtxStats.pinnedAxisUsed && !modeCtxStats.untrackedBinding && !pinsInScope
            && (!ancestorDiscoveryWanted || coverageComplete) && !modeCtxStats.unconfirmedDefaultUsed) {
          const isLib = await (deps.libraryFiles?.has(parsed.value).catch(() => false) ?? Promise.resolve(false));
          modeContext = isLib ? 'library_default_modes' : 'default_modes';
        } else {
          // Observability: name every gate input so prod can tell WHICH conjunct silenced the
          // marker (mirrors design_context.ancestor_discovery's one-line-per-request style).
          deps.logger.info(
            { file_key_prefix: parsed.value.slice(0, 8), node_id: id,
              idx_ok: idx !== undefined, pinned_axis_used: modeCtxStats.pinnedAxisUsed,
              untracked_binding: modeCtxStats.untrackedBinding, untracked_kinds: modeCtxStats.untrackedKinds,
              pins_in_scope: pinsInScope,
              ancestor_discovery_wanted: ancestorDiscoveryWanted, coverage_complete: coverageComplete,
              unconfirmed_default_used: modeCtxStats.unconfirmedDefaultUsed },
            'design_context.mode_context_suppressed',
          );
        }

        progress('assembling response', 95);
        const context: DesignContext = {
          file: parsed.value, node: fit.node, globalVars,
          ...(codeConnect ? { codeConnect } : {}),
          ...(componentDocs ? { components: componentDocs } : {}),
          ...(screenshot ? { screenshot } : {}),
          ...(concreteInstances ? { concrete_instances: concreteInstances } : {}),
          ...(resolutionHints ? { resolution_hints: resolutionHints } : {}),
          depth: fit.depth, degraded: fit.degraded,
          ...(modeContext ? { mode_context: modeContext } : {}),
          ...(degradedStages.length ? { degraded_stages: degradedStages } : {}),
          ...(truncationHint ? { hint: truncationHint } : {}),
        };

        if (serializeForDelivery(context).length > budget) {
          // Shed enrichment in order of least value: screenshot → component docs → globalVars.
          // truncationHint carries the same top-level pointer as the primary `context` above — a
          // node can still be marked truncated:true after shedding enrichment, and without the hint
          // here the caller would lose the pointer to it.
          if (screenshot) {
            const noShot = { file: parsed.value, node: fit.node, globalVars, ...(codeConnect ? { codeConnect } : {}), ...(componentDocs ? { components: componentDocs } : {}), ...(concreteInstances ? { concrete_instances: concreteInstances } : {}), ...(resolutionHints ? { resolution_hints: resolutionHints } : {}), depth: fit.depth, degraded: true, ...(modeContext ? { mode_context: modeContext } : {}), ...(degradedStages.length ? { degraded_stages: degradedStages } : {}), ...(truncationHint ? { hint: truncationHint } : {}) };
            if (serializeForDelivery(noShot).length <= budget) return jsonResult(noShot);
          }
          if (componentDocs) {
            const noDocs = { file: parsed.value, node: fit.node, globalVars, ...(codeConnect ? { codeConnect } : {}), ...(concreteInstances ? { concrete_instances: concreteInstances } : {}), ...(resolutionHints ? { resolution_hints: resolutionHints } : {}), depth: fit.depth, degraded: true, ...(modeContext ? { mode_context: modeContext } : {}), ...(degradedStages.length ? { degraded_stages: degradedStages } : {}), ...(truncationHint ? { hint: truncationHint } : {}) };
            if (serializeForDelivery(noDocs).length <= budget) return jsonResult(noDocs);
          }
          const lean = { file: parsed.value, node: fit.node, depth: fit.depth, degraded: true, globalVars, ...(concreteInstances ? { concrete_instances: concreteInstances } : {}), ...(resolutionHints ? { resolution_hints: resolutionHints } : {}), ...(modeContext ? { mode_context: modeContext } : {}), ...(degradedStages.length ? { degraded_stages: degradedStages } : {}), ...(truncationHint ? { hint: truncationHint } : {}) };
          if (serializeForDelivery(lean).length <= budget) return jsonResult(lean);
          return jsonResult({ file: parsed.value, node: fit.node, depth: fit.depth, degraded: true,
            ...(concreteInstances ? { concrete_instances: concreteInstances } : {}),
            ...(resolutionHints ? { resolution_hints: resolutionHints } : {}),
            ...(degradedStages.length ? { degraded_stages: degradedStages } : {}),
            note: 'Result exceeded the size budget even at minimum depth; globalVars omitted — style refs (fill_0, text_0, …) are unresolved. Request a deeper child node directly for full detail.' });
        }
        return jsonResult(context);
      }, deps.noTokenHint),
  );
}
