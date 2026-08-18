import { describe, it, expect } from 'vitest';
import { simplify } from '../../src/domain/design-context/simplify.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { ResolvedToken } from '../../src/domain/design-context/resolved-token.js';

const card: RawSceneNode = {
  id: '1:1', name: 'Card', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 120 },
  layoutMode: 'VERTICAL', itemSpacing: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12,
  primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'MIN',
  cornerRadius: 8,
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
  children: [
    { id: '1:2', name: 'Title', type: 'TEXT', characters: 'Hello',
      style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 18, lineHeightPx: 24 },
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] },
    { id: '1:3', name: 'Avatar', type: 'INSTANCE', componentId: 'C:9',
      componentProperties: { Size: { type: 'VARIANT', value: 'M' } } },
  ],
};

describe('simplify', () => {
  it('extracts layout, fill ref, corner radius, size', () => {
    const { node, globalVars } = simplify(card);
    expect(node.size).toEqual({ w: 200, h: 120 });
    expect(node.layout).toEqual({ mode: 'col', gap: 8, padding: '12 16 12 16', primaryAlign: 'CENTER', counterAlign: 'MIN' });
    expect(node.cornerRadius).toBe(8);
    expect(node.fill).toBe('fill_0');
    expect(globalVars['fill_0']).toBe('#ffffff');
  });

  it('extracts text + interns text style', () => {
    const { node, globalVars } = simplify(card);
    const title = node.children![0];
    expect(title.text).toBe('Hello');
    expect(title.textStyle).toBe('text_0');
    expect(globalVars['text_0']).toMatchObject({ fontFamily: 'Inter', fontSize: 18, fontWeight: 600 });
    expect(title.fill).toBe('fill_1'); // black, distinct from card white
  });

  it('captures component instance id + props', () => {
    const { node } = simplify(card);
    const avatar = node.children![1];
    expect(avatar.component).toEqual({ id: 'C:9', props: { Size: 'M' } });
  });

  it('dedups identical fills across nodes into one ref', () => {
    const two: RawSceneNode = { id: '0', name: 'r', type: 'FRAME', children: [
      { id: 'a', name: 'a', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
      { id: 'b', name: 'b', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
    ] };
    const { node, globalVars } = simplify(two);
    expect(node.children![0].fill).toBe(node.children![1].fill);
    expect(Object.keys(globalVars)).toHaveLength(1);
  });

  it('skips invisible nodes', () => {
    const n: RawSceneNode = { id: '0', name: 'r', type: 'FRAME', children: [
      { id: 'h', name: 'hidden', type: 'RECTANGLE', visible: false },
      { id: 'v', name: 'shown', type: 'RECTANGLE' },
    ] };
    const { node } = simplify(n);
    expect(node.children).toHaveLength(1);
    expect(node.children![0].name).toBe('shown');
  });

  it('multiplies paint opacity into color alpha', () => {
    const n: RawSceneNode = {
      id: '0', name: 'r', type: 'RECTANGLE',
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.5 }],
    };
    const { node, globalVars } = simplify(n);
    expect(globalVars[node.fill!]).toBe('#00000080'); // 0.5 alpha → 0x80
  });

  it('captures min/max width/height constraints on an auto-layout node', () => {
    const n: RawSceneNode = {
      id: '0', name: 'r', type: 'FRAME', layoutMode: 'HORIZONTAL',
      minWidth: 100, maxWidth: 400, minHeight: 40, maxHeight: null,
    };
    const { node } = simplify(n);
    expect(node.layout).toMatchObject({ mode: 'row', minW: 100, maxW: 400, minH: 40 });
    expect(node.layout).not.toHaveProperty('maxH');
  });

  it('carries the applied text-style name into the interned textStyle', () => {
    const n: RawSceneNode = {
      id: '0', name: 't', type: 'TEXT', characters: 'Hi',
      style: { styleName: 'body1/regular 16_24', fontFamily: 'Inter', fontWeight: 400, fontSize: 16, lineHeightPx: 24 },
    };
    const { node, globalVars } = simplify(n);
    expect(globalVars[node.textStyle!]).toMatchObject({ styleName: 'body1/regular 16_24', fontSize: 16 });
  });

  it('resolves a stroke-bound variable to its token name when a resolver is given', () => {
    const n = {
      id: '0', name: 'r', type: 'RECTANGLE',
      strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 2,
      boundVariables: { strokes: { type: 'VARIABLE_ALIAS', id: 'V:9' } },
    } as import('../../src/domain/figma-raw.js').RawSceneNode;
    const { node } = simplify(n, { resolveToken: (_bv, key) => (key === 'strokes' ? 'color/border' : null) });
    expect(node.stroke).toBe('color/border');
    expect(node.strokeWeight).toBe(2);
  });

  it('interns a mode-resolved stroke token object into globalVars', () => {
    const n = {
      id: '0', name: '24/Stroke/menu', type: 'VECTOR',
      strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
      boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:1' }] },
    } as import('../../src/domain/figma-raw.js').RawSceneNode;
    const token: ResolvedToken = {
      token: 'text color/accent',
      value: '#8b6afb',
      default_value: '#a73afd',
      effective_rendered_value: '#8b6afb',
      effective_modes: { Theme: { mode: 'Dusk', source: 'explicit_node', node_id: '0' } },
      effective_mode_source: 'explicit_node',
      mode_dependent: true,
    };
    const { node, globalVars } = simplify(n, { resolveTokenMode: (nd, key) => (key === 'strokes' && nd.id === '0' ? token : null) });
    expect(node.stroke).toBe('fill_0');
    expect(globalVars['fill_0']).toEqual(token);
    expect(node.strokeWeight).toBe(1.5);
  });

  describe('truncatedChildCounts (Figma-depth-boundary truncation signal)', () => {
    // root(0) -> mid(1) -> deep(2), deep has one visible child `cut` at depth 3. This is the
    // UNPRUNED shape simplify would have seen with the old maxDepth option; the caller (the tool)
    // now prunes `deep`'s children away itself and passes the count via truncatedChildCounts, so
    // simplify only ever sees `prunedTree` below plus the recorded map.
    const deepTree: RawSceneNode = {
      id: 'root', name: 'root', type: 'FRAME',
      children: [
        { id: 'mid', name: 'mid', type: 'FRAME', children: [
          { id: 'deep', name: 'deep', type: 'FRAME', children: [
            { id: 'cut', name: 'cut', type: 'RECTANGLE',
              fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
          ] },
        ] },
      ],
    };
    // The caller-pruned equivalent: 'deep' already has no children of its own — only the recorded
    // count in truncatedChildCounts says one was cut.
    const prunedTree: RawSceneNode = {
      id: 'root', name: 'root', type: 'FRAME',
      children: [
        { id: 'mid', name: 'mid', type: 'FRAME', children: [
          { id: 'deep', name: 'deep', type: 'FRAME' },
        ] },
      ],
    };

    it('a node present in truncatedChildCounts (children already pruned by the caller) is marked truncated+childCount, no children key, and its cut descendants never reach globalVars', () => {
      const { node, globalVars } = simplify(prunedTree, { truncatedChildCounts: new Map([['deep', 1]]) });
      const mid = node.children![0];
      const deep = mid.children![0];
      expect(deep.id).toBe('deep');
      expect(deep.truncated).toBe(true);
      expect(deep.childCount).toBe(1);
      expect(deep.children).toBeUndefined();
      // The cut child isn't even present in `raw` anymore (caller pruned it) — this also proves
      // simplify never re-derives the count from raw.children, only from the map.
      expect(Object.keys(globalVars)).toHaveLength(0);
    });

    it('a node NOT present in truncatedChildCounts (genuinely empty, or well within depth) is NOT truncated, no childCount', () => {
      const tree: RawSceneNode = {
        id: 'root', name: 'root', type: 'FRAME',
        children: [{ id: 'empty', name: 'empty', type: 'FRAME', children: [] }],
      };
      const { node } = simplify(tree, { truncatedChildCounts: new Map() });
      const empty = node.children![0];
      expect(empty.truncated).toBeUndefined();
      expect(empty.childCount).toBeUndefined();
    });

    it('truncatedChildCounts undefined -> behavior unchanged (full recursion, no truncated marks)', () => {
      const { node, globalVars } = simplify(deepTree);
      const mid = node.children![0];
      const deep = mid.children![0];
      const cut = deep.children![0];
      expect(cut.id).toBe('cut');
      expect(deep.truncated).toBeUndefined();
      expect(deep.childCount).toBeUndefined();
      expect(Object.keys(globalVars)).toHaveLength(1); // cut's fill WAS interned
    });
  });
});
