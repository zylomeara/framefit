// Pure variable-mode inheritance. Figma REST gives only explicitVariableModes
// (collectionId -> modeId) per node; the effective mode of a node for a collection is
// the nearest ancestor (incl. self) that sets it, else the collection's default mode.
import type { RawSceneNode } from './figma-raw.js';
import { collectionLibKey } from './variable-graph.js';
import { extractLibraryKey } from './variable-snapshot.js';   // no cycle (variable-snapshot is a leaf module) — direct import

export type ModeStack = Map<string, string>; // collectionId -> modeId

function merge(base: ModeStack, explicit: Record<string, string> | undefined): ModeStack {
  // Always allocate a fresh map so every per-node stack is a distinct instance —
  // never alias the inherited stack across the ancestor chain or across sibling leaves.
  const next = new Map(base);
  if (explicit) for (const [coll, mode] of Object.entries(explicit)) next.set(coll, mode);
  return next;
}

/** nodeId -> effective ModeStack, accumulated from `root` down through descendants. */
export function collectSubtreeModes(root: RawSceneNode): Map<string, ModeStack> {
  const out = new Map<string, ModeStack>();
  const walk = (n: RawSceneNode, inherited: ModeStack): void => {
    const here = merge(inherited, n.explicitVariableModes);
    out.set(n.id, here);
    for (const c of n.children ?? []) walk(c, here);
  };
  walk(root, new Map());
  return out;
}

// ── Gate-on-demand for ancestor-mode discovery ────────────────────────────
// "Does the subtree hold at least one visible-SOLID fill/stroke with a bound color variable?" —
// a BYTE-EXACT mirror of the resolveColorToken predicate (compare-tool :189): SOLID only,
// p.visible !== false only, boundVariables.color only. NO gradientStops/other keys (wider —
// over-triggers on cost; narrower — false-negative skip → lost mode). Walk WITHOUT the node-visible
// filter (the collectSubtreeModes pattern): the projector resolves fills/strokes even on an invisible node
// (a self-gate on n.visible would give a false-negative gate at a pair's root).
const nodeHasBoundSolid = (n: RawSceneNode): boolean =>
  (['fills', 'strokes'] as const).some((key) =>
    (n[key] ?? []).some((p) => p.visible !== false && p.type === 'SOLID' && p.boundVariables?.color?.id !== undefined));
export function hasBoundPaintColor(root: RawSceneNode): boolean {
  if (nodeHasBoundSolid(root)) return true;
  return (root.children ?? []).some((c) => hasBoundPaintColor(c));
}

// ── variables-400 fallback: gate-on-demand for the graph/snapshot fallback ──────────────────────
// Like hasBoundPaintColor, but the id MUST carry a published key (extractLibraryKey !== null):
// without a local index the graph/snapshot can resolve ONLY those. Local-only
// subtrees do not trigger discovery (otherwise the whole file burns for nothing
// and eats the shared deadline of neighbouring pairs). Same walk, without the node-visible filter.
const nodeHasExternalBoundSolid = (n: RawSceneNode): boolean =>
  (['fills', 'strokes'] as const).some((key) =>
    (n[key] ?? []).some((p) => p.visible !== false && p.type === 'SOLID'
      && p.boundVariables?.color?.id !== undefined && extractLibraryKey(p.boundVariables.color.id) !== null));
export function hasExternalBoundPaintColor(root: RawSceneNode): boolean {
  if (nodeHasExternalBoundSolid(root)) return true;
  return (root.children ?? []).some((c) => hasExternalBoundPaintColor(c));
}

