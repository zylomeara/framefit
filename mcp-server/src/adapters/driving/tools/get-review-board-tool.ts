import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { buildReviewBoard, type Lane } from '../../../domain/review-board.js';
import { clampToBudget } from '../../../application/get-comments.js';
import { serializeForDelivery } from './serialize.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"')
    .describe('The review-board section/frame to extract (e.g. a section packed with numbered pins and comment fields)'),
  include_screenshots: z.boolean().default(false)
    .describe('Attach a short-lived signed prod-screenshot URL per lane for visual context (token-light — a URL, not base64).'),
  pin_name: z.string().optional().describe('Override the pin marker name pattern (regex, default matches "пин"/"pin").'),
  comment_field_name: z.string().optional().describe('Override the comment-field name pattern (regex, default "коммент"/"comment"/"note"/"замеч").'),
  reference_name: z.string().optional().describe('Override the reference/"Макет" frame name pattern (regex). By default the reference frame is detected structurally (the aligned non-screenshot column), not by name.'),
  include_bounds: z.boolean().default(false).describe('Add w/h to each referenceNode.path node — container size is often the answer in design review.'),
  depth: z.number().int().min(1).max(10).default(6).describe('Subtree depth to fetch.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetReviewBoardTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_review_board',
    {
      description: 'Extract a design-review board in one call. Use this when a section packs a prod screenshot with numbered pin markers, "comment field" frames of numbered notes, and reference ("Макет") frames — the classic design-review layout. Returns each note linked pin↔text↔target (the pin number, its comment text, and the prod-screenshot coordinate the pin points at), grouped by lane (the prod screenshot each pin sits on) — no manual x/y geometry. Pins link to comments by their sequential number, assuming numbering is unique board-wide; when it is not, a "duplicate_pin_numbers" warning is emitted and ambiguous/cross-lane links are left as unmatched (honest-unmatched over confidently-wrong). Each note also resolves a `referenceNode` (the node under the pin in the lane\'s aligned reference/"Макет" frame): the deepest leaf, a `suggested` container, and an ancestor `path`; `nearestTargetNodeId` is the deepest leaf id. When no aligned reference exists, `referenceNode` is null with a `referenceReason`. Each `referenceNode` also carries a `confidence` ({level: high|medium|low, scaleDiscrepancyPx, boundaryMarginPx}) for the linear pin→reference projection — when `level` is not "high", re-verify the `suggested` node visually with get_screenshot (return=preview) before acting on it, because prod/reference layout differences can drift the projection into a neighbouring band. To identify the element directly, call get_screenshot with focus=target.atPercent (a zoomed crop around the pin), read what it points at, then locate that element in the reference with find_nodes — this beats the linear projection when prod/reference layouts drift.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('get_review_board', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const id = normalizeNodeId(args.node_id);
        const api = deps.buildApi(token);
        const res = await api.getNodesRaw(parsed.value, [id], args.depth);
        const doc = res.nodes[id]?.document;
        if (!doc) throw new Error(`node ${id} not found in file`);

        const board = buildReviewBoard(doc, {
          pinName: args.pin_name,
          commentFieldName: args.comment_field_name,
          referenceName: args.reference_name,
          includeBounds: args.include_bounds,
        });

        if (args.include_screenshots) {
          const prodIds = [...new Set(board.groups.map((g) => g.screenshots.prod?.node_id).filter((x): x is string => !!x))];
          if (prodIds.length) {
            const { images } = await api.getImages(parsed.value, prodIds, { format: 'png', scale: 1 });
            for (const g of board.groups) {
              const nid = g.screenshots.prod?.node_id;
              if (nid && images[nid] && g.screenshots.prod) g.screenshots.prod.url = images[nid];
            }
          }
        }

        // Budget: clamp lanes (each lane is self-contained) if the response is oversized.
        // Measure == delivery: serializeForDelivery is the same function
        // jsonResult uses; the whole envelope; warnings in the measurement CONSERVATIVELY always carry
        // 'auto_clamped' (+~15 chars of fixed headroom — an honest shift upward, not drift).
        const budget = deps.maxResultChars ?? 40000;
        const serialize = (lanes: Lane[]): string =>
          serializeForDelivery({ file: parsed.value, node_id: id, groups: lanes,
            unmatched: board.unmatched, warnings: [...board.warnings, 'auto_clamped'] });
        const { kept, clamped } = clampToBudget(board.groups, budget, serialize);
        return jsonResult({
          file: parsed.value,
          node_id: id,
          groups: kept,
          unmatched: board.unmatched,
          warnings: [...board.warnings, ...(clamped ? ['auto_clamped'] : [])],
        });
      }, deps.noTokenHint),
  );
}
