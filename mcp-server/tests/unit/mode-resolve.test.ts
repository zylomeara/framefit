import { describe, it, expect } from 'vitest';
import { collectSubtreeModes, collectSubtreeChains, effectiveMode, ancestorModes, buildModeByCollection, buildExactModeEvidence, buildGraphModeEvidence, modeIds, hasBoundPaintColor, ancestorChainFromSubtree, hasExternalBoundPaintColor, collectExternalPaintKeys, pickDescentCandidates, boxIntersects, sceneIdEquals } from '../../src/domain/mode-resolve.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const tree: RawSceneNode = {
  id: 'F', name: 'Screen', type: 'FRAME', explicitVariableModes: { C: 'm2' },
  children: [
    { id: 'A', name: 'Header', type: 'FRAME',
      children: [{ id: 'L', name: '24/Stroke/menu', type: 'VECTOR' }] },
    { id: 'B', name: 'Override', type: 'FRAME', explicitVariableModes: { C: 'm1' },
      children: [{ id: 'L2', name: 'inner', type: 'VECTOR' }] },
  ],
};

describe('mode-resolve', () => {
  it('inherits an ancestor explicit mode down the subtree', () => {
    const m = collectSubtreeModes(tree);
    expect(m.get('L')!.get('C')).toBe('m2'); // inherited from Screen
    expect(m.get('L2')!.get('C')).toBe('m1'); // overridden on B
  });

  it('gives each subtree node a distinct stack instance (no aliasing) while inheriting', () => {
    const parentWithLeaves: RawSceneNode = {
      id: 'F', name: 'Screen', type: 'FRAME', explicitVariableModes: { C: 'm2' },
      children: [
        { id: 'L1', name: 'leaf1', type: 'VECTOR' },
        { id: 'L2', name: 'leaf2', type: 'VECTOR' },
      ],
    };
    const out = collectSubtreeModes(parentWithLeaves);
    // Distinct instances: mutating one leaf's stack must never corrupt a sibling.
    expect(out.get('L1')).not.toBe(out.get('L2'));
    expect(out.get('L1')).not.toBe(out.get('F'));
    // Inheritance still intact: both leaves resolve C to the parent's mode.
    expect(out.get('L1')!.get('C')).toBe('m2');
    expect(out.get('L2')!.get('C')).toBe('m2');
  });

  it('effectiveMode reports node vs default source', () => {
    const m = collectSubtreeModes(tree);
    expect(effectiveMode(m.get('L')!, 'C', 'm0')).toEqual({ modeId: 'm2', source: 'node' });
    expect(effectiveMode(new Map(), 'C', 'm0')).toEqual({ modeId: 'm0', source: 'default' });
  });

  it('effectiveMode returns null when neither stack hit nor default is present', () => {
    expect(effectiveMode(new Map(), 'C', undefined)).toBeNull();
  });

  it('ancestorModes folds root->parent with deeper override', () => {
    const stack = ancestorModes([
      { id: 'R', name: 'Page', type: 'CANVAS', explicitVariableModes: { C: 'm2' } },
      { id: 'X', name: 'mid', type: 'FRAME', explicitVariableModes: { C: 'm1' } },
    ]);
    expect(stack.get('C')).toBe('m1');
  });
});

describe('buildModeByCollection (nearest-ancestor-wins, de-duped by library key)', () => {
  // The graph resolver matches a collection by LIBRARY KEY and, on the lib-key fallback,
  // returns the FIRST map-order entry. When two ancestor levels set the SAME library
  // collection under DIFFERENT subscribed-instance id suffixes, the NEAREST ancestor's
  // mode must win — and be first in map order so the resolver picks it.
  const LIBKEY = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  const pageColl = `VariableCollectionId:${LIBKEY}/34:56`;   // subscribed instance on the page
  const frameColl = `VariableCollectionId:${LIBKEY}/9999:1`;    // a different instance on a nearer frame

  it('keeps the nearest ancestor mode when the same library collection is set at two levels', () => {
    // root -> parent order: PAGE (shallowest) sets Lunar, nearer FRAME sets Solar.
    const stack = buildModeByCollection([
      { id: 'PAGE', name: 'Page', type: 'CANVAS', explicitVariableModes: { [pageColl]: '12:0' } },   // Lunar
      { id: 'FRAME', name: 'Sub', type: 'FRAME', explicitVariableModes: { [frameColl]: '34:0' } },   // Solar (nearest)
    ]);
    // Exactly one entry for the library key, and it carries the NEAREST (Solar) mode id.
    const entries = [...stack].filter(([k]) => k.includes(LIBKEY));
    expect(entries.length).toBe(1);
    expect(entries[0][1]).toBe('34:0');
    // Nearest entry is first in map order (so the resolver's first-match lib-key fallback picks it).
    expect([...stack.keys()][0]).toContain(LIBKEY);
  });

  it('exact-id override still keeps the nearest mode for the same full collection id', () => {
    const stack = buildModeByCollection([
      { id: 'PAGE', name: 'Page', type: 'CANVAS', explicitVariableModes: { [pageColl]: '12:0' } },
      { id: 'FRAME', name: 'Sub', type: 'FRAME', explicitVariableModes: { [pageColl]: '34:0' } },
    ]);
    expect(stack.get(pageColl)).toBe('34:0');
  });

  it('unrelated collections from different levels all survive', () => {
    const stack = buildModeByCollection([
      { id: 'PAGE', name: 'Page', type: 'CANVAS', explicitVariableModes: { A: 'a1' } },
      { id: 'FRAME', name: 'Sub', type: 'FRAME', explicitVariableModes: { B: 'b1' } },
    ]);
    expect(stack.get('A')).toBe('a1');
    expect(stack.get('B')).toBe('b1');
  });
});

