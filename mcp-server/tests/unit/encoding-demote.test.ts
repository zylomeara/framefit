// Feedback items 3+18: the design POSITIVELY declares zero padding while the DOM declares one -
// the insets are encoded structurally (spacer children / a nested component's padding) and the
// content-box convention fabricated size deltas of exactly the dom padding on two live runs
// (D21/D32 in July, D13 in August). Two panel rounds killed a border-box convention SWITCH (it
// deleted the padding from rows that have no compensator - the cross axis has no padding row,
// padding-end skips a text last child, fig-unwrap anchors broke). What shipped is the vault's
// own alternative, the DEMOTE road: content-box math stays byte-identical everywhere; when the
// content-box size row fails but the raw boxes agree, the fail is an encoding artifact - 🟰
// with both numbers, the receipt stays incomplete, no fix_plan edit. When the raw boxes also
// differ, the fail STANDS and the note carries the honest raw-box magnitude.
import { describe, it, expect } from 'vitest';
import { diffPair, summarize, deriveCoverage } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import type { LayoutSpec, DomSnapshotOk } from '../../src/domain/layout-spec/types.js';

const shelf = (padLR = 0): LayoutSpec => ({
  node: { id: '1:1', name: 'Shelf', type: 'INSTANCE' },
  rect: { x: 0, y: 0, w: 413, h: 140 },
  axis: 'col',
  autoLayout: { gap: 12, padding: { top: 0, right: padLR, bottom: 0, left: padLR } },
  children: [
    { id: '1:2', name: 'title', type: 'FRAME', rect: { x: 16, y: 16, w: 381, h: 24 } } as never,
    { id: '1:3', name: 'body', type: 'FRAME', rect: { x: 16, y: 52, w: 381, h: 72 } } as never,
  ],
} as LayoutSpec);
const card = (domPad = 16, w = 424): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.card', innerWidth: 1280,
  rect: { x: 0, y: 0, w, h: 140 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: domPad, right: domPad, bottom: domPad, left: domPad },
  clientWidth: w, clientHeight: 140, scrollHeight: 140,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex' },
  children: [
    { kind: 'element', tag: 'h3', rect: { x: 16, y: 16, w: w - 32, h: 24 } },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 52, w: w - 32, h: 72 } },
  ],
});
const row = (rows: ReturnType<typeof diffPair>, prop: string) => rows.find((r) => r.prop === prop);

