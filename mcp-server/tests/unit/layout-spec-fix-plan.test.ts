// fix-plan: DiffRow.srcChannel — the source channel + the edit class (editKind),
// set DIRECTLY IN THE ROW LITERAL when it is created by a fail of an editable axis (index
// couplings proven unsound — rows is assembled from three arrays via spreads + the tool's unshift).
// Invariants:
//  - srcChannel is UNCONDITIONAL — does NOT depend on attributionOut (the defensive role of source-hint.test.ts:52);
//  - structural rows (children_reorder / layout_axis_mismatch) do NOT carry a channel EVER;
//  - pass rows and soft carriers (warn/demoted/info) do not carry a channel — the demotion strips it;
//  - text channel: the label is byte-for-byte == attributionOut.text[..].label (the label-space co-lock).
import { describe, it, expect } from 'vitest';
import { diffPair, condenseBulkPass, summarize } from '../../src/domain/layout-spec/diff.js';
import { buildFixPlan, buildPairSource } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import type {
  LayoutSpec, DomSnapshotOk, PairAttribution, GradientModel, DiffRow, PairResult, PairSource,
  FixPlanGroup, FixPlanEdit,
} from '../../src/domain/layout-spec/types.js';
import type { SourceHint } from '../../src/domain/layout-spec/class-source.js';

const TABS_A = 'tabs-module-scss-module__Ta0__root';    // direct child (module A)
const CARRIER_B = 'seg-module-scss-module__Se1__label'; // text carrier (module B)

const baseDom = (over: Partial<DomSnapshotOk>): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.root', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 200 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false,
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 200, scrollHeight: 200,
  children: [], ...over,
});

const run = (spec: LayoutSpec, dom: DomSnapshotOk): DiffRow[] => diffPair(spec, dom, { tolerancePx: 1 });
const findRow = (rows: DiffRow[], prefix: string): DiffRow | undefined => rows.find((r) => r.prop.startsWith(prefix));

