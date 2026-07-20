import type { LayoutSpec, SpecChild, Edges } from './types.js';
import type { RawSceneNode } from '../figma-raw.js';
// reuse the projector's in-flow predicate — exported from projector.ts as inFlowSceneChildren:
import { inFlowSceneChildren } from './projector.js';

export interface SpacingContainer { node_id: string; name: string; axis?: 'row' | 'col'; gap?: number; derived_gaps: number[]; paddings?: Edges }
export interface SpacingView { containers: SpacingContainer[] }

// Inter-child gaps derived from geometry along the axis (edge-to-edge of consecutive in-flow children).
function derivedGaps(kids: SpecChild[], axis?: 'row' | 'col'): number[] {
  if (!axis || kids.length < 2) return [];
  const sorted = [...kids].sort((a, b) => (axis === 'row' ? a.rect.x - b.rect.x : a.rect.y - b.rect.y));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].rect, cur = sorted[i].rect;
    gaps.push(Math.round(axis === 'row' ? cur.x - (prev.x + prev.w) : cur.y - (prev.y + prev.h)));
  }
  return gaps;
}

export function buildSpacing(spec: LayoutSpec): SpacingView {
  const containers: SpacingContainer[] = [];
  const visit = (node: { node?: { id: string; name: string }; id?: string; name?: string; axis?: 'row' | 'col';
    autoLayout?: { gap?: number; padding: Edges }; paddings?: Edges; children?: SpecChild[] }, isRoot: boolean) => {
    const kids = node.children;
    if (kids && kids.length) {
      const axis = isRoot ? (node as LayoutSpec).axis : (node as SpecChild).axis;
      containers.push({
        node_id: isRoot ? (node as LayoutSpec).node.id : (node as SpecChild).id,
        name: isRoot ? (node as LayoutSpec).node.name : (node as SpecChild).name,
        ...(axis ? { axis } : {}),
        ...(isRoot && (node as LayoutSpec).autoLayout?.gap !== undefined ? { gap: (node as LayoutSpec).autoLayout!.gap } : {}),
        derived_gaps: derivedGaps(kids, axis),
        ...(isRoot ? ((node as LayoutSpec).autoLayout ? { paddings: (node as LayoutSpec).autoLayout!.padding } : {})
                   : ((node as SpecChild).paddings ? { paddings: (node as SpecChild).paddings } : {})),
      });
      for (const k of kids) visit(k, false);
    }
  };
  visit(spec, true);
  return { containers };
}

export interface CoverageContainer { node_id: string; name: string; axis?: 'row' | 'col'; child_count: number; spacing_checkable: boolean }
export interface CoverageView { containers: CoverageContainer[] }

export function buildCoverage(spec: LayoutSpec): CoverageView {
  const containers: CoverageContainer[] = [];
  const visit = (node: any, isRoot: boolean) => {
    const kids: SpecChild[] | undefined = node.children;
    if (kids && kids.length) {
      const axis = isRoot ? (node as LayoutSpec).axis : (node as SpecChild).axis;
      containers.push({
        node_id: isRoot ? node.node.id : node.id, name: isRoot ? node.node.name : node.name,
        ...(axis ? { axis } : {}), child_count: kids.length,
        spacing_checkable: !!axis && kids.length >= 2,   // auto-layout + ≥2 in-flow children → gap rows
      });
      for (const k of kids) visit(k, false);
    }
  };
  visit(spec, true);
  return { containers };
}

export interface SkeletonNode {
  node_id: string; type: string; name: string; child_count: number; axis?: 'row' | 'col';
  collapsed?: string[]; children?: SkeletonNode[];
  repeated?: { count: number; of: string; signature: string; variant_shapes?: number };
  truncated?: boolean;
}

const REPEAT_MIN = 3;  // summarize runs of ≥3 identical-signature siblings (calibration-tunable)

// Structural signature: type + name + immediate child-shape (child types in order). Two siblings with
// the same signature are interchangeable-shaped; a child-shape difference yields a DIFFERENT signature
// so it can never be summarized away (the never-false-green guard).
function signatureOf(n: RawSceneNode): string {
  const kids = inFlowSceneChildren(n);
  return `${n.type}|${n.name}|${kids.map((c) => c.type).join(',')}`;
}

function skel(n: RawSceneNode, depthLeft: number): SkeletonNode {
  // collapse single-child wrapper chain, retaining ids
  const collapsed: string[] = [];
  let cur = n;
  let kids = inFlowSceneChildren(cur);
  while (kids.length === 1 && depthLeft > 0) { collapsed.push(cur.id); cur = kids[0]; kids = inFlowSceneChildren(cur); depthLeft--; }
  const axis = (cur as any).layoutMode === 'HORIZONTAL' ? 'row' : (cur as any).layoutMode === 'VERTICAL' ? 'col' : undefined;
  const node: SkeletonNode = { node_id: cur.id, type: cur.type, name: cur.name, child_count: kids.length,
    ...(axis ? { axis } : {}), ...(collapsed.length ? { collapsed } : {}) };
  if (kids.length === 0 || depthLeft <= 0) { if (kids.length > 0) node.truncated = true; return node; }

  // group children by signature, preserving order; summarize runs of ≥ REPEAT_MIN
  const out: SkeletonNode[] = [];
  let i = 0;
  while (i < kids.length) {
    const sig = signatureOf(kids[i]);
    let j = i; while (j < kids.length && signatureOf(kids[j]) === sig) j++;
    const run = j - i;
    if (run >= REPEAT_MIN) {
      // count how many DISTINCT signatures share this run's NAME across the whole sibling set (variant flag)
      const sameName = kids.filter((k) => k.name === kids[i].name);
      const distinct = new Set(sameName.map(signatureOf)).size;
      out.push({ node_id: kids[i].id, type: kids[i].type, name: kids[i].name, child_count: inFlowSceneChildren(kids[i]).length,
        repeated: { count: run, of: kids[i].name || kids[i].type, signature: sig, ...(distinct > 1 ? { variant_shapes: distinct } : {}) } });
    } else {
      for (let k = i; k < j; k++) out.push(skel(kids[k], depthLeft - 1));
    }
    i = j;
  }
  node.children = out;
  return node;
}

export function buildSkeleton(raw: RawSceneNode, maxDepth: number): SkeletonNode {
  return skel(raw, Math.min(8, Math.max(1, maxDepth)));
}
