import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import type { RawSceneNode } from '../../../domain/figma-raw.js';
import { widthNoiseTolerance } from '../../../domain/layout-spec/diff.js';
import { FigmaApiError } from '../../../ports/errors.js';
import { COVERAGE_SKIPPED_NAMES_CAP } from './find-nodes-tool.js';

// COMPONENT_SET is a candidate in its own right (feedback item 10 panel): a set named
// "promo rail" holds the actual breakpoint variants as COMPONENT children named
// "Breakpoint=..." - matching the set by name and ranking its children is the only way that
// shape is findable at all. COMPONENT joins CONTENT_TYPES for the same reason.
const CANDIDATE_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);
const CONTAINER_TYPES = new Set(['SECTION', 'CANVAS']); // CANVAS = page
const CONTENT_TYPES = new Set(['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT']);
// Types whose subtree can still HOLD candidates - a node of one of these types sitting AT the
// per-container fetch boundary is a real coverage residual (depth_cut), counted BY CONSTRUCTION
// from the known walk depth, never by inspecting the wire shape of a cut node.
const CONTAINERISH_TYPES = new Set(['SECTION', 'CANVAS', 'FRAME', 'GROUP', 'COMPONENT_SET', 'INSTANCE', 'COMPONENT']);
const MAX_VARIANTS = 10;
const MAX_CONTENT_PER_VARIANT = 5;
// The whole-document skeleton depth (page -> top-level container), and the depth of each
// per-container fetch. Document reach = 2 + 3 = 5: the measured live-repro shape is
// canvas > SECTION > sub-SECTION > COMPONENT (depth 4) with one level of headroom - NOT a
// blind whole-document depth bump, which on the 110MB-class flagship is the latency/OOM class
// the whole-file cap line exists for.
const SKELETON_DEPTH = 2;
const PER_CONTAINER_DEPTH = 3;
const CONTENT_FETCH_DEPTH = 2;
// A single slow container must not eat the whole tool budget (the per-request default equals
// the tool budget, 90s == 90s): each container fetch gets its own cap under the shared deadline.
const PER_CONTAINER_TIMEOUT_MS = 20_000;
// parent_node_id is ONE scoped fetch, one level deeper than the per-container walk - the
// drill-down remedy must be the CHEAPEST path in the tool (2 REST calls, as on main), not 1+N.
const ANCHOR_DEPTH = 4;

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  query: z.string().min(2)
    .describe('Substring to match against a breakpoint-variant frame\'s own name OR its nearest section/page (container) name, case-insensitive.'),
  render_width: z.number().positive()
    .describe('The width you rendered the DOM at - variants are ranked by how close a CONTENT frame\'s width is to this.'),
  parent_node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"').optional()
    .describe('Scope the walk to this node\'s subtree (its direct children become the searched containers). Use on huge files to narrow the walk or to drill one container from coverage.skipped.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

interface VariantCandidate { node: RawSceneNode; container?: string; nameMatch: boolean }

// Pre-order DFS bounded by depthLeft (the fetch depth of the tree being walked - the boundary
// is known BY CONSTRUCTION). Collects FRAME/COMPONENT/COMPONENT_SET nodes whose own name OR
// nearest SECTION/page-ancestor name contains `queryLower`; counts containerish nodes AT the
// boundary as depth_cut. Stops descending once a node matches: its children are the variant's
// own content, not separate candidates.
function collectVariantCandidates(
  root: RawSceneNode, queryLower: string, container: string | undefined, depthLeft: number,
): { candidates: VariantCandidate[]; depthCut: number } {
  const out: VariantCandidate[] = [];
  let depthCut = 0;
  const walk = (node: RawSceneNode, containerCtx: string | undefined, left: number): void => {
    const nextContainer = CONTAINER_TYPES.has(node.type) ? node.name : containerCtx;
    if (CANDIDATE_TYPES.has(node.type)) {
      const nameMatch = node.name.toLowerCase().includes(queryLower);
      const containerMatch = nextContainer !== undefined && nextContainer.toLowerCase().includes(queryLower);
      if (nameMatch || containerMatch) {
        out.push({ node, container: nextContainer, nameMatch });
        return; // don't descend into a matched variant's own content
      }
    }
    if (left <= 0) {
      // The walk is cut here by the fetch depth. A containerish node at the boundary can still
      // hold candidates - count it instead of silently treating "not fetched" as "not there".
      if (CONTAINERISH_TYPES.has(node.type)) depthCut += 1;
      return;
    }
    for (const child of node.children ?? []) walk(child, nextContainer, left - 1);
  };
  walk(root, container, depthLeft);
  return { candidates: out, depthCut };
}

interface ContentCandidate { node_id: string; name: string; w: number }
interface ContentOut extends ContentCandidate { isBestMatch?: true }

// The variant frame's children + grandchildren (mirrors the depth-2 getNodesRaw fetch anchored
// at the frame) typed FRAME/GROUP/INSTANCE/COMPONENT with a bbox - sorted
// closest-to-render_width first, capped to MAX_CONTENT_PER_VARIANT.
function collectContentCandidates(frameDoc: RawSceneNode, renderWidth: number): ContentOut[] {
  const out: ContentCandidate[] = [];
  // COMPONENT children enter the width race ONLY under a COMPONENT_SET (its variants ARE the
  // content) - inside an ordinary FRAME they would flip matches on files that did not change.
  const contentTypes = frameDoc.type === 'COMPONENT_SET' ? CONTENT_TYPES : new Set([...CONTENT_TYPES].filter((t) => t !== 'COMPONENT'));
  const consider = (n: RawSceneNode): void => {
    if (contentTypes.has(n.type) && n.absoluteBoundingBox) {
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
      description: 'Resolve which breakpoint variant frame matches your rendered width. Works from a bare text query (no node_id required - avoids a whole-file find_nodes on files with many near-duplicate variant frames). Rank is by CONTENT frame width, not the variant frame\'s own width (a variant named "desktop" (w1280) whose inner drawer content is w420 matches render_width 420). The walk enumerates top-level containers and searches each to a bounded depth under a time budget; the response always carries a coverage ledger (searched/total/skipped, plus depth_cut for containers deeper than the walk) - an empty variants list claims absence ONLY over the searched slice. Pass parent_node_id (a section or page) to scope the walk, or to drill one container named in coverage.skipped.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('find_breakpoint_variant', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        // The find_nodes budget shape: every fetch below shares one deadline; containers the
        // budget could not reach land in the ledger instead of failing the call.
        const deadlineAt = Date.now() + (deps.toolTimeBudgetMs ?? 90_000);
        const api = deps.buildApi(token, undefined, deadlineAt);
        // The container loop's client: per-request sub-cap under the same absolute deadline.
        const walkApi = deps.buildApi(token, PER_CONTAINER_TIMEOUT_MS, deadlineAt);
        const queryLower = args.query.toLowerCase();
        const tolerance = widthNoiseTolerance(args.render_width);

        // Container population + the skeleton-level pass. Whole-file: containers = ALL page
        // children (no type filter - the find_nodes precedent; FRAME/GROUP wrappers nest
        // candidates exactly like sub-sections do). parent_node_id: the node's DIRECT children.
        let containers: { node: RawSceneNode; container?: string }[];
        let anchored = false;
        const byId = new Map<string, VariantCandidate>();
        let depthCut = 0;
        const addAll = (cands: VariantCandidate[]): void => {
          for (const c of cands) byId.set(c.node.id, c);
        };

        if (args.parent_node_id) {
          // ONE scoped fetch at ANCHOR_DEPTH (wave findings 1/3/8): the anchor's NAME is the
          // container context regardless of its type (an anchor IS the deliberate scope - a
          // FRAME anchor must not silently drop container matching), a matched anchor stops the
          // walk at itself exactly like the whole-file path, and the documented drill-down
          // remedy stays the cheapest call in the tool instead of 1+N.
          const parentId = normalizeNodeId(args.parent_node_id);
          const res = await api.getNodesRaw(parsed.value, [parentId], ANCHOR_DEPTH);
          const doc = res.nodes[parentId]?.document;
          if (!doc) throw new Error(`node ${parentId} not found in file`);
          const found = collectVariantCandidates(doc, queryLower, doc.name, ANCHOR_DEPTH);
          addAll(found.candidates);
          depthCut += found.depthCut;
          containers = [];
          anchored = true;
        } else {
          const file = await api.getDocumentRaw(parsed.value, SKELETON_DEPTH);
          // Skeleton pass: canvas-level frames and the top-level containers themselves are
          // candidates today and must remain so; depth_cut is NOT counted on the skeleton -
          // every skeleton-boundary container is either deep-fetched below or ledgered.
          const skel = collectVariantCandidates(file.document, queryLower, undefined, SKELETON_DEPTH);
          addAll(skel.candidates);
          // Only nodes that can BE or HOLD a candidate join the population: a loose TEXT or
          // VECTOR at page level would cost a REST call each and inflate the ledger denominator
          // with containers that were never searchable (wave finding: leaves as 'containers').
          containers = (file.document.children ?? []).flatMap((p) =>
            (p.children ?? [])
              .filter((c) => CONTAINERISH_TYPES.has(c.type) || CANDIDATE_TYPES.has(c.type))
              .map((c) => ({ node: c, container: p.name })));
        }

        // Skipped entries carry the node_id BESIDE the name (a deliberate divergence from
        // find_nodes' name-only list): every drill note says 'pass parent_node_id' - advice
        // that is unactionable unless the response hands over an id to pass.
        const skippedEntries: { node_id: string; name: string }[] = [];
        let skippedTotal = 0;
        let searched = 0;
        let sawRateLimit = false;
        const skip = (node: RawSceneNode): void => {
          skippedTotal += 1;
          if (skippedEntries.length < COVERAGE_SKIPPED_NAMES_CAP) skippedEntries.push({ node_id: node.id, name: node.name });
        };
        const skipFrom = (idx: number): void => { for (const rest of containers.slice(idx)) skip(rest.node); };

        for (let i = 0; i < containers.length; i += 1) {
          const c = containers[i];
          // Loop-guard, not a first-container guarantee: a genuinely expired deadline aborts
          // the first fetch too (honest FigmaApiError) - this only stops paying for containers
          // 2..N once we KNOW we are past budget.
          if (i > 0 && Date.now() >= deadlineAt) { skipFrom(i); break; }
          // NO name-match early-stop (wave blocker): unlike find_nodes' score===1 - a proven
          // maximum - a name match is a boolean; skeleton-banked matches would abort the deep
          // walk before its first fetch and lose candidates main's depth-3 walk could still see.
          try {
            const res = await walkApi.getNodesRaw(parsed.value, [c.node.id], PER_CONTAINER_DEPTH);
            const doc = res.nodes[c.node.id]?.document;
            if (!doc) { skip(c.node); continue; }
            const found = collectVariantCandidates(doc, queryLower, c.container, PER_CONTAINER_DEPTH);
            addAll(found.candidates);
            depthCut += found.depthCut;
            searched += 1;
          } catch (e) {
            // Dead token kills every remaining fetch - fail the whole call honestly.
            if (e instanceof FigmaApiError && (e.kind === 'auth' || e.kind === 'forbidden')) throw e;
            if (e instanceof FigmaApiError && e.kind === 'rate_limited') {
              // Keep the partial we already paid for; hammering on under 429 is the antipattern.
              sawRateLimit = true;
              skipFrom(i);
              break;
            }
            // timeout/network/anything else: this ONE container failed - ledger it, keep going.
            skip(c.node);
            continue;
          }
        }

        // Name-matches rank ABOVE container-only matches BEFORE the cap (stable insertion order
        // within each group): the deep candidate this line exists to find must not be starved by
        // ten shallow frames that merely sit inside a query-matched section.
        const allCandidates = [...byId.values()];
        const ranked = [...allCandidates.filter((c) => c.nameMatch), ...allCandidates.filter((c) => !c.nameMatch)];
        const capped = ranked.slice(0, MAX_VARIANTS);

        // Anchored calls have a one-element population: the anchor itself, searched by its one
        // scoped fetch - the ledger vocabulary keeps ONE meaning across both paths.
        const total = anchored ? 1 : containers.length;
        if (anchored) searched = 1;
        const coverage = {
          searched, total, skipped: skippedEntries, skippedTotal,
          ...(depthCut > 0 ? { depth_cut: depthCut } : {}),
        };
        const notes: string[] = [];
        if (allCandidates.length > MAX_VARIANTS) {
          notes.push(
            `${allCandidates.length} frames matched "${args.query}" — showing ${MAX_VARIANTS} (name matches first, then container matches, walk order within each group); ` +
            'refine query or pass parent_node_id to narrow the walk.',
          );
        }
        if (searched < total) {
          notes.push(
            `Searched ${searched} of ${total} top-level containers (budget/limit/429) — ${total - searched} unsearched (ids in coverage.skipped); ` +
            'any result below is from the searched slice; pass a skipped entry\'s node_id as parent_node_id to search it.',
          );
        }
        if (depthCut > 0) {
          notes.push(
            `${depthCut} container(s) sit at the walk's depth boundary and were not descended into — a deeper variant may exist; pass parent_node_id to search one.`,
          );
        }

        if (capped.length === 0) {
          const fullCoverage = searched === total && depthCut === 0;
          return jsonResult({
            query: args.query, render_width: args.render_width, tolerance,
            variants: [], match: null, coverage,
            note: [
              fullCoverage
                ? `no FRAME/COMPONENT/COMPONENT_SET matched "${args.query}" by name or container — every container within reach was searched; check the query.`
                : `no FRAME/COMPONENT/COMPONENT_SET matched "${args.query}" within the searched slice — the file may still hold one.`,
              ...notes,
            ].join(' '),
          });
        }

        const variantIds = capped.map((c) => c.node.id);
        // The content fetch shares the deadline; if the budget is already gone, degrade to the
        // walk-time node data instead of failing a call that holds a useful candidate list.
        let contentNodes: Record<string, { document?: RawSceneNode } | null> = {};
        if (sawRateLimit) {
          // The walk just stopped on 429 - firing one more REST call immediately IS the
          // hammering the stop exists to avoid; widths come from the walk slice.
          notes.push('content-frame fetch skipped (rate-limited during the walk) — widths below come from the walk slice and may miss nested content.');
        } else {
          try {
            contentNodes = (await api.getNodesRaw(parsed.value, variantIds, CONTENT_FETCH_DEPTH)).nodes;
          } catch (e) {
            if (e instanceof FigmaApiError && (e.kind === 'auth' || e.kind === 'forbidden' || e.kind === 'rate_limited')) throw e;
            notes.push('content-frame fetch did not complete (budget/limit) — widths below come from the walk slice and may miss nested content.');
          }
        }

        let best: { diff: number; nodeId: string; w: number; variantNodeId: string } | undefined;
        const variantsOut = capped.map((c) => {
          const fetched = contentNodes[c.node.id]?.document ?? c.node;
          const frameW = Math.round(fetched.absoluteBoundingBox?.width ?? 0);
          const content = collectContentCandidates(fetched, args.render_width);

          // The frame's own width competes too - sometimes the frame IS the content.
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
          variants: variantsOut, match, coverage,
          ...(notes.length ? { note: notes.join(' ') } : {}),
        });
      }, deps.noTokenHint),
  );
}
