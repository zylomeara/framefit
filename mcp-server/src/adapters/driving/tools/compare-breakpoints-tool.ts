import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { simplify } from '../../../domain/design-context/simplify.js';
import { styleForName } from '../../../domain/text-styles.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_ids: z.array(z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"')).min(2).max(8)
    .describe('Breakpoint frame node ids — one per width (e.g. desktop/laptop/tablet/mob). Fetched in one call.'),
  name: z.string().min(1).describe('Element name/role to compare across breakpoints (e.g. "tabs").'),
  fuzzy: z.boolean().default(false).describe('Typo-tolerant matching of the element name.'),
  include_color: z.boolean().default(true).describe('Include the element\'s text color per breakpoint.'),
  depth: z.number().int().min(1).max(10).default(8).describe('Subtree depth fetched per frame.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerCompareBreakpointsTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'compare_breakpoints',
    'Compare one element\'s typography across several breakpoint frames in a single call. Pass the breakpoint frame node_ids (one per width) and the element name (e.g. "tabs"); returns the element\'s text-style per breakpoint with the frame name and width. Replaces opening each width frame by hand.',
    InputSchema,
    async (args) =>
      runTool('compare_breakpoints', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const ids = args.node_ids.map(normalizeNodeId);
        const api = deps.buildApi(token);

        const res = await api.getNodesRaw(parsed.value, ids, args.depth); // single batched REST call
        const breakpoints = ids.map((id) => {
          const doc = res.nodes[id]?.document;
          // frame id absent from the batch response (bad id) — shape: { frame_node_id, error: 'not found' }
          if (!doc) return { frame_node_id: id, error: 'not found' };
          const { node, globalVars } = simplify(doc);
          const hit = styleForName(node, globalVars, args.name, { fuzzy: args.fuzzy, includeColor: args.include_color });
          const base: Record<string, unknown> = { frame_node_id: id, frame_name: doc.name };
          if (node.size) base.width = node.size.w;
          if (hit) {
            base.node_id = hit.node_id;
            base.name = hit.name;
            base.textStyle = hit.textStyle;
            if (hit.fill !== undefined) base.fill = hit.fill;
          } else {
            // frame found but no node matched `name` — distinct from the frame-missing `error` shape above
            // shape: { frame_node_id, frame_name, width?, match: null }
            base.match = null;
          }
          return base;
        });
        return jsonResult({ element: args.name, breakpoints });
      }, deps.noTokenHint),
  );
}
