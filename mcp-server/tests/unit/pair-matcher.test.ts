import { describe, it, expect } from 'vitest';
import { matchPairs, matchChildrenOneLevel, figText, domText, figWorthy, domWorthy, figUnwrap, collectFigSnippets, collectDomTextUnits, figContentUnknown, domContentUnknown, buildNestedAnchorMap, detectChildrenReorder } from '../../src/domain/layout-spec/pair-matcher.js';
import type { SpecChild, DomChild } from '../../src/domain/layout-spec/types.js';
import { SNIPPET_CAP } from '../../src/domain/layout-spec/types.js';

const fc = (id: string, type: string, box: [number,number,number,number], extra: Partial<SpecChild> = {}): SpecChild =>
  ({ id, name: id, type, rect: { x: box[0], y: box[1], w: box[2], h: box[3] }, ...extra });
const dc = (path: string, tag: string, box: [number,number,number,number], extra: Partial<DomChild> = {}): DomChild =>
  ({ kind: 'element', tag, path, rect: { x: box[0], y: box[1], w: box[2], h: box[3] }, ...extra });
const dtext = (text: string, path: string): DomChild => ({ kind: 'text', text, path, rect: { x:0,y:0,w:1,h:1 } });

describe('worthiness + unwrap + text', () => {
  it('figWorthy: text/instance/container(≠1) — yes; pass-through wrapper(1) — no', () => {
    expect(figWorthy(fc('t','TEXT',[0,0,10,10],{ textSnippet:'Hi' }))).toBe(true);
    expect(figWorthy(fc('i','INSTANCE',[0,0,10,10]))).toBe(true);
    expect(figWorthy(fc('w','FRAME',[0,0,10,10],{ children:[fc('only','TEXT',[0,0,10,10],{ textSnippet:'X' })] }))).toBe(false);
    expect(figWorthy(fc('c','FRAME',[0,0,10,10],{ children:[fc('a','TEXT',[0,0,5,5],{textSnippet:'A'}),fc('b','TEXT',[5,0,5,5],{textSnippet:'B'})] }))).toBe(true);
  });
  it('figUnwrap falls through a single-child wrapper to the worthy descendant (C1)', () => {
    const inner = fc('col','FRAME',[0,0,10,10],{ children:[fc('a','TEXT',[0,0,5,5],{textSnippet:'A'}),fc('b','TEXT',[5,0,5,5],{textSnippet:'B'})] });
    const wrapper = fc('card','FRAME',[0,0,10,10],{ children:[inner] });
    expect(figUnwrap(wrapper).id).toBe('col'); // not 'card' — the wrapper was fallen through
  });
  it('figText/domText extract the content identifier (asymmetry: Figma TEXT itself, DOM — the text child)', () => {
    expect(figText(fc('t','TEXT',[0,0,10,10],{ textSnippet:'Buy now' }))).toBe('Buy now');
    expect(domText(dc('> :nth-child(1)','span',[0,0,10,10],{ children:[dtext('Buy now','> :nth-child(1)')] }))).toBe('Buy now');
  });
});

describe('matchPairs: structure-awareness + bijection-first + unwrap regression', () => {
  it('4a: unwrap card (C1 regression) — a single-child content wrapper on both sides does not yield empty output', () => {
    // fig: card(1 child col(2 texts)) — card itself is not worthy (1 child), unwrap falls through to col.
    const card = fc('card', 'FRAME', [0, 0, 100, 50], {
      children: [
        fc('col', 'FRAME', [0, 0, 100, 50], {
          children: [
            fc('a', 'TEXT', [0, 0, 50, 25], { textSnippet: 'A' }),
            fc('b', 'TEXT', [0, 25, 50, 25], { textSnippet: 'B' }),
          ],
        }),
      ],
    });
    // dom: outerDiv(1 child innerDiv(2 span texts)) — outerDiv itself is not worthy, unwrap falls through to innerDiv.
    const outerDiv = dc('> :nth-child(1)', 'div', [0, 0, 100, 50], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'div', [0, 0, 100, 50], {
          children: [
            dc('> :nth-child(1) > :nth-child(1) > :nth-child(1)', 'span', [0, 0, 50, 25], { text: 'A' }),
            dc('> :nth-child(1) > :nth-child(1) > :nth-child(2)', 'span', [0, 25, 50, 25], { text: 'B' }),
          ],
        }),
      ],
    });

    const result = matchPairs([card], [outerDiv]);

    // C1 regression: without unwrap card/outerDiv are not worthy → weren't recursed into → empty. With unwrap — both texts found.
    expect(result.pairs.length).toBeGreaterThan(0);
    const a = result.pairs.find((p) => p.node_id === 'a');
    const b = result.pairs.find((p) => p.node_id === 'b');
    expect(a?.dom_path).toBe('> :nth-child(1) > :nth-child(1) > :nth-child(1)');
    expect(b?.dom_path).toBe('> :nth-child(1) > :nth-child(1) > :nth-child(2)');
  });

  it('4b: bijection-first (I2) — a text-less fig earlier in the tree does not steal a dom from a text-exact pair', () => {
    // deco (no text, comes first) is close in size to domB — greed without bijection-first
    // would take domB for deco BEFORE total gets a chance at its exact text match.
    const deco = fc('deco', 'FRAME', [0, 0, 50, 20]);
    const total = fc('total', 'TEXT', [0, 20, 50, 50], { textSnippet: 'Итого' });
    const domA = dc('> :nth-child(1)', 'div', [0, 0, 50, 50]); // close in size to total, but has no text
    const domB = dc('> :nth-child(2)', 'span', [0, 20, 50, 20], { text: 'Итого' }); // close in size to deco, but carries total's exact text

    const result = matchPairs([deco, total], [domA, domB]);

    const totalPair = result.pairs.find((p) => p.node_id === 'total');
    expect(totalPair?.dom_path).toBe('> :nth-child(2)'); // domB — by text, not stolen by deco
    expect(result.pairs.find((p) => p.node_id === 'deco')?.dom_path).not.toBe('> :nth-child(2)');
  });

  it('4c: structure-awareness — the same text "X" in different fig/dom containers does not cross', () => {
    const c1 = fc('c1', 'FRAME', [0, 0, 50, 50], {
      children: [
        fc('x1', 'TEXT', [0, 0, 25, 50], { textSnippet: 'X' }),
        fc('a2', 'TEXT', [25, 0, 25, 50], { textSnippet: 'A2' }),
      ],
    });
    const c2 = fc('c2', 'FRAME', [50, 0, 50, 50], {
      children: [
        fc('b1', 'TEXT', [50, 0, 25, 50], { textSnippet: 'B1' }),
        fc('x2', 'TEXT', [75, 0, 25, 50], { textSnippet: 'X' }),
      ],
    });
    const domC1 = dc('> :nth-child(1)', 'div', [0, 0, 50, 50], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 25, 50], { text: 'X' }),
        dc('> :nth-child(1) > :nth-child(2)', 'span', [25, 0, 25, 50], { text: 'A2' }),
      ],
    });
    const domC2 = dc('> :nth-child(2)', 'div', [50, 0, 50, 50], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 25, 50], { text: 'B1' }),
        dc('> :nth-child(2) > :nth-child(2)', 'span', [75, 0, 25, 50], { text: 'X' }),
      ],
    });

    const result = matchPairs([c1, c2], [domC1, domC2]);

    const x1Pair = result.pairs.find((p) => p.node_id === 'x1');
    const x2Pair = result.pairs.find((p) => p.node_id === 'x2');
    expect(x1Pair?.dom_path).toBe('> :nth-child(1) > :nth-child(1)'); // from its own container domC1
    expect(x2Pair?.dom_path).toBe('> :nth-child(2) > :nth-child(2)'); // from its own container domC2
  });
});

describe('matchPairs: honest-null', () => {
  it('weak match → unmatched_figma, NOT a forced pair with a low score', () => {
    // lonely — tiny, not at the front of the dom-candidate list by size or order —
    // must fail MATCH_FLOOR against ANY of the doms, regardless of what 'other' takes.
    const lonely = fc('lonely', 'TEXT', [0, 0, 2, 2], { textSnippet: 'Zzyzx unique phrase' });
    const other = fc('other', 'FRAME', [0, 0, 100, 100]);
    const domA = dc('> :nth-child(1)', 'div', [0, 0, 100, 100], { text: 'totally different content here' });
    const domB = dc('> :nth-child(2)', 'div', [0, 0, 90, 90]);
    const result = matchPairs([lonely, other], [domA, domB]);
    expect(result.pairs.some((p) => p.node_id === 'lonely')).toBe(false);
    expect(result.unmatched_figma.some((u) => u.node_id === 'lonely')).toBe(true);
  });

  it('worthy dom with no fig pair on its level → unmatched_dom (I1, locally per-level)', () => {
    const onlyFig = fc('one', 'TEXT', [0, 0, 10, 10], { textSnippet: 'Solo' });
    const domSolo = dc('> :nth-child(1)', 'span', [0, 0, 10, 10], { text: 'Solo' });
    const domExtra = dc('> :nth-child(2)', 'span', [20, 0, 10, 10], { text: 'Extra leftover' });
    const result = matchPairs([onlyFig], [domSolo, domExtra]);
    expect(result.pairs.length).toBe(1);
    expect(result.unmatched_dom.some((u) => u.dom_path === '> :nth-child(2)')).toBe(true);
  });

  it('a bare top-level text child (kind:text, no .children) does not crash domUnwrap and is honestly not counted as worthy (Thread 3 — the break in domUnwrap is not dead)', () => {
    // DomSnapshotOk.children documents "including bare text nodes" — they can arrive as a
    // direct element of the ds array (not only nested in .children inside an element). domWorthy for
    // kind:'text' returns false IMMEDIATELY on kind, regardless of elemKids.length (usually 0 for a
    // leaf text node) — without the break in domUnwrap `cur = elemKids[0]` would become undefined and
    // crash on the next iteration.
    const onlyFig = fc('one', 'TEXT', [0, 0, 10, 10], { textSnippet: 'Solo' });
    const domSolo = dc('> :nth-child(1)', 'span', [0, 0, 10, 10], { text: 'Solo' });
    const bareText = dtext('stray', '> :nth-child(2)');
    expect(() => matchPairs([onlyFig], [domSolo, bareText])).not.toThrow();
    const result = matchPairs([onlyFig], [domSolo, bareText]);
    expect(result.pairs.length).toBe(1);
    // bareText is not worthy (kind:'text') — not a "lost worthy dom", honestly excluded.
    expect(result.unmatched_dom.some((u) => u.dom_path === '> :nth-child(2)')).toBe(false);
  });
});

describe('matchPairs: ambiguous + candidates', () => {
  it('(a) two dom candidates with a gap < AMBIGUOUS_MARGIN, both ≥ FLOOR → ambiguous:true + candidates (score desc)', () => {
    const f1 = fc('f1', 'FRAME', [0, 0, 40, 40]);
    const domA = dc('> :nth-child(1)', 'div', [0, 0, 40, 40]);
    const domB = dc('> :nth-child(2)', 'div', [0, 0, 36, 36]);

    const result = matchPairs([f1], [domA, domB]);

    const pair = result.pairs.find((p) => p.node_id === 'f1');
    expect(pair?.ambiguous).toBe(true);
    expect(pair?.dom_path).toBe('> :nth-child(1)'); // the best is still chosen as the primary pair
    expect(pair?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(pair?.candidates?.[0].dom_path).toBe('> :nth-child(1)');
    expect(pair?.candidates?.[1].dom_path).toBe('> :nth-child(2)');
    expect(pair!.candidates![0].score).toBeGreaterThanOrEqual(pair!.candidates![1].score);
  });

  it('(b) a text duplicate on 2 dom nodes — bijection does not fire (not unique) → phase-2 → ambiguous with candidates', () => {
    const figDup = fc('dup', 'TEXT', [0, 0, 50, 20], { textSnippet: 'Dup' });
    const figUnique = fc('solo', 'TEXT', [100, 0, 20, 20], { textSnippet: 'Solo' });
    const domDup1 = dc('> :nth-child(1)', 'span', [0, 0, 50, 20], { text: 'Dup' });
    const domDup2 = dc('> :nth-child(2)', 'span', [0, 0, 45, 18], { text: 'Dup' });
    const domSolo = dc('> :nth-child(3)', 'span', [100, 0, 20, 20], { text: 'Solo' });

    const result = matchPairs([figDup, figUnique], [domDup1, domDup2, domSolo]);

    const dupPair = result.pairs.find((p) => p.node_id === 'dup');
    expect(dupPair?.ambiguous).toBe(true);
    expect(dupPair?.candidates?.length).toBeGreaterThanOrEqual(2);

    // Invariant: the bijection (phase-1) stays confident — not ambiguous, even when another node
    // on the same level (phase-2) is flagged ambiguous.
    const soloPair = result.pairs.find((p) => p.node_id === 'solo');
    expect(soloPair?.ambiguous).toBeUndefined();
  });

  it('(c) a clear gap (>margin) → no ambiguous', () => {
    const f1 = fc('f1', 'FRAME', [0, 0, 40, 40]);
    const domA = dc('> :nth-child(1)', 'div', [0, 0, 40, 40]);
    const domB = dc('> :nth-child(2)', 'div', [0, 0, 32, 32]);

    const result = matchPairs([f1], [domA, domB]);

    const pair = result.pairs.find((p) => p.node_id === 'f1');
    expect(pair?.ambiguous).toBeUndefined();
    expect(pair?.candidates).toBeUndefined();
  });

  it('(d) guard: the second candidate < FLOOR → NOT ambiguous (one real candidate)', () => {
    const figMain = fc('main', 'FRAME', [0, 0, 70, 70]);
    const figDummy = fc('dummy', 'TEXT', [0, 0, 140, 140], { textSnippet: 'DummyUniqueText' });
    const domX = dc('> :nth-child(1)', 'div', [0, 0, 112, 112]);
    const domY = dc('> :nth-child(2)', 'div', [0, 0, 112, 112]);
    const domZ = dc('> :nth-child(3)', 'div', [0, 0, 140, 140], { text: 'DummyUniqueText' });

    const result = matchPairs([figMain, figDummy], [domX, domY, domZ]);

    const mainPair = result.pairs.find((p) => p.node_id === 'main');
    expect(mainPair?.dom_path).toBe('> :nth-child(1)');
    expect(mainPair?.ambiguous).toBeUndefined();
    expect(mainPair?.candidates).toBeUndefined();
  });
});

describe('matchPairs: figma_text/dom_text on the pair (readability — name≠matched text)', () => {
  it('a text pair carries figma_text (override, NOT name) and dom_text; a container pair with no text — both fields absent', () => {
    // name deliberately differs from textSnippet — figma_text must take the override (figText),
    // not the master-layer name, otherwise the reviewer sees "MasterDefault" and doesn't understand why confidence is high.
    const textNode = fc('txt', 'TEXT', [0, 0, 10, 10], { name: 'MasterDefault', textSnippet: 'Override текст' });
    const containerFig = fc('box', 'FRAME', [50, 0, 40, 40]);
    const domTextEl = dc('> :nth-child(1)', 'span', [0, 0, 10, 10], { text: 'Override текст' });
    const domContainer = dc('> :nth-child(2)', 'div', [50, 0, 40, 40]);

    const result = matchPairs([textNode, containerFig], [domTextEl, domContainer]);

    const textPair = result.pairs.find((p) => p.node_id === 'txt');
    expect(textPair?.name).toBe('MasterDefault'); // sanity: name — the master layer, not content
    expect(textPair?.figma_text).toBe('Override текст'); // figma_text — the override, not name
    expect(textPair?.dom_text).toBe('Override текст');

    const containerPair = result.pairs.find((p) => p.node_id === 'box');
    expect(containerPair?.figma_text).toBeUndefined();
    expect(containerPair?.dom_text).toBeUndefined();
    // truly absent (not a serialized undefined field), not just an undefined value:
    expect(containerPair && 'figma_text' in containerPair).toBe(false);
    expect(containerPair && 'dom_text' in containerPair).toBe(false);
  });
});

describe('matchPairs: determinism', () => {
  it('the same input twice → identical output', () => {
    const figs: SpecChild[] = [
      fc('a', 'TEXT', [0, 0, 25, 20], { textSnippet: 'Alpha' }),
      fc('b', 'TEXT', [25, 0, 25, 20], { textSnippet: 'Beta' }),
      fc('c', 'FRAME', [50, 0, 25, 20]),
    ];
    const doms: DomChild[] = [
      dc('> :nth-child(1)', 'span', [0, 0, 25, 20], { text: 'Alpha' }),
      dc('> :nth-child(2)', 'span', [25, 0, 25, 20], { text: 'Beta' }),
      dc('> :nth-child(3)', 'div', [50, 0, 25, 20]),
    ];
    const r1 = matchPairs(figs, doms);
    const r2 = matchPairs(figs, doms);
    expect(r1).toEqual(r2);
  });
});

describe('matchPairs: depth_truncated (Thread 1 — honest marker of depth truncation)', () => {
  const childA = fc('childA', 'TEXT', [0, 0, 25, 50], { textSnippet: 'A' });
  const childB = fc('childB', 'TEXT', [25, 0, 25, 50], { textSnippet: 'B' });
  const parent = fc('parent', 'FRAME', [0, 0, 50, 50], { children: [childA, childB] });
  const domA = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 25, 50], { text: 'A' });
  const domB = dc('> :nth-child(1) > :nth-child(2)', 'span', [25, 0, 25, 50], { text: 'B' });
  const domParent = dc('> :nth-child(1)', 'div', [0, 0, 50, 50], { children: [domA, domB] });

  it('(a) maxDepth=0 cuts a non-empty children pair at L1 → depth_truncated===true', () => {
    const result = matchPairs([parent], [domParent], { maxDepth: 0 });
    // L0 matches (parent↔domParent), but recursion into childA/childB is cut off by the guard.
    expect(result.pairs.some((p) => p.node_id === 'parent')).toBe(true);
    expect(result.pairs.some((p) => p.node_id === 'childA')).toBe(false);
    expect(result.depth_truncated).toBe(true);
  });

  it('(b) without maxDepth (undefined) on the same tree → the flag is absent', () => {
    const result = matchPairs([parent], [domParent]);
    expect(result.pairs.some((p) => p.node_id === 'childA')).toBe(true);
    expect(result.depth_truncated).toBeFalsy();
  });
});

