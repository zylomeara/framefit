// Phase 3 of the icon-color axis (feedback item 6): the diff row. Panel-locked semantics: a row
// fires ONLY where BOTH sides detect an icon (one-sided detection = no row - geometry still
// covers the box); the hex pair goes through colorVerdict (the same ladder as text-color); a
// multi-color or unreadable side is an info WITH coverageSkipped, never a hex compare; a fig
// candidate whose subtree is cut is one honest unchecked routed to raise_max_depth; a tag:'svg'
// DOM child with NO icon fields is a stale capture routed to re_extract_dom; the axis does NOT
// fire in dom-dom mode; nested icons are found by DFS descent, labels disambiguate with #i.
import { describe, it, expect } from 'vitest';
import { diffPair, summarize, deriveCoverage, NOT_COVERED_BY_TOOL } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import type { LayoutSpec, DomSnapshotOk, DomChild, SpecChild } from '../../src/domain/layout-spec/types.js';

const figIcon = (over: Partial<SpecChild> = {}): SpecChild => ({
  id: '1:9', name: 'star', type: 'INSTANCE', rect: { x: 8, y: 8, w: 16, h: 16 }, ...over,
});
const spec = (kids: SpecChild[], over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '1:1', name: 'Row', type: 'FRAME' },
  rect: { x: 0, y: 0, w: 300, h: 32 }, axis: 'row',
  autoLayout: { gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  children: kids, ...over,
});
const domIcon = (styles: DomChild['styles'], over: Partial<DomChild> = {}): DomChild => ({
  kind: 'element', tag: 'svg', rect: { x: 8, y: 8, w: 16, h: 16 }, styles, ...over,
});
const snap = (kids: DomChild[], over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.row', innerWidth: 1280,
  rect: { x: 0, y: 0, w: 300, h: 32 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 300, clientHeight: 32, scrollHeight: 32,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex' },
  children: kids, ...over,
});
const iconRows = (rows: ReturnType<typeof diffPair>) => rows.filter((r) => r.prop.startsWith('icon-color'));

describe('icon-color: the direct child pair', () => {
  it('the live defect shape: accent glyph vs neutral design -> FAIL with both hexes', () => {
    const rows = diffPair(spec([figIcon({ iconHex: '#242429' })]), snap([domIcon({ iconColor: '#6c5dd3' })]), { tolerancePx: 1 });
    const r = iconRows(rows)[0];
    expect(r?.status).toBe('fail');
    expect(r?.figma).toBe('#242429');
    expect(r?.dom).toBe('#6c5dd3');
  });
  it('matching hexes with no token axis -> pass', () => {
    const rows = diffPair(spec([figIcon({ iconHex: '#242429' })]), snap([domIcon({ iconColor: '#242429' })]), { tolerancePx: 1 });
    expect(iconRows(rows)[0]?.status).toBe('pass');
  });
  it('token-bound fig vs a DOM literal on the same hex -> the tokenize-it fail', () => {
    const rows = diffPair(
      spec([figIcon({ iconHex: '#242429', iconToken: { token: '--icon-neutral', hex: '#242429' } })]),
      snap([domIcon({ iconColor: '#242429', iconColorToken: { literal: true } })]), { tolerancePx: 1 });
    const r = iconRows(rows)[0];
    expect(r?.status).toBe('fail');
    expect(r?.note).toMatch(/tokenize/);
  });
  it('token on both sides, same hex -> review semantic-confirm (the text-color ladder)', () => {
    const rows = diffPair(
      spec([figIcon({ iconHex: '#242429', iconToken: { token: '--icon-neutral', hex: '#242429' } })]),
      snap([domIcon({ iconColor: '#242429', iconColorToken: { token: '--icon-neutral' } })]), { tolerancePx: 1 });
    const r = iconRows(rows)[0];
    expect(r?.status).toBe('review');
    expect(r?.tokenReason).toBe('semantic-confirm');
  });
  it('a multi-color side (either) -> info with coverageSkipped, never a hex compare', () => {
    for (const [fig, dom] of [
      [figIcon({ iconMulti: true }), domIcon({ iconColor: '#242429' })],
      [figIcon({ iconHex: '#242429' }), domIcon({ iconColorMulti: true })],
    ] as [SpecChild, DomChild][]) {
      const r = iconRows(diffPair(spec([fig]), snap([dom]), { tolerancePx: 1 }))[0];
      expect(r?.status).toBe('info');
      expect(r?.coverageSkipped).toBe(true);
      expect(r?.note).toMatch(/verify visually/);
    }
  });
  it('an unreadable paint on either side -> info with coverageSkipped and the reason', () => {
    for (const [fig, dom] of [
      [figIcon({ iconUnknown: 'unreadable fill (GRADIENT_LINEAR)' }), domIcon({ iconColor: '#242429' })],
      [figIcon({ iconHex: '#242429' }), domIcon({ iconColorUnknown: 'unreadable fill (url("#g"))' })],
    ] as [SpecChild, DomChild][]) {
      const r = iconRows(diffPair(spec([fig]), snap([dom]), { tolerancePx: 1 }))[0];
      expect(r?.status).toBe('info');
      expect(r?.coverageSkipped).toBe(true);
      expect(r?.note).toMatch(/unreadable/);
    }
  });
  it('one-sided detection -> NO icon row (geometry rows still cover the box)', () => {
    const plainDiv: DomChild = { kind: 'element', tag: 'div', rect: { x: 8, y: 8, w: 16, h: 16 } };
    const rows = diffPair(spec([figIcon({ iconHex: '#242429' })]), snap([plainDiv]), { tolerancePx: 1 });
    expect(iconRows(rows)).toEqual([]);
  });
});

