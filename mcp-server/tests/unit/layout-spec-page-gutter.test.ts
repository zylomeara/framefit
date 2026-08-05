// mcp-server/tests/unit/layout-spec-page-gutter.test.ts
//
// THE DEFECT. A classic (non-overlay) page scrollbar takes its width off the LAYOUT VIEWPORT, not
// off the window: at a 1920 window Chrome reports `window.innerWidth` 1920 and
// `document.documentElement.clientWidth` 1909, and a full-bleed `main` measures 1909. Against a
// Figma frame of 1920 that shipped as a hard FAIL carrying `edit the layout rule, not px` -- the
// tool telling the reader to change a working CSS rule over an 11px scrollbar.
//
// EVERY NUMBER BELOW WAS MEASURED IN A REAL CHROME (headless, `--hide-scrollbars` disabled, window
// 1920), by the REAL extractor, on fixtures whose design side is the SAME page captured with the
// gutter suppressed -- so design == code by construction and the only difference is the gutter.
//
// WHY BOTH ARMS ARE HERE. The obvious rule -- "the shortfall equals the gutter, so it is the
// gutter" -- passes every green fixture and is a false-green machine: the RED cases below are the
// ones that kill it, and a suite with only the green arm would have shipped it.
//
// WHAT THE EXPLANATION IS ALLOWED TO COVER. Exactly one row: size.w of the root that IS the layout
// viewport, where the shortfall equals the gutter by arithmetic and the only slack is the sub-pixel
// rounding of an integer clientWidth against a fractional rect. The rows the gutter also MOVES --
// trailing padding, distributed gap, centred cross offset -- move by amounts set by CSS this capture
// does not measure, so they keep their fails and get a pointer instead of an allowance.
import { describe, it, expect } from 'vitest';
import { diffPair, summarize } from '../../src/domain/layout-spec/diff.js';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import type { LayoutSpec, DomSnapshotOk, DomChild, SpecChild } from '../../src/domain/layout-spec/types.js';

const kid = (x: number, w: number, name: string): { fig: SpecChild; dom: DomChild } => ({
  fig: { id: '12:341', name, type: 'FRAME', rect: { x, y: 0, w, h: 80 } },
  dom: { kind: 'element', tag: 'div', rect: { x, y: 0, w, h: 80 } },
});

const spec = (w: number, axis: 'row' | 'col', kids: SpecChild[]): LayoutSpec => ({
  node: { id: '12:340', name: 'main', type: 'FRAME' },
  rect: { x: 0, y: 0, w, h: 720 }, axis, children: kids,
});

const snap = (over: Partial<DomSnapshotOk>): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: 'main', innerWidth: 1920,
  rect: { x: 0, y: 0, w: 1909, h: 720 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 1909, clientHeight: 720,
  children: [], ...over,
});

const find = (rows: ReturnType<typeof diffPair>, prefix: string) => rows.find((r) => r.prop.startsWith(prefix))!;
const verdict = (rows: ReturnType<typeof diffPair>) =>
  buildVerification([{ node_id: '12:340', selector: 'main', rows, summary: summarize(rows) } as never], { depthLevels: 4 });