describe('matchPairs: rootFig/rootDom (Thread 2 — the real frame rect instead of the max-child proxy)', () => {
  // deco: unique text on both sides — matched in Phase 1 by text, regardless of size,
  // and does NOT take part in Phase 2 (isolates target's size score from competition for a DOM candidate).
  // deco's sizes (160 fig / 15 dom) are deliberately different on the two sides so the max-child proxy
  // diverges between sides (figPar.w=160, domPar.w=30) — the only source of the ratio divergence at target.
  const figDeco = fc('deco', 'TEXT', [0, 0, 160, 20], { textSnippet: 'Zzyzx unique' });
  const figTarget = fc('target', 'FRAME', [0, 20, 30, 20]);
  const domDeco = dc('> :nth-child(1)', 'span', [0, 0, 15, 20], { text: 'Zzyzx unique' });
  const domTarget = dc('> :nth-child(2)', 'div', [0, 20, 30, 20]);

  it('without override — the proxy (max-child) diverges between sides (160 vs 30) → target honestly unmatched (not a forced pair)', () => {
    const result = matchPairs([figDeco, figTarget], [domDeco, domTarget]);
    expect(result.pairs.some((p) => p.node_id === 'target')).toBe(false);
    expect(result.unmatched_figma.some((u) => u.node_id === 'target')).toBe(true);
  });

  it('rootFig/rootDom — the real frame (200×200) is wider than the widest child → ratios smaller (30/200), but both sides consistent → target matches (not unmatched)', () => {
    const result = matchPairs([figDeco, figTarget], [domDeco, domTarget],
      { rootFig: { w: 200, h: 200 }, rootDom: { w: 200, h: 200 } });
    expect(result.pairs.find((p) => p.node_id === 'target')?.dom_path).toBe('> :nth-child(2)');
    expect(result.unmatched_figma.some((u) => u.node_id === 'target')).toBe(false);
  });

  it('regression: existing matcher tests without rootFig (fallback max-child) are unaffected', () => {
    // The test above without override (the same fixture) already covers the fallback path — here we pin
    // that the deco pair matches by text as before, regardless of rootFig.
    const result = matchPairs([figDeco, figTarget], [domDeco, domTarget]);
    expect(result.pairs.find((p) => p.node_id === 'deco')?.dom_path).toBe('> :nth-child(1)');
  });
});

// #2 disambiguation of a parent by a reliable descendant (candidate-scoped anchor). Soundness rests
// on the candidate-scoped guard (NOT global-uniqueness — that one is unsound) — tests (c)/(d)
// are deliberately detectors: without candidate-scope they would pass incorrectly (the anchor would mask a mis-assign).
describe('matchPairs: #2 disambiguation of a parent by a reliable descendant (candidate-scoped anchor)', () => {
  it('(a) anchor-legit: two near-identical fig containers (ambiguous by geometry), the distinguishing text descendant NOT under the runner-up → anchors', () => {
    // The 3rd DOM slot (domC, no text) is needed so BOTH containers are ambiguous: phase-2 is greedy
    // and sequential — container1 (i=0) sees domA/domB/domC and takes domA, leaving
    // container2 (i=1) only domB/domC (2 close candidates — also ambiguous). With EXACTLY 2 DOM
    // container2 would always get the single remaining candidate (not ambiguous at all).
    const container1 = fc('tile1', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('alphaText', 'TEXT', [0, 0, 20, 40], { textSnippet: 'AlphaUnique' }),
        fc('filler1', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    const container2 = fc('tile2', 'FRAME', [50, 0, 40, 40], {
      children: [
        fc('betaText', 'TEXT', [50, 0, 20, 40], { textSnippet: 'BetaUnique' }),
        fc('filler2', 'FRAME', [70, 0, 20, 40]),
      ],
    });
    const domA = dc('> :nth-child(1)', 'div', [0, 0, 40, 40], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 20, 40], { text: 'AlphaUnique' }),
        dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 20, 40]),
      ],
    });
    const domB = dc('> :nth-child(2)', 'div', [50, 0, 38, 38], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 19, 38], { text: 'BetaUnique' }),
        dc('> :nth-child(2) > :nth-child(2)', 'div', [69, 0, 19, 38]),
      ],
    });
    const domC = dc('> :nth-child(3)', 'div', [100, 0, 36, 36]); // decoy competitor — no text

    const result = matchPairs([container1, container2], [domA, domB, domC]);

    const tile1 = result.pairs.find((p) => p.node_id === 'tile1');
    const tile2 = result.pairs.find((p) => p.node_id === 'tile2');
    // sanity: the containers really are ambiguous BEFORE the anchor (otherwise the test checks nothing).
    expect(tile1?.dom_path).toBe('> :nth-child(1)');
    expect(tile2?.dom_path).toBe('> :nth-child(2)');

    expect(tile1?.ambiguous).toBeUndefined();
    expect(tile1?.candidates).toBeUndefined();
    expect(tile1?.signals).toContain('descendant-anchored');
    expect(tile1?.confidence).toBe('medium');

    expect(tile2?.ambiguous).toBeUndefined();
    expect(tile2?.candidates).toBeUndefined();
    expect(tile2?.signals).toContain('descendant-anchored');
    expect(tile2?.confidence).toBe('medium');
  });

  it('(b) no proof: all descendants of an ambiguous parent are low → ambiguous STAYS', () => {
    const container1 = fc('tileA', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('subA1', 'FRAME', [0, 0, 20, 40]),
        fc('subA2', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    const container2 = fc('tileB', 'FRAME', [50, 0, 40, 40], {
      children: [
        fc('subB1', 'FRAME', [50, 0, 20, 40]),
        fc('subB2', 'FRAME', [70, 0, 20, 40]),
      ],
    });
    const domA = dc('> :nth-child(1)', 'div', [0, 0, 40, 40], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'div', [0, 0, 20, 40]),
        dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 20, 40]),
      ],
    });
    const domB = dc('> :nth-child(2)', 'div', [50, 0, 40, 40], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'div', [50, 0, 20, 40]),
        dc('> :nth-child(2) > :nth-child(2)', 'div', [70, 0, 20, 40]),
      ],
    });

    const result = matchPairs([container1, container2], [domA, domB]);

    const tileA = result.pairs.find((p) => p.node_id === 'tileA');
    expect(tileA?.ambiguous).toBe(true);
    expect(tileA?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(tileA?.signals).not.toContain('descendant-anchored');
    expect(tileA?.confidence).toBe('low');
  });

  it('(c) CRITICAL negative adv1: a shared DOM string + Figma asymmetry (2nd INSTANCE without textSnippet) → ambiguous MUST stay', () => {
    // plitkaA carries the override text 'Buy' on its button (master captured), plitkaB — does NOT (the
    // override is not captured by the extractor, pair-matcher.ts:11/24 "master layer ≠ override"). BOTH DOM
    // tiles carry a real "Buy" button. Geometry (size) deliberately mis-assigns plitkaA → domY (NOT its
    // true partner) instead of domX, leaving domX to tile B by remainder.
    const plitkaA = fc('plitkaA', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('buttonA', 'INSTANCE', [0, 0, 20, 40], { textSnippet: 'Buy' }),
        fc('fillerA', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    const plitkaB = fc('plitkaB', 'FRAME', [50, 0, 32, 32], {
      children: [
        fc('buttonB', 'INSTANCE', [50, 0, 16, 32]), // no textSnippet — Figma asymmetry
        fc('fillerB', 'FRAME', [66, 0, 16, 32]),
      ],
    });
    const domX = dc('> :nth-child(1)', 'div', [0, 0, 30, 30], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 15, 30], { text: 'Buy' }),
        dc('> :nth-child(1) > :nth-child(2)', 'div', [15, 0, 15, 30]),
      ],
    });
    const domY = dc('> :nth-child(2)', 'div', [50, 0, 40, 40], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 20, 40], { text: 'Buy' }),
        dc('> :nth-child(2) > :nth-child(2)', 'div', [70, 0, 20, 40]),
      ],
    });

    const result = matchPairs([plitkaA, plitkaB], [domX, domY]);

    const a = result.pairs.find((p) => p.node_id === 'plitkaA');
    // sanity: geometry REALLY mis-assigns (otherwise the test doesn't check the claimed scenario).
    expect(a?.dom_path).toBe('> :nth-child(2)'); // domY — NOT the true domX
    expect(a?.ambiguous).toBe(true);
    expect(a?.candidates?.some((c) => c.dom_path === '> :nth-child(1)')).toBe(true); // domX — runner-up

    const buttonAPair = result.pairs.find((p) => p.node_id === 'buttonA');
    expect(buttonAPair?.dom_path).toBe('> :nth-child(2) > :nth-child(1)');
    expect(buttonAPair?.confidence).toBe('high'); // there is a high descendant under the WRONG parent
    expect(buttonAPair?.dom_text).toBe('Buy');

    const buttonBPair = result.pairs.find((p) => p.node_id === 'buttonB');
    expect(buttonBPair?.dom_path).toBe('> :nth-child(1) > :nth-child(1)');
    expect(buttonBPair?.dom_text).toBe('Buy'); // committed (even if not high) — reachable under the runner-up domX

    // Key check: the candidate-scoped guard prevented the anchor from firing (without it the test would pass incorrectly).
    expect(a?.candidates).toBeDefined();
    expect(a?.signals).not.toContain('descendant-anchored');
  });

  it('(d) CRITICAL negative: BOTH tiles carry the real text "Buy" (2 high pairs) → ambiguous STAYS', () => {
    const plitkaA = fc('plitkaA2', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('buttonA2', 'INSTANCE', [0, 0, 20, 40], { textSnippet: 'Buy' }),
        fc('fillerA2', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    const plitkaB = fc('plitkaB2', 'FRAME', [50, 0, 32, 32], {
      children: [
        fc('buttonB2', 'INSTANCE', [50, 0, 16, 32], { textSnippet: 'Buy' }), // also a real override
        fc('fillerB2', 'FRAME', [66, 0, 16, 32]),
      ],
    });
    const domX = dc('> :nth-child(1)', 'div', [0, 0, 30, 30], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 15, 30], { text: 'Buy' }),
        dc('> :nth-child(1) > :nth-child(2)', 'div', [15, 0, 15, 30]),
      ],
    });
    const domY = dc('> :nth-child(2)', 'div', [50, 0, 40, 40], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 20, 40], { text: 'Buy' }),
        dc('> :nth-child(2) > :nth-child(2)', 'div', [70, 0, 20, 40]),
      ],
    });

    const result = matchPairs([plitkaA, plitkaB], [domX, domY]);

    const a = result.pairs.find((p) => p.node_id === 'plitkaA2');
    expect(a?.dom_path).toBe('> :nth-child(2)'); // sanity: the same mis-assigning geometry
    expect(a?.ambiguous).toBe(true);

    const buttonAPair = result.pairs.find((p) => p.node_id === 'buttonA2');
    const buttonBPair = result.pairs.find((p) => p.node_id === 'buttonB2');
    expect(buttonAPair?.confidence).toBe('high');
    expect(buttonBPair?.confidence).toBe('high'); // now BOTH high (symmetric)
    expect(buttonAPair?.dom_text).toBe('Buy');
    expect(buttonBPair?.dom_text).toBe('Buy');

    expect(a?.signals).not.toContain('descendant-anchored');
  });

  it('(e) a top-level decoy with matching text NOW blocks (all-siblings scan without ≥FLOOR): the decoy is also a worthy sibling of the level → included in pairCompetitors regardless of score', () => {
    const container1 = fc('tileR1', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('alphaTextR', 'TEXT', [0, 0, 20, 40], { textSnippet: 'AlphaUnique' }),
        fc('fillerR1', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    const container2 = fc('tileR2', 'FRAME', [50, 0, 40, 40], {
      children: [
        fc('betaTextR', 'TEXT', [50, 0, 20, 40], { textSnippet: 'BetaUnique' }),
        fc('fillerR2', 'FRAME', [70, 0, 20, 40]),
      ],
    });
    // Decoy: an unrelated top-level nav label with MATCHING text 'AlphaUnique', geometrically
    // <FLOOR against tileR1 (score≈7.5 — the old ≥FLOOR filter excluded it from the scan: "candidate-scope
    // ignores non-candidates", global-uniqueness was considered rejected by design). This changes that:
    // the competitor set is now = ALL worthy siblings of the LEVEL (raw wd), and navFig/navDom is a top-level
    // sibling of container1/container2 → structurally ALWAYS in the set, regardless of score. This is FLIP
    // (2) from the plan: a <FLOOR sibling with the same string is NOW scanned → the tileR1 anchor is correctly
    // blocked (it would be a false recall under the old floor-blindness on this same level — the same class
    // of hole as Zebra (t), just for a decoy, not for a "true home"). Adjudication: we do NOT restore
    // ≥FLOOR (it would break Zebra) — this is an accepted, documented over-refusal
    // cost; recall for a decoy on a DIFFERENT level/subtree (not a sibling of P) still does not block (c)/(j)/(k)/(l).
    const navFig = fc('navLabel', 'TEXT', [200, 0, 20, 20], { textSnippet: 'AlphaUnique' });

    const domA = dc('> :nth-child(1)', 'div', [0, 0, 40, 40], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 20, 40], { text: 'AlphaUnique' }),
        dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 20, 40]),
      ],
    });
    const domB = dc('> :nth-child(2)', 'div', [50, 0, 40, 40], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 20, 40], { text: 'BetaUnique' }),
        dc('> :nth-child(2) > :nth-child(2)', 'div', [70, 0, 20, 40]),
      ],
    });
    const navDom = dc('> :nth-child(3)', 'span', [200, 0, 20, 20], { text: 'AlphaUnique' });

    const result = matchPairs([container1, container2, navFig], [domA, domB, navDom]);

    const tileR1 = result.pairs.find((p) => p.node_id === 'tileR1');
    expect(tileR1?.ambiguous).toBe(true); // FLIP: was undefined (anchored) — now stays ambiguous
    expect(tileR1?.signals).not.toContain('descendant-anchored');
    expect(tileR1?.confidence).toBe('low');
    // sanity: the decoy really matched separately (not absorbed by the containers).
    expect(result.pairs.find((p) => p.node_id === 'navLabel')?.dom_path).toBe('> :nth-child(3)');
    // contrast: tileR2 ('BetaUnique') does NOT share text with decoy/domA → anchors as before, no flip.
    const tileR2 = result.pairs.find((p) => p.node_id === 'tileR2');
    expect(tileR2?.ambiguous).toBeUndefined();
    expect(tileR2?.signals).toContain('descendant-anchored');
    expect(tileR2?.confidence).toBe('medium');
  });

  it('(f) non-ambiguous low + a distinguishing descendant NOW anchors (correct upgrade) + post-pass determinism (two runs of the anchored case are identical)', () => {
    // Part 1: BEFORE the fix 'solo' was non-ambiguous low (its only real competitor 'other' —
    // a clear size gap, score < FLOOR — the old ambiguous-only gate never touched unflagged
    // ambiguous pairs). The fix widens eligible to non-ambiguous LOW — 'solo' is now ELIGIBLE, and
    // competitors = wd.filter(j!==best) = [domOther] (raw, regardless of score) is non-empty → the scan runs;
    // domOther with no text/children → 'SoloUnique' not found in a competitor → CORRECTLY anchors (flip
    // (1) from the plan: a new, expected upgrade, not a bug). "Genuinely untouched" (high / lonely-without-
    // competitors) is already covered separately by tests (s)/(r) — here we pin exactly the flip.
    const solo = fc('solo', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('soloText', 'TEXT', [0, 0, 20, 40], { textSnippet: 'SoloUnique' }),
        fc('soloFiller', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    const other = fc('other', 'FRAME', [200, 0, 10, 10]); // a clear size gap — a <FLOOR competitor
    const domSolo = dc('> :nth-child(1)', 'div', [0, 0, 40, 40], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 20, 40], { text: 'SoloUnique' }),
        dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 20, 40]),
      ],
    });
    const domOther = dc('> :nth-child(2)', 'div', [200, 0, 10, 10]);

    const soloResult = matchPairs([solo, other], [domSolo, domOther]);
    const soloPair = soloResult.pairs.find((p) => p.node_id === 'solo');
    expect(soloPair?.ambiguous).toBeUndefined(); // did not flip — solo was never ambiguous
    expect(soloPair?.signals).toContain('descendant-anchored'); // FLIP: was not.toContain
    expect(soloPair?.confidence).toBe('medium'); // FLIP: would have been 'low'

    // Part 2: determinism SPECIFICALLY of the post-pass — on a genuinely anchored case two runs are identical.
    const container1 = fc('tileD1', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('alphaTextD', 'TEXT', [0, 0, 20, 40], { textSnippet: 'AlphaUniqueD' }),
        fc('fillerD1', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    const container2 = fc('tileD2', 'FRAME', [50, 0, 40, 40], {
      children: [
        fc('betaTextD', 'TEXT', [50, 0, 20, 40], { textSnippet: 'BetaUniqueD' }),
        fc('fillerD2', 'FRAME', [70, 0, 20, 40]),
      ],
    });
    const domA = dc('> :nth-child(1)', 'div', [0, 0, 40, 40], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 20, 40], { text: 'AlphaUniqueD' }),
        dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 20, 40]),
      ],
    });
    const domB = dc('> :nth-child(2)', 'div', [50, 0, 40, 40], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 20, 40], { text: 'BetaUniqueD' }),
        dc('> :nth-child(2) > :nth-child(2)', 'div', [70, 0, 20, 40]),
      ],
    });

    const r1 = matchPairs([container1, container2], [domA, domB]);
    const r2 = matchPairs([container1, container2], [domA, domB]);
    expect(r1).toEqual(r2);
    expect(r1.pairs.find((p) => p.node_id === 'tileD1')?.signals).toContain('descendant-anchored');
  });

  it('(g) lockstep/prefix invariant: a numeric prefix is NOT treated as a descendant boundary + empty parentPath → false', () => {
    // isDescendant — a local function inside matchPairs (not exported) — checked here
    // indirectly through the observable behavior of matchPairs (the only available way).
    //
    // Part 1: '> :nth-child(3)' is NOT a parent of '> :nth-child(30) > :nth-child(1)' despite
    // the matching leading digit — the segment boundary (a space AFTER ')') must distinguish them.
    const parent3 = fc('parent3', 'FRAME', [0, 0, 40, 40]);
    const other = fc('other', 'FRAME', [50, 0, 36, 36]);
    const decoyText = fc('decoyText', 'TEXT', [200, 0, 15, 15], { textSnippet: 'DistinguishDecoy' });

    const domParent3 = dc('> :nth-child(3)', 'div', [0, 0, 40, 40]);
    const domOther = dc('> :nth-child(4)', 'div', [50, 0, 36, 36]);
    // The decoy path — '> :nth-child(30) > :nth-child(1)': the leading '3' matches parent3, but it's
    // a DIFFERENT node (the 30th child) — a naive `startsWith(parentPath)` without the boundary check would
    // count it as a descendant of '> :nth-child(3)'; the correct implementation does not (')' vs '0' at position 14 diverge).
    const domDecoy = dc('> :nth-child(30) > :nth-child(1)', 'span', [200, 0, 15, 15], { text: 'DistinguishDecoy' });

    const result = matchPairs([parent3, other, decoyText], [domParent3, domOther, domDecoy]);

    const p3 = result.pairs.find((p) => p.node_id === 'parent3');
    expect(p3?.dom_path).toBe('> :nth-child(3)');
    expect(p3?.ambiguous).toBe(true); // near-identical size to 'other' — ambiguous, as in (a)/(c)
    expect(p3?.candidates).toBeDefined();
    expect(p3?.confidence).toBe('low');
    expect(result.pairs.find((p) => p.node_id === 'decoyText')?.confidence).toBe('high'); // high is there...
    expect(p3?.signals).not.toContain('descendant-anchored'); // ...but NOT under parent3 — does not anchor

    // Part 2: an empty parentPath (dom_path==='', e.g. a snapshot root with no path of its own) —
    // the guard MUST return false, even if childPath starts with ' ' (which a naive `'' + ' '`
    // concatenation would count as a valid prefix separator).
    const rootless = fc('rootless', 'FRAME', [0, 0, 40, 40]);
    const rootlessOther = fc('rootlessOther', 'FRAME', [50, 0, 36, 36]);
    const spaceText = fc('spaceText', 'TEXT', [200, 0, 15, 15], { textSnippet: 'RootDistinguish' });

    const domRoot = dc('', 'div', [0, 0, 40, 40]);
    const domRootOther = dc('> :nth-child(4)', 'div', [50, 0, 36, 36]);
    const domSpace = dc(' > :nth-child(1)', 'span', [200, 0, 15, 15], { text: 'RootDistinguish' });

    const result2 = matchPairs([rootless, rootlessOther, spaceText], [domRoot, domRootOther, domSpace]);

    const rl = result2.pairs.find((p) => p.node_id === 'rootless');
    expect(rl?.dom_path).toBe('');
    expect(rl?.ambiguous).toBe(true);
    expect(rl?.candidates).toBeDefined();
    expect(rl?.confidence).toBe('low');
    expect(result2.pairs.find((p) => p.node_id === 'spaceText')?.confidence).toBe('high'); // the high descendant formally exists...
    expect(rl?.signals).not.toContain('descendant-anchored'); // ...but the parentPath==='' guard blocks the anchor
  });
});