describe('icon-color: honesty at the edges', () => {
  it('a tag:svg DOM child with NO icon fields = a stale capture -> unchecked routed to re_extract_dom', () => {
    const rows = diffPair(spec([figIcon({ iconHex: '#242429' })]), snap([domIcon(undefined)]), { tolerancePx: 1 });
    const r = iconRows(rows)[0];
    expect(r?.status).toBe('unchecked');
    expect(r?.note).toMatch(/older extractor/);
    const pair = { node_id: '1:1', selector: '.row', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const v = buildVerification([pair], { depthLevels: 4, tolerancePx: 1 });
    const b = v.blocking.find((x) => x.action === 're_extract_dom');
    expect(b).toBeDefined();
  });
  it('a cut fig candidate facing a DOM icon -> one unchecked routed to raise_max_depth', () => {
    const cutFig: SpecChild = { id: '1:9', name: 'slot', type: 'FRAME', rect: { x: 8, y: 8, w: 16, h: 16 }, childrenTruncated: true, truncationCause: 'depth' };
    const rows = diffPair(spec([cutFig]), snap([domIcon({ iconColor: '#242429' })]), { tolerancePx: 1 });
    const r = iconRows(rows)[0];
    expect(r?.status).toBe('unchecked');
    expect(r?.note).toMatch(/raise max_depth/);
    const pair = { node_id: '1:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const v = buildVerification([pair], { depthLevels: 4, tolerancePx: 1 });
    expect(v.blocking.some((x) => x.action === 'raise_max_depth')).toBe(true);
  });
  it('an UNCUT non-icon fig child facing a DOM icon -> no row (genuinely one-sided)', () => {
    const plainFig: SpecChild = { id: '1:9', name: 'slot', type: 'FRAME', rect: { x: 8, y: 8, w: 16, h: 16 }, children: [] };
    const rows = diffPair(spec([plainFig]), snap([domIcon({ iconColor: '#242429' })]), { tolerancePx: 1 });
    expect(iconRows(rows)).toEqual([]);
  });
});

describe('icon-color: descent and the root site', () => {
  it('icons nested one level down on both sides are found by the DFS descent', () => {
    const figWrap: SpecChild = { id: '1:5', name: 'cell', type: 'FRAME', rect: { x: 0, y: 0, w: 32, h: 32 },
      children: [figIcon({ iconHex: '#242429' })] };
    const domWrap: DomChild = { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 32, h: 32 },
      children: [domIcon({ iconColor: '#6c5dd3' })] };
    const rows = diffPair(spec([figWrap]), snap([domWrap]), { tolerancePx: 1 });
    const r = iconRows(rows)[0];
    expect(r?.status).toBe('fail');
    expect(r?.prop).toContain('star');
    // a descent row carries NO srcChannel: the child address would name the WRAPPER's class -
    // the typography channel's mis-addressing; no address beats a wrong one.
    expect(r?.srcChannel).toBeUndefined();
  });
  it('UNEQUAL inventories are never zipped - and the refusal HOLDS the gate (unchecked, not info)', () => {
    const figWrap: SpecChild = { id: '1:5', name: 'cell', type: 'FRAME', rect: { x: 0, y: 0, w: 40, h: 16 },
      children: [figIcon({ iconHex: '#242429' })] };
    const domTwo: DomChild = { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 40, h: 16 },
      children: [domIcon({ iconColor: '#242429' }), domIcon({ iconColor: '#6c5dd3' }, { rect: { x: 28, y: 8, w: 16, h: 16 } })] };
    const rows = diffPair(spec([figWrap]), snap([domTwo]), { tolerancePx: 1 });
    const rs = iconRows(rows);
    expect(rs.length).toBe(1);
    expect(rs[0].status).toBe('unchecked');
    expect(rs[0].note).toMatch(/NOT compared/);
    expect(rows.filter((r) => r.prop.startsWith('icon-color') && r.status === 'fail')).toEqual([]);
    const pair = { node_id: '1:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const v = buildVerification([pair], { depthLevels: 4, tolerancePx: 1 });
    expect(v.complete).toBe(false);
    expect(v.blocking.some((b) => b.action === 'resolve_skip')).toBe(true);
  });
  it('srcChannel is gated on the DOM side: a dom-self carrier keeps the address even under fig descent', () => {
    const figWrap: SpecChild = { id: '1:5', name: 'cell', type: 'FRAME', rect: { x: 0, y: 0, w: 32, h: 32 },
      children: [figIcon({ iconHex: '#242429' })] };
    const rows = diffPair(spec([figWrap]), snap([domIcon({ iconColor: '#6c5dd3' })]), { tolerancePx: 1 });
    expect(iconRows(rows)[0]?.srcChannel).toEqual({ kind: 'child', i: 0, editKind: 'property' });
  });
  it('srcChannel is dropped when the DOM carrier was found by descent - even for a fig-self icon', () => {
    const domWrap: DomChild = { kind: 'element', tag: 'div', rect: { x: 8, y: 8, w: 24, h: 24 },
      children: [domIcon({ iconColor: '#6c5dd3' })] };
    const rows = diffPair(spec([figIcon({ iconHex: '#242429' })]), snap([domWrap]), { tolerancePx: 1 });
    const r = iconRows(rows)[0];
    expect(r?.status).toBe('fail');
    expect(r?.srcChannel).toBeUndefined();
  });
  it('an equal-count zip under a truncated inventory appends one unchecked for the unseen tail', () => {
    const figWrap: SpecChild = { id: '1:5', name: 'cell', type: 'FRAME', rect: { x: 0, y: 0, w: 32, h: 32 },
      childrenTruncated: true, children: [figIcon({ iconHex: '#242429' })] };
    const rows = diffPair(spec([figWrap]), snap([domIcon({ iconColor: '#242429' })]), { tolerancePx: 1 });
    const rs = iconRows(rows);
    expect(rs.some((r) => r.status === 'pass')).toBe(true);
    const tail = rs.find((r) => r.status === 'unchecked');
    expect(tail?.note).toMatch(/beyond the cut/);
  });
  it('label collision: two nested icons named alike -> #i disambiguates, both rows emitted', () => {
    const two = (hexes: [string, string]): SpecChild => ({ id: '1:5', name: 'cell', type: 'FRAME', rect: { x: 0, y: 0, w: 40, h: 16 },
      children: [figIcon({ id: '1:6', iconHex: hexes[0] }), figIcon({ id: '1:7', rect: { x: 28, y: 8, w: 16, h: 16 }, iconHex: hexes[1] })] });
    const domTwo: DomChild = { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 40, h: 16 },
      children: [domIcon({ iconColor: '#242429' }), domIcon({ iconColor: '#6c5dd3' }, { rect: { x: 28, y: 8, w: 16, h: 16 } })] };
    const rows = diffPair(spec([two(['#242429', '#242429'])]), snap([domTwo]), { tolerancePx: 1 });
    const props = iconRows(rows).map((r) => r.prop);
    expect(props.length).toBe(2);
    expect(new Set(props).size).toBe(2);
    expect(props.join(' ')).toMatch(/#\d/);
  });
  it('the pair ROOT itself an icon -> the same row without a label', () => {
    const rows = diffPair(
      spec([], { iconHex: '#242429' }),
      snap([], { styles: { display: 'block', iconColor: '#6c5dd3' } }), { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'icon-color');
    expect(r?.status).toBe('fail');
  });
  it('root stale capture: fig root icon + componentHints tag svg + no fields -> unchecked re-extract', () => {
    const rows = diffPair(
      spec([], { iconHex: '#242429' }),
      snap([], { componentHints: { tag: 'svg', classList: [], data: {} } }), { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'icon-color');
    expect(r?.status).toBe('unchecked');
    expect(r?.note).toMatch(/older extractor/);
  });
  it('a stale WRAPPER root is found by descent: the bare svg lives deeper with no fields', () => {
    const staleSvg: DomChild = { kind: 'element', tag: 'svg', rect: { x: 4, y: 4, w: 16, h: 16 } };
    const rows = diffPair(
      spec([], { iconHex: '#242429' }),
      snap([staleSvg], { componentHints: { tag: 'span', classList: [], data: {} } }), { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'icon-color');
    expect(r?.status).toBe('unchecked');
    expect(r?.note).toMatch(/older extractor/);
  });
  it('the root-descent row carries NO srcChannel (the root address would name the wrapper)', () => {
    const rows = diffPair(
      spec([], { iconHex: '#242429' }),
      snap([domIcon({ iconColor: '#6c5dd3' })], { componentHints: { tag: 'span', classList: ['btn'], data: {} } }), { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'icon-color');
    expect(r?.status).toBe('fail');
    expect(r?.srcChannel).toBeUndefined();
  });
  it('a fig root icon over a truncated captureless DOM subtree -> unchecked re-extract, not silence', () => {
    const rows = diffPair(
      spec([], { iconHex: '#242429' }),
      snap([], { childrenTruncated: true, componentHints: { tag: 'span', classList: [], data: {} } }), { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'icon-color');
    expect(r?.status).toBe('unchecked');
    expect(r?.note).toMatch(/re-extract/);
  });
  it('a root icon CONSUMES its children: one row for the glyph, never a second per-child row', () => {
    const figInner = figIcon({ iconHex: '#242429' });
    const domInner = domIcon({ iconColor: '#6c5dd3' });
    const rows = diffPair(
      spec([figInner], { iconHex: '#242429' }),
      snap([domInner], { styles: { display: 'block', iconColor: '#6c5dd3' } }), { tolerancePx: 1 });
    const rs = iconRows(rows);
    expect(rs.length).toBe(1);
    expect(rs[0].prop).toBe('icon-color');
  });
});

describe('icon-color: mode and census guards', () => {
  it('the axis does NOT fire in dom-dom mode', () => {
    const refWithIcon = snap([domIcon({ iconColor: '#242429' })]);
    const candWithIcon = snap([domIcon({ iconColor: '#6c5dd3' })]);
    // dom-dom goes through its own projection; here we assert the DIFF layer never emits the
    // axis under sides:'dom-dom' even if a projected spec somehow carried icon fields.
    const rows = diffPair(spec([figIcon({ iconHex: '#242429' })]), candWithIcon, { tolerancePx: 1, sides: 'dom-dom' });
    expect(iconRows(rows)).toEqual([]);
    void refWithIcon;
  });
  it('not_covered narrows: glyph geometry and icon-font/mask-image stay named, blanket "icons" is gone', () => {
    expect(NOT_COVERED_BY_TOOL.some((s) => /icon-glyph/.test(s))).toBe(true);
    expect(NOT_COVERED_BY_TOOL.some((s) => /icon-font|mask-image/.test(s))).toBe(true);
    expect(NOT_COVERED_BY_TOOL).not.toContain('icons');
  });
});
