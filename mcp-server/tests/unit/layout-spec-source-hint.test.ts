// source-hint: collection of RAW attribution in diff.ts (opts.attributionOut) + assembly of
// PairSource in the tool (buildPairSource). The differ is silent about CSS classes (compares the result), but
// the CSS-modules class of a MATCHED DOM node carries a deterministic code address (parseCssModuleClass).
//
// Invariants:
//  - the collection is strictly read-only, zero input mutations → rows/summary are byte-identical to a run WITHOUT attributionOut;
//  - children are positional (an array, not a Record — same-named ones do not collapse), the hint from domKids2[i]
//    (the matched node AFTER unwrap/salvage), NOT from the raw d.children[i] by index;
//  - anchor = the LAST link of the transparent wrappers (the carrier), the gate mirrors the style_anchor row;
//  - the text hint from the ANCESTOR CHAIN (the nearest parseable one), not from the immediate parent;
//  - the parser (parseCssModuleClass) lives ONLY in the tool — it does not leak into diff.ts (diff carries classList);
//  - the tool creates a FRESH PairAttribution for EACH pair (a cross-pair leak is impossible).
import { describe, it, expect, vi } from 'vitest';
import { diffPair } from '../../src/domain/layout-spec/diff.js';
import {
  buildPairSource, SOURCE_NOTE_NO_PARSE, registerCompareNodeToDomTool,
} from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import type { LayoutSpec, DomSnapshotOk, PairAttribution, PairResult, PairSource } from '../../src/domain/layout-spec/types.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

// ── Live CSS-modules classes (turbopack P1: module with an extension + hash-with-digit + local) ──
const CARD_A = 'card-module-scss-module__Cd2__root';    // card.module.scss / root
const CARD_B = 'card-module-scss-module__Cd2__item';    // card.module.scss / item
const PANEL = 'panel-module-scss-module__Xy9__root';    // panel.module.scss / root
const WRAP = 'wrap-module-scss-module__Ab1__list';      // wrap.module.scss / list  (transparent DOM wrapper)
const TABS_A = 'tabs-module-scss-module__Ta0__root';    // tabs.module.scss / root  (direct child, module A)
const CARRIER_B = 'seg-module-scss-module__Se1__label'; // seg.module.scss / label  (text carrier, module B)
const BUTTON = 'button-module-scss-module__Bt1__root';  // button.module.scss / root (style carrier)
const SHELL = 'shell-module-scss-module__Rt0__root';    // shell.module.scss / root  (root / componentHints)

const baseDom = (over: Partial<DomSnapshotOk>): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.root', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 200 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false,
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 200, scrollHeight: 200,
  children: [], ...over,
});

// Zero-impact co-lock: rows are byte-identical with/without attributionOut. The differ only
// WRITES to the side-output — if the presence of the field drifted rows, this comparison would catch it.
const rowsWithoutAttr = (spec: LayoutSpec, dom: DomSnapshotOk) => diffPair(spec, dom, { tolerancePx: 1 });
const runWithAttr = (spec: LayoutSpec, dom: DomSnapshotOk): { rows: ReturnType<typeof diffPair>; attr: PairAttribution } => {
  const attr: PairAttribution = {};
  const rows = diffPair(spec, dom, { tolerancePx: 1, attributionOut: attr });
  // #8: the presence of attributionOut did not shift ANY row/summary.
  expect(JSON.stringify(rows)).toBe(JSON.stringify(rowsWithoutAttr(spec, dom)));
  return { rows, attr };
};

