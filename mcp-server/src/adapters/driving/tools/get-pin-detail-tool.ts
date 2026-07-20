import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { buildReviewBoard, type Lane, type ReviewItem } from '../../../domain/review-board.js';
import type { RawSceneNode } from '../../../domain/figma-raw.js';
import { renderFocusCrop, DEFAULT_FOCUS_RADIUS } from './focus-crop.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  board_node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"')
    .describe('The review-board section (the same node_id you pass to get_review_board).'),
  pin_number: z.number().int().min(1).optional()
    .describe('The pin number to inspect. Use on boards where numbering is unique. Provide either pin_number OR pin_node_id (exactly one).'),
  pin_node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"').optional()
    .describe('Address the pin directly by its marker node id (from item.pinNodeId in get_review_board output). Use this on multi-lane boards where pin numbers repeat per lane and a number alone is ambiguous. Provide either pin_number OR pin_node_id (exactly one).'),
  focus_radius: z.number().min(0.02).max(0.5).default(DEFAULT_FOCUS_RADIUS)
    .describe('Focus-crop half-size as a fraction of the prod screenshot width. 0.12 ≈ a ~24%-wide window.'),
  depth: z.number().int().min(1).max(10).default(6).describe('Subtree depth to fetch (match get_review_board).'),
  pin_name: z.string().optional().describe('Override the pin marker name pattern (regex).'),
  comment_field_name: z.string().optional().describe('Override the comment-field name pattern (regex).'),
  reference_name: z.string().optional().describe('Override the reference/"Макет" frame name pattern (regex).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

// Walk the raw subtree for a node id; return its unscaled bbox or null.
function findRawBox(node: RawSceneNode, id: string): { width: number; height: number } | null {
  if (node.id === id) return node.absoluteBoundingBox ?? null;
  for (const c of node.children ?? []) {
    const hit = findRawBox(c as RawSceneNode, id);
    if (hit) return hit;
  }
  return null;
}

// One-line ≤50-char preview of a pin's comment for the ambiguous-candidate list.
function snippet(text: string | null): string {
  if (!text) return '(no comment)';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(no comment)';
  return oneLine.length > 50 ? `${oneLine.slice(0, 49)}…` : oneLine;
}

export function registerGetPinDetailTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'get_pin_detail',
    'Inspect ONE review-board pin in a single call: returns a zoomed, reticle-marked PNG crop of exactly where the pin points (the prod screenshot region) plus its resolved referenceNode (deepest leaf + suggested container + path + confidence), the reference-frame node_id, and the full-res screenshot URL. Use this to recover a pin whose get_review_board confidence is not "high": read the element in the crop, then find_nodes(file, query=<what you see>, node_id=<referenceFrameNodeId>) to locate it in the reference — this beats the linear projection when prod/reference layouts drift. board_node_id is the same section you pass to get_review_board. Address the pin by pin_number (unique-numbered boards) OR by pin_node_id (from item.pinNodeId in the get_review_board output) — use pin_node_id on multi-lane boards where numbers repeat per lane.',
    InputSchema,
    async (args) =>
      runTool('get_pin_detail', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const hasNumber = args.pin_number !== undefined;
        const hasNodeId = args.pin_node_id !== undefined;
        if (hasNumber === hasNodeId) throw new Error('provide exactly one of pin_number or pin_node_id');
        const boardId = normalizeNodeId(args.board_node_id);
        const api = deps.buildApi(token);
        const res = await api.getNodesRaw(parsed.value, [boardId], args.depth);
        const doc = res.nodes[boardId]?.document;
        if (!doc) throw new Error(`node ${boardId} not found in file`);

        const boardData = buildReviewBoard(doc, {
          pinName: args.pin_name,
          commentFieldName: args.comment_field_name,
          referenceName: args.reference_name,
          includeBounds: false,
        });

        let found: { item: ReviewItem; lane: Lane } | null = null;
        if (args.pin_node_id !== undefined) {
          const pinId = normalizeNodeId(args.pin_node_id);
          for (const lane of boardData.groups) {
            for (const item of lane.items) {
              if (item.pinNodeId === pinId) { found = { item, lane }; break; }
            }
            if (found) break;
          }
          if (!found) throw new Error(`pin node ${pinId} not found on board ${boardId}`);
        } else {
          for (const lane of boardData.groups) {
            for (const item of lane.items) {
              if (item.number === args.pin_number) { found = { item, lane }; break; }
            }
            if (found) break;
          }
          if (!found) throw new Error(`pin ${args.pin_number} not found on board ${boardId}`);
          if (boardData.warnings.includes('duplicate_pin_numbers')) {
            const candidates: { pinNodeId: string; lane: number; comment: string }[] = [];
            boardData.groups.forEach((g, gi) => {
              for (const it of g.items) {
                if (it.number === args.pin_number) {
                  candidates.push({ pinNodeId: it.pinNodeId, lane: gi + 1, comment: snippet(it.commentText) });
                }
              }
            });
            if (candidates.length > 1) {
              const list = candidates
                .map((c) => `${c.pinNodeId} (lane ${c.lane}, "${c.comment}")`)
                .join(', ');
              throw new Error(`pin ${args.pin_number} is ambiguous on board ${boardId} (appears ${candidates.length}×) — pass pin_node_id, one of: ${list}.`);
            }
          }
        }

        const { item, lane } = found;
        const t = item.target;
        const referenceFrameNodeId = lane.screenshots.reference?.node_id ?? null;

        // No screenshot coordinate → honest text-only partial (not an error).
        if (!t.atPercent || !t.screenshotNodeId) {
          return jsonResult({
            pin_number: item.number,
            commentText: item.commentText,
            target: { atPercent: t.atPercent, screenshotNodeId: t.screenshotNodeId },
            referenceNode: t.referenceNode,
            referenceReason: t.referenceReason ?? null,
            referenceFrameNodeId,
            note: 'No screenshot coordinate for this pin — cannot produce a focus crop. Use referenceNode (if present) or inspect the board visually.',
          });
        }

        const prodBox = findRawBox(doc, t.screenshotNodeId);
        if (!prodBox) throw new Error(`prod screenshot ${t.screenshotNodeId} has no bounding box; cannot crop.`);
        // Runtime fallback: the MCP SDK applies the Zod .default, but tests call the handler
        // directly (bypassing Zod) so args.focus_radius can be undefined — mirror get_screenshot.
        const focusRadius = args.focus_radius ?? DEFAULT_FOCUS_RADIUS;
        const { buffer, region, sourceScale } = await renderFocusCrop(api, parsed.value, t.screenshotNodeId, prodBox.width, {
          focusX: t.atPercent.x, focusY: t.atPercent.y, focusRadius, requestedScale: 2,
        });
        const full_res_url = (await api.getImages(parsed.value, [t.screenshotNodeId], { format: 'png', scale: 2 })).images[t.screenshotNodeId] ?? null;

        const meta: Record<string, unknown> = {
          pin_number: item.number,
          commentText: item.commentText,
          target: { atPercent: t.atPercent, screenshotNodeId: t.screenshotNodeId },
          referenceNode: t.referenceNode,
          referenceReason: t.referenceReason ?? null,
          referenceFrameNodeId,
          region,
          source_scale: sourceScale,
          full_res_url,
          note: `Reticle marks pin ${item.number}. If referenceNode looks wrong (confidence != high), read the element in the crop, then find_nodes(file, query=<what you see>, node_id=referenceFrameNodeId) to locate it in the reference.`,
        };
        return {
          content: [
            { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/png' },
            { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
          ],
        };
      }, deps.noTokenHint),
  );
}
