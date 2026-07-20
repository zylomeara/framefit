// mcp-server/src/domain/metadata.ts
// Sparse navigation tree: id/name/type + position/size only, depth-limited. The
// agent uses this as a cheap map, then fetches design context for a chosen node.
import type { RawSceneNode } from './figma-raw.js';

export interface SparseNode {
  id: string;
  name: string;
  type: string;
  hidden?: boolean; // node.visible === false
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  truncated?: boolean; // true when children existed but depth cut them off
  childCount?: number; // direct child count of a truncated node (how many were dropped)
  children?: SparseNode[];
}

export function toSparseTree(node: RawSceneNode, depth: number): SparseNode {
  const out: SparseNode = { id: node.id, name: node.name, type: node.type };
  if (node.visible === false) out.hidden = true;
  const box = node.absoluteBoundingBox;
  if (box) {
    out.x = box.x;
    out.y = box.y;
    out.w = box.width;
    out.h = box.height;
  }
  const kids = node.children ?? [];
  if (kids.length > 0) {
    if (depth <= 0) {
      out.truncated = true;
      out.childCount = kids.length;
    } else {
      out.children = kids.map((c) => toSparseTree(c, depth - 1));
    }
  }
  return out;
}

export function countTruncated(node: SparseNode): number {
  let n = node.truncated ? 1 : 0;
  for (const c of node.children ?? []) n += countTruncated(c);
  return n;
}