describe('source-hint — attribution collection in diff + source assembly in the tool', () => {
  // #1 children: a carousel with TWO same-named 'card' (different classList) → an array (not a Record),
  // DIFFERENT modules under i=0,1. A mutation "key by name / collapse" → RED (only 1 entry would remain).
  it('#1 children: two same-named card with different classList → two positional hints, modules differ', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 200 }, axis: 'col',
      children: [
        { id: '1:2', name: 'card', type: 'FRAME', rect: { x: 16, y: 12, w: 311, h: 80 } },
        { id: '1:3', name: 'card', type: 'FRAME', rect: { x: 16, y: 104, w: 311, h: 80 } },
      ],
    };
    const dom = baseDom({ children: [
      { kind: 'element', tag: 'div', classList: [CARD_A], rect: { x: 16, y: 12, w: 311, h: 80 } },
      { kind: 'element', tag: 'div', classList: [PANEL], rect: { x: 16, y: 104, w: 311, h: 80 } },
    ] });
    const { attr } = runWithAttr(spec, dom);
    // RAW: both under i=0,1 with DIFFERENT classList (the diff-side lock).
    expect(attr.children).toEqual([
      { i: 0, name: 'card', classList: [CARD_A] },
      { i: 1, name: 'card', classList: [PANEL] },
    ]);
    const src = buildPairSource(attr, undefined)!;
    expect(src.children).toHaveLength(2);
    expect(src.children![0].hint.module).toBe('card.module.scss');
    expect(src.children![1].hint.module).toBe('panel.module.scss');
    // explicit anti-collapse lock: the modules differ.
    expect(src.children![0].hint.module).not.toBe(src.children![1].hint.module);
  });

  // #8c same-name geometry: card on the left, panel on the right (row axis). children[i] carries the module of the i-th
  // GEOMETRIC child (domKids2 sorted by main-start, zip figKids[i]↔domKids2[i]) — not
  // "both present". Note: a reversed RAW array is unrealistic here — the extractor emits
  // document order, and the monotonicity guard (over RAW d.children) would reject it as layout_axis_mismatch.
  it('#8c same-name geometry: children[i] carries the module of the i-th geometric child (left↔card, right↔panel)', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 400, h: 100 }, axis: 'row',
      children: [
        { id: '1:2', name: 'card', type: 'FRAME', rect: { x: 0, y: 0, w: 180, h: 100 } },   // left
        { id: '1:3', name: 'card', type: 'FRAME', rect: { x: 200, y: 0, w: 180, h: 100 } },  // right
      ],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 400, h: 100 }, clientWidth: 400, clientHeight: 100, scrollHeight: 100, children: [
      { kind: 'element', tag: 'div', classList: [CARD_A], rect: { x: 0, y: 0, w: 180, h: 100 } },    // left = card
      { kind: 'element', tag: 'div', classList: [PANEL], rect: { x: 200, y: 0, w: 180, h: 100 } },   // right = panel
    ] });
    const { attr } = runWithAttr(spec, dom);
    const src = buildPairSource(attr, undefined)!;
    // left (i=0) = card, right (i=1) = panel — position i = the i-th geometric child.
    expect(src.children![0].hint.module).toBe('card.module.scss');
    expect(src.children![1].hint.module).toBe('panel.module.scss');
  });

  // #8d (final M1): children_reorder — a moved slot has NO per-child rows (gap/offset-cross/
  // typography skip movedIdx), and the zip figKids[i]↔domKids2[i] there is GEOMETRIC, not content-based:
  // a hint would lead to a real but WRONG file (Figma «Алый парус» → charlie.module.scss) — the worst
  // false-navigation mode, bypassing the consumer's gate "file found + local in it". The slots
  // are excluded mirroring the rows; a mutation "remove filter(movedIdx)" → RED here.
  it('#8d reorder: moved slots excluded from children (no rows → no hint), the non-reordered one survives', () => {
    const inst = (id: string, t: string, x: number) => ({ id, name: id, type: 'INSTANCE',
      rect: { x, y: 0, w: 100, h: 40 }, children: [{ id: `${id}t`, name: t, type: 'TEXT',
      rect: { x, y: 0, w: 90, h: 18 }, textSnippet: t }] });
    const domI = (t: string, cls: string, x: number) => ({ kind: 'element' as const, tag: 'article', classList: [cls],
      rect: { x, y: 0, w: 100, h: 40 }, children: [{ kind: 'element' as const, tag: 'span',
      rect: { x, y: 0, w: 90, h: 18 }, text: t }] });
    const spec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [inst('1:2', 'Алый парус', 0), inst('1:3', 'Белый клык', 120), inst('1:4', 'Отверженные', 240)],
    } as unknown as LayoutSpec;
    const dom = baseDom({ rect: { x: 0, y: 0, w: 340, h: 40 }, clientWidth: 340, clientHeight: 40, scrollHeight: 40, children: [
      domI('Отверженные', 'charlie-module-scss-module__Ch3__root', 0),
      domI('Белый клык', 'bravo-module-scss-module__Br2__root', 120),
      domI('Алый парус', 'alpha-module-scss-module__Al1__root', 240),
    ] });
    const attr: PairAttribution = {};
    const rows = diffPair(spec, dom, { tolerancePx: 1, attributionOut: attr });
    expect(rows.find((r) => r.prop === 'children_reorder')?.status).toBe('fail'); // the detector really fired
    const src = buildPairSource(attr, undefined)!;
    // ONLY the non-reordered i=1 remained (Белый клык ↔ bravo); moved 0/2 — without hints.
    expect(src.children!.map((c) => c.i)).toEqual([1]);
    expect(src.children![0].hint.module).toBe('bravo.module.scss');
  });

  // #2 unwrap: a DOM wrapper (WRAP) over carriers (CARD) with the fig side having no wrapper → children hint
  // from the CARRIER (card.module.scss), NOT from the wrapper. A mutation "raw d.children[i]" → RED (wrap.module.scss).
  it('#2 unwrap: hint from the unwrapped carrier, not from the transparent DOM wrapper', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 200 }, axis: 'col',
      children: [
        { id: '1:2', name: 'row', type: 'FRAME', rect: { x: 16, y: 12, w: 311, h: 80 } },
        { id: '1:3', name: 'row', type: 'FRAME', rect: { x: 16, y: 104, w: 311, h: 80 } },
      ],
    };
    const dom = baseDom({ children: [
      { kind: 'element', tag: 'div', classList: [WRAP], rect: { x: 0, y: 0, w: 343, h: 200 }, children: [
        { kind: 'element', tag: 'div', classList: [CARD_A], rect: { x: 16, y: 12, w: 311, h: 80 } },
        { kind: 'element', tag: 'div', classList: [CARD_B], rect: { x: 16, y: 104, w: 311, h: 80 } },
      ] },
    ] });
    const { attr } = runWithAttr(spec, dom);
    expect(attr.children).toEqual([
      { i: 0, name: 'row', classList: [CARD_A] },
      { i: 1, name: 'row', classList: [CARD_B] },
    ]);
    const src = buildPairSource(attr, undefined)!;
    expect(src.children!.every((c) => c.hint.module === 'card.module.scss')).toBe(true);
    // wrap.module.scss did not leak into any channel.
    expect(JSON.stringify(src)).not.toContain('wrap.module.scss');
  });

  // #3 salvage: fig 5 / dom 7, high-conf on 3 (text anchor). children carries EXACTLY 3, hint from
  // domKids2[m.domIdx] (matched in the raw array at positions 1/3/5). A mutation "d.children[i] by
  // index" → RED (would take noise from positions 0/1/2).
  it('#3 salvage: children carries 3 matched, hint from the MATCHED domKids2, not by the raw index', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 300 }, axis: 'col',
      children: [
        { id: '1:2', name: 'a', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 }, textSnippet: 'Alpha' },
        { id: '1:3', name: 'b', type: 'TEXT', rect: { x: 0, y: 30, w: 200, h: 20 }, textSnippet: 'Beta' },
        { id: '1:4', name: 'c', type: 'TEXT', rect: { x: 0, y: 60, w: 200, h: 20 }, textSnippet: 'Gamma' },
        { id: '1:5', name: 'x', type: 'FRAME', rect: { x: 0, y: 90, w: 200, h: 20 } },
        { id: '1:6', name: 'y', type: 'FRAME', rect: { x: 0, y: 120, w: 200, h: 20 } },
      ],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 300 }, clientHeight: 300, scrollHeight: 300, children: [
      { kind: 'element', tag: 'div', classList: ['noise-module-scss-module__N0__a'], rect: { x: 0, y: -30, w: 200, h: 20 }, text: 'Zzz0' },
      { kind: 'element', tag: 'div', classList: [CARD_A], rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'Alpha' },   // idx 1
      { kind: 'element', tag: 'div', classList: ['noise-module-scss-module__N2__c'], rect: { x: 0, y: 15, w: 200, h: 20 }, text: 'Zzz2' },
      { kind: 'element', tag: 'div', classList: [CARD_B], rect: { x: 0, y: 30, w: 200, h: 20 }, text: 'Beta' },    // idx 3
      { kind: 'element', tag: 'div', classList: ['noise-module-scss-module__N4__e'], rect: { x: 0, y: 45, w: 200, h: 20 }, text: 'Zzz4' },
      { kind: 'element', tag: 'div', classList: [PANEL], rect: { x: 0, y: 60, w: 200, h: 20 }, text: 'Gamma' },    // idx 5
      { kind: 'element', tag: 'div', classList: ['noise-module-scss-module__N6__g'], rect: { x: 0, y: 75, w: 200, h: 20 }, text: 'Zzz6' },
    ] });
    const { rows, attr } = runWithAttr(spec, dom);
    expect(rows.find((r) => r.prop === 'structure_mismatch')?.status).toBe('warn');
    // EXACTLY 3 matched, classList from the matched nodes (idx 1/3/5), NOT noise from idx 0/1/2.
    expect(attr.children).toEqual([
      { i: 0, name: 'a', classList: [CARD_A] },
      { i: 1, name: 'b', classList: [CARD_B] },
      { i: 2, name: 'c', classList: [PANEL] },
    ]);
    const src = buildPairSource(attr, undefined)!;
    expect(src.children!.map((c) => c.hint.local)).toEqual(['root', 'item', 'root']);
    expect(JSON.stringify(src.children)).not.toContain('noise.module.scss'); // a foreign classList did not leak
  });

  // #4 anchor: transparent style-less wrappers over a carrier with styles+class → anchor = the CARRIER
  // (button), not the wrapper (chain[0]) and not the root (shell/componentHints). Mutations "anchor := chain[0]"
  // / "anchor := root" → RED.
  it('#4 anchor: source.anchor from the style carrier (the last link), not from the wrapper/root', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'card', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 120 },
      fillHex: '#ffffff', children: [], // fillHex → hasStyleAxis (emission gate)
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 120 }, clientHeight: 120, scrollHeight: 120,
      componentHints: { tag: 'div', classList: [SHELL], data: {} },
      children: [
        { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 120 }, styles: {}, children: [   // transparent wrapper (no class)
          { kind: 'element', tag: 'button', classList: [BUTTON], rect: { x: 0, y: 0, w: 343, h: 120 }, styles: { backgroundColor: '#ffffff' }, children: [] }, // carrier (has bg)
        ] },
      ] });
    const { rows, attr } = runWithAttr(spec, dom);
    expect(rows.find((r) => r.prop === 'style_anchor')?.status).toBe('pass');
    expect(attr.anchorClassList).toEqual([BUTTON]);
    const src = buildPairSource(attr, [SHELL])!;
    expect(src.anchor?.module).toBe('button.module.scss');
    expect(src.root?.module).toBe('shell.module.scss');
    // anchor is NOT the root (mutation "anchor := root" → RED) and NOT empty (mutation "anchor := chain[0]"
    // would take the class-less wrapper → undefined → RED).
    expect(src.anchor?.module).not.toBe(src.root?.module);
  });

  it('#4b anchor is not attributed without a style axis (the gate mirrors the style_anchor row)', () => {
    // The same descent, but Figma has NOT a single style axis → the style_anchor row is not emitted → anchor
    // is not collected (the note "axes read" without a single check would be a lie).
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'card', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 120 }, children: [],
    };
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 120 }, clientHeight: 120, scrollHeight: 120,
      children: [
        { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 120 }, styles: {}, children: [
          { kind: 'element', tag: 'button', classList: [BUTTON], rect: { x: 0, y: 0, w: 343, h: 120 }, styles: { backgroundColor: '#ffffff' }, children: [] },
        ] },
      ] });
    const { rows, attr } = runWithAttr(spec, dom);
    expect(rows.find((r) => r.prop === 'style_anchor')).toBeUndefined();
    expect(attr.anchorClassList).toBeUndefined();
  });

  // #5 text: a direct child tabs (module A) → carrier seg (module B) → text leaf. The hint from the ANCESTOR
  // CHAIN = the nearest parseable one (B), NOT the direct tabs (A). A mutation "hint from the direct tabs" / reversing
  // the chain → RED. Second variant: a class-less <span> between the carrier and the text → hint is still B.
  const textSpec: LayoutSpec = {
    node: { id: '1:1', name: 'p', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 64 }, axis: 'col',
    children: [
      { id: '1:2', name: 'tabs', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 64 }, children: [
        { id: '1:3', name: 'tab', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 24 }, textSnippet: 'Популярное', text: { fontSize: 14 } },
      ] },
    ],
  };
  it('#5 text: hint from the nearest parseable ANCESTOR (carrier B), not from the direct tabs (A)', () => {
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 64 }, clientHeight: 64, scrollHeight: 64, children: [
      { kind: 'element', tag: 'div', classList: [TABS_A], rect: { x: 0, y: 0, w: 343, h: 64 }, children: [
        { kind: 'element', tag: 'span', classList: [CARRIER_B], rect: { x: 0, y: 0, w: 200, h: 24 }, children: [
          { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 24 }, text: 'Популярное', styles: { fontSize: 14 } },
        ] },
      ] },
    ] });
    const { attr } = runWithAttr(textSpec, dom);
    // RAW: the chain bottom-up — carrier B first, tabs A next (the parser was NOT called in diff).
    expect(attr.text).toEqual([{ label: '[tabs→"Популярное"]', classListChain: [[CARRIER_B], [TABS_A]] }]);
    const src = buildPairSource(attr, undefined)!;
    expect(src.text).toHaveLength(1);
    expect(src.text![0].label).toBe('[tabs→"Популярное"]');
    expect(src.text![0].hint.module).toBe('seg.module.scss');       // B
    expect(src.text![0].hint.module).not.toBe('tabs.module.scss');  // NOT A (the direct tabs)
  });
  it('#5b text: a class-less <span> between the carrier and the text → hint is still B (chain, not immediate parent)', () => {
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 64 }, clientHeight: 64, scrollHeight: 64, children: [
      { kind: 'element', tag: 'div', classList: [TABS_A], rect: { x: 0, y: 0, w: 343, h: 64 }, children: [
        { kind: 'element', tag: 'span', classList: [CARRIER_B], rect: { x: 0, y: 0, w: 200, h: 24 }, children: [
          { kind: 'element', tag: 'span', rect: { x: 0, y: 0, w: 200, h: 24 }, children: [ // class-less wrapper
            { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 24 }, text: 'Популярное', styles: { fontSize: 14 } },
          ] },
        ] },
      ] },
    ] });
    const { attr } = runWithAttr(textSpec, dom);
    expect(attr.text![0].classListChain).toEqual([[], [CARRIER_B], [TABS_A]]); // the class-less link first, the channel is not lost
    const src = buildPairSource(attr, undefined)!;
    expect(src.text![0].hint.module).toBe('seg.module.scss'); // the tool descended through the empty link to B
  });

  // #7 unpaired: structure_mismatch-salvage → unpaired carries path+hint of the unmatched DOM children, cap 10
  // (11 unmatched → 10). A mutation "remove the cap" → RED (11).
  it('#7 unpaired: 11 unmatched DOM children → cap 10', () => {
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 400 }, axis: 'col',
      children: [
        { id: '1:2', name: 'a', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 }, textSnippet: 'UniqueAlpha' },
        { id: '1:3', name: 'b', type: 'TEXT', rect: { x: 0, y: 30, w: 200, h: 20 }, textSnippet: 'UniqueBeta' },
      ],
    };
    const domKids: DomSnapshotOk['children'] = [
      { kind: 'element', tag: 'div', classList: [CARD_A], rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'UniqueAlpha', path: '.m0' },
      { kind: 'element', tag: 'div', classList: [CARD_B], rect: { x: 0, y: 30, w: 200, h: 20 }, text: 'UniqueBeta', path: '.m1' },
    ];
    const noise: DomSnapshotOk['children'] = Array.from({ length: 11 }, (_, k) => ({
      kind: 'element', tag: 'div', classList: [`x${k}-module-scss-module__Zz${k}__root`],
      rect: { x: 0, y: 100 + k * 30, w: 200, h: 20 }, text: `Noise${k}`, path: `.noise${k}`,
    }));
    const dom = baseDom({ rect: { x: 0, y: 0, w: 343, h: 400 }, clientHeight: 400, scrollHeight: 400, children: [...domKids, ...noise] });
    const { attr } = runWithAttr(spec, dom);
    expect(attr.unpaired).toHaveLength(10);       // cap at the collection site (diff side)
    expect(attr.unpaired![0]).toMatchObject({ path: '.noise0' });
    const src = buildPairSource(attr, undefined)!;
    expect(src.unpaired).toHaveLength(10);        // all parseable → 10 in source
    expect(src.unpaired!.every((u) => u.hint.module?.endsWith('.module.scss') === true)).toBe(true);
  });

  it('#7b unpaired: a total 0-high-conf structure_mismatch also collects the unpaired (the main add-pairs flow)', () => {
    // fig children without text → 0 high-conf (size+order max ~45 < 90); all DOM children are unpaired.
    const spec: LayoutSpec = {
      node: { id: '1:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 200 }, axis: 'col',
      children: [{ id: '1:2', name: 'only', type: 'FRAME', rect: { x: 0, y: 0, w: 200, h: 20 } }],
    };
    const dom = baseDom({ children: [
      { kind: 'element', tag: 'div', classList: [CARD_A], rect: { x: 0, y: 0, w: 200, h: 20 }, path: '.a' },
      { kind: 'element', tag: 'div', classList: [PANEL], rect: { x: 0, y: 30, w: 200, h: 20 }, path: '.b' },
      { kind: 'element', tag: 'div', classList: [WRAP], rect: { x: 0, y: 60, w: 200, h: 20 }, path: '.c' },
    ] });
    const { attr } = runWithAttr(spec, dom);
    expect(attr.unpaired).toHaveLength(3);
    const src = buildPairSource(attr, undefined)!;
    expect(src.unpaired!.map((u) => u.path)).toEqual(['.a', '.b', '.c']);
  });

  // #6 note: EXACTLY when classList is non-empty && 0 parses. A mutation "note always" → RED (case B undefined).
  describe('#6 note gate (buildPairSource tool logic)', () => {
    it('classList non-empty, 0 parses → note = the fixed string (and ONLY note)', () => {
      const src = buildPairSource({}, ['ab12cd', 'flex']);
      expect(src).toEqual({ note: SOURCE_NOTE_NO_PARSE });
    });
    it('note also fires from an unparseable child classList (not only the root)', () => {
      const src = buildPairSource({ children: [{ i: 0, name: 'x', classList: ['minified123abc'] }] }, undefined);
      expect(src).toEqual({ note: SOURCE_NOTE_NO_PARSE });
    });
    it('root classList=[] and children without classes → source === undefined (mutation "note always" → RED)', () => {
      expect(buildPairSource({ children: [{ i: 0, name: 'x' }] }, [])).toBeUndefined();
      expect(buildPairSource({}, undefined)).toBeUndefined();
    });
    it('a parse exists → note is NOT set (note is orthogonal to successful channels)', () => {
      const src = buildPairSource({ children: [{ i: 0, name: 'x', classList: [CARD_A] }] }, ['ab12cd']);
      expect(src!.note).toBeUndefined();
      expect(src!.children).toHaveLength(1);
    });
  });

  // buildPairSource: dedup child-hint === root-hint (module+local) — a child at the same address as the
  // root adds no navigation.
  it('child-hint === root-hint is deduplicated (same module+local as the root)', () => {
    const src = buildPairSource({ children: [
      { i: 0, name: 'a', classList: [SHELL] },   // === root
      { i: 1, name: 'b', classList: [CARD_A] },  // differs
    ] }, [SHELL]);
    expect(src!.children).toHaveLength(1);
    expect(src!.children![0].hint.module).toBe('card.module.scss');
  });
});

