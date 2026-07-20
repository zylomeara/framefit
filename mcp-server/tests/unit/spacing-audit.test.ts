import { describe, it, expect } from 'vitest';
import { auditContainer } from '../../src/domain/layout-spec/spacing-audit.js';
import type { AuditKid } from '../../src/domain/layout-spec/spacing-audit.js';
import type { SpecChild, SpecRect, Edges, CaptureInfo, SpacingAuditGap } from '../../src/domain/layout-spec/types.js';

// Fixtures: kid() builds the Figma side of a candidate (child = the container's raw child, pairedNode = the
// same rect if a pair exists — auditContainer uses ONLY pairedId/pairedNode for the geometry, child carries
// the shape for compatibility with partialDetails.kids but isn't read into the geometry itself).
// cap() builds the DOM side (CaptureInfo) — by default geometryUnchecked:false, no borders.
type KidOpts = { paired?: boolean; y?: number; h?: number };
const rect = (x: number, w: number, y = 0, h = 10): SpecRect => ({ x, y, w, h });
const kid = (id: string, x: number, w: number, opts: KidOpts = {}): AuditKid => {
  const r = rect(x, w, opts.y, opts.h);
  const child: SpecChild = { id, name: id, type: 'FRAME', rect: r };
  if (opts.paired === false) return { child };
  return { child, pairedId: id, pairedNode: { ...child } };
};
type CapOpts = { y?: number; h?: number; borders?: Edges; geometryUnchecked?: boolean; noRect?: boolean };
const cap = (ref: string | undefined, x: number, w: number, opts: CapOpts = {}): CaptureInfo => ({
  ...(ref !== undefined ? { ref } : {}),
  ...(opts.noRect ? {} : { rect: rect(x, w, opts.y, opts.h) }),
  ...(opts.borders ? { borders: opts.borders } : {}),
  geometryUnchecked: opts.geometryUnchecked ?? false,
});
const caps = (entries: Array<[string, CaptureInfo]>): Map<string, CaptureInfo> => new Map(entries);

// Lock against a regression to fabrication: under unchecked, dom/delta MUST be absent — if
// someone returns `dom: figma, delta: 0`, this check goes red even if note/status are correct.
const expectUnchecked = (gap: SpacingAuditGap, note: string): void => {
  expect(gap.status).toBe('unchecked');
  expect(gap.note).toBe(note);
  expect(gap.dom).toBeUndefined();
  expect(gap.delta).toBeUndefined();
};

