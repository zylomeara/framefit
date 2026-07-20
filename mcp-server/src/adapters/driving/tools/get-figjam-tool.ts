import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { serializeForDelivery } from './serialize.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { simplifyFigjam } from '../../../domain/figjam.js';

const InputSchema = {
  file: z.string().min(1).describe('FigJam board URL (/board/<key>) or raw key'),
  node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"').optional()
    .describe('Scope to a section/subtree; omit for the whole board'),
  depth: z.number().int().min(1).max(8).default(4)
    .describe('Tree depth to walk (default 4). Lower it (or pass node_id) if the board overflows the size budget.'),
  include_hidden: z.boolean().default(false).describe('Include hidden nodes (default false).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetFigjamTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'get_figjam',
    'Structured content of a FigJam board: sticky notes (text + color), shapes-with-text, sections, connectors (from→to edges with labels), and tables. The headless analogue of the official get_figjam — returns board data, not generated UI code. Use nodeNames to label connector endpoints. Tables degrade to an ordered flat list of cell texts (REST exposes no row/column index).',
    InputSchema,
    async (args) =>
      runTool('get_figjam', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const api = deps.buildApi(token);

        let doc;
        if (args.node_id) {
          const id = normalizeNodeId(args.node_id);
          const res = await api.getNodesRaw(parsed.value, [id], args.depth);
          doc = res.nodes[id]?.document;
          if (!doc) throw new Error(`node ${id} not found in file`);
        } else {
          const file = await api.getDocumentRaw(parsed.value, args.depth);
          doc = file.document;
        }

        const board = simplifyFigjam(doc, { file: parsed.value, depth: args.depth, includeHidden: args.include_hidden });
        // Measure == delivery: serializeForDelivery is the same function
        // jsonResult delivers with. The pretty gate (×~1.35 on a live fixture: 2801 vs 2077) REJECTED
        // boards in the (compact, pretty] window that fit the budget whole — a full rejection instead
        // of delivery. The rejection stub itself is unchanged.
        const deliveredLen = serializeForDelivery(board).length;
        const budget = deps.maxResultChars ?? 40000;
        if (deliveredLen > budget) {
          return jsonResult({
            warning: `FigJam board is ${deliveredLen} chars, over the ${budget} budget. Re-run with a lower depth (current ${args.depth})${args.node_id ? '' : ' or pass a node_id to scope to a section'}.`,
            counts: {
              stickies: board.stickies.length, shapes: board.shapes.length,
              sections: board.sections.length, connectors: board.connectors.length, tables: board.tables.length,
            },
          });
        }
        return jsonResult(board);
      }, deps.noTokenHint),
  );
}
