import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, textResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { buildLayoutSpec, collectLeafTexts, VIEW_CAPS, type ViewCaps } from '../../../domain/layout-spec/projector.js';
import { buildHydrationReceipt } from '../../../domain/layout-spec/frame-receipt.js';
import { buildSpacing, buildCoverage, buildSkeleton } from '../../../domain/layout-spec/views.js';
import { buildSetNames } from './component-set-names.js';
import { clampToBudget, responseTooLargeResult, RESULT_BUDGET_BYTES } from './response-budget.js';
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
    'typography (default depth 8): flat TEXT leaves (single-root -> reaches deep DS text). ' +
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
      annotations: { readOnlyHint: true },
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
        // styleNames keeps the "compare-compatible" claim of the branch view honest at the
        // style-name level: without it a shared-style fill projects a nameless '(paint)' token
        // where get_layout_spec names the style. (The variable RESOLVER stays out of get_view —
        // navigation-only tool, no verdict runs on its output.)
        const ctx: ProjectorContext = { components: entry.components, setNames, styleNames: (sid: string) => entry.styles?.[sid]?.name };

        // Receipt is always built from the branch-caps spec of the SAME raw (honest truncation of the
        // deepest compare-shaped projection; view payload uses its own caps).
        const receiptSpec = buildLayoutSpec(entry.document, ctx, { maxDepth: effDepth, caps: VIEW_CAPS.branch });
        const hydration = buildHydrationReceipt(id, receiptSpec, frameRes);

        const payload = buildView(view, entry.document, ctx, effDepth);
        const serialize = (items: unknown[]) => serializeForDelivery({
          file: parsed.value,
          view,
          effective_max_depth: effDepth,
          node_id: id,
          ...(items.length ? { [view]: items[0] } : {}),
          hydration,
        });
        const result = clampToBudget(
          [payload],
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
