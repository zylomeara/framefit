import { describe, it, expect } from 'vitest';
import { buildLayoutSpec, VIEW_CAPS, ENUM_CAPS, anyTruncatedSpec, budgetForCaps, MAX_TOTAL_NODES, budgetFor } from '../../src/domain/layout-spec/projector.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

// A raw node with many children + several depth levels, wider than branch caps.
const mk = (id: string, type: string, children: any[] = [], extra: any = {}): any => ({
  id, name: id, type, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 }, children, ...extra,
});
const wideDeep = (): RawSceneNode => mk('root', 'FRAME', Array.from({ length: 50 }, (_, i) =>
  mk(`c${i}`, 'FRAME', [mk(`g${i}`, 'TEXT', [], { characters: `t${i}`, style: { fontSize: 12 } })])), { layoutMode: 'VERTICAL' });

describe('VIEW_CAPS', () => {
  it('default caps == VIEW_CAPS.branch == current consts (byte-identical)', () => {
    const withDefault = JSON.stringify(buildLayoutSpec(wideDeep(), {}, { maxDepth: 4 }));
    const withBranch = JSON.stringify(buildLayoutSpec(wideDeep(), {}, { maxDepth: 4, caps: VIEW_CAPS.branch }));
    expect(withDefault).toBe(withBranch);
  });

  it('branch caps == the frozen consts (mirror anchor)', () => {
    expect(VIEW_CAPS.branch).toEqual({ maxSpecChildren: 30, maxNestedChildren: 15, maxTotalNodes: 90, totalCeiling: 300 });
    expect(budgetForCaps(VIEW_CAPS.branch, 4)).toBe(budgetFor(4)); // back-compat budgetFor == branch
    expect(VIEW_CAPS.branch.maxTotalNodes).toBe(MAX_TOTAL_NODES);
  });

  it('a wider nav-caps view keeps MORE children than branch on the same raw', () => {
    const branch = buildLayoutSpec(wideDeep(), {}, { maxDepth: 4, caps: VIEW_CAPS.branch });
    const skel = buildLayoutSpec(wideDeep(), {}, { maxDepth: 4, caps: VIEW_CAPS.skeleton });
    expect(branch.children.length).toBe(30);        // MAX_SPEC_CHILDREN
    expect(skel.children.length).toBeGreaterThan(30); // skeleton.maxSpecChildren = 120
  });
});

describe('ENUM_CAPS — internal coverage-enumeration profile', () => {
  const emptyCtx = () => ({ components: {}, setNames: new Map() });
  const frameWith31Kids = (): RawSceneNode => mk('root', 'FRAME', Array.from({ length: 31 }, (_, i) =>
    mk(`c${i}`, 'FRAME', [], { absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } })),
    { absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } });

  it('values are locked: enum profile (not output-bearing), branch untouched', () => {
    expect(ENUM_CAPS).toEqual({ maxSpecChildren: 200, maxNestedChildren: 200, maxTotalNodes: 2000, totalCeiling: 2000 });
    expect(VIEW_CAPS.branch).toEqual({ maxSpecChildren: 30, maxNestedChildren: 15, maxTotalNodes: 90, totalCeiling: 300 });
  });
  it('MUTATION LOCK: 31 in-flow children — branch cuts (breadth), ENUM_CAPS does not', () => {
    // fixture: FRAME with 31 direct visible children (raw), projected at maxDepth 4
    const raw = frameWith31Kids(); // helper in the test: RawSceneNode with children.length=31
    const branchSpec = buildLayoutSpec(raw, emptyCtx(), { maxDepth: 4 });            // pair path: caps NOT passed
    const enumSpec = buildLayoutSpec(raw, emptyCtx(), { maxDepth: 4, caps: ENUM_CAPS });
    expect(branchSpec.childrenTruncated).toBe(true);   // 31 > branch.maxSpecChildren 30
    expect(branchSpec.truncationCause).toBe('breadth');
    expect(enumSpec.childrenTruncated).toBeUndefined(); // 31 < 200
  });
  it('anyTruncatedSpec: sees truncation at the root and at any depth', () => {
    expect(anyTruncatedSpec({ childrenTruncated: true })).toBe(true);
    expect(anyTruncatedSpec({ children: [{ children: [{ childrenTruncated: true } as any] } as any] })).toBe(true);
    expect(anyTruncatedSpec({ children: [{} as any] })).toBe(false);
  });
});
