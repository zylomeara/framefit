// Server-side graceful degradation: when a tree serializes over budget, re-prune
// it to a shallower depth (down to 1) instead of refusing. Generic over any node
// with optional children/truncated (SimplifiedNode and SparseNode both qualify).
export function pruneToDepth<T extends { children?: T[]; truncated?: boolean }>(
  node: T,
  depth: number,
  onTruncate?: (out: T, childCount: number) => void,
): T {
  const out: T = { ...node };
  const kids = node.children;
  if (kids && kids.length) {
    if (depth <= 0) {
      delete out.children;
      out.truncated = true;
      onTruncate?.(out, kids.length);
    } else {
      out.children = kids.map((c) => pruneToDepth(c, depth - 1, onTruncate));
    }
  }
  return out;
}

export interface FitResult<T> { node: T; depth: number; degraded: boolean }

export function fitToBudget<T extends { children?: T[]; truncated?: boolean }>(
  node: T,
  startDepth: number,
  budget: number,
  sizeOf: (n: T) => number,
  onTruncate?: (out: T, childCount: number) => void,
): FitResult<T> {
  if (sizeOf(node) <= budget) return { node, depth: startDepth, degraded: false };
  for (let d = startDepth - 1; d >= 1; d--) {
    const pruned = pruneToDepth(node, d, onTruncate);
    if (sizeOf(pruned) <= budget || d === 1) {
      return { node: pruned, depth: d, degraded: true };
    }
  }
  return { node: pruneToDepth(node, 1, onTruncate), depth: 1, degraded: true };
}

// get_metadata-specific budget fit: instead of one global depth (fitToBudget), greedily
// deepen branch by branch so light branches show depth 2-3 while heavy ones stay shallow.
// The full subtree is already materialized in memory, so this is purely client-side.
export function fitToBudgetPerBranch<
  T extends { id: string; children?: T[]; truncated?: boolean; childCount?: number },
>(
  root: T,
  startDepth: number,
  budget: number,
  sizeOf: (n: T) => number,
): { node: T; effectiveDepth: number; minEffectiveDepth: number; degraded: boolean } {
  // Render a pruned copy: a node's children are shown iff its id ∈ expanded.
  const build = (node: T, expanded: Set<string>): T => {
    const out: T = { ...node };
    const kids = node.children;
    if (kids && kids.length) {
      if (expanded.has(node.id)) {
        out.children = kids.map((c) => build(c, expanded));
      } else {
        delete out.children;
        out.truncated = true;
        out.childCount = kids.length;
      }
    }
    return out;
  };

  if (sizeOf(root) <= budget) {
    return { node: root, effectiveDepth: startDepth, minEffectiveDepth: startDepth, degraded: false };
  }

  // Baseline = depth 1 (only root expanded). Then deepen, cheapest subtree first, committing
  // an expansion whenever the whole tree still fits. Cost (full-subtree JSON length) only orders attempts.
  const expanded = new Set<string>([root.id]);
  const costCache = new Map<string, number>();
  const costOf = (n: T): number => {
    let c = costCache.get(n.id);
    if (c === undefined) { c = JSON.stringify(n).length; costCache.set(n.id, c); }
    return c;
  };

  // If even the depth-1 baseline (all direct children truncated) exceeds budget, no expansion
  // can help — expansions only grow the tree. Skip the frontier loop (avoids O(width) futile attempts).
  if (sizeOf(build(root, expanded)) <= budget) {
    let frontier = (root.children ?? []).filter((c) => c.children && c.children.length);
    while (frontier.length) {
      frontier.sort((a, b) => costOf(a) - costOf(b) || a.id.localeCompare(b.id));
      const next: T[] = [];
      for (const node of frontier) {
        expanded.add(node.id);
        if (sizeOf(build(root, expanded)) <= budget) {
          for (const c of node.children ?? []) if (c.children && c.children.length) next.push(c);
        } else {
          expanded.delete(node.id); // revert — branch stays truncated
        }
      }
      frontier = next;
    }
  }

  const node = build(root, expanded);
  let effectiveDepth = 0;
  let minTruncated: number | null = null;
  const walk = (n: T, depth: number): void => {
    if (depth > effectiveDepth) effectiveDepth = depth;
    if (n.truncated) minTruncated = minTruncated === null ? depth : Math.min(minTruncated, depth);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(node, 0);
  return { node, effectiveDepth, minEffectiveDepth: minTruncated ?? effectiveDepth, degraded: true };
}
