// mcp-server/tests/unit/layout-spec-projector.test.ts
import { describe, it, expect } from 'vitest';
import { buildLayoutSpec, MAX_SPEC_CHILDREN, MAX_NESTED_CHILDREN, MAX_TOTAL_NODES, budgetFor, collectLeafTexts } from '../../src/domain/layout-spec/projector.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { SpecChild } from '../../src/domain/layout-spec/types.js';
import { SNIPPET_CAP } from '../../src/domain/layout-spec/types.js';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });

const child = (id: string, name: string, x: number, y: number, w = 20, h = 20, extra: Partial<RawSceneNode> = {}): RawSceneNode =>
  ({ id, name, type: 'FRAME', absoluteBoundingBox: box(x, y, w, h), ...extra } as RawSceneNode);

describe('buildLayoutSpec', () => {
  it('projects rect, axis, declared auto-layout, fill hex, cornerRadius', () => {
    const raw = {
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 343, 120),
      layoutMode: 'VERTICAL', itemSpacing: 16, paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16,
      cornerRadius: 16, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
      children: [child('1:2', 'a', 16, 12), child('1:3', 'b', 16, 48)],
    } as RawSceneNode;
    const spec = buildLayoutSpec(raw);
    expect(spec.rect).toEqual({ x: 0, y: 0, w: 343, h: 120 });
    expect(spec.axis).toBe('col');
    expect(spec.autoLayout).toEqual({ gap: 16, padding: { top: 12, right: 16, bottom: 12, left: 16 } });
    expect(spec.fillHex).toBe('#ffffff');
    expect(spec.cornerRadius).toBe(16);
    expect(spec.children.map((c) => c.id)).toEqual(['1:2', '1:3']);
  });

  // Live-run p.2/p.8: a frame's overlay and three modals — DIRECT children, layoutPositioning
  // ABSOLUTE — vanished from the spec without a trace, and the truncation note ("cut by DEPTH")
  // pointed at a knob that cannot reveal them. Mirror of DomChild.outOfFlow: every enumerated
  // level carries the count of visible, non-zero-area ABSOLUTE children the flow filter dropped.
  it('counts visible ABSOLUTE children as outOfFlow at the root and on nested levels', () => {
    const raw = {
      id: '1:1', name: 'screen', type: 'FRAME', absoluteBoundingBox: box(0, 0, 400, 800), layoutMode: 'VERTICAL',
      children: [
        child('1:2', 'content', 0, 0, 400, 700, { children: [
          child('1:5', 'row', 0, 0, 400, 40),
          child('1:6', 'toast', 0, 0, 200, 40, { layoutPositioning: 'ABSOLUTE' } as Partial<RawSceneNode>)] }),
        child('1:3', 'overlay', 0, 0, 400, 800, { layoutPositioning: 'ABSOLUTE' } as Partial<RawSceneNode>),
        child('1:4', 'modal', 40, 100, 320, 500, { layoutPositioning: 'ABSOLUTE' } as Partial<RawSceneNode>),
      ],
    } as RawSceneNode;
    const spec = buildLayoutSpec(raw);
    expect(spec.outOfFlow).toBe(2);                          // overlay + modal, dropped from the root flow
    expect(spec.children.map((c) => c.id)).toEqual(['1:2']); // the filter itself is unchanged
    expect(spec.children[0].outOfFlow).toBe(1);              // the nested toast
  });
  it('a depth-terminal node still counts its ABSOLUTE children (raw is one level deeper by FETCH)', () => {
    // Adversarial-pass hole: at the projection boundary neither branch fired for a node whose
    // children are ALL out of flow — no childrenTruncated (nothing in flow) and no outOfFlow
    // (counted only in the recursion branch). The very loss class this change was written to close.
    const raw = { id: '1:1', name: 'f', type: 'FRAME', absoluteBoundingBox: box(0, 0, 200, 200), layoutMode: 'VERTICAL',
      children: [child('1:2', 'row', 0, 0, 200, 40, { children: [
        child('1:3', 'tooltip', 0, 0, 100, 30, { layoutPositioning: 'ABSOLUTE' } as Partial<RawSceneNode>)] })] } as RawSceneNode;
    const spec = buildLayoutSpec(raw, {}, { maxDepth: 1 }); // children are terminal immediately
    expect(spec.children[0].outOfFlow).toBe(1);
    expect(spec.children[0].childrenTruncated).toBeUndefined(); // nothing in flow was cut
  });

  it('invisible and zero-area ABSOLUTE children stay silent (both sides skip them without a count)', () => {
    const raw = { id: '1:1', name: 'f', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 100),
      children: [child('1:2', 'a', 0, 0),
        child('1:3', 'hidden', 0, 0, 20, 20, { layoutPositioning: 'ABSOLUTE', visible: false } as Partial<RawSceneNode>),
        child('1:4', 'flat', 0, 0, 0, 0, { layoutPositioning: 'ABSOLUTE' } as Partial<RawSceneNode>)] } as RawSceneNode;
    const spec = buildLayoutSpec(raw);
    expect(spec.outOfFlow).toBeUndefined();
  });

  it('projects strokeHex/strokeWeight/strokeBoundVar from raw.strokes', () => {
    const spec = buildLayoutSpec({ id: '1:1', name: 'n', type: 'FRAME',
      strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], strokeWeight: 2 } as any);
    expect(spec.strokeHex).toBe('#ff0000');
    expect(spec.strokeWeight).toBe(2);
  });
  it('no strokes → stroke fields undefined', () => {
    const spec = buildLayoutSpec({ id: '1:1', name: 'n', type: 'FRAME' } as any);
    expect(spec.strokeHex).toBeUndefined();
    expect(spec.strokeWeight).toBeUndefined();
  });

  it('projects root hugWidth from layoutSizingHorizontal HUG (E hug-vs-fill gate); FIXED → undefined', () => {
    const hug = buildLayoutSpec({ id: '1:1', name: 'btns', type: 'FRAME', layoutMode: 'HORIZONTAL',
      layoutSizingHorizontal: 'HUG', absoluteBoundingBox: box(0, 0, 395, 52) } as any);
    expect(hug.hugWidth).toBe(true);
    const fixed = buildLayoutSpec({ id: '1:1', name: 'btns', type: 'FRAME', layoutMode: 'HORIZONTAL',
      layoutSizingHorizontal: 'FIXED', absoluteBoundingBox: box(0, 0, 395, 52) } as any);
    expect(fixed.hugWidth).toBeUndefined();
  });

  it('projects first visible drop shadow + count + spread (REST returns spread)', () => {
    const spec = buildLayoutSpec({ id: '1:1', name: 'n', type: 'FRAME', effects: [
      { type: 'DROP_SHADOW', radius: 6, spread: 2, offset: { x: 0, y: 4 }, color: { r: 0, g: 0, b: 0, a: 0.1 } },
      { type: 'DROP_SHADOW', radius: 12, offset: { x: 0, y: 8 }, color: { r: 0, g: 0, b: 0, a: 0.2 } },
    ] } as any);
    expect(spec.shadow).toMatchObject({ inner: false, x: 0, y: 4, blur: 6, spread: 2, colorHex: '#0000001a', count: 2 });
  });
  it('omitted spread → 0 (Figma omits the default)', () => {
    const spec = buildLayoutSpec({ id: '1:1', name: 'n', type: 'FRAME',
      effects: [{ type: 'DROP_SHADOW', radius: 6, offset: { x: 0, y: 4 }, color: { r: 0, g: 0, b: 0 } }] } as any);
    expect(spec.shadow?.spread).toBe(0);
  });
  it('inner shadow → inner true', () => {
    const spec = buildLayoutSpec({ id: '1:1', name: 'n', type: 'FRAME',
      effects: [{ type: 'INNER_SHADOW', radius: 2, offset: { x: 0, y: 1 }, color: { r: 0, g: 0, b: 0 } }] } as any);
    expect(spec.shadow?.inner).toBe(true);
  });
  it('LAYER_BLUR / invisible effects ignored → shadow undefined', () => {
    const spec = buildLayoutSpec({ id: '1:1', name: 'n', type: 'FRAME', effects: [
      { type: 'LAYER_BLUR', radius: 4 }, { type: 'DROP_SHADOW', radius: 6, visible: false, color: { r: 0, g: 0, b: 0 } },
    ] } as any);
    expect(spec.shadow).toBeUndefined();
  });

  it('filters hidden / absolute / null-bbox / zero-area children; sorts by main axis', () => {
    const raw = {
      id: '1:1', name: 'row', type: 'FRAME', absoluteBoundingBox: box(0, 0, 300, 40), layoutMode: 'HORIZONTAL',
      children: [
        child('1:5', 'second', 100, 0),
        child('1:2', 'first', 10, 0),
        child('1:3', 'hidden', 50, 0, 20, 20, { visible: false }),
        child('1:4', 'badge', 200, 0, 20, 20, { layoutPositioning: 'ABSOLUTE' }),
        { id: '1:6', name: 'nobox', type: 'FRAME', absoluteBoundingBox: null } as RawSceneNode,
        child('1:7', 'spacer', 60, 0, 0, 20), // zero-area
      ],
    } as RawSceneNode;
    const spec = buildLayoutSpec(raw);
    expect(spec.children.map((c) => c.name)).toEqual(['first', 'second']);
  });

  // children-reorder: detectChildrenReorder consumes buildLayoutSpec.children
  // downstream — a regression in the in-flow boundary predicates (visible/absolute/zero-area) would
  // now AMPLIFY into false children_reorder rows on previously-invisible content, not just a silent
  // skeleton/coverage miscount. Dedicated lock (length-focused, not name-focused like the test above)
  // so the amplification concern has its own explicit guard.
  it('inFlowChildren boundary cases are locked: visible:false / layoutPositioning:ABSOLUTE / zero-area are dropped (amplification by the detector)', () => {
    const raw = {
      id: '1:1', name: 'row', type: 'FRAME', absoluteBoundingBox: box(0, 0, 300, 40), layoutMode: 'HORIZONTAL',
      children: [
        child('1:1', 'normal', 0, 0),
        child('1:2', 'hidden', 50, 0, 20, 20, { visible: false }),
        child('1:3', 'badge', 100, 0, 20, 20, { layoutPositioning: 'ABSOLUTE' }),
        child('1:4', 'spacer', 150, 0, 0, 20), // zero-area
      ],
    } as RawSceneNode;
    const spec = buildLayoutSpec(raw);
    expect(spec.children).toHaveLength(1);
    expect(spec.children[0].name).toBe('normal');
  });

  it('marks rotated node and survives null bbox on the node itself', () => {
    const spec = buildLayoutSpec({ id: '1:1', name: 'r', type: 'FRAME', rotation: 0.3, absoluteBoundingBox: null } as RawSceneNode);
    expect(spec.rotated).toBe(true);
    expect(spec.rect).toBeUndefined();
    expect(spec.children).toEqual([]);
  });

  it('caps children at MAX_SPEC_CHILDREN with childrenTruncated', () => {
    const kids = Array.from({ length: MAX_SPEC_CHILDREN + 5 }, (_, i) => child(`2:${i}`, `c${i}`, 0, i * 10));
    const spec = buildLayoutSpec({ id: '1:1', name: 'list', type: 'FRAME', layoutMode: 'VERTICAL', absoluteBoundingBox: box(0, 0, 100, 1000), children: kids } as RawSceneNode);
    expect(spec.children).toHaveLength(MAX_SPEC_CHILDREN);
    expect(spec.childrenTruncated).toBe(true);
  });

  it('extracts typography for TEXT node and TEXT children (incl. color hex, lineHeightUnit)', () => {
    const text: RawSceneNode = {
      id: '1:9', name: 'title', type: 'TEXT', absoluteBoundingBox: box(16, 12, 200, 24), characters: 'Причина',
      // letterSpacing: REST TypeStyle returns px (including fractional) — passthrough without conversion (a conscious drop of PERCENT→px)
      style: { fontFamily: 'Inter', fontWeight: 650, fontSize: 19, lineHeightPx: 24, lineHeightUnit: 'PIXELS', letterSpacing: 0.25 },
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    } as RawSceneNode;
    const spec = buildLayoutSpec(text);
    expect(spec.text).toEqual({ fontFamily: 'Inter', fontWeight: 650, fontSize: 19, lineHeightPx: 24, lineHeightUnit: 'PIXELS', letterSpacing: 0.25, colorHex: '#000000' });
    const parent = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL', absoluteBoundingBox: box(0, 0, 300, 60), children: [text] } as RawSceneNode);
    expect(parent.children[0].text?.fontSize).toBe(19);
  });

  it('projects component id+props (stripped #ids), name and setName from context', () => {
    const raw = {
      id: '1:1', name: 'item', type: 'INSTANCE', absoluteBoundingBox: box(0, 0, 343, 56),
      componentId: '5:1', componentProperties: { 'Size#123:0': { type: 'VARIANT', value: 'medium' } },
    } as RawSceneNode;
    const spec = buildLayoutSpec(raw, {
      components: { '5:1': { key: 'k1', name: 'Type=Basic', componentSetId: '4:1' } },
      setNames: new Map([['4:1', 'listItem']]),
    });
    expect(spec.component).toEqual({ id: '5:1', name: 'Type=Basic', setName: 'listItem', props: { Size: 'medium' } });
  });

  it('componentSetId present, name in neither the meta nor the fallback → setUnresolved: true (p.3a reason)', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'v', type: 'INSTANCE', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      componentId: '5:1',
    } as any, {
      components: { '5:1': { key: 'k1', name: 'Type=Basic', componentSetId: '4:1' } },
      setNames: new Map(), // resolve yielded no name
    });
    expect(spec.component).toEqual({ id: '5:1', name: 'Type=Basic', setUnresolved: true });
  });
  it('setName resolved → setUnresolved is NOT set', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'v', type: 'INSTANCE', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      componentId: '5:1',
    } as any, {
      components: { '5:1': { key: 'k1', name: 'Type=Basic', componentSetId: '4:1' } },
      setNames: new Map([['4:1', 'listItem']]),
    });
    expect(spec.component?.setUnresolved).toBeUndefined();
  });
  it('componentSetId absent (single component) → setUnresolved is NOT set', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'v', type: 'INSTANCE', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      componentId: '5:1',
    } as any, { components: { '5:1': { key: 'k1', name: 'TagChip' } }, setNames: new Map() });
    expect(spec.component?.setUnresolved).toBeUndefined();
  });

  it('projects declared child paddings; omits when none declared', () => {
    const raw: RawSceneNode = {
      id: '1:1', name: 'col', type: 'FRAME', layoutMode: 'VERTICAL', absoluteBoundingBox: box(0, 0, 300, 200),
      children: [
        child('1:2', 'padded', 0, 0, 300, 72, { layoutMode: 'VERTICAL', paddingBottom: 48 } as Partial<RawSceneNode>),
        child('1:3', 'plain', 0, 92, 300, 40),
      ],
    } as RawSceneNode;
    const spec = buildLayoutSpec(raw);
    expect(spec.children[0].paddings).toEqual({ top: 0, right: 0, bottom: 48, left: 0 });
    expect(spec.children[1].paddings).toBeUndefined();
  });

  it('auto-descends typography from a single nested TEXT (flagged), skips when ambiguous', () => {
    const textNode = (id: string, size: number): RawSceneNode => ({
      id, name: 't', type: 'TEXT', absoluteBoundingBox: box(0, 0, 100, 20), characters: 'x',
      style: { fontSize: size, fontWeight: 400 },
    } as RawSceneNode);
    const wrapOne = child('2:1', 'wrap1', 0, 0, 300, 24, { children: [textNode('2:2', 19)] });
    const wrapTwo = child('2:3', 'wrap2', 0, 40, 300, 24, { children: [textNode('2:4', 14), textNode('2:5', 16)] });
    const spec = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: box(0, 0, 300, 100), children: [wrapOne, wrapTwo] } as RawSceneNode);
    expect(spec.children[0].text?.fontSize).toBe(19);
    expect(spec.children[0].textFromNested).toBe(true);
    expect(spec.children[1].text).toBeUndefined();
    expect(spec.children[1].textFromNested).toBeUndefined();
    expect(spec.children[1].textAmbiguous).toBe(true);
  });

  it('micro: opacity < 1 projected; default y-sort when no layoutMode', () => {
    const spec = buildLayoutSpec({ id: '1:1', name: 'o', type: 'FRAME',
      absoluteBoundingBox: box(0, 0, 10, 10), opacity: 0.5 } as RawSceneNode);
    expect(spec.opacity).toBe(0.5);
    const noAxis = buildLayoutSpec({ id: '1:1', name: 'n', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 100),
      children: [child('1:3', 'lower', 0, 60), child('1:2', 'upper', 0, 10)] } as RawSceneNode);
    expect(noAxis.children.map((c) => c.name)).toEqual(['upper', 'lower']);
  });

  it('descends to a unique TEXT two hops below the child; flags uncertain/beyondCut honestly', () => {
    const text = (id: string): RawSceneNode => ({ id, name: 't', type: 'TEXT',
      absoluteBoundingBox: box(0, 0, 100, 20), characters: 'x', style: { fontSize: 19 } } as RawSceneNode);
    const emptyText: RawSceneNode = { id: 'e:1', name: 'et', type: 'TEXT',
      absoluteBoundingBox: box(0, 30, 100, 20), characters: '   ', style: { fontSize: 12 } } as RawSceneNode;
    // 2 hops: child → mid → TEXT (an empty TEXT on the 1st hop is ignored)
    const mid = child('3:2', 'mid', 0, 0, 300, 24, { children: [text('3:3')] });
    const wrapDeep = child('3:1', 'deep', 0, 0, 300, 24, { children: [mid, emptyText] });
    const spec = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: box(0, 0, 300, 100), children: [wrapDeep] } as RawSceneNode);
    expect(spec.children[0].text?.fontSize).toBe(19);
    expect(spec.children[0].textFromNested).toBe(true);
    expect(spec.children[0].textUncertain).toBeUndefined(); // there was no cut

    // found=0, but at the 2nd hop the node has children → beyondCut
    // (lvl3 — a node met at the 2nd hop from 'cut'; it itself has a child lvl4,
    // beyond the 2-hop budget — we can't look, so we honestly mark cut)
    const deeper = child('4:2', 'lvl2', 0, 0, 300, 24, { children: [child('4:3', 'lvl3', 0, 0, 300, 24,
      { children: [child('4:4', 'lvl4', 0, 0, 300, 24)] })] });
    const wrapCut = child('4:1', 'cut', 0, 0, 300, 24, { children: [deeper] });
    const spec2 = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: box(0, 0, 300, 100), children: [wrapCut] } as RawSceneNode);
    expect(spec2.children[0].text).toBeUndefined();
    expect(spec2.children[0].textBeyondCut).toBe(true);
  });

  it('projects nested children 4 levels deep (children on L1/L2/L3, absent on L4) with caps (depth 3→4)', () => {
    const l4 = child('5:5', 'l4', 0, 0, 40, 8);
    const l3 = child('5:4', 'l3', 0, 0, 50, 10, { children: [l4] });
    const l2 = child('5:3', 'l2', 0, 0, 100, 20, { children: [l3] });
    const l1 = child('5:2', 'l1', 0, 0, 200, 40, { children: [l2] });
    const spec = buildLayoutSpec({ id: '5:1', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: box(0, 0, 300, 100), children: [l1] } as RawSceneNode);
    const pl1 = spec.children[0];
    const pl2 = pl1.children?.[0];
    const pl3 = pl2?.children?.[0];
    const pl4 = pl3?.children?.[0];
    expect(pl2?.name).toBe('l2');
    expect(pl3?.name).toBe('l3');
    expect(pl4?.name).toBe('l4');
    expect(pl4?.children).toBeUndefined(); // L4 — beyond the cut, the field is absent
    expect(pl3?.children).toBeDefined();   // on L3 the field is present ([l4])
    expect(pl2?.children).toBeDefined();   // on L2 the field is present too ([l3])
  });

  it('caps nested-text scan at MAX_NESTED_CHILDREN per hop; found=1 through the cut is uncertain', () => {
    const text = child('6:2', 't', 0, 0, 100, 20, { type: 'TEXT', characters: 'x', style: { fontSize: 21 } } as Partial<RawSceneNode>);
    const filler = (i: number) => child(`6:${3 + i}`, `f${i}`, 0, (i + 1) * 10, 20, 8);
    const many = child('6:1', 'many', 0, 0, 300, 24, { children: [text, ...Array.from({ length: 15 }, (_, i) => filler(i))] });
    const spec = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: box(0, 0, 300, 100), children: [many] } as RawSceneNode);
    expect(spec.children[0].text?.fontSize).toBe(21);
    expect(spec.children[0].textFromNested).toBe(true);
    expect(spec.children[0].textUncertain).toBe(true);
  });

  it('projects fillBoundVar from a bound solid paint on the root; omits when unbound', () => {
    const bound = buildLayoutSpec({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } } }],
    } as RawSceneNode);
    expect(bound.fillHex).toBe('#ffffff');
    expect(bound.fillBoundVar).toBe('VariableID:1:2');

    const unbound = buildLayoutSpec({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    } as RawSceneNode);
    expect(unbound.fillHex).toBe('#ffffff');
    expect(unbound.fillBoundVar).toBeUndefined();
  });

  it('projects colorBoundVar from a bound solid paint on a TEXT node; omits when unbound', () => {
    const raw: RawSceneNode = {
      id: '1:9', name: 'label', type: 'TEXT', absoluteBoundingBox: box(0, 0, 100, 20), characters: 'x',
      style: { fontSize: 14 },
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:3:4' } } }],
    } as RawSceneNode;
    const spec = buildLayoutSpec(raw);
    expect(spec.text?.colorHex).toBe('#000000');
    expect(spec.text?.colorBoundVar).toBe('VariableID:3:4');

    const rawUnbound: RawSceneNode = {
      id: '1:9', name: 'label', type: 'TEXT', absoluteBoundingBox: box(0, 0, 100, 20), characters: 'x',
      style: { fontSize: 14 },
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    } as RawSceneNode;
    const specUnbound = buildLayoutSpec(rawUnbound);
    expect(specUnbound.text?.colorHex).toBe('#000000');
    expect(specUnbound.text?.colorBoundVar).toBeUndefined();
  });

  it('ignores an invisible bound paint when picking boundColor (first VISIBLE solid)', () => {
    const raw = {
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      fills: [
        { type: 'SOLID', visible: false, color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:hidden' } } },
        { type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:visible' } } },
      ],
    } as RawSceneNode;
    const spec = buildLayoutSpec(raw);
    expect(spec.fillBoundVar).toBe('VariableID:visible');
  });

  it('post-prunes a dense tree (30 roots × 3 leaves) to the total-node cap (C1 regression; widened budget — 30×2=90 no longer exceeds the raised MAX_TOTAL_NODES=90, so this needs 3 leaves/root to still overflow)', () => {
    const leaf = (id: string, y: number) => child(id, 'leaf', 0, y, 10, 10);
    const li = (i: number) => child(`li:${i}`, `li${i}`, 0, i * 30, 100, 20, {
      children: [leaf(`li:${i}:a`, i * 30), leaf(`li:${i}:b`, i * 30 + 10), leaf(`li:${i}:c`, i * 30 + 20)],
    });
    const kids = Array.from({ length: 30 }, (_, i) => li(i));
    const raw = { id: '1:1', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: box(0, 0, 300, 1000), children: kids } as RawSceneNode;
    const spec = buildLayoutSpec(raw);

    const countNodes = (list: SpecChild[] | undefined): number =>
      (list ?? []).reduce((n, c) => n + 1 + countNodes(c.children), 0);
    expect(countNodes(spec.children)).toBeLessThanOrEqual(MAX_TOTAL_NODES);

    const truncated = spec.children.filter((c) => c.childrenTruncated);
    expect(truncated.length).toBeGreaterThan(0);
    for (const c of truncated) expect(c.children).toBeUndefined();
  });

  describe('text data: textSnippet / textNode / textFixedWidth', () => {
    it('projects textSnippet on a TEXT child, collapsing whitespace runs BEFORE slicing to SNIPPET_CAP chars', () => {
      // raw must collapse to MORE than SNIPPET_CAP (120) chars — otherwise slice(0, SNIPPET_CAP) is a
      // no-op and the test stops exercising "collapse-before-slice" at all (vacuous at the raised cap).
      const raw = 'Заголовок\n\n  плашки   с большим количеством внутренних переносов и пробелов, продолжается ещё   дальше сверх ста двадцати символов для проверки капа';
      const expectedSnippet = raw.trim().replace(/\s+/g, ' ').slice(0, SNIPPET_CAP);
      const naiveSliceFirst = raw.trim().slice(0, SNIPPET_CAP).replace(/\s+/g, ' ');
      // fixture sanity: the two orders must actually diverge, otherwise this test wouldn't exercise the order
      expect(expectedSnippet).not.toBe(naiveSliceFirst);
      expect(raw.trim().replace(/\s+/g, ' ').length).toBeGreaterThan(SNIPPET_CAP); // anti-drift: collapsed form exceeds the cap

      const text = child('7:2', 't', 0, 0, 200, 24, { type: 'TEXT', characters: raw, style: { fontSize: 14 } } as Partial<RawSceneNode>);
      const spec = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: box(0, 0, 300, 100), children: [text] } as RawSceneNode);
      expect(spec.children[0].textSnippet).toBe(expectedSnippet);
      expect(spec.children[0].textSnippet).not.toBe(naiveSliceFirst);
    });

    it('omits textSnippet for an empty/whitespace-only TEXT child, and textNode/textFixedWidth for an empty TEXT root', () => {
      const emptyText = child('7:3', 'et', 0, 0, 100, 20, { type: 'TEXT', characters: '   \n  ', style: { fontSize: 12 } } as Partial<RawSceneNode>);
      const spec = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: box(0, 0, 300, 100), children: [emptyText] } as RawSceneNode);
      expect(spec.children[0].textSnippet).toBeUndefined();

      const rootEmpty = buildLayoutSpec({ id: '1:9', name: 'root-text', type: 'TEXT',
        absoluteBoundingBox: box(0, 0, 100, 20), characters: '   ', style: { fontSize: 12 }, textAutoResize: 'NONE' } as RawSceneNode);
      expect(rootEmpty.textNode).toBeUndefined();
      expect(rootEmpty.textFixedWidth).toBeUndefined();
    });

    it('omits textSnippet for a non-TEXT child even if it carries a stray characters field', () => {
      const stray = child('7:4', 'stray', 0, 0, 100, 20, { type: 'FRAME', characters: 'should not count' } as Partial<RawSceneNode>);
      const spec = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: box(0, 0, 300, 100), children: [stray] } as RawSceneNode);
      expect(spec.children[0].textSnippet).toBeUndefined();
    });

    it('projects textSnippet for a TEXT node nested at L2 (through the same projectChildren)', () => {
      const l2Text = child('7:6', 't2', 0, 0, 100, 20, { type: 'TEXT', characters: 'nested snippet text' } as Partial<RawSceneNode>);
      const l1 = child('7:5', 'wrap', 0, 0, 300, 24, { children: [l2Text] });
      const spec = buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: box(0, 0, 300, 100), children: [l1] } as RawSceneNode);
      expect(spec.children[0].children?.[0].textSnippet).toBe('nested snippet text');
    });

    it('sets textFixedWidth true for textAutoResize NONE/HEIGHT; omits for WIDTH_AND_HEIGHT/absent', () => {
      const mk = (resize?: string) => child('7:7', 't', 0, 0, 100, 20,
        { type: 'TEXT', characters: 'x', ...(resize !== undefined ? { textAutoResize: resize } : {}) } as Partial<RawSceneNode>);
      const specFor = (resize?: string) => buildLayoutSpec({ id: '1:1', name: 'p', type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: box(0, 0, 300, 100), children: [mk(resize)] } as RawSceneNode);

      expect(specFor('NONE').children[0].textFixedWidth).toBe(true);
      expect(specFor('HEIGHT').children[0].textFixedWidth).toBe(true);
      expect(specFor('WIDTH_AND_HEIGHT').children[0].textFixedWidth).toBeUndefined();
      expect(specFor(undefined).children[0].textFixedWidth).toBeUndefined();
    });

    it('sets LayoutSpec.textNode (and textFixedWidth) when the ROOT itself is a non-empty TEXT node', () => {
      const spec = buildLayoutSpec({ id: '1:9', name: 'label', type: 'TEXT',
        absoluteBoundingBox: box(0, 0, 100, 20), characters: 'root text', style: { fontSize: 14 },
        textAutoResize: 'HEIGHT' } as RawSceneNode);
      expect(spec.textNode).toBe(true);
      expect(spec.textFixedWidth).toBe(true);

      const frameRoot = buildLayoutSpec({ id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40) } as RawSceneNode);
      expect(frameRoot.textNode).toBeUndefined();
      expect(frameRoot.textFixedWidth).toBeUndefined();
    });
  });

  describe('hugWidth (transitive case): layoutSizingHorizontal HUG → SpecChild.hugWidth', () => {
    it('layoutSizingHorizontal HUG → hugWidth true on a child (any type, not just TEXT)', () => {
      const raw = { id: '1:1', name: 'row', type: 'FRAME', layoutMode: 'HORIZONTAL', absoluteBoundingBox: box(0, 0, 343, 48),
        children: [child('1:2', 'textCol', 52, 12, 291, 24, { layoutSizingHorizontal: 'HUG' } as Partial<RawSceneNode>)],
      } as RawSceneNode;
      const spec = buildLayoutSpec(raw);
      expect(spec.children[0].hugWidth).toBe(true);
    });

    it('layoutSizingHorizontal FILL/FIXED/absent → hugWidth field omitted', () => {
      const mk = (sizing?: string) => child('1:3', 'c', 0, 0, 100, 20, sizing !== undefined
        ? ({ layoutSizingHorizontal: sizing } as Partial<RawSceneNode>) : {});
      const specFor = (sizing?: string) => buildLayoutSpec({ id: '1:1', name: 'row', type: 'FRAME', layoutMode: 'HORIZONTAL',
        absoluteBoundingBox: box(0, 0, 300, 40), children: [mk(sizing)] } as RawSceneNode);

      expect(specFor('FILL').children[0].hugWidth).toBeUndefined();
      expect(specFor('FIXED').children[0].hugWidth).toBeUndefined();
      expect(specFor(undefined).children[0].hugWidth).toBeUndefined();
    });

    it('hugWidth projects on nested levels too (L1 and L2)', () => {
      const l2 = child('2:3', 'l2', 0, 0, 100, 20, { layoutSizingHorizontal: 'HUG' } as Partial<RawSceneNode>);
      const l1 = child('2:2', 'l1', 0, 0, 200, 40, { layoutSizingHorizontal: 'HUG', children: [l2] } as Partial<RawSceneNode>);
      const spec = buildLayoutSpec({ id: '2:1', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: box(0, 0, 300, 100), children: [l1] } as RawSceneNode);
      expect(spec.children[0].hugWidth).toBe(true);
      expect(spec.children[0].children?.[0].hugWidth).toBe(true);
    });
  });

  describe('honest depth-boundary childrenTruncated flag (mirror #61 DOM-side hasFlowContent)', () => {
    // minimal raw node with rect; FRAME with kids, TEXT leaf without
    const raw = (id: string, name: string, w: number, h: number, kids?: RawSceneNode[]): RawSceneNode => ({
      id, name, type: kids ? 'FRAME' : 'TEXT', absoluteBoundingBox: box(0, 0, w, h),
      ...(kids ? { children: kids } : {}),
    } as RawSceneNode);
    // robust to the exact depth of the projection cut: walk .children[0] until it runs out,
    // rather than hard-coding a link count (root→L1→L2→L3→L4 is FOUR .children[0] hops from
    // `spec`, not three — buildLayoutSpec's own root call always projects with depthLeft=3).
    const deepest = (n: { children?: SpecChild[] }): SpecChild =>
      (n.children && n.children.length ? deepest(n.children[0]) : (n as SpecChild));

    it('(a) L4 with real in-flow content below the depth boundary → childrenTruncated', () => {
      const l5 = raw('5:5', 'l5', 10, 10);
      const l4 = raw('4:4', 'l4', 40, 40, [l5]);
      const l3 = raw('3:3', 'l3', 40, 40, [l4]);
      const l2 = raw('2:2', 'l2', 40, 40, [l3]);
      const l1 = raw('1:1', 'l1', 40, 40, [l2]);
      const root = raw('0:0', 'root', 50, 50, [l1]);
      const spec = buildLayoutSpec(root);
      expect(deepest(spec).childrenTruncated).toBe(true);
    });

    it('(b) L4 genuine leaf (no children at all) → no childrenTruncated', () => {
      const l4 = raw('4:4', 'l4', 40, 8); // TEXT leaf, no children
      const l3 = raw('3:3', 'l3', 40, 40, [l4]);
      const l2 = raw('2:2', 'l2', 40, 40, [l3]);
      const l1 = raw('1:1', 'l1', 40, 40, [l2]);
      const spec = buildLayoutSpec(raw('0:0', 'root', 50, 50, [l1]));
      expect(deepest(spec).childrenTruncated).toBeUndefined();
    });

    it('(c) L4 with only absolute/hidden/zero-area children (no real in-flow content) → no childrenTruncated', () => {
      const absKid = { id: '5:5', name: 'abs', type: 'FRAME', absoluteBoundingBox: box(0, 0, 10, 10), layoutPositioning: 'ABSOLUTE' } as RawSceneNode;
      const hiddenKid = { id: '5:6', name: 'hid', type: 'FRAME', visible: false, absoluteBoundingBox: box(0, 0, 10, 10) } as RawSceneNode;
      const zeroKid = { id: '5:7', name: 'zero', type: 'FRAME', absoluteBoundingBox: box(0, 0, 0, 10) } as RawSceneNode; // zero-area (width=0)
      const l4 = raw('4:4', 'l4', 40, 40, [absKid, hiddenKid, zeroKid]);
      const l3 = raw('3:3', 'l3', 40, 40, [l4]);
      const l2 = raw('2:2', 'l2', 40, 40, [l3]);
      const l1 = raw('1:1', 'l1', 40, 40, [l2]);
      const spec = buildLayoutSpec(raw('0:0', 'root', 50, 50, [l1]));
      expect(deepest(spec).childrenTruncated).toBeUndefined();
    });

    it('auto-descend typography stays bounded by the PROJECTION depth, not a deeper fetch/peek (B4 footgun guard)', () => {
      // L4 is a plain wrapper (no own typography); its only child L5 is a real fetched TEXT
      // (simulates the Task-2 peek level). Auto-descend must NOT reach past the depth
      // boundary to steal L5's typography for L4 — that would be asymmetric with the DOM
      // side (which never captures a peek level) and produce a false-positive type match.
      const l5 = child('9:5', 't5', 0, 0, 100, 20, { type: 'TEXT', characters: 'peek text', style: { fontSize: 99 } } as Partial<RawSceneNode>);
      const l4 = child('9:4', 'l4', 0, 0, 40, 40, { children: [l5] });
      const l3 = child('9:3', 'l3', 0, 0, 40, 40, { children: [l4] });
      const l2 = child('9:2', 'l2', 0, 0, 40, 40, { children: [l3] });
      const l1 = child('9:1', 'l1', 0, 0, 40, 40, { children: [l2] });
      const spec = buildLayoutSpec({ id: '9:0', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: box(0, 0, 50, 50), children: [l1] } as RawSceneNode);
      const specL4 = deepest(spec);
      expect(specL4.text).toBeUndefined();
      expect(specL4.textFromNested).toBeUndefined();
      // honest signals fire instead of a silent wrong auto-descend
      expect(specL4.textBeyondCut).toBe(true);
      expect(specL4.childrenTruncated).toBe(true);
    });
  });

  describe('max_depth drill-down (dynamic capture depth, projector mirror)', () => {
    const buildChain = (levels: number): RawSceneNode => {
      let node = child(`dd:${levels}`, `l${levels}`, 0, 0, 40, 8);
      for (let i = levels - 1; i >= 1; i -= 1) {
        node = child(`dd:${i}`, `l${i}`, 0, 0, 40, 8, { children: [node] });
      }
      return node;
    };
    const rootWith = (levels: number): RawSceneNode => ({
      id: 'dd:0', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: box(0, 0, 300, 100), children: [buildChain(levels)],
    } as RawSceneNode);
    // spec.children[0] is L1; k-1 further .children[0] hops reach L_k.
    const nthLevel = (spec: { children: SpecChild[] }, k: number): SpecChild | undefined => {
      let cur: SpecChild | undefined = spec.children[0];
      for (let i = 1; i < k; i += 1) cur = cur?.children?.[0];
      return cur;
    };

    it('maxDepth:6 projects deeper than the default — L1..L5 keep .children, L6 is terminal (childrenTruncated, real content below)', () => {
      const spec = buildLayoutSpec(rootWith(8), {}, { maxDepth: 6 });
      expect(nthLevel(spec, 5)?.children).toBeDefined(); // L5 still has children
      const l6 = nthLevel(spec, 6);
      expect(l6?.children).toBeUndefined();        // L6 — beyond the cut, the field is absent
      expect(l6?.childrenTruncated).toBe(true);    // L7 exists below the cut — an honest flag
    });

    it('maxDepth:4 (explicit) is byte-for-byte the default (backward-compat)', () => {
      const raw = rootWith(8);
      const withDefault = buildLayoutSpec(raw);
      const withExplicit = buildLayoutSpec(raw, {}, { maxDepth: 4 });
      expect(withExplicit).toEqual(withDefault);
      const l4 = nthLevel(withDefault, 4);
      expect(l4?.children).toBeUndefined();
      expect(l4?.childrenTruncated).toBe(true);
    });

    it('maxDepth:9 clamps to 8 (byte-for-byte same as explicit maxDepth:8)', () => {
      const raw = rootWith(10);
      const clamped = buildLayoutSpec(raw, {}, { maxDepth: 9 });
      const explicit8 = buildLayoutSpec(raw, {}, { maxDepth: 8 });
      expect(clamped).toEqual(explicit8);
      const l8 = nthLevel(clamped, 8);
      expect(l8?.children).toBeUndefined();
      expect(l8?.childrenTruncated).toBe(true);
    });

    // Lower clamp symmetric with the upper one above — Math.max(1, ...)
    // in buildLayoutSpec must reject 0 and negative maxDepth the same way, not just cap at 8.
    it('maxDepth:0 clamps to 1 (byte-for-byte same as explicit maxDepth:1)', () => {
      const raw = rootWith(8);
      const clamped = buildLayoutSpec(raw, {}, { maxDepth: 0 });
      const explicit1 = buildLayoutSpec(raw, {}, { maxDepth: 1 });
      expect(clamped).toEqual(explicit1);
    });

    it('maxDepth:-3 also clamps to 1 (same as maxDepth:0/1 — Math.max floor, not Math.abs)', () => {
      const raw = rootWith(8);
      const clampedNeg = buildLayoutSpec(raw, {}, { maxDepth: -3 });
      const explicit1 = buildLayoutSpec(raw, {}, { maxDepth: 1 });
      expect(clampedNeg).toEqual(explicit1);
    });

    it('budgetFor: 4→90 (and below), 5-8→180 — 300 unreachable at maxDepth<=8', () => {
      for (const d of [1, 2, 3, 4]) expect(budgetFor(d)).toBe(90);
      for (const d of [5, 6, 7, 8]) expect(budgetFor(d)).toBe(180);
    });

    it('budget mirror wired end-to-end: maxDepth 8 raises the total-node budget so a 180-node tree fits untruncated (vs partial truncation at default maxDepth 4)', () => {
      const leaf = (id: string, y: number) => child(id, 'leaf', 0, y, 10, 10);
      const li = (i: number) => child(`bi:${i}`, `li${i}`, 0, i * 60, 100, 50, {
        children: Array.from({ length: 5 }, (_, j) => leaf(`bi:${i}:${j}`, i * 60 + j * 10)),
      });
      const kids = Array.from({ length: 30 }, (_, i) => li(i)); // 30 + 30*5 = 180 nodes total
      const raw = { id: 'b:1', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: box(0, 0, 300, 2000), children: kids } as RawSceneNode;

      const countNodes = (list: SpecChild[] | undefined): number =>
        (list ?? []).reduce((n, c) => n + 1 + countNodes(c.children), 0);

      const specDefault = buildLayoutSpec(raw); // maxDepth 4 → budget 90
      expect(specDefault.children.some((c) => c.childrenTruncated)).toBe(true);

      const specDeep = buildLayoutSpec(raw, {}, { maxDepth: 8 }); // budget 180
      expect(specDeep.children.some((c) => c.childrenTruncated)).toBe(false);
      expect(countNodes(specDeep.children)).toBe(180);
    });
  });
});