// upgrade candidate-scoped → competitor-subtree-scoped. Both of the following (h)/(i) are
// regression tests of REAL holes found adversarially in the earlier code (candidate-scoped via
// p.candidates top-3 + committed-pairs scan). They MUST fail on 562b2c8 (mis-anchor) and pass after Step 3a/3b.
describe('matchPairs: competitor-subtree-scoped — regression of candidate-scoped holes', () => {
  it('(h) candidate-truncation: the 4th competitor (≥FLOOR, but outside the display top-3 candidates) carries the same anchor string → ambiguous MUST stay', () => {
    const anchorText = 'QSharedText';

    // tileQ — the only figure processed FIRST (figIdx=0) — its scored is computed over the
    // FULL pool [domP1..domP4] before anyone else touches them.
    const qText = fc('qText', 'TEXT', [0, 0, 20, 40], { textSnippet: anchorText });
    const fillerQ = fc('fillerQ', 'FRAME', [20, 0, 20, 40]);
    const tileQ = fc('tileQ', 'FRAME', [0, 0, 40, 40], { children: [qText, fillerQ] });

    // otherFig2/otherFig3 — "cleaners" of the remainder (domP2/domP3), no children — not involved in text.
    const otherFig2 = fc('otherFig2', 'FRAME', [100, 0, 36, 40]);
    const otherFig3 = fc('otherFig3', 'FRAME', [200, 0, 36, 40]);
    // otherFig4 — will pick up domP4 (the only one remaining by its turn) and its text child
    // REALLY commits as a pair (dom_text=anchorText) — but domP4 is NOT in the displayed top-3.
    const hiddenAnchor = fc('hiddenAnchor', 'TEXT', [0, 0, 20, 40], { textSnippet: anchorText });
    const fillerOF4 = fc('fillerOF4', 'FRAME', [20, 0, 20, 40]);
    const otherFig4 = fc('otherFig4', 'FRAME', [300, 0, 36, 40], { children: [hiddenAnchor, fillerOF4] });

    const spanQ = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 20, 40], { text: anchorText });
    const fillerDivQ = dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 20, 40]);
    const domP1 = dc('> :nth-child(1)', 'div', [0, 0, 40, 40], { children: [spanQ, fillerDivQ] });
    const domP2 = dc('> :nth-child(2)', 'div', [50, 0, 36, 40]);
    const domP3 = dc('> :nth-child(3)', 'div', [100, 0, 36, 40]);
    const spanHidden = dc('> :nth-child(4) > :nth-child(1)', 'span', [150, 0, 20, 40], { text: anchorText });
    const fillerDivOF4 = dc('> :nth-child(4) > :nth-child(2)', 'div', [170, 0, 16, 40]);
    const domP4 = dc('> :nth-child(4)', 'div', [150, 0, 36, 40], { children: [spanHidden, fillerDivOF4] });

    const result = matchPairs([tileQ, otherFig2, otherFig3, otherFig4], [domP1, domP2, domP3, domP4]);

    const tileQPair = result.pairs.find((p) => p.node_id === 'tileQ');
    // sanity: domP1 really is chosen best, domP4 — a real ≥FLOOR competitor, but dropped from top-3.
    expect(tileQPair?.dom_path).toBe('> :nth-child(1)');

    // sanity: hiddenAnchor REALLY committed (not unmatched) with dom_text=anchorText under domP4 —
    // exactly this committed, but truncated-from-top-3, pair is what misled the committed scan.
    const hiddenPair = result.pairs.find((p) => p.node_id === 'hiddenAnchor');
    expect(hiddenPair?.dom_path).toBe('> :nth-child(4) > :nth-child(1)');
    expect(hiddenPair?.dom_text).toBe(anchorText);

    // sanity: qText — high confidence (text-exact) under domP1, a descendant of tileQ.
    const qPair = result.pairs.find((p) => p.node_id === 'qText');
    expect(qPair?.confidence).toBe('high');
    expect(qPair?.dom_text).toBe(anchorText);

    // Key check: even though domP4 is not in the displayed top-3 candidates,
    // the competitor scan must see it and block the anchor.
    expect(tileQPair?.ambiguous).toBe(true);
    expect(tileQPair?.candidates).toBeDefined();
    expect(tileQPair?.candidates?.length).toBeLessThanOrEqual(3); // display top-3 — truncation reproduced
    expect(tileQPair?.candidates?.some((c) => c.dom_path === '> :nth-child(4)')).toBe(false); // domP4 really truncated
    expect(tileQPair?.signals).not.toContain('descendant-anchored');
    expect(tileQPair?.confidence).toBe('low');
  });

  it('(i) TEST D: the anchor string under a competitor — an unmatched leaf (not a committed pair) → ambiguous MUST stay', () => {
    const plitkaA = fc('plitkaA3', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('buttonA3', 'INSTANCE', [0, 0, 20, 40], { textSnippet: 'Buy' }),
        fc('fillerA3', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    // otherFigX will pick up domX (the only one remaining). It has 2 children (not 1 — otherwise C1-unwrap
    // would collapse it into its single child, and the walk into domX.children would never happen):
    // fillerBig will prefer fillerDiv (by size, takes it first), and fillerFar — after
    // fillerDiv is taken, its only remaining candidate (the Buy heading) scores BELOW FLOOR for it →
    // honest-null on the fig side → the Buy heading stays UNCOMMITTED (unmatched_dom), not swallowed.
    const otherFigX = fc('otherFigX', 'FRAME', [50, 0, 32, 32], {
      children: [
        fc('fillerBig', 'FRAME', [50, 0, 28, 32]),
        fc('fillerFar', 'FRAME', [78, 0, 30, 32]),
      ],
    });
    const domX = dc('> :nth-child(1)', 'div', [0, 0, 30, 30], {
      children: [
        dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 2, 30], { text: 'Buy' }), // will remain an unmatched leaf
        dc('> :nth-child(1) > :nth-child(2)', 'div', [2, 0, 28, 30]),
      ],
    });
    const domY = dc('> :nth-child(2)', 'div', [50, 0, 40, 40], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 20, 40], { text: 'Buy' }),
        dc('> :nth-child(2) > :nth-child(2)', 'div', [70, 0, 20, 40]),
      ],
    });

    const result = matchPairs([plitkaA, otherFigX], [domX, domY]);

    const a = result.pairs.find((p) => p.node_id === 'plitkaA3');
    expect(a?.dom_path).toBe('> :nth-child(2)'); // sanity: mis-assign to domY, domX — a competitor/runner-up
    expect(a?.candidates?.some((c) => c.dom_path === '> :nth-child(1)')).toBe(true);

    // sanity: the domX CONTAINER really is matched (otherFigX), but via filler, NOT via the Buy heading.
    expect(result.pairs.find((p) => p.node_id === 'otherFigX')?.dom_path).toBe('> :nth-child(1)');
    expect(result.pairs.find((p) => p.node_id === 'fillerBig')?.dom_path).toBe('> :nth-child(1) > :nth-child(2)');
    // sanity: fillerFar honestly fell into unmatched_figma (its only remaining candidate —
    // the Buy heading — is below FLOOR for it), did not steal the Buy heading for itself.
    expect(result.unmatched_figma.some((u) => u.node_id === 'fillerFar')).toBe(true);

    // Key sanity: the Buy heading under domX — REALLY an unmatched leaf, not a committed pair
    // (otherwise the test would check the old TEST D scenario, not the new one).
    expect(result.unmatched_dom.some((u) => u.dom_path === '> :nth-child(1) > :nth-child(1)')).toBe(true);
    expect(result.pairs.some((p) => p.dom_path === '> :nth-child(1) > :nth-child(1)')).toBe(false);

    const buttonAPair = result.pairs.find((p) => p.node_id === 'buttonA3');
    expect(buttonAPair?.confidence).toBe('high');
    expect(buttonAPair?.dom_text).toBe('Buy');

    // Key check: the raw scan of the domX subtree finds 'Buy' as an unmatched leaf →
    // the committed-pairs scan (562b2c8) would not see it → would anchor incorrectly.
    expect(a?.ambiguous).toBe(true);
    expect(a?.signals).not.toContain('descendant-anchored');
  });

  it('(j) positive motivation: 5 near-identical tiles, each with a unique text descendant → ALL 5 anchor', () => {
    const N = 5;
    const figs: SpecChild[] = [];
    const doms: DomChild[] = [];
    for (let i = 0; i < N; i++) {
      const text = `Tile${i}Uniq`;
      figs.push(fc(`tileK${i}`, 'FRAME', [i * 50, 0, 40, 40], {
        children: [
          fc(`tileK${i}Text`, 'TEXT', [i * 50, 0, 20, 40], { textSnippet: text }),
          fc(`tileK${i}Filler`, 'FRAME', [i * 50 + 20, 0, 20, 40]),
        ],
      }));
      doms.push(dc(`> :nth-child(${i + 1})`, 'div', [i * 50, 0, 40, 40], {
        children: [
          dc(`> :nth-child(${i + 1}) > :nth-child(1)`, 'span', [i * 50, 0, 20, 40], { text }),
          dc(`> :nth-child(${i + 1}) > :nth-child(2)`, 'div', [i * 50 + 20, 0, 20, 40]),
        ],
      }));
    }
    // decoy — no text/children: keeps the last tile ambiguous too, without "leaking" as anyone's anchor.
    doms.push(dc(`> :nth-child(${N + 1})`, 'div', [N * 50, 0, 40, 40]));

    const result = matchPairs(figs, doms);

    for (let i = 0; i < N; i++) {
      const tile = result.pairs.find((p) => p.node_id === `tileK${i}`);
      expect(tile?.dom_path).toBe(`> :nth-child(${i + 1})`); // sanity: its own tile
      expect(tile?.ambiguous).toBeUndefined();
      expect(tile?.candidates).toBeUndefined();
      expect(tile?.signals).toContain('descendant-anchored');
      expect(tile?.confidence).toBe('medium');
    }
  });
});