describe('fix-plan — DiffRow.srcChannel on fail rows of editable axes', () => {
  // #1 gap-fail → {kind:'root', editKind:'layout'}; the pair's size.w → root/layout.
  it('#1 gap-fail and size.w-fail carry srcChannel root/layout', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 200 }, axis: 'col',
      children: [
        { id: '1:2', name: 'title', type: 'FRAME', rect: { x: 16, y: 12, w: 311, h: 80 } },
        { id: '1:3', name: 'list', type: 'FRAME', rect: { x: 16, y: 104, w: 311, h: 80 } }, // fig gap 12
      ],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 300, h: 200 }, clientWidth: 300, children: [
      { kind: 'element', tag: 'div', rect: { x: 16, y: 12, w: 311, h: 80 } },
      { kind: 'element', tag: 'div', rect: { x: 16, y: 120, w: 311, h: 80 } },              // dom gap 28
    ] });
    const rows = run(spec, dom);
    const gap = findRow(rows, 'gap[0]')!;
    expect(gap.status).toBe('fail');
    expect(gap.srcChannel).toEqual({ kind: 'root', editKind: 'layout' });
    const sizeW = findRow(rows, 'size.w')!;
    expect(sizeW.status).toBe('fail');
    expect(sizeW.srcChannel).toEqual({ kind: 'root', editKind: 'layout' });
    // pass rows of the same pair do NOT carry a channel (mutation "set always" → RED).
    for (const r of rows.filter((x) => x.status === 'pass')) expect(r.srcChannel).toBeUndefined();
  });

  // #2 offset-cross[1]-fail on SAME-NAMED children → {kind:'child', i:1, editKind:'layout'}
  // (mutation "offset-cross → root" → RED here; the same-naming rules out a match by name).
  it('#2 offset-cross[1]-fail on same-named card → child(1)/layout; offset-cross[0] pass without a channel', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 400, h: 100 }, axis: 'row',
      children: [
        { id: '1:2', name: 'card', type: 'FRAME', rect: { x: 0, y: 0, w: 180, h: 100 } },
        { id: '1:3', name: 'card', type: 'FRAME', rect: { x: 200, y: 0, w: 180, h: 100 } },
      ],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 400, h: 100 }, clientWidth: 400, clientHeight: 100, scrollHeight: 100, children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 180, h: 100 } },
      { kind: 'element', tag: 'div', rect: { x: 200, y: 10, w: 180, h: 80 } }, // cross shift 10
    ] });
    const rows = run(spec, dom);
    const off1 = findRow(rows, 'offset-cross[1]')!;
    expect(off1.status).toBe('fail');
    expect(off1.srcChannel).toEqual({ kind: 'child', i: 1, editKind: 'layout' });
    const off0 = findRow(rows, 'offset-cross[0]')!;
    expect(off0.status).toBe('pass');
    expect(off0.srcChannel).toBeUndefined();
  });

  // #3 typography-descent font-weight-fail → {kind:'text', label, editKind:'property'};
  // the label is byte-for-byte == attributionOut.text[..].label (the label-space co-lock; mutation
  // "text-label ≠ attributionOut-label" → RED). + #9 the unconditionality co-lock: rows with/without
  // attributionOut are byte-identical, srcChannel is present in BOTH runs.
  const descentSpec: LayoutSpec = {
    node: { id: '1:1', name: 'p', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 64 }, axis: 'col',
    children: [
      { id: '1:2', name: 'tabs', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 64 }, children: [
        { id: '1:3', name: 'tab', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 24 }, textSnippet: 'Популярное',
          text: { fontSize: 14, fontWeight: 700, fontFamily: 'Inter' } },
      ] },
    ],
  };
  const descentDom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 64 }, clientHeight: 64, scrollHeight: 64, children: [
    { kind: 'element', tag: 'div', classList: [TABS_A], rect: { x: 0, y: 0, w: 343, h: 64 }, children: [
      { kind: 'element', tag: 'span', classList: [CARRIER_B], rect: { x: 0, y: 0, w: 200, h: 24 }, children: [
        { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 24 }, text: 'Популярное',
          styles: { fontSize: 14, fontWeight: 400, fontFamily: 'Roboto' } },
      ] },
    ] },
  ] });
  it('#3 font-weight-fail on the descent → text(label)/property, label == attributionOut.text label', () => {
    const attr: PairAttribution = {};
    const rows = diffPair(descentSpec, descentDom, { tolerancePx: 1, attributionOut: attr });
    const fw = findRow(rows, 'font-weight[')!;
    expect(fw.status).toBe('fail');
    expect(fw.srcChannel).toEqual({ kind: 'text', label: '[tabs→"Популярное"]', editKind: 'property' });
    // the label-space co-lock: the same label as in attributionOut.text (buildFixPlan resolves by it).
    expect(attr.text).toHaveLength(1);
    expect(fw.srcChannel!.label).toBe(attr.text![0].label);
  });

  // #4b font-family-fail on the descent → text(label)/property (twin of font-weight, was missed).
  it('#4b font-family-fail on the descent → text(label)/property', () => {
    const rows = run(descentSpec, descentDom);
    const ff = findRow(rows, 'font-family[')!;
    expect(ff.status).toBe('fail');
    expect(ff.srcChannel).toEqual({ kind: 'text', label: '[tabs→"Популярное"]', editKind: 'property' });
  });

  // #9 the source-hint line co-lock: srcChannel is UNCONDITIONAL — rows with/without attributionOut are byte-identical
  // (mutation "gate the channel on attributionOut" → RED: the channel would disappear from the run without attr).
  it('#9 srcChannel is unconditional: rows with/without attributionOut are byte-identical, the channel is in both', () => {
    const attr: PairAttribution = {};
    const withAttr = diffPair(descentSpec, descentDom, { tolerancePx: 1, attributionOut: attr });
    const withoutAttr = diffPair(descentSpec, descentDom, { tolerancePx: 1 });
    expect(JSON.stringify(withAttr)).toBe(JSON.stringify(withoutAttr));
    expect(findRow(withoutAttr, 'font-weight[')!.srcChannel).toBeDefined();
  });

  // #4b-root: a DIRECT text pair (spec.text, suffix='') — there is NO label, attributionOut.text is empty →
  // channel ROOT/property, NOT text('').
  it('#4b root text pair (suffix="") with font-weight-fail → {kind:"root"}, NOT text("")', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'title', type: 'TEXT' }, rect: { x: 0, y: 0, w: 343, h: 200 },
      text: { fontSize: 14, fontWeight: 700, lineHeightPx: 20, lineHeightUnit: 'INTRINSIC_%' }, children: [],
    };
    const dom = baseDom({ styles: { fontSize: 14, fontWeight: 400, lineHeight: 40 },
      // p.7 migration: the root carrier routing needs the node to own its text
      children: [{ kind: 'text', rect: { x: 0, y: 0, w: 343, h: 200 }, text: 't' }] });
    const rows = run(spec, dom);
    const fw = rows.find((r) => r.prop === 'font-weight')!;
    expect(fw.status).toBe('fail');
    expect(fw.srcChannel).toEqual({ kind: 'root', editKind: 'property' });
    expect(fw.srcChannel!.kind).not.toBe('text');
    expect(fw.srcChannel!.label).toBeUndefined();
    // line-height Figma-auto: a numRow-fail is post-hoc softened to warn → a soft carrier does NOT carry a channel.
    const lh = rows.find((r) => r.prop === 'line-height')!;
    expect(lh.status).toBe('warn');
    expect(lh.srcChannel).toBeUndefined();
  });

  // #4 fill-fail on a DIRECT (un-wrapped) pair → {kind:'anchor', editKind:'property'} (resolve
  // anchor??root in buildFixPlan). Fixture: DOM root with its OWN styles.backgroundColor (hex ≠
  // spec.fillHex), styleAnchor disqualified (children:[] → aRes undefined) → colorVerdict C branch.
  it('#4 fill-fail on a direct pair → anchor/property (aRes undefined, colorVerdict C branch)', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'card', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 120 },
      fillHex: '#ff0000', children: [],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 120 }, clientHeight: 120, scrollHeight: 120,
      styles: { backgroundColor: '#00ff00' }, children: [] });
    const rows = run(spec, dom);
    expect(rows.find((r) => r.prop === 'style_anchor')).toBeUndefined(); // direct pair: no descent
    const fill = rows.find((r) => r.prop === 'fill')!;
    expect(fill.status).toBe('fail');
    expect(fill.srcChannel).toEqual({ kind: 'anchor', editKind: 'property' });
  });

  // #4c gradient-stop-color-fail → anchor/property; the gradient info/warn rows WITHOUT a channel.
  it('#4c gradient-stop-color-fail → anchor/property; gradient info/warn/pass without a channel', () => {
    const figG: GradientModel = { kind: 'linear', angleDeg: 90, whole: { literal: true }, stops: [
      { position: 0, hex: '#ff0000', token: { literal: true } },
      { position: 1, hex: '#0000ff', token: { literal: true } },
    ] };
    const domG: GradientModel = { kind: 'linear', angleDeg: 90, whole: { literal: true }, multiLayer: true, stops: [
      { position: 0, hex: '#00ff00', token: { literal: true } }, // the stop color diverged
      { position: 1, hex: '#0000ff', token: { literal: true } },
    ] };
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'hero', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 120 },
      gradient: figG, children: [],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 120 }, clientHeight: 120, scrollHeight: 120,
      styles: { gradient: domG }, children: [] });
    const rows = run(spec, dom);
    const stop = rows.find((r) => r.prop === 'gradient-stop-0-color')!;
    expect(stop.status).toBe('fail');
    expect(stop.srcChannel).toEqual({ kind: 'anchor', editKind: 'property' });
    // non-fail gradient rows do NOT carry a channel (info multiLayer / pass angle / pass token).
    expect(rows.find((r) => r.prop === 'gradient-layers')!.status).toBe('info');
    for (const r of rows.filter((x) => x.prop.startsWith('gradient') && x.status !== 'fail')) {
      expect(r.srcChannel).toBeUndefined();
    }
    // a warn gradient row (the stop count diverged) — also without a channel.
    const warnRows = run(spec, baseDom({ rect: { x: 0, y: 0, w: 343, h: 120 }, clientHeight: 120, scrollHeight: 120,
      styles: { gradient: { ...domG, stops: domG.stops.slice(0, 1) } }, children: [] }));
    const stops = warnRows.find((r) => r.prop === 'gradient-stops')!;
    expect(stops.status).toBe('warn');
    expect(stops.srcChannel).toBeUndefined();
  });

  // #5 opacity-fail → anchor/property (the axis was missed in the routing draft).
  it('#5 opacity-fail → anchor/property', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'card', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 120 },
      opacity: 0.5, children: [],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 120 }, clientHeight: 120, scrollHeight: 120,
      styles: { opacity: 1 }, children: [] });
    const rows = run(spec, dom);
    const op = rows.find((r) => r.prop === 'opacity')!;
    expect(op.status).toBe('fail');
    expect(op.srcChannel).toEqual({ kind: 'anchor', editKind: 'property' });
  });

  // #6 STRUCTURAL: children_reorder (fixture from source-hint #8d) → srcChannel is ABSENT
  // (mutation "channel on a structural one" → RED). A structural axis is not a "property edit", its remediation is in blocking.
  it('#6 children_reorder-fail WITHOUT srcChannel (a structural axis carries no channel)', () => {
    const inst = (id: string, t: string, x: number) => ({ id, name: id, type: 'INSTANCE',
      rect: { x, y: 0, w: 100, h: 40 }, children: [{ id: `${id}t`, name: t, type: 'TEXT',
      rect: { x, y: 0, w: 90, h: 18 }, textSnippet: t }] });
    const domI = (t: string, x: number) => ({ kind: 'element' as const, tag: 'article',
      rect: { x, y: 0, w: 100, h: 40 }, children: [{ kind: 'element' as const, tag: 'span',
      rect: { x, y: 0, w: 90, h: 18 }, text: t }] });
    const spec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [inst('1:2', 'Алый парус', 0), inst('1:3', 'Белый клык', 120), inst('1:4', 'Отверженные', 240)],
    } as unknown as LayoutSpec;
    const dom = baseDom({ rect: { x: 0, y: 0, w: 340, h: 40 }, clientWidth: 340, clientHeight: 40, scrollHeight: 40, children: [
      domI('Отверженные', 0), domI('Белый клык', 120), domI('Алый парус', 240),
    ] });
    const rows = run(spec, dom);
    const reorder = rows.find((r) => r.prop === 'children_reorder')!;
    expect(reorder.status).toBe('fail'); // the detector really fired
    expect(reorder.srcChannel).toBeUndefined();
  });

  it('#6b layout_axis_mismatch-fail WITHOUT srcChannel (a second structural axis, in the spirit of #6)', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [
        { id: '1:2', name: 'a', type: 'FRAME', rect: { x: 0, y: 0, w: 100, h: 40 } },
        { id: '1:3', name: 'b', type: 'FRAME', rect: { x: 120, y: 0, w: 100, h: 40 } },
      ],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 340, h: 40 }, clientWidth: 340, clientHeight: 40, scrollHeight: 40, children: [
      { kind: 'element', tag: 'div', rect: { x: 120, y: 0, w: 100, h: 40 } }, // non-monotonic document order
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 40 } },
    ] });
    const rows = run(spec, dom);
    const mism = rows.find((r) => r.prop === 'layout_axis_mismatch')!;
    expect(mism.status).toBe('fail');
    expect(mism.srcChannel).toBeUndefined();
  });

  // #7 pass rows WITHOUT srcChannel + NO non-fail row (warn/demoted/info) carries a channel on the
  // demotion fixture (mutation "set always" → RED; a soft carrier does not carry an edit address).
  it('#7 demotion fixture (hug-TEXT size.w fail→demoted): no non-fail row carries a channel', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'label', type: 'TEXT' }, rect: { x: 0, y: 0, w: 343, h: 200 },
      textNode: true, children: [], // hug-width TEXT (textFixedWidth absent) → size.w is demoted
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 300, h: 200 }, clientWidth: 300 });
    const rows = run(spec, dom);
    const sizeW = rows.find((r) => r.prop === 'size.w')!;
    expect(sizeW.status).toBe('demoted'); // the fixture really demotes (probe gate)
    expect(sizeW.srcChannel).toBeUndefined();
    for (const r of rows) {
      if (r.status !== 'fail') expect(r.srcChannel).toBeUndefined();
    }
  });

  // #7b-#7d (final LOW): #7 exercised ONLY applyTextWidthOverride — a mutation "remove stripSrc"
  // from the three other demotion helpers kept the suite green (the promise "a soft carrier does not carry an
  // address" was locked only a quarter of the way). One fixture per helper, each with a probe gate
  // "the row really is demoted"; a mutation "remove stripSrc" in the corresponding helper → RED here.
  it('#7b overlay demotion (expectedOverlayWidth): size.w fail→demoted WITHOUT a channel', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'drawer', type: 'FRAME' }, rect: { x: 0, y: 0, w: 420, h: 200 },
      children: [],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 375, h: 200 }, clientWidth: 375 });
    const rows = diffPair(spec, dom, { tolerancePx: 1, expectedOverlayWidth: 420 });
    const sizeW = rows.find((r) => r.prop === 'size.w')!;
    expect(sizeW.status).toBe('demoted');
    expect(sizeW.srcChannel).toBeUndefined();
  });

  it('#7c hug-vs-fill demotion (hugWidth container, DOM wider): size.w fail→demoted WITHOUT a channel', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'chip', type: 'FRAME' }, rect: { x: 0, y: 0, w: 200, h: 50 },
      hugWidth: true, children: [],
    } as unknown as LayoutSpec;
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 50 }, clientWidth: 343, clientHeight: 50, scrollHeight: 50 });
    const rows = run(spec, dom);
    const sizeW = rows.find((r) => r.prop === 'size.w')!;
    expect(sizeW.status).toBe('demoted');
    expect(sizeW.srcChannel).toBeUndefined();
  });

  it('#7d justify demotion (space-between, flex): trailing padding fail→demoted WITHOUT a channel', () => {
    // space-between distributes the free space → the trailing gap is not a padding defect; the gate requires
    // a real flex/grid display. The children match, padding-end diverges ONLY due to the distribution.
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'bar', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 40 },
      axis: 'row', autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      children: [
        { id: '1:2', name: 'a', type: 'FRAME', rect: { x: 0, y: 0, w: 50, h: 40 } },
        { id: '1:3', name: 'b', type: 'FRAME', rect: { x: 60, y: 0, w: 50, h: 40 } },
      ],
    } as unknown as LayoutSpec;
    const dom = baseDom({
      rect: { x: 0, y: 0, w: 343, h: 40 }, clientWidth: 343, clientHeight: 40, scrollHeight: 40,
      styles: { display: 'flex', justifyContent: 'space-between' },
      children: [
        { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 50, h: 40 } },
        { kind: 'element', tag: 'div', rect: { x: 293, y: 0, w: 50, h: 40 } },
      ],
    });
    const rows = diffPair(spec, dom, { tolerancePx: 1 });
    const demoted = rows.filter((r) => r.status === 'demoted' && /padding|gap/.test(r.prop));
    expect(demoted.length).toBeGreaterThan(0); // probe gate: the justify demotion really fired
    for (const r of demoted) expect(r.srcChannel).toBeUndefined();
    for (const r of rows) if (r.status !== 'fail') expect(r.srcChannel).toBeUndefined();
  });
});