describe('ResolvedColorToken (projector resolver hook)', () => {
  const node = (): RawSceneNode => ({
    id: '1:1', name: 'Card', type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
    fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' } } }],
  } as unknown as RawSceneNode);

  it('projector attaches a resolved fill token via the injected resolver', () => {
    const spec = buildLayoutSpec(node(), {
      resolveColorToken: (_n, key) => key === 'fills'
        ? {
            token: 'neutral/bg/base',
            defaultHex: '#ffffff',
            effectiveHex: '#ffffff',
            effectiveModes: { Theme: { mode: 'Solar', source: 'explicit_node', node_id: '1:1' } },
            effectiveModeSource: 'explicit_node',
          }
        : undefined,
    });
    expect(spec.fillToken).toEqual({
      token: 'neutral/bg/base',
      defaultHex: '#ffffff',
      effectiveHex: '#ffffff',
      effectiveModes: { Theme: { mode: 'Solar', source: 'explicit_node', node_id: '1:1' } },
      effectiveModeSource: 'explicit_node',
    });
  });
});

describe('collectLeafTexts', () => {
  // list → item×2 → label(TEXT); + a deep label beyond the max_depth:4 cut
  // TWO same-named 'item' (a real list = repeating rows) — guards path disambiguation
  const raw = {
    id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 } as any,
    layoutMode: 'VERTICAL',
    children: [
      { id: '1:2', name: 'list', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 }, layoutMode: 'VERTICAL',
        children: [
          { id: '1:3', name: 'item', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 }, layoutMode: 'VERTICAL',
            children: [
              { id: '1:4', name: 'label', type: 'TEXT', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
                characters: 'Первый', style: { fontFamily: 'Inter', fontWeight: 450, fontSize: 14 } },
            ] },
          { id: '1:5', name: 'item', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 40, width: 300, height: 40 }, layoutMode: 'VERTICAL',
            children: [
              { id: '1:6', name: 'label', type: 'TEXT', absoluteBoundingBox: { x: 0, y: 40, width: 100, height: 20 },
                characters: 'Второй', style: { fontFamily: 'Inter', fontWeight: 450, fontSize: 14 } },
            ] },
        ] },
    ],
  } as any;

  it('collects genuine TEXT leaves; same-named items get DIFFERENT paths (disambiguation)', () => {
    const spec = buildLayoutSpec(raw, {}, { maxDepth: 6 });
    const { leaves, truncated } = collectLeafTexts(spec);
    const a = leaves.find((l) => l.id === '1:4');
    const b = leaves.find((l) => l.id === '1:6');
    expect(a).toMatchObject({ name: 'label', text_snippet: 'Первый' });
    expect(a?.typography).toMatchObject({ fontSize: 14, fontWeight: 450 });
    // same-named 'item' siblings are indexed; 'list'/'label' (unique on their level) — clean
    expect(a?.path).toEqual(['list', 'item[0]', 'label']);
    expect(b?.path).toEqual(['list', 'item[1]', 'label']);
    expect(a?.path).not.toEqual(b?.path); // path DISTINGUISHES the rows — the main use case the feature exists for
    expect(truncated).toBe(false);
  });

  it('depth mirror: leaves beyond the max_depth:2 cut are absent + truncated:true', () => {
    const spec = buildLayoutSpec(raw, {}, { maxDepth: 2 });
    const { leaves, truncated } = collectLeafTexts(spec);
    expect(leaves.find((l) => l.id === '1:4')).toBeUndefined();
    expect(leaves.find((l) => l.id === '1:6')).toBeUndefined();
    expect(truncated).toBe(true);
  });

  it('a node with no TEXT → an empty list, not an error', () => {
    const empty = buildLayoutSpec({ id: '9:1', name: 'box', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } } as any, {}, {});
    expect(collectLeafTexts(empty)).toEqual({ leaves: [], truncated: false });
  });
});

