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
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { simplify } from '../../../domain/design-context/simplify.js';
import { buildVariableIndex, resolveBoundVariable, resolveBoundVariableInMode, boundVariableId, type VariableIndex } from '../../../domain/variables.js';
import { collectSubtreeModes, collectSubtreeChains, buildModeByCollection, effectiveMode, type ModeStack } from '../../../domain/mode-resolve.js';
import { buildFileStructure, type RawDocumentNode, type FileStructure } from '../../../domain/file-structure.js';
import { extractLibraryKey } from '../../../domain/variable-snapshot.js';
import { FigmaApiError } from '../../../ports/errors.js';
import type { FigmaApi } from '../../../ports/figma-api.js';
import type { Logger } from '../../../infrastructure/logger.js';
import type { ResolvedToken } from '../../../domain/design-context/resolved-token.js';
import type { RawSceneNode, RawPaint, RawVariableAlias, PublishedComponentMeta } from '../../../domain/figma-raw.js';
import type { DesignContext, ComponentDoc, SimplifiedNode } from '../../../domain/design-context/types.js';
import { collectInstanceKeys, indexSnippetsByNodeId, buildComponentDocs, type CodeConnectSnippet } from '../../../domain/code-connect-enrich.js';
import { fitToBudget } from '../../../domain/design-context/auto-degrade.js';

// CSS var() name segment: escape chars that would prematurely close the function or
// be read as the fallback separator. Figma names are free-form (e.g. "button(default)").
const cssVarName = (n: string): string => n.replace(/[(),]/g, '\\$&');

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"')
    .describe('The node to extract design context for (a frame/component/instance)'),
  depth: z.number().int().min(1).max(8).default(4)
    .describe('Subtree depth to extract (default 4). When the result exceeds the size budget the server auto-reduces depth (down to 1) instead of refusing; check degraded/depth in the response.'),
  include_component_docs: z.boolean().default(true)
    .describe('Include human-authored component descriptions/documentation links as a deduped `components` map keyed by component id. Default true (cheap — reuses the Code Connect component fetch); set false to shrink output.'),
  include_screenshot: z.boolean().default(false)
    .describe('When true, also attach a short-lived signed PNG `screenshot` URL of the node for visual context (token-light — a URL string, never inline base64; default false to keep responses lean). Use get_screenshot for inline/SVG/scale control.'),
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
// Ancestor mode discovery reads each ancestor node's explicitVariableModes. The chain is found
// by fetching the document structure and walking parent links. If the request node is deeper
// than the fetch depth it is ABSENT from the tree → the chain is empty → a mode set on a page
// never applies → wrong on-screen color. We deepen the fetch until the node is present, BOUNDED
// by a depth cap AND a byte budget so we never risk pulling the ~110 MB worst-case whole file.

// Start shallow (matches getDocumentRaw's historical default) and deepen by doubling to the cap.
const ANCESTOR_START_DEPTH = 4;
const ANCESTOR_MAX_DEPTH = 8;
// Byte budget for the whole-file structure fetch. A large file's depth-4 document is a few MB;
// we allow deepening only while the fetched document stays under this budget, then STOP with an
// honest incomplete coverage rather than risk pulling the whole (~110 MB worst-case) file. The
// size is the serialized length of the fetched document (a proxy for the transferred bytes).
const ANCESTOR_BYTE_BUDGET = 24 * 1024 * 1024; // 24 MB

export interface AncestorDiscovery {
  /** collectionId -> modeId folded from the ancestor chain (nearest-wins, de-duped by lib key). */
  stack: ModeStack;
  /** The raw ancestor nodes above the request root, in root→parent order (each with its
   * explicitVariableModes). Exposed so the caller can lib-key-fold them together with the request
   * subtree chain into ONE nearest-wins-by-library-key stack for the graph resolver. */
  nodesRootToParent: RawSceneNode[];
  /** True iff the request node was located AND its chain reaches a top-level CANVAS (page). When
   * false, a mode set on an unfetched ancestor may still be missing → downstream must stay honest. */
  coverageComplete: boolean;
  /** Why discovery stopped short of locating the node (undefined when it wasn't stopped): the
   * existing depth_cap/byte_budget bounds, or time_budget (the per-call deadline could not fit
   * another whole-file fetch). The caller surfaces only time_budget in degraded_stages —
   * depth_cap/byte_budget stay log-only (pre-existing behavior). */
  droppedReason?: 'depth_cap' | 'byte_budget' | 'time_budget';
}