describe('mode evidence provenance', () => {
  const LIBKEY = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  const rootColl = `VariableCollectionId:${LIBKEY}/1:1`;
  const parentColl = `VariableCollectionId:${LIBKEY}/2:2`;
  const chain: RawSceneNode[] = [
    { id: 'ROOT', name: 'Root', type: 'FRAME', explicitVariableModes: { [rootColl]: 'root-mode', C: 'root-c' } },
    { id: 'FRAME', name: 'Frame', type: 'FRAME', explicitVariableModes: { [parentColl]: 'parent-mode', B: 'b2' } },
    { id: 'ILEAF', name: 'Leaf', type: 'RECTANGLE', explicitVariableModes: { A: 'a2' } },
  ];

  it('preserves exact collection provenance and classifies the compound-safe target pin', () => {
    const evidence = buildExactModeEvidence(chain, 'LEAF');
    expect(evidence.get('A')).toEqual({ modeId: 'a2', source: 'explicit_node', nodeId: 'ILEAF' });
    expect(evidence.get('B')).toEqual({ modeId: 'b2', source: 'ancestor_chain', nodeId: 'FRAME' });
    expect(evidence.has('ABSENT')).toBe(false);
    expect(modeIds(evidence)).toEqual(new Map([['C', 'root-c'], [rootColl, 'root-mode'], [parentColl, 'parent-mode'], ['B', 'b2'], ['A', 'a2']]));
  });

  it('de-duplicates graph collections by library key with the nearest carrier winning', () => {
    const evidence = buildGraphModeEvidence(chain, 'LEAF');
    expect(evidence.has(rootColl)).toBe(false);
    expect(evidence.get(parentColl)).toEqual({ modeId: 'parent-mode', source: 'ancestor_chain', nodeId: 'FRAME' });
    expect(evidence.get('A')).toEqual({ modeId: 'a2', source: 'explicit_node', nodeId: 'ILEAF' });
  });
});

describe('collectSubtreeChains + buildModeByCollection (within-subtree nearest-wins by library key)', () => {
  // WITHIN a subtree, collectSubtreeModes folds by EXACT id, so two subscribed-instance suffixes of
  // the SAME library collection set at two levels BOTH survive → the graph resolver's lib-key
  // first-match could pick the shallower one. Lib-key-folding the ORDERED chain instead keeps only
  // the DEEPER (nearest) node's mode, first in map order.
  const LIBKEY = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  const rootColl = `VariableCollectionId:${LIBKEY}/34:56`;   // shallower: request root
  const deepColl = `VariableCollectionId:${LIBKEY}/8888:2`;     // deeper: inner frame (nearest to leaf)

  const tree: RawSceneNode = {
    id: 'ROOT', name: 'Header', type: 'FRAME', explicitVariableModes: { [rootColl]: '12:0' },   // Lunar
    children: [
      { id: 'INNER', name: 'Sub', type: 'FRAME', explicitVariableModes: { [deepColl]: '34:0' },  // Solar
        children: [{ id: 'LEAF', name: 'Union', type: 'VECTOR' }] },
    ],
  };

  it('returns the ordered [root … node] chain per node', () => {
    const chains = collectSubtreeChains(tree);
    expect(chains.get('LEAF')!.map((n) => n.id)).toEqual(['ROOT', 'INNER', 'LEAF']);
    expect(chains.get('ROOT')!.map((n) => n.id)).toEqual(['ROOT']);
  });

  it('deeper subtree level wins the library key, first in map order', () => {
    const chains = collectSubtreeChains(tree);
    const stack = buildModeByCollection(chains.get('LEAF')!);   // root→node order
    const entries = [...stack].filter(([k]) => k.includes(LIBKEY));
    expect(entries.length).toBe(1);
    expect(entries[0][1]).toBe('34:0');                      // Solar (deeper INNER), not Lunar
    expect([...stack.keys()][0]).toContain(LIBKEY);            // nearest entry is first for the lib-key scan
  });
});