describe('projector truncationCause (Phase 1 — cause-gated drill safety)', () => {
  // single-child chain deep enough that max_depth 4 leaves content below the cut
  const chain = (levels: number) => {
    const mk = (id: string, kids?: any[]): any =>
      ({ id, name: id, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 8 },
         ...(kids ? { children: kids } : {}) });
    let cur = mk('L' + levels);
    for (let i = levels - 1; i >= 1; i -= 1) cur = mk('L' + i, [cur]);
    return { id: 'dd:0', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 100 }, children: [cur] } as any;
  };
  const nth = (spec: any, k: number) => {
    let cur = spec.children[0];
    for (let i = 1; i < k; i += 1) cur = cur?.children?.[0];
    return cur;
  };

  it('depth-boundary cut carries cause "depth"', () => {
    const spec = buildLayoutSpec(chain(6), {}, { maxDepth: 4 });
    const t = nth(spec, 4);
    expect(t.childrenTruncated).toBe(true);
    expect(t.truncationCause).toBe('depth');
  });

  it('top-breadth cut carries cause "breadth" (>MAX_SPEC_CHILDREN root children)', () => {
    const kids = Array.from({ length: MAX_SPEC_CHILDREN + 5 }, (_, i) =>
      ({ id: '2:' + i, name: 'c' + i, type: 'FRAME', absoluteBoundingBox: { x: 0, y: i * 10, width: 20, height: 8 } }));
    const root = { id: 'r', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 400 }, children: kids } as any;
    const spec = buildLayoutSpec(root, {}, { maxDepth: 4 });
    expect(spec.childrenTruncated).toBe(true);
    expect(spec.truncationCause).toBe('breadth');
  });

  it('nested-breadth cut carries cause "breadth" (>MAX_NESTED_CHILDREN grandchildren)', () => {
    const grand = Array.from({ length: MAX_NESTED_CHILDREN + 5 }, (_, i) =>
      ({ id: '3:' + i, name: 'g' + i, type: 'FRAME', absoluteBoundingBox: { x: 0, y: i * 10, width: 20, height: 8 } }));
    const mid = { id: '2:0', name: 'mid', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 400 }, children: grand } as any;
    const root = { id: 'r', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 400 }, children: [mid] } as any;
    const spec = buildLayoutSpec(root, {}, { maxDepth: 4 });
    expect(spec.children[0].childrenTruncated).toBe(true);
    expect(spec.children[0].truncationCause).toBe('breadth');
  });

  it('budget prune carries cause "budget"; a depth cut in the SAME tree keeps "depth" (precedence: depth never overwritten)', () => {
    // dense tree that overflows budgetFor(4)=90: 30 roots × 4 leaves each; also each leaf chain
    // continues below the depth cut so a depth cause exists somewhere.
    const leaves = (base: string) => Array.from({ length: 4 }, (_, j) =>
      ({ id: base + ':' + j, name: 'lf', type: 'FRAME', absoluteBoundingBox: { x: 0, y: j * 5, width: 10, height: 4 } }));
    const roots = Array.from({ length: 30 }, (_, i) =>
      ({ id: '2:' + i, name: 'row' + i, type: 'FRAME', layoutMode: 'VERTICAL',
        absoluteBoundingBox: { x: 0, y: i * 20, width: 100, height: 20 }, children: leaves('2:' + i) } as any));
    const root = { id: 'r', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 600 }, children: roots } as any;
    const spec = buildLayoutSpec(root, {}, { maxDepth: 4 });
    const budgetCuts = spec.children.filter((c: any) => c.childrenTruncated && c.truncationCause === 'budget');
    expect(budgetCuts.length).toBeGreaterThan(0);
    // and a depth-cut in a separate deep chain keeps 'depth' (no children → pruneToBudget skips it)
    const deep = buildLayoutSpec(chain(6), {}, { maxDepth: 4 });
    expect(nth(deep, 4).truncationCause).toBe('depth');
  });
});