// fix-plan: buildFixPlan — channel resolution by source + grouping by candidate file
// (module+local) + null group + caps. The differ's srcChannel objects are shared constants: buildFixPlan
// reads them read-only, creates edits/groups fresh. The gate is the FINAL status==='fail' && srcChannel.
describe('fix-plan — buildFixPlan grouping/resolution/caps/budget', () => {
  const X_ROOT: SourceHint = { module: 'x.module.scss', local: 'root', raw: 'x-module-scss-module__X1__root' };
  // hand-fail: a row of an editable axis created by a fail (as the differ does).
  const failRow = (prop: string, src: NonNullable<DiffRow['srcChannel']>, over: Partial<DiffRow> = {}): DiffRow =>
    ({ prop, figma: 1, dom: 2, delta: 1, status: 'fail', srcChannel: src, ...over });

  // #10 grouping 2 channels of the same module+local → 1 group + anchor??root fallback + kind property/layout.
  // size.w (root/layout) and fill (anchor/property, source WITHOUT anchor → resolves to root) → ONE file address →
  // ONE group with 2 edits. A mutation "resolve strictly anchor" → fill into the null group → 2 groups → RED.
  // A mutation "kind all property" → size.w.kind='property' → RED.
  it('#10 two channels of the same address (root + anchor→root) merge into 1 group; kind property/layout are honest', () => {
    const src: PairSource = { root: X_ROOT };
    const rows = [
      failRow('size.w', { kind: 'root', editKind: 'layout' }),
      failRow('fill', { kind: 'anchor', editKind: 'property' }, { figma: '#ff0000', dom: '#00ff00', delta: undefined }),
    ];
    const plan = buildFixPlan(rows, src)!;
    expect(plan.fix_plan).toHaveLength(1);           // merged into one address
    expect(plan.fix_plan[0].target).toEqual(X_ROOT); // anchor??root gave the root address
    expect(plan.fix_plan[0].edits).toHaveLength(2);
    const sizeEdit = plan.fix_plan[0].edits.find((e) => e.prop === 'size.w')!;
    const fillEdit = plan.fix_plan[0].edits.find((e) => e.prop === 'fill')!;
    expect(sizeEdit.kind).toBe('layout');            // metric → fix the layout rule
    expect(fillEdit.kind).toBe('property');          // literal → "set it to #ff0000"
    expect(fillEdit.expected).toBe('#ff0000');       // row.figma AS IS
    expect(fillEdit.actual).toBe('#00ff00');
    expect(fillEdit.delta).toBeUndefined();          // a row without delta — the field is omitted
    expect(sizeEdit.delta).toBe(1);
    expect(plan.fix_plan_capped).toBeUndefined();
  });

  // #10b anchor??root RED-lock explicitly: source WITHOUT root AND WITHOUT anchor → the anchor-fail falls into the null group
  // (address not derived, but the fail is VISIBLE). And if source.anchor existed — it would resolve to it.
  it('#10b anchor resolves to anchor when present; otherwise to root; otherwise null (never silent)', () => {
    const anchorHint: SourceHint = { module: 'btn.module.scss', local: 'root', raw: 'btn' };
    const withAnchor = buildFixPlan([failRow('opacity', { kind: 'anchor', editKind: 'property' })],
      { root: X_ROOT, anchor: anchorHint })!;
    expect(withAnchor.fix_plan[0].target).toEqual(anchorHint); // anchor wins over root when present
    const noAddr = buildFixPlan([failRow('opacity', { kind: 'anchor', editKind: 'property' })], undefined)!;
    expect(noAddr.fix_plan).toHaveLength(1);
    expect(noAddr.fix_plan[0].target).toBeNull();
    expect(noAddr.fix_plan[0].channel).toBe('unknown');
  });

  // #11 the null group is SINGLE and LAST: an addressed edit + two address-less ones (child without a hint, text without
  // a hint) → the addressed group first, ONE 'unknown' group last with BOTH edits (the origin channel does not split
  // the null group).
  it('#11 null-target edits collapse into ONE unknown group, the last one; the addressed one — first', () => {
    const src: PairSource = { root: X_ROOT }; // neither children nor text → these channels give null
    const rows = [
      failRow('gap[0] a↔b', { kind: 'root', editKind: 'layout' }),
      failRow('offset-cross[2] c', { kind: 'child', i: 2, editKind: 'layout' }),
      failRow('font-weight[x]', { kind: 'text', label: '[x]', editKind: 'property' }),
    ];
    const plan = buildFixPlan(rows, src)!;
    expect(plan.fix_plan).toHaveLength(2);
    expect(plan.fix_plan[0].target).toEqual(X_ROOT); // addressed first
    const last = plan.fix_plan[plan.fix_plan.length - 1];
    expect(last.target).toBeNull();
    expect(last.channel).toBe('unknown');
    expect(last.edits.map((e) => e.prop)).toEqual(['offset-cross[2] c', 'font-weight[x]']); // BOTH in one group
  });

  // #12 fail-only gate: warn/review/pass/skip/info rows → empty (undefined). Even warn/demoted rows
  // CARRYING srcChannel (they should not, but double protection) — the status gate cuts them off.
  it('#12 warn/review/pass → plan undefined; a demotion with a channel is cut by the status gate (double protection)', () => {
    expect(buildFixPlan([
      { prop: 'fill', figma: 1, dom: 2, status: 'warn' },
      { prop: 'color', figma: 'a', dom: 'b', status: 'review' },
      { prop: 'size.w', figma: 1, dom: 1, status: 'pass' },
      { prop: 'gap[0]', status: 'skip' },
    ], { root: X_ROOT })).toBeUndefined();
    // a demoted row WITH a channel (a hypothetical diff.ts regression) — the gate status==='fail' cuts it ANYWAY.
    const plan = buildFixPlan([
      { prop: 'size.w', figma: 1, dom: 2, delta: 1, status: 'demoted', srcChannel: { kind: 'root', editKind: 'layout' } },
      failRow('gap[0] a↔b', { kind: 'root', editKind: 'layout' }),
    ], { root: X_ROOT })!;
    expect(plan.fix_plan.flatMap((g) => g.edits.map((e) => e.prop))).toEqual(['gap[0] a↔b']); // ONLY fail
  });

  // #13 caps: >10 groups → cut to 10, fix_plan_capped = the number of cut edits (not groups); >10 edits in
  // a group → cut to 10. Consistent with blocking_capped/places_capped (counting elements).
  it('#13a cap 10 groups: 12 addresses → 10 groups + fix_plan_capped=2 (cut edits)', () => {
    const src: PairSource = { children: Array.from({ length: 12 }, (_, i) => ({
      i, name: `c${i}`, hint: { module: `m${i}.module.scss`, local: 'root', raw: `c${i}` } as SourceHint })) };
    const rows = Array.from({ length: 12 }, (_, i) => failRow(`offset-cross[${i}] c${i}`, { kind: 'child', i, editKind: 'layout' }));
    const plan = buildFixPlan(rows, src)!;
    expect(plan.fix_plan).toHaveLength(10);
    expect(plan.fix_plan_capped).toBe(2); // 2 groups × 1 edit cut
  });
  it('#13b cap 10 edits/group: 13 root-fail → 1 group, 10 edits, fix_plan_capped=3', () => {
    const rows = Array.from({ length: 13 }, (_, i) => failRow(`p${i}`, { kind: 'root', editKind: 'property' }));
    const plan = buildFixPlan(rows, { root: X_ROOT })!;
    expect(plan.fix_plan).toHaveLength(1);
    expect(plan.fix_plan[0].edits).toHaveLength(10);
    expect(plan.fix_plan_capped).toBe(3);
  });

  // #14 the root channel typography (a DIRECT text pair, suffix='') resolves to source.root — integration of
  // diffPair(srcChannel) → buildPairSource → buildFixPlan on a real chain.
  it('#14 root-typography font-weight-fail → group target=source.root, channel root (integration)', () => {
    const ROOT_CLASS = 'title-module-scss-module__Tt3__root';
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'title', type: 'TEXT' }, rect: { x: 0, y: 0, w: 343, h: 200 },
      text: { fontSize: 14, fontWeight: 700 }, children: [],
    };
    const dom = baseDom({ styles: { fontSize: 14, fontWeight: 400 },
      // p.7 migration: the root carrier routing needs the node to own its text
      children: [{ kind: 'text', rect: { x: 0, y: 0, w: 343, h: 200 }, text: 't' }],
      componentHints: { tag: 'h1', classList: [ROOT_CLASS], data: {} } });
    const attr: PairAttribution = {};
    const rows = diffPair(spec, dom, { tolerancePx: 1, attributionOut: attr });
    const source = buildPairSource(attr, dom.componentHints!.classList)!;
    const plan = buildFixPlan(rows, source)!;
    const grp = plan.fix_plan.find((g) => g.edits.some((e) => e.prop === 'font-weight'))!;
    expect(grp.channel).toBe('root');
    expect(grp.target).toEqual(source.root);        // resolve root → source.root
    expect(grp.target!.local).toBe('root');
    expect(grp.edits.find((e) => e.prop === 'font-weight')!.expected).toBe(700);
  });

  // #15 PRE-condense robustness: fix_plan is built on PRE-condense rows; condenseBulkPass collapses
  // ONLY bulk-pass → fix_plan survives the collapse (spread) and its fail-refs stay valid
  // fail rows in the condensed rows (not collapsed). A mutation "condense loses fix_plan" → RED.
  it('#15 fix_plan survives condenseBulkPass; fail-refs stay fail rows in condensed', () => {
    const rows: DiffRow[] = [
      { prop: 'font-size[a]', figma: 14, dom: 14, status: 'pass' },      // bulk-pass (will collapse)
      { prop: 'font-weight[a]', figma: 400, dom: 400, status: 'pass' },  // bulk-pass (will collapse)
      failRow('gap[0] a↔b', { kind: 'root', editKind: 'layout' }),       // signal (will survive)
    ];
    const fixPlan = buildFixPlan(rows, { root: X_ROOT })!;
    const pair: PairResult = { node_id: '1:1', rows, summary: summarize(rows), fix_plan: fixPlan.fix_plan };
    const [condensed] = condenseBulkPass([pair]);
    expect(condensed.fix_plan).toEqual(fixPlan.fix_plan);               // fix_plan survived the collapse
    expect(condensed.rows.some((r) => r.prop === 'passes_condensed')).toBe(true); // bulk collapsed
    // every fail-ref of the plan still exists as a fail row (not collapsed)
    for (const p of condensed.fix_plan!.flatMap((g) => g.edits.map((e) => e.prop))) {
      expect(condensed.rows.some((r) => r.prop === p && r.status === 'fail')).toBe(true);
    }
  });
});