// The capped-api adapter (buildApi(token, capMs)) aborts an over-budget fetch INSIDE
// FigmaRestAdapter as FigmaApiError('network', 0, '… timed out …'). Discovery maps that (and only
// that) to a time_budget drop; every other rejection (notably rate_limited) propagates.
const isTimeoutAbort = (err: unknown): boolean =>
  err instanceof FigmaApiError && err.kind === 'network' && err.message.includes('timed out');

/**
 * Locate `nodeId`'s ancestor chain via a bounded, size-guarded document fetch and fold the
 * ancestor explicit modes into a ModeStack. `getDocumentRaw` is version-cached, so repeated
 * fetches within a file version are amortized. Deepens (4 -> 8) until the node is present or a
 * bound is hit; on a bound (depth cap or byte budget) it STOPS and reports coverageComplete=false,
 * logging what was dropped (no silent truncation).
 */
export async function discoverAncestorModes(
  api: Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'>,
  fileKey: string,
  nodeId: string,
  logger: Logger,
  cfg: { startDepth?: number; maxDepth?: number; byteBudget?: number; deadlineAt?: number;
    /** Build a fresh api capped at `capMs` (the tool passes deps.buildApi(token, capMs)). Each
     * iteration — and the trailing chain fetch — uses a fresh capped instance so a REAL abort
     * settles the ACTUAL promise: an over-budget fetch throws the adapter's timeout FigmaApiError
     * (mapped to droppedReason:'time_budget' — drop, coverageComplete:false), while a 429 arriving
     * before the cap rethrows as genuine rate_limited and propagates. Capped instances share the
     * same readCaches (single factory), and getDocumentRaw has no negative cache → no poisoning;
     * positive doc caching still applies. Absent (unit tests / no deadline) → the base `api`. */
    makeCappedApi?: (capMs: number) => Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'>;
    /** Latency (opt-in, compare-only): predict the NEXT fetch's size (`bytes * 2` — deepening
     * at minimum doubles the real tree) and stop BEFORE issuing it, instead of the reactive
     * `bytes >= byteBudget` (which only fires AFTER an over-budget fetch already returned — and is
     * blind to a cached depth-4 response returning near-instantly while the ACTUAL depth-8 fetch
     * would be tens of MB — a live 88s stream-abort measured on a large production page). The gdc (get_design_context) path keeps
     * the reactive-only check: ×2 is not a guaranteed bound on wide-shallow files. */
    predictiveByteGate?: boolean } = {},
): Promise<AncestorDiscovery> {
  const maxDepth = cfg.maxDepth ?? ANCESTOR_MAX_DEPTH;
  const byteBudget = cfg.byteBudget ?? ANCESTOR_BYTE_BUDGET;
  let depth = cfg.startDepth ?? ANCESTOR_START_DEPTH;

  let struct: FileStructure = { nodeById: new Map(), pageNameByNodeId: new Map(), childrenByNodeId: new Map() };
  let located = false;
  let droppedReason: 'depth_cap' | 'byte_budget' | 'time_budget' | undefined;
  let lastLatencyMs = 0;
  for (;;) {
    // Time budget: a whole-file fetch on a heavy file runs 60-90s; do not START one that
    // cannot plausibly fit (floor 15s, else 2x the previous fetch's latency).
    const need = Math.max(15_000, 2 * lastLatencyMs);
    if (cfg.deadlineAt !== undefined && Date.now() + need > cfg.deadlineAt) {
      droppedReason = 'time_budget';
      logger.info({ file_key_prefix: fileKey.slice(0, 8), node_id: nodeId, depth, need_ms: need, reason: 'time_budget' },
        'design_context.ancestor_coverage_dropped');
      break;
    }
    // The floor gate above only decides whether to START a fetch; the fetch itself must be bounded
    // too, or a slow-but-successful whole-file fetch (measured 63-90s) silently overruns the whole
    // call's deadline. Fetch through a fresh capped api (remaining budget, floored 1s, ceiled 90s —
    // R7-F2: an oversized deadline (e.g. a misconfigured multi-hour budget) must not hand
    // setTimeout a value past Node's ~2.1e9ms limit, which silently clamps to ~1ms and mislabels
    // every discovery 'time_budget' almost instantly) so an overrun aborts to time_budget via a
    // REAL settled rejection instead of hanging. (the cheap floor check stays the first gate.)
    const capMs = cfg.deadlineAt !== undefined ? Math.min(Math.max(1_000, cfg.deadlineAt - Date.now()), 90_000) : undefined;
    const fetchApi = capMs !== undefined && cfg.makeCappedApi !== undefined ? cfg.makeCappedApi(capMs) : api;
    const t0 = Date.now();
    let fileDoc: Awaited<ReturnType<typeof api.getDocumentRaw>>;
    try {
      fileDoc = await fetchApi.getDocumentRaw(fileKey, depth);                // cached by file version
    } catch (err) {
      if (isTimeoutAbort(err)) {
        droppedReason = 'time_budget';
        logger.info({ file_key_prefix: fileKey.slice(0, 8), node_id: nodeId, depth, cap_ms: capMs, reason: 'time_budget' },
          'design_context.ancestor_coverage_dropped');
        break;
      }
      throw err;                                                              // rate_limited & all else propagate
    }
    lastLatencyMs = Date.now() - t0;
    struct = buildFileStructure(fileDoc.document as unknown as RawDocumentNode);
    if (struct.nodeById.has(nodeId)) { located = true; break; }
    // Node not in this (bounded) tree. Stop if we cannot (depth cap) or should not (byte budget)
    // go deeper — the next, deeper fetch would only be larger. Degrade honestly, log the drop.
    if (depth >= maxDepth) {
      droppedReason = 'depth_cap';
      logger.info({ file_key_prefix: fileKey.slice(0, 8), node_id: nodeId, depth, reason: 'depth_cap' },
        'design_context.ancestor_coverage_dropped');
      break;
    }
    const bytes = JSON.stringify(fileDoc.document).length;
    // Latency (opt-in, compare only): a predictive gate — doubling depth at least doubles the
    // bytes on a real tree; the reactive `bytes >= byteBudget` caught the overshoot only AFTER the fetch,
    // and a latency need-gate is poisoned by the cache (depth-4 from cache in ~1s → "depth-8 will fit" → 88s
    // stream abort, live measurement on a large prod page). The gdc path stays reactive: ×2 is not a guaranteed
    // boundary on wide-shallow files.
    const byteStop = cfg.predictiveByteGate ? bytes * 2 >= byteBudget : bytes >= byteBudget;
    if (byteStop) {
      droppedReason = 'byte_budget';
      logger.info({ file_key_prefix: fileKey.slice(0, 8), node_id: nodeId, depth, bytes, budget: byteBudget,
        ...(cfg.predictiveByteGate ? { predicted_next_bytes: bytes * 2 } : {}), reason: 'byte_budget' },
        'design_context.ancestor_coverage_dropped');
      break;
    }
    depth = Math.min(depth * 2, maxDepth);
  }

  // Build the ancestor chain (root … parent(nodeId)) from parent links.
  const parentOf = new Map<string, string>();
  for (const [pid, kids] of struct.childrenByNodeId) for (const k of kids) parentOf.set(k, pid);
  const chainIds: string[] = [];
  for (let cur = parentOf.get(nodeId); cur; cur = parentOf.get(cur)) chainIds.unshift(cur);   // root … parent(id)

  // Coverage is complete only when the node was located AND its chain reaches a top-level CANVAS
  // (a document-root page) — i.e. we hold every ancestor that could carry an explicit mode.
  const reachesTopCanvas = chainIds.some((cid) => struct.nodeById.get(cid)?.type === 'CANVAS');
  const coverageComplete = located && reachesTopCanvas;

  // depth=1 (nodes only, no children): buildModeByCollection reads only each node's
  // .explicitVariableModes. depth=0 is below Figma's minimum and 400s the request.
  // Guard this trailing fetch too — a slow getNodesRaw after a successful locate would also
  // overrun the deadline. Unlike the loop, there is no next iteration to re-check the floor, so a
  // direct deadline-passed PRE-GATE below skips the fetch entirely when the deadline has already
  // elapsed (the capMs floor further down — `min(max(1_000, deadlineAt - now), 90_000)` — would
  // otherwise still schedule a 1s-capped fetch even past the deadline, an avoidable call that also
  // queues on the shared heavy-fetch semaphore). A timeout during the fetch itself still degrades
  // honestly (empty stack/ancestors, coverageComplete=false, droppedReason=time_budget) rather than
  // block.
  let anc: Awaited<ReturnType<typeof api.getNodesRaw>>;
  if (chainIds.length) {
    if (cfg.deadlineAt !== undefined && Date.now() >= cfg.deadlineAt) {
      logger.info({ file_key_prefix: fileKey.slice(0, 8), node_id: nodeId, depth, reason: 'time_budget', stage: 'ancestor_chain' },
        'design_context.ancestor_coverage_dropped');
      return { stack: new Map(), nodesRootToParent: [], coverageComplete: false, droppedReason: 'time_budget' };
    }
    // R7-F2: same upper clamp as the loop fetch above — see that comment for why (Node's setTimeout
    // silently mis-fires past ~2.1e9ms, which an oversized deadline could otherwise reach).
    const capMs = cfg.deadlineAt !== undefined ? Math.min(Math.max(1_000, cfg.deadlineAt - Date.now()), 90_000) : undefined;
    const chainApi = capMs !== undefined && cfg.makeCappedApi !== undefined ? cfg.makeCappedApi(capMs) : api;
    try {
      anc = await chainApi.getNodesRaw(fileKey, chainIds, 1);
    } catch (err) {
      if (isTimeoutAbort(err)) {
        logger.info({ file_key_prefix: fileKey.slice(0, 8), node_id: nodeId, depth, cap_ms: capMs, reason: 'time_budget', stage: 'ancestor_chain' },
          'design_context.ancestor_coverage_dropped');
        return { stack: new Map(), nodesRootToParent: [], coverageComplete: false, droppedReason: 'time_budget' };
      }
      throw err;                                                              // rate_limited & all else propagate
    }
  } else {
    anc = { nodes: {} };
  }
  const rootToParent = chainIds.map((cid) => anc.nodes[cid]?.document).filter((n): n is RawSceneNode => !!n);
  // Observability: one line per discovery so prod can measure how often the deepest (maxDepth)
  // whole-file fetch actually fires and whether it yields complete coverage. `depth_reached ===
  // <maxDepth>` counts the expensive path; `at_max_depth` flags it directly.
  logger.info(
    { file_key_prefix: fileKey.slice(0, 8), node_id: nodeId, depth_reached: depth, at_max_depth: depth >= maxDepth,
      located, reaches_top_canvas: reachesTopCanvas, coverage_complete: coverageComplete, chain_len: chainIds.length },
    'design_context.ancestor_discovery',
  );
  return { stack: buildModeByCollection(rootToParent), nodesRootToParent: rootToParent, coverageComplete,
    ...(droppedReason ? { droppedReason } : {}) };
}