// full-sibling competitor set (close the 5th break: the stolen true home) + split-text scan.
// (k)/(l) — regression of Vector 1/1b: the true competitor home of P is STOLEN by an earlier
// phase-2/phase-1 fig and drops out of the scored/usedDom set (c7534bd) → the guard doesn't see it → mis-anchors.
// (m) — regression of Vector 2: a shared string split across ≥2 kind:'text' children of a competitor escapes
// domText (length!==1 → undefined) → without concatenation in domSubtreeHasText the anchor also mis-fires.
describe('matchPairs: full-sibling competitor set — regression of the stolen true home + split-text', () => {
  it('(k) stolen home phase-2 (CONFIRMED Vector 1, detector): the true home D_true is stolen by the greedy fThief (i=0, no text) before P moves → P MUST stay ambiguous', () => {
    // fThief — no textSnippet, no children, processed FIRST (i=0) — greedily takes D_true
    // (closest by size) before P (i=1) sees the remainder [D_chosen, D_other].
    const fThief = fc('fThief', 'FRAME', [0, 0, 40, 40]);
    const buttonP = fc('buttonP', 'INSTANCE', [50, 0, 10, 20], { textSnippet: 'Buy' });
    const fillerP = fc('fillerP', 'FRAME', [60, 0, 10, 20]);
    const P = fc('P', 'FRAME', [50, 0, 20, 20], { children: [buttonP, fillerP] });

    const spanTrue = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 20, 40], { text: 'Buy' });
    const fillerTrueDiv = dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 20, 40]);
    const D_true = dc('> :nth-child(1)', 'div', [0, 0, 40, 40], { children: [spanTrue, fillerTrueDiv] });

    const spanChosen = dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 10, 20], { text: 'Buy' });
    const fillerChosenDiv = dc('> :nth-child(2) > :nth-child(2)', 'div', [60, 0, 10, 20]);
    const D_chosen = dc('> :nth-child(2)', 'div', [50, 0, 20, 20], { children: [spanChosen, fillerChosenDiv] });

    const D_other = dc('> :nth-child(3)', 'div', [80, 0, 20, 20]); // no 'Buy', no children

    const result = matchPairs([fThief, P], [D_true, D_chosen, D_other],
      { rootFig: { w: 100, h: 100 }, rootDom: { w: 100, h: 100 } });

    // sanity: fThief REALLY stole D_true (greedy by order, a clean gap — not ambiguous itself).
    const thiefPair = result.pairs.find((p) => p.node_id === 'fThief');
    expect(thiefPair?.dom_path).toBe('> :nth-child(1)');
    expect(thiefPair?.ambiguous).toBeUndefined();

    // sanity: P is forced onto D_chosen vs D_other (the only visible remainder), margin<12 → ambiguous.
    const pPair = result.pairs.find((p) => p.node_id === 'P');
    expect(pPair?.dom_path).toBe('> :nth-child(2)');
    expect(pPair?.ambiguous).toBe(true);
    expect(pPair?.candidates?.some((c) => c.dom_path === '> :nth-child(3)')).toBe(true);

    // sanity: P's high descendant carries the SHARED (non-distinguishing) text 'Buy'.
    const buttonPPair = result.pairs.find((p) => p.node_id === 'buttonP');
    expect(buttonPPair?.confidence).toBe('high');
    expect(buttonPPair?.dom_text).toBe('Buy');

    // Key check: D_true (P's true home, stolen by fThief) carries 'Buy' and SCORES ≥FLOOR
    // against P → structurally MUST be a competitor REGARDLESS of usedDom → 'Buy' does not distinguish →
    // P STAYS ambiguous. Under c7534bd (scored.filter(!usedDom)) D_true is excluded as spent →
    // the only visible competitor (D_other) without 'Buy' → a false anchor.
    expect(pPair?.ambiguous).toBe(true);
    expect(pPair?.signals).not.toContain('descendant-anchored');
    expect(pPair?.confidence).toBe('low');
  });

  it('(l) stolen home phase-1 (Vector 1b): the true home D_true is spent by the unique-text bijection of fUnique → P MUST stay ambiguous', () => {
    // fUnique — unique text 'UniqueXYZ' matches ONLY D_true's own .text (own-text
    // bijection, phase-1) — takes D_true before P (phase-2) even sees the level.
    const fUnique = fc('fUnique', 'TEXT', [0, 0, 10, 10], { textSnippet: 'UniqueXYZ' });
    const buttonP2 = fc('buttonP2', 'INSTANCE', [50, 0, 10, 20], { textSnippet: 'Buy' });
    const fillerP2 = fc('fillerP2', 'FRAME', [60, 0, 10, 20]);
    const P2 = fc('P2', 'FRAME', [50, 0, 20, 20], { children: [buttonP2, fillerP2] });

    // D_true carries own .text='UniqueXYZ' (the bijection key) AND deeper — 'Buy' (a nested span) —
    // domSubtreeHasText must find 'Buy' by recursing into children, even when own-text is something else.
    const spanBuried = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 10, 20], { text: 'Buy' });
    const fillerTrueDiv2 = dc('> :nth-child(1) > :nth-child(2)', 'div', [10, 0, 10, 20]);
    const D_true = dc('> :nth-child(1)', 'div', [0, 0, 20, 20],
      { text: 'UniqueXYZ', children: [spanBuried, fillerTrueDiv2] });

    const spanChosen2 = dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 10, 20], { text: 'Buy' });
    const fillerChosenDiv2 = dc('> :nth-child(2) > :nth-child(2)', 'div', [60, 0, 10, 20]);
    const D_chosen = dc('> :nth-child(2)', 'div', [50, 0, 20, 20], { children: [spanChosen2, fillerChosenDiv2] });

    const D_other = dc('> :nth-child(3)', 'div', [80, 0, 20, 20]);

    const result = matchPairs([fUnique, P2], [D_true, D_chosen, D_other],
      { rootFig: { w: 100, h: 100 }, rootDom: { w: 100, h: 100 } });

    // sanity: the phase-1 bijection REALLY took D_true under fUnique (did not remain a visible remainder).
    const uniquePair = result.pairs.find((p) => p.node_id === 'fUnique');
    expect(uniquePair?.dom_path).toBe('> :nth-child(1)');
    expect(uniquePair?.confidence).toBe('high');

    const pPair = result.pairs.find((p) => p.node_id === 'P2');
    expect(pPair?.dom_path).toBe('> :nth-child(2)');
    expect(pPair?.ambiguous).toBe(true);

    const buttonPPair = result.pairs.find((p) => p.node_id === 'buttonP2');
    expect(buttonPPair?.confidence).toBe('high');
    expect(buttonPPair?.dom_text).toBe('Buy');

    // Key check: D_true (spent by the phase-1 bijection on ITS OWN unique text) is still
    // a plausible alt-home of P (≥FLOOR by geometry) → structurally a competitor → 'Buy' in its subtree
    // does not distinguish → P STAYS ambiguous. Under c7534bd (scored.filter(!usedDom)) D_true is not visible.
    expect(pPair?.signals).not.toContain('descendant-anchored');
    expect(pPair?.confidence).toBe('low');
  });

  it('(m) split-text competitor (Vector 2): the shared string "BuyNow", split across 2 kind:\'text\' children of a competitor, blocks the anchor by concatenation; control (a single text node) — also blocks', () => {
    // Part 1 (split): the competitor is a div WITHOUT own .text, whose children are 2 BARE kind:'text' nodes
    // ('Buy'+'Now'), not a single text node → domText(competitor) would return undefined
    // (texts.length===2 !== 1) — without concatenation in domSubtreeHasText the string would escape.
    const buttonN1 = fc('buttonN1', 'INSTANCE', [0, 0, 10, 20], { textSnippet: 'BuyNow' });
    const fillerN1 = fc('fillerN1', 'FRAME', [10, 0, 10, 20]);
    const tileN1 = fc('tileN1', 'FRAME', [0, 0, 20, 20], { children: [buttonN1, fillerN1] });

    const spanChosenN1 = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 10, 20], { text: 'BuyNow' });
    const fillerChosenN1 = dc('> :nth-child(1) > :nth-child(2)', 'div', [10, 0, 10, 20]);
    const domChosenN1 = dc('> :nth-child(1)', 'div', [0, 0, 20, 20], { children: [spanChosenN1, fillerChosenN1] });

    const domCompetitorSplit = dc('> :nth-child(2)', 'div', [50, 0, 20, 20], {
      children: [
        dtext('Buy', '> :nth-child(2) > :nth-child(1)'),
        dtext('Now', '> :nth-child(2) > :nth-child(2)'),
      ],
    });

    const result = matchPairs([tileN1], [domChosenN1, domCompetitorSplit],
      { rootFig: { w: 100, h: 100 }, rootDom: { w: 100, h: 100 } });

    const tileN1Pair = result.pairs.find((p) => p.node_id === 'tileN1');
    expect(tileN1Pair?.dom_path).toBe('> :nth-child(1)');
    expect(tileN1Pair?.ambiguous).toBe(true); // sanity: really ambiguous before the anchor

    const buttonN1Pair = result.pairs.find((p) => p.node_id === 'buttonN1');
    expect(buttonN1Pair?.confidence).toBe('high');
    expect(buttonN1Pair?.dom_text).toBe('BuyNow');

    // Key check: the competitor's split text ('Buy'+'Now') is found by CONCATENATION → the anchor is blocked.
    expect(tileN1Pair?.signals).not.toContain('descendant-anchored');
    expect(tileN1Pair?.confidence).toBe('low');

    // Part 2 (control): the competitor carries 'BuyNow' as ONE text node (own .text, not split) —
    // the already-working node.text branch — also blocks. Contrast with the split case: this is NOT a detector
    // (passes even without 3b), it pins that the split is the only new hole, not the general scan.
    const buttonN2 = fc('buttonN2', 'INSTANCE', [0, 0, 10, 20], { textSnippet: 'BuyNow' });
    const fillerN2 = fc('fillerN2', 'FRAME', [10, 0, 10, 20]);
    const tileN2 = fc('tileN2', 'FRAME', [0, 0, 20, 20], { children: [buttonN2, fillerN2] });

    const spanChosenN2 = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 10, 20], { text: 'BuyNow' });
    const fillerChosenN2 = dc('> :nth-child(1) > :nth-child(2)', 'div', [10, 0, 10, 20]);
    const domChosenN2 = dc('> :nth-child(1)', 'div', [0, 0, 20, 20], { children: [spanChosenN2, fillerChosenN2] });

    const domCompetitorWhole = dc('> :nth-child(2)', 'div', [50, 0, 20, 20], { text: 'BuyNow' });

    const result2 = matchPairs([tileN2], [domChosenN2, domCompetitorWhole],
      { rootFig: { w: 100, h: 100 }, rootDom: { w: 100, h: 100 } });

    const tileN2Pair = result2.pairs.find((p) => p.node_id === 'tileN2');
    expect(tileN2Pair?.ambiguous).toBe(true);
    expect(tileN2Pair?.signals).not.toContain('descendant-anchored');
    expect(tileN2Pair?.confidence).toBe('low');
  });
});

// flatten-substring scan (close the 6th break: SCAN incompleteness of split text). The competitor
// set is already provably complete — here the text SCAN itself breaks: the old domSubtreeHasText
// concatenated only DIRECT text children (join('')) — it missed (n) text in nested ELEMENTS
// and (o) whitespace variants. A scan miss → the guard fires (!competitors.some) → a FALSE anchor
// (unsafe). (n)/(o) — regression detectors: MUST fail (mis-anchor) on the 977095f code.
describe('matchPairs: flatten-substring scan — regression of split/element-nested text', () => {
  it('(n) element-nested (CONFIRMED Vector 5, detector): a competitor renders the shared anchor string "BuyNow" as NESTED elements (span>text, NOT direct text children) → ambiguous MUST stay', () => {
    const buttonO1 = fc('buttonO1', 'INSTANCE', [0, 0, 10, 20], { textSnippet: 'BuyNow' });
    const fillerO1 = fc('fillerO1', 'FRAME', [10, 0, 10, 20]);
    const tileO1 = fc('tileO1', 'FRAME', [0, 0, 20, 20], { children: [buttonO1, fillerO1] });

    const spanChosenO1 = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 10, 20], { text: 'BuyNow' });
    const fillerChosenO1 = dc('> :nth-child(1) > :nth-child(2)', 'div', [10, 0, 10, 20]);
    const domChosenO1 = dc('> :nth-child(1)', 'div', [0, 0, 20, 20], { children: [spanChosenO1, fillerChosenO1] });

    // Competitor: "BuyNow" is split across NESTED span elements, each with its OWN text child
    // (span > text) — the competitor's direct children are THEMSELVES elements (kind:'element'), not
    // kind:'text' — the old domSubtreeHasText concatenated only a node's DIRECT text children and did NOT
    // glue across the boundary of nested elements (per-element recursion lost the adjacency 'Buy'+'Now').
    const domCompetitorNested = dc('> :nth-child(2)', 'div', [50, 0, 20, 20], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 10, 20], {
          children: [dtext('Buy', '> :nth-child(2) > :nth-child(1) > :nth-child(1)')],
        }),
        dc('> :nth-child(2) > :nth-child(2)', 'span', [60, 0, 10, 20], {
          children: [dtext('Now', '> :nth-child(2) > :nth-child(2) > :nth-child(1)')],
        }),
      ],
    });

    const result = matchPairs([tileO1], [domChosenO1, domCompetitorNested],
      { rootFig: { w: 100, h: 100 }, rootDom: { w: 100, h: 100 } });

    const tileO1Pair = result.pairs.find((p) => p.node_id === 'tileO1');
    expect(tileO1Pair?.dom_path).toBe('> :nth-child(1)');
    expect(tileO1Pair?.ambiguous).toBe(true); // sanity: really ambiguous before the anchor

    const buttonO1Pair = result.pairs.find((p) => p.node_id === 'buttonO1');
    expect(buttonO1Pair?.confidence).toBe('high');
    expect(buttonO1Pair?.dom_text).toBe('BuyNow');

    // Key check: the competitor's element-nested text is found by the flatten scan (flattens the WHOLE
    // subtree recursively, regardless of element boundaries) → the anchor is blocked.
    expect(tileO1Pair?.signals).not.toContain('descendant-anchored');
    expect(tileO1Pair?.confidence).toBe('low');
  });

  it('(o) whitespace variant: anchor text "Buy Now" (with a space); the competitor carries it as 2 DIRECT text nodes "Buy"+"Now" without a separator → join(\'\')=\'BuyNow\'≠\'Buy Now\' the old scan would mis-anchor; flatten+stripWs (both sides→\'BuyNow\') finds it → ambiguous MUST stay', () => {
    const buttonP1 = fc('buttonP1', 'INSTANCE', [0, 0, 10, 20], { textSnippet: 'Buy Now' });
    const fillerP1 = fc('fillerP1', 'FRAME', [10, 0, 10, 20]);
    const tileP1 = fc('tileP1', 'FRAME', [0, 0, 20, 20], { children: [buttonP1, fillerP1] });

    const spanChosenP1 = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 10, 20], { text: 'Buy Now' });
    const fillerChosenP1 = dc('> :nth-child(1) > :nth-child(2)', 'div', [10, 0, 10, 20]);
    const domChosenP1 = dc('> :nth-child(1)', 'div', [0, 0, 20, 20], { children: [spanChosenP1, fillerChosenP1] });

    // Competitor: the same string "Buy Now" split across 2 DIRECT text nodes WITHOUT a space between them in
    // the source markup (typical of splitting by inline markup) — join('')='BuyNow' ≠
    // normSnippet('Buy Now')='Buy Now' for the old scan (the concat branch mis-skips). flatten inserts
    // a separator after EACH .text node, then stripWs removes ALL whitespace on BOTH sides —
    // 'Buy Now '→'BuyNow' and the figma side 'Buy Now'→'BuyNow' — they match.
    const domCompetitorWs = dc('> :nth-child(2)', 'div', [50, 0, 20, 20], {
      children: [
        dtext('Buy', '> :nth-child(2) > :nth-child(1)'),
        dtext('Now', '> :nth-child(2) > :nth-child(2)'),
      ],
    });

    const result = matchPairs([tileP1], [domChosenP1, domCompetitorWs],
      { rootFig: { w: 100, h: 100 }, rootDom: { w: 100, h: 100 } });

    const tileP1Pair = result.pairs.find((p) => p.node_id === 'tileP1');
    expect(tileP1Pair?.dom_path).toBe('> :nth-child(1)');
    expect(tileP1Pair?.ambiguous).toBe(true); // sanity: really ambiguous before the anchor

    const buttonP1Pair = result.pairs.find((p) => p.node_id === 'buttonP1');
    expect(buttonP1Pair?.confidence).toBe('high');
    expect(buttonP1Pair?.dom_text).toBe('Buy Now');

    // Key check: the whitespace-normalized flatten scan finds the competitor's split string
    // with no separator space → the anchor is blocked.
    expect(tileP1Pair?.signals).not.toContain('descendant-anchored');
    expect(tileP1Pair?.confidence).toBe('low');
  });
});

