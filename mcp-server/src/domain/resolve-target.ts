// Pure geometry for design-review boards: resolve a pin's prod-screenshot percentage to the
// concrete node under it in the lane's aligned reference (mockup) frame. The prod screenshot is
// a flat raster (no child nodes), so all semantics come from the reference frame's real subtree.
import type { RawSceneNode } from './figma-raw.js';

export interface Box { x: number; y: number; w: number; h: number }

export function boxOf(n: RawSceneNode): Box | null {
  const b = n.absoluteBoundingBox;
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
}

// Vertical overlap (px) between two boxes — 0 if disjoint on Y.
export function verticalOverlap(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

// Two boxes are in different columns when their X-ranges do not overlap.
export function differentColumn(a: Box, b: Box): boolean {
  return a.x >= b.x + b.w || a.x + a.w <= b.x;
}

// The reference frame for a prod screenshot: among candidates, the one in a DIFFERENT column
// (X-disjoint) with MAXIMUM vertical overlap, requiring that overlap to be at least half the prod
// height (guards against a stray cursor/decoration being mislabeled as the reference).
export function pickReferenceFrame(prodBox: Box, candidates: RawSceneNode[]): RawSceneNode | null {
  let best: RawSceneNode | null = null;
  let bestOverlap = 0;
  for (const c of candidates) {
    const cb = boxOf(c);
    if (!cb) continue;
    if (!differentColumn(prodBox, cb)) continue;
    const ov = verticalOverlap(prodBox, cb);
    if (ov > bestOverlap) { bestOverlap = ov; best = c; }
  }
  return best && bestOverlap >= prodBox.h * 0.5 ? best : null;
}

function contains(b: Box, p: { x: number; y: number }): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}
function isVisible(n: RawSceneNode): boolean {
  return n.visible !== false && n.opacity !== 0;
}

// Deepest visible node containing the point, honoring z-order (later child renders on top).
// Returns the chain from refFrame (inclusive) down to the leaf, or null if the point is outside.
export function hitPath(refFrame: RawSceneNode, point: { x: number; y: number }): RawSceneNode[] | null {
  const rb = boxOf(refFrame);
  if (!rb || !contains(rb, point)) return null;
  const path: RawSceneNode[] = [refFrame];
  let cur = refFrame;
  for (;;) {
    const kids = cur.children ?? [];
    let next: RawSceneNode | null = null;
    for (let i = kids.length - 1; i >= 0; i--) { // topmost-first
      const k = kids[i];
      if (!isVisible(k)) continue;
      const b = boxOf(k);
      if (b && contains(b, point)) { next = k; break; }
    }
    if (!next) break;
    path.push(next);
    cur = next;
  }
  return path;
}

export interface RefPathNode { id: string; name: string; type: string; w?: number; h?: number; suggested?: boolean }
export interface ReferenceNode {
  nodeId: string; name: string; type: string;
  text?: string;
  suggested: { nodeId: string; name: string; type: string };
  path: RefPathNode[];
  pathTruncated?: boolean;
  coarse?: true;
  confidence?: Confidence;
}
export interface Confidence { level: 'high' | 'medium' | 'low'; scaleDiscrepancyPx: number; boundaryMarginPx: number }
export interface ResolveOpts { includeBounds?: boolean }
export type ResolveResult =
  | { ok: true; node: ReferenceNode }
  | { ok: false; reason: 'point_outside_reference' };

// Confidence in the linear atPercent→reference projection for THIS hit, as a per-pin signal.
// scaleDiscrepancyPx (|prodH − refH×(prodW/refW)|, in prod px) is a proxy for the lane's worst-case
// vertical projection drift; boundaryMarginPx (in reference px) is how far the projected point sits
// from the edges of its `suggested` band. The drift bound is converted into reference px
// (× refW/prodW) so the per-pin ratio is unit-consistent for ANY prod/ref width relationship:
//   marginRatio = boundaryMarginPx / max(scaleDiscrepancyPx × refW/prodW, 1)
// marginRatio ≥ 1 ⟹ margin ≥ worst-case drift ⟹ even maximal drift cannot push the true target out
// of the resolved zone ⟹ the answer is provably correct → 'high' (the no-false-high invariant, now
// unconditional in the width relationship). A middling margin → 'medium'; margin ≪ drift → 'low'.
// max(.,1) lets a perfectly-aligned lane (discrepancy ≈ 0) return 'high' for any hit ≥ 1px inside its
// band. Thresholds calibrated on a reference board (see spec). A coarse (frame-only) hit is always 'low'.
export function computeConfidence(
  prodBox: Box, refBox: Box, pointY: number, suggestedBox: Box, coarse: boolean,
): Confidence {
  // Reject zero/negative AND NaN dims (NaN comparisons are false). prodBox.w is a divisor below.
  if (!(refBox.w > 0) || !(refBox.h > 0) || !(prodBox.w > 0)) {
    return { level: 'low', scaleDiscrepancyPx: 0, boundaryMarginPx: 0 };
  }
  const scaleDiscrepancyPx = Math.abs(prodBox.h - refBox.h * (prodBox.w / refBox.w));
  const boundaryMarginPx = Math.max(0, Math.min(pointY - suggestedBox.y, suggestedBox.y + suggestedBox.h - pointY));
  const driftPx = scaleDiscrepancyPx * (refBox.w / prodBox.w);
  const marginRatio = boundaryMarginPx / Math.max(driftPx, 1);
  let level: 'high' | 'medium' | 'low';
  if (coarse) level = 'low';
  else if (marginRatio >= HIGH_MARGIN_RATIO) level = 'high';
  else if (marginRatio >= MEDIUM_MARGIN_RATIO) level = 'medium';
  else level = 'low';
  return { level, scaleDiscrepancyPx: Math.round(scaleDiscrepancyPx), boundaryMarginPx: Math.round(boundaryMarginPx) };
}

