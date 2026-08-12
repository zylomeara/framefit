// Batch 2 item 1's cross-axis ceiling, reopened as live pain (red on the consumer's stand
// in both acceptances). Panel: 3 lenses, 16 blockers, 18 majors - the draft's
// "cannot adjudicate -> demote" was replaced by MEASURED reconciliation one level down.
// The wave over the first cut then replaced the reconciliation ANCHOR (two blockers: the
// DOM root's own cross padding/border was silently absorbed by content-edge anchors, and
// the wrapper's accepted stretch slack was dropped from the sum): the interior's absolute
// lead/trail from the DOM root BOX must equal the design child's lead/trail from the
// design root BOX within tol - commensurable anchors, no tolerance stacking.
// The rule (offset-cross ONLY - child cross-size rows do not exist in fig<->dom mode, and
// a pair-root size.h demote would delete the only witness of real height defects):
// a symmetric content-height design child (both cross insets > structTol, equal within
// structTol in the design CONTENT box - pure per-child geometry, no projector field)
// against a DOM child that (1) STRETCHES the container's cross content box, (2) is
// VISUALLY INERT (no background/gradient/bgImage/borders/shadow AND no paintUnknown -
// the v7 flag for paints the snapshot cannot classify), (3) HAS a complete interior
// (children present, not truncated, no out-of-flow child - the band must cover what
// renders), (4) whose interior band is SYMMETRIC in the wrapper, and (5) whose interior
// RE-CREATES the design inset box-edge to box-edge -> the offset-cross fail demotes with
// the measured note. Everything else stays red: full-bleed, lost or chrome-shifted
// insets, misplaced interiors.
//
// Term subsumption (why some single-term mutants are not isolatable, proven geometry):
// with the box-edge equations + band symmetry + fig symmetry in place, a per-HALF stretch
// violation (lead-only or trail-only) cannot reach the demote - the wrapper would have to
// be off-center in the content box while its centered interior still lands on the design
// inset, which the band/box equations reject first. The stretch gate stays as the
// contract's SHAPE definition and fail-fast; only its WHOLE removal is locked (arm k).
// The fig-symmetry and band-symmetry terms are SCOPE gates (the demote covers only the
// centered-encoding class): their mutants are killed by chrome-asymmetric arms (j, l2)
// where the render reconciles box-edge but the composition is not centered.
// No fix_plan caveat - demoted rows are excluded from fix_plan by design (stripSrc also
// drops `caveat`), and removing the wrong edit IS the cure.
import { describe, it, expect } from 'vitest';
import { diffPair } from '../../src/domain/layout-spec/diff.js';
import type { LayoutSpec, DomSnapshotOk, SpecChild, DomChild } from '../../src/domain/layout-spec/types.js';

const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

// row-axis container 360x120; the design child is content-height (80) centered (insets 20/20)
const spec = (kid: Partial<SpecChild> = {}, over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '6:0', name: 'tile', type: 'INSTANCE' },
  rect: R(0, 0, 360, 120), axis: 'row',
  autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  children: [{ id: '6:1', name: 'Body', type: 'FRAME', rect: R(0, 20, 360, 80), ...kid } as SpecChild],
  ...over,
});
const kid = (x: number, y: number, w: number, h: number): DomChild =>
  ({ kind: 'element', tag: 'span', rect: R(x, y, w, h) } as DomChild);
const domChild = (over: Partial<DomChild> = {}): DomChild => ({
  kind: 'element', tag: 'div', rect: R(0, 0, 360, 120),
  children: [kid(0, 20, 360, 80)],
  ...over,
});
const snap = (child: DomChild, over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.tile', innerWidth: 1920,
  rect: R(0, 0, 360, 120), borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 360, clientHeight: 120, scrollHeight: 120,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  children: [child], ...over,
}) as never;
const pads = (top: number, bottom: number) => ({ paddings: { top, right: 0, bottom, left: 0 } } as never);

const oc = (rows: ReturnType<typeof diffPair>) => rows.find((r) => r.prop.startsWith('offset-cross[0]'));
const opts = { tolerancePx: 1 } as const;

