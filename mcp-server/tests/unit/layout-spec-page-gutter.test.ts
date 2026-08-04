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
import { describe, it, expect } from 'vitest';
import { diffPair, summarize } from '../../src/domain/layout-spec/diff.js';
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

  it('a demote is not a pass: verification.complete stays false and mints no blocking action', () => {
    const rows = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 });
    const v = verdict(rows);
    expect(summarize(rows).fail).toBe(0);
    expect(v.complete).toBe(false);
    expect(v.blocking).toEqual([]);
  });

  it('the rows the gutter also moves come with it: cross offsets on a col axis (measured Δ5.5 = half)', () => {
    const rows = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 });
    const offs = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(offs).toHaveLength(2);
    for (const r of offs) expect(r).toMatchObject({ status: 'demoted', figma: 360, dom: 354.5, delta: 5.5 });
    expect(offs.every((r) => r.srcChannel === undefined)).toBe(true);
  });

  it('and on a row axis: the trailing padding (measured fig 1280 / dom 1269) and a distributed gap', () => {
    // nav.bar: fixed left-anchored children at 0 and 240 -- the trailing slack absorbs the loss.
    const bar = [kid(0, 200, 'logo'), kid(240, 400, 'navi')];
    const padRow = find(diffPair(
      spec(1920, 'row', bar.map((k) => k.fig)),
      shelfDom({ children: bar.map((k) => k.dom) }),
      { tolerancePx: 1, frameWidth: 1920 },
    ), 'padding-right');
    expect(padRow).toMatchObject({ status: 'demoted', figma: 1280, dom: 1269, delta: 11 });
    expect(padRow.srcChannel).toBeUndefined();

    // space-between: the gap carries the whole gutter (measured fig 1320 / dom 1309).
    const sbFig = [kid(0, 200, 'l').fig, kid(1520, 400, 'r').fig];
    const sbDom = [kid(0, 200, 'l').dom, { ...kid(1509, 400, 'r').dom }];
    const gapRow = find(diffPair(spec(1920, 'row', sbFig), shelfDom({ children: sbDom }), { tolerancePx: 1, frameWidth: 1920 }), 'gap[0]');
    expect(gapRow).toMatchObject({ status: 'demoted', figma: 1320, dom: 1309, delta: 11 });
  });

  it('the viewport row stops reading "the window is exactly right" without naming the CSS canvas', () => {
    const rows = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 });
    expect(find(rows, 'viewport')).toMatchObject({ status: 'pass', figma: 1920, dom: 1920 });
    expect(find(rows, 'viewport').note).toContain('CSS layout viewport 1909');
  });

  // ── RED: what must still fail ────────────────────────────────────────────────────────────────
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