describe('figmaGradient', () => {
  // A minimal node with a linear-gradient fill; a horizontal handle (0.5→0.5 on y),
  // rect 200×100 (the aspect correction below is checked on it).
  const gradNode = (over: Partial<RawSceneNode> = {}): RawSceneNode => ({
    id: '1:1', name: 'btn', type: 'FRAME',
    absoluteBoundingBox: box(0, 0, 200, 100),
    fills: [{ type: 'GRADIENT_LINEAR', visible: true,
      gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }],
      gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 1, g: 1, b: 1 } }] }],
    ...over,
  } as RawSceneNode);

  it('linear → model with aspect-corrected angle 90deg (horizontal handle)', () => {
    const g = buildLayoutSpec(gradNode(), {}).gradient!;
    expect(g.kind).toBe('linear');
    expect(g.angleDeg).toBe(90);
    expect(g.stops.map((s) => s.hex)).toEqual(['#000000', '#ffffff']);
    expect(g.whole).toEqual({ literal: true });
  });

  it('degenerate rect (h=0) → angle undefined (honest info downstream)', () => {
    const n = gradNode({ absoluteBoundingBox: box(0, 0, 200, 0) });
    expect(buildLayoutSpec(n, {}).gradient!.angleDeg).toBeUndefined();
  });

  it('DIAMOND → kind unknown (angle not computed for non-linear)', () => {
    const n = gradNode();
    (n.fills![0] as any).type = 'GRADIENT_DIAMOND';
    const g = buildLayoutSpec(n, {}).gradient!;
    expect(g.kind).toBe('unknown');
    expect(g.angleDeg).toBeUndefined();
  });

  it('bound stop → whole tokenized (paint-level marker); per-stop deferred to bound-unresolved', () => {
    const n = gradNode();
    (n.fills![0].gradientStops![0] as any).boundVariables = { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } };
    const g = buildLayoutSpec(n, {}).gradient!;
    // Figma whole — tokenized STATE, the name is NOT verified (provenance state). per-stop resolver deferred.
    expect('token' in g.whole).toBe(true);
    expect(g.stops[0].token).toEqual({ unknown: 'bound-unresolved' });
    expect(g.stops[1].token).toEqual({ literal: true });
  });

  it('gradient fill does not set fillHex (mutually exclusive for the first visible paint)', () => {
    const spec = buildLayoutSpec(gradNode(), {});
    expect(spec.gradient).toBeDefined();
    expect(spec.fillHex).toBeUndefined();
  });

  it('2 visible GRADIENT_* → multiLayer:true (mirror of DOM layers>1); 1 gradient → not set', () => {
    const second = { type: 'GRADIENT_LINEAR', visible: true,
      gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0 } }, { position: 1, color: { r: 0, g: 0, b: 1 } }] };
    const multi = gradNode();
    (multi.fills as any[]).push(second);
    expect(buildLayoutSpec(multi, {}).gradient!.multiLayer).toBe(true);
    // a single gradient — multiLayer is NOT set (the mutation "remove the count" breaks the check above)
    expect(buildLayoutSpec(gradNode(), {}).gradient!.multiLayer).toBeUndefined();
    // the invisible second gradient paint is NOT counted as a layer
    const hiddenSecond = gradNode();
    (hiddenSecond.fills as any[]).push({ ...second, visible: false });
    expect(buildLayoutSpec(hiddenSecond, {}).gradient!.multiLayer).toBeUndefined();
  });

  it('paint-level opacity multiplies into the stop alpha (mirror of solid paintValue); without opacity — no alpha octet', () => {
    const dimmed = gradNode();
    (dimmed.fills![0] as any).opacity = 0.5; // stops color.a=1 → effective alpha 0.5 → octet ~80
    const g = buildLayoutSpec(dimmed, {}).gradient!;
    expect(g.stops.map((s) => s.hex)).toEqual(['#00000080', '#ffffff80']);
    // paint without opacity → stop hex with no alpha octet (identical to before)
    expect(buildLayoutSpec(gradNode(), {}).gradient!.stops.map((s) => s.hex)).toEqual(['#000000', '#ffffff']);
  });

  // Lock aspect-angle : projector.ts aspectAngle — the `* rect.w` / `* rect.h` handle scaling.
  //   Handle coords are normalized to the bbox; multiplying by real w/h converts the direction into pixel
  //   space (what the browser actually paints). Revert (drop `* rect.w`/`* rect.h`) → the angle is measured
  //   in normalized 0..1 space and STOPS depending on aspect → a non-square rect yields the SAME angle as a
  //   square → `.not.toBe` fails. This is the load-bearing reason a Figma linear angle can be FAIL-compared.
  it('lock aspect-angle: non-square rect changes the computed angle vs a square (aspect-corrected)', () => {
    const diag = (w: number, h: number) => {
      const n = gradNode({ absoluteBoundingBox: box(0, 0, w, h) });
      (n.fills![0] as any).gradientHandlePositions = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
      return buildLayoutSpec(n, {}).gradient!.angleDeg;
    };
    expect(diag(200, 100)).not.toBe(diag(100, 100)); // aspect-correction is load-bearing
    expect(diag(100, 100)).toBe(135);                // square diagonal → 135deg (sanity anchor)
  });

  // Lock DIAMOND kind (edge) : projector.ts figmaGradient — `FIG_GRADIENT_KIND[paint.type] ?? 'unknown'`.
  //   GRADIENT_DIAMOND is deliberately ABSENT from the map → 'unknown'; and 'unknown' !== 'linear' so NO angle
  //   is computed (an angle on a non-linear geometry would be a false measurement). Revert (`?? 'linear'`) →
  //   DIAMOND is mislabeled linear AND gets an angle → this test fails.
  it('lock DIAMOND: unknown kind + angle undefined (never a false linear angle)', () => {
    const n = gradNode();
    (n.fills![0] as any).type = 'GRADIENT_DIAMOND';
    const g = buildLayoutSpec(n, {}).gradient!;
    expect(g.kind).toBe('unknown');
    expect(g.angleDeg).toBeUndefined();
  });

  describe('gradient whole flips on fill-style', () => {
    it('fill-style + literal stops → whole tokenized (state)', () => {
      const n = gradNode({}); (n as any).styles = { fill: 'S:brand' };
      // no bound stops:
      (n.fills![0] as any).gradientStops.forEach((s: any) => { delete s.boundVariables; });
      const g = buildLayoutSpec(n, {}).gradient!;
      expect('token' in g.whole).toBe(true); // was {literal:true} before the fix
    });
    it('fill-style + resolvable name → whole carries the style name', () => {
      const n = gradNode({}); (n as any).styles = { fill: 'S:brand' };
      (n.fills![0] as any).gradientStops.forEach((s: any) => { delete s.boundVariables; });
      const g = buildLayoutSpec(n, { styleNames: (id: string) => id === 'S:brand' ? 'Brand/Primary' : undefined }).gradient!;
      expect(g.whole).toEqual({ token: '(style: Brand/Primary)' });
    });
    it('NON-fill style slot (text) does NOT tokenize a literal gradient (G1 guard)', () => {
      const n = gradNode({}); (n as any).styles = { text: 'S:body' };
      (n.fills![0] as any).gradientStops.forEach((s: any) => { delete s.boundVariables; });
      expect(buildLayoutSpec(n, {}).gradient!.whole).toEqual({ literal: true });
    });
    it('no styles field → byte-identical to today (G2 no-op)', () => {
      const n = gradNode({});
      (n.fills![0] as any).gradientStops.forEach((s: any) => { delete s.boundVariables; });
      expect(buildLayoutSpec(n, {}).gradient!.whole).toEqual({ literal: true });
    });
    // Lock anyBound-precedence : projector.ts figmaGradient — the anyBound-FIRST precedence of the
    //   `whole: anyBound ? {token:'(paint)'} : (wholeToken ?? {literal})` ternary. A bound gradient stop
    //   (anyBound) coexisting with a RESOLVABLE fill-STYLE must still emit the {token:'(paint)'} anyBound
    //   sentinel — NOT the style name — because the two whole-tokenization signals collapse to a single
    //   provenance-STATE (bound var wins, the name is not compared). No prior test had BOTH a bound stop AND a
    //   resolvable fill-style at once, so this precedence was provable-but-unlocked. Revert (swap to
    //   `wholeToken ?? (anyBound ? … : …)`) → the resolvable wholeToken={token:'(style: Brand/Primary)'}
    //   short-circuits first → whole becomes the style name → this test fails.
    it('lock anyBound-precedence: bound gradient stop wins over a coexisting resolvable fill-style → whole {token:"(paint)"}', () => {
      const n = gradNode({}); (n as any).styles = { fill: 'S:brand' };
      (n.fills![0].gradientStops![0] as any).boundVariables = { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } };
      const g = buildLayoutSpec(n, { styleNames: (id: string) => id === 'S:brand' ? 'Brand/Primary' : undefined }).gradient!;
      expect(g.whole).toEqual({ token: '(paint)' });                     // anyBound sentinel wins, NOT the resolvable style name
      expect(g.stops[0].token).toEqual({ unknown: 'bound-unresolved' }); // bound stop → per-stop tokenized (whole atomic)
    });
  });

  describe('multiLayer counts image-like layers', () => {
    it('1 gradient + 1 IMAGE fill → multiLayer:true (mirrors DOM background-image layer count)', () => {
      const n = gradNode({});
      (n.fills as any[]).push({ type: 'IMAGE', visible: true, scaleMode: 'FILL', imageRef: 'x' });
      // firstVisiblePaint = the gradient (find skips IMAGE); count = gradient + image = 2
      expect(buildLayoutSpec(n, {}).gradient!.multiLayer).toBe(true);
    });
    it('1 gradient + 1 VIDEO fill → multiLayer:true', () => {
      const n = gradNode({});
      (n.fills as any[]).push({ type: 'VIDEO', visible: true });
      expect(buildLayoutSpec(n, {}).gradient!.multiLayer).toBe(true);
    });
    it('LOCK: single gradient (no image) → multiLayer undefined (not inflated)', () => {
      expect(buildLayoutSpec(gradNode({}), {}).gradient!.multiLayer).toBeUndefined();
    });
    it('gradient + hidden IMAGE → multiLayer undefined (visible-only count)', () => {
      const n = gradNode({});
      (n.fills as any[]).push({ type: 'IMAGE', visible: false, imageRef: 'x' });
      expect(buildLayoutSpec(n, {}).gradient!.multiLayer).toBeUndefined();
    });
    it('gradient + SOLID (deliberately excluded) → multiLayer undefined', () => {
      const n = gradNode({});
      (n.fills as any[]).push({ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } });
      expect(buildLayoutSpec(n, {}).gradient!.multiLayer).toBeUndefined();
    });
  });
});

