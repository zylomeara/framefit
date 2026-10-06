import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, textResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, normalizeScopedResponseRoot, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { buildLayoutSpec, budgetFor, collectLeafTexts } from '../../../domain/layout-spec/projector.js';
import { buildHydrationReceipt, type HydrationReceipt } from '../../../domain/layout-spec/frame-receipt.js';
import { buildVariableIndex, type VariableIndex } from '../../../domain/variables.js';
import { collectSubtreeChains, hasBoundPaintColor, hasExternalBoundPaintColor, buildExactModeEvidence, buildGraphModeEvidence, modeIds, sceneIdEquals } from '../../../domain/mode-resolve.js';
import { discoverAncestorModesBatch, type AncestorDiscovery, type AncestorDiscoveryReason } from './get-design-context-tool.js';
import { makeColorTokenResolver, prefetchSnapshotHits, VARIABLES_FETCH_CAP_MS } from './color-token-resolver.js';
import { FigmaApiError } from '../../../ports/errors.js';
import type { RawSceneNode } from '../../../domain/figma-raw.js';
import { DOM_SNAPSHOT_SCHEMA_VERSION } from './dom-snapshot-schema.js';
import { EXTRACTOR_JS, buildExtractorLoader } from './dom-extractor.js';
import { buildSetNames } from './component-set-names.js';
import { clampToBudget, responseTooLargeResult, RESULT_BUDGET_BYTES } from './response-budget.js';
import { serializeForDelivery } from './serialize.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_ids: z.array(z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42" or nested "I…;…"')).min(1).max(20)
    .describe('Node ids to project into diff-ready layout specs, up to 20 per call (batched in one REST call).'),
  include_extractor: z.boolean().default(false)
    .describe('Include the canonical DOM extractor script (paste it VERBATIM into chrome-devtools evaluate_script).'),
  extractor_mode: z.enum(['loader', 'inline']).default('loader')
    // No size digits here on purpose: a tools/list description is cached by the client, cannot be
    // corrected in the field, and nothing the caller DOES depends on the exact count - "the whole
    // script" already carries the only decision it informs (loader small, inline large). A digit
    // here would have to be gated forever; see extractor-size-lock.test.ts for where the real
    // numbers are stated and checked.
    .describe('loader (default): a short thunk that fetches the versioned extractor from the server ' +
      '(GET /api/dom-snapshots/extractor.js) instead of inlining the whole script ' +
      'every call - falls back to inline automatically if the server has no public base URL configured, ' +
      'including a stdio process whose loopback browser bridge could not start. inline: always return the full extractor script (e.g. if the ' +
      'loader\'s script-tag injection is CSP-blocked).'),
  max_depth: z.number().int().min(1).max(8).optional()
    .describe('Capture depth for BOTH sides (Figma projection + emitted extractor); default 4. Drill into a ' +
      'childrenTruncated branch by re-fetching it deeper (e.g. max_depth:6) - pass the SAME max_depth to ' +
      'compare_node_to_dom for that pair, or the Figma/DOM sides desync.'),
  text_leaves: z.boolean().default(false)
    .describe('Instead of the full spec tree, return a flat list of leaf TEXT nodes ' +
      '(id/name/path/text_snippet/typography) under each node_id - one call to enumerate typography ' +
      'for pair-building/inspection, no manual frame->children->text drill. Respects max_depth; ' +
      'text_leaves_truncated flags leaves beyond the depth cut (raise max_depth to reach them).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetLayoutSpecTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_layout_spec',
    {
      description: 'Diff-ready layout spec of nodes: rect, auto-layout axis/gap/padding, in-flow children geometry, ' +
      'typography, fill hex, component identity. A shallow node fetch, plus one cached ancestor lookup when a color is ' +
      'bound to a variable - use it to pick the target frame width ' +
      'and build node<->selector pairs before compare_node_to_dom. include_extractor:true returns the DOM extractor ' +
      '(schema-versioned with the server) as extractor_js: the loader thunk that fetches the canonical script ' +
      '(extractor_mode:"loader", the default) is returned only when the server has a public base URL to point the ' +
      'browser at - otherwise, and whenever extractor_mode:"inline" is passed, the full script comes back inline, ' +
      'with extractor_note saying so when the loader was asked for and was unavailable. That same public base URL ' +
      'and snapshot store are available on HTTP deployments and through stdio\'s loopback browser sidecar; they return ' +
      'an upload_url the extractor can POST snapshots to directly from the browser, yielding a dom_ref for ' +
      'compare_node_to_dom. If the stdio sidecar cannot start, the response fails soft to the inline extractor and ' +
      'inline DOM snapshots, with a machine-readable browser_bridge receipt.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('get_layout_spec', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const ids = args.node_ids.map(normalizeCompoundNodeId);
        const api = deps.buildApi(token);

        const maxDepth = args.max_depth;
        const reqDepth = maxDepth ?? 4;
        // Frame hydration: hold the deepest raw per id-set, re-slice ≤ heldDepth for free (bypasses
        // nodeCache). effectiveMaxDepth == reqDepth unless a deep-fetch abort clamped it (backoff).
        const frameRes = await api.getFrameRaw(parsed.value, ids, reqDepth);
        const res = frameRes.raw;
        const coreVersion = typeof res.version === 'string' && res.version.length > 0 ? res.version : undefined;
        // Ancestors are attached to these roots below, so a response root that is not the requested
        // node is refused here rather than projected under the requested id.
        const roots = ids.map((id) => normalizeScopedResponseRoot(res.nodes[id]?.document, id));
        const effDepth = frameRes.effectiveMaxDepth;
        const hydration: Array<HydrationReceipt | undefined> = new Array(ids.length);

        // Mode-aware token names for bound colors — the SAME resolver compare_node_to_dom uses
        // (color-token-resolver.ts), with three deliberate differences on this hot navigation path:
        // (1) demand gate first — a batch that binds no colour pays nothing at all;
        // (2) the variables fetch is ALWAYS capped (compare caps MT-only): a bounded miss with a
        //     degraded_stages receipt beats a measured ~90s stall, and the caller still has
        //     fillBoundVar + this receipt to tell "not bound" from "bound, fetch degraded";
        // (3) pins above the fetched subtree come from compare's targeted ancestor projection: one
        //     batch per call (4 -> 8 -> 16, version-pinned, one deadline), only for nodes whose colour
        //     a resolver can actually use; an unproven chain stays 'unverifiable' with a receipt.
        const degradedStages: Array<
          | { stage: 'variables'; reason: 'error'; ms: number; detail: string }
          | { stage: 'ancestor_discovery'; reason: AncestorDiscoveryReason; ms: number; node_ids: string[] }
        > = [];
        let variableIndex: VariableIndex | undefined;
        let snapHits: Map<string, { value: unknown; name?: string }> | undefined;
        const anyBindsColor = roots.some((doc) => doc !== undefined && hasBoundPaintColor(doc));
        if (anyBindsColor) {
          await deps.variableGraph?.ensureReady?.();
          const variablesStartedAt = Date.now();
          try {
            variableIndex = buildVariableIndex(await deps.buildApi(token, VARIABLES_FETCH_CAP_MS).getVariablesLocal(parsed.value));
          } catch (err) {
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            deps.logger.info({ err: (err as Error).message }, 'layout_spec.variables_unavailable');
            degradedStages.push({ stage: 'variables', reason: 'error', ms: Date.now() - variablesStartedAt,
              detail: (err as Error).message });
          }
          try {
            snapHits = await prefetchSnapshotHits(deps, variableIndex, roots);
          } catch (err) {
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            deps.logger.info({ err: (err as Error).message }, 'layout_spec.snapshot_prefetch_unavailable');
          }
        }

        // Same demand gate as compare: the local index needs any bound colour, the index-less
        // graph/snapshot fallback can only use an external (published-key) one.
        const graphOrSnapshotAvailable = deps.variableGraph !== undefined || deps.variableSnapshot !== undefined;
        const modeIdsNeeded = ids.filter((_, i) => {
          const doc = roots[i];
          return doc !== undefined && ((variableIndex !== undefined && hasBoundPaintColor(doc))
            || (variableIndex === undefined && graphOrSnapshotAvailable && hasExternalBoundPaintColor(doc)));
        });
        let ancestry = new Map<string, AncestorDiscovery>();
        if (modeIdsNeeded.length > 0) {
          const startedAt = Date.now();
          const deadlineAt = startedAt + (deps.toolTimeBudgetMs ?? 90_000);
          ancestry = await discoverAncestorModesBatch(api, parsed.value, modeIdsNeeded, coreVersion, deps.logger,
            { deadlineAt, makeCappedApi: (capMs) => deps.buildApi(token, capMs, deadlineAt) });
          const ms = Date.now() - startedAt;
          const failed = new Map<AncestorDiscoveryReason, string[]>();
          for (const [id, found] of ancestry) {
            if (found.coverageComplete || !found.reason) continue;
            failed.set(found.reason, [...(failed.get(found.reason) ?? []), id]);
          }
          for (const [reason, node_ids] of failed) degradedStages.push({ stage: 'ancestor_discovery', reason, ms, node_ids });
        }
        const ancestryFor = (id: string): AncestorDiscovery | undefined =>
          [...ancestry].find(([key]) => sceneIdEquals(key, id))?.[1];

        const specs = await Promise.all(ids.map(async (id, index) => {
          const found = res.nodes[id];
          if (!found?.document) return { node_id: id, error: 'not found' };
          const root = roots[index];
          if (!root) return { node_id: id, error: 'malformed scoped root' };
          const entry = { ...found, document: root };
          const setNames = await buildSetNames(api, entry, deps.logger);
          const subtreeChains = collectSubtreeChains(entry.document);
          const discovered = ancestryFor(id);
          const ancestorNodes = discovered?.nodesRootToParent ?? [];
          const fullChainFor = (n: RawSceneNode): RawSceneNode[] => [...ancestorNodes, ...(subtreeChains.get(n.id) ?? [n])];
          const resolveColorToken = makeColorTokenResolver({
            variableIndex, snapHits, variableGraph: deps.variableGraph,
            stackFor: (n: RawSceneNode) => modeIds(buildExactModeEvidence(fullChainFor(n), n.id)),
            graphStackFor: (n: RawSceneNode) => modeIds(buildGraphModeEvidence(fullChainFor(n), n.id)),
            exactEvidenceFor: (n: RawSceneNode) => buildExactModeEvidence(fullChainFor(n), n.id),
            graphEvidenceFor: (n: RawSceneNode) => buildGraphModeEvidence(fullChainFor(n), n.id),
            coverageComplete: discovered?.coverageComplete ?? false,
            omitAllModes: true,        // all_modes is compare's confirm payload, not navigation data
          });
          const built = buildLayoutSpec(entry.document, { components: entry.components, setNames, resolveColorToken, styleNames: (sid: string) => entry.styles?.[sid]?.name }, { maxDepth: effDepth });
          if (args.text_leaves) {
            const { leaves, truncated } = collectLeafTexts(built);
            return { node_id: id, text_leaves: leaves, ...(truncated ? { text_leaves_truncated: true } : {}) };
          }
          hydration[index] = buildHydrationReceipt(id, built, frameRes);
          return { node_id: id, spec: built };
        }));

        // (a') mint-meta: every successful node's rect.w (rounded, deduped)
        // — the widths a browser upload against this capToken is EXPECTED to match. Drives the
        // upload route's honest viewport_warning (dom-snapshot-routes.ts handleUpload) when the
        // browser's innerWidth is a guaranteed reflow vs all of them. Error/text_leaves entries carry
        // no `.spec` and don't contribute; an all-error batch yields widths:[] → meta stays undefined
        // (no hint to give, not an empty-array hint).
        const widths = [...new Set(specs.flatMap((r) => r.spec?.rect ? [Math.round(r.spec.rect.w)] : []))];

        // Multi-use upload_url: minted only when the caller asked for the extractor AND the
        // server is wired for the browser-direct upload flow (snapshotStore + a public base URL
        // to point the browser at). Absent either, the tool falls back to its prior output
        // unchanged — no field, no mint() call. On stdio this is the fail-soft branch when the
        // loopback browser bridge could not start.
        const uploadUrl = args.include_extractor && deps.snapshotStore && deps.publicBaseUrl
          ? `${deps.publicBaseUrl}/api/dom-snapshots/${deps.snapshotStore.mint(deps.tenantId ?? 'local', widths.length ? { expectedWidths: widths } : undefined)}`
          : undefined;

        // extractor_mode: 'loader' (default; ?? here mirrors the zod .default('loader') for direct
        // handler invocations that bypass MCP SDK schema parsing, e.g. unit tests) only actually
        // loads when the server has a public base URL to point the browser at (GET
        // /api/dom-snapshots/extractor.js, see dom-snapshot-routes.ts) — without one there's nothing
        // to fetch, so it silently falls back to the full inline script and says so via extractor_note
        // (honest-degrade, not a silent behavior change the caller has to notice on their own).
        // extractor_mode:'inline' always gets the full script, no note (that's what the caller
        // explicitly asked for, not a fallback).
        const extractorMode = args.extractor_mode ?? 'loader';
        const useLoader = extractorMode === 'loader' && !!deps.publicBaseUrl;
        const extractorFields = args.include_extractor
          ? useLoader
            ? { extractor_js: buildExtractorLoader(deps.publicBaseUrl!) }
            : {
                extractor_js: EXTRACTOR_JS,
                ...(extractorMode === 'loader'
                  ? { extractor_note: 'loader unavailable without public base URL — inline returned' }
                  : {}),
              }
          : {};

        // When max_depth was explicitly given, show the 4-arg extractor call (depthLeft, budget)
        // so the pasted-VERBATIM upload_hint actually drills as deep as the caller asked — without
        // this the extractor would silently run at its 2-arg defaults (depthLeft=3, budget=90) even
        // though get_layout_spec's OWN projection just went deeper. Absent max_depth, the hint stays
        // the prior 2-arg call, byte-for-byte (backward-compat).
        const depthArgsSuffix = maxDepth !== undefined ? `, ${effDepth - 1}, ${budgetFor(effDepth)}` : '';
        // Same depth/budget arguments for the no-upload_url call form, which has no uploadUrl to pass:
        // depthLeft/budget are positional args 3 and 4, so slot 2 needs an explicit `undefined`.
        const stdioDepthArgs = depthArgsSuffix && `, undefined${depthArgsSuffix}`;
        const serialize = (kept: typeof specs) => {
          const omitted = specs.slice(kept.length).map((entry) => entry.node_id);
          const keptHydration = hydration.slice(0, kept.length).filter(
            (receipt): receipt is HydrationReceipt => receipt !== undefined,
          );
          return serializeForDelivery({
            file: parsed.value,
            snapshot_schema: DOM_SNAPSHOT_SCHEMA_VERSION,
            specs: kept,
            // Same shape as compare/get_design_context: without this an absent fillToken is
            // ambiguous between "bound but the variables fetch degraded" and "bound but no
            // resolver can name it" — fillBoundVar alone cannot tell those apart.
            ...(degradedStages.length ? { degraded_stages: degradedStages } : {}),
            ...(omitted.length ? { result_truncated: true, omitted_node_ids: omitted,
              result_truncated_note: 'result exceeded the budget — re-request the omitted node_ids in a separate get_layout_spec call (fewer node_ids at a time) or lower max_depth' } : {}),
            ...(keptHydration.length ? { hydration: keptHydration } : {}),
            ...extractorFields,
            ...(args.include_extractor && deps.browserBridgeDegraded
              ? { browser_bridge: deps.browserBridgeDegraded }
              : {}),
            // The call form for the branch with NO upload_url — this fires on `!uploadUrl`, which is
            // a degraded stdio server (no snapshot store, no public base URL) and equally any server that
            // has a public base URL but no snapshot store: uploadUrl needs BOTH, the loader needs only
            // the base URL, so that server would hand back a loader thunk AND this hint. No shipped
            // wiring builds one — but the guard is `!uploadUrl`, and the hint is true of any branch it
            // fires on: without an upload_url the snapshots come back to the caller either way.
            // The guidance used to live only in upload_hint, so a caller on any degraded/no-endpoint
            // path got the full inline extractor and no instructions at all; the
            // usual guess is then to re-paste it per capture and re-request it per call, which costs a
            // cycle roughly 3x what it needs to.
            //
            // THE PASTE-ONCE FORM IS A THUNK, NOT AN ASSIGNMENT. chrome-devtools evaluate_script
            // evaluates `(<what you sent>)` and then CALLS it with no arguments, so a bare
            // `window.__extract = <script>;` does not even parse (the trailing `;` closes nothing) and
            // the same text without the `;` parses as a function expression that is then invoked with
            // no selectors — a TypeError inside the extractor. Wrapping the assignment in a thunk that
            // returns is the only shape that survives both steps.
            ...(args.include_extractor && !uploadUrl ? { extractor_hint:
              'no upload_url on this server: the extractor hands the snapshots back to you. Paste ' +
              'extractor_js ONCE inside a thunk: `() => { window.__extract = <extractor_js VERBATIM>; ' +
              "return 'ok'; }` (evaluate_script CALLS what you send with no arguments, so a bare " +
              'assignment throws) — then every capture is ' +
              `\`async () => await window.__extract(["<sel>", …]${stdioDepthArgs})\` (a reload drops the ` +
              'handle — paste again). Pass include_extractor:false on every later get_layout_spec call. ' +
              'Hand each snapshot inline to the matching compare_node_to_dom pairs[i].dom.' } : {}),
            ...(uploadUrl ? { upload_url: uploadUrl, upload_hint:
              `call the extractor as: async () => { const extract = <extractor_js VERBATIM>; return await extract(["<sel>", …], "<upload_url>"${depthArgsSuffix}); } ` +
              '— extractor_js decides for itself whether to load the canonical script from the server (loader) or is already the full script (inline); ' +
              'it returns {snapshot_ref, summaries}; pass pairs to compare_node_to_dom as dom_ref:{ref, index} (selector position, 0-based, disambiguates duplicates) or {ref, selector}' +
              '; a batch >2MB — split it into several POSTs under the same upload_url (the limit is per-POST, not per-session)' } : {}),
          });
        };
        const result = clampToBudget(
          specs,
          RESULT_BUDGET_BYTES,
          serialize,
          (text) => Buffer.byteLength(text, 'utf8'),
        );
        if (result.kind === 'first_item_oversize' || result.kind === 'envelope_oversize') {
          return responseTooLargeResult(result.kind);
        }
        return textResult(result.serialized);
      }, deps.noTokenHint),
  );
}
