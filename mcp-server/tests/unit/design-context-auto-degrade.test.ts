import { describe, it, expect } from 'vitest';
import { pruneToDepth, fitToBudget } from '../../src/domain/design-context/auto-degrade.js';
import type { SimplifiedNode } from '../../src/domain/design-context/types.js';

// root → a → a1
//      → b
const tree: SimplifiedNode = {
  id: 'root', name: 'root', type: 'FRAME',
  children: [
    {
      id: 'a', name: 'a', type: 'FRAME',
      children: [{ id: 'a1', name: 'a1', type: 'RECTANGLE' }],
    },
    { id: 'b', name: 'b', type: 'RECTANGLE' },
  ],
};

describe('pruneToDepth', () => {
  it('depth=1 removes grandchildren and flags truncated on cut nodes', () => {
    const pruned = pruneToDepth(tree, 1);
    expect(pruned.children).toHaveLength(2);
    const a = pruned.children![0];
    expect(a.children).toBeUndefined();
    expect(a.truncated).toBe(true);
    // b has no children — no truncated flag
    expect(pruned.children![1].truncated).toBeUndefined();
  });

  it('depth=2 keeps grandchildren without truncated flag', () => {
    const pruned = pruneToDepth(tree, 2);
    const a = pruned.children![0];
    expect(a.children).toHaveLength(1);
    expect(a.truncated).toBeUndefined();
  });
});

describe('fitToBudget', () => {
  const small = (n: SimplifiedNode) => JSON.stringify(n).length;

  it('already-fits returns the same node, original depth, degraded:false', () => {
    const result = fitToBudget(tree, 4, 100000, small);
    expect(result.node).toBe(tree);
    expect(result.depth).toBe(4);
    expect(result.degraded).toBe(false);
  });

  it('mid-budget forces degrade to depth 1 with truncated on cut nodes', () => {
    // budget just enough for depth-1 but not full tree
    const fullSize = small(tree);
    const depth1 = pruneToDepth(tree, 1);
    const depth1Size = small(depth1);
    const budget = depth1Size + 10; // fits depth-1 but not full
    // only run if full tree actually exceeds budget
    if (fullSize <= budget) return; // guard: if tiny tree fits, skip
    const result = fitToBudget(tree, 4, budget, small);
    expect(result.degraded).toBe(true);
    expect(result.depth).toBeLessThan(4);
    expect(result.node.children![0].truncated).toBe(true);
  });

  it('mid-budget degrade carries childCount via onTruncate', () => {
    const fullSize = small(tree);
    const depth1 = pruneToDepth(tree, 1);
    const depth1Size = small(depth1);
    const budget = depth1Size + 10;
    if (fullSize <= budget) return;
    const onTruncate = (out: SimplifiedNode, count: number) => { out.childCount = count; };
    const result = fitToBudget(tree, 4, budget, small, onTruncate);
    expect(result.degraded).toBe(true);
    expect(result.node.children![0].truncated).toBe(true);
    expect(result.node.children![0].childCount).toBe(1); // 'a' had one child ('a1') cut
  });

  it('budget=1 (tiny) always returns depth-1 floor degraded', () => {
    const result = fitToBudget(tree, 4, 1, small);
    expect(result.degraded).toBe(true);
    expect(result.depth).toBe(1);
  });
});

describe('auto-degrade generic over any {children, truncated} tree', () => {
  type Sparse = { id: string; name: string; type: string; truncated?: boolean; children?: Sparse[] };
  const tree: Sparse = {
    id: '0', name: 'root', type: 'FRAME',
    children: [{ id: '1', name: 'a', type: 'FRAME', children: [{ id: '2', name: 'b', type: 'TEXT' }] }],
  };

  it('prunes a SparseNode-shaped tree and sets truncated', () => {
    const pruned = pruneToDepth(tree, 1);
    expect(pruned.children?.[0].children).toBeUndefined();
    expect(pruned.children?.[0].truncated).toBe(true);
  });

  it('fitToBudget reduces depth on a SparseNode-shaped tree', () => {
    const sizeOf = (n: Sparse) => JSON.stringify(n).length;
    const tiny = sizeOf({ id: '0', name: 'root', type: 'FRAME' }) + 10;
    const fit = fitToBudget(tree, 3, tiny, sizeOf);
    expect(fit.degraded).toBe(true);
    expect(fit.depth).toBeGreaterThanOrEqual(1);
  });
});

