import { describe, it, expect } from 'vitest';
import { buildHydrationReceipt } from '../../src/domain/layout-spec/frame-receipt.js';
import type { LayoutSpec } from '../../src/domain/layout-spec/types.js';

// minimal LayoutSpec with a single truncated child of a given cause
const specWith = (cause: 'depth' | 'breadth' | 'budget' | undefined): LayoutSpec => ({
  node_id: 'n', name: 'n', type: 'FRAME', rect: { x: 0, y: 0, w: 10, h: 10 },
  children: cause
    ? [{ node_id: 'c', name: 'c', type: 'FRAME', rect: { x: 0, y: 0, w: 5, h: 5 }, childrenTruncated: true, truncationCause: cause }]
    : [{ node_id: 'c', name: 'c', type: 'FRAME', rect: { x: 0, y: 0, w: 5, h: 5 } }],
} as unknown as LayoutSpec);

describe('buildHydrationReceipt — cause-gated note', () => {
  it('depth cut + strictly-deeper raw held → BACKED positive (free re-slice, no re-fetch)', () => {
    const r = buildHydrationReceipt('n', specWith('depth'), { heldDepth: 9, hydrated: true, effectiveMaxDepth: 4 });
    expect(r.cause_breakdown).toEqual({ depth: 1, breadth: 0, budget: 0 });
    expect(r.drill_free_upto).toBe(8);
    expect(r.note).toMatch(/already held|free re-slice|held/i);
    expect(r.note).toMatch(/max_depth/);
  });

  it('depth cut + NOTHING deeper held (cold: heldDepth == effectiveMaxDepth+1) → honest hedge, NOT backed', () => {
    const r = buildHydrationReceipt('n', specWith('depth'), { heldDepth: 5, hydrated: true, effectiveMaxDepth: 4 });
    expect(r.drill_free_upto).toBe(4);
    expect(r.note).toMatch(/deeper fetch|not yet|not cached/i);
    expect(r.note).not.toMatch(/already held|free re-slice/i); // must NOT promise a free drill
  });

  it('breadth cut → hedge that never promises a deeper-max_depth remedy', () => {
    const r = buildHydrationReceipt('n', specWith('breadth'), { heldDepth: 9, hydrated: true, effectiveMaxDepth: 4 });
    expect(r.cause_breakdown).toEqual({ depth: 0, breadth: 1, budget: 0 });
    expect(r.note).toMatch(/breadth|cap/i);
    expect(r.note).not.toMatch(/raise max_depth|re-call max_depth/i);
    expect(r.note).not.toMatch(/already held/i);
  });

  it('budget cut → same honest hedge, no drill remedy', () => {
    const r = buildHydrationReceipt('n', specWith('budget'), { heldDepth: 9, hydrated: true, effectiveMaxDepth: 4 });
    expect(r.cause_breakdown).toEqual({ depth: 0, breadth: 0, budget: 1 });
    expect(r.note).not.toMatch(/raise max_depth/i);
  });

  it('hydrated:false never claims held (even with a deeper heldDepth number)', () => {
    const r = buildHydrationReceipt('n', specWith('depth'), { heldDepth: 5, hydrated: false, effectiveMaxDepth: 4 });
    expect(r.hydrated).toBe(false);
    expect(r.note).not.toMatch(/already held|free re-slice/i);
  });

  it('no cuts → no note (clean)', () => {
    const r = buildHydrationReceipt('n', specWith(undefined), { heldDepth: 9, hydrated: true, effectiveMaxDepth: 4 });
    expect(r.cause_breakdown).toEqual({ depth: 0, breadth: 0, budget: 0 });
    expect(r.note).toBeUndefined();
  });

  it('counts a truncated GRANDCHILD (whole-tree recursion, not just direct children)', () => {
    const spec = {
      node_id: 'n', name: 'n', type: 'FRAME', rect: { x: 0, y: 0, w: 10, h: 10 },
      children: [{ node_id: 'c', name: 'c', type: 'FRAME', rect: { x: 0, y: 0, w: 5, h: 5 },
        children: [{ node_id: 'g', name: 'g', type: 'FRAME', rect: { x: 0, y: 0, w: 2, h: 2 },
          childrenTruncated: true, truncationCause: 'depth' }] }],
    } as unknown as LayoutSpec;
    const r = buildHydrationReceipt('n', spec, { heldDepth: 9, hydrated: true, effectiveMaxDepth: 4 });
    expect(r.cause_breakdown).toEqual({ depth: 1, breadth: 0, budget: 0 }); // grandchild counted → recursion locked
  });

  it('counts a truncated ROOT (bump(spec), not only children)', () => {
    const spec = {
      node_id: 'n', name: 'n', type: 'FRAME', rect: { x: 0, y: 0, w: 10, h: 10 },
      childrenTruncated: true, truncationCause: 'breadth',
      children: [{ node_id: 'c', name: 'c', type: 'FRAME', rect: { x: 0, y: 0, w: 5, h: 5 } }],
    } as unknown as LayoutSpec;
    const r = buildHydrationReceipt('n', spec, { heldDepth: 9, hydrated: true, effectiveMaxDepth: 4 });
    expect(r.cause_breakdown).toEqual({ depth: 0, breadth: 1, budget: 0 }); // root counted → bump(spec) locked
  });

  it('mixed depth+breadth in one tree: backed depth note AND breadth hedge both present', () => {
    const spec = {
      node_id: 'n', name: 'n', type: 'FRAME', rect: { x: 0, y: 0, w: 10, h: 10 },
      children: [
        { node_id: 'b', name: 'b', type: 'FRAME', rect: { x: 0, y: 0, w: 5, h: 5 }, childrenTruncated: true, truncationCause: 'breadth' },
        { node_id: 'd', name: 'd', type: 'FRAME', rect: { x: 6, y: 0, w: 5, h: 5 }, childrenTruncated: true, truncationCause: 'depth' },
      ],
    } as unknown as LayoutSpec;
    const r = buildHydrationReceipt('n', spec, { heldDepth: 9, hydrated: true, effectiveMaxDepth: 4 });
    expect(r.cause_breakdown).toEqual({ depth: 1, breadth: 1, budget: 0 });
    expect(r.note).toMatch(/already held|free re-slice/i);   // backed depth (heldDepth 9 > effDepth+1)
    expect(r.note).toMatch(/breadth|max_depth.*NOT|NOT.*max_depth|text_leaves/i); // breadth hedge appended
  });
});
