// feedback batch 2 item 1 (panel-locked, 50 findings): a DS that encodes container insets as literal
// RECTANGLE spacer children ("Padding horizontal", 16w, full-height, flush to the edge; the
// container's own auto-layout padding is 0) breaks the EQUAL-COUNT index zip - the spacer
// pairs with a real DOM child and gap[0]/padding-left/offset-cross go false-red over correct
// code, with fix_plan prescribing edits against working CSS. The mechanic: qualifying EDGE
// spacers are REMOVED from the local figKids before pairing (removal IS the fold - the
// surviving children's absolute rects carry the inset; an arithmetic fold double-counts),
// the folded edge's padding row switches to a BORDER-EDGE reading on BOTH sides (declared
// paddings not subtracted - a missing DOM inset is a hard fail, never 0v0), encoding demotes
// are OFF on folded edges (the fold IS the reconciliation), and ONE spacer_inset service row
// (COVERAGE_META) is pushed AT the conversion site so it survives every early return.
// Fixtures use invented names; the live layer name's typo sits in the SECOND token, so the
// first-token name gate still matches it - locked with a typo-position-faithful name below.
import { describe, it, expect } from 'vitest';
import { diffPair } from '../../src/domain/layout-spec/diff.js';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import type { LayoutSpec, DomSnapshotOk, SpecChild, DomChild } from '../../src/domain/layout-spec/types.js';

const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const spacer = (over: Partial<SpecChild> = {}): SpecChild =>
  ({ id: '5:2', name: 'Padding horizontal', type: 'RECTANGLE', rect: R(0, 0, 16, 140), ...over });
const kidA = (over: Partial<SpecChild> = {}): SpecChild =>
  ({ id: '5:3', name: 'square', type: 'FRAME', rect: R(16, 25, 90, 90), ...over });
const kidB = (over: Partial<SpecChild> = {}): SpecChild =>
  ({ id: '5:4', name: 'title', type: 'TEXT', textSnippet: 'Make a shelf', rect: R(130, 50, 200, 40), ...over });

const tile = (children: SpecChild[], over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '5:1', name: 'tile', type: 'INSTANCE' },
  rect: R(0, 0, 400, 140), axis: 'row',
  autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  children, ...over,
});

const domKid = (x: number, w: number, over: Partial<DomChild> = {}): DomChild =>
  ({ kind: 'element', tag: 'div', rect: R(x, 25, w, 90), ...over });
const domText = (x: number, w: number): DomChild =>
  ({ kind: 'element', tag: 'span', rect: R(x, 50, w, 40), children: [{ kind: 'text', rect: R(x, 50, w, 40), text: 'Make a shelf' }] });

const snap = (children: DomChild[], over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 1, status: 'ok', selector: '.tile', innerWidth: 1920,
  rect: R(0, 0, 400, 140), borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false,
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 400, clientHeight: 140, scrollHeight: 140,
  styles: { display: 'flex' },
  children, ...over,
});

const row = (rows: ReturnType<typeof diffPair>, prefix: string) => rows.find((r) => r.prop.startsWith(prefix));
const opts = { tolerancePx: 1 } as const;