const HIGH_MARGIN_RATIO = 1;
const MEDIUM_MARGIN_RATIO = 0.35;
const CONTAINER_TYPES = new Set(['FRAME', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET']);
const COLLAPSE_TYPES = new Set(['GROUP', 'VECTOR', 'BOOLEAN_OPERATION']);
const MAX_PATH_NODES = 8;
const MAX_TEXT_CHARS = 120;

// Build the ReferenceNode payload from a hit chain (root → leaf).
export function buildReferenceNode(chain: RawSceneNode[], opts: ResolveOpts): ReferenceNode {
  const leaf = chain[chain.length - 1];
  // suggested = deepest container in the chain; fall back to the root.
  let suggestedNode = chain[0];
  for (let i = chain.length - 1; i >= 0; i--) {
    if (CONTAINER_TYPES.has(chain[i].type)) { suggestedNode = chain[i]; break; }
  }
  // Collapse pure structural wrappers, but always keep root, leaf and the suggested node.
  const collapsed = chain.filter((n, i) =>
    i === 0 || i === chain.length - 1 || n.id === suggestedNode.id || !COLLAPSE_TYPES.has(n.type));
  // Cap length: keep root + suggested + leaf, fill remaining slots from tail, preserve order.
  let pathNodes = collapsed;
  let truncated = false;
  if (collapsed.length > MAX_PATH_NODES) {
    const leaf = collapsed[collapsed.length - 1];
    // Anchors that must always survive, deduped by id (suggested may equal root or leaf).
    const mustKeep = [collapsed[0], suggestedNode, leaf]
      .filter((n, i, arr) => arr.findIndex((m) => m.id === n.id) === i);
    const keepIds = new Set(mustKeep.map((n) => n.id));
    // Fill remaining budget from the tail (closest context to the leaf), skipping anchors.
    for (let i = collapsed.length - 1; i >= 0 && keepIds.size < MAX_PATH_NODES; i--) {
      keepIds.add(collapsed[i].id);
    }
    pathNodes = collapsed.filter((n) => keepIds.has(n.id)); // original (ancestor) order, ≤ 8
    truncated = true;
  }
  const toPathNode = (n: RawSceneNode): RefPathNode => {
    const out: RefPathNode = { id: n.id, name: n.name, type: n.type };
    if (opts.includeBounds) { const b = boxOf(n); if (b) { out.w = b.w; out.h = b.h; } }
    if (n.id === suggestedNode.id) out.suggested = true;
    return out;
  };
  const ref: ReferenceNode = {
    nodeId: leaf.id, name: leaf.name, type: leaf.type,
    suggested: { nodeId: suggestedNode.id, name: suggestedNode.name, type: suggestedNode.type },
    path: pathNodes.map(toPathNode),
  };
  if (leaf.type === 'TEXT' && typeof leaf.characters === 'string') {
    ref.text = leaf.characters.length > MAX_TEXT_CHARS ? leaf.characters.slice(0, MAX_TEXT_CHARS) + '…' : leaf.characters;
  }
  if (truncated) ref.pathTruncated = true;
  if (chain.length === 1) ref.coarse = true;
  return ref;
}

// Map a pin's prod-relative percentage into the reference frame's coordinate space and resolve
// the node under it. atPercent is relative to the prod screenshot; we transplant it onto the
// reference frame assuming both depict the same screen at (possibly) different scales.
export function resolveReferenceNode(
  refFrame: RawSceneNode,
  atPercent: { x: number; y: number },
  prodBox: Box,
  opts: ResolveOpts,
): ResolveResult {
  const rb = boxOf(refFrame);
  if (!rb) return { ok: false, reason: 'point_outside_reference' };
  const point = { x: rb.x + atPercent.x * rb.w, y: rb.y + atPercent.y * rb.h };
  const chain = hitPath(refFrame, point);
  if (!chain) return { ok: false, reason: 'point_outside_reference' };
  const refNode = buildReferenceNode(chain, opts);
  // suggested is always one of the chain nodes; its band gives the boundary margin.
  const suggestedNode = chain.find((n) => n.id === refNode.suggested.nodeId) ?? chain[0];
  const sb = boxOf(suggestedNode);
  if (sb) refNode.confidence = computeConfidence(prodBox, rb, point.y, sb, refNode.coarse === true);
  return { ok: true, node: refNode };
}