describe('auditContainer — spacing audit without a container pair', () => {
  it('1. two neighbors, one ref, gaps match → pass (figma 24/dom 24)', () => {
    const kids = [kid('a', 0, 10), kid('b', 34, 10)];
    const c = caps([
      ['a', cap('batch1', 0, 10)],
      ['b', cap('batch1', 34, 10)],
    ]);
    const audit = auditContainer('R', 'row', kids, c, 2);
    expect(audit).toMatchObject({ container_id: 'R', axis: 'row', insets_unverified: true });
    expect(audit!.gaps).toEqual([{ between: ['a', 'b'], figma: 24, dom: 24, delta: 0, status: 'pass' }]);
  });

  it('2. delta 7 > tol → fail with Δ in note; symmetry of both signs (dom>figma and dom<figma → |Δ|)', () => {
    // dom > figma: figma 24 (a end=10, b start=34), dom 31 (b start=41)
    const kidsUp = [kid('a', 0, 10), kid('b', 34, 10)];
    const capsUp = caps([
      ['a', cap('batch1', 0, 10)],
      ['b', cap('batch1', 41, 10)],
    ]);
    const auditUp = auditContainer('R', 'row', kidsUp, capsUp, 2);
    expect(auditUp!.gaps[0]).toMatchObject({ figma: 24, dom: 31, delta: 7, status: 'fail', note: 'Δ7px (tolerance 2px incl. borders)' });

    // dom < figma: figma 31 (b start=41), dom 24 (b start=34)
    const kidsDown = [kid('a', 0, 10), kid('b', 41, 10)];
    const capsDown = caps([
      ['a', cap('batch1', 0, 10)],
      ['b', cap('batch1', 34, 10)],
    ]);
    const auditDown = auditContainer('R', 'row', kidsDown, capsDown, 2);
    expect(auditDown!.gaps[0]).toMatchObject({ figma: 31, dom: 24, delta: 7, status: 'fail', note: 'Δ7px (tolerance 2px incl. borders)' });
  });

  it('3. different refs → unchecked "different captures" (mutation lock on the gate: make refs equal → pass)', () => {
    const kids = [kid('a', 0, 10), kid('b', 34, 10)];
    const cDiff = caps([
      ['a', cap('batch1', 0, 10)],
      ['b', cap('batch2', 34, 10)],
    ]);
    const auditDiff = auditContainer('R', 'row', kids, cDiff, 2);
    expectUnchecked(auditDiff!.gaps[0], 'gap not verified: pairs from different captures — pass a single-batch dom_ref or add a container pair');

    // gate lock: if the refs are made equal (with the same rects) — the result CHANGES to pass, it doesn't
    // stay unchecked forever (proving the gate is really conditional on ref, not always emitting unchecked).
    const cSame = caps([
      ['a', cap('batch1', 0, 10)],
      ['b', cap('batch1', 34, 10)],
    ]);
    const auditSame = auditContainer('R', 'row', kids, cSame, 2);
    expect(auditSame!.gaps[0]).toMatchObject({ status: 'pass' });
  });

  it('4. inline dom (ref undefined on one) → unchecked', () => {
    const kids = [kid('a', 0, 10), kid('b', 34, 10)];
    const c = caps([
      ['a', cap(undefined, 0, 10)], // inline dom — the capture is unprovable
      ['b', cap('batch1', 34, 10)],
    ]);
    const audit = auditContainer('R', 'row', kids, c, 2);
    expectUnchecked(audit!.gaps[0], 'gap not verified: pairs from different captures — pass a single-batch dom_ref or add a container pair');
  });

  it('5. geometryUnchecked on one → unchecked env', () => {
    const kids = [kid('a', 0, 10), kid('b', 34, 10)];
    const c = caps([
      ['a', cap('batch1', 0, 10)],
      ['b', cap('batch1', 34, 10, { geometryUnchecked: true })],
    ]);
    const audit = auditContainer('R', 'row', kids, c, 2);
    expectUnchecked(audit!.gaps[0], 'pair geometry not verifiable (env) — gap not audited');
  });

  it('6. wrap: 2 rows of 3 (second row: x rolled back, y grew) → gap row1↔row2 unchecked "wrap"; within a row — measured', () => {
    const kids = [
      kid('a', 0, 10), kid('b', 20, 10), kid('c', 40, 10),
      kid('d', 0, 10, { y: 20 }), kid('e', 20, 10, { y: 20 }), kid('f', 40, 10, { y: 20 }),
    ];
    const c = caps([
      ['a', cap('batch1', 0, 10)], ['b', cap('batch1', 20, 10)], ['c', cap('batch1', 40, 10)],
      ['d', cap('batch1', 0, 10, { y: 20 })], ['e', cap('batch1', 20, 10, { y: 20 })], ['f', cap('batch1', 40, 10, { y: 20 })],
    ]);
    const audit = auditContainer('R', 'row', kids, c, 2);
    expect(audit!.gaps.map((g) => g.status)).toEqual(['pass', 'pass', 'unchecked', 'pass', 'pass']);
    expect(audit!.gaps[2]).toMatchObject({ between: ['c', 'd'] });
    expectUnchecked(audit!.gaps[2], 'wrap/2D desync — a single-axis gap is meaningless');
    expect(audit!.gaps[0]).toMatchObject({ figma: 10, dom: 10 });
  });

  // Case 7 of the original version locked TWO independent behaviors of gate 3 in one fixture (the cross-axis
  // math inside inFlowNeighbors AND the independence of the DOM side from the Figma side). Split into 7a/7b,
  // each hit by EXACTLY one of the two live mutations: 7a hinges ONLY on cross-axis
  // (progression is clean on both sides) — "disable the cross axis" fails exactly and only it; 7b hinges on
  // the main-axis progression of the DOM side ONLY (Figma is wholly clean, both in progression and on the
  // cross axis) — "disable the DOM side of the guard" (hardcode domOk=true) fails exactly and only it. If 7b
  // were also built on a cross-axis discrepancy (as in the original version), both mutations would break both
  // cases — not orthogonal, because inFlowNeighbors is ONE function invoked twice on shared rects.
  it('7a. wrap guard: cross-axis — BOTH sides wrap identically, caught ONLY by the cross axis (progression clean on both sides)', () => {
    const kids = [kid('a', 0, 10), kid('b', 15, 10, { y: 50 })];
    const c = caps([
      ['a', cap('batch1', 0, 10)],
      ['b', cap('batch1', 15, 10, { y: 50 })],
    ]);
    const audit = auditContainer('R', 'row', kids, c, 2);
    // main-axis: start(b)=15 >= end(a)=10-tol(2)=8 → progression clean on BOTH sides (Figma and DOM are
    // identical); ONLY the cross-axis fails (b at y=50, outside the intersection with a at y=0..10).
    expectUnchecked(audit!.gaps[0], 'wrap/2D desync — a single-axis gap is meaningless');
  });

  it('7b. wrap guard: DOM-only desync along the main axis (main-axis progression), Figma clean both in progression and on the cross axis', () => {
    const kids = [kid('g', 0, 10), kid('h', 25, 10)];
    const c = caps([
      ['g', cap('batch1', 0, 10)],
      // DOM: h no longer comes strictly after g along the main axis (start=5 < end(g)=10-tol(2)=8) — same row
      // (y=0 on both, the cross axis doesn't fail), the discrepancy is only in main-axis progression and only
      // on the DOM side (Figma h sits at x=25, cleanly progressing after g).
      ['h', cap('batch1', 5, 10)],
    ]);
    const audit = auditContainer('R', 'row', kids, c, 2);
    expectUnchecked(audit!.gaps[0], 'wrap/2D desync — a single-axis gap is meaningless');
  });

  it('8. decor divider (kid without pairedId) between A and B → zero gaps between A and B (not emitted), the rest measured', () => {
    const kids = [
      kid('x', 0, 10), kid('a', 20, 10), kid('decor', 32, 6, { paired: false }), kid('b', 50, 10), kid('y', 70, 10),
    ];
    const c = caps([
      ['x', cap('batch1', 0, 10)], ['a', cap('batch1', 20, 10)], ['b', cap('batch1', 50, 10)], ['y', cap('batch1', 70, 10)],
    ]);
    const audit = auditContainer('R', 'row', kids, c, 2);
    // exactly 2 gaps: x↔a and b↔y; NOTHING links a and b directly through the decor
    expect(audit!.gaps.length).toBe(2);
    expect(audit!.gaps.map((g) => g.between)).toEqual([['x', 'a'], ['b', 'y']]);
    expect(audit!.gaps.every((g) => g.status === 'pass')).toBe(true);
  });

  it('9. facing borders: figma 24, dom 22, borders A.right=1 B.left=1, tol 1 → effTol 3 → pass', () => {
    const kids = [kid('a', 0, 10), kid('b', 34, 10)];
    const c = caps([
      ['a', cap('batch1', 0, 10, { borders: { top: 0, right: 1, bottom: 0, left: 0 } })],
      ['b', cap('batch1', 32, 10, { borders: { top: 0, right: 0, bottom: 0, left: 1 } })],
    ]);
    const audit = auditContainer('R', 'row', kids, c, 1);
    expect(audit!.gaps[0]).toMatchObject({ figma: 24, dom: 22, delta: 2, status: 'pass' });
  });

  it('10. no neighbors measurable (all kids without pairedId) → undefined', () => {
    const kids = [kid('a', 0, 10, { paired: false }), kid('b', 20, 10, { paired: false }), kid('c', 40, 10, { paired: false })];
    const audit = auditContainer('R', 'row', kids, caps([]), 2);
    expect(audit).toBeUndefined();
  });

  it('11. col axis: main=y mirrored', () => {
    const kids = [kid('a', 0, 10, { y: 0, h: 10 }), kid('b', 0, 10, { y: 30, h: 10 })];
    const c = caps([
      ['a', cap('batch1', 0, 10, { y: 0, h: 10 })],
      ['b', cap('batch1', 0, 10, { y: 30, h: 10 })],
    ]);
    const audit = auditContainer('R', 'col', kids, c, 2);
    expect(audit!.gaps[0]).toMatchObject({ figma: 20, dom: 20, delta: 0, status: 'pass' });
  });

  it('12. a neighbor capture missing from the Map ENTIRELY (not just ref:undefined) → unchecked (lock against a refactor to optional-chaining in gate 1)', () => {
    const kids = [kid('a', 0, 10), kid('b', 34, 10)];
    const c = caps([
      ['a', cap('batch1', 0, 10)],
      // 'b' is not added to the Map at all — captures.get('b') returns undefined as an OBJECT (not a
      // CaptureInfo with ref:undefined, as in case 4) — the same gate-1 branch, but it checks exactly the
      // `capB?.ref` optional-chaining on a fully absent capB, rather than on a present-but-uncheckable capB.
    ]);
    const audit = auditContainer('R', 'row', kids, c, 2);
    expectUnchecked(audit!.gaps[0], 'gap not verified: pairs from different captures — pass a single-batch dom_ref or add a container pair');
  });
});
