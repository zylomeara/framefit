import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { toSparseTree, countTruncated, type SparseNode } from '../../../domain/metadata.js';
import { fitToBudgetPerBranch } from '../../../domain/design-context/auto-degrade.js';
import { clampToBudget } from '../../../application/get-comments.js';
import { serializeForDelivery } from './serialize.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42", or a nested-instance id like "I12:340;56:7890"').optional()
    .describe('Scope the map to this node and its subtree; omit for the whole file'),
  depth: z.number().int().min(1).max(6).default(2)
    .describe('Tree depth (default 2). Higher = bigger map; start shallow then drill in.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetMetadataTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_metadata',
    {
      description: 'A sparse map of a Figma file: id/name/type/position/size per node, depth-limited. Cheap navigation - call this first, then get_design_context on a chosen node_id. On large nodes the depth degrades per-branch: light branches stay deep while heavy ones collapse; truncation reports effective_depth (deepest shown) and min_effective_depth (shallowest branch), with truncated:true + childCount on each cut node.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('get_metadata', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const api = deps.buildApi(token);
        let tree;
        if (args.node_id) {
          const id = normalizeCompoundNodeId(args.node_id);
          const res = await api.getNodesRaw(parsed.value, [id], args.depth);
          const doc = res.nodes[id]?.document;
          if (!doc) throw new Error(`node ${id} not found in file`);
          tree = toSparseTree(doc, args.depth);
        } else {
          const file = await api.getDocumentRaw(parsed.value, args.depth);
          tree = toSparseTree(file.document, args.depth);
        }

        // Measure == delivery: compact via serializeForDelivery is the same function
        // jsonResult delivers with. The pretty cushion (×1.9-3.75) USED TO MASK an under-count: the
        // `truncation` block (~150 chars compact) is added to `out` AFTER all three measurements — without the cushion
        // this silently pushed delivery over budget (live floor-case measure: 1073 > budget 1000). All
        // three measurements carry a conservative worst-case-width stub, reserving room for this block.
        const TRUNCATION_STUB = { requested_depth: 88, effective_depth: 88, min_effective_depth: 88,
          reason: 'width', truncated_branches: 88888, omitted_children: 888888 } as const; // 'width'/'depth' = 5 chars — worst-case reason ('both'/'none' are shorter)
        const STUB_LEN = serializeForDelivery({ truncation: TRUNCATION_STUB, depth: 88, degraded: true, omittedChildren: 888888 }).length; // =205 (live measurement)
        // STUB_LEN includes ~26 chars of double-counting depth/degraded (already in the node's sizeOf) — a
        // deliberate conservative MARGIN, not the exact marginal cost of the truncation block.
        const budget = deps.maxResultChars ?? 40000;
        const sizeOf = (n: SparseNode): number =>
          serializeForDelivery({ ...n, depth: 0, degraded: false }).length;
        // Subtracting STUB_LEN from the fit budget is equivalent to the stub in every per-branch
        // measurement without inflating the per-node cost (budget is the GLOBAL threshold for the whole tree).
        const fit = fitToBudgetPerBranch(tree, args.depth, budget - STUB_LEN, sizeOf);
        const out: SparseNode & {
          depth: number; degraded: boolean; omittedChildren?: number;
          truncation?: { requested_depth: number; effective_depth: number; min_effective_depth: number; reason: string; truncated_branches: number; omitted_children: number };
        } = { ...fit.node, depth: fit.effectiveDepth, degraded: fit.degraded };

        // Floor case: per-branch fitting already collapsed every branch to depth 1, but
        // top-level breadth (the number/size of direct children) alone still exceeds the
        // budget — trim children (keep the largest prefix that fits) and report how many
        // were dropped.
        let omitted = 0;
        if (serializeForDelivery({ ...out, truncation: TRUNCATION_STUB }).length > budget && Array.isArray(out.children)) {
          const all = out.children;
          const { kept } = clampToBudget(all, budget, (xs) =>
            serializeForDelivery({ ...fit.node, children: xs, depth: 1, degraded: true, omittedChildren: all.length - xs.length, truncation: TRUNCATION_STUB }));
          out.children = kept;
          out.degraded = true;
          if (kept.length < all.length) { out.omittedChildren = all.length - kept.length; omitted = out.omittedChildren; }
        }

        const depthReduced = fit.minEffectiveDepth < args.depth;
        const reason = depthReduced && omitted ? 'both' : depthReduced ? 'depth' : omitted ? 'width' : 'none';
        out.truncation = {
          requested_depth: args.depth,
          effective_depth: fit.effectiveDepth,
          min_effective_depth: fit.minEffectiveDepth,
          reason,
          truncated_branches: countTruncated(out),
          omitted_children: omitted,
        };
        return jsonResult(out);
      }, deps.noTokenHint),
  );
}