import { fitToBudgetPerBranch } from '../../src/domain/design-context/auto-degrade.js';

describe('fitToBudgetPerBranch', () => {
  type S = { id: string; name: string; type: string; truncated?: boolean; childCount?: number; children?: S[] };
  const sizeOf = (n: S) => JSON.stringify(n).length;

  it('full tree fits → passthrough, degraded:false', () => {
    const t: S = { id: '0', name: 'r', type: 'F', children: [{ id: '1', name: 'a', type: 'F' }] };
    const r = fitToBudgetPerBranch(t, 3, 100000, sizeOf);
    expect(r.node).toBe(t);
    expect(r.degraded).toBe(false);
    expect(r.effectiveDepth).toBe(3);
    expect(r.minEffectiveDepth).toBe(3);
  });

  it('deepens a light branch while truncating a heavy one at depth 1', () => {
    // light: r → light → l1 → l2 (small). heavy: r → heavy → 40 leaves (wide).
    const heavyKids: S[] = Array.from({ length: 40 }, (_, i) => ({ id: `h${i}`, name: `heavyLeaf${i}`, type: 'T' }));
    const tree: S = {
      id: 'r', name: 'r', type: 'F', children: [
        { id: 'light', name: 'light', type: 'F', children: [
          { id: 'l1', name: 'l1', type: 'F', children: [{ id: 'l2', name: 'l2', type: 'T' }] },
        ] },
        { id: 'heavy', name: 'heavy', type: 'F', children: heavyKids },
      ],
    };
    // Budget: comfortably fits the light chain fully + heavy truncated, but NOT heavy expanded.
    const baseline = sizeOf({ ...tree, children: tree.children!.map((c) => ({ ...c, children: undefined, truncated: true, childCount: c.children!.length })) });
    const budget = baseline + 300; // +300 admits the 2 small light expansions, not the 40-wide heavy one
    const r = fitToBudgetPerBranch(tree, 4, budget, sizeOf);

    expect(r.degraded).toBe(true);
    expect(r.minEffectiveDepth).toBe(1);          // heavy cut at depth 1
    expect(r.effectiveDepth).toBeGreaterThan(1);  // light went deeper
    const heavy = r.node.children!.find((c) => c.id === 'heavy')!;
    expect(heavy.truncated).toBe(true);
    expect(heavy.childCount).toBe(40);
    const light = r.node.children!.find((c) => c.id === 'light')!;
    expect(light.children).toBeDefined();         // light kept its descendants
    expect(light.children![0].children).toBeDefined(); // ...down to depth 3 (l1 → l2), not just one level
  });

  it('all branches too wide at depth 1 → effectiveDepth 1, degraded', () => {
    const kids: S[] = Array.from({ length: 30 }, (_, i) => ({
      id: `${i}`, name: `n${i}`, type: 'F', children: [{ id: `${i}.x`, name: 'x', type: 'T' }],
    }));
    const tree: S = { id: 'r', name: 'r', type: 'F', children: kids };
    const r = fitToBudgetPerBranch(tree, 3, 50, sizeOf);
    expect(r.degraded).toBe(true);
    expect(r.effectiveDepth).toBe(1);
    expect(r.minEffectiveDepth).toBe(1);
  });

  // Item A: when even the depth-1 baseline (all direct children truncated) exceeds
  // budget, no expansion can ever help (expansions only grow the tree). The frontier
  // loop should be skipped entirely instead of futilely attempting every frontier node.
  it('skips the frontier loop when the depth-1 baseline already exceeds budget', () => {
    const wideKids: S[] = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`, name: `child${i}`, type: 'F',
      children: [{ id: `c${i}.g`, name: 'g', type: 'T' }],
    }));
    const tree: S = { id: 'r', name: 'r', type: 'F', children: wideKids };

    const baselineSize = sizeOf({
      ...tree,
      children: wideKids.map((c) => ({ ...c, children: undefined, truncated: true, childCount: c.children!.length })),
    });
    const budget = baselineSize - 10; // depth-1 baseline itself already exceeds budget

    let calls = 0;
    const countingSizeOf = (n: S): number => { calls++; return sizeOf(n); };

    const r = fitToBudgetPerBranch(tree, 3, budget, countingSizeOf);

    expect(r.degraded).toBe(true);
    expect(r.node.children!.every((c) => c.truncated === true)).toBe(true);
    expect(calls).toBe(2); // top sizeOf(root) check + baseline build check — NOT proportional to width (8)
  });
});
