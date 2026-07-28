import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import type { RawSceneNode } from '../../../domain/figma-raw.js';
import { widthNoiseTolerance } from '../../../domain/layout-spec/diff.js';

const CANDIDATE_TYPES = new Set(['FRAME', 'COMPONENT']);
const CONTAINER_TYPES = new Set(['SECTION', 'CANVAS']); // CANVAS = page
const CONTENT_TYPES = new Set(['FRAME', 'GROUP', 'INSTANCE']);
const MAX_VARIANTS = 10;
const MAX_CONTENT_PER_VARIANT = 5;
const VARIANT_WALK_DEPTH = 3;
const CONTENT_FETCH_DEPTH = 2;

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  query: z.string().min(2)
    .describe('Substring to match against a breakpoint-variant frame\'s own name OR its nearest section/page (container) name, case-insensitive.'),
  render_width: z.number().positive()
    .describe('The width you rendered the DOM at - variants are ranked by how close a CONTENT frame\'s width is to this.'),
  parent_node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"').optional()
    .describe('Scope the walk to this node\'s subtree (e.g. a section or page) instead of the whole document. Use on huge files to avoid a slow/timing-out whole-document walk.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

interface VariantCandidate { node: RawSceneNode; container?: string }

// Pre-order DFS: collects FRAME/COMPONENT nodes whose own name OR nearest SECTION/page-ancestor
// name contains `queryLower`. Push order == document (tree) order — the caller caps WITHOUT
// re-sorting so results stay deterministic (no width/relevance reordering at this stage).
// Stops descending once a node matches: its children are the variant's own content (potentially
// also FRAME-typed and inheriting the same matched container) — not separate variant candidates.
function collectVariantCandidates(root: RawSceneNode, queryLower: string): VariantCandidate[] {
  const out: VariantCandidate[] = [];
  const walk = (node: RawSceneNode, container: string | undefined): void => {
    const nextContainer = CONTAINER_TYPES.has(node.type) ? node.name : container;
    if (CANDIDATE_TYPES.has(node.type)) {
      const nameMatch = node.name.toLowerCase().includes(queryLower);
      const containerMatch = nextContainer !== undefined && nextContainer.toLowerCase().includes(queryLower);
      if (nameMatch || containerMatch) {
        out.push({ node, container: nextContainer });
        return; // don't descend into a matched variant's own content
      }
    }
    for (const child of node.children ?? []) walk(child, nextContainer);
  };
  walk(root, undefined);
  return out;
}

interface ContentCandidate { node_id: string; name: string; w: number }
interface ContentOut extends ContentCandidate { isBestMatch?: true }

// The variant frame's children + grandchildren (mirrors the depth-2 getNodesRaw fetch anchored
// at the frame) typed FRAME/GROUP/INSTANCE with a bbox — sorted closest-to-render_width first,
// capped to MAX_CONTENT_PER_VARIANT.
function collectContentCandidates(frameDoc: RawSceneNode, renderWidth: number): ContentOut[] {
  const out: ContentCandidate[] = [];
  const consider = (n: RawSceneNode): void => {
    if (CONTENT_TYPES.has(n.type) && n.absoluteBoundingBox) {
      out.push({ node_id: n.id, name: n.name, w: Math.round(n.absoluteBoundingBox.width) });
    }
  };
  for (const child of frameDoc.children ?? []) {
    consider(child);
    for (const grandchild of child.children ?? []) consider(grandchild);
  }
  out.sort((a, b) => Math.abs(a.w - renderWidth) - Math.abs(b.w - renderWidth));
  return out.slice(0, MAX_CONTENT_PER_VARIANT);
}

export function registerFindBreakpointVariantTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'find_breakpoint_variant',
    {
      description: 'Resolve which breakpoint variant frame matches your rendered width. Works from a bare text query (no node_id required - avoids a whole-file find_nodes on files with many near-duplicate variant frames). Rank is by CONTENT frame width, not the variant frame\'s own width (a variant named "desktop" (w1280) whose inner drawer content is w420 matches render_width 420). On huge files pass parent_node_id (a section or page) to scope the walk and avoid timing out.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('find_breakpoint_variant', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const api = deps.buildApi(token);
        const queryLower = args.query.toLowerCase();
        const tolerance = widthNoiseTolerance(args.render_width);

        let root: RawSceneNode;
        if (args.parent_node_id) {
          const parentId = normalizeNodeId(args.parent_node_id);
          const res = await api.getNodesRaw(parsed.value, [parentId], VARIANT_WALK_DEPTH);
          const doc = res.nodes[parentId]?.document;
          if (!doc) throw new Error(`node ${parentId} not found in file`);
          root = doc;
        } else {
          const file = await api.getDocumentRaw(parsed.value, VARIANT_WALK_DEPTH);
          root = file.document;
        }

        const allCandidates = collectVariantCandidates(root, queryLower);
        const capped = allCandidates.slice(0, MAX_VARIANTS);
        const notes: string[] = [];
        if (allCandidates.length > MAX_VARIANTS) {
          notes.push(
            `${allCandidates.length} frames matched "${args.query}" — showing the first ${MAX_VARIANTS} in document order; ` +
            'refine query or pass parent_node_id to narrow the walk.',
          );
        }

        if (capped.length === 0) {
          return jsonResult({
            query: args.query, render_width: args.render_width, tolerance,
            variants: [], match: null,
            note: `no FRAME/COMPONENT matched "${args.query}" by name or container — check query or pass parent_node_id.`,
          });
        }

        const variantIds = capped.map((c) => c.node.id);
        const contentRes = await api.getNodesRaw(parsed.value, variantIds, CONTENT_FETCH_DEPTH);

        let best: { diff: number; nodeId: string; w: number; variantNodeId: string } | undefined;
        const variantsOut = capped.map((c) => {
          const fetched = contentRes.nodes[c.node.id]?.document ?? c.node;
          const frameW = Math.round(fetched.absoluteBoundingBox?.width ?? 0);
          const content = collectContentCandidates(fetched, args.render_width);

          // The frame's own width is a candidate too — sometimes the frame IS the content (no
          // separate inner content wrapper), so it must compete for `best` even though it's not
          // listed inside `content` (that array is for descendant nodes; frame_w is reported
          // separately at the variant level).
          const evalCandidates: { nodeId: string; w: number }[] = [
            ...content.map((cc) => ({ nodeId: cc.node_id, w: cc.w })),
            { nodeId: c.node.id, w: frameW },
          ];
          for (const cand of evalCandidates) {
            const diff = Math.abs(cand.w - args.render_width);
            if (!best || diff < best.diff) best = { diff, nodeId: cand.nodeId, w: cand.w, variantNodeId: c.node.id };
          }

          return {
            node_id: c.node.id,
            name: c.node.name,
            ...(c.container !== undefined ? { container: c.container } : {}),
            frame_w: frameW,
            content,
          };
        });

        let match: { node_id: string; w: number; variant_node_id: string } | null = null;
        if (best && best.diff <= tolerance) {
          match = { node_id: best.nodeId, w: best.w, variant_node_id: best.variantNodeId };
          const variant = variantsOut.find((v) => v.node_id === best!.variantNodeId);
          const contentHit = variant?.content.find((cc) => cc.node_id === best!.nodeId);
          if (contentHit) contentHit.isBestMatch = true;
        } else {
          notes.push(
            `no content width within ±${Math.round(tolerance)} tolerance — candidates below, verify the breakpoint by hand.`,
          );
        }

        return jsonResult({
          query: args.query, render_width: args.render_width, tolerance,
          variants: variantsOut, match,
          ...(notes.length ? { note: notes.join(' ') } : {}),
        });
      }, deps.noTokenHint),
  );
}
