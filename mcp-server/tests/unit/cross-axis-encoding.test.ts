// Batch 2 item 1's cross-axis ceiling, reopened as live pain (red on the consumer's stand
// in both acceptances). Panel: 3 lenses, 16 blockers, 18 majors - the draft's
// "cannot adjudicate -> demote" was replaced by MEASURED reconciliation one level down.
// The rule (offset-cross ONLY - child cross-size rows do not exist in fig<->dom mode, and
// a pair-root size.h demote would delete the only witness of real height defects):
// a symmetric content-height design child (both cross insets > structTol, equal within
// structTol - pure per-child geometry, no projector field: counterAxisAlignItems is a
// container property a child may override) against a DOM child that (1) STRETCHES the
// container's cross content box, (2) is VISUALLY INERT (no background/gradient/bgImage/
// borders/shadow - a painting box's geometry IS the rendered pixels), (3) HAS an interior
// (children present, not truncated - fail-closed), and (4) whose interior band RE-CREATES
// the design inset (symmetric within structTol, leading inset == the fig offset within
// tol) -> the offset-cross fail demotes with the measured note. Everything else stays red:
// stretch is the CSS default, and the un-reconciled residue is exactly the real-defect set
// (full-bleed, lost insets, misplaced interiors). No fix_plan caveat - demoted rows are
// excluded from fix_plan by design, and removing the wrong edit IS the cure.
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
const domChild = (over: Partial<DomChild> = {}): DomChild => ({
  kind: 'element', tag: 'div', rect: R(0, 0, 360, 120),
  children: [{ kind: 'element', tag: 'span', rect: R(0, 20, 360, 80) } as DomChild],
  ...over,
});
const snap = (child: DomChild, over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.tile', innerWidth: 1920,
  rect: R(0, 0, 360, 120), borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 360, clientHeight: 120, scrollHeight: 120,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  children: [child], ...over,
}) as never;

const oc = (rows: ReturnType<typeof diffPair>) => rows.find((r) => r.prop.startsWith('offset-cross[0]'));
const opts = { tolerancePx: 1 } as const;

describe('the measured reconciliation demote', () => {
  it('a: centered content-height design child + stretched inert DOM child whose interior re-creates the inset -> DEMOTED with the measured note', () => {
    const rows = diffPair(spec(), snap(domChild()), opts);
    const r = oc(rows)!;
    expect(r.status).toBe('demoted');
    expect(r.figma).toBe(20);
    expect(r.dom).toBe(0);                                  // both numbers preserved
    expect(r.note).toMatch(/box-encoding difference/);
    expect(r.note).toMatch(/measured 20 one level down/);
    expect(r.srcChannel).toBeUndefined();                   // the wrong fix_plan edit is removed
  });

  it('b: interior TOP-PINNED (band at 0) -> the fail stands - a real misplacement is never demoted', () => {
    const rows = diffPair(spec(),
      snap(domChild({ children: [{ kind: 'element', tag: 'span', rect: R(0, 0, 360, 80) } as DomChild] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('c: the stretched DOM child PAINTS -> the fail stands (the box geometry IS the pixels)', () => {
    const rows = diffPair(spec(), snap(domChild({ styles: { backgroundColor: '#101010' } as never })), opts);
    expect(oc(rows)!.status).toBe('fail');
    const rows2 = diffPair(spec(), snap(domChild({ borders: { top: 1, right: 1, bottom: 1, left: 1 } as never })), opts);
    expect(oc(rows2)!.status).toBe('fail');
  });

  it('d: the stretched DOM child is a LEAF or its children are cut -> fail-closed', () => {
    const rows = diffPair(spec(), snap(domChild({ children: [] })), opts);
    expect(oc(rows)!.status).toBe('fail');
    const rows2 = diffPair(spec(), snap(domChild({ childrenTruncated: true })), opts);
    expect(oc(rows2)!.status).toBe('fail');
  });

  it('e: a bottom-pinned design child (asymmetric insets 40/0) + stretched DOM -> the fail stands (one-sided)', () => {
    const rows = diffPair(spec({ rect: R(0, 40, 360, 80) }), snap(domChild()), opts);
    const r = oc(rows)!;
    expect(r.figma).toBe(40);
    expect(r.status).toBe('fail');
  });

  it('f: a NON-stretched DOM child with a real offset delta -> the fail stands (the DOM shows its own position)', () => {
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 8, 360, 80), children: [{ kind: 'element', tag: 'span', rect: R(0, 8, 360, 80) } as DomChild] })), opts);
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
      children: [{ kind: 'element', tag: 'span', rect: R(0, 10, 240, 100) } as DomChild],
    } as DomChild, { rect: R(0, 0, 240, 360), clientWidth: 240, clientHeight: 360, scrollHeight: 360 } as never);
    const rows = diffPair(s, d, opts);
    const r = oc(rows)!;
    expect(r.figma).toBe(12);
    expect(r.dom).toBe(0);
    expect(r.status).toBe('fail');
  });

  it('j: fig-side SYMMETRY is load-bearing - a bottom-pinned design child is never demoted even when the DOM interior mimics its lead', () => {
    // design bottom-pinned (insets 40/0); DOM stretches and CENTERS the interior at lead 40
    // (band 40/40) - the lead matches but the design declares an edge: a real alignment
    // difference that must stay red.
    const rows = diffPair(spec({ rect: R(0, 40, 360, 80) }),
      snap(domChild({ children: [{ kind: 'element', tag: 'span', rect: R(0, 40, 360, 40) } as DomChild] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('k: the STRETCH term is load-bearing - a non-stretched box whose interior mimics the inset stays red (the content is really shifted)', () => {
    // dom child inset 4/4 (not a stretch), interior at +20 inside it -> absolute content
    // at 24 vs the design's 20: the sum shifts, the demote must not fire.
    const rows = diffPair(spec(),
      snap(domChild({ rect: R(0, 4, 360, 112),
        children: [{ kind: 'element', tag: 'span', rect: R(0, 24, 360, 72) } as DomChild] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });

  it('l: BAND SYMMETRY is load-bearing - a top-anchored interior at the right lead is not a centered composition', () => {
    // interior lead 20 matches, but trail 80 - the content is top-anchored, not centered.
    const rows = diffPair(spec(),
      snap(domChild({ children: [{ kind: 'element', tag: 'span', rect: R(0, 20, 360, 20) } as DomChild] })), opts);
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
          domChild({ rect: R(216, 0, 144, 120), children: [{ kind: 'element', tag: 'span', rect: R(216, 20, 144, 80) } as DomChild] }),
        ] } as never), opts);
    expect(rows.some((r) => r.prop === 'unwrapped')).toBe(true);
    const r = rows.find((row) => row.prop.startsWith('offset-cross[0]'));
    expect(r?.status).toBe('fail');
  });

  it('i: the interior band must MATCH the design inset, not merely be symmetric', () => {
    // interior centered but at 40/40 in a 120-tall box vs the design inset 20 - the DOM
    // re-created a DIFFERENT inset; the delta is real.
    const rows = diffPair(spec(),
      snap(domChild({ children: [{ kind: 'element', tag: 'span', rect: R(0, 40, 360, 40) } as DomChild] })), opts);
    expect(oc(rows)!.status).toBe('fail');
  });
});