describe('the predicate: what converts and what must not', () => {
  // 1b shape: [spacer, A, B] vs 2 real DOM children -> post-conversion 2v2 equal-count zip
  it('an edge spacer folds: gap[0] is between REAL children and carries the true numbers', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]), snap([domKid(16, 90), domText(130, 200)]), opts);
    const g = row(rows, 'gap[0]');
    expect(g).toBeDefined();
    expect(g!.prop).not.toContain('Padding');            // the spacer is out of the label
    expect(g!.status).toBe('pass');                       // 24 vs 24 (130-106 both sides)
    const si = row(rows, 'spacer_inset');
    expect(si).toMatchObject({ status: 'pass' });
    expect(si!.note).toMatch(/leading 16px/);              // the folded extent is named
    expect(String(si!.figma)).toContain('Padding horizontal');
  });

  it('spacer_inset never enters coverage as a visual axis (COVERAGE_META)', async () => {
    const { deriveCoverage } = await import('../../src/domain/layout-spec/diff.js');
    const rows = diffPair(tile([spacer(), kidA(), kidB()]), snap([domKid(16, 90), domText(130, 200)]), opts);
    const cov = deriveCoverage(rows);
    expect(cov.measured).not.toContain('spacer_inset');
    expect(cov.skipped).not.toContain('spacer_inset');
  });

  it('the typo-position-faithful live name still matches (second token carries the typo)', () => {
    const rows = diffPair(tile([spacer({ name: 'Padding horisontal' }), kidA(), kidB()]),
      snap([domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeDefined();
  });

  it('an accent bar and a divider do NOT convert (name gate)', () => {
    for (const name of ['Accent bar', 'Divider']) {
      const rows = diffPair(tile([spacer({ name }), kidA(), kidB()]), snap([domKid(16, 90), domText(130, 200)]), opts);
      expect(row(rows, 'spacer_inset')).toBeUndefined();
    }
  });

  it('a flush VECTOR named "gap" does NOT convert (type gate protects the icon axis)', () => {
    const rows = diffPair(tile([spacer({ name: 'gap', type: 'VECTOR' }), kidA(), kidB()]),
      snap([domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeUndefined();
  });

  it('an image-filled "Padding art" does NOT convert (imageFill gate)', () => {
    const rows = diffPair(tile([spacer({ name: 'Padding art', imageFill: true }), kidA(), kidB()]),
      snap([domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeUndefined();
  });

  it('a truncated spacer-shaped node does NOT convert and its truncation warn survives', () => {
    const rows = diffPair(tile([spacer({ childrenTruncated: true }), kidA(), kidB()]),
      snap([domKid(0, 16, { rect: R(0, 0, 16, 140) }), domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeUndefined();
    expect(rows.some((r) => r.prop === 'children_truncated')).toBe(true);
  });

  it('a short (non-full-cross) edge rectangle does NOT convert (named ceiling)', () => {
    const rows = diffPair(tile([spacer({ rect: R(0, 62, 16, 16) }), kidA(), kidB()]),
      snap([domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeUndefined();
  });

  it('a spacer-only container does NOT convert (survivor guard) - rows byte-shape as today', () => {
    const rows = diffPair(tile([spacer()]), snap([domKid(16, 90)]), opts);
    expect(row(rows, 'spacer_inset')).toBeUndefined();
  });

  it('an INTERIOR spacer is not folded and is NAMED in the note (visible ceiling)', () => {
    const rows = diffPair(tile([spacer(), kidA(), spacer({ id: '5:9', name: 'Spacer mid', rect: R(106, 0, 24, 140) }), kidB()]),
      snap([domKid(16, 90), domText(130, 200)]), opts);
    const si = row(rows, 'spacer_inset');
    expect(si).toBeDefined();
    expect(si!.note).toMatch(/interior/i);
    expect(si!.note).toContain('Spacer mid');              // the layer is NAMED, not counted
  });

  it('strict profile (tol=0): a sub-pixel-fraction spacer still converts (the clamp is load-bearing)', () => {
    // getBoundingClientRect-class fractions: flush offset 0.4px and cross short by 0.6px -
    // a raw-tol (0) flush/cross test refuses this shape; the structTol clamp admits it.
    const rows = diffPair(tile([spacer({ rect: R(0.4, 0.3, 16, 139.4) }), kidA({ rect: R(16.4, 25, 90, 90) }), kidB({ rect: R(130.4, 50, 200, 40) })]),
      snap([domKid(16, 90), domText(130, 200)]), { tolerancePx: 0 });
    expect(row(rows, 'spacer_inset')).toBeDefined();
  });

  it('a NON-flush spacer-named rectangle does NOT convert (flush gate)', () => {
    const rows = diffPair(tile([spacer({ rect: R(8, 0, 16, 140) }), kidA(), kidB()]),
      snap([domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeUndefined();
  });

  it('a near-full-main-extent rectangle does NOT convert (background sanity gate)', () => {
    const rows = diffPair(tile([spacer({ rect: R(0, 0, 399.5, 140) })]),
      snap([domKid(16, 90)]), opts);
    expect(row(rows, 'spacer_inset')).toBeUndefined();
  });
});

describe('the border-edge padding reading on folded edges', () => {
  it('DOM inset 16 -> padding-left 16 vs 16 pass; the numbers are border-edge', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]), snap([domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'padding-left')).toMatchObject({ figma: 16, dom: 16, status: 'pass' });
  });

  it('DOM inset 24 -> FAIL delta 8 (the honest-red criterion)', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]), snap([domKid(24, 90), domText(138, 200)]), opts);
    const p = row(rows, 'padding-left');
    expect(p).toMatchObject({ figma: 16, dom: 24, status: 'fail' });
  });

  it('DOM has NO inset at all -> FAIL delta 16 (never 0v0)', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]), snap([domKid(0, 90), domText(114, 200)]), opts);
    expect(row(rows, 'padding-left')).toMatchObject({ figma: 16, dom: 0, status: 'fail' });
  });

  it('DOM implements the inset as REAL root padding -> pass, not demoted (demotes off on folded edges)', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]),
      snap([domKid(16, 90), domText(130, 200)], { paddings: { top: 0, right: 0, bottom: 0, left: 16 } }), opts);
    expect(row(rows, 'padding-left')).toMatchObject({ status: 'pass' });
  });

  it('fold 32 with DOM padding 16 and flush-at-16 content -> FAIL with srcChannel (fix_plan survives)', () => {
    const rows = diffPair(tile([spacer({ rect: R(0, 0, 32, 140) }), kidA({ rect: R(32, 25, 90, 90) }), kidB({ rect: R(146, 50, 200, 40) })],),
      snap([domKid(16, 90), domText(130, 200)], { paddings: { top: 0, right: 0, bottom: 0, left: 16 } }), opts);
    const p = row(rows, 'padding-left');
    expect(p!.status).toBe('fail');
    expect(p!.srcChannel).toBeDefined();                  // never silently demoted away
  });

  it('a consecutive run of edge spacers sums into one inset', () => {
    const rows = diffPair(tile([
      spacer({ rect: R(0, 0, 16, 140) }),
      spacer({ id: '5:8', name: 'Padding extra', rect: R(16, 0, 8, 140) }),
      kidA({ rect: R(24, 25, 90, 90) }), kidB({ rect: R(138, 50, 200, 40) })]),
    snap([domKid(24, 90), domText(138, 200)]), opts);
    expect(row(rows, 'padding-left')).toMatchObject({ figma: 24, dom: 24, status: 'pass' });
    expect(row(rows, 'spacer_inset')).toBeDefined();
  });

  it('trailing demote-off lock: fold 16 + DOM declared padding-right 8 with content short of it -> FAIL survives', () => {
    // mirror of the leading demote-off test: dualDemote's border-edge re-addition would
    // demote this genuine trailing shortfall (fig 16 vs dom 8+8=16); disabled on the folded
    // edge it stays red with its fix_plan channel.
    // the LAST real child is a FRAME (a trailing TEXT would trigger the legitimate text-hug
    // demote road and mask the lock under test)
    const rows = diffPair(tile([kidB({ rect: R(0, 50, 200, 40) }), kidA({ rect: R(294, 25, 90, 90) }), spacer({ id: '5:7', name: 'Padding end', rect: R(384, 0, 16, 140) })]),
      snap([domText(0, 200), domKid(302, 90)], { paddings: { top: 0, right: 8, bottom: 0, left: 0 } }), opts);
    const pr = row(rows, 'padding-right');
    expect(pr).toMatchObject({ figma: 16, dom: 8, status: 'fail' });
    expect(pr!.srcChannel).toBeDefined();
  });

  it('trailing DOM spacer box is removed symmetrically', () => {
    const rows = diffPair(tile([kidA({ rect: R(0, 25, 90, 90) }), kidB({ rect: R(184, 50, 200, 40) }), spacer({ id: '5:7', name: 'Padding end', rect: R(384, 0, 16, 140) })]),
      snap([domKid(0, 90), domText(184, 200), domKid(384, 16, { rect: R(384, 0, 16, 140) })]), opts);
    expect(row(rows, 'structure_mismatch')).toBeUndefined();
    expect(row(rows, 'padding-right')).toMatchObject({ figma: 16, dom: 16, status: 'pass' });
  });

  it('a trailing spacer folds symmetrically on padding-right', () => {
    const rows = diffPair(tile([kidA({ rect: R(0, 25, 90, 90) }), kidB({ rect: R(184, 50, 200, 40) }), spacer({ id: '5:7', name: 'Padding end', rect: R(384, 0, 16, 140) })]),
      snap([domKid(0, 90), domText(184, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeDefined();
    const pr = row(rows, 'padding-right');
    expect(pr).toBeDefined();
    expect(pr!.figma).toBe(16);
  });
});

describe('the DOM-side spacer symmetric removal', () => {
  it('both sides render spacers, equal extents -> pass, counts preserved, no structure_mismatch', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]),
      snap([domKid(0, 16, { rect: R(0, 0, 16, 140) }), domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'structure_mismatch')).toBeUndefined();
    expect(row(rows, 'padding-left')).toMatchObject({ figma: 16, dom: 16, status: 'pass' });
    expect(row(rows, 'spacer_inset')).toBeDefined();
  });

  it('DOM spacer is 24 wide vs design 16 -> FAIL delta 8 through the border-edge reading', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]),
      snap([domKid(0, 24, { rect: R(0, 0, 24, 140) }), domKid(24, 90), domText(138, 200)]), opts);
    expect(row(rows, 'padding-left')).toMatchObject({ figma: 16, dom: 24, status: 'fail' });
  });

  it('fig spacer + single real child vs DOM [spacer, content]: no wrong unwrap of the content child', () => {
    const rows = diffPair(tile([spacer(), kidA({ rect: R(16, 25, 384, 90), children: [kidB({ rect: R(130, 50, 200, 40) })] })]),
      snap([domKid(0, 16, { rect: R(0, 0, 16, 140) }), domKid(16, 384, { rect: R(16, 25, 384, 90) })]), opts);
    expect(row(rows, 'unwrapped')).toBeUndefined();
    expect(row(rows, 'spacer_inset')).toBeDefined();
  });
});

