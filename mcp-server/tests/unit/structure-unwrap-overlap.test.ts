// Feedback item 12: a DS component's wrapper vs hand-rolled flat markup lost EVERY child metric.
// Measured root cause: tryUnwrap's expand() rejected the wrapper because its children do not
// form a single file on the PAIR axis (title stacked over subtitle, meta to the side) - and the
// one-level salvage cannot anchor 1-vs-3 (one fig child holds all the texts -> contradiction).
// The panel killed a descendant-rescue tier and named the superset fix instead: ACCEPT the
// overlapping unwrap and extend the existing wrap/reflow protections - everything downstream
// (per-child zip, offset-cross, typography descent, the gap skip) already exists, guarded.
import { describe, it, expect } from 'vitest';
import { diffPair, summarize, deriveCoverage } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import type { LayoutSpec, DomSnapshotOk, DomChild, SpecChild } from '../../src/domain/layout-spec/types.js';

const figText = (id: string, name: string, x: number, y: number, w: number, h: number, snippet: string, size: number): SpecChild =>
  ({ id, name, type: 'TEXT', rect: { x, y, w, h }, textSnippet: snippet,
    text: { fontSize: size, fontWeight: 400 } } as SpecChild);

const listItemSpec = (kids: SpecChild[]): LayoutSpec => ({
  node: { id: '1:1', name: 'listItem', type: 'INSTANCE' },
  rect: { x: 0, y: 0, w: 412, h: 70 },
  axis: 'row',
  autoLayout: { gap: 12, padding: { top: 12, right: 16, bottom: 12, left: 16 } },
  children: [
    { id: '1:2', name: 'Body', type: 'FRAME', rect: { x: 16, y: 12, w: 380, h: 46 },
      children: kids } as never,
  ],
} as LayoutSpec);

const span = (x: number, y: number, w: number, h: number, text: string | undefined, size: number): DomChild =>
  ({ kind: 'element', tag: 'span', rect: { x, y, w, h },
    ...(text !== undefined ? { styles: { fontSize: size, fontWeight: 400 },
      children: [{ kind: 'text', text, rect: { x, y, w, h } }] } : { children: [] }) });

const domRow = (children: DomChild[]): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.row', innerWidth: 1280,
  rect: { x: 0, y: 0, w: 412, h: 70 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 12, right: 16, bottom: 12, left: 16 },
  clientWidth: 412, clientHeight: 70, scrollHeight: 70,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex' },
  children,
});

const figKids = () => [
  figText('1:3', 'title', 16, 12, 200, 20, 'Row title', 16),
  figText('1:4', 'subtitle', 16, 36, 200, 16, 'Row subtitle', 13),
  figText('1:5', 'meta', 340, 24, 56, 16, 'Meta tag', 13),
];
const domKids = () => [
  span(16, 12, 200, 20, 'Row title', 16),
  span(16, 36, 200, 16, 'Row subtitle', 13),
  span(340, 24, 56, 16, 'Meta tag', 13),
];

describe('the July shape: overlapping unwrap is ACCEPTED', () => {
  it('no structure_mismatch; cross offsets and typography measured; main-axis gaps skipped honestly', () => {
    const rows = diffPair(listItemSpec(figKids()), domRow(domKids()), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'structure_mismatch')).toBeUndefined();
    expect(rows.some((r) => r.prop === 'unwrapped')).toBe(true);
    const crosses = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crosses.length).toBe(3);
    expect(crosses.every((r) => r.status === 'pass')).toBe(true);
    expect(rows.some((r) => r.prop.startsWith('font-size') && r.status === 'pass')).toBe(true);
    const gaps = rows.filter((r) => r.prop.startsWith('gap['));
    // Only OVERLAPPING neighbors skip (title/subtitle stack); subtitle<->meta is genuinely
    // single-file and gets a REAL measured gap - stricter than the spec asked for.
    expect(gaps.some((r) => r.status === 'skip' && /stack|overlap/.test(r.note ?? ''))).toBe(true);
    expect(gaps.some((r) => r.status === 'pass')).toBe(true);
    expect(rows.filter((r) => r.status === 'fail')).toEqual([]);
  });
  it('a shifted span y -> offset-cross FAIL; a wrong fontSize -> font-size FAIL', () => {
    const shifted = domKids();
    shifted[1] = span(16, 44, 200, 16, 'Row subtitle', 13);   // subtitle sits 8px lower
    const rows1 = diffPair(listItemSpec(figKids()), domRow(shifted), { tolerancePx: 1 });
    expect(rows1.some((r) => r.prop.startsWith('offset-cross') && r.status === 'fail')).toBe(true);
    const wrongFont = domKids();
    wrongFont[0] = span(16, 12, 200, 20, 'Row title', 13);    // 16 -> 13
    const rows2 = diffPair(listItemSpec(figKids()), domRow(wrongFont), { tolerancePx: 1 });
    expect(rows2.some((r) => r.prop.startsWith('font-size') && r.status === 'fail')).toBe(true);
  });
  it('textless (skeleton-ish) variant with EQUAL counts: accepted, offsets measured, gaps skipped', () => {
    const figNoText = figKids().map((k) => ({ ...k, textSnippet: undefined, text: undefined, type: 'FRAME' })) as SpecChild[];
    const domNoText = [span(16, 12, 200, 20, undefined, 0), span(16, 36, 200, 16, undefined, 0), span(340, 24, 56, 16, undefined, 0)];
    const rows = diffPair(listItemSpec(figNoText), domRow(domNoText), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'structure_mismatch')).toBeUndefined();
    expect(rows.filter((r) => r.prop.startsWith('offset-cross')).length).toBe(3);
    const gaps = rows.filter((r) => r.prop.startsWith('gap['));
    expect(gaps.some((r) => r.status === 'skip')).toBe(true);
    expect(gaps.filter((r) => r.status !== 'skip').every((r) => r.status === 'pass')).toBe(true);
  });
});