// unique published keys of the subtree's PAINT-level bound-SOLID paints — input to the snapshot prefetch.
// NOT the node-level collectExternalAliasIds (design-context): compare resolves at paint level, a node-level
// collector would return [] and kill the snapshot half.
export function collectExternalPaintKeys(root: RawSceneNode): Set<string> {
  const keys = new Set<string>();
  const walk = (n: RawSceneNode): void => {
    for (const key of ['fills', 'strokes'] as const) {
      for (const p of n[key] ?? []) {
        if (p.visible === false || p.type !== 'SOLID') continue;
        const id = p.boundVariables?.color?.id;
        const k = id !== undefined ? extractLibraryKey(id) : null;
        if (k !== null) keys.add(k);
      }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return keys;
}

// ── The document ancestor chain of the target within the raw subtree ────────────────────────────
// [root .. parent(target)] in root→parent order (input to buildModeByCollection); [] if the target
// is root itself; undefined if the target is beyond the subtree slice. The id match normalizes the leading 'I'
// (compound pairs arrive with and without it; raw inside the subtree is always 'I…;…').
// Invariant: in a depth-sliced tree a node is never without a parent →
// located ⟹ the chain is COMPLETE at any held_depth. The DOCUMENT TREE only — geometry
// (resolveAncestry) must not be used for modes (a geometric ancestor ≠ a document ancestor).
const stripI = (id: string): string => (id.startsWith('I') ? id.slice(1) : id);
export function ancestorChainFromSubtree(root: RawSceneNode, targetId: string): RawSceneNode[] | undefined {
  const want = stripI(targetId);
  const walk = (n: RawSceneNode, path: RawSceneNode[]): RawSceneNode[] | undefined => {
    if (stripI(n.id) === want) return path;
    for (const c of n.children ?? []) {
      const r = walk(c, [...path, n]);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return walk(root, []);
}

// Latency prefilter of target-descent candidates. GEOMETRY only picks who to try
// (membership is proven documentarily by children-id in the tool); intersects (not containment, ε=1px)
// catches overflow/rotation/clip cases; a candidate without a bbox passes conservatively.
export type DescentBox = { x: number; y: number; width: number; height: number };
const DESCENT_CONTAINER_TYPES = new Set(['SECTION', 'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET']);
export function boxIntersects(a: DescentBox, b: DescentBox, eps = 1): boolean {
  return a.x - eps <= b.x + b.width && b.x - eps <= a.x + a.width
    && a.y - eps <= b.y + b.height && b.y - eps <= a.y + a.height;
}
export function pickDescentCandidates(containers: readonly RawSceneNode[], frameBox: DescentBox): RawSceneNode[] {
  return containers.filter((c) => DESCENT_CONTAINER_TYPES.has(c.type)
    && (c.absoluteBoundingBox == null || boxIntersects(c.absoluteBoundingBox, frameBox)));
}
export const sceneIdEquals = (a: string, b: string): boolean => stripI(a) === stripI(b);

/** Fold an ancestor chain (root -> parent order); deeper entries override shallower. */
export function ancestorModes(ancestorsRootToParent: RawSceneNode[]): ModeStack {
  let stack: ModeStack = new Map();
  for (const a of ancestorsRootToParent) stack = merge(stack, a.explicitVariableModes);
  return stack;
}

/**
 * nodeId -> the ORDERED node chain [root, …, node] (root first, node last) for every node in the
 * subtree under `root`. Unlike `collectSubtreeModes` (which folds each node's inherited modes into
 * a flat map by EXACT id), this preserves the raw nodes in nearest-last order so a caller can apply
 * a LIBRARY-KEY fold (`buildModeByCollection`) over the FULL chain — the merge with above-root
 * ancestors then de-dupes two subscribed-instance suffixes of the same library collection, keeping
 * the nearest node's mode first for the graph resolver's lib-key first-match scan.
 */
export function collectSubtreeChains(root: RawSceneNode): Map<string, RawSceneNode[]> {
  const out = new Map<string, RawSceneNode[]>();
  const walk = (n: RawSceneNode, chain: RawSceneNode[]): void => {
    const here = [...chain, n];
    out.set(n.id, here);
    for (const c of n.children ?? []) walk(c, here);
  };
  walk(root, []);
  return out;
}

/**
 * Fold an ancestor chain (root -> parent order) into a flat collectionId -> modeId map with
 * NEAREST-ancestor-wins, DE-DUPED BY LIBRARY KEY. The graph resolver (resolveKeyInMode) matches a
 * collection by its library key and, on that lib-key fallback, returns the FIRST map-order
 * entry. So when two ancestor levels set the SAME library collection — possibly under different
 * subscribed-instance id suffixes (`<key>/<a>` vs `<key>/<b>`) — we keep only the nearest
 * ancestor's mode AND place it first in map order, so the resolver picks the nearest one.
 *
 * Differs from `ancestorModes` (which folds by EXACT id, so two different suffixes with the same
 * library key would BOTH survive and the shallower could win the resolver's first-match scan).
 */
export function buildModeByCollection(ancestorsRootToParent: RawSceneNode[]): ModeStack {
  const out: ModeStack = new Map();
  const seenLibKeys = new Set<string>();
  // Walk NEAREST -> farthest (parent -> root) so the first entry kept per library key is the
  // nearest ancestor's, and appears first in insertion (map) order.
  for (let i = ancestorsRootToParent.length - 1; i >= 0; i--) {
    const explicit = ancestorsRootToParent[i].explicitVariableModes;
    if (!explicit) continue;
    for (const [coll, mode] of Object.entries(explicit)) {
      const libKey = collectionLibKey(coll);
      if (seenLibKeys.has(libKey)) continue;   // a nearer ancestor already pinned this collection
      seenLibKeys.add(libKey);
      out.set(coll, mode);
    }
  }
  return out;
}

export function effectiveMode(
  stack: ModeStack, collectionId: string, defaultModeId: string | undefined,
): { modeId: string; source: 'node' | 'default' } | null {
  const hit = stack.get(collectionId);
  if (hit !== undefined) return { modeId: hit, source: 'node' };
  if (defaultModeId !== undefined) return { modeId: defaultModeId, source: 'default' };
  return null;
}