// helper fixture: a node with an optional bound-SOLID fill
const bound = (id: string, extra: Partial<RawSceneNode> = {}): RawSceneNode => ({
  id, name: id, type: 'FRAME',
  fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' } } }],
  ...extra,
} as RawSceneNode);
const plain = (id: string, children?: RawSceneNode[]): RawSceneNode => ({ id, name: id, type: 'FRAME', ...(children ? { children } : {}) } as RawSceneNode);

describe('hasBoundPaintColor — gate-on-demand discovery', () => {
  it('bound-SOLID fill at the root → true', () => { expect(hasBoundPaintColor(bound('1:1'))).toBe(true); });
  it('bound-SOLID stroke deep in the subtree → true', () => {
    const deep = plain('1:1', [plain('1:2', [{ ...plain('1:3'), strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' } } }] } as RawSceneNode])]);
    expect(hasBoundPaintColor(deep)).toBe(true);
  });
  it('MUTATION LOCK L2-imp: an invisible ROOT with a bound-fill → true (the projector resolves fills of an invisible node; a self-gate on node.visible is forbidden)', () => {
    expect(hasBoundPaintColor(bound('1:1', { visible: false } as Partial<RawSceneNode>))).toBe(true);
  });
  it('paint-level visible:false does NOT count (mirror of tool.ts:189 p.visible !== false)', () => {
    const n = { ...plain('1:1'), fills: [{ type: 'SOLID', visible: false, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' } } }] } as RawSceneNode;
    expect(hasBoundPaintColor(n)).toBe(false);
  });
  it('a bound-GRADIENT stop WITHOUT a bound-SOLID → false (the predicate is exactly SOLID fills/strokes, not collectNodeVariableIds)', () => {
    const n = { ...plain('1:1'), fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:2:2' } } }] }] } as RawSceneNode;
    expect(hasBoundPaintColor(n)).toBe(false);
  });
  it('unbound SOLID / empty tree → false', () => {
    expect(hasBoundPaintColor({ ...plain('1:1'), fills: [{ type: 'SOLID' }] } as RawSceneNode)).toBe(false);
    expect(hasBoundPaintColor(plain('1:1', [plain('1:2')]))).toBe(false);
  });
});

describe('ancestorChainFromSubtree — the document chain', () => {
  const tree = plain('F', [plain('A', [plain('B', [plain('T')])]), plain('X')]);
  it('root→parent chain for a deep target', () => {
    expect(ancestorChainFromSubtree(tree, 'T')!.map((n) => n.id)).toEqual(['F', 'A', 'B']);
  });
  it('target === root → [] (located, no ancestors inside the subtree)', () => {
    expect(ancestorChainFromSubtree(tree, 'F')).toEqual([]);
  });
  it('target absent (beyond the slice) → undefined', () => {
    expect(ancestorChainFromSubtree(tree, 'ZZ:9')).toBeUndefined();
  });
  it('MUTATION LOCK L1-min-2: a compound without the leading I finds the I-form of raw (normalized match)', () => {
    const t2 = plain('F', [plain('A', [{ ...plain('I12:1;5:5') }])]);
    expect(ancestorChainFromSubtree(t2, '12:1;5:5')!.map((n) => n.id)).toEqual(['F', 'A']);
  });
  it('plain ids do NOT collapse under the normalized match (12:1 ≠ I12:1;5:5)', () => {
    const t3 = plain('F', [plain('12:1')]);
    expect(ancestorChainFromSubtree(t3, '12:1;5:5')).toBeUndefined();
  });
  it('MUTATION LOCK on the want side: a targetId WITH a leading I also finds the I-form of raw (stripI is mandatory on BOTH sides — the calling tool passes pairId as-is)', () => {
    const t4 = plain('F', [plain('A', [{ ...plain('I12:1;5:5') }])]);
    expect(ancestorChainFromSubtree(t4, 'I12:1;5:5')!.map((n) => n.id)).toEqual(['F', 'A']);
  });
});

describe('hasExternalBoundPaintColor — graph/snapshot-fallback gate (external = id with a published key)', () => {
  const ext = (id: string) => ({ ...plain(id), fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1:2' } } }] } as RawSceneNode);
  it('external bound-SOLID (40-hex key in the id) → true', () => { expect(hasExternalBoundPaintColor(ext('1:1'))).toBe(true); });
  it('a LOCAL bound-SOLID (id without a key) → false — MUTATION LOCK (the gate does not burn discovery on locals)', () => {
    expect(hasExternalBoundPaintColor(bound('1:1'))).toBe(false);   // bound() binds VariableID:9:9
  });
  it('external deep in the subtree → true; empty → false', () => {
    expect(hasExternalBoundPaintColor(plain('1:1', [ext('1:2')]))).toBe(true);
    expect(hasExternalBoundPaintColor(plain('1:1', [plain('1:2')]))).toBe(false);
  });
  it('paint-level visible:false does NOT count (mirror of the predicate)', () => {
    const n = { ...plain('1:1'), fills: [{ type: 'SOLID', visible: false, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1:2' } } }] } as RawSceneNode;
    expect(hasExternalBoundPaintColor(n)).toBe(false);
  });
  it('MUTATION LOCK on the strokes branch: an external bound-SOLID STROKE deep in the subtree → true (all ext() fixtures bind fills — without this the "fills only" mutation stayed green)', () => {
    const deep = plain('1:1', [plain('1:2', [{ ...plain('1:3'), strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1:2' } } }] } as RawSceneNode])]);
    expect(hasExternalBoundPaintColor(deep)).toBe(true);
  });
});

describe('collectExternalPaintKeys — paint-level published-key collector (snapshot-prefetch input)', () => {
  const ext = (id: string, key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') => ({ ...plain(id), fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: `VariableID:${key}/1:2` } } }] } as RawSceneNode);
  it('paint-level external → a Set with one key', () => {
    const keys = collectExternalPaintKeys(ext('1:1'));
    expect([...keys]).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  });
  it('a local bound (id without a published key) → an empty Set', () => {
    expect(collectExternalPaintKeys(bound('1:1')).size).toBe(0);
  });
  it('empty tree → an empty Set', () => {
    expect(collectExternalPaintKeys(plain('1:1')).size).toBe(0);
  });
  it('duplicates of the same published key on different nodes collapse to one Set element', () => {
    const tree = plain('1:1', [ext('1:2'), ext('1:3')]);
    const keys = collectExternalPaintKeys(tree);
    expect([...keys]).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  });
  it('different published keys on different nodes → both in the Set', () => {
    const tree = plain('1:1', [ext('1:2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), ext('1:3', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')]);
    const keys = collectExternalPaintKeys(tree);
    expect([...keys].sort()).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  });
  it('paint-level visible:false does NOT count', () => {
    const n = { ...plain('1:1'), fills: [{ type: 'SOLID', visible: false, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1:2' } } }] } as RawSceneNode;
    expect(collectExternalPaintKeys(n).size).toBe(0);
  });
  it('MUTATION LOCK on the strokes branch: the key from a stroke bind lands in the Set (without this the "fills only" mutation stayed green)', () => {
    const n = { ...plain('1:1'), strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:cccccccccccccccccccccccccccccccccccccccc/1:2' } } }] } as RawSceneNode;
    expect([...collectExternalPaintKeys(n)]).toEqual(['cccccccccccccccccccccccccccccccccccccccc']);
  });
});

describe('pickDescentCandidates (probe prefilter)', () => {
  const frameBox = { x: 100, y: 100, width: 200, height: 100 };
  const sec = (id: string, box?: { x: number; y: number; width: number; height: number }, type = 'SECTION') =>
    ({ id, name: id, type, ...(box ? { absoluteBoundingBox: box } : {}) }) as RawSceneNode;

  it('intersects: overlapping / containing / touching within ε — pass; far — no', () => {
    const inside = sec('a', { x: 50, y: 50, width: 400, height: 300 });     // contains frameBox
    const overlap = sec('b', { x: 250, y: 150, width: 200, height: 100 }); // partial overlap
    const eps = sec('c', { x: 300.5, y: 100, width: 50, height: 50 });     // touching within ε=1
    const far = sec('d', { x: 900, y: 900, width: 10, height: 10 });
    expect(pickDescentCandidates([inside, overlap, eps, far], frameBox).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
  it('a candidate WITHOUT a bbox passes (conservatively); a non-container type — no', () => {
    const noBox = sec('nb');
    const text = sec('t', { x: 100, y: 100, width: 200, height: 100 }, 'TEXT');
    expect(pickDescentCandidates([noBox, text], frameBox).map((n) => n.id)).toEqual(['nb']);
  });
  it('container types: SECTION/FRAME/GROUP/COMPONENT/COMPONENT_SET', () => {
    const boxes = ['SECTION', 'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']
      .map((t, i) => sec(`n${i}`, { x: 100, y: 100, width: 10, height: 10 }, t));
    expect(pickDescentCandidates(boxes, frameBox)).toHaveLength(5); // INSTANCE excluded
  });
  it('ε-boundary EXACTLY at 1px (c.x - eps === frameBox.x + frameBox.width) — included (mutation lock <= → < in both x-terms of boxIntersects)', () => {
    // frameBox.x + frameBox.width = 300; c.x = 301 ⟹ c.x - eps(1) === 300 EXACTLY — not "within ε"
    // (like the neighbouring eps case x:300.5 above, where strict < also passes and does not catch the
    // mutation), but exactly ON the boundary. Same y-overlap as frameBox (y:100..200 vs c.y:100..150).
    const exact = sec('e', { x: 301, y: 100, width: 50, height: 50 });
    expect(pickDescentCandidates([exact], frameBox).map((n) => n.id)).toEqual(['e']);
    // The "<=→< in both x-terms of boxIntersects" mutation → a.x-eps(300) < b.x+b.width(300) === false →
    // boxIntersects returns false → the candidate is filtered out → RED here.
  });
  it('sceneIdEquals normalizes the leading I', () => {
    expect(sceneIdEquals('I123:4;5:6', '123:4;5:6')).toBe(true);
    expect(sceneIdEquals('123:4', '123:5')).toBe(false);
  });
});

// ── NODE-level boundVariables (feedback 15/15.1): design_context reads bindings node-level FIRST
// (get-design-context-tool aliasIdFor), the diff side read only paint-level — a node-level-bound
// fill therefore reached colorVerdict as a raw literal and FAILED over correct code. The three
// collectors below must see both binding forms, or the demand gate skips the variables fetch
// (and the snapshot prefetch collects nothing) for exactly the July shape.
describe('node-level boundVariables are seen by all three collectors', () => {
  const nodeBound = (id: string, key: 'fills' | 'strokes', aliasId: string): RawSceneNode => ({
    ...plain(id),
    [key]: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
    boundVariables: { [key]: { type: 'VARIABLE_ALIAS', id: aliasId } },
  } as RawSceneNode);

  it('hasBoundPaintColor: node-level fills binding (no paint-level) → true', () => {
    expect(hasBoundPaintColor(nodeBound('1:1', 'fills', 'VariableID:9:9'))).toBe(true);
  });
  it('hasBoundPaintColor: node-level strokes binding deep in the subtree → true', () => {
    expect(hasBoundPaintColor(plain('1:1', [nodeBound('1:2', 'strokes', 'VariableID:9:9')]))).toBe(true);
  });
  it('hasExternalBoundPaintColor: node-level binding with a published key → true; local-only → false', () => {
    expect(hasExternalBoundPaintColor(nodeBound('1:1', 'fills', 'VariableID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1:2'))).toBe(true);
    expect(hasExternalBoundPaintColor(nodeBound('1:1', 'fills', 'VariableID:9:9'))).toBe(false);
  });
  it('collectExternalPaintKeys: node-level binding contributes its published key', () => {
    const keys = collectExternalPaintKeys(nodeBound('1:1', 'fills', 'VariableID:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/3:4'));
    expect([...keys]).toEqual(['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  });
  it('node-level binding as an ARRAY (REST emits one alias per paint) → first alias id counts', () => {
    const n = {
      ...plain('1:1'),
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
      boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:cccccccccccccccccccccccccccccccccccccccc/5:6' }] },
    } as unknown as RawSceneNode;
    expect(hasBoundPaintColor(n)).toBe(true);
    expect([...collectExternalPaintKeys(n)]).toEqual(['cccccccccccccccccccccccccccccccccccccccc']);
  });
  it('CONTROL: node-level binding under an INVISIBLE sole paint does not count (no visible solid to bind)', () => {
    const n = {
      ...plain('1:1'),
      fills: [{ type: 'SOLID', visible: false, color: { r: 0, g: 0, b: 0, a: 1 } }],
      boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' } },
    } as RawSceneNode;
    expect(hasBoundPaintColor(n)).toBe(false);
  });
});