describe('the measured reconciliation demote', () => {
  it('a: centered content-height design child + stretched inert DOM child whose interior re-creates the inset -> DEMOTED with the MEASURED note', () => {
    // the interior sits at 20.6, not 20: the note must print the number it MEASURED one
    // level down, not echo the design inset back (both are within tol of each other).
    const rows = diffPair(spec(), snap(domChild({ children: [kid(0, 20.6, 360, 78.8)] })), opts);
    const r = oc(rows)!;
    expect(r.status).toBe('demoted');
    expect(r.figma).toBe(20);
    expect(r.dom).toBe(0);                                  // both numbers preserved
    expect(r.note).toMatch(/box-encoding difference/);
    expect(r.note).toMatch(/measured 20.6 one level down/); // measured, not echoed
    expect(r.srcChannel).toBeUndefined();                   // the wrong fix_plan edit is removed
  });

  it('b: interior TOP-PINNED (band at 0) -> the fail stands - a real misplacement is never demoted', () => {
    const rows = diffPair(spec(),
      snap(domChild({ children: [kid(0, 0, 360, 80)] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('c: the stretched DOM child PAINTS -> the fail stands, for EVERY paint field (the box geometry IS the pixels)', () => {
    const painted: Partial<DomChild>[] = [
      { styles: { backgroundColor: '#101010' } as never },
      { borders: { top: 1, right: 1, bottom: 1, left: 1 } as never },
      { styles: { gradient: { kind: 'linear', angleDeg: 90, stops: [] } } as never },
      { styles: { bgImage: true } as never },
      { shadow: { inset: false, x: 0, y: 2, blur: 4, spread: 0, colorHex: '#00000040' } as never },
    ];
    for (const p of painted) {
      const rows = diffPair(spec(), snap(domChild(p)), opts);
      expect(oc(rows)!.status).toBe('fail');
    }
  });

  it('c2: paintUnknown (v7 - a declared paint the snapshot cannot classify) -> the fail stands', () => {
    const rows = diffPair(spec(), snap(domChild({ styles: { paintUnknown: true } as never })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('d: the stretched DOM child is a LEAF or its children are cut -> fail-closed', () => {
    // note: the empty-children term is behaviorally shadowed by the band math (Math.min of
    // [] is Infinity, which fails the box equations) - the explicit term stays because
    // Infinity/NaN accidents are not a contract; only the truncation half is mutant-locked.
    const rows = diffPair(spec(), snap(domChild({ children: [] })), opts);
    expect(oc(rows)!.status).toBe('fail');
    const rows2 = diffPair(spec(), snap(domChild({ childrenTruncated: true })), opts);
    expect(oc(rows2)!.status).toBe('fail');
  });

  it('d2: an OUT-OF-FLOW child was dropped from the interior -> fail-closed (the band is a subset of what renders)', () => {
    const rows = diffPair(spec(), snap(domChild({ outOfFlow: 1 } as never)), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('e: a bottom-pinned design child (asymmetric insets 40/0) + stretched DOM -> the fail stands (one-sided)', () => {
    const rows = diffPair(spec({ rect: R(0, 40, 360, 80) }), snap(domChild()), opts);
    const r = oc(rows)!;
    expect(r.figma).toBe(40);
    expect(r.status).toBe('fail');
  });

  it('f: a NON-stretched DOM child with a real offset delta -> the fail stands (the DOM shows its own position)', () => {
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 8, 360, 80), children: [kid(0, 8, 360, 80)] })), opts);
    const r = oc(rows)!;
    expect(r.dom).toBe(8);
    expect(r.status).toBe('fail');
  });

  it('g: dom-dom never demotes (the geometric arm is pure rect arithmetic - the sides term is load-bearing)', () => {
    const rows = diffPair(spec(), snap(domChild()), { tolerancePx: 1, sides: 'dom-dom' });
    const r = oc(rows);
    expect(r?.status).toBe('fail');
  });

  it('h: the full-bleed proof (col axis, lost side insets) - the interior spans the box, no reconciliation, the fail stands', () => {
    // design: col container 240 wide, card inset 12/12; DOM: the card went full-bleed and
    // its interior spans the box too - offset-cross is the SINGLE witness on a col axis.
    const s: LayoutSpec = {
      node: { id: '6:0', name: 'list', type: 'FRAME' },
      rect: R(0, 0, 240, 360), axis: 'col',
      autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      children: [{ id: '6:1', name: 'card', type: 'FRAME', rect: R(12, 0, 216, 120) } as SpecChild],
    };
    const d = snap({
      kind: 'element', tag: 'div', rect: R(0, 0, 240, 120),
      children: [kid(0, 10, 240, 100)],
    } as DomChild, { rect: R(0, 0, 240, 360), clientWidth: 240, clientHeight: 360, scrollHeight: 360 } as never);
    const rows = diffPair(s, d, opts);
    const r = oc(rows)!;
    expect(r.figma).toBe(12);
    expect(r.dom).toBe(0);
    expect(r.status).toBe('fail');
  });

  it('n: the col-axis POSITIVE twin of h - an inset card behind a full-bleed inert wrapper whose interior re-creates the inset -> DEMOTED (locks the cross-axis band selection on the axis where offset-cross is the single witness)', () => {
    const s: LayoutSpec = {
      node: { id: '6:0', name: 'list', type: 'FRAME' },
      rect: R(0, 0, 240, 360), axis: 'col',
      autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      children: [{ id: '6:1', name: 'card', type: 'FRAME', rect: R(12, 0, 216, 120) } as SpecChild],
    };
    const d = snap({
      kind: 'element', tag: 'div', rect: R(0, 0, 240, 120),
      children: [kid(12, 10, 216, 100)],
    } as DomChild, { rect: R(0, 0, 240, 360), clientWidth: 240, clientHeight: 360, scrollHeight: 360 } as never);
    const rows = diffPair(s, d, opts);
    const r = oc(rows)!;
    expect(r.status).toBe('demoted');
    expect(r.note).toMatch(/measured 12 one level down/);
  });

  it('i: the interior band must MATCH the design inset, not merely be symmetric', () => {
    // interior centered but at 40/40 in a 120-tall box vs the design inset 20 - the DOM
    // re-created a DIFFERENT inset; the delta is real.
    const rows = diffPair(spec(),
      snap(domChild({ children: [kid(0, 40, 360, 40)] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('j: fig-side SYMMETRY is load-bearing as a SCOPE gate - an asymmetrically pinned design child is never demoted, even when chrome makes the render reconcile box-edge', () => {
    // design pins the child 40/8 (asymmetric -> outside the centered-encoding class);
    // DOM: root padding-top 32, stretched wrapper 32..120, interior at absolute 40..112 -
    // the box-edge equations reconcile exactly (40/8), the band is symmetric (8/8), and
    // border-edge (32) differs from the design offset (40) so the declared-padding demote
    // does not fire either. Only the fig-symmetry gate keeps this red.
    const rows = diffPair(spec({ rect: R(0, 40, 360, 72) }),
      snap(domChild({ rect: R(0, 32, 360, 88), children: [kid(0, 40, 360, 72)] }), pads(32, 0)), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('k: the STRETCH shape gate is load-bearing - a non-stretched inert box whose interior sits exactly at the design inset stays red (outside the licensed shape)', () => {
    // wrapper inset 4/4 (not a stretch), interior at absolute 20..100 = the design
    // position. The box equations reconcile; only the stretch gate keeps the fail.
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 4, 360, 112), children: [kid(0, 20, 360, 80)] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('l: a top-anchored interior at the right lead is not a centered composition -> the fail stands', () => {
    // interior lead 20 matches, but trail 80 - the content is top-anchored, not centered.
    const rows = diffPair(spec(),
      snap(domChild({ children: [kid(0, 20, 360, 20)] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('l2: band SYMMETRY is load-bearing as a SCOPE gate - chrome-shifted wrapper with an off-center interior stays red even though the box edges reconcile', () => {
    // root padding-top 8: wrapper 8..120, interior at absolute 20..100 (= the design
    // position, box equations reconcile) but the band inside the wrapper is 12/20 -
    // the composition is not centered; only the band-symmetry gate keeps this red.
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 8, 360, 112), children: [kid(0, 20, 360, 80)] }), pads(8, 0)), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('m: the WRAPPER/UNWRAP gate is load-bearing - cross references mix repair boxes, the demote is fail-closed there', () => {
    const wrapper: SpecChild = { id: '6:5', name: 'wrap', type: 'FRAME', rect: R(0, 0, 360, 120), axis: 'row',
      children: [
        { id: '6:6', name: 'k1', type: 'FRAME', rect: R(0, 20, 200, 80) } as SpecChild,
        { id: '6:7', name: 'k2', type: 'FRAME', rect: R(216, 20, 144, 80) } as SpecChild,
      ] } as SpecChild;
    const rows = diffPair(spec({}, { children: [wrapper] } as never),
      snap(domChild({ rect: R(0, 0, 200, 120) }),
        { children: [
          domChild({ rect: R(0, 0, 200, 120) }),
          domChild({ rect: R(216, 0, 144, 120), children: [kid(216, 20, 144, 80)] }),
        ] } as never), opts);
    expect(rows.some((r) => r.prop === 'unwrapped')).toBe(true);
    const r = rows.find((row) => row.prop.startsWith('offset-cross[0]'));
    expect(r?.status).toBe('fail');
  });

  it('o: the wave blocker lock - DOM root cross chrome is NOT absorbed: content really low AND short behind an in-content-box-stretched wrapper stays a hard fail', () => {
    // root padding 10/10; wrapper stretches the CONTENT box (10..110); interior at
    // absolute 30..90 re-creates a 20px band INSIDE the wrapper - but the rendered
    // content sits at 30, not the designed 20. Content-edge anchors would demote this.
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 10, 360, 100), children: [kid(0, 30, 360, 60)] }), pads(10, 10)), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('p: the chrome-encoded PIXEL-PERFECT render demotes - the box-edge anchors accept what content-edge anchors wrongly rejected', () => {
    // root padding 10/10; wrapper 10..110; interior at absolute 20..100 - exactly the
    // design position. The DOM encodes 10px of the inset as root padding and 10px as
    // interior placement; the render is identical to the design.
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 10, 360, 100), children: [kid(0, 20, 360, 80)] }), pads(10, 10)), opts);
    const r = oc(rows)!;
    expect(r.status).toBe('demoted');
    expect(r.note).toMatch(/measured 20 one level down/);
  });

  it('q: the box-edge LEAD equation is load-bearing - asymmetric top chrome shifts the content down; the trail alone would reconcile', () => {
    // root padding-top 12: wrapper 12..120, interior at absolute 32..100 (band 20/20
    // symmetric). Trail: 20 == 20 reconciles; lead: 32 vs 20 is the real 12px defect.
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 12, 360, 108), children: [kid(0, 32, 360, 68)] }), pads(12, 0)), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('r: the box-edge TRAIL equation is load-bearing - asymmetric bottom chrome shortens the content; the lead alone would reconcile', () => {
    // root padding-bottom 12: wrapper 0..108, interior at absolute 20..88 (band 20/20
    // symmetric). Lead: 20 == 20 reconciles; trail: 32 vs 20 is the real 12px defect.
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 0, 360, 108), children: [kid(0, 20, 360, 68)] }), pads(0, 12)), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('s: the accepted stretch slack is part of the measurement - a 1px wrapper offset plus a 21px band is a 22px content position, not "the same inset"', () => {
    // wrapper at 1..119 (slack within structTol, the stretch gate accepts the SHAPE);
    // interior at absolute 22..98 (band 21/21 symmetric). Content-edge reconciliation
    // against the band alone would stack tolerances and demote; box-edge says 22 vs 20.
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 1, 360, 118), children: [kid(0, 22, 360, 76)] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('w: the interior band is an ENVELOPE over all children - a sibling above the band breaks the symmetry, first-child-only reads would demote', () => {
    const rows = diffPair(spec(),
      snap(domChild({ children: [kid(0, 20, 200, 80), kid(200, 10, 160, 90)] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('x: the multi-child POSITIVE - the envelope (not the first child) defines both band edges; a shorter first column does not break the demote', () => {
    // first child 20..80, second 20..100: the envelope is 20..100 = the design inset.
    const rows = diffPair(spec(),
      snap(domChild({ children: [kid(0, 20, 200, 60), kid(200, 20, 160, 80)] })), opts);
    expect(oc(rows)!.status).toBe('demoted');
  });

  it('y: a design inset at structTol is not a "real inset" - the sub-tolerance guard keeps a sub-pixel/negative-offset defect red', () => {
    // design child inset 1/1 (== structTol); DOM wrapper at -0.6 with the interior at
    // 0.4 - every other term reconciles within tolerances, only the figOff floor rejects.
    const rows = diffPair(spec({ rect: R(0, 1, 360, 118) }),
      snap(domChild({ rect: R(0, -0.6, 360, 120), children: [kid(0, 0.4, 360, 118)] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('z: a demoted row carries NO caveat and NO residual-gutter contradiction - the demote note replaces the accumulated note', () => {
    // col axis with a page scrollbar gutter: the gutter-residual pass runs first and (on a
    // fail) plants a caveat + "not explained by it" note fragment; the encoding demote
    // must not ship a row that says both "real layout" and "not a defect".
    const s: LayoutSpec = {
      node: { id: '6:0', name: 'page', type: 'FRAME' },
      rect: R(0, 0, 1920, 720), axis: 'col',
      autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      children: [{ id: '6:1', name: 'Body', type: 'FRAME', rect: R(100, 0, 1720, 720) } as SpecChild],
    };
    const d = snap({
      kind: 'element', tag: 'div', rect: R(0, 0, 1909, 720),
      children: [kid(100, 0, 1709, 720)],
    } as DomChild, { rect: R(0, 0, 1909, 720), innerWidth: 1920, layoutViewportWidth: 1909,
      clientWidth: 1909, clientHeight: 720, scrollHeight: 720 } as never);
    const rows = diffPair(s, d, opts);
    const r = oc(rows)!;
    expect(r.status).toBe('demoted');
    expect(r.caveat).toBeUndefined();
    expect(r.note).not.toMatch(/not explained/);
    expect(r.note).toMatch(/box-encoding difference/);
  });
});

describe('the verify-round locks (opacity, member completeness, the two-anchor note)', () => {
  it('c3: an opacity<1 wrapper is not inert - opacity decouples geometry from pixels', () => {
    const rows = diffPair(spec(), snap(domChild({ styles: { opacity: 0 } as never })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('c4: an opacity<1 band MEMBER renders nothing - the band is a subset of what renders', () => {
    const rows = diffPair(spec(),
      snap(domChild({ children: [{ ...kid(0, 20, 360, 80), styles: { opacity: 0 } } as DomChild] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('d3: a band MEMBER that dropped an out-of-flow child (the relative>absolute overlay pattern) -> fail-closed', () => {
    const rows = diffPair(spec(),
      snap(domChild({ children: [{ ...kid(0, 20, 360, 80), outOfFlow: 1 } as DomChild] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('a2: with design cross padding the note names BOTH anchors - the box-edge inset and the content-box number the row reads', () => {
    const s = spec({ rect: R(0, 30, 360, 60) },
      { autoLayout: { padding: { top: 10, right: 0, bottom: 10, left: 0 } } } as never);
    const rows = diffPair(s, snap(domChild({ children: [kid(0, 30, 360, 60)] })), opts);
    const r = oc(rows)!;
    expect(r.status).toBe('demoted');
    expect(r.figma).toBe(20);
    expect(r.note).toMatch(/cross inset 30 from the container edge - 20 of it inside the container's cross padding/);
  });
});