describe('solid fill tokenizes on a fill-style', () => {
  const solidNode = (over: any = {}) => ({
    id: '1:2', name: 'n', type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
    fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 } }],
    ...over,
  });
  it('fill-style + resolvable name → fillToken carries the style name (NAME → branch D)', () => {
    const n = solidNode({ styles: { fill: 'S:brand' } });
    const spec = buildLayoutSpec(n, { styleNames: (id: string) => id === 'S:brand' ? 'Brand/Primary' : undefined });
    expect(spec.fillToken?.token).toBe('(style: Brand/Primary)');
  });
  it('fill-style, no name resolver → fillToken carries (paint) sentinel (STATE unifies with NAME → branch C/D)', () => {
    const n = solidNode({ styles: { fill: 'S:brand' } });
    const spec = buildLayoutSpec(n, {});
    expect(spec.fillToken).toEqual({ token: '(paint)', effectiveHex: '#ff0000' });
  });
  it('G1: non-fill slot (text style) on a literal solid fill → NOT tokenized', () => {
    const n = solidNode({ styles: { text: 'S:body' } });
    const spec = buildLayoutSpec(n, {});
    expect(spec.fillToken).toBeUndefined();
  });
  it('G2: no styles field → byte-identical (no token)', () => {
    const spec = buildLayoutSpec(solidNode(), {});
    expect(spec.fillToken).toBeUndefined();
  });
  it('bound var wins over fill-style (precedence): style path does NOT fire when a bound var is present', () => {
    const n = solidNode({ styles: { fill: 'S:brand' } });
    n.fills[0].boundVariables = { color: { id: 'V:c' } };
    const spec = buildLayoutSpec(n, { styleNames: () => 'Brand/Primary' });
    // boundColor sets fillBoundVar; style path must NOT fire → no (paint)/style token set here:
    expect(spec.fillToken).toBeUndefined();
  });
  it('lock plural-slot: plural fill slot styles.fills tokenizes (revert `?? raw.styles?.fills` → fillToken undefined → fails)', () => {
    const n = solidNode({ styles: { fills: 'S:brand' } });   // PLURAL key
    const spec = buildLayoutSpec(n, { styleNames: () => 'Brand/Primary' });
    expect(spec.fillToken?.token).toBe('(style: Brand/Primary)');
  });
});