describe('overlap asymmetry is a named difference, not a meaningless number', () => {
  it('fig children overlap on the main axis while dom children form a single file -> skip row naming the sides', () => {
    // dom lays the three out in a genuine row (no overlap): a REAL layout difference.
    const domSingleFile = [span(16, 24, 100, 20, 'Row title', 16), span(140, 24, 100, 16, 'Row subtitle', 13), span(300, 24, 56, 16, 'Meta tag', 13)];
    const rows = diffPair(listItemSpec(figKids()), domRow(domSingleFile), { tolerancePx: 1 });
    const gaps = rows.filter((r) => r.prop.startsWith('gap['));
    const skipped = gaps.filter((r) => r.status === 'skip');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((r) => /design|figma/i.test(r.note ?? ''))).toBe(true);
  });
});

describe('what does NOT change', () => {
  it('a truncated wrapper still rejects the unwrap (byte-compat with the honest rejection)', () => {
    const spec = listItemSpec(figKids());
    (spec.children[0] as { childrenTruncated?: boolean }).childrenTruncated = true;
    const rows = diffPair(spec, domRow(domKids()), { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.note).toMatch(/truncated by a cap/);
  });
  it('a genuinely unmatchable shape keeps the total-skip note and now routes state checks to compare_dom_to_dom', () => {
    const spec = listItemSpec(figKids());
    // dom has FIVE children - counts cannot repair, no anchors can cover them all
    const dom = domRow([...domKids(), span(10, 60, 40, 8, undefined, 0), span(60, 60, 40, 8, undefined, 0)]);
    const rows = diffPair(spec, dom, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm).toBeDefined();
    expect(sm?.note).toMatch(/compare_dom_to_dom/);
  });
});

describe('tie-order truth under an overlap unwrap (panel blocker)', () => {
  // Overlapping substitutes share a main-axis start, so the main-start sort degenerates to
  // LAYER order - an index zip then pairs the wrong nodes, and the reorder detector's tie-mute
  // silences itself exactly there. Text anchors must realign the zip; unanchored tie slots are
  // honestly skipped, never guessed.
  const fig3 = () => [
    figText('2:1', 'Title', 0, 0, 100, 20, 'Alpha', 16),
    figText('2:2', 'Sub', 0, 20, 100, 16, 'Beta', 12),
    figText('2:3', 'Meta', 200, 0, 60, 16, 'Gamma', 10),
  ];
  const domAligned = () => [
    span(0, 0, 100, 20, 'Alpha', 16),
    span(0, 20, 100, 16, 'Beta', 12),
    span(200, 40, 60, 16, 'Gamma', 10),   // Gamma sits 40px lower - a REAL cross defect
  ];
  it('anchors realign tied children: the only fail is the REAL one (Gamma cross-shift), no fabricated pairs', () => {
    const rows = diffPair(listItemSpec(fig3()), domRow(domAligned()), { tolerancePx: 1 });
    const fails = rows.filter((r) => r.status === 'fail');
    // correct pairing: Title-Alpha pass, Sub-Beta pass, Meta-Gamma offset-cross FAIL 0 vs 40.
    expect(fails.length).toBe(1);
    expect(fails[0].prop).toMatch(/offset-cross.*Meta/);
    expect(rows.filter((r) => r.prop.startsWith('font-size') && r.status === 'fail')).toEqual([]);
  });
  it('textless tie slots are SKIPPED with an honest note, not zipped by layer order', () => {
    const figNoText = fig3().map((k) => ({ ...k, textSnippet: undefined, text: undefined, type: 'FRAME' })) as SpecChild[];
    const domNoText = [span(0, 0, 100, 20, undefined, 0), span(0, 20, 100, 16, undefined, 0), span(200, 40, 60, 16, undefined, 0)];
    const rows = diffPair(listItemSpec(figNoText), domRow(domNoText), { tolerancePx: 1 });
    // Title/Sub tie at main-start 0 with no anchors -> their per-child rows are unattributable;
    // Meta (x200, no tie) stays measured and its 40px shift is the one real fail.
    const skips = rows.filter((r) => r.status === 'skip' && /ambiguous|not attributed/i.test(r.note ?? ''));
    expect(skips.length).toBeGreaterThan(0);
    const crossFails = rows.filter((r) => r.prop.startsWith('offset-cross') && r.status === 'fail');
    expect(crossFails.length).toBe(1);
    expect(crossFails[0].prop).toMatch(/Meta|2/);
  });
});

describe('wave locks: both-sides truth under an overlap unwrap', () => {
  // A DOM-side wrapper holding the cross-stack: fig children have DISTINCT main starts, the dom
  // substitutes tie at one x. The verdict must not depend on markup source order.
  // FLAT spec (no Body wrapper): 2 fig children vs 1 dom wrapper = the DOM-side unwrap path.
  const flatSpec = (kids: SpecChild[]): LayoutSpec => ({
    node: { id: '3:0', name: 'row', type: 'FRAME' },
    rect: { x: 0, y: 0, w: 412, h: 70 },
    axis: 'row',
    autoLayout: { gap: 12, padding: { top: 12, right: 16, bottom: 12, left: 16 } },
    children: kids,
  } as LayoutSpec);
  const figDistinct = () => [
    figText('3:1', 'Left', 16, 12, 40, 20, 'Alpha', 16),
    figText('3:2', 'Right', 60, 36, 56, 16, 'Beta', 12),
  ];
  const domWrapped = (topFirst: boolean): DomSnapshotOk => {
    const top: DomChild = span(16, 12, 100, 20, 'Zulu', 16);      // texts deliberately unmatched
    const bottom: DomChild = span(16, 36, 100, 16, 'Yankee', 12); // (dynamic content - no anchors)
    return domRow([{ kind: 'element', tag: 'div', rect: { x: 16, y: 12, w: 100, h: 46 },
      children: topFirst ? [top, bottom] : [bottom, top] }]);
  };
  it('dom-side tie group without anchors -> honest ambiguous skips, IDENTICAL verdict for both source orders', () => {
    const a = diffPair(flatSpec(figDistinct()), domWrapped(true), { tolerancePx: 1 });
    const b = diffPair(flatSpec(figDistinct()), domWrapped(false), { tolerancePx: 1 });
    const verdictOf = (rows: typeof a) => rows.filter((r) => r.status === 'fail').map((r) => r.prop).sort().join('|');
    expect(verdictOf(a)).toBe(verdictOf(b));
    expect(a.some((r) => r.status === 'skip' && /ambiguous/.test(r.note ?? ''))).toBe(true);
  });
  it('padding rows measure the PHYSICAL extremes after anchor realignment - a real leading overshoot fails', () => {
    // fig: Title/Sub tied at x16 (overlap unwrap, anchors exist). dom: Beta overshoots to x=8.
    const fig = [
      figText('4:1', 'Title', 16, 12, 100, 20, 'Alpha', 16),
      figText('4:2', 'Sub', 16, 36, 100, 16, 'Beta', 12),
    ];
    const dom = domRow([
      span(8, 36, 108, 16, 'Beta', 12),   // physically leading (x=8): 8px overshoot
      span(16, 12, 100, 20, 'Alpha', 16),
    ]);
    const rows = diffPair(listItemSpec(fig), dom, { tolerancePx: 1 });
    const pl = rows.find((r) => r.prop === 'padding-left');
    expect(pl?.status).toBe('fail');
  });
  it('fig-side overlap does not arm the monotonicity guard over stack-order markup', () => {
    // fig wrapper holds the stack (fig-side unwrap); dom children are flat but written
    // icon-after-label (document order not main-start-sorted) - the norm for a stack.
    const dom = domRow([
      span(60, 36, 56, 16, 'Row subtitle', 13),   // written first, sits second by x
      span(16, 12, 50, 20, 'Row title', 16),      // written second, sits first by x
    ]);
    const fig = [
      figText('5:1', 'title', 16, 12, 50, 20, 'Row title', 16),      // ends x66 - overlaps subtitle (x60): the overlap-accepted case
      figText('5:2', 'subtitle', 60, 36, 56, 16, 'Row subtitle', 13),
    ];
    const rows = diffPair(listItemSpec(fig), dom, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'layout_axis_mismatch')).toBeUndefined();
    expect(rows.filter((r) => r.status === 'fail')).toEqual([]);
  });
  it('no false children_reorder across a stack (main-start order is meaningless there)', () => {
    // Title/Sub cross-stacked with a few px of centring drift flipping their main-start order
    // between design and dom - NOT a reorder.
    const fig = [
      figText('6:1', 'title', 18, 12, 100, 20, 'Row title', 16),
      figText('6:2', 'subtitle', 16, 36, 100, 16, 'Row subtitle', 13),
    ];
    const dom = domRow([
      span(16, 12, 100, 20, 'Row title', 16),     // title now leads by x
      span(18, 36, 100, 16, 'Row subtitle', 13),
    ]);
    const rows = diffPair(listItemSpec(fig), dom, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'children_reorder')).toBeUndefined();
  });
});