describe('item 3: the spacer-encoded shelf', () => {
  it('size.h: raw boxes match (140/140) -> the fabricated D32 becomes a demoted row with both numbers', () => {
    const rows = diffPair(shelf(), card(), { tolerancePx: 1 });
    const h = row(rows, 'size.h');
    expect(h?.status).toBe('demoted');
    expect(h?.note).toMatch(/encoding artifact/);
    expect(h?.note).toMatch(/140 vs 140/);
  });
  it('size.w: raw boxes DIFFER (413/424) -> the fail STANDS and the note carries the honest D11', () => {
    const rows = diffPair(shelf(), card(), { tolerancePx: 1 });
    const w = row(rows, 'size.w');
    expect(w?.status).toBe('fail');
    expect(w?.note).toMatch(/413 vs 424/);
    expect(w?.caveat).toMatch(/D11/);
  });
  it('the receipt stays incomplete (a demoted row gates) - never a silent green', () => {
    const rows = diffPair(shelf(413 === 413 ? 0 : 0), card(16, 413), { tolerancePx: 1 });
    // width now matches raw (413/413): h demoted + w demoted -> anyDemoted -> complete:false
    const pair = { node_id: '1:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const v = buildVerification([pair], { depthLevels: 4, tolerancePx: 1 });
    expect(rows.filter((r) => r.status === 'demoted').length).toBeGreaterThan(0);
    expect(v.complete).toBe(false);
  });
});

describe('item 18: the nested-padding button', () => {
  const button: LayoutSpec = {
    node: { id: '2:1', name: 'Button', type: 'INSTANCE' },
    rect: { x: 0, y: 0, w: 88, h: 28 },
    axis: 'row',
    autoLayout: { gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    children: [{ id: '2:2', name: 'content', type: 'FRAME', rect: { x: 8, y: 4, w: 72, h: 20 } } as never],
  } as LayoutSpec;
  const dom: DomSnapshotOk = {
    schema: 6, status: 'ok', selector: '.btn', innerWidth: 1280,
    rect: { x: 0, y: 0, w: 87.1, h: 28 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 4, right: 6, bottom: 4, left: 6 },
    clientWidth: 87, clientHeight: 28, scrollHeight: 28,
    scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
    styles: { display: 'flex' },
    children: [{ kind: 'element', tag: 'span', rect: { x: 6, y: 4, w: 75, h: 20 } }],
  };
  it('both fabricated fails (D13 / D8) become demoted rows - the raw boxes match', () => {
    const rows = diffPair(button, dom, { tolerancePx: 1 });
    expect(row(rows, 'size.w')?.status).toBe('demoted');
    expect(row(rows, 'size.h')?.status).toBe('demoted');
    expect(row(rows, 'size.w')?.note).toMatch(/88 vs 87.1/);
  });
});

describe('nothing else moved - the false-green classes of the killed switch stay caught', () => {
  it('cross-axis trailing dom padding is still caught by the content-box size row (the switch made it green)', () => {
    // dom padding-right only: children 408 wide; raw boxes match 424/424, content differs
    const fig: LayoutSpec = { ...shelf(), rect: { x: 0, y: 0, w: 424, h: 140 } } as LayoutSpec;
    const dom = card(0, 424);
    (dom.paddings as { right: number }).right = 16;
    dom.children = dom.children!.map((c) => ({ ...c, rect: { ...c.rect, w: 392 } }));
    const rows = diffPair(fig, dom, { tolerancePx: 1 });
    const w = row(rows, 'size.w');
    // content-box 424 vs 408 -> fail -> raw boxes MATCH (424/424) -> demoted, NOT green:
    expect(w?.status).toBe('demoted');
    const pair = { node_id: 'x', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    expect(buildVerification([pair], { depthLevels: 4, tolerancePx: 1 }).complete).toBe(false);
  });
  it('a dom padding regression (children reflowed) keeps its reds in the anchor rows (untouched math)', () => {
    const dom = card(24);
    dom.children = [
      { kind: 'element', tag: 'h3', rect: { x: 24, y: 24, w: 376, h: 24 } },
      { kind: 'element', tag: 'div', rect: { x: 24, y: 60, w: 376, h: 72 } },
    ];
    const rows = diffPair(shelf(), dom, { tolerancePx: 1 });
    expect(rows.some((r) => r.status === 'fail')).toBe(true);   // offset/padding rows carry it
  });
  it('MUTATION LOCK: without the dom-dom guard the skeleton-vs-loaded padding loss would demote instead of fail', () => {
    // dom-dom: reference declares 0 padding, candidate has 24 - a REAL state regression; the
    // demote must NOT fire (sides guard). This locks the guard the wave found unlocked.
    const refSnap: DomSnapshotOk = { ...card(0, 400), rect: { x: 0, y: 0, w: 400, h: 200 },
      clientWidth: 400, clientHeight: 200, scrollHeight: 200,
      children: [{ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 400, h: 80 } },
        { kind: 'element', tag: 'div', rect: { x: 0, y: 100, w: 400, h: 80 } }] };
    const candSnap: DomSnapshotOk = { ...refSnap,
      paddings: { top: 24, right: 24, bottom: 24, left: 24 },
      children: [{ kind: 'element', tag: 'div', rect: { x: 24, y: 24, w: 352, h: 80 } },
        { kind: 'element', tag: 'div', rect: { x: 24, y: 124, w: 352, h: 56 } }] };
    return import('../../src/domain/layout-spec/dom-dom.js').then(({ diffDomPair }) => {
      const rows = diffDomPair(refSnap, candSnap, { tolerancePx: 1 });
      const w = rows.find((r) => r.prop === 'size.w');
      expect(w?.status).toBe('fail');       // NOT demoted - the guard is load-bearing
    });
  });
  it('MUTATION LOCK: absent autoLayout is not a zero declaration (fixed TEXT vs padded <p> stays green)', () => {
    const textSpec: LayoutSpec = {
      node: { id: '3:1', name: 'label', type: 'TEXT' },
      rect: { x: 0, y: 0, w: 200, h: 24 },
      children: [],
    } as never;
    const p: DomSnapshotOk = { ...card(16, 232), children: [], selector: 'p',
      clientWidth: 232, clientHeight: 56, scrollHeight: 56, rect: { x: 0, y: 0, w: 232, h: 56 } };
    const rows = diffPair(textSpec, p, { tolerancePx: 1 });
    expect(row(rows, 'size.w')?.status).toBe('pass');   // content-box 200/200, and no demote fired
    expect(row(rows, 'size.w')?.note ?? '').not.toMatch(/encoding/);
  });
  it('the padding channel in use on ANY axis disables the demote entirely', () => {
    const rows = diffPair(shelf(8), card(16), { tolerancePx: 1 });
    const h = row(rows, 'size.h');
    expect(h?.status).toBe('fail');   // 140 vs 108 as on main - the channel is declared, no demote
    expect(h?.note ?? '').not.toMatch(/encoding/);
  });
});

describe('verify-round locks', () => {
  it('BLOCKER lock: a genuinely FLUSH design vs a dom-only padding stays RED - the size row is the only witness', () => {
    const flushFig: LayoutSpec = {
      node: { id: '7:1', name: 'Row', type: 'FRAME' },
      rect: { x: 0, y: 0, w: 400, h: 200 },
      axis: 'col',
      autoLayout: { gap: 20, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      children: [
        { id: '7:2', name: 'a', type: 'FRAME', rect: { x: 0, y: 0, w: 400, h: 80 } } as never,
        { id: '7:3', name: 'b', type: 'FRAME', rect: { x: 0, y: 100, w: 400, h: 100 } } as never,
      ],
    } as LayoutSpec;
    const paddedDom: DomSnapshotOk = {
      schema: 6, status: 'ok', selector: '.row', innerWidth: 1280,
      rect: { x: 0, y: 0, w: 400, h: 200 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 40 },
      clientWidth: 400, clientHeight: 200, scrollHeight: 200,
      scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
      styles: { display: 'flex' },
      children: [
        { kind: 'element', tag: 'div', rect: { x: 40, y: 0, w: 360, h: 80 } },
        { kind: 'element', tag: 'div', rect: { x: 40, y: 100, w: 360, h: 100 } },
      ],
    };
    const rows = diffPair(flushFig, paddedDom, { tolerancePx: 1 });
    expect(row(rows, 'size.w')?.status).toBe('fail');   // no structural inset in the design -> not an encoding artifact
  });
  it('per-axis truth: a cross-only dom padding does not stamp the encoding note on a row that subtracted nothing', () => {
    const fig: LayoutSpec = { ...shelf(), rect: { x: 0, y: 0, w: 400, h: 140 } } as LayoutSpec;
    const dom = card(0, 380);          // a REAL 20px width defect
    (dom.paddings as { top: number; bottom: number }).top = 10;
    (dom.paddings as { top: number; bottom: number }).bottom = 10;
    dom.clientWidth = 380; dom.clientHeight = 140;
    const rows = diffPair(fig, dom, { tolerancePx: 1 });
    const w = row(rows, 'size.w');
    expect(w?.status).toBe('fail');
    expect(w?.note ?? '').not.toMatch(/overstates|encoding/);
  });
  it('the July item-3 pair is now FULLY quiet of fabricated reds: padding and offset rows dual-demote too', () => {
    const rows = diffPair(shelf(), card(16, 413), { tolerancePx: 1 });
    expect(rows.filter((r) => r.status === 'fail')).toEqual([]);
    const demoted = rows.filter((r) => r.status === 'demoted');
    expect(demoted.length).toBeGreaterThan(2);   // size + padding + offset rows all read as encoding artifacts
    expect(demoted.some((r) => /border edge both sides agree/.test(r.note ?? ''))).toBe(true);
    const pair = { node_id: 'p', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const v = buildVerification([pair], { depthLevels: 4, tolerancePx: 1 });
    expect(v.complete).toBe(false);   // demoted gates - never a silent green
  });
  it('a REAL inset regression is NOT dual-demoted: fig 16 vs dom-beyond-padding at 24 stays red', () => {
    const dom = card(24, 413);
    dom.children = [
      { kind: 'element', tag: 'h3', rect: { x: 24, y: 24, w: 365, h: 24 } },
      { kind: 'element', tag: 'div', rect: { x: 24, y: 60, w: 365, h: 72 } },
    ];
    const rows = diffPair(shelf(), dom, { tolerancePx: 1 });
    // fig structural 16 vs dom border-edge 24: both conventions disagree -> real red survives
    expect(rows.some((r) => r.status === 'fail')).toBe(true);
  });
  it('MUTATION lock (discriminating): absence of autoLayout keeps a real fail red even when raw boxes match', () => {
    const noAutoFig: LayoutSpec = {
      node: { id: '8:1', name: 'plain', type: 'FRAME' },
      rect: { x: 0, y: 0, w: 216, h: 60 },
      children: [],
    } as never;
    const dom: DomSnapshotOk = { ...card(16, 216), children: [], selector: '.plain',
      clientWidth: 216, clientHeight: 60, scrollHeight: 60, rect: { x: 0, y: 0, w: 216, h: 60 } };
    const rows = diffPair(noAutoFig, dom, { tolerancePx: 1 });
    const w = row(rows, 'size.w');
    // content-box 216 vs 184 fails; raw boxes match (216/216) - but ABSENT autoLayout must not
    // demote (a mutant dropping the presence clause turns this row demoted and fails here)
    expect(w?.status).toBe('fail');
  });
});