describe('stroke tokenizes on a stroke-style', () => {
  const strokeNode = (over: any = {}) => ({
    id: '1:3', name: 's', type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
    strokes: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 1, a: 1 } }],
    strokeWeight: 1,
    ...over,
  });
  it('stroke-style + name → strokeToken carries name', () => {
    const spec = buildLayoutSpec(strokeNode({ styles: { stroke: 'S:line' } }), { styleNames: () => 'Border/Default' });
    expect(spec.strokeToken?.token).toBe('(style: Border/Default)');
  });
  it('stroke-style, no name → strokeToken carries (paint) sentinel (STATE unifies with NAME)', () => {
    expect(buildLayoutSpec(strokeNode({ styles: { stroke: 'S:line' } }), {}).strokeToken).toEqual({ token: '(paint)', effectiveHex: '#0000ff' });
  });
  it('G1: fill-slot style does NOT tokenize the stroke', () => {
    expect(buildLayoutSpec(strokeNode({ styles: { fill: 'S:brand' } }), {}).strokeToken).toBeUndefined();
  });
  it('lock plural-slot: plural stroke slot styles.strokes tokenizes (revert `?? raw.styles?.strokes` → strokeToken undefined → fails)', () => {
    const n = strokeNode({ styles: { strokes: 'S:line' } });  // PLURAL key
    expect(buildLayoutSpec(n, { styleNames: () => 'Border/Default' }).strokeToken?.token).toBe('(style: Border/Default)');
  });
});

