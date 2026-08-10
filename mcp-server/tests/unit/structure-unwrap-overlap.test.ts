// Feedback item 12: a DS component's wrapper vs hand-rolled flat markup lost EVERY child metric.
// Measured root cause: tryUnwrap's expand() rejected the wrapper because its children do not
// form a single file on the PAIR axis (title stacked over subtitle, meta to the side) - and the
// one-level salvage cannot anchor 1-vs-3 (one fig child holds all the texts -> contradiction).
// The panel killed a descendant-rescue tier and named the superset fix instead: ACCEPT the
// overlapping unwrap and extend the existing wrap/reflow protections - everything downstream
// (per-child zip, offset-cross, typography descent, the gap skip) already exists, guarded.
import { describe, it, expect } from 'vitest';
import { diffPair } from '../../src/domain/layout-spec/diff.js';
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
  schema: 6, status: 'ok', selector: '.row', innerWidth: 1280,
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
    expect(gaps.some((r) => r.status === 'skip' && /overlap/.test(r.note ?? ''))).toBe(true);
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