// ── Tool level: cross-pair isolation (#8b) + budget independence of the window (#9) ──
const logger = createLogger({ level: 'silent' });
function harness(api: Partial<FigmaApi>, maxResultChars = 40000) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars };
  registerCompareNodeToDomTool(server, deps);
  return (a: any): Promise<any> => call('compare_node_to_dom', a);
}

describe('source-hint — tool: cross-pair isolation + budget', () => {
  // #8b cross-pair: pair-1 with CSS-modules classes (fills children), pair-2 without auto-layout and
  // classes (no channel is written) → pair-2's source undefined. A mutation "one PairAttribution for
  // all pairs" → pair-2 would inherit pair-1's children (its early return does not overwrite them) → RED.
  it('#8b each pair gets a FRESH PairAttribution — the source of pair-2 does not leak from pair-1', async () => {
    const fig1: RawSceneNode = {
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 },
      layoutMode: 'VERTICAL', itemSpacing: 20,
      children: [
        { id: '1:2', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 12, width: 311, height: 40 } },
        { id: '1:3', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 64, width: 311, height: 40 } },
      ],
    };
    // pair-2: NO layoutMode → no axis → geometryRows does a children-skip and an early return (no channels
    // are written). With a shared object, pair-1's children would still be visible.
    const fig2: RawSceneNode = { id: '2:1', name: 'plain', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } };
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: fig1 }, '2:1': { document: fig2 } } }));
    const run = harness({ getNodesRaw } as unknown as Partial<FigmaApi>);

    const dom1 = { ...baseDom({ rect: { x: 0, y: 0, w: 343, h: 120 }, clientHeight: 120, scrollHeight: 120,
      componentHints: { tag: 'div', classList: [SHELL], data: {} }, children: [
        { kind: 'element', tag: 'div', classList: [CARD_A], rect: { x: 16, y: 12, w: 311, h: 40 } },
        { kind: 'element', tag: 'div', classList: [PANEL], rect: { x: 16, y: 64, w: 311, h: 40 } },
      ] }) };
    const dom2 = baseDom({ rect: { x: 0, y: 0, w: 100, h: 100 }, clientWidth: 100, clientHeight: 100, scrollHeight: 100, children: [] });

    const out = JSON.parse((await run({
      file: 'abc', tolerance_px: 1,
      pairs: [{ node_id: '1:1', dom: dom1, label: 'P1' }, { node_id: '2:1', dom: dom2, label: 'P2' }],
    })).content[0].text);

    const p1 = out.pairs.find((p: { node_id: string }) => p.node_id === '1:1');
    const p2 = out.pairs.find((p: { node_id: string }) => p.node_id === '2:1');
    expect(p1.source).toBeDefined();
    expect(p1.source.children).toHaveLength(2);
    expect(p1.source.root.module).toBe('shell.module.scss');
    // the key lock: pair-2 WITHOUT classes → source undefined, ZERO channels from pair-1.
    expect(p2.source).toBeUndefined();
  });

  // #9 budget: narrowDom pairs (children:[], no componentHints) → source===undefined → the baked-byte
  // serialization of the window does not grow. INVARIANT: the budget-fixture pairs do NOT carry CSS-modules classes
  // (source-independence of the window :1844 / self-calibrating locks :1457/:1486 immune by construction).
  it('#9 budget invariant: narrowDom pairs without classes → source===undefined (window untouched)', async () => {
    const mkFig = (id: string): RawSceneNode => ({ id, name: id, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 } });
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: mkFig('1:1') }, '1:2': { document: mkFig('1:2') }, '1:3': { document: mkFig('1:3') } } }));
    const run = harness({ getNodesRaw } as unknown as Partial<FigmaApi>);
    const narrowDom = (selector: string): DomSnapshotOk => baseDom({
      selector, rect: { x: 0, y: 0, w: 343, h: 120 }, clientWidth: 343, clientHeight: 120, scrollHeight: 120, children: [],
    });
    const out = JSON.parse((await run({
      file: 'abc', tolerance_px: 1,
      pairs: [
        { node_id: '1:1', dom: narrowDom('.a'), label: 'A' },
        { node_id: '1:2', dom: narrowDom('.b'), label: 'B' },
        { node_id: '1:3', dom: narrowDom('.c'), label: 'C' },
      ],
    })).content[0].text);
    // no budget fixture carries CSS-modules classes → source is absent on all.
    for (const p of out.pairs) expect(p.source).toBeUndefined();
    expect(out.pairs.every((p: { source?: unknown }) => !('source' in p))).toBe(true);
  });
});

