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
// WHAT THE EXPLANATION IS ALLOWED TO COVER. Two rows, each because the capture PROVES the quantity.
// size.w of the root the gutter was taken from, where the shortfall equals the gutter by arithmetic
// and the only slack is the sub-pixel rounding of an integer clientWidth against a fractional rect.
// And the cross offset of a child the capture shows CENTRED on both sides, which the same arithmetic
// puts at exactly half of what the root lost. The rows whose share is set by CSS this capture does
// NOT measure -- trailing padding, a distributed gap, a cross offset that is not provably centred --
// keep their fails and get a pointer instead of an allowance, in the rendered row AND in the
// machine-facing fix_plan entry built from that row.
//
// RE-MEASURED, one page (window 1920, body 4000 tall), `main` at width:100%, three children of equal
// width at Figma offsets 0 / 360 / 720 (leading-anchored / centred / trailing-anchored):
//
//     scrollbar-gutter          innerWidth  clientWidth   main x  main w   child offsets
//     auto / stable, 11px bar         1920         1909        0    1909   0 / 354.5 / 709
//     stable both-edges, 11px bar     1920         1909       11    1898   0 / 349   / 698
//     auto / stable, 15px bar         1920         1905        0    1905   0 / 352.5 / 705
//     stable both-edges, 15px bar     1920         1905       15    1890   0 / 345   / 690
//
// Two facts this file previously had wrong. `documentElement.clientWidth` is the VIEWPORT width: under
// both-edges it does NOT double -- the reserved pair shows up in the ELEMENT instead (x == bar,
// w == clientWidth - bar). And a centred child loses half of what the ROOT lost (5.5 / 11 / 7.5 / 15
// above), which is bar/2 only in the spanning shape. The earlier reading recorded clientWidth 1898 /
// gutter 22 / x 11 for both-edges and gated the second anchoring on x == bar/2 -- a predicate a real
// both-edges page can never satisfy (it fails the span test outright) and an ordinary 11px page can,
// which is why the both-edges fixture below is now the measured capture and the x ~ bar/2 band has
// its own RED.
import { describe, it, expect } from 'vitest';
import { diffPair, summarize } from '../../src/domain/layout-spec/diff.js';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import { buildFixPlan } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
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
    // The claim is about a pair whose ONLY discrepancy is the gutter, so the fixture has to BE one:
    // left-anchored children whose DOM offsets match the design exactly, on a col axis where the
    // paddings are measured on y and match too. Every row but size.w passes -- summary.fail 0 -- so
    // `complete: false` below can only have come from the demote. The earlier fixture was a row-axis
    // bar whose padding-right failed by the gutter, which forced the same false through the FAIL and
    // would have kept passing had a demote started counting as verified.
    const flush = [kid(0, 200, 'logo'), kid(0, 400, 'navi')];
    const rows = diffPair(spec(1920, 'col', flush.map((k) => k.fig)),
      shelfDom({ children: flush.map((k) => k.dom) }), { tolerancePx: 1, frameWidth: 1920 });
    expect(find(rows, 'size.w').status).toBe('demoted');
    const s = summarize(rows);
    expect({ fail: s.fail, demoted: s.demoted, warn: s.warn, unchecked: s.unchecked, review: s.review })
      .toEqual({ fail: 0, demoted: 1, warn: 0, unchecked: 0, review: 0 });
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

  it('`scrollbar-gutter: stable both-edges` is the same bar reserved twice, and the ROOT carries both', () => {
    // The measured capture (see the table at the top): innerWidth 1920, documentElement.clientWidth
    // 1909 -- the viewport width, which excludes the PAINTED bar and knows nothing about the one
    // reserved on the opposite edge -- and a full-bleed `main` at x 11 w 1898, inset by a full bar on
    // each edge. So the root lost 22 while `innerWidth - clientWidth` reads 11: the anchoring test is
    // the inset SHAPE (x == bar, w == clientWidth - bar) and the quantity spent is 2*bar. Without it
    // this page keeps the original defect -- a hard ❌ of Δ22 carrying "edit the layout rule".
    const row = find(diffPair(shelfSpec, shelfDom({
      innerWidth: 1920, layoutViewportWidth: 1909, reservedGutter: 11, reservedGutterLeft: 11,
      rect: { x: 11, y: 0, w: 1898, h: 720 }, clientWidth: 1898,
    }), { tolerancePx: 1, frameWidth: 1920 }), 'size.w');
    expect(row).toMatchObject({ status: 'demoted', figma: 1920, dom: 1898, delta: 22 });
    expect(row.note).toContain('page scrollbar gutter 22px');
    expect(row.note).toContain('inset by 11px on each edge');
    expect(row.srcChannel).toBeUndefined();
  });

  it('RED: x == half the bar on an ORDINARY page is a number, not the both-edges shape', () => {
    // The band the inset shape replaced. At an 11px gutter and a layout viewport of 1909, a box
    // 1909 wide sitting at x 5.5 overflows the layout viewport by 5.5 -- it is a box on a horizontally
    // scrolling page, not a root inset by a reserved gutter (which measures x 11 w 1898). The old
    // `|x - gutter/2| <= structTol` accepted the whole band 4.5..6.5 and demoted every one of them.
    for (const x of [4.5, 5, 5.4, 5.5, 5.6, 6, 6.5]) {
      const row = find(diffPair(shelfSpec, shelfDom({ rect: { x, y: 0, w: 1909, h: 720 } }),
        { tolerancePx: 1, frameWidth: 1920 }), 'size.w');
      expect(row, `x=${x}`).toMatchObject({ status: 'fail', figma: 1920, dom: 1909, delta: 11 });
      expect(row.srcChannel, `x=${x}`).toMatchObject({ kind: 'root', editKind: 'layout' });
    }
  });

  it('RED: a shortfall SMALLER than the gutter is as unexplained as a larger one', () => {
    // The span gate accepts rect.w within structTol of the layout viewport, and structTol follows
    // tolerancePx. At tolerancePx 4 a root of 1913 against a 1909 layout viewport passes the span test
    // on that slack, and its shortfall against the 1920 frame is 7 -- which an "11px gutter" does not
    // explain in either direction. A one-sided residual (`short - gutter < 0.5`) demoted it.
    const row = find(diffPair(shelfSpec, shelfDom({ rect: { x: 0, y: 0, w: 1913, h: 720 }, clientWidth: 1913 }),
      { tolerancePx: 4, frameWidth: 1920 }), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1920, dom: 1913, delta: 7 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
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
    //
    // The assertion is the rendered LINE, not the phrase. "CSS layout viewport 1909" also lives in the
    // size.w demote note two lines down, so a `contains` on it was satisfied whether the viewport row
    // rendered or not: reverting the render gate to `r.prop === 'unwrapped'` passed the whole suite.
    const rows = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 });
    const md = renderReport({ file: 'AbCdEf012345', tolerancePx: 1,
      pairs: [{ node_id: '12:340', selector: 'main', rows, summary: summarize(rows) } as never] });
    expect(md.split('\n')).toContainEqual(expect.stringMatching(/^- ✅ viewport: Figma 1920 \/ DOM 1920 — CSS layout viewport 1909\b/));
    expect(md).toContain('🟰 size.w: Figma 1920 / DOM 1909');

    const clean = diffPair(shelfSpec, shelfDom({ layoutViewportWidth: 1920 }), { tolerancePx: 1, frameWidth: 1920 });
    const cleanMd = renderReport({ file: 'AbCdEf012345', tolerancePx: 1,
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

  it('RED: a regression of exactly the gutter on a trailing padding / a gap still fails', () => {
    // The gutter moves these through mechanisms the capture cannot see -- the trailing padding only
    // while the slack absorbs the loss, the gap only while the main axis distributes free space. A
    // flat gutter-wide allowance on them turns a real 11px regression on a full-bleed container into
    // zero fails. They fail, and they say why. (The third row of the old trio, a CENTRED cross offset,
    // is derivable from this capture and is demoted now -- the two tests after this one.)
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
  });

  it('a centred child IS derivable: leading == trailing on both sides, so the share is exactly half', () => {
    // Measured (top of file, 11px bar): fig 360 / dom 354.5, and 360 - 354.5 == 11/2 exactly. Nothing
    // is assumed -- the capture carries the root rect and every child rect, so "centred" is a fact of
    // it on both sides, and a centre that sits in the middle of a box which lost 11px of width moves
    // by 5.5. Demoted, not passed: 🟰 keeps verification.complete false and prints both numbers.
    const offs = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 })
      .filter((r) => r.prop.startsWith('offset-cross'));
    expect(offs).toHaveLength(2);
    for (const r of offs) {
      expect(r).toMatchObject({ status: 'demoted', figma: 360, dom: 354.5, delta: 5.5 });
      expect(r.note).toContain('centred in the pair root on both sides');
      expect(r.note).toContain('moves a centred offset by exactly half of itself, 5.5px');
      expect(r.srcChannel).toBeUndefined();   // and therefore no fix_plan edit
      expect(r.caveat).toBeUndefined();
    }
    // The same page under `stable both-edges` (measured: root x 11 w 1898, centred child at x 360, so
    // an offset of 349 against a designed 360): the root lost 22, half of it is 11, and half of
    // `innerWidth - clientWidth` -- 5.5 -- would leave this row failing by 5.5 of nothing.
    const both = diffPair(shelfSpec, shelfDom({
      layoutViewportWidth: 1909, reservedGutter: 11, reservedGutterLeft: 11,
      rect: { x: 11, y: 0, w: 1898, h: 720 }, clientWidth: 1898,
      children: [kid(360, 1200, 'hero').dom, kid(360, 1200, 'shelf').dom],
    }), { tolerancePx: 1, frameWidth: 1920 }).filter((r) => r.prop.startsWith('offset-cross'));
    expect(both).toHaveLength(2);
    for (const r of both) expect(r).toMatchObject({ status: 'demoted', figma: 360, dom: 349, delta: 11 });
  });

  it('RED: centred by DESIGN but not in the DOM keeps its fail -- the proof is two-sided', () => {
    // The mirror of the row above, and the half that had no fixture. The Figma side IS centred, the
    // DOM side is NOT, and the offset delta is exactly half the gutter anyway. A predicate that
    // proved centring on the Figma side alone would demote a real defect whose number happens to
    // coincide -- measured: dropping the DOM-side test from crossGutterShare left the whole suite
    // green while this case turned into a demote, losing its fail, its channel and its caveat. It is
    // the same coincidence the span gate refuses one level up.
    //
    // Designed: root 1920, child 1200 centred at 360 (leading 360 == trailing 360).
    // Rendered:  root 1909 (gutter 11), child at x 354.5 but 1190 wide -- leading 354.5, trailing
    // 364.5, not centred. The 5.5 is real: the child is 10px narrower than it should be.
    const offCentre = [kid(360, 1200, 'hero'), kid(360, 1200, 'shelf')];
    const offs = diffPair(spec(1920, 'col', offCentre.map((k) => k.fig)),
      shelfDom({ children: offCentre.map((k) => ({ ...k.dom, rect: { x: 354.5, y: 0, w: 1190, h: 80 } })) }),
      { tolerancePx: 1, frameWidth: 1920 }).filter((r) => r.prop.startsWith('offset-cross'));
    expect(offs.length).toBeGreaterThan(0);
    for (const r of offs) {
      expect(r.status, 'a DOM that is not centred must not borrow the centred share').toBe('fail');
      expect(r.delta).toBe(5.5);
      expect(r.srcChannel, 'and it keeps the address of the edit').toMatchObject({ editKind: 'layout' });
      expect(r.caveat, 'with the pointer, so the gutter is checked before editing').toContain('page scrollbar gutter');
    }
  });

  it('RED: a cross offset that is not provably centred keeps its fail, its delta and its address', () => {
    // Same page, same gutter, the children NOT centred: measured trailing-anchored offsets are 709
    // against a designed 720 -- a loss of the WHOLE gutter, twice the centred share, through an
    // alignment this capture does not measure. It is derivable in principle and is not derived here,
    // so it keeps everything a fail keeps, plus the pointer.
    const trailing = [kid(720, 1200, 'hero'), kid(720, 1200, 'shelf')];
    const rows = diffPair(spec(1920, 'col', trailing.map((k) => k.fig)),
      shelfDom({ children: trailing.map((k) => ({ ...k.dom, rect: { ...k.dom.rect, x: 709 } })) }),
      { tolerancePx: 1, frameWidth: 1920 });
    const offs = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(offs).toHaveLength(2);
    for (const r of offs) {
      expect(r).toMatchObject({ status: 'fail', figma: 720, dom: 709, delta: 11 });
      expect(r.srcChannel).toMatchObject({ kind: 'child', editKind: 'layout' });
      expect(r.note).toContain('the pair root also lost 11px to a page scrollbar gutter');
    }

    // The case that makes the centring test load-bearing rather than decorative: a child short by
    // EXACTLY half the gutter and not centred by either side's measurement (leading 100 against a
    // trailing 1620). A left-anchored child does not move when the gutter is taken -- measured offset
    // 0 -> 0 -- so these 5.5px are 5.5px of layout. With the residual test alone this demotes.
    const pinned = kid(100, 200, 'badge');
    const off = find(diffPair(spec(1920, 'col', [pinned.fig]),
      shelfDom({ children: [{ ...pinned.dom, rect: { x: 94.5, y: 0, w: 200, h: 80 } }] }),
      { tolerancePx: 1, frameWidth: 1920 }), 'offset-cross');
    expect(off).toMatchObject({ status: 'fail', figma: 100, dom: 94.5, delta: 5.5 });
    expect(off.srcChannel).toMatchObject({ kind: 'child', editKind: 'layout' });
    expect(off.note).toContain('the pair root also lost 11px to a page scrollbar gutter');
    expect(off.caveat).toContain('confirm this delta is not that before editing');

    // And BOTH sides have to prove it. The DOM side alone is not enough: a 200-wide box centred in the
    // DOM (854.5) against a 300-wide box the design puts at 860 -- not centred, leading 860 vs
    // trailing 760 -- differs by exactly 5.5 too. The design did not ask for centring, so nothing here
    // says the gutter is what moved it.
    const dropped = find(diffPair(spec(1920, 'col', [kid(860, 300, 'badge').fig]),
      shelfDom({ children: [{ ...kid(0, 200, 'badge').dom, rect: { x: 854.5, y: 0, w: 200, h: 80 } }] }),
      { tolerancePx: 1, frameWidth: 1920 }), 'offset-cross');
    expect(dropped).toMatchObject({ status: 'fail', figma: 860, dom: 854.5, delta: 5.5 });
    expect(dropped.srcChannel).toMatchObject({ kind: 'child', editKind: 'layout' });
  });

  it('RED: a centred child short by MORE than half the gutter is short by something else', () => {
    // Centring is proved on both sides and the allowance is still exactly 5.5: this child is at 353.5,
    // one real pixel further left than the gutter accounts for. Same subtract-then-compare as size.w.
    const off = kid(360, 1200, 'hero');
    const rows = diffPair(spec(1920, 'col', [off.fig]),
      shelfDom({ children: [{ ...off.dom, rect: { x: 353.5, y: 0, w: 1202, h: 80 } }] }),
      { tolerancePx: 1, frameWidth: 1920 });
    const row = find(rows, 'offset-cross');
    expect(row).toMatchObject({ status: 'fail', figma: 360, dom: 353.5, delta: 6.5 });
    expect(row.srcChannel).toMatchObject({ kind: 'child', editKind: 'layout' });
  });

  it('the caveat reaches the PLAN, which is the surface this tool is read by', () => {
    // The rendered row said "the pair root also lost 11px to a page scrollbar gutter (see size.w)" and
    // four lines below it the Edits block prescribed "edit the layout rule, not px" over those same
    // pixels with nothing attached -- and fix_plan in the JSON likewise. A consumer reading only the
    // plan got the un-caveated instruction, which is the original defect surviving in the machine
    // channel. The caveat now travels on the edit.
    const bar = [kid(0, 200, 'logo'), kid(240, 400, 'navi')];
    const rows = diffPair(spec(1920, 'row', bar.map((k) => k.fig)),
      shelfDom({ children: bar.map((k) => k.dom) }), { tolerancePx: 1, frameWidth: 1920 });
    const source = { root: { module: 'Shelf.module.css', local: 'bar', raw: 'Shelf-module__bar' } };
    const plan = buildFixPlan(rows, source)!;
    const edit = plan.fix_plan[0].edits.find((e) => e.prop === 'padding-right')!;
    expect(edit.kind).toBe('layout');
    expect(edit.caveat).toBe('the pair root lost 11px to a page scrollbar gutter (see size.w): confirm this delta is not that before editing');

    const md = renderReport({ file: 'AbCdEf012345', tolerancePx: 1,
      pairs: [{ node_id: '12:340', selector: 'main', rows, summary: summarize(rows), fix_plan: plan.fix_plan } as never] });
    const editLine = md.split('\n').find((l) => l.includes('layout: padding-right'))!;
    expect(editLine).toContain('edit the layout rule, not px');
    expect(editLine).toContain('a page scrollbar gutter (see size.w)');
  });

  it('and the shelf page, whose every remaining discrepancy IS the gutter, prescribes no edits at all', () => {
    // The live shape: a centred page under a classic scrollbar. Both offset rows are derived and
    // demoted, size.w carries no channel -> buildFixPlan has nothing to emit. This is the whole point
    // of the round; the previous commit reached it by allowing a number it had not measured, and the
    // one after it reached TWO edits by refusing to derive a number it could.
    const rows = diffPair(shelfSpec, shelfDom(), { tolerancePx: 1, frameWidth: 1920 });
    expect(rows.filter((r) => r.status === 'fail')).toEqual([]);
    expect(buildFixPlan(rows, { root: { module: 'Shelf.module.css', local: 'main', raw: 'Shelf-module__main' } })).toBeUndefined();
    // ...and it is still not a green: three rows are demoted, so the pair reads "not verified".
    expect(summarize(rows).demoted).toBe(3);
    expect(verdict(rows).complete).toBe(false);
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

// ── A gutter that is RESERVED and never painted ──────────────────────────────────────────────────
//
// THE SECOND MECHANISM, found and reproduced live. `scrollbar-gutter: stable` on a page that does
// NOT scroll reserves the bar's width and paints nothing. `documentElement.clientWidth` is the
// VIEWPORT width and does not subtract a reserve, so `innerWidth - clientWidth` is 0, the detector
// above returned undefined, and the shortfall shipped as a hard ❌ carrying `edit the layout rule`
// on `base-layout.module.scss (.root)` -- the exact defect this file exists to prevent, arriving
// through a door it did not cover.
//
// MEASURED IN A REAL CHROME on that page (window 1280, an 11px
// `::-webkit-scrollbar`), toggling ONE property at a time and restoring it, and re-measured on a
// synthetic page at the 15px native bar (same shape, every number scaled by the bar):
//
//     state                        innerWidth  clientWidth  painted  reserved  root x  root w
//     auto, scrolls                      1280         1269       11         -       0    1269
//     stable, scrolls                    1280         1269       11         0       0    1269
//     stable, does NOT scroll            1280         1280        0        11       0    1269
//     both-edges, scrolls                1280         1269       11        11      11    1258
//     both-edges, does NOT scroll        1280         1280        0        22      11    1258
//
// painted and reserved are MUTUALLY EXCLUSIVE per edge and their SUM is invariant across the states
// of one page -- and equal to exactly what the page layout root lost. `reserved` is the extractor's
// new `reservedGutter` (the html BOX, minus the html margins; see dom-extractor.test.ts for why the
// margins and the declared-gutter gate are both load-bearing).
describe('a gutter that is RESERVED and not painted is the same gutter', () => {
  const head = kid(0, 400, 'head');
  const pageSpec = spec(1280, 'col', [head.fig]);
  // The live page's shape: a 1280 frame, a full-bleed root, one left-anchored child that matches.
  const pageDom = (over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => snap({
    innerWidth: 1280, layoutViewportWidth: 1280, reservedGutter: 11,
    rect: { x: 0, y: 0, w: 1269, h: 720 }, clientWidth: 1269,
    children: [head.dom], ...over,
  });
  const rowsFor = (over: Partial<DomSnapshotOk> = {}) =>
    diffPair(pageSpec, pageDom(over), { tolerancePx: 1, frameWidth: 1280 });

  it('the live case: reserved-but-not-painted is demoted, and prescribes no edit', () => {
    const rows = rowsFor();
    const row = find(rows, 'size.w');
    expect(row).toMatchObject({ status: 'demoted', figma: 1280, dom: 1269, delta: 11 });
    expect(row.note).toContain('page scrollbar gutter 11px');
    // The window and the viewport read the SAME 1280 here -- nothing but the reserve explains the
    // 11px, so the note has to say which half of the gutter it is or the numbers look like a typo.
    expect(row.note).toContain('window 1280, CSS layout viewport 1280');
    expect(row.note).toContain('11px is reserved by scrollbar-gutter and not painted');
    // The half that costs the reader real work: no channel => fix_plan emits no edit for this row.
    expect(row.srcChannel).toBeUndefined();
    const plan = buildFixPlan(rows, { root: { module: 'page-shell.module.scss', local: 'root', raw: 'page-shell-module-scss-module__aBc123__root' } });
    expect(plan?.fix_plan.flatMap((p) => p.edits).filter((e) => e.prop === 'size.w') ?? []).toEqual([]);
  });

  it('the viewport row names the width the page was laid out in, which is NOT its clientWidth here', () => {
    // `innerWidth - clientWidth` is 0 in this state, so the old note went silent on the one page
    // whose size.w is short by a gutter -- leaving "viewport ✅ 1280 vs 1280" next to it.
    const vp = find(rowsFor(), 'viewport');
    expect(vp).toMatchObject({ status: 'pass', figma: 1280, dom: 1280 });
    expect(vp.note).toContain('CSS layout viewport 1269');
    expect(vp.note).toContain('11px page scrollbar gutter');
  });

  it('all five measured states of one page resolve to the same gutter and the same demote', () => {
    // The table at the top, row by row. The quantity is `painted + reserved` in every one of them,
    // and it is exactly what the root lost -- 1280 - root w.
    const states: { state: string; lvw: number; reserved?: number; lead?: number; x: number; w: number; px: number }[] = [
      { state: 'auto, scrolls', lvw: 1269, reserved: undefined, lead: undefined, x: 0, w: 1269, px: 11 },
      { state: 'stable, scrolls', lvw: 1269, reserved: 0, lead: 0, x: 0, w: 1269, px: 11 },
      { state: 'stable, does NOT scroll', lvw: 1280, reserved: 11, lead: 0, x: 0, w: 1269, px: 11 },
      { state: 'both-edges, scrolls', lvw: 1269, reserved: 11, lead: 11, x: 11, w: 1258, px: 22 },
      { state: 'both-edges, does NOT scroll', lvw: 1280, reserved: 22, lead: 11, x: 11, w: 1258, px: 22 },
    ];
    for (const s of states) {
      const row = find(rowsFor({
        layoutViewportWidth: s.lvw, reservedGutter: s.reserved, reservedGutterLeft: s.lead,
        rect: { x: s.x, y: 0, w: s.w, h: 720 }, clientWidth: s.w,
      }), 'size.w');
      expect(row, s.state).toMatchObject({ status: 'demoted', figma: 1280, dom: s.w, delta: 1280 - s.w });
      expect(row.note, s.state).toContain(`page scrollbar gutter ${s.px}px`);
      expect(row.srcChannel, s.state).toBeUndefined();
    }
  });

  it('RED: one pixel more than a RESERVED gutter is one pixel of layout, and it keeps its address', () => {
    const row = find(diffPair(spec(1281, 'col', [head.fig]), pageDom(), { tolerancePx: 1, frameWidth: 1281 }), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1281, dom: 1269, delta: 12 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
  });

  it('RED: a reserved gutter does not license a box that is not anchored where it was taken from', () => {
    // Same page, same reserve, a section pushed to x 356 by an oversized sibling: it never paid the
    // gutter. And the both-edges band (x == gutter/2 == 5.5) is a number, not the both-edges shape:
    // this page reserved its whole gutter on the TRAILING edge (measured `reservedGutterLeft` 0), so
    // a box at 5.5 is a box overflowing to the right by 5.5. Deriving the inset from the gutter
    // instead of measuring it demotes every one of these.
    for (const x of [356, 5.5, 5, 6]) {
      const row = find(rowsFor({ rect: { x, y: 0, w: 1269, h: 720 } }), 'size.w');
      expect(row, `x=${x}`).toMatchObject({ status: 'fail', figma: 1280, dom: 1269, delta: 11 });
      expect(row.srcChannel, `x=${x}`).toMatchObject({ kind: 'root', editKind: 'layout' });
    }
  });

  it('RED: an ASYMMETRIC reserve is a shape nothing has measured, and it keeps its fail', () => {
    // The whole 11px reserved on the LEADING edge. The root would sit at x == lead with exactly the
    // right width, so the anchoring alone accepts it -- and the receipt would then read "inset by
    // 11px on each edge" over a page that lost 11 in total. No browser here produces this state
    // (`lead` is 0 in every measured state but both-edges, where it is exactly half), so it is not
    // demoted on the strength of prose that does not match its own numbers.
    const row = find(rowsFor({ reservedGutterLeft: 11, rect: { x: 11, y: 0, w: 1269, h: 720 } }), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1280, dom: 1269, delta: 11 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
  });

  it('a pre-this-release capture of a both-edges page LOSES the explanation, it never gains one', () => {
    // The direction that keeps this additive and un-versioned. An old extractor emits no
    // `reservedGutter`, so a both-edges capture reads one bar where the root lost two, falls out of
    // both anchorings, and keeps the FAIL it would now be demoted from. A demote invented for a
    // capture that cannot prove it is the failure mode this whole detector is built against.
    const row = find(rowsFor({
      layoutViewportWidth: 1269, reservedGutter: undefined,
      rect: { x: 11, y: 0, w: 1258, h: 720 }, clientWidth: 1258,
    }), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1280, dom: 1258, delta: 22 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
  });

  it('RED: no declared gutter at all and the page still fails everything it failed before', () => {
    // Overlay scrollbars: nothing painted, nothing reserved, the field absent. An 11px shortfall is
    // an 11px defect.
    const row = find(rowsFor({ layoutViewportWidth: 1280, reservedGutter: undefined }), 'size.w');
    expect(row).toMatchObject({ status: 'fail', figma: 1280, dom: 1269, delta: 11 });
    expect(row.srcChannel).toMatchObject({ kind: 'root', editKind: 'layout' });
    // ...and a declared gutter that this state paints nowhere is the same nothing.
    const zero = find(rowsFor({ layoutViewportWidth: 1280, reservedGutter: 0 }), 'size.w');
    expect(zero).toMatchObject({ status: 'fail', delta: 11 });
  });
});