describe('text color tokenizes on a fill-style (text-color = fill slot)', () => {
  const textNode = (over: any = {}) => ({
    id: '1:4', name: 't', type: 'TEXT', characters: 'hi',
    absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
    style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 },
    fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } }],
    ...over,
  });
  it('text fill-style + name → colorToken carries name', () => {
    const spec = buildLayoutSpec(textNode({ styles: { fill: 'S:ink' } }), { styleNames: () => 'Text/Primary' });
    expect(spec.text?.colorToken?.token).toBe('(style: Text/Primary)');
  });
  it('text fill-style, no name → colorToken carries (paint) sentinel (STATE unifies with NAME)', () => {
    expect(buildLayoutSpec(textNode({ styles: { fill: 'S:ink' } }), {}).text?.colorToken).toEqual({ token: '(paint)', effectiveHex: '#000000' });
  });
  it('G1: typography (text-slot) style does NOT tokenize the color', () => {
    const spec = buildLayoutSpec(textNode({ styles: { text: 'S:heading' } }), {});
    expect(spec.text?.colorToken).toBeUndefined();
  });
});

describe('salvage-nested: leaf-TEXT invariant', () => {
  it('phase-0 scope invariant (salvage-nested): textSnippet is set ONLY on leaf TEXT', () => {
    // The phase-0 eligibility boundary (figText(f)===undefined) silently depends on "textSnippet ⟺ leaf-TEXT".
    // We build a spec with TEXT deep inside containers and assert the invariant over the WHOLE tree.
    const raw = {
      id: '1:0', name: 'root', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
      children: [
        { id: '1:1', name: 'card', type: 'INSTANCE', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 100 },
          children: [
            { id: '1:2', name: 'title', type: 'TEXT', characters: 'Заголовок карточки',
              absoluteBoundingBox: { x: 8, y: 8, width: 280, height: 20 } },
            { id: '1:3', name: 'row', type: 'FRAME', absoluteBoundingBox: { x: 8, y: 40, width: 280, height: 40 },
              children: [{ id: '1:4', name: 'price', type: 'TEXT', characters: '299 ₽',
                absoluteBoundingBox: { x: 8, y: 44, width: 60, height: 18 } }] },
          ] },
      ],
    } as unknown as RawSceneNode;
    const s = buildLayoutSpec(raw, { components: {}, setNames: new Map() }, { maxDepth: 8 });
    const walk = (c: { textSnippet?: string; children?: unknown[] }): void => {
      if (c.textSnippet !== undefined) expect(c.children ?? []).toHaveLength(0);
      for (const k of (c.children ?? []) as { textSnippet?: string; children?: unknown[] }[]) walk(k);
    };
    walk(s as unknown as { textSnippet?: string; children?: unknown[] });
    // sanity anti-vacuum: snippets really are collected on the leaves
    const snippets: string[] = [];
    const collect = (c: { textSnippet?: string; children?: unknown[] }): void => {
      if (c.textSnippet !== undefined) snippets.push(c.textSnippet);
      for (const k of (c.children ?? []) as { textSnippet?: string; children?: unknown[] }[]) collect(k);
    };
    collect(s as unknown as { textSnippet?: string; children?: unknown[] });
    expect(snippets).toContain('299 ₽');
  });
});