// decouple the anchor from the ambiguous flag — an ergonomic gap from the acceptance: a terminal
// sibling (the last tile) is never flagged ambiguous (scored[1] is a forward-looking window, no competitor
// below) → it used to stay low ("check by hand"), though it is as unambiguous as its medium neighbours.
// The gate: eligibility for an anchor = p.ambiguous || p.confidence === 'low'. CRITICAL (adversarial caught it
// BEFORE the code): the competitor set for the SCAN = ALL worthy siblings of the level (raw wd minus best),
// WITHOUT the ≥FLOOR filter — otherwise a <FLOOR sibling (mis-sized by the very layout bug) drops out of the scan and the anchor lies (Zebra, (t)).
describe('matchPairs: anchor decoupled from ambiguous flag (terminal sibling by distinguishing descendant)', () => {
  it('(p) terminal sibling anchored: N=3 near-identical tiles, a unique title on each, WITHOUT a decoy — the last tile exhausts the dom pool on its phase-2 turn (scored[1] empty) → under d57d2ff low-non-ambiguous, now medium+descendant-anchored', () => {
    const N = 3;
    const figs: SpecChild[] = [];
    const doms: DomChild[] = [];
    for (let i = 0; i < N; i++) {
      const text = `TileR${i}Uniq`;
      figs.push(fc(`tileR${i}`, 'FRAME', [i * 50, 0, 40, 40], {
        children: [
          fc(`tileR${i}Text`, 'TEXT', [i * 50, 0, 20, 40], { textSnippet: text }),
          fc(`tileR${i}Filler`, 'FRAME', [i * 50 + 20, 0, 20, 40]),
        ],
      }));
      doms.push(dc(`> :nth-child(${i + 1})`, 'div', [i * 50, 0, 40, 40], {
        children: [
          dc(`> :nth-child(${i + 1}) > :nth-child(1)`, 'span', [i * 50, 0, 20, 40], { text }),
          dc(`> :nth-child(${i + 1}) > :nth-child(2)`, 'div', [i * 50 + 20, 0, 20, 40]),
        ],
      }));
    }
    // WITHOUT a decoy (unlike positive-motivation (j)): the dom pool is EXACTLY N — each of the first N-1 tiles
    // (greedy, in order) takes one dom, leaving the last (i=N-1) EXACTLY one candidate →
    // its scored[1] is empty → under d57d2ff it is NOT flagged ambiguous (confirmed by a print on d57d2ff: confidence
    // 'low', signals without 'ambiguous'/'descendant-anchored' — see the report).
    const result = matchPairs(figs, doms);

    const last = result.pairs.find((p) => p.node_id === `tileR${N - 1}`);
    expect(last?.dom_path).toBe(`> :nth-child(${N})`);
    expect(last?.ambiguous).toBeUndefined(); // a terminal sibling is never ambiguous (no competitor below)
    expect(last?.confidence).toBe('medium'); // was 'low' under d57d2ff
    expect(last?.signals).toContain('descendant-anchored');

    // sanity: 1..N-1 (non-terminal) really are near-identical/anchored — the test is about the terminal one, not them.
    for (let i = 0; i < N - 1; i++) {
      expect(result.pairs.find((p) => p.node_id === `tileR${i}`)?.signals).toContain('descendant-anchored');
    }
  });

  it('(q) a terminal sibling with a SHARED title (a neighbour text-twin) stays low — the shared text is found in a competitor, does not distinguish (honesty negative, mirrors the acceptance adversarial)', () => {
    const N = 3;
    const figs: SpecChild[] = [];
    const doms: DomChild[] = [];
    const titles = ['TileS0Uniq', 'SharedTitle', 'SharedTitle']; // the last — a text-twin of the neighbour tileS1
    for (let i = 0; i < N; i++) {
      const text = titles[i];
      figs.push(fc(`tileS${i}`, 'FRAME', [i * 50, 0, 40, 40], {
        children: [
          fc(`tileS${i}Text`, 'TEXT', [i * 50, 0, 20, 40], { textSnippet: text }),
          fc(`tileS${i}Filler`, 'FRAME', [i * 50 + 20, 0, 20, 40]),
        ],
      }));
      doms.push(dc(`> :nth-child(${i + 1})`, 'div', [i * 50, 0, 40, 40], {
        children: [
          dc(`> :nth-child(${i + 1}) > :nth-child(1)`, 'span', [i * 50, 0, 20, 40], { text }),
          dc(`> :nth-child(${i + 1}) > :nth-child(2)`, 'div', [i * 50 + 20, 0, 20, 40]),
        ],
      }));
    }
    const result = matchPairs(figs, doms);

    // sanity: the terminal tileS2 REALLY carries a high descendant (text locally-unique in ITS OWN 2-element
    // subtree, even when the string is duplicated at a neighbour globally) — otherwise the test would not check the claimed scenario.
    const lastText = result.pairs.find((p) => p.node_id === 'tileS2Text');
    expect(lastText?.confidence).toBe('high');
    expect(lastText?.dom_text).toBe('SharedTitle');

    const last = result.pairs.find((p) => p.node_id === 'tileS2');
    expect(last?.dom_path).toBe('> :nth-child(3)');
    expect(last?.ambiguous).toBeUndefined();
    expect(last?.confidence).toBe('low'); // does NOT anchor — 'SharedTitle' found in a competitor (tileS1)
    expect(last?.signals).not.toContain('descendant-anchored');
  });

  it('(r) a lone worthy pair (competitors empty) stays low — an accepted limitation out of scope 🟡 (about sibling sets, not singletons)', () => {
    const soloText = fc('soloTText', 'TEXT', [0, 0, 20, 40], { textSnippet: 'SoloTUniq' });
    const soloFiller = fc('soloTFiller', 'FRAME', [20, 0, 20, 40]);
    const solo = fc('soloT', 'FRAME', [0, 0, 40, 40], { children: [soloText, soloFiller] });
    const domSpan = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 20, 40], { text: 'SoloTUniq' });
    const domFiller = dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 20, 40]);
    const domSolo = dc('> :nth-child(1)', 'div', [0, 0, 40, 40], { children: [domSpan, domFiller] });

    const result = matchPairs([solo], [domSolo]); // the only worthy dom on the level → competitors empty

    const childPair = result.pairs.find((p) => p.node_id === 'soloTText');
    expect(childPair?.confidence).toBe('high'); // sanity: a high descendant really exists

    const p = result.pairs.find((p) => p.node_id === 'soloT');
    expect(p?.ambiguous).toBeUndefined();
    expect(p?.confidence).toBe('low'); // guard competitors.length===0 → continue, not upgraded
    expect(p?.signals).not.toContain('descendant-anchored');
  });

  it('(s) non-eligible confidence (not ambiguous, not low) is not touched: a high descendant is ignored by the gate (equivalent to "clean medium" — scorePair is bimodal [0,45]∪[100,145], the 55-89 wedge is unreachable without a bump; high checks the SAME gate predicate confidence!==\'low\')', () => {
    // The parent itself carries own text (phase-1 bijection) → high, margin maximal, not ambiguous —
    // and it also has a separate high descendant. The gate `!p.ambiguous && p.confidence !== 'low'` must
    // stop on this same predicate as for a hypothetical medium — we add no signal.
    const childText = fc('uChildText', 'TEXT', [10, 0, 10, 40], { textSnippet: 'UChildDistinct' });
    const childFiller = fc('uChildFiller', 'FRAME', [20, 0, 10, 40]);
    const parent = fc('uParent', 'FRAME', [0, 0, 30, 40], { textSnippet: 'UParentUnique', children: [childText, childFiller] });
    const domChildText = dc('> :nth-child(1) > :nth-child(1)', 'span', [10, 0, 10, 40], { text: 'UChildDistinct' });
    const domChildFiller = dc('> :nth-child(1) > :nth-child(2)', 'div', [20, 0, 10, 40]);
    const domParent = dc('> :nth-child(1)', 'div', [0, 0, 30, 40], { text: 'UParentUnique', children: [domChildText, domChildFiller] });

    const result = matchPairs([parent], [domParent]);

    const childPair = result.pairs.find((p) => p.node_id === 'uChildText');
    expect(childPair?.confidence).toBe('high'); // sanity: a high descendant really exists

    const p = result.pairs.find((p) => p.node_id === 'uParent');
    expect(p?.ambiguous).toBeUndefined();
    expect(p?.confidence).toBe('high'); // not eligible — the gate does not touch it
    expect(p?.signals).not.toContain('descendant-anchored');
  });

  it('(t) CRITICAL negative Zebra (<FLOOR true home + shared string "Buy"): greed mis-assigns fig→c0 (Apple,Buy) non-ambiguous low; the true home c2 (Zebra,Buy) is mis-sized <FLOOR — the all-siblings set SCANS it (without the ≥FLOOR filter) → "Buy" found in c2 → the pair STAYS low (c2 honestly in unmatched_dom), does NOT anchor', () => {
    const zebraTitle = fc('zebraTitle', 'TEXT', [0, 0, 20, 40], { textSnippet: 'Zebra' });
    const zebraButton = fc('zebraButton', 'INSTANCE', [20, 0, 20, 40], { textSnippet: 'Buy' });
    const zebraCard = fc('zebraCard', 'FRAME', [0, 0, 50, 40], { children: [zebraTitle, zebraButton] });

    // c0 = {Apple, Buy} — greed picks it as best (size/order maximal, w=50 matches card).
    const spanApple = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 25, 40], { text: 'Apple' });
    const spanBuy0 = dc('> :nth-child(1) > :nth-child(2)', 'span', [25, 0, 25, 40], { text: 'Buy' });
    const c0 = dc('> :nth-child(1)', 'div', [0, 0, 50, 40], { children: [spanApple, spanBuy0] });
    // c1 = {Cherry, Add} w30 — score 26.25 (>=FLOOR), runner-up: margin(40-26.25=13.75)>=12 → non-ambiguous.
    const spanCherry = dc('> :nth-child(2) > :nth-child(1)', 'span', [0, 0, 15, 40], { text: 'Cherry' });
    const spanAdd = dc('> :nth-child(2) > :nth-child(2)', 'span', [15, 0, 15, 40], { text: 'Add' });
    const c1 = dc('> :nth-child(2)', 'div', [0, 0, 30, 40], { children: [spanCherry, spanAdd] });
    // c2 = {Zebra, Buy} w10 — mis-sized by a layout bug → score 12.5 (<FLOOR=25). The true home is card
    // (carries its own 'Zebra'), but greed will never pick it (score worse than c0/c1).
    const spanZebra2 = dc('> :nth-child(3) > :nth-child(1)', 'span', [0, 0, 5, 40], { text: 'Zebra' });
    const spanBuy2 = dc('> :nth-child(3) > :nth-child(2)', 'span', [5, 0, 5, 40], { text: 'Buy' });
    const c2 = dc('> :nth-child(3)', 'div', [0, 0, 10, 40], { children: [spanZebra2, spanBuy2] });

    const result = matchPairs([zebraCard], [c0, c1, c2]);

    const card = result.pairs.find((p) => p.node_id === 'zebraCard');
    // sanity: geometry REALLY mis-assigns to c0 (not c2 — the true home) non-ambiguous low.
    expect(card?.dom_path).toBe('> :nth-child(1)');
    expect(card?.ambiguous).toBeUndefined();
    expect(card?.confidence).toBe('low');

    // sanity: the only high descendant under c0 — the SHARED 'Buy' (title 'Zebra' matched to 'Apple', low).
    const button = result.pairs.find((p) => p.node_id === 'zebraButton');
    expect(button?.confidence).toBe('high');
    expect(button?.dom_text).toBe('Buy');
    const title = result.pairs.find((p) => p.node_id === 'zebraTitle');
    expect(title?.confidence).toBe('low');

    // Key check: c2 (<FLOOR) carries 'Buy' → the all-siblings scan (without the ≥FLOOR filter) must
    // see it → 'Buy' does not distinguish → the anchor is BLOCKED, the pair stays low.
    expect(card?.signals).not.toContain('descendant-anchored');
    // c2 honestly in unmatched_dom (not swallowed, not a forced pair).
    expect(result.unmatched_dom.some((u) => u.dom_path === '> :nth-child(3)')).toBe(true);

    // Boundary control: widen c2 to w40 (score 27.5 >= FLOOR) — it also does NOT anchor (it was already scanned
    // even under the old ≥FLOOR filter) — pins that the fix closes exactly the <FLOOR blindness, does not change
    // behavior for already-visible competitors.
    const spanZebraWide = dc('> :nth-child(3) > :nth-child(1)', 'span', [0, 0, 20, 40], { text: 'Zebra' });
    const spanBuyWide = dc('> :nth-child(3) > :nth-child(2)', 'span', [20, 0, 20, 40], { text: 'Buy' });
    const c2Wide = dc('> :nth-child(3)', 'div', [0, 0, 40, 40], { children: [spanZebraWide, spanBuyWide] });
    const resultWide = matchPairs([zebraCard], [c0, c1, c2Wide]);
    const cardWide = resultWide.pairs.find((p) => p.node_id === 'zebraCard');
    expect(cardWide?.ambiguous).toBeUndefined();
    expect(cardWide?.confidence).toBe('low');
    expect(cardWide?.signals).not.toContain('descendant-anchored');
  });
});

// Post-implementation finding: flattenText did not check childrenTruncated (the extractor's honest
// truncation, #4) — a truncated competitor is invisible to the scan → its distinguishing content is missed →
// the anchor string is falsely read as unique → a false anchor (truncation ACTIVELY produces extra
// confidence — an inversion of honest-trust). (u) — the low-non-ambiguous form (a detector, reachable only
// after the low decoupling; (v) — the ambiguous form (a pre-existing hole, a detector on
// d57d2ff too, not only 5fbc1e0).
describe('matchPairs: truncation-aware competitor scan (childrenTruncated competitor = content-unknown, no anchor)', () => {
  it('(u) Scenario L (low-non-ambiguous, mirrors Zebra (t)): the true home competitor c2 — a leaf with childrenTruncated:true, WITHOUT children ({Zebra,Buy} cut by the extractor) → the scan does not see "Buy" under c2 → WITHOUT the fix a false upgrade low→medium+descendant-anchored (the prior logic); with the fix the pair stays low', () => {
    const zebraTitle = fc('zebraTitleX', 'TEXT', [0, 0, 20, 40], { textSnippet: 'Zebra' });
    const zebraButton = fc('zebraButtonX', 'INSTANCE', [20, 0, 20, 40], { textSnippet: 'Buy' });
    const zebraCard = fc('zebraCardX', 'FRAME', [0, 0, 50, 40], { children: [zebraTitle, zebraButton] });

    // c0 = {Apple, Buy} — greed picks it as best (as in (t)).
    const spanApple = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 25, 40], { text: 'Apple' });
    const spanBuy0 = dc('> :nth-child(1) > :nth-child(2)', 'span', [25, 0, 25, 40], { text: 'Buy' });
    const c0 = dc('> :nth-child(1)', 'div', [0, 0, 50, 40], { children: [spanApple, spanBuy0] });
    // c1 = {Cherry, Add} w30 — as in (t), non-ambiguous margin.
    const spanCherry = dc('> :nth-child(2) > :nth-child(1)', 'span', [0, 0, 15, 40], { text: 'Cherry' });
    const spanAdd = dc('> :nth-child(2) > :nth-child(2)', 'span', [15, 0, 15, 40], { text: 'Add' });
    const c1 = dc('> :nth-child(2)', 'div', [0, 0, 30, 40], { children: [spanCherry, spanAdd] });
    // c2 — the TRUE home (would carry {Zebra,Buy}), but the extractor honestly cut its children at the depth-cap:
    // childrenTruncated:true, children absent. The scan (flattenText) sees '' — content-unknown,
    // not "empty and safe".
    const c2 = dc('> :nth-child(3)', 'div', [0, 0, 10, 40], { childrenTruncated: true });

    const result = matchPairs([zebraCard], [c0, c1, c2]);

    const card = result.pairs.find((p) => p.node_id === 'zebraCardX');
    // sanity: the same mis-geometry as in (t) — greed mis-assigns to c0, non-ambiguous low.
    expect(card?.dom_path).toBe('> :nth-child(1)');
    expect(card?.ambiguous).toBeUndefined();

    // sanity: the only high descendant under c0 — 'Buy' (title 'Zebra' matched to 'Apple', low).
    const button = result.pairs.find((p) => p.node_id === 'zebraButtonX');
    expect(button?.confidence).toBe('high');
    expect(button?.dom_text).toBe('Buy');

    // Key check: c2 truncated → content-unknown → do NOT anchor through it.
    // Print (for the report): on 5fbc1e0 without the fix this would be confidence 'medium' +
    // signals contains 'descendant-anchored' (a false anchor — a detector).
    expect(card?.confidence).toBe('low');
    expect(card?.signals).not.toContain('descendant-anchored');
    // c2 honestly in unmatched_dom (not swallowed, not a forced pair).
    expect(result.unmatched_dom.some((u) => u.dom_path === '> :nth-child(3)')).toBe(true);
  });

  it('(v) Scenario M (ambiguous, a pre-existing hole): the true home competitor is truncated (childrenTruncated:true, mirrors (c), but with no visible "Buy" string) → the scan does not see the shared string → WITHOUT the fix mis-anchors (ambiguous removed, the prior logic); with the fix ambiguous stays', () => {
    const plitkaA = fc('plitkaAM', 'FRAME', [0, 0, 40, 40], {
      children: [
        fc('buttonAM', 'INSTANCE', [0, 0, 20, 40], { textSnippet: 'Buy' }),
        fc('fillerAM', 'FRAME', [20, 0, 20, 40]),
      ],
    });
    const plitkaB = fc('plitkaBM', 'FRAME', [50, 0, 32, 32], {
      children: [
        fc('buttonBM', 'INSTANCE', [50, 0, 16, 32]), // no textSnippet — Figma asymmetry, as in (c)
        fc('fillerBM', 'FRAME', [66, 0, 16, 32]),
      ],
    });
    // domX — the TRUE home competitor (the same role as domX in (c) adv1), but truncated by the extractor:
    // its {Buy-span} is not extracted, only childrenTruncated:true. Geometry (30×30) does NOT change —
    // domText(domX) was undefined in (c) too (own .text not set, children kind:'element'), so the score/
    // ambiguous determination is identical to (c); only the visibility of content to the scan changes.
    const domX = dc('> :nth-child(1)', 'div', [0, 0, 30, 30], { childrenTruncated: true });
    const domY = dc('> :nth-child(2)', 'div', [50, 0, 40, 40], {
      children: [
        dc('> :nth-child(2) > :nth-child(1)', 'span', [50, 0, 20, 40], { text: 'Buy' }),
        dc('> :nth-child(2) > :nth-child(2)', 'div', [70, 0, 20, 40]),
      ],
    });

    const result = matchPairs([plitkaA, plitkaB], [domX, domY]);

    const a = result.pairs.find((p) => p.node_id === 'plitkaAM');
    // sanity: the same mis-geometry as (c) — plitkaA mis-assigned to domY (not the true domX).
    expect(a?.dom_path).toBe('> :nth-child(2)');

    const buttonAPair = result.pairs.find((p) => p.node_id === 'buttonAM');
    expect(buttonAPair?.confidence).toBe('high');
    expect(buttonAPair?.dom_text).toBe('Buy');

    // Key check: domX (the true home competitor) is truncated → the scan does not see its content →
    // without the fix it would decide "Buy" is unique and remove ambiguous (a mis-anchor). With the fix ambiguous stays —
    // content-unknown blocks the anchor just like a visible matching string in (c).
    expect(a?.ambiguous).toBe(true);
    expect(a?.candidates?.some((c) => c.dom_path === '> :nth-child(1)')).toBe(true);
    expect(a?.signals).not.toContain('descendant-anchored');
  });
});