export function registerGetDesignContextTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_design_context',
    {
      description: 'Extract a descriptive, code-oriented representation of a Figma node: layout (auto-layout), sizing, fills/strokes/effects (deduplicated into globalVars), text + typography, and component instances. A fill/stroke bound to a variable in a multi-mode collection (>1 mode) is resolved to an object in globalVars: { token, value (actual hex in the node\'s effective variable mode), mode, mode_dependent, mode_source }. mode_source:\'node\' means the node\'s mode was confirmed via explicitVariableModes; \'default\' means the mode could not be determined and the default-mode value is shown — do not treat it as the on-screen color, and such an object also carries a short `hint` pointing you to get_variables\' per-mode `modes` map for the actual value. When the value was decided by modes across MORE THAN ONE multi-mode collection (a cross-collection alias chain), the object also carries modes_applied — {collection name: "mode name (node|default)"} — every axis actually APPLIED to compute value: (node) = that axis was pinned via explicitVariableModes on the node or an ancestor; (default) = that collection\'s default mode was used. modes_applied explains the computation only — it makes NO on-screen claim (that is mode_source\'s job, for the composite). A top-level mode_context marker may be present: "library_default_modes" = this file is a registered component library rendered in its default variable modes — do NOT transfer these mode-dependent values to branded pages (the same tokens resolve differently there); "default_modes" = every shown mode-dependent value is its axis default. The marker appears only when the server has positive evidence (all bindings tracked, no pinned axes anywhere); its absence claims nothing. Mode and collection names are verbatim Figma names; casing can differ between collections. A fill/stroke bound to a single-mode (non-mode-dependent) variable keeps its inline form: the local token name, or var(--name, value) for a cross-library variable. Human-authored component descriptions/documentation are returned as a deduped `components` map keyed by component id (disable with include_component_docs:false). Set include_screenshot:true to also attach a short-lived signed PNG URL for visual context. Container nodes whose children were cut — by the requested depth, or by the size-budget auto-degrade when `degraded` is true — are marked `truncated:true` with `childCount`; request that node_id directly, raise `depth` (max 8, no effect when `degraded` is true), or use get_metadata to see them. The call runs under a server time budget: enrichment stages (variables resolution, ancestor-mode discovery, component docs, Code Connect, screenshot) that do not fit are skipped and listed in degraded_stages [{stage, reason}] — the core subtree is never time-degraded (the size budget\'s `degraded` flag is separate). If the subtree fetch itself exceeds the budget the call fails fast and suggests a lower depth. Use get_metadata first to pick a node_id.',
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
        const id = normalizeNodeId(args.node_id);

        // Time budget (spec): deadline for the WHOLE call. Enrichment stages check remaining()
        // and skip honestly into degraded_stages; every skip lands on an EXISTING honesty path
        // (no idx -> honest labels; coverageComplete=false -> honest 'default').
        const deadlineAt = Date.now() + (deps.toolTimeBudgetMs ?? 90_000);
        const remaining = () => deadlineAt - Date.now();
        type DegradedStage = NonNullable<DesignContext['degraded_stages']>[number];
        const degradedStages: DegradedStage[] = [];
        const stageDegraded = (stage: DegradedStage['stage'], reason: DegradedStage['reason']): void => {
          degradedStages.push({ stage, reason });
          deps.logger.info({ stage, reason, remaining_ms: remaining() }, 'design_context.stage_degraded');
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
        const doc = entry.document;
        progress('subtree fetched', 20);

        // We fetched args.depth + 1 so we can tell a depth-cut container (children exist one level
        // below the requested depth) from a genuinely empty one. Use that extra level ONLY to count
        // cut children, then prune it away immediately so EVERY downstream consumer — needsAncestors,
        // collectExternalAliasIds, collectSubtreeModes/Chains, and simplify — sees exactly the
        // requested depth, byte-identical to a plain depth-N fetch. This keeps mode resolution and
        // ancestor-discovery gating unaffected by a node that is never rendered in the result.
        const boundaryChildCounts = new Map<string, number>();
        const pruneToRequestedDepth = (n: RawSceneNode, depth: number): void => {
          if (depth >= args.depth) {
            const visibleKids = (n.children ?? []).filter((c) => c.visible !== false);
            if (visibleKids.length) boundaryChildCounts.set(n.id, visibleKids.length);
            if (n.children) delete (n as { children?: unknown }).children;
            return;
          }
          for (const c of n.children ?? []) pruneToRequestedDepth(c, depth + 1);
        };
        pruneToRequestedDepth(doc, 0);

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
        let ancestorStack: ModeStack = new Map();
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
                // any ancestor mode, so a depth-8 whole-file fetch for it is pure waste.
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
            // Bounded, size-guarded ancestor discovery: deepens the whole-file fetch (4 -> 8) only
            // until the request node is present or a depth/byte/time bound is hit, then degrades
            // honestly (coverageComplete=false -> resolvers stay at honest 'default').
            // The leading positional `api` arg is discoverAncestorModes' no-deadline fallback,
            // exercised directly by its own unit tests; THIS call always passes both `deadlineAt`
            // and `makeCappedApi` below, so every fetch inside always resolves through the fresh
            // capped instance and the fallback branch is structurally unreachable here. Passing the
            // already-built `coreApi` (rather than constructing a separate, genuinely unused plain
            // instance) avoids an extra dead buildApi call purely to satisfy the required parameter.
            const disc = await discoverAncestorModes(coreApi, parsed.value, id, deps.logger, { deadlineAt, makeCappedApi: (capMs) => deps.buildApi(token, capMs, deadlineAt) });
            ancestorStack = disc.stack;
            ancestorNodesRootToParent = disc.nodesRootToParent;
            coverageComplete = disc.coverageComplete;
            // depth_cap/byte_budget stay log-only (pre-existing behavior); only the time budget
            // surfaces as a degraded stage — it is this call's budget, not the file's shape.
            if (disc.droppedReason === 'time_budget') stageDegraded('ancestor_discovery', 'time_budget');
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
        const stackFor = (n: RawSceneNode): ModeStack => new Map([...ancestorStack, ...nodeStack(n.id)]);

        // Effective stack for the GRAPH resolver, which matches a collection by LIBRARY KEY and, on
        // that lib-key fallback, returns the FIRST map-order entry. A plain merge of two flattened
        // maps (stackFor) lets two subscribed-instance suffixes of the SAME library collection BOTH
        // survive — from an above-root ancestor AND a nearer subtree node, or from two subtree levels
        // — and the FARTHER one, sitting first in map order, would win the lib-key scan → wrong hex.
        // Fix: lib-key-fold the FULL ordered chain (root … request-root … node) so at most ONE entry
        // per library key survives — the NEAREST node's — and it sits first in map order.
        // buildModeByCollection walks its argument NEAREST→farthest (end→start), so we pass the chain
        // in root→node order: [above-root ancestors (root→parent), request-root … node].
        const subtreeChains = collectSubtreeChains(doc);   // nodeId -> [request-root … node]
        const graphStackFor = (n: RawSceneNode): ModeStack =>
          buildModeByCollection([...ancestorNodesRootToParent, ...(subtreeChains.get(n.id) ?? [n])]);

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

        // Tool boundary only: when a mode-dependent token could not be confirmed
        // against the on-screen node (mode_source:'default'), attach a terse pointer so the
        // consuming agent knows get_variables' per-mode `modes` map is the trustworthy fallback.
        // 'node' (confirmed) gets no hint — keep the size budget for the case that needs it.
        // Domain resolvers (resolveKeyInMode/resolveBoundVariableInMode) stay pure and never set this.
        const withModeHint = (t: ResolvedToken): ResolvedToken =>
          t.mode_dependent && t.mode_source === 'default'
            ? { ...t, hint: "⚠️ mode-default — do not port the hex; see get_variables 'modes' for the per-mode value" }
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
            const local = resolveBoundVariableInMode(bv, key, idx, stackFor(n), coverageComplete, modeCtxStats);
            if (local) return local.mode_dependent ? withModeHint(local) : null;   // resolved (tracked) → don't fall through
          }
          // cross-library: object ONLY when mode-dependent. pinned_axis_used is read
          // BEFORE the mode_dependent-gated discard and never copied onto the interned token.
          const libKey = extractLibraryKey(aliasId);
          const inMode = libKey ? deps.variableGraph?.resolveInMode?.(libKey, graphStackFor(n), coverageComplete) : undefined;
          if (inMode) {
            if (inMode.pinned_axis_used) modeCtxStats.pinnedAxisUsed = true;
            if (inMode.unconfirmed_default_used) modeCtxStats.unconfirmedDefaultUsed = true;
            if (inMode.mode_dependent) {
              return withModeHint({ token: inMode.token, value: inMode.value, mode: inMode.mode, mode_dependent: true, mode_source: inMode.mode_source,
                ...(inMode.modes_applied ? { modes_applied: inMode.modes_applied } : {}) });
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
          serializeForDelivery({ file: parsed.value, node: n, globalVars, ...(codeConnect ? { codeConnect } : {}), ...(componentDocs ? { components: componentDocs } : {}), ...(screenshot ? { screenshot } : {}), depth: 0, degraded: false }).length;

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
            const noShot = { file: parsed.value, node: fit.node, globalVars, ...(codeConnect ? { codeConnect } : {}), ...(componentDocs ? { components: componentDocs } : {}), depth: fit.depth, degraded: true, ...(modeContext ? { mode_context: modeContext } : {}), ...(degradedStages.length ? { degraded_stages: degradedStages } : {}), ...(truncationHint ? { hint: truncationHint } : {}) };
            if (serializeForDelivery(noShot).length <= budget) return jsonResult(noShot);
          }
          if (componentDocs) {
            const noDocs = { file: parsed.value, node: fit.node, globalVars, ...(codeConnect ? { codeConnect } : {}), depth: fit.depth, degraded: true, ...(modeContext ? { mode_context: modeContext } : {}), ...(degradedStages.length ? { degraded_stages: degradedStages } : {}), ...(truncationHint ? { hint: truncationHint } : {}) };
            if (serializeForDelivery(noDocs).length <= budget) return jsonResult(noDocs);
          }
          const lean = { file: parsed.value, node: fit.node, depth: fit.depth, degraded: true, globalVars, ...(modeContext ? { mode_context: modeContext } : {}), ...(degradedStages.length ? { degraded_stages: degradedStages } : {}), ...(truncationHint ? { hint: truncationHint } : {}) };
          if (serializeForDelivery(lean).length <= budget) return jsonResult(lean);
          return jsonResult({ file: parsed.value, node: fit.node, depth: fit.depth, degraded: true,
            ...(degradedStages.length ? { degraded_stages: degradedStages } : {}),
            note: 'Result exceeded the size budget even at minimum depth; globalVars omitted — style refs (fill_0, text_0, …) are unresolved. Request a deeper child node directly for full detail.' });
        }
        return jsonResult(context);
      }, deps.noTokenHint),
  );
}