// fix-plan — the markdown "Edits:" block in report.ts, rendered STRICTLY from fix_plan (not from
// rows). Hand-crafted PairResult.fix_plan (as in the buildFixPlan suite above)
// — the render does not re-parse classList, it only formats the already-assembled groups.
describe('fix-plan — the markdown "Edits:" block renders from fix_plan', () => {
  const ZERO_SUMMARY = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 };
  const LINK_ROOT: SourceHint = { module: 'link.module.scss', local: 'root', raw: 'link-module-scss-module__L1__root' };
  // A Vite target without a module → show local.
  const VITE_LOCAL: SourceHint = { local: 'card', raw: 'card' };

  // Extracts ONLY the "Edits (target..." substring of the pair — the block ends at the empty pair-separator line
  // (renderReport pushes '' after each pair).
  const extractFixBlock = (md: string): string => {
    const start = md.indexOf('Edits (target');
    if (start === -1) return '';
    const rest = md.slice(start);
    const end = rest.indexOf('\n\n');
    return end === -1 ? rest : rest.slice(0, end);
  };

  // #16 RENDER STRICTLY FROM fix_plan (mutation "bypass fix_plan from rows" → RED): rows carries a fail with
  // srcChannel (gap[0], a routable axis) WITHOUT a corresponding entry in fix_plan (a simulated
  // desync) — if the render read rows instead of fix_plan, the gap would seep into the "Edits" block.
  it('#16 markdown reflects ONLY fix_plan; a rows fail with a channel absent from fix_plan does not enter the block', () => {
    const fixPlan: FixPlanGroup[] = [{ target: LINK_ROOT, channel: 'text', edits: [
      { prop: 'font-weight', kind: 'property', expected: 550, actual: 450 },
    ] }];
    const pair: PairResult = {
      node_id: '1:1',
      rows: [
        { prop: 'gap[0] a↔b', figma: 8, dom: 40, delta: 32, status: 'fail', srcChannel: { kind: 'root', editKind: 'layout' } },
      ],
      summary: { ...ZERO_SUMMARY, fail: 1 },
      fix_plan: fixPlan,
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    const block = extractFixBlock(md);
    expect(block).toContain('- ≈ link.module.scss (.root): font-weight 550 ← 450');
    expect(block).not.toMatch(/gap\[0\]/); // a rows-only fail NOT in fix_plan → NOT in the block (mutation lock)
    expect(block.split('\n').filter((l) => l.startsWith('- ≈')).length).toBe(1);
  });

  // #17 ≈ prefix + the address form: a module target "module (.local)"; Vite-without-module → the honest form
  // ".local (local class)" (a nuance of the format, locked here).
  it('#17 ≈ prefix; the module form and the Vite module-less form ".card (local class)"', () => {
    const pair: PairResult = {
      node_id: '1:1', rows: [], summary: ZERO_SUMMARY,
      fix_plan: [
        { target: LINK_ROOT, channel: 'root', edits: [
          { prop: 'size.w', kind: 'layout', expected: 1272, actual: 1280, delta: 8 },
        ] },
        { target: VITE_LOCAL, channel: 'anchor', edits: [
          { prop: 'opacity', kind: 'property', expected: 1, actual: 0.5 },
        ] },
      ],
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).toContain('- ≈ link.module.scss (.root): layout: size.w 1272 ← 1280 (Δ8) — edit the layout rule, not px');
    expect(md).toContain('- ≈ .card (local class): opacity 1 ← 0.5');
  });

  // #18 ×N fold: 3 property edits of ONE target with an equal prop BASE (up to the first '[') + equal
  // expected/actual → ONE line "×3 places (check: one class?)", the base is shown without the bracket suffix.
  it('#18 ×N fold: 3×font-weight[…] of one target/expected/actual → one line "×3 places"', () => {
    const edits: FixPlanEdit[] = [
      { prop: 'font-weight[plates→"A"]', kind: 'property', expected: 550, actual: 450 },
      { prop: 'font-weight[plates→"B"]', kind: 'property', expected: 550, actual: 450 },
      { prop: 'font-weight[plates→"C"]', kind: 'property', expected: 550, actual: 450 },
    ];
    const pair: PairResult = {
      node_id: '1:1', rows: [], summary: ZERO_SUMMARY,
      fix_plan: [{ target: LINK_ROOT, channel: 'text', edits }],
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    const block = extractFixBlock(md);
    expect(block).toContain('- ≈ link.module.scss (.root): font-weight 550 ← 450 — ×3 places (check: one class?)');
    expect(block.split('\n').filter((l) => l.startsWith('- ≈')).length).toBe(1); // collapsed into ONE line
  });

  // #18b ×N fold does NOT collapse: a different actual (not the same edit class) stays separate;
  // kind='layout' NEVER collapses (fold ONLY kind='property'), even if the
  // prop base/expected/actual would match on a layout pair.
  it('#18b ×N fold does not touch a different expected/actual and NEVER kind=layout', () => {
    const pair: PairResult = {
      node_id: '1:1', rows: [], summary: ZERO_SUMMARY,
      fix_plan: [{ target: LINK_ROOT, channel: 'root', edits: [
        { prop: 'font-weight[a]', kind: 'property', expected: 550, actual: 450 },
        { prop: 'font-weight[b]', kind: 'property', expected: 550, actual: 400 }, // different actual
        { prop: 'size.w', kind: 'layout', expected: 100, actual: 90 },
        { prop: 'size.h', kind: 'layout', expected: 100, actual: 90 }, // "looks similar", but layout — never collapses
      ] }],
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    const block = extractFixBlock(md);
    expect(block.split('\n').filter((l) => l.startsWith('- ≈')).length).toBe(4);
    expect(block).not.toContain('places');
  });

  // #19 the layout: prefix on gap/size + the honest note "edit the layout rule, not px" (kind='layout').
  it('#19 the layout: prefix on a gap-edit + the fixed note about the layout rule', () => {
    const pair: PairResult = {
      node_id: '1:1', rows: [], summary: ZERO_SUMMARY,
      fix_plan: [{ target: LINK_ROOT, channel: 'root', edits: [
        { prop: 'gap[0] title↔list', kind: 'layout', expected: 12, actual: 28, delta: 16 },
      ] }],
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).toContain('- ≈ link.module.scss (.root): layout: gap[0] title↔list 12 ← 28 (Δ16) — edit the layout rule, not px');
  });

  // #20 null group: one honest line "address not resolved: N edits — navigate by structure/text"
  // (not per-edit — N = the total edit count of the null group, the channel order does not split it).
  it('#20 null group renders as ONE line with the edit count', () => {
    const pair: PairResult = {
      node_id: '1:1', rows: [], summary: ZERO_SUMMARY,
      fix_plan: [{ target: null, channel: 'unknown', edits: [
        { prop: 'offset-cross[2] c', kind: 'layout', expected: 4, actual: 14, delta: 10 },
        { prop: 'font-weight[x]', kind: 'property', expected: 700, actual: 400 },
      ] }],
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).toContain('- address not resolved: 2 edits — navigate by structure/text');
  });

  // #21 a pair without fix_plan (the fail-only gate is empty) — no "Edits" block at all (neither a header nor lines).
  it('#21 a pair without fix_plan — no "Edits" block', () => {
    const pair: PairResult = {
      node_id: '1:1',
      rows: [{ prop: 'component', figma: 'a', dom: 'b', status: 'warn', note: 'heuristic' }],
      summary: { ...ZERO_SUMMARY, warn: 1 },
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).not.toContain('Edits (target');
  });

  // #22 the "Edits" block comes AFTER the "code:" line in the pair section (fixed position).
  it('#22 the "Edits" block renders after the "code:" line', () => {
    const pair: PairResult = {
      node_id: '1:1', rows: [], summary: ZERO_SUMMARY,
      source: { root: LINK_ROOT },
      fix_plan: [{ target: LINK_ROOT, channel: 'root', edits: [
        { prop: 'size.w', kind: 'layout', expected: 100, actual: 90, delta: 10 },
      ] }],
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    const codeIdx = md.indexOf('code:');
    const fixIdx = md.indexOf('Edits (target');
    expect(codeIdx).toBeGreaterThan(-1);
    expect(fixIdx).toBeGreaterThan(codeIdx);
  });

  // #23 integration buildFixPlan → renderReport (the assembly-and-render seam, not a hand-crafted FixPlanGroup[]):
  // 3 DIFFERENT text labels ("3 places" = 3 cards of one reusable component) resolve to a
  // structurally-equal (module+local) but reference-DIFFERENT SourceHint object → buildFixPlan must
  // merge them by value (keyOf), not by identity, and the render — collapse into "×3 places".
  it('#23 integration buildFixPlan→renderReport: 3 different text-labels of one address collapse into "×3 places"', () => {
    const cardHint: SourceHint = { module: 'plates.module.scss', local: 'card', raw: 'plates-module-scss-module__P1__card' };
    const source: PairSource = {
      text: [
        { label: '[plates→"A"]', hint: { ...cardHint } },
        { label: '[plates→"B"]', hint: { ...cardHint } },
        { label: '[plates→"C"]', hint: { ...cardHint } },
      ],
    };
    const rows: DiffRow[] = (['A', 'B', 'C'] as const).map((letter) => ({
      prop: `font-weight[plates→"${letter}"]`, figma: 550, dom: 450, status: 'fail',
      srcChannel: { kind: 'text', label: `[plates→"${letter}"]`, editKind: 'property' },
    }));
    const built = buildFixPlan(rows, source)!;
    const pair: PairResult = { node_id: '1:1', rows, summary: summarize(rows), source, fix_plan: built.fix_plan };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).toContain('- ≈ plates.module.scss (.card): font-weight 550 ← 450 — ×3 places (check: one class?)');
  });
});