// Final gate: subtreeTruncated closed "content unknown INSIDE a present competitor",
// but NOT "a competitor DROPPED from the list entirely". When a container dom is cut by the number of
// children (childrenTruncated on the PARENT/root — the extractor cuts >15 nested/>30 root), the true
// competitor with the shared anchor string is ABSENT from the sibling list wd → the string is falsely unique among
// the survivors → a false anchor. (w) — the root form (A, suggest-pairs-tool did not pass
// dom.childrenTruncated); (x) — the nested form (B, walk did not carry dx.d.childrenTruncated). Both —
// detectors on the prior logic.
describe('matchPairs: sibling-list truncation blocks anchor (dropped competitor = content-unknown)', () => {
  it('(w) the root sibling list is truncated (rootDomTruncated): the true competitor c2 (would carry the shared "Buy") is ENTIRELY ABSENT from doms (not just its content truncated) → WITHOUT the fix "Buy" is falsely unique among the present c0/c1 → anchors; with the fix (rootDomTruncated:true) it stays low (the list is incomplete — the true competitor could have been dropped)', () => {
    const zebraTitle = fc('zebraTitleCh', 'TEXT', [0, 0, 20, 40], { textSnippet: 'Zebra' });
    const zebraButton = fc('zebraButtonCh', 'INSTANCE', [20, 0, 20, 40], { textSnippet: 'Buy' });
    const zebraCard = fc('zebraCardCh', 'FRAME', [0, 0, 50, 40], { children: [zebraTitle, zebraButton] });

    // c0 = {Apple, Buy} — greed picks it as best (as in (t)/(u)).
    const spanApple = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 25, 40], { text: 'Apple' });
    const spanBuy0 = dc('> :nth-child(1) > :nth-child(2)', 'span', [25, 0, 25, 40], { text: 'Buy' });
    const c0 = dc('> :nth-child(1)', 'div', [0, 0, 50, 40], { children: [spanApple, spanBuy0] });
    // c1 = {Cherry, Add} w30 — non-ambiguous margin (as in (t)/(u)).
    const spanCherry = dc('> :nth-child(2) > :nth-child(1)', 'span', [0, 0, 15, 40], { text: 'Cherry' });
    const spanAdd = dc('> :nth-child(2) > :nth-child(2)', 'span', [15, 0, 15, 40], { text: 'Add' });
    const c1 = dc('> :nth-child(2)', 'div', [0, 0, 30, 40], { children: [spanCherry, spanAdd] });
    // c2 (would carry {Zebra, Buy}) is ENTIRELY absent from doms — the root list is cut by the extractor's
    // cap (>30 direct children), not just its content. wd sees only [c0, c1].

    const result = matchPairs([zebraCard], [c0, c1], { rootDomTruncated: true });

    const card = result.pairs.find((p) => p.node_id === 'zebraCardCh');
    // sanity: the same mis-geometry as (t)/(u) — greed mis-assigns to c0, non-ambiguous low.
    expect(card?.dom_path).toBe('> :nth-child(1)');
    expect(card?.ambiguous).toBeUndefined();

    const button = result.pairs.find((p) => p.node_id === 'zebraButtonCh');
    expect(button?.confidence).toBe('high');
    expect(button?.dom_text).toBe('Buy');

    // Key check: rootDomTruncated:true → the root sibling list is incomplete → do not
    // anchor, even when "Buy" is technically unique among the PRESENT c0/c1. On 94f9f00 (without
    // the fix) rootDomTruncated is ignored by the runtime (the field is not read) → this MIS-anchors
    // (confidence 'medium' + 'descendant-anchored') — a detector.
    expect(card?.confidence).toBe('low');
    expect(card?.signals).not.toContain('descendant-anchored');
  });

  it('(x) a nested container is truncated (childrenTruncated on the dom parent): its children = the surviving siblings (the true competitor with the shared "Buy" dropped entirely from children) → the pair ON THIS LEVEL mis-anchors WITHOUT the fix; with the fix it stays low', () => {
    // A depth-1 "card" scenario (mirrors (t)/(u)/(w)), nested one level deeper under an outer wrapper.
    const zebraTitle = fc('zebraTitleSh', 'TEXT', [0, 0, 20, 40], { textSnippet: 'Zebra' });
    const zebraButton = fc('zebraButtonSh', 'INSTANCE', [20, 0, 20, 40], { textSnippet: 'Buy' });
    const zebraCard = fc('zebraCardSh', 'FRAME', [0, 0, 50, 40], { children: [zebraTitle, zebraButton] });
    // outerFig — INSTANCE (worthy REGARDLESS of child count — prevents figUnwrap from falling through
    // the single-child wrapper to zebraCard, which would eat the nesting and reduce the test to (w)).
    const outerFig = fc('outerFigSh', 'INSTANCE', [0, 0, 50, 40], { children: [zebraCard] });

    const spanApple = dc('> :nth-child(1) > :nth-child(1)', 'span', [0, 0, 25, 40], { text: 'Apple' });
    const spanBuy0 = dc('> :nth-child(1) > :nth-child(2)', 'span', [25, 0, 25, 40], { text: 'Buy' });
    const c0 = dc('> :nth-child(1)', 'div', [0, 0, 50, 40], { children: [spanApple, spanBuy0] });
    const spanCherry = dc('> :nth-child(2) > :nth-child(1)', 'span', [0, 0, 15, 40], { text: 'Cherry' });
    const spanAdd = dc('> :nth-child(2) > :nth-child(2)', 'span', [15, 0, 15, 40], { text: 'Add' });
    const c1 = dc('> :nth-child(2)', 'div', [0, 0, 30, 40], { children: [spanCherry, spanAdd] });
    // outerDom — a container dom, a wrapper over c0/c1; the extractor honestly cut ITS CHILDREN LIST
    // (childrenTruncated:true) — the true competitor (would carry {Zebra, Buy}) is dropped ENTIRELY from
    // children, not merely trimmed inside (this is NOT the subtreeTruncated case — c0/c1 themselves
    // are not truncated, their PARENT list is).
    const outerDom = dc('> :nth-child(1)', 'div', [0, 0, 50, 40], { children: [c0, c1], childrenTruncated: true });

    const result = matchPairs([outerFig], [outerDom]);

    const card = result.pairs.find((p) => p.node_id === 'zebraCardSh');
    // sanity: the same mis-geometry — greed mis-assigns card to c0, non-ambiguous low.
    expect(card?.dom_path).toBe('> :nth-child(1)');
    expect(card?.ambiguous).toBeUndefined();

    const button = result.pairs.find((p) => p.node_id === 'zebraButtonSh');
    expect(button?.confidence).toBe('high');
    expect(button?.dom_text).toBe('Buy');

    // Key check (nested form B): outerDom.childrenTruncated:true → the sibling list of
    // THIS level (c0/c1) is incomplete → do not anchor "card", even when "Buy" is unique among
    // the present c0/c1. On 94f9f00 (without the fix) walk does not carry dx.d.childrenTruncated →
    // MIS-anchors (confidence 'medium' + 'descendant-anchored') — a detector.
    expect(card?.confidence).toBe('low');
    expect(card?.signals).not.toContain('descendant-anchored');
  });
});

// Live acceptance: truncatedLevelPairs marks ONLY the level whose OWN
// committed dom is truncated (dx.d.childrenTruncated at line 122) — it does not inherit to descendants
// committed UNDER a truncated ancestor. The parent tile honestly over-refuses (its own level
// levelTruncated=true — inherited DIRECTLY from the container, already covered), but ONE
// level DEEPER (inside the tile) its committed dom is NOT itself truncated → without inheriting levelTruncated
// it is falsely false there → the nested Text frame anchors, even though the committed position of the ancestor tile (and everything under
// it) is unreliable due to the LIST truncation one level up. (y) — a detector on the prior logic.
describe('matchPairs: inherit truncation down the recursion (nested anchor under truncated ancestor over-refuses)', () => {
  it('(y) a nested anchor under a truncated ANCESTOR (not its own level): container childrenTruncated:true > 2 near-identical tiles (honestly over-refuse, on THEIR OWN level) > INSIDE a tile a Text frame (itself low+ambiguous among its 2 OWN siblings, whose own committed dom is NOT truncated) with a distinguishing high descendant "UniqueLabel" → WITHOUT the fix the Text frame anchors medium+descendant-anchored (own levelTruncated=false, no inheritance); WITH the fix it inherits levelTruncated=true from the ancestor → stays low, WITHOUT descendant-anchored', () => {
    // Level 3 (inside the Text frame): a distinguishing high descendant "UniqueLabel" + a decoy neighbour "Decoy".
    const uniqueLabelFig = fc('uniqueLabelFig', 'TEXT', [0, 0, 12, 20], { textSnippet: 'UniqueLabel' });
    const decoyFig = fc('decoyFig', 'TEXT', [0, 20, 12, 20], { textSnippet: 'Decoy' });
    // Level 2 (inside tile A): textFrame — itself low+ambiguous among siblingFig (near-identical
    // size → margin<12). BOTH — 2 children (not 1!), otherwise figUnwrap/domUnwrap falls through
    // the single-child wrapper (C1) and the "Text frame" as a separate pair disappears (see (x): the same guard
    // at c0/c1 — without 2 children domWorthy(textFrameDom) would be false, domUnwrap would dive to a leaf).
    const otherFig1 = fc('otherFig1', 'TEXT', [0, 0, 13, 20], { textSnippet: 'Other1' });
    const otherFig2 = fc('otherFig2', 'TEXT', [0, 20, 13, 20], { textSnippet: 'Other2' });
    const textFrameFig = fc('textFrameFig', 'FRAME', [0, 0, 12, 40], { children: [uniqueLabelFig, decoyFig] });
    const siblingFig = fc('siblingFig', 'FRAME', [12, 0, 13, 40], { children: [otherFig1, otherFig2] });
    // Level 1 (tiles): tileFigA carries the Text frame; tileFigB — an empty leaf competitor (terminal,
    // not involved in the assert — needed only so Level 1 is "≥2 near-identical tiles").
    const tileFigA = fc('tileFigA', 'FRAME', [0, 0, 25, 40], { children: [textFrameFig, siblingFig] });
    const tileFigB = fc('tileFigB', 'FRAME', [25, 0, 25, 40], {});
    // Level 0: the container — childrenTruncated:true (the ONLY truncation in the whole structure; neither
    // tileDomA nor textFrameDom carries its OWN childrenTruncated — the entire effect must come
    // EXCLUSIVELY through inheriting levelTruncated down the recursion).
    const containerFig = fc('containerFig', 'INSTANCE', [0, 0, 50, 40], { children: [tileFigA, tileFigB] });

    const uniqueLabelDom = dc('> :nth-child(1) > :nth-child(1) > :nth-child(1) > :nth-child(1)', 'span', [0, 0, 12, 20], { text: 'UniqueLabel' });
    const decoyDom = dc('> :nth-child(1) > :nth-child(1) > :nth-child(1) > :nth-child(2)', 'span', [0, 20, 12, 20], { text: 'Decoy' });
    const otherDom1 = dc('> :nth-child(1) > :nth-child(1) > :nth-child(2) > :nth-child(1)', 'span', [0, 0, 13, 20], { text: 'Other1' });
    const otherDom2 = dc('> :nth-child(1) > :nth-child(1) > :nth-child(2) > :nth-child(2)', 'span', [0, 20, 13, 20], { text: 'Other2' });
    const textFrameDom = dc('> :nth-child(1) > :nth-child(1) > :nth-child(1)', 'div', [0, 0, 12, 40], { children: [uniqueLabelDom, decoyDom] });
    const siblingDom = dc('> :nth-child(1) > :nth-child(1) > :nth-child(2)', 'div', [12, 0, 13, 40], { children: [otherDom1, otherDom2] });
    const tileDomA = dc('> :nth-child(1) > :nth-child(1)', 'div', [0, 0, 25, 40], { children: [textFrameDom, siblingDom] });
    const tileDomB = dc('> :nth-child(1) > :nth-child(2)', 'div', [25, 0, 25, 40], {});
    const containerDom = dc('> :nth-child(1)', 'div', [0, 0, 50, 40], { children: [tileDomA, tileDomB], childrenTruncated: true });

    const result = matchPairs([containerFig], [containerDom]);

    // Sanity (the parent tiles honestly over-refuse on THEIR OWN level — not a new bug, already
    // covered directly: containerDom.childrenTruncated===true is passed into Level 1 WITHOUT
    // needing inheritance).
    const tileA = result.pairs.find((p) => p.node_id === 'tileFigA');
    expect(tileA?.dom_path).toBe('> :nth-child(1) > :nth-child(1)');
    expect(tileA?.confidence).toBe('low');
    expect(tileA?.signals).not.toContain('descendant-anchored');

    // Key check: the nested Text frame — its own committed dom (textFrameDom) does NOT
    // carry childrenTruncated, but must inherit levelTruncated=true from the truncated ancestor
    // (containerDom) through the recursion container→tile→textFrame.
    const textFrame = result.pairs.find((p) => p.node_id === 'textFrameFig');
    expect(textFrame?.dom_path).toBe('> :nth-child(1) > :nth-child(1) > :nth-child(1)');
    expect(textFrame?.confidence).toBe('low');
    expect(textFrame?.signals).not.toContain('descendant-anchored');
  });

  it('(z) the inheritance latch reaches ARBITRARY depth: truncation ONLY at the great-ancestor L0, the anchoring pair 2 hops deeper (L3), all intermediate committed doms WITHOUT their own childrenTruncated → WITHOUT the fix the L3 pair anchors (no inheritance, each level sees only its own false); WITH the fix latch true propagates L0→L1→L2→L3 → the L3 pair over-refuses. Locks the monotonicity of the latch against a regression (a cap on inheritance depth)', () => {
    // L4 (inside textFrame): a distinguishing high descendant "DeepUnique" + a decoy.
    const deepUniqueFig = fc('deepUniqueFig', 'TEXT', [0, 0, 12, 20], { textSnippet: 'DeepUnique' });
    const deepDecoyFig = fc('deepDecoyFig', 'TEXT', [0, 20, 12, 20], { textSnippet: 'DeepDecoy' });
    const sibLeaf1Fig = fc('sibLeaf1Fig', 'TEXT', [0, 0, 13, 20], { textSnippet: 'SibOne' });
    const sibLeaf2Fig = fc('sibLeaf2Fig', 'TEXT', [0, 20, 13, 20], { textSnippet: 'SibTwo' });
    // L3 (inside tileA): textFrame itself low+ambiguous among frameSib (near-identical size, margin<12).
    const textFrameFig = fc('textFrameFig', 'FRAME', [0, 0, 12, 40], { children: [deepUniqueFig, deepDecoyFig] });
    const frameSibFig = fc('frameSibFig', 'FRAME', [12, 0, 13, 40], { children: [sibLeaf1Fig, sibLeaf2Fig] });
    // L2 (inside groupA): tileA carries textFrame; tileB — near-identical (commits+descends).
    const tileAFig = fc('tileAFig', 'FRAME', [0, 0, 25, 40], { children: [textFrameFig, frameSibFig] });
    const tileBFig = fc('tileBFig', 'FRAME', [25, 0, 25, 40], {});
    // L1 (inside container): groupA carries tileA; groupB — near-identical.
    const groupAFig = fc('groupAFig', 'FRAME', [0, 0, 50, 40], { children: [tileAFig, tileBFig] });
    const groupBFig = fc('groupBFig', 'FRAME', [50, 0, 50, 40], {});
    // L0: the container — childrenTruncated:true is the ONLY truncation; neither the group/tile/textFrame doms
    // carry their OWN flags → the entire effect at L3 must come through 2 hops of inheritance.
    const containerFig = fc('containerFig', 'INSTANCE', [0, 0, 100, 40], { children: [groupAFig, groupBFig] });

    const p0 = '> :nth-child(1)';
    const pGA = p0 + ' > :nth-child(1)';
    const pGB = p0 + ' > :nth-child(2)';
    const pTA = pGA + ' > :nth-child(1)';
    const pTB = pGA + ' > :nth-child(2)';
    const pTF = pTA + ' > :nth-child(1)';
    const pFS = pTA + ' > :nth-child(2)';
    const deepUniqueDom = dc(pTF + ' > :nth-child(1)', 'span', [0, 0, 12, 20], { text: 'DeepUnique' });
    const deepDecoyDom = dc(pTF + ' > :nth-child(2)', 'span', [0, 20, 12, 20], { text: 'DeepDecoy' });
    const sibLeaf1Dom = dc(pFS + ' > :nth-child(1)', 'span', [0, 0, 13, 20], { text: 'SibOne' });
    const sibLeaf2Dom = dc(pFS + ' > :nth-child(2)', 'span', [0, 20, 13, 20], { text: 'SibTwo' });
    const textFrameDom = dc(pTF, 'div', [0, 0, 12, 40], { children: [deepUniqueDom, deepDecoyDom] });
    const frameSibDom = dc(pFS, 'div', [12, 0, 13, 40], { children: [sibLeaf1Dom, sibLeaf2Dom] });
    const tileADom = dc(pTA, 'div', [0, 0, 25, 40], { children: [textFrameDom, frameSibDom] });
    const tileBDom = dc(pTB, 'div', [25, 0, 25, 40], {});
    const groupADom = dc(pGA, 'div', [0, 0, 50, 40], { children: [tileADom, tileBDom] });
    const groupBDom = dc(pGB, 'div', [50, 0, 50, 40], {});
    const containerDom = dc(p0, 'div', [0, 0, 100, 40], { children: [groupADom, groupBDom], childrenTruncated: true });

    const result = matchPairs([containerFig], [containerDom]);

    // The L3 pair (2 hops of inheritance from the truncated L0) must over-refuse.
    const textFrame = result.pairs.find((p) => p.node_id === 'textFrameFig');
    expect(textFrame?.dom_path).toBe(pTF);
    expect(textFrame?.confidence).toBe('low');
    expect(textFrame?.signals).not.toContain('descendant-anchored');
  });
});

