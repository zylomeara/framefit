import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { COMPOUND_NODE_ID_RE, normalizeCompoundNodeId } from '../../../domain/node-id.js';
import { resolveAncestry } from '../../../application/node-ancestry.js';
import type { RawSceneNode } from '../../../domain/figma-raw.js';

// Cap per breadcrumb (not per whole result): a single ancestor's own children list, sorted then
// sliced. Overflow is reported honestly via childrenTruncated/childrenTotal — never silently dropped.
export const ANCESTRY_CHILDREN_CAP = 15;

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42", or a compound instance-path id like "I1:2;3:4"')
    .describe('A node you already know (anywhere in the file). Ancestry is resolved UP from it to the page.'),
  query: z.string().min(2).optional()
    .describe('Highlight ancestor children whose name contains this substring (case-insensitive) — surfaces neighbors even beyond the per-ancestor cap.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

interface ChildEntry {
  id: string;
  name: string;
  type: string;
  w?: number;
  h?: number;
  isTarget?: true;
  onPath?: true;
}

interface Breadcrumb {
  id: string;
  name: string;
  type: string;
  w?: number;
  h?: number;
  children: ChildEntry[];
  childrenTruncated?: true;
  childrenTotal?: number;
}

function boxFields(n: RawSceneNode): { w?: number; h?: number } {
  const b = n.absoluteBoundingBox;
  return b ? { w: b.width, h: b.height } : {};
}

// Local comparator — deliberately NOT the projector's sortByAxis (unexported, layout-diff shaped:
// it pre-filters to inFlowChildren and asserts a non-null bbox). Navigation needs the opposite:
// every child stays (hidden/absolute/zero-size included), and a child with no bbox at all — rather
// than crashing — just falls to the tail in document order.
function sortAncestryChildren(children: RawSceneNode[], layoutMode?: string): RawSceneNode[] {
  if (layoutMode !== 'HORIZONTAL' && layoutMode !== 'VERTICAL') return children; // document order
  const withBox: RawSceneNode[] = [];
  const withoutBox: RawSceneNode[] = [];
  for (const c of children) (c.absoluteBoundingBox ? withBox : withoutBox).push(c);
  const axisValue = (n: RawSceneNode): number =>
    layoutMode === 'HORIZONTAL' ? n.absoluteBoundingBox!.x : n.absoluteBoundingBox!.y;
  withBox.sort((a, b) => axisValue(a) - axisValue(b));
  return [...withBox, ...withoutBox]; // no-bbox children keep their relative document order, in the tail
}

// One breadcrumb per path node, its own full children list (no inFlowChildren filter — this is
// navigation, not a layout diff; a zero-size or hidden target must still be visible among its
// parent's children). query_hits below searches the FULL list too (pre-cap) — a name beyond the
// cap is exactly the kind of buried neighbor this tool exists to surface.
function buildBreadcrumbs(
  path: RawSceneNode[],
  resolvedTargetId: string,
): { breadcrumbs: Breadcrumb[]; scope: { ancestorId: string; child: RawSceneNode }[] } {
  const pathIds = new Set(path.map((p) => p.id));
  const breadcrumbs: Breadcrumb[] = [];
  const scope: { ancestorId: string; child: RawSceneNode }[] = [];

  for (const node of path) {
    const all = node.children ?? [];
    for (const child of all) scope.push({ ancestorId: node.id, child });

    const sorted = sortAncestryChildren(all, node.layoutMode);
    const total = sorted.length;
    const truncated = total > ANCESTRY_CHILDREN_CAP;
    // Reserved slots: the isTarget row and any onPath row are load-bearing — "the target is always
    // visible among its parent's children" is this tool's core invariant, and the onPath row is the
    // link that continues the chain on non-terminal breadcrumbs. Both survive the cap regardless of
    // their sorted position; the remaining slots fill in sorted order, and the output keeps the
    // overall sort order (a reserved row past the cap appears after the plain rows that precede it).
    let visible: RawSceneNode[];
    if (!truncated) {
      visible = sorted;
    } else {
      const selected = new Set<string>(
        sorted.filter((c) => c.id === resolvedTargetId || pathIds.has(c.id)).map((c) => c.id),
      );
      for (const c of sorted) {
        if (selected.size >= ANCESTRY_CHILDREN_CAP) break;
        selected.add(c.id);
      }
      visible = sorted.filter((c) => selected.has(c.id));
    }
    const children: ChildEntry[] = visible.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      ...boxFields(c),
      ...(c.id === resolvedTargetId ? { isTarget: true as const } : {}),
      ...(pathIds.has(c.id) ? { onPath: true as const } : {}),
    }));

    breadcrumbs.push({
      id: node.id,
      name: node.name,
      type: node.type,
      ...boxFields(node),
      children,
      ...(truncated ? { childrenTruncated: true as const, childrenTotal: total } : {}),
    });
  }

  return { breadcrumbs, scope };
}

function queryHits(
  scope: { ancestorId: string; child: RawSceneNode }[],
  query: string,
): { id: string; name: string; ancestor_id: string }[] {
  const q = query.toLowerCase();
  const hits: { id: string; name: string; ancestor_id: string }[] = [];
  for (const { ancestorId, child } of scope) {
    if (child.name.toLowerCase().includes(q)) {
      hits.push({ id: child.id, name: child.name, ancestor_id: ancestorId });
    }
  }
  return hits;
}

export function registerGetNodeAncestryTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'get_node_ancestry',
    'Breadcrumbs from a node UP to its page + direct children of every ancestor (siblings/neighbors). ' +
      'Use when the node you need lies OUTSIDE the frame you know: call on a nearby known node and read ' +
      'the ancestor children. bbox-guided, id-confirmed, ≤12 light REST calls — never fetches the whole ' +
      'file. query highlights matching names in scope.',
    InputSchema,
    async (args) =>
      runTool('get_node_ancestry', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const id = normalizeCompoundNodeId(args.node_id);

        const deadlineAt = Date.now() + (deps.toolTimeBudgetMs ?? 90_000);
        const api = deps.buildApi(token, undefined, deadlineAt);
        const result = await resolveAncestry(api, parsed.value, id, { deadlineAt });

        const { breadcrumbs, scope } = buildBreadcrumbs(result.path, result.target.id);
        const out: Record<string, unknown> = {
          target: result.target,
          breadcrumbs,
          confirmed: result.confirmed,
        };
        if (!result.confirmed) out.ambiguous = true;
        if (result.note) out.note = result.note;
        if (args.query !== undefined) out.query_hits = queryHits(scope, args.query);
        out.callsUsed = result.callsUsed;

        return jsonResult(out);
      }, deps.noTokenHint),
  );
}