describe('path accounting and the trace invariant', () => {
  it('the live 2-child shape rides the unwrap road after conversion and stays honest', () => {
    const body: SpecChild = { id: '5:5', name: 'Body', type: 'FRAME', rect: R(16, 25, 384, 90),
      children: [kidA({ rect: R(16, 25, 90, 90) }), kidB({ rect: R(130, 50, 200, 40) })] };
    const rows = diffPair(tile([spacer(), body]), snap([domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeDefined();
    expect(row(rows, 'unwrapped')).toBeDefined();         // Body expanded over the two DOM children
    const g = row(rows, 'gap[0]');
    expect(g?.prop).not.toContain('Padding');
  });

  it('2v3 salvage transition: the trace DEMOTES to skip (padding rows suppressed) and the mismatch names the fold', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]),
      snap([domKid(16, 90), domText(130, 200), domKid(340, 40, { rect: R(340, 25, 40, 90) })]), opts);
    const si = row(rows, 'spacer_inset');
    expect(si).toMatchObject({ status: 'skip' });          // the fold<=>emitted-row invariant
    expect(si!.note).toMatch(/NOT measured/);
    const sm = row(rows, 'structure_mismatch');
    expect(sm).toBeDefined();                              // unguarded - the road must be the salvage road
    expect(sm!.note ?? '').toMatch(/spacer/i);
  });

  it('the structure_mismatch TOTAL-skip road demotes the trace too (no padding row exists)', () => {
    // three anchorless DOM boxes: fold -> 2v3, zero text anchors -> total skip early return
    const rows = diffPair(tile([spacer(), kidA(), kidB({ textSnippet: undefined })]),
      snap([domKid(16, 90), domKid(130, 90), domKid(240, 90)]), opts);
    const si = row(rows, 'spacer_inset');
    expect(si).toMatchObject({ status: 'skip' });
    expect(si!.note).toMatch(/NOT measured/);
  });

  it('the layout_axis_mismatch road demotes the trace too', () => {
    // non-monotonic DOM document order along the row axis -> axis-mismatch early return
    const rows = diffPair(tile([spacer(), kidA(), kidB()]),
      snap([domText(130, 200), domKid(16, 90)]), opts);
    if (row(rows, 'layout_axis_mismatch')) {
      expect(row(rows, 'spacer_inset')).toMatchObject({ status: 'skip' });
    } else {
      // the shape resolved on another road - the invariant still holds: pass requires a padding row
      const si = row(rows, 'spacer_inset');
      if (si?.status === 'pass') expect(row(rows, 'padding-left')).toBeDefined();
    }
  });

  it('DOM removal is BOUNDED by the fig fold count: a rendered accent-bar box is NOT eaten', () => {
    // fig keeps its accent bar (name gate); DOM renders it as a content-empty full-cross box
    // right after the spacer div. Unbounded removal ate both and broke the counts on correct
    // code (wave blocker); bounded removal takes exactly one and the zip stays 3v3... minus
    // the fold: fig [accent, A, B] vs dom [accent-div, A', B'] - equal, honest.
    const accent: SpecChild = { id: '5:11', name: 'Accent bar', type: 'RECTANGLE', rect: R(16, 0, 4, 140) };
    const rows = diffPair(tile([spacer(), accent, kidA({ rect: R(20, 25, 90, 90) }), kidB({ rect: R(134, 50, 200, 40) })]),
      snap([domKid(0, 16, { rect: R(0, 0, 16, 140) }), domKid(16, 4, { rect: R(16, 0, 4, 140) }), domKid(20, 90), domText(134, 200)]), opts);
    expect(row(rows, 'structure_mismatch')).toBeUndefined();
    expect(row(rows, 'spacer_inset')).toMatchObject({ status: 'pass' });
  });

  it('figInsetOn reads the POST-conversion population: size demotes when raw boxes agree (acceptance 10)', () => {
    // fig 400 wide with a 16px spacer; DOM declares padding-left 16 - the content-box size.w
    // fails by the padding, but the raw boxes agree: the encoding demote must fire, and it
    // only can when the spacer counts as the structural-inset evidence (post-conversion read).
    // Content reaches the RIGHT edge (trail 0) so the lead inset is the ONLY evidence - a
    // raw-array read (lead 0 through the flush spacer) has nothing left to fire on.
    const rows = diffPair(tile([spacer(), kidA(), kidB({ rect: R(200, 50, 200, 40) })]),
      snap([domKid(16, 90), domText(200, 200)], { paddings: { top: 0, right: 0, bottom: 0, left: 16 }, clientWidth: 400 }), opts);
    const w = row(rows, 'size.w');
    expect(w).toBeDefined();
    expect(w!.status).not.toBe('fail');                    // demoted (raw boxes agree), never a hard red
  });

  it('site 2: a spacer INSIDE an unwrapped wrapper converts - counts and padding both honest', () => {
    // without the in-unwrap conversion: expand yields [spacer, A, B] vs 2 DOM children ->
    // cardinality rollback -> salvage; with it the unwrap lands 2v2 over real children.
    const wrapper: SpecChild = { id: '5:6', name: 'Body', type: 'FRAME', rect: R(0, 0, 400, 140),
      children: [spacer(), kidA(), kidB()] };
    const rows = diffPair(tile([wrapper]), snap([domKid(16, 90), domText(130, 200)]), opts);
    expect(row(rows, 'spacer_inset')).toBeDefined();
    expect(row(rows, 'unwrapped')).toBeDefined();
    expect(row(rows, 'structure_mismatch')).toBeUndefined();
    const g = row(rows, 'gap[0]');
    expect(g).toBeDefined();
    expect(g!.prop).not.toContain('Padding');
  });

  it('dom-dom sides gate: the same fabricated spacer shape does not fold', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]), snap([domKid(16, 90), domText(130, 200)]),
      { tolerancePx: 1, sides: 'dom-dom' });
    expect(row(rows, 'spacer_inset')).toBeUndefined();
  });

  it('the rendered report SHOWS the spacer_inset pass row (render allowlist)', () => {
    const rows = diffPair(tile([spacer(), kidA(), kidB()]), snap([domKid(16, 90), domText(130, 200)]), opts);
    const md = renderReport({
      file: 'abc', tolerancePx: 1, depthLevels: 4,
      pairs: [{ node_id: '5:1', label: 'tile', rows, summary: { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 }, coverage: { measured: [], skipped: [] } } as never],
    });
    expect(md).toContain('spacer_inset');
  });
});