describe('phase-0 helpers (salvage-nested)', () => {
  const fig = (id: string, extra: Partial<SpecChild> = {}): SpecChild =>
    ({ id, name: id, type: 'FRAME', rect: { x: 0, y: 0, w: 100, h: 20 }, ...extra }) as SpecChild;
  const domEl = (extra: Partial<DomChild> = {}): DomChild =>
    ({ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 20 }, ...extra }) as DomChild;

  it('collectFigSnippets: recursively all textSnippet of the subtree, incl. its own', () => {
    const c = fig('1:1', { textSnippet: 'own', children: [
      fig('1:2', { children: [fig('1:3', { textSnippet: 'deep' })] }),
      fig('1:4', { textSnippet: 'mid' })] });
    expect(collectFigSnippets(c).sort()).toEqual(['deep', 'mid', 'own']);
  });
  it('collectDomTextUnits: recursively all .text (element and text kind)', () => {
    const d = domEl({ text: 'own', children: [
      { kind: 'text', rect: { x: 0, y: 0, w: 10, h: 10 }, text: 'bare' } as DomChild,
      domEl({ children: [domEl({ text: 'deep' })] })] });
    expect(collectDomTextUnits(d).sort()).toEqual(['bare', 'deep', 'own']);
  });
  it('figContentUnknown: childrenTruncated recursively → truncation; OR textSnippet.length >= SNIPPET_CAP → longtext; neither → undefined', () => {
    expect(figContentUnknown(fig('a', { children: [fig('b', { childrenTruncated: true })] }))).toBe('truncation');
    expect(figContentUnknown(fig('a', { children: [fig('b', { textSnippet: 'x'.repeat(SNIPPET_CAP) })] }))).toBe('longtext');
    expect(figContentUnknown(fig('a', { textSnippet: 'x'.repeat(SNIPPET_CAP - 1) }))).toBeUndefined();
  });
  it('domContentUnknown: childrenTruncated recursively → truncation; OR text.length >= SNIPPET_CAP → longtext; neither → undefined', () => {
    expect(domContentUnknown(domEl({ children: [domEl({ childrenTruncated: true })] }))).toBe('truncation');
    expect(domContentUnknown(domEl({ children: [domEl({ text: 'y'.repeat(SNIPPET_CAP) })] }))).toBe('longtext');
    expect(domContentUnknown(domEl({ text: 'y'.repeat(SNIPPET_CAP - 1) }))).toBeUndefined();
  });
  it('figContentUnknown: priority of truncation over longtext WITHIN one subtree (both found → truncation)', () => {
    expect(figContentUnknown(fig('a', { children: [
      fig('b', { childrenTruncated: true }),
      fig('c', { textSnippet: 'x'.repeat(SNIPPET_CAP) })] }))).toBe('truncation');
  });
  it('domContentUnknown: priority of truncation over longtext WITHIN one subtree (both found → truncation)', () => {
    expect(domContentUnknown(domEl({ children: [
      domEl({ childrenTruncated: true }),
      domEl({ text: 'y'.repeat(SNIPPET_CAP) })] }))).toBe('truncation');
  });
  it('threshold boundary: text of length SNIPPET_CAP-1 is NOT unknown; exactly SNIPPET_CAP — unknown (value lock 120)', () => {
    expect(figContentUnknown(fig('a', { textSnippet: 'x'.repeat(SNIPPET_CAP - 1) }))).toBeUndefined();
    expect(figContentUnknown(fig('a', { textSnippet: 'x'.repeat(SNIPPET_CAP) }))).toBe('longtext');
    expect(SNIPPET_CAP).toBe(120); // explicit VALUE lock — the mutation "return 40" → RED here
  });
});

describe('matchChildrenOneLevel phase-0 (nested bijection)', () => {
  const card = (id: string, deepTexts: string[], x = 0): SpecChild =>
    ({ id, name: id, type: 'INSTANCE', rect: { x, y: 0, w: 100, h: 100 }, children: [
      { id: `${id}c`, name: 'content', type: 'FRAME', rect: { x, y: 0, w: 100, h: 100 },
        children: deepTexts.map((t, k) => ({ id: `${id}t${k}`, name: t, type: 'TEXT',
          rect: { x, y: k * 20, w: 90, h: 18 }, textSnippet: t })) } ] }) as SpecChild;
  const domCard = (texts: string[], x = 0): DomChild =>
    ({ kind: 'element', tag: 'article', rect: { x, y: 0, w: 100, h: 100 }, children: [
      { kind: 'element', tag: 'div', rect: { x, y: 0, w: 100, h: 100 },
        children: texts.map((t, k) => ({ kind: 'element', tag: 'span',
          rect: { x, y: k * 20, w: 90, h: 18 }, text: t })) } ] }) as DomChild;
  const PAR = { w: 400, h: 100 };

  it('DS case: instances without own textSnippet + unique deep texts → high bijection (spec-test 1)', () => {
    const figs = [card('1:1', ['Алый парус', '299 ₽']), card('1:2', ['Белый клык', '349 ₽'])];
    const doms = [domCard(['Белый клык', '349 ₽'], 200), domCard(['Промо-баннер'], 400), domCard(['Алый парус', '299 ₽'], 0)];
    const r = matchChildrenOneLevel(figs, doms, PAR, PAR);
    const high = r.matched.filter((m) => m.confidence === 'high');
    expect(high).toEqual([ { figIdx: 0, domIdx: 2, confidence: 'high' }, { figIdx: 1, domIdx: 0, confidence: 'high' } ]);
    expect(r.nestedAnchorMuted).toBeUndefined();
    // Duplicate «299 ₽»? NO — the prices differ; the anchor is by both title and price — both point to ONE dom.
  });
  it('confirm = exact-per-node: S="Save" is NOT confirmed by the dom node "Saved to wishlist" (superstring; spec-test 2a)', () => {
    const figs = [card('1:1', ['Save'])];
    const doms = [domCard(['Saved to wishlist']), domCard(['Другое'])];
    const high = matchChildrenOneLevel(figs, doms, PAR, PAR).matched.filter((m) => m.confidence === 'high');
    expect(high).toEqual([]); // the mutation "substring on confirm" → high on the superstring → RED
  });
  it('confirm: cross-node concatenation «Ку»+«пить» does NOT fabricate S=«Купить» (spec-test 2b)', () => {
    const figs = [card('1:1', ['Купить'])];
    const doms = [domCard(['Ку', 'пить']), domCard(['Другое'])];
    expect(matchChildrenOneLevel(figs, doms, PAR, PAR).matched.filter((m) => m.confidence === 'high')).toEqual([]);
  });
  it('fig-blocking: a duplicate of nested text among fig siblings → anchors only the unique one (spec-test 3)', () => {
    // PANEL (blocker): «Купить» must be discrete in EXACTLY ONE dom — otherwise the confirm gate
    // (hits.length!==1) mutes it itself and fig-blocking is left toothless (mutation m5 is not red).
    const figs = [card('1:1', ['Купить', 'Уникальный заголовок']), card('1:2', ['Купить'])];
    const doms = [domCard(['Купить', 'Уникальный заголовок']), domCard(['Баннер'])];
    const high = matchChildrenOneLevel(figs, doms, PAR, PAR).matched.filter((m) => m.confidence === 'high');
    expect(high).toEqual([{ figIdx: 0, domIdx: 0, confidence: 'high' }]); // 1:1 by title; 1:2 without a unique S
    // m5 "remove fig-blocking" → both f target dom0 by «Купить» (hits=1!) → collision → high=[] → RED here.
  });
  it('dom-blocking: S in split spans in ANOTHER dom sibling blocks the anchor (spec-test 4)', () => {
    const figs = [card('1:1', ['Купить'])];
    const doms = [domCard(['Купить']), domCard(['Ку', 'пить'])]; // the competitor concatenation contains S
    expect(matchChildrenOneLevel(figs, doms, PAR, PAR).matched.filter((m) => m.confidence === 'high')).toEqual([]);
    // the mutation "confirm without the blocking scan of others" → high on doms[0] → RED
  });
  it('contentUnknown mutes phase-0 entirely + nestedAnchorMuted with the precise reason (spec-test 5a/5b)', () => {
    const truncDom = domCard(['x'.repeat(SNIPPET_CAP)]);              // per-node truncation without a flag — longtext
    const figs = [card('1:1', ['Уникальный'])];
    const r1 = matchChildrenOneLevel(figs, [domCard(['Уникальный']), truncDom], PAR, PAR);
    expect(r1.matched.filter((m) => m.confidence === 'high')).toEqual([]);
    expect(r1.nestedAnchorMuted).toBe('longtext'); // SNIPPET_CAP text, no childrenTruncated on this level
    const truncFig = card('9:9', []); (truncFig.children![0] as SpecChild).childrenTruncated = true;
    const r2 = matchChildrenOneLevel([...figs, truncFig], [domCard(['Уникальный']), domCard(['Б'])], PAR, PAR);
    expect(r2.matched.filter((m) => m.confidence === 'high')).toEqual([]);
    expect(r2.nestedAnchorMuted).toBe('truncation'); // childrenTruncated — a capture cut, not text length
    // the mutation "guard only childrenTruncated" → r1 anchors → RED
  });
  it('S.length===SNIPPET_CAP → not an anchor candidate (spec-test 5c) — but the sibling itself is content-unknown (longtext)', () => {
    // Design consequence: a fig text of exactly SNIPPET_CAP makes ITS OWN subtree content-unknown → phase-0 is muted.
    const figs = [card('1:1', ['x'.repeat(SNIPPET_CAP)]), card('1:2', ['Другое'])];
    const r = matchChildrenOneLevel(figs, [domCard(['Другое']), domCard(['Ю'])], PAR, PAR);
    expect(r.matched.filter((m) => m.confidence === 'high')).toEqual([]);
    expect(r.nestedAnchorMuted).toBe('longtext'); // no sibling is childrenTruncated
  });
  it('priority of truncation over longtext ACROSS the level siblings: one truncated + another longtext → truncation', () => {
    const truncFig = card('9:9', []); (truncFig.children![0] as SpecChild).childrenTruncated = true;
    const figs = [card('1:1', ['Уникальный']), truncFig];
    const longtextDom = domCard(['x'.repeat(SNIPPET_CAP)]);
    const r = matchChildrenOneLevel(figs, [domCard(['Уникальный']), longtextDom], PAR, PAR);
    expect(r.matched.filter((m) => m.confidence === 'high')).toEqual([]);
    expect(r.nestedAnchorMuted).toBe('truncation'); // the truncation sibling outweighs the longtext sibling
    // the mutation "priority longtext" → the note/reason would become 'longtext' → RED
  });
  it('live acceptance case #101: titles 51-60 chars are NO LONGER longtext → phase-0 anchors the carousel', () => {
    // 3 cards: titles 55, 60 chars (unique "book" strings) and 32 chars; DOM has 4 children
    // (the same texts deep + a banner) — WITHOUT truncation. Assert: 3 high, nestedAnchorMuted undefined.
    // At a cap of 40 this test would be muted — that is exactly this pass's delivery.
    // t49/t58: 40 ≤ len < SNIPPET_CAP (the "was longtext at a cap of 40" class); t32 < 40 (actual lengths
    // 49/58/32 — the panel fixed the names). The anti-drift below locks the actual lengths.
    const t49 = 'Анна Джейн. Разреши любить. Часть вторая. Роман о';
    const t58 = 'Анна Джейн. На волнах оригами. Музыкальный приворот. Книга';
    const t32 = 'Анна Джейн. Музыкальный приворот';
    expect(t49.length).toBeGreaterThanOrEqual(40);
    expect(t49.length).toBeLessThan(SNIPPET_CAP);
    expect(t58.length).toBeGreaterThanOrEqual(40);
    expect(t58.length).toBeLessThan(SNIPPET_CAP);
    expect(t32.length).toBeLessThan(40);
    const figs = [card('1:1', [t49]), card('1:2', [t58]), card('1:3', [t32])];
    const doms = [domCard([t32]), domCard(['Промо']), domCard([t58]), domCard([t49])];
    const r = matchChildrenOneLevel(figs, doms, PAR, PAR);
    expect(r.nestedAnchorMuted).toBeUndefined();
    expect(r.matched.filter((m) => m.confidence === 'high')).toEqual([
      { figIdx: 0, domIdx: 3, confidence: 'high' }, { figIdx: 1, domIdx: 2, confidence: 'high' }, { figIdx: 2, domIdx: 0, confidence: 'high' }]);
  });
  it('contradiction: two S of one f point to DIFFERENT d → f does not anchor (spec-test 6)', () => {
    const figs = [card('1:1', ['Альфа', 'Бета'])];
    const doms = [domCard(['Альфа']), domCard(['Бета']), domCard(['Гамма'])];
    expect(matchChildrenOneLevel(figs, doms, PAR, PAR).matched.filter((m) => m.confidence === 'high')).toEqual([]);
  });
  it('collision: two f point to ONE d → both do not anchor (spec-test 6)', () => {
    const figs = [card('1:1', ['Альфа']), card('1:2', ['Бета'])];
    const doms = [domCard(['Альфа', 'Бета']), domCard(['Гамма'])];
    expect(matchChildrenOneLevel(figs, doms, PAR, PAR).matched.filter((m) => m.confidence === 'high')).toEqual([]);
  });
  it('byte invariant: children WITH own textSnippet go the old path (phase-0 does not see them; spec-test 7)', () => {
    // direct TEXT children (textSnippet on the child itself) — existing semantics: text-exact in the score loop
    const t = (id: string, s: string): SpecChild => ({ id, name: s, type: 'TEXT', rect: { x: 0, y: 0, w: 100, h: 20 }, textSnippet: s }) as SpecChild;
    const dt = (s: string): DomChild => ({ kind: 'element', tag: 'span', rect: { x: 0, y: 0, w: 100, h: 20 }, text: s }) as DomChild;
    const r = matchChildrenOneLevel([t('1:1', 'Alpha')], [dt('Alpha'), dt('Beta')], PAR, PAR);
    expect(r.matched[0].confidence).toBe('high'); // the old text-exact, NOT phase-0
    expect(r.nestedAnchorMuted).toBeUndefined();
  });
  it('a whitespace-only nested snippet does not fabricate an anchor (mutation m8, sw==="" guard)', () => {
    // A single f → fig-blocking is vacuous (no other fig siblings); a single d with the same
    // whitespace-only text → confirm (exact-per-node on normSnippet) would pass without the guard,
    // since normSnippet('   ')==='' matches on both sides. An empty anchor proves nothing.
    const figs = [card('1:1', ['   '])];
    const doms = [domCard(['   '])];
    const high = matchChildrenOneLevel(figs, doms, PAR, PAR).matched.filter((m) => m.confidence === 'high');
    expect(high).toEqual([]);
  });

  describe('buildNestedAnchorMap (children-reorder T1)', () => {
    it('includeOwnText:false — own-textSnippet children are skipped (phase-0 semantics)', () => {
      const t = (id: string, s: string): SpecChild => ({ id, name: s, type: 'TEXT', rect: { x: 0, y: 0, w: 100, h: 20 }, textSnippet: s }) as SpecChild;
      const r = buildNestedAnchorMap([t('1:1', 'Alpha')], [domCard(['Alpha'])], { includeOwnText: false });
      expect(r.anchor.size).toBe(0);
      expect(r.muted).toBeUndefined();
    });
    it('includeOwnText:true — own-textSnippet children PARTICIPATE (detector input)', () => {
      const t = (id: string, s: string): SpecChild => ({ id, name: s, type: 'TEXT', rect: { x: 0, y: 0, w: 100, h: 20 }, textSnippet: s }) as SpecChild;
      const r = buildNestedAnchorMap([t('1:1', 'Alpha'), t('1:2', 'Beta')], [domCard(['Beta']), domCard(['Alpha'])], { includeOwnText: true });
      expect(r.anchor.get(0)).toEqual({ domIdx: 1, text: 'Alpha' });
      expect(r.anchor.get(1)).toEqual({ domIdx: 0, text: 'Beta' });
    });
    it('muted reason and bijection guards identical to phase-0 (contentUnknown/collision)', () => {
      const r1 = buildNestedAnchorMap([card('1:1', ['Уникальный'])], [domCard(['Уникальный']), domCard(['x'.repeat(SNIPPET_CAP)])], { includeOwnText: true });
      expect(r1.muted).toBe('longtext');
      expect(r1.anchor.size).toBe(0);
      const r2 = buildNestedAnchorMap([card('1:1', ['Альфа']), card('1:2', ['Бета'])], [domCard(['Альфа', 'Бета']), domCard(['Гамма'])], { includeOwnText: true });
      expect(r2.anchor.size).toBe(0); // collision: both f → dom0 — both miss
    });
  });

  describe('detectChildrenReorder (children-reorder T2)', () => {
    it('content reorder with correct geometry → moved with a map (spec-test 1 core)', () => {
      const figs = [card('1:1', ['Алый парус'], 0), card('1:2', ['Белый клык'], 200), card('1:3', ['Отверженные'], 400)];
      const doms = [domCard(['Отверженные'], 0), domCard(['Белый клык'], 200), domCard(['Алый парус'], 400)];
      const r = detectChildrenReorder(figs, doms, 1, 'row');
      expect(r && 'moved' in r ? r.moved : []).toEqual([
        { figIdx: 0, domIdx: 2, text: 'Алый парус' }, { figIdx: 2, domIdx: 0, text: 'Отверженные' }]);
    });
    it('correct order → undefined (never "confirms the order" with a positive record)', () => {
      const figs = [card('1:1', ['Алый парус'], 0), card('1:2', ['Белый клык'], 200)];
      const doms = [domCard(['Алый парус'], 0), domCard(['Белый клык'], 200)];
      expect(detectChildrenReorder(figs, doms, 1, 'row')).toBeUndefined();
    });
    it('tol-tie gate: equal main-start for the involved → silence (stable sorts tie-break differently; spec-test 4)', () => {
      // fig: A@0, B@0 (tie); dom (reverse document order): B@0, A@0 → the sorts give different ranks
      const figs = [card('1:1', ['Alpha'], 0), card('1:2', ['Beta'], 0)];
      const doms = [domCard(['Beta'], 0), domCard(['Alpha'], 0)];
      expect(detectChildrenReorder(figs, doms, 1, 'row')).toBeUndefined();
      // the mutation "without the tol-gate" → { moved: [...] } → RED here
    });
    it('defensive sort: a document-ordered input is correct (spec-test 12)', () => {
      // fig is given in "document" order with GEOMETRY B@0, A@200; dom is sorted A-content@0="B"…
      // Simpler: fig [B@200, A@0] (unsorted), dom [A@0, B@200] (sorted), content is CORRECT
      // geometrically → after the internal sort the bijection is identical → undefined (not a false reorder).
      const figs = [card('1:2', ['Beta'], 200), card('1:1', ['Alpha'], 0)];
      const doms = [domCard(['Alpha'], 0), domCard(['Beta'], 200)];
      expect(detectChildrenReorder(figs, doms, 1, 'row')).toBeUndefined();
      // the mutation "sort removed" → fig[0]=Beta@200 vs dom[0]=Alpha@0 → moved → RED here
    });
    it('muted is propagated (longtext sibling); duplicate text → not moved (helper guards; spec-tests 5/6)', () => {
      const r1 = detectChildrenReorder([card('1:1', ['Уникальный'], 0)], [domCard(['x'.repeat(SNIPPET_CAP)], 0)], 1, 'row');
      expect(r1).toEqual({ muted: 'longtext' });
      const figs = [card('1:1', ['Купить'], 0), card('1:2', ['Купить'], 200)];
      const doms = [domCard(['Купить'], 0), domCard(['Купить'], 200)];
      expect(detectChildrenReorder(figs, doms, 1, 'row')).toBeUndefined(); // duplicate → no bijections
    });
    it('own-textSnippet children participate (includeOwnText:true; spec-test 6 tail)', () => {
      const t = (id: string, s: string, x: number): SpecChild => ({ id, name: s, type: 'TEXT', rect: { x, y: 0, w: 100, h: 20 }, textSnippet: s }) as SpecChild;
      const dt = (s: string, x: number): DomChild => ({ kind: 'element', tag: 'span', rect: { x, y: 0, w: 100, h: 20 }, text: s }) as DomChild;
      const r = detectChildrenReorder([t('1:1', 'Alpha', 0), t('1:2', 'Beta', 200)], [dt('Beta', 0), dt('Alpha', 200)], 1, 'row');
      expect(r && 'moved' in r ? r.moved.length : 0).toBe(2);
      // the mutation "includeOwnText:false in the detector" → undefined → RED here
    });
    it('dom-only tie: fig geometry clean, a dom tie swaps ranks → silence (lock of the ds terms of tieAt)', () => {
      const figs = [card('1:1', ['Alpha'], 0), card('1:2', ['Beta'], 100)];
      const doms = [domCard(['Beta'], 0), domCard(['Alpha'], 1)]; // dom starts 1px apart — a sub-pixel tie
      expect(detectChildrenReorder(figs, doms, 1, 'row')).toBeUndefined();
      // the mutation "remove the tieAt(ds,·) terms" → moved → RED here (the symmetric tie test on the fig side masks it)
    });
    it('contradiction on an includeOwnText:true input: two S of one f → different d → not moved (lock of the shared branch)', () => {
      const figs = [card('1:1', ['X', 'Y'], 0), card('1:2', ['Z'], 100)];
      const doms = [domCard(['X'], 0), domCard(['Y', 'Z'], 100)];
      // f0: S=X→dom0, S=Y→dom1 → contradiction → f0 does not anchor; f1: Z→dom1 j===i? dom1 index 1 === fi 1 → not moved.
      expect(detectChildrenReorder(figs, doms, 1, 'row')).toBeUndefined();
    });
    // (low) the col-axis branch is locked: all fixtures above are 'row' (x variables, y=0 in card/domCard).
    // mainStart = axis==='row' ? r.x : r.y — the y branch is never touched by the T2 regression net. Local
    // mini-fixtures with y (card/domCard hardcode y:0, x — the third argument — can't be extended without
    // touching existing calls) — we keep x constant (0), vary y.
    it('col-axis: mainStart reads r.y (not r.x) — top↔bottom swapped → moved (axis lock; children-reorder)', () => {
      const t = (id: string, s: string, y: number): SpecChild => ({ id, name: s, type: 'TEXT', rect: { x: 0, y, w: 100, h: 20 }, textSnippet: s }) as SpecChild;
      const dt = (s: string, y: number): DomChild => ({ kind: 'element', tag: 'span', rect: { x: 0, y, w: 100, h: 20 }, text: s }) as DomChild;
      const figs = [t('1:1', 'Top', 0), t('1:2', 'Mid', 50), t('1:3', 'Bottom', 100)];
      const doms = [dt('Bottom', 0), dt('Mid', 50), dt('Top', 100)]; // top↔bottom swapped, Mid in place
      const r = detectChildrenReorder(figs, doms, 1, 'col');
      expect(r && 'moved' in r ? r.moved : []).toEqual([
        { figIdx: 0, domIdx: 2, text: 'Top' }, { figIdx: 2, domIdx: 0, text: 'Bottom' }]);
      // the mutation mainStart → always r.x: all x=0 (constant) → tieAt(≤tol) true EVERYWHERE → moved empty → undefined → RED
    });
    it('col-axis: correct order by y → undefined (identity case, symmetry with row)', () => {
      const t = (id: string, s: string, y: number): SpecChild => ({ id, name: s, type: 'TEXT', rect: { x: 0, y, w: 100, h: 20 }, textSnippet: s }) as SpecChild;
      const dt = (s: string, y: number): DomChild => ({ kind: 'element', tag: 'span', rect: { x: 0, y, w: 100, h: 20 }, text: s }) as DomChild;
      const figs = [t('1:1', 'Top', 0), t('1:2', 'Mid', 50), t('1:3', 'Bottom', 100)];
      const doms = [dt('Top', 0), dt('Mid', 50), dt('Bottom', 100)];
      expect(detectChildrenReorder(figs, doms, 1, 'col')).toBeUndefined();
    });
  });
});

