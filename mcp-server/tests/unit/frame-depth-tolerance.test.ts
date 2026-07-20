import { describe, it, expect } from 'vitest';
import { buildLayoutSpec } from '../../src/domain/layout-spec/projector.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { SpecChild } from '../../src/domain/layout-spec/types.js';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
const node = (id: string, extra: Partial<RawSceneNode> = {}): RawSceneNode =>
  ({ id, name: id, type: 'FRAME', absoluteBoundingBox: box(0, 0, 40, 8), ...extra } as RawSceneNode);

// root dd:0 (VERTICAL) → single-child chain L1→L2→…→L{levels}, built deep enough that projecting
// to max_depth 4 ALWAYS leaves real in-flow content below the cut.
function rootWith(levels: number): RawSceneNode {
  let cur = node(`L${levels}`);
  for (let i = levels - 1; i >= 1; i -= 1) cur = node(`L${i}`, { children: [cur] });
  return { id: 'dd:0', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
    absoluteBoundingBox: box(0, 0, 300, 100), children: [cur] } as RawSceneNode;
}
const nth = (spec: { children: SpecChild[] }, k: number): SpecChild | undefined => {
  let cur: SpecChild | undefined = spec.children[0];
  for (let i = 1; i < k; i += 1) cur = cur?.children?.[0];
  return cur;
};

describe('frame-hydration depth-tolerance invariant (Phase 0 lock)', () => {
  it('SAFE: a deeper-than-needed raw (depth 9) and an exactly-sufficient raw (depth 5) project BYTE-IDENTICAL at max_depth 4, incl. childrenTruncated', () => {
    const deep = buildLayoutSpec(rootWith(9), {}, { maxDepth: 4 });
    const exact = buildLayoutSpec(rootWith(5), {}, { maxDepth: 4 });
    expect(JSON.stringify(deep)).toBe(JSON.stringify(exact));
    expect(nth(deep, 4)?.childrenTruncated).toBe(true); // real content below the cut, honestly flagged
  });

  it('DANGEROUS: a raw shallower than max_depth+1 (depth 4, heldDepth == max_depth) DROPS the boundary childrenTruncated — the tool must NEVER hold a raw shallower than max_depth+1', () => {
    const tooShallow = buildLayoutSpec(rootWith(4), {}, { maxDepth: 4 });
    const sufficient = buildLayoutSpec(rootWith(5), {}, { maxDepth: 4 });
    expect(nth(sufficient, 4)?.childrenTruncated).toBe(true);
    expect(nth(tooShallow, 4)?.childrenTruncated).toBeUndefined(); // under-report = false-green
    expect(JSON.stringify(tooShallow)).not.toBe(JSON.stringify(sufficient)); // differ precisely at the flag
  });
});