describe('a page scrollbar gutter is explained, never silently passed', () => {
  // Measured: window 1920, documentElement.clientWidth 1909, `main` rect.w 1909, two centred
  // 1200-wide children at x 354.5 where the 1920 frame puts them at 360.
  const centred = [kid(360, 1200, 'hero'), kid(360, 1200, 'shelf')];
  const shelfSpec = spec(1920, 'col', centred.map((k) => k.fig));
  const shelfDom = (over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => snap({
    layoutViewportWidth: 1909,
    children: centred.map((k) => ({ ...k.dom, rect: { ...k.dom.rect, x: 354.5 } })),
    ...over,
  });

  it('size.w is 🟰 demoted with both measured widths in the row, and emits no fix_plan channel', () => {
    const row = find(diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 }), 'size.w');
    expect(row).toMatchObject({ status: 'demoted', figma: 1920, dom: 1909, delta: 11 });
    // The receipt must SAY it: the gutter and both widths it was derived from are in the row.
    expect(row.note).toContain('page scrollbar gutter 11px');
    expect(row.note).toContain('window 1920');
    expect(row.note).toContain('layout viewport 1909');
    // The sharpest half of the defect: no channel => fix_plan emits no edit for it.
    expect(row.srcChannel).toBeUndefined();
  });

  it('a demote is not a pass: verification.complete stays false and mints no blocking action for it', () => {
    // The root's own size.w is the demoted row; nothing else on this pair is demoted, so a pair whose
    // ONLY discrepancy is the gutter still reads "not verified" rather than "verified clean".
    const bar = [kid(0, 200, 'logo'), kid(240, 400, 'navi')];
    const rows = diffPair(spec(1920, 'row', bar.map((k) => k.fig)),
      shelfDom({ children: bar.map((k) => k.dom) }), { tolerancePx: 1, frameWidth: 1920 });
    expect(find(rows, 'size.w').status).toBe('demoted');
    expect(summarize(rows).demoted).toBe(1);
    const v = verdict(rows);
    expect(v.complete).toBe(false);
    expect(v.blocking).toEqual([]);
  });

  it('the sub-pixel residual the capture itself produces is still explained (integer clientWidth vs fractional rect)', () => {
    // Measured: `documentElement.clientWidth` is an INTEGER, `getBoundingClientRect().width` is not,
    // so at a fractional layout viewport a genuinely spanning box misses the gutter arithmetic by the
    // rounding alone -- 0.400 / 0.333 / 0.143 under real browser zoom, and exactly 0.000 at
    // deviceScaleFactor 1 / 1.25 / 2. All below half a pixel, which is what the allowance is; this is
    // the largest of them, 0.400.
    const row = find(diffPair(shelfSpec, shelfDom({ rect: { x: 0, y: 0, w: 1908.6, h: 720 } }),
      { tolerancePx: 1, frameWidth: 1920 }), 'size.w');
    expect(row).toMatchObject({ status: 'demoted', dom: 1908.6, delta: 11.4 });
    // ...and half a pixel is not sub-pixel: the row's numbers are already rounded to 0.1, so the
    // residual is measured on what the reader is shown, and it rounds AWAY from the demote.
    const half = find(diffPair(shelfSpec, shelfDom({ rect: { x: 0, y: 0, w: 1908.5, h: 720 } }),
      { tolerancePx: 1, frameWidth: 1920 }), 'size.w');
    expect(half).toMatchObject({ status: 'fail', dom: 1908.5, delta: 11.5 });
  });

  it('`scrollbar-gutter: stable both-edges` is the same measurement, split across both edges', () => {
    // Measured in Chrome, same 1920 window and same 11px bar: innerWidth 1920, documentElement
    // .clientWidth 1898 (BOTH reserved gutters), full-bleed `main` x 11 w 1898. The box is inset by
    // exactly half the reported gutter on each edge, so the anchoring test takes x == gutter/2 too --
    // otherwise this page keeps the original defect: a hard ❌ of Δ22 carrying "edit the layout rule".
    const row = find(diffPair(shelfSpec, shelfDom({
      innerWidth: 1920, layoutViewportWidth: 1898, rect: { x: 11, y: 0, w: 1898, h: 720 }, clientWidth: 1898,
    }), { tolerancePx: 1, frameWidth: 1920 }), 'size.w');
    expect(row).toMatchObject({ status: 'demoted', figma: 1920, dom: 1898, delta: 22 });
    expect(row.note).toContain('page scrollbar gutter 22px');
    expect(row.note).toContain('layout viewport 1898');
    expect(row.srcChannel).toBeUndefined();
  });

  it('the viewport row stops reading "the window is exactly right" without naming the CSS canvas', () => {
    const rows = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 });
    expect(find(rows, 'viewport')).toMatchObject({ status: 'pass', figma: 1920, dom: 1920 });
    expect(find(rows, 'viewport').note).toContain('CSS layout viewport 1909');
  });

  it('and the markdown reader sees it, not only a JSON consumer', () => {
    // report.ts renders a row only when its status is not `pass`; the viewport row is a pass BY
    // CONSTRUCTION, so the one sentence that explains the 🟰 beside it used to reach the JSON rows
    // only. Without a gutter the row carries no note and stays filtered out.
    const rows = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 });
    const md = renderReport({ file: 'RVVo', tolerancePx: 1,
      pairs: [{ node_id: '12:340', selector: 'main', rows, summary: summarize(rows) } as never] });
    expect(md).toContain('CSS layout viewport 1909');
    expect(md).toContain('🟰 size.w: Figma 1920 / DOM 1909');

    const clean = diffPair(shelfSpec, shelfDom({ layoutViewportWidth: 1920 }), { tolerancePx: 1, frameWidth: 1920 });
    const cleanMd = renderReport({ file: 'RVVo', tolerancePx: 1,
      pairs: [{ node_id: '12:340', selector: 'main', rows: clean, summary: summarize(clean) } as never] });
    expect(cleanMd).not.toContain('viewport:');
  });

  // ── RED: what must still fail ────────────────────────────────────────────────────────────────
  it('RED: one pixel more than the gutter is one pixel of layout, and it fails', () => {
    // The same capture, against a frame the design says is 1921: short by gutter + 1. An allowance of
    // `gutter + tolerancePx` made the window 12px wide where the gutter is 11 and demoted this --
    // dropping the pair to zero fails with an empty fix_plan over a real 1px regression.
    const row = find(diffPair(spec(1921, 'col', shelfSpec.children), shelfDom(),
      { tolerancePx: 1, frameWidth: 1921 }), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1921, dom: 1909, delta: 12 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
  });

  it('RED: a regression of exactly the gutter on a trailing padding / a gap / a cross offset still fails', () => {
    // The gutter moves each of these by a DIFFERENT amount through a different mechanism -- the
    // trailing padding only while the slack absorbs the loss, the gap only while the main axis
    // distributes free space, the cross offset only when centred (measured: HALF the gutter). The
    // capture measures none of those conditions, so a flat gutter-wide allowance on all three turns a
    // real 11px regression on a full-bleed container into zero fails. They fail, and they say why.
    const gutterNote = 'the pair root also lost 11px to a page scrollbar gutter';

    // trailing padding: fixed left-anchored children, the trailing slack takes the whole 11.
    const bar = [kid(0, 200, 'logo'), kid(240, 400, 'navi')];
    const padRow = find(diffPair(spec(1920, 'row', bar.map((k) => k.fig)),
      shelfDom({ children: bar.map((k) => k.dom) }), { tolerancePx: 1, frameWidth: 1920 }), 'padding-right');
    expect(padRow).toMatchObject({ status: 'fail', figma: 1280, dom: 1269, delta: 11 });
    expect(padRow.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
    expect(padRow.note).toContain(gutterNote);

    // space-between gap: the distribution hands the whole 11 to the gap.
    const sbFig = [kid(0, 200, 'l').fig, kid(1520, 400, 'r').fig];
    const sbDom = [kid(0, 200, 'l').dom, kid(1509, 400, 'r').dom];
    const gapRow = find(diffPair(spec(1920, 'row', sbFig), shelfDom({ children: sbDom }),
      { tolerancePx: 1, frameWidth: 1920 }), 'gap[0]');
    expect(gapRow).toMatchObject({ status: 'fail', figma: 1320, dom: 1309, delta: 11 });
    expect(gapRow.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
    expect(gapRow.note).toContain(gutterNote);

    // cross offset on centred content: measured Δ5.5, i.e. HALF the gutter -- so an 11px allowance
    // here would cover twice what the gutter can even reach.
    const offs = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 })
      .filter((r) => r.prop.startsWith('offset-cross'));
    expect(offs).toHaveLength(2);
    for (const r of offs) {
      expect(r).toMatchObject({ status: 'fail', figma: 360, dom: 354.5, delta: 5.5 });
      expect(r.srcChannel).toMatchObject({ kind: 'child', editKind: 'layout' });
      expect(r.note).toContain(gutterNote);
    }
  });

  it('RED: the same width at the wrong x is a coincidence of magnitude, not the layout viewport', () => {
    // A horizontally overflowing page: a section 1909 wide pushed to x 356 by an oversized sibling.
    // It never paid the gutter -- the gutter is past the RIGHT edge of the layout viewport, and this
    // box does not touch either edge -- so its 11px shortfall is a defect with an address.
    const row = find(diffPair(
      spec(1920, 'row', [kid(0, 200, 'a').fig]),
      snap({ layoutViewportWidth: 1909, rect: { x: 356, y: 0, w: 1909, h: 720 }, clientWidth: 1909,
        children: [kid(356, 200, 'a').dom] }),
      { tolerancePx: 1, frameWidth: 1920 },
    ), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1920, dom: 1909, delta: 11 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
  });

  it('RED: a shortfall LARGER than the gutter keeps its fail, its delta and its edit address', () => {
    // Measured: the same page, a section the design says is 1920 that the DOM makes 1900 -- 11px of
    // gutter plus a real 9px defect. rect.w 1900 != layout viewport 1909, so it never spans it.
    const row = find(diffPair(
      spec(1920, 'row', [kid(0, 200, 'a').fig]),
      snap({ layoutViewportWidth: 1909, rect: { x: 0, y: 0, w: 1900, h: 720 }, clientWidth: 1900,
        children: [kid(0, 200, 'a').dom] }),
      { tolerancePx: 1, frameWidth: 1920 },
    ), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1920, dom: 1900, delta: 20 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
  });

  it('RED: on a pair root that DOES span, a derived row short by more than the gutter still fails', () => {
    // The span gate is a property of the ROOT, so it alone cannot protect the rows derived from it:
    // this `main` spans the layout viewport (1909) while its last child is 40px too wide, leaving a
    // trailing padding of 1229 against a designed 1280 -- 11px of gutter plus a real 40px defect.
    // Subtract-then-compare is what keeps this a fail; a rule that demoted anything short on a
    // spanning root would swallow it whole.
    const rows = diffPair(
      spec(1920, 'row', [kid(0, 200, 'logo').fig, kid(240, 400, 'navi').fig]),
      shelfDom({ children: [kid(0, 200, 'logo').dom, kid(240, 440, 'navi').dom] }),
      { tolerancePx: 1, frameWidth: 1920 },
    );
    expect(find(rows, 'padding-right')).toMatchObject({ status: 'fail', figma: 1280, dom: 1229, delta: 51 });
    expect(find(rows, 'padding-right').srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
    // ...while the root's own width, which really is the layout viewport, is still explained.
    expect(find(rows, 'size.w').status).toBe('demoted');
  });

  it('RED: a max-width container never paid the gutter, so a real defect of EXACTLY the gutter still fails', () => {
    // Measured in Chrome: `::-webkit-scrollbar { width: 8px }`, window 1920, documentElement
    // .clientWidth 1912, `.container { max-width: 1200; margin: 0 auto }` at x 356, w 1200, carrying
    // a leftover `padding-right: 8px` the Figma container does not have -> content box 1192.
    // Shortfall 8 == gutter 8 EXACTLY: the arithmetic-coincidence rule ships this clean. The span
    // measurement does not, because 1200 is not 1912.
    const cards = [kid(356, 381.3, 'card0'), kid(761.3, 381.3, 'card1'), kid(1166.7, 381.3, 'card2')];
    const rows = diffPair(
      spec(1200, 'row', cards.map((k) => k.fig)),
      snap({ selector: '.container', layoutViewportWidth: 1912,
        rect: { x: 356, y: 0, w: 1200, h: 120 }, clientWidth: 1200,
        paddings: { top: 0, right: 8, bottom: 0, left: 0 },
        children: cards.map((k) => k.dom) }),
      { tolerancePx: 1, frameWidth: 1920 },
    );
    expect(find(rows, 'size.w')).toMatchObject({ status: 'fail', figma: 1200, dom: 1192, delta: 8 });
    expect(find(rows, 'size.w').srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
    expect(verdict(rows).complete).toBe(false);
  });

  it('a pre-release capture (no layoutViewportWidth) behaves exactly as before: the shortfall stays a fail', () => {
    // Why the schema version is NOT bumped: an old extractor loses the explanation, it never gains a
    // green. Same snapshot, field removed.
    const bare = shelfDom();
    delete bare.layoutViewportWidth;
    const row = find(diffPair(shelfSpec, bare, { tolerancePx: 1, frameWidth: 1920 }), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1920, dom: 1909, delta: 11 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
  });

  it('a page with no gutter at all (overlay scrollbars: innerWidth == clientWidth) demotes nothing', () => {
    // Measured on this machine with AppleShowScrollBars=Automatic: window 1920, documentElement
    // .clientWidth 1920. A 1909-wide `main` there is a REAL 11px defect and must read as one.
    const row = find(diffPair(shelfSpec, shelfDom({ layoutViewportWidth: 1920 }), { tolerancePx: 1, frameWidth: 1920 }), 'size.w');
    expect(row).toMatchObject({ status: 'fail', delta: 11 });
  });
});