// The receipt + the descent gate. Confidence is deliberately NOT touched here: `high` needs text-exact
// (+100 of a ~145 scale) and the descendant-anchor post-pass above reads exactly that word, so a
// friendlier band over the same evidence would silently re-point diff.ts's salvage. What a reader gets
// instead is the arithmetic that produced the ranking, and a matcher that refuses to build a subtree on
// top of a coin flip.
describe('matchPairs: the receipt (score/margin/rects/tag) and the descent gate', () => {
  // Two same-sized fig containers over two same-sized dom containers: the winner leads by the order term
  // alone (25 + 15 = 40 vs 25 + 11.25 = 36.25) — a 3.75 margin, i.e. an unresolved identity.
  const coinFlip = (withText: boolean) => {
    const kidF = (id: string, x: number, t?: string): SpecChild =>
      fc(id, 'FRAME', [x, 0, 50, 50], t !== undefined ? { textSnippet: t, type: 'TEXT' } as Partial<SpecChild> : {});
    const kidD = (path: string, x: number, t?: string): DomChild =>
      dc(path, 'div', [x, 0, 50, 50], t !== undefined ? { text: t } : {});
    const figs = [
      fc('A', 'FRAME', [0, 0, 100, 50], { children: [kidF('A1', 0, withText ? 'AlphaUnique' : undefined), kidF('A2', 50)] }),
      fc('B', 'FRAME', [0, 50, 100, 50], { children: [kidF('B1', 0), kidF('B2', 50)] }),
    ];
    const doms = [
      dc('> :nth-child(1)', 'section', [0, 0, 100, 50], { children: [kidD('> :nth-child(1) > :nth-child(1)', 0, withText ? 'AlphaUnique' : undefined), kidD('> :nth-child(1) > :nth-child(2)', 50)] }),
      dc('> :nth-child(2)', 'div', [0, 50, 100, 50], { children: [kidD('> :nth-child(2) > :nth-child(1)', 0), kidD('> :nth-child(2) > :nth-child(2)', 50)] }),
    ];
    return matchPairs(figs, doms);
  };

  it('every proposal carries the numbers it was ranked by, and both sides identity (rects + dom tag)', () => {
    const a = coinFlip(false).pairs.find((p) => p.node_id === 'A');
    expect(a?.score).toBe(40);           // size 25 + order 15, no text anywhere → the non-text ceiling
    expect(a?.margin).toBe(3.75);        // the lead over the runner-up the ambiguity band is measured on
    expect(a?.figma_rect).toEqual({ w: 100, h: 50 });
    expect(a?.dom_rect).toEqual({ w: 100, h: 50 });
    expect(a?.dom_tag).toBe('section');  // the pair row used to hide the one field that rejects a mis-pair by eye
  });

  it('the two rects are the two SIDES, not one number printed twice', () => {
    // Every other fixture here is same-sized on both sides, so figma_rect and dom_rect could be swapped
    // - or both sourced from one side - and the whole suite stays green (measured: 2970 passed under the
    // swap). These are the two fields the tool description sells as "reject a wrong proposal without a
    // browser"; sourced from one side a 100-vs-200 mis-size prints as agreement. The scorer reads
    // RELATIVE size, so a DOM captured at twice the scale scores identically while the rects differ -
    // which makes the swap a red test instead of a documented intention.
    const r = matchPairs([fc('half', 'INSTANCE', [0, 0, 100, 50])], [dc('> :nth-child(1)', 'div', [0, 0, 200, 100])],
      { rootFig: { w: 100, h: 100 }, rootDom: { w: 200, h: 200 } });
    expect(r.pairs[0].score).toBe(45);                        // identical RELATIVE size - the scorer agrees
    expect(r.pairs[0].figma_rect).toEqual({ w: 100, h: 50 }); // and the receipt still names each side
    expect(r.pairs[0].dom_rect).toEqual({ w: 200, h: 100 });
  });

  it('the runner-up carries the same identity as the winner - the reported "41 vs 41" is decidable on the row', () => {
    // The live contest reduced to a fixture: the design's Footer instance against two DOM candidates
    // whose scores are IDENTICAL, so the printed integers cannot separate them and the tie falls to
    // document order - which puts the wrong one first, exactly as reported. candidates[] used to hold a
    // path and that same integer, i.e. nothing a reader could decide on without opening a browser.
    const par = { w: 100, h: 100 };
    const r = matchPairs(
      [fc('Footer', 'INSTANCE', [0, 0, 100, 8])],
      [dc('> :nth-child(1)', 'header', [0, 0, 100, 24]), dc('> :nth-child(2)', 'footer', [0, 92, 100, 7])],
      { rootFig: par, rootDom: par });
    const p = r.pairs[0];
    expect(p.ambiguous).toBe(true);
    expect(p.candidates?.map((c) => c.score)).toEqual([41, 41]); // the two numbers a reader used to get
    expect(p.dom_tag).toBe('header');                            // and the one it leads with is the wrong one
    expect(p.candidates).toEqual([
      { dom_path: '> :nth-child(1)', score: 41, dom_tag: 'header', dom_rect: { w: 100, h: 24 } },
      { dom_path: '> :nth-child(2)', score: 41, dom_tag: 'footer', dom_rect: { w: 100, h: 7 } },
    ]);
    expect(p.figma_rect).toEqual({ w: 100, h: 8 }); // the design side: the runner-up's height decides it
  });

  it('honest-null rows carry the size of the side they name (that is how a reader re-pairs them)', () => {
    const par = { w: 100, h: 100 };
    const solo = fc('solo', 'FRAME', [0, 0, 40, 40]);
    const far = fc('far', 'FRAME', [0, 0, 4000, 4000]);           // relative size nowhere near — below FLOOR
    const r = matchPairs([solo, far], [dc('> :nth-child(1)', 'aside', [0, 0, 40, 40])], { rootFig: par, rootDom: par });
    expect(r.unmatched_figma[0]).toMatchObject({ node_id: 'far', rect: { w: 4000, h: 4000 } });
    const r2 = matchPairs([solo], [dc('> :nth-child(1)', 'aside', [0, 0, 40, 40]), dc('> :nth-child(2)', 'footer', [0, 900, 300, 77])], { rootFig: par, rootDom: par });
    expect(r2.unmatched_dom[0]).toEqual({ dom_path: '> :nth-child(2)', tag: 'footer', rect: { w: 300, h: 77 } });
  });

  it('a coin-flip commit with no text under EITHER side does not father a subtree — children_skipped, no descendants', () => {
    const r = coinFlip(false);
    const a = r.pairs.find((p) => p.node_id === 'A');
    expect(a?.margin).toBeLessThan(12);                                   // inside AMBIGUOUS_MARGIN
    expect(a?.children_skipped).toBe(true);                               // and we SAY we stopped
    // Nothing under A is proposed, and nothing under A is claimed unmatched either — we withdrew the
    // level, we did not judge it. (B is left with a single candidate, i.e. no runner-up and no coin flip
    // — it descends, which is the same rule, not an exception.)
    expect(r.pairs.filter((p) => p.dom_path.startsWith('> :nth-child(1) >'))).toEqual([]);
    expect(r.unmatched_dom.filter((u) => u.dom_path.startsWith('> :nth-child(1) >'))).toEqual([]);
    expect(r.unmatched_figma.map((u) => u.node_id)).toEqual([]);
  });

  it('CONTROL: the same coin flip WITH text on both sides below still descends — the descent can resolve it', () => {
    const r = coinFlip(true);
    const a = r.pairs.find((p) => p.node_id === 'A');
    expect(a?.margin).toBe(3.75);                        // the same unresolved margin as above
    expect(a?.children_skipped).toBeUndefined();         // but text below is evidence a descent can bring
    expect(r.pairs.some((p) => p.node_id === 'A1')).toBe(true);
    // and that is exactly the evidence the descendant-anchor post-pass consumes:
    expect(a?.signals).toContain('descendant-anchored');
  });

  it('INVARIANT the anchor post-pass rests on: high => text-exact, quantified over a set that HAS a high', () => {
    // The post-pass anchors a parent through a descendant it trusts by `confidence === 'high'` and reads
    // that descendant's dom_text — a string that is only PROVEN to be in the design when high implies
    // text-exact. Nothing asserts it in the banding itself; it holds by arithmetic (90 > 25+15+5).
    // The fixture carries BOTH sides of the implication on purpose: over a population with no high in it
    // the `every` below is vacuously true and would bless a banding that made geometry alone high, which
    // is precisely the change this invariant exists to catch. So a high must be present AND named.
    const par = { w: 100, h: 100 };
    const r = matchPairs(
      [fc('zText', 'TEXT', [0, 0, 100, 20], { textSnippet: 'ZedUnique' }), fc('zInst', 'INSTANCE', [0, 20, 100, 50])],
      [dc('> :nth-child(1)', 'span', [0, 0, 100, 20], { text: 'ZedUnique' }), dc('> :nth-child(2)', 'div', [0, 20, 100, 50])],
      { rootFig: par, rootDom: par });
    const inst = r.pairs.find((p) => p.node_id === 'zInst');
    expect(inst?.score).toBe(45);                 // identical relative size + identical index + INSTANCE
    expect(inst?.confidence).toBe('low');         // the non-text ceiling is 45 of a 90 bar
    const highs = r.pairs.filter((p) => p.confidence === 'high');
    expect(highs.map((p) => p.node_id)).toEqual(['zText']); // PRESENCE co-lock: the `every` is not vacuous
    expect(highs.every((p) => p.signals.includes('text-exact'))).toBe(true);
  });
});
