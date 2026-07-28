import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { buildLayoutSpec, collectLeafTexts, VIEW_CAPS, type ViewCaps } from '../../../domain/layout-spec/projector.js';
import { buildHydrationReceipt } from '../../../domain/layout-spec/frame-receipt.js';
import { buildSpacing, buildCoverage, buildSkeleton } from '../../../domain/layout-spec/views.js';
import { buildSetNames } from './component-set-names.js';
import { RESULT_BUDGET_BYTES, type SpecEntry } from './clamp-specs.js';
import { serializeForDelivery } from './serialize.js';
import type { RawSceneNode } from '../../../domain/figma-raw.js';
import type { ProjectorContext } from '../../../domain/layout-spec/projector.js';

const VIEWS = ['skeleton', 'branch', 'coverage', 'typography', 'spacing'] as const;
type View = (typeof VIEWS)[number];
const DEFAULT_DEPTH: Record<View, number> = { skeleton: 6, branch: 4, coverage: 6, typography: 8, spacing: 6 };

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42" or nested "I…;…"')
    .describe('Single node to view (globally unique). get_layout_spec keeps the node_ids[] batch for pairs.'),
  view: z.enum(VIEWS).describe(
    'skeleton (default depth 6): collapsed structural map (single-child wrappers collapsed, repeated siblings summarized). ' +
    'branch (default depth 4): the compare-compatible layout spec. ' +
    'coverage (default depth 6): per-container which will yield gap rows. ' +
    'typography (default depth 8): flat TEXT leaves (single-root → reaches deep DS text). ' +
    'spacing (default depth 6): gaps/paddings per container.'),
  max_depth: z.number().int().min(1).max(8).optional().describe('Projection depth (per-view default 4-8).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

// Dispatcher over the 5 views; `default` is a compile-time exhaustiveness guard.
function buildView(view: View, raw: RawSceneNode, ctx: ProjectorContext, effDepth: number): unknown {
  const caps: ViewCaps = VIEW_CAPS[view];
  switch (view) {
    case 'branch': return buildLayoutSpec(raw, ctx, { maxDepth: effDepth, caps });
    case 'typography': {
      const spec = buildLayoutSpec(raw, ctx, { maxDepth: effDepth, caps });
      const { leaves, truncated } = collectLeafTexts(spec);
      return { leaves, ...(truncated ? { truncated: true } : {}) };
    }
    case 'spacing': return buildSpacing(buildLayoutSpec(raw, ctx, { maxDepth: effDepth, caps }));
    case 'coverage': return buildCoverage(buildLayoutSpec(raw, ctx, { maxDepth: effDepth, caps }));
    // skeleton reads RAW + depth directly (NOT through buildLayoutSpec) so it sees TRUE child counts,
    // not the caps-truncated spec. The `caps` bound above is intentionally unused for this view.
    case 'skeleton': return buildSkeleton(raw, effDepth);
    default: { const _exhaustive: never = view; throw new Error(`unknown view: ${_exhaustive}`); }
  }
}

export function registerGetViewTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_view',
    {
      description: 'Single-root navigation over a held frame: one node_id, five pure lenses (skeleton/branch/' +
      'coverage/typography/spacing) sliced from one deep-fetch, zero re-fetch across views/depths.',
      inputSchema: InputSchema,
    },
    async (args) =>
      runTool('get_view', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const id = normalizeCompoundNodeId(args.node_id);
        const view = args.view as View;
        const reqDepth = args.max_depth ?? DEFAULT_DEPTH[view];
        const api = deps.buildApi(token);

        const frameRes = await api.getFrameRaw(parsed.value, [id], reqDepth);
        const entry = frameRes.raw.nodes[id];
        if (!entry?.document) throw new Error(`node ${id} not found`);
        const effDepth = frameRes.effectiveMaxDepth;
        const setNames = await buildSetNames(api, entry, deps.logger);
        const ctx: ProjectorContext = { components: entry.components, setNames };

        // Receipt is always built from the branch-caps spec of the SAME raw (honest truncation of the
        // deepest compare-shaped projection; view payload uses its own caps).
        const receiptSpec = buildLayoutSpec(entry.document, ctx, { maxDepth: effDepth, caps: VIEW_CAPS.branch });
        const hydration = buildHydrationReceipt(id, receiptSpec, frameRes);

        const payload = buildView(view, entry.document, ctx, effDepth);
        // Built as a local var (not an inline literal in argument position): SpecEntry has no index
        // signature, and `view` is a computed key — an inline literal would trip TS excess-property
        // checking. A pre-built variable is structurally compatible and skips that check.
        const entryForBudget = { node_id: id, [view]: payload } as SpecEntry;
        // Honest single-view guard: get_view always emits ONE view of ONE node, so clampSpecsToBudget
        // (which bounds a MULTI-entry batch by dropping a tail — it never drops a lone entry) can't flag
        // oversize here. Measure the DELIVERED serialization directly; an oversized view is still delivered
        // (never silently dropped) but the consumer is told to narrow node_id / lower max_depth.
        // serializeForDelivery is the exact fn jsonResult uses, so this byte count can't drift from delivery.
        const oversized = serializeForDelivery(entryForBudget).length > RESULT_BUDGET_BYTES;

        return jsonResult({
          // node_id intentionally NOT set here: it's always supplied by the ...entryForBudget spread —
          // an explicit duplicate would be silently overwritten by that spread, which tsc (TS2783) rejects.
          file: parsed.value, view, effective_max_depth: effDepth,
          ...entryForBudget,
          ...(oversized ? { result_oversized: true, result_oversized_note:
            'the view exceeded the response budget — lower max_depth or request a narrower node_id' } : {}),
          hydration,
        });
      }, deps.noTokenHint),
  );
}