describe('wave round 2: gaps, receipt, vocabulary', () => {
  it('a gap touching a tie-group slot is not attributed - FULL ROW EQUALITY across source orders', () => {
    // 3 children: two tied at one start with different extents + one single-file. The gap from
    // the tie group to the single child must not ride the layer-order zip (its NUMBER flipped
    // with markup order before this lock - the prop-names-only comparison hid it).
    const fig = [
      figText('7:1', 'A', 16, 12, 50, 20, 'Aaa', 16),
      figText('7:2', 'B', 76, 12, 50, 20, 'Bbb', 16),
      figText('7:3', 'C', 216, 12, 50, 20, 'Ccc', 16),
    ];
    const mk = (order: 'sw' | 'ws'): DomSnapshotOk => {
      const small: DomChild = span(16, 12, 50, 20, 'Zz', 16);
      const wide: DomChild = span(16, 40, 150, 16, 'Yy', 12);
      const far: DomChild = span(216, 12, 50, 20, 'Xx', 16);
      return domRow([{ kind: 'element', tag: 'div', rect: { x: 16, y: 12, w: 250, h: 46 },
        children: order === 'sw' ? [small, wide, far] : [wide, small, far] }]);
    };
    const flat = (kids: SpecChild[]): LayoutSpec => ({
      node: { id: '7:0', name: 'row', type: 'FRAME' }, rect: { x: 0, y: 0, w: 412, h: 70 },
      axis: 'row', autoLayout: { gap: 12, padding: { top: 12, right: 16, bottom: 12, left: 16 } },
      children: kids,
    } as LayoutSpec);
    const a = diffPair(flat(fig), mk('sw'), { tolerancePx: 1 });
    const b = diffPair(flat(fig), mk('ws'), { tolerancePx: 1 });
    const proj = (rows: typeof a) => rows.map((r) => `${r.status}|${r.prop}|${r.figma}|${r.dom}|${r.delta}`).sort().join('\n');
    expect(proj(a)).toBe(proj(b));
    expect(a.some((r) => r.prop.startsWith('gap[') && /ambiguous/.test(r.note ?? ''))).toBe(true);
  });
  it('the all-pass July pair CLOSES the receipt: the stack gap-skip is an inapplicable axis, not a hole', () => {
    const rows = diffPair(listItemSpec(figKids()), domRow(domKids()), { tolerancePx: 1 });
    const skips = rows.filter((r) => r.status === 'skip');
    expect(skips.every((r) => r.coverageSkipped === true)).toBe(true);
    expect(skips.some((r) => /pair the wrapper directly/.test(r.note ?? ''))).toBe(true);
    // The receipt-level promise, locked end to end: complete:true with empty blocking.
    const pair = { node_id: '1:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const v = buildVerification([pair], { depthLevels: 4, tolerancePx: 1 });
    expect(v.complete).toBe(true);
    expect(v.blocking).toEqual([]);
  });
  it('a REAL main-axis swap of disjoint children still fires children_reorder under an overlap unwrap', () => {
    // title/subtitle stack (overlap accepted via the tie), but meta and badge - disjoint main
    // ranges - are genuinely swapped in the dom: the detector must still catch it.
    const fig = [
      figText('8:1', 'title', 16, 12, 100, 20, 'Row title', 16),
      figText('8:2', 'subtitle', 16, 36, 100, 16, 'Row subtitle', 13),
      figText('8:3', 'meta', 220, 24, 40, 16, 'Meta tag', 13),
      figText('8:4', 'badge', 320, 24, 40, 16, 'New badge', 13),
    ];
    const dom = domRow([
      span(16, 12, 100, 20, 'Row title', 16),
      span(16, 36, 100, 16, 'Row subtitle', 13),
      span(220, 24, 40, 16, 'New badge', 13),   // swapped
      span(320, 24, 40, 16, 'Meta tag', 13),    // swapped
    ]);
    const rows = diffPair(listItemSpec(fig), dom, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'children_reorder')).toBeDefined();
  });
});
