import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { simplify } from '../../../domain/design-context/simplify.js';
import { collectTextStyles, dedupeTextStyles } from '../../../domain/text-styles.js';
import { clampToBudget } from '../../../application/get-comments.js';
import { serializeForDelivery } from './serialize.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"')
    .describe('Root node — its text descendants\' typography is returned (no full tree).'),
  include_color: z.boolean().default(true).describe('Join each text node\'s color (fill) — hex or token name. Text color lives on fill, not in textStyle.'),
  dedupe: z.boolean().default(true).describe('Group nodes that share an identical style into one entry.'),
  depth: z.number().int().min(1).max(10).default(8).describe('How deep to fetch/walk the subtree.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetTextStylesTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_text_styles',
    {
      description: 'Extract only the typography of a node\'s subtree (fontFamily, fontWeight, fontSize, lineHeightPx, letterSpacing, align) without the full design tree — for fast spec verification of a deep text node. Pass dedupe=true to group identical styles. Use find_nodes first to get a node_id.',
      inputSchema: InputSchema,
    },
    async (args) =>
      runTool('get_text_styles', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const id = normalizeNodeId(args.node_id);
        const api = deps.buildApi(token);

        const res = await api.getNodesRaw(parsed.value, [id], args.depth);
        const doc = res.nodes[id]?.document;
        if (!doc) throw new Error(`node ${id} not found in file`);

        // No variable resolution: typography shape is independent of variables; text
        // color surfaces as the interned hex (token-named color is out of scope).
        const { node, globalVars } = simplify(doc);
        const hits = collectTextStyles(node, globalVars, { includeColor: args.include_color });

        const budget = deps.maxResultChars ?? 40000;
        // Measure == delivery: serializeForDelivery is the same function
        // jsonResult uses; the whole envelope; clamped:true in the measurement is CONSERVATIVELY always set
        // (+~14 chars of fixed headroom — an honest shift upward, not drift).
        if (args.dedupe) {
          const groups = dedupeTextStyles(hits);
          const { kept, clamped } = clampToBudget(groups, budget, (xs) =>
            serializeForDelivery({ node_id: id, total: groups.length, returned: xs.length, clamped: true, styles: xs }));
          return jsonResult({ node_id: id, total: groups.length, returned: kept.length, ...(clamped ? { clamped: true } : {}), styles: kept });
        }
        const { kept, clamped } = clampToBudget(hits, budget, (xs) =>
          serializeForDelivery({ node_id: id, total: hits.length, returned: xs.length, clamped: true, styles: xs }));
        return jsonResult({ node_id: id, total: hits.length, returned: kept.length, ...(clamped ? { clamped: true } : {}), styles: kept });
      }, deps.noTokenHint),
  );
}