// ── NODE-level boundVariables (feedback 15/15.1): a fill bound at the NODE level (not on the
// paint) previously projected NO fillBoundVar → colorVerdict saw a raw literal → false FAIL over
// correct code. Both binding forms must yield the same spec.
describe('node-level boundVariables → *BoundVar projected', () => {
  it('fill bound at the node level (no paint-level binding) → fillBoundVar set', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
      boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } },
    } as RawSceneNode);
    expect(spec.fillHex).toBe('#ffffff');
    expect(spec.fillBoundVar).toBe('VariableID:1:2');
  });
  it('paint-level binding wins over node-level when both present (nearest to the paint)', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:5:5' } } }],
      boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } },
    } as RawSceneNode);
    expect(spec.fillBoundVar).toBe('VariableID:5:5');
  });
  it('stroke bound at the node level → strokeBoundVar set; TEXT color bound at the node level → colorBoundVar set', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      strokes: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }],
      boundVariables: { strokes: { type: 'VARIABLE_ALIAS', id: 'VariableID:7:8' } },
    } as RawSceneNode);
    expect(spec.strokeBoundVar).toBe('VariableID:7:8');
    const text = buildLayoutSpec({
      id: '2:1', name: 't', type: 'TEXT', absoluteBoundingBox: box(0, 0, 100, 20),
      characters: 'x', style: { fontSize: 14 },
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
      boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:7:9' }] },
    } as unknown as RawSceneNode);
    expect(text.text?.colorBoundVar).toBe('VariableID:7:9');
  });
});

// ── Paint opacity × resolved token hex (feedback 15.1 class): the RAW path multiplies paint
// opacity into the hex alpha (simplify.ts paintValue), the token path did not — a bound fill at
// paint opacity 0.5 made fillToken.hex opaque, hex comparison against the DOM rgba diverged, and
// colorVerdict emitted FAIL over correct code. Same defect was fixed for gradient stops
// (figmaGradient paintOpacity) and never carried to the solid meet points.
describe('paint opacity is multiplied into the resolved token hex', () => {
  const resolver = () => ({ token: 'brand/red', effectiveHex: '#ff0000', all_modes: { Solar: '#ff0000', Lunar: '#00ff00' } });
  it('fill: opacity 0.5 → fillToken.hex carries the alpha octet; all_modes multiplied too; fillHex (raw) already has it', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } } }],
    } as RawSceneNode, { resolveColorToken: resolver });
    expect(spec.fillHex).toBe('#ff000080');
    expect(spec.fillToken?.effectiveHex).toBe('#ff000080');
    expect(spec.fillToken?.all_modes).toEqual({ Solar: '#ff000080', Lunar: '#00ff0080' });
  });
  it('CONTROL fill: opacity 1 (or absent) → resolved hex unchanged, no alpha octet appended', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } } }],
    } as RawSceneNode, { resolveColorToken: resolver });
    expect(spec.fillToken?.effectiveHex).toBe('#ff0000');
    expect(spec.fillToken?.all_modes).toEqual({ Solar: '#ff0000', Lunar: '#00ff00' });
  });
  it('stroke and TEXT color: same multiplication at their meet points', () => {
    const spec = buildLayoutSpec({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 100, 40),
      strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.25, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:3:4' } } }],
    } as RawSceneNode, { resolveColorToken: () => ({ token: 'stroke/x', effectiveHex: '#ff0000' }) });
    expect(spec.strokeToken?.effectiveHex).toBe('#ff000040');
    const text = buildLayoutSpec({
      id: '2:1', name: 't', type: 'TEXT', absoluteBoundingBox: box(0, 0, 100, 20),
      characters: 'x', style: { fontSize: 14 },
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:5:6' } } }],
    } as RawSceneNode, { resolveColorToken: () => ({ token: 'text/x', effectiveHex: '#000000' }) });
    expect(text.text?.colorToken?.effectiveHex).toBe('#00000080');
  });
});
