import type { LayoutSpec, SpecChild } from './types.js';

export interface HydrationReceipt {
  node_id: string;
  /** Depth the frame raw is held at (shared across all nodes of one getFrameRaw call). */
  held_depth: number;
  /** Whether the frame is actually held (within parse cap). false → every drill re-fetches. */
  hydrated: boolean;
  /** Highest max_depth that re-slices for FREE from the held raw (heldDepth-1). */
  drill_free_upto: number;
  cause_breakdown: { depth: number; breadth: number; budget: number };
  /** Cause-gated guidance; omitted when there is nothing truncated. */
  note?: string;
}

function countCauses(spec: LayoutSpec): { depth: number; breadth: number; budget: number } {
  const acc = { depth: 0, breadth: 0, budget: 0 };
  const bump = (n: { childrenTruncated?: boolean; truncationCause?: 'depth' | 'breadth' | 'budget' }) => {
    if (n.childrenTruncated && n.truncationCause) acc[n.truncationCause] += 1;
  };
  const walk = (nodes?: SpecChild[]) => {
    for (const n of nodes ?? []) { bump(n); walk(n.children); }
  };
  bump(spec);
  walk(spec.children);
  return acc;
}

/**
 * Build the per-node drill-receipt. The note is cause-gated (spec Section 2):
 *  - depth cut + a strictly-deeper raw already held → BACKED positive (free re-slice).
 *  - depth cut + nothing deeper held → honest hedge (re-call max_depth:N will RE-FETCH deeper).
 *  - breadth/budget cut → honest hedge that NEVER promises a deeper-max_depth remedy (those caps are
 *    depth-invariant); points at text_leaves / narrowing node_ids instead.
 * Never claims held when hydrated is false.
 */
export function buildHydrationReceipt(
  nodeId: string,
  spec: LayoutSpec,
  frame: { heldDepth: number; hydrated: boolean; effectiveMaxDepth: number },
): HydrationReceipt {
  const cause_breakdown = countCauses(spec);
  const drill_free_upto = frame.heldDepth - 1;
  const backedDepth = frame.hydrated && cause_breakdown.depth > 0 && drill_free_upto > frame.effectiveMaxDepth;

  let note: string | undefined;
  if (cause_breakdown.depth > 0 && backedDepth) {
    note = `${cause_breakdown.depth} node(s) cut by DEPTH at max_depth:${frame.effectiveMaxDepth}; ` +
      `deeper levels are ALREADY HELD in cache — re-request max_depth:${drill_free_upto} for a free ` +
      `re-slice (no round-trip to Figma). held_depth=${frame.heldDepth}.`;
  } else if (cause_breakdown.depth > 0) {
    note = `${cause_breakdown.depth} node(s) cut by DEPTH below max_depth:${frame.effectiveMaxDepth}; ` +
      `re-request max_depth:${frame.effectiveMaxDepth + 1}+ — this is a real deeper fetch (NOT yet cached), not free.`;
  }
  const breadthBudget = cause_breakdown.breadth + cause_breakdown.budget;
  if (breadthBudget > 0) {
    const hedge = `${breadthBudget} container(s) cut by breadth/total-node caps (do NOT depend on ` +
      `max_depth — a higher max_depth will NOT reveal them); for text use text_leaves, or narrow node_ids.`;
    note = note ? `${note} ${hedge}` : hedge;
  }

  return { node_id: nodeId, held_depth: frame.heldDepth, hydrated: frame.hydrated, drill_free_upto, cause_breakdown, note };
}