// ── The markdown routing line "code: …" in report.ts (consumer of PairSource) ──
// The differ/tool assemble source — report.ts RENDERS it from the ready object (not a re-parse).
describe('source-hint — "code: …" routing line in report_markdown', () => {
  const basePair: PairResult = {
    node_id: '1:1', label: 'card',
    rows: [{ prop: 'size.w', figma: 343, dom: 343, status: 'pass' }],
    summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
  };

  // Main lock: source {root, children[txt,scan], anchor≠root} → EXACTLY one 'code: ' line
  // with axis routing (root=gap/spacing, children listed, anchor=styles).
  it('source {root, children[txt,scan], anchor} → one "code: " line with axis routing', () => {
    const source: PairSource = {
      root: { module: 'shell.module.scss', local: 'root', raw: 'shell-module-scss-module__Rt0__root' },
      children: [
        { i: 0, name: 'txt', hint: { module: 'label.module.scss', local: 'text', raw: 'x' } },
        { i: 1, name: 'scan', hint: { module: 'scan.module.scss', local: 'wrap', raw: 'y' } },
      ],
      anchor: { module: 'button.module.scss', local: 'root', raw: 'z' },
    };
    const pair: PairResult = { ...basePair, source };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    const codeLines = md.split('\n').filter((l) => l.startsWith('code: '));
    expect(codeLines).toHaveLength(1); // EXACTLY one line
    const line = codeLines[0];
    expect(line).toContain('gap/spacing → shell.module.scss (root)');
    expect(line).toContain('txt → label.module.scss');
    expect(line).toContain('scan → scan.module.scss');
    expect(line).toContain('styles → button.module.scss'); // anchor.module !== root.module
  });

  // Mutation "render always": a pair WITHOUT source → no 'code:' line at all (RED lock).
  it('a pair WITHOUT source → no "code:" line', () => {
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [basePair] });
    expect(md).not.toContain('code:');
  });

  // Byte lock of the existing sections: the pair header + rows lines do not shift when a
  // "code: " line is added — we subtract ONLY the added code lines and get identical output.
  it('adding source does not touch the pair header/rows lines (byte lock)', () => {
    const withoutSource = renderReport({ file: 'f', tolerancePx: 1, pairs: [basePair] });
    const withSource = renderReport({ file: 'f', tolerancePx: 1, pairs: [{
      ...basePair,
      source: { root: { module: 'shell.module.scss', local: 'root', raw: 'r' } },
    }] });
    const strippedLines = withSource.split('\n').filter((l) => !l.startsWith('code: '));
    expect(strippedLines.join('\n')).toBe(withoutSource);
  });

  // note case: classList non-empty, 0 parses → "code: — (<note>)", NOT an empty/absent line.
  it('source.note → "code: — (<note>)"', () => {
    const pair: PairResult = { ...basePair, source: { note: 'minified, code address not derived' } };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).toContain('code: — (minified, code address not derived)');
  });

  // Nuance: the style_anchor row CAN be emitted without source.anchor (a carrier with no
  // classes) — the "styles → …" render is strictly by the presence of source.anchor, not by the presence of the rows line.
  it('rows carries style_anchor but source.anchor is absent → "styles →" not rendered (we do not emit emptiness)', () => {
    const pair: PairResult = {
      ...basePair,
      rows: [...basePair.rows, { prop: 'style_anchor', figma: 'div', dom: 'div', status: 'pass' }],
      source: { root: { module: 'shell.module.scss', local: 'root', raw: 'r' } }, // anchor absent
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).toContain('code: ');
    expect(md).not.toContain('styles →');
  });

  // anchor === root (same module) → "styles" does not duplicate root, the segment is suppressed.
  it('anchor.module === root.module → "styles" segment suppressed (does not duplicate root)', () => {
    const pair: PairResult = {
      ...basePair,
      source: {
        root: { module: 'shell.module.scss', local: 'root', raw: 'r' },
        anchor: { module: 'shell.module.scss', local: 'root', raw: 'r' },
      },
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).not.toContain('styles →');
    expect(md).toContain('gap/spacing → shell.module.scss (root)');
  });

  // text channel: label + module, format 'text: <label> → <module>' (format lock).
  it('source.text → segment "text: <label> → <module>"', () => {
    const pair: PairResult = {
      ...basePair,
      source: {
        root: { module: 'shell.module.scss', local: 'root', raw: 'r' },
        text: [{ label: '[tabs→"Популярное"]', hint: { module: 'seg.module.scss', local: 'label', raw: 't' } }],
      },
    };
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair] });
    expect(md).toContain('text: [tabs→"Популярное"] → seg.module.scss');
  });
});
