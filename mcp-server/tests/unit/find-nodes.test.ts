import { describe, it, expect } from 'vitest';
import { findNodes, matchedOverrideText, overridePreview } from '../../src/domain/find-nodes.js';

type N = { id: string; name: string; type: string; visible?: boolean; children?: N[] };
const tree: N = {
  id: '0:0', name: 'page', type: 'FRAME', children: [
    { id: '1:1', name: 'header', type: 'FRAME', children: [
      { id: '1:2', name: 'tabs', type: 'FRAME', children: [
        { id: '1:3', name: 'Tab text', type: 'TEXT' },
      ] },
    ] },
    { id: '2:1', name: 'hidden tabs', type: 'FRAME', visible: false },
  ],
};

describe('findNodes', () => {
  it('finds by name substring and reports a breadcrumb path', () => {
    const m = findNodes(tree, { query: 'tabs', limit: 10 });
    const ids = m.map((x) => x.node.id);
    expect(ids).toContain('1:2');
    const tabsHit = m.find((x) => x.node.id === '1:2')!;
    expect(tabsHit.path).toEqual(['page', 'header']);
  });

  it('filters by type', () => {
    const m = findNodes(tree, { query: 'tab', type: 'TEXT', limit: 10 });
    expect(m.map((x) => x.node.id)).toEqual(['1:3']);
  });

  it('skips hidden nodes unless includeHidden', () => {
    expect(findNodes(tree, { query: 'tabs', limit: 10 }).some((x) => x.node.id === '2:1')).toBe(false);
    expect(findNodes(tree, { query: 'tabs', limit: 10, includeHidden: true }).some((x) => x.node.id === '2:1')).toBe(true);
  });

  it('respects limit', () => {
    expect(findNodes(tree, { query: 'tab', limit: 1 })).toHaveLength(1);
  });

  it('fuzzy tolerates a typo', () => {
    const m = findNodes(tree, { query: 'tabz', fuzzy: true, limit: 5 });
    expect(m.some((x) => x.node.id === '1:2')).toBe(true);
  });

  it('matches by characters when the name is a placeholder', () => {
    const t: N & { characters?: string } = {
      id: '3:1', name: 'Все жанры', type: 'TEXT', characters: 'Корзина',
    } as N;
    const m = findNodes(t, { query: 'Корзина', limit: 10 });
    expect(m).toHaveLength(1);
    expect(m[0].node.id).toBe('3:1');
    expect(m[0].matchedOn).toBe('text');
  });

  it('ranks a name match above a text match', () => {
    const root: N = {
      id: '0:0', name: 'root', type: 'FRAME', children: [
        { id: 'a', name: 'Корзина', type: 'TEXT' } as N,
        { id: 'b', name: 'placeholder', type: 'TEXT', characters: 'Корзина' } as unknown as N,
      ],
    };
    const m = findNodes(root, { query: 'Корзина', limit: 10 });
    expect(m[0].node.id).toBe('a');
    expect(m[0].matchedOn).toBe('name');
  });

  it('short/numeric query does not match a number embedded in longer text', () => {
    const root: N = {
      id: '0:0', name: 'root', type: 'FRAME', children: [
        { id: 'noise', name: 'Subtitle', type: 'TEXT', characters: 'Пока читать книги не начали — 29 штук' } as unknown as N,
        { id: 'hit', name: '29', type: 'TEXT' } as N,
      ],
    };
    const m = findNodes(root, { query: '29', limit: 10 });
    expect(m.map((x) => x.node.id)).toEqual(['hit']);
    expect(m[0].matchedOn).toBe('name');
  });

  it('reports matchedOn:name for a plain name hit', () => {
    const m = findNodes(tree, { query: 'tabs', limit: 10 });
    expect(m.find((x) => x.node.id === '1:2')!.matchedOn).toBe('name');
  });

  it('matchedOn:text via the .text field (SimplifiedNode-style)', () => {
    const node = { id: '5:1', name: 'Icon', type: 'TEXT', text: 'Корзина' } as N & { text?: string };
    const m = findNodes(node as N, { query: 'Корзина', limit: 10 });
    expect(m).toHaveLength(1);
    expect(m[0].node.id).toBe('5:1');
    expect(m[0].matchedOn).toBe('text');
  });

  it('fuzzy matches by text and reports matchedOn:text', () => {
    const node = { id: '6:1', name: 'Все жанры', type: 'TEXT', characters: 'Корзина' } as N & { characters?: string };
    const m = findNodes(node as N, { query: 'Корзина', fuzzy: true, limit: 10 });
    expect(m).toHaveLength(1);
    expect(m[0].node.id).toBe('6:1');
    expect(m[0].matchedOn).toBe('text');
  });
});

// ── gap fixes ──────────────────────────────────────────────────────────────────
const gapTree = {
  id: '0', name: 'root', type: 'FRAME',
  children: [
    { id: '1', name: 'btn', type: 'INSTANCE', characters: 'OK button' },
    { id: '2', name: 'row', type: 'TEXT', characters: '— 29 штук' },
    { id: '3', name: 'card', type: 'INSTANCE', children: [{ id: '4', name: 'inner', type: 'TEXT', characters: 'hello' }] },
  ],
} as any;

describe('find_nodes gaps', () => {
  it('type-only search (no query) returns all nodes of the type, matchedOn type', () => {
    const r = findNodes(gapTree, { type: 'INSTANCE', limit: 20 });
    expect(r.map((m) => m.node.id).sort()).toEqual(['1', '3']);
    expect(r.every((m) => m.matchedOn === 'type' && m.score === 1)).toBe(true);
  });
  it('a short ALPHA term now reaches text-content matching', () => {
    const r = findNodes(gapTree, { query: 'ok', limit: 20 });
    // "ok" is 2 chars but alpha → text fallback runs → node 1 ("OK button") matches on text
    expect(r.find((m) => m.node.id === '1')?.matchedOn).toBe('text');
  });
  it('a purely-numeric term still skips text matching (noise guard preserved)', () => {
    const r = findNodes(gapTree, { query: '29', limit: 20 });
    // "29" is numeric → text skipped; node 2's NAME is "row" (no "29") → no match
    expect(r.find((m) => m.node.id === '2')).toBeUndefined();
  });
  it('no query and no type → empty', () => {
    expect(findNodes(gapTree, { limit: 20 })).toEqual([]);
  });
});

// ── instance TEXT property-overrides ────────────────────────────────────
const overrideTree = {
  id: '0', name: 'root', type: 'FRAME',
  children: [
    { id: '1', name: 'sectionHeader', type: 'INSTANCE',
      componentProperties: { 'Title#9:0': { type: 'TEXT', value: 'Как привязать карту' } } },
    { id: '2', name: 'sizeBox', type: 'INSTANCE',
      componentProperties: { 'Size': { type: 'VARIANT', value: 'Большой' } } },
    { id: '3', name: 'numBox', type: 'INSTANCE',
      componentProperties: { 'Count#1:0': { type: 'TEXT', value: '29 штук' } } },
  ],
} as any;

describe('find_nodes TEXT overrides', () => {
  it('matches a TEXT property-override value and reports matchedOn:property', () => {
    const r = findNodes(overrideTree, { query: 'привязать карту', limit: 20 });
    const hit = r.find((m) => m.node.id === '1');
    expect(hit).toBeDefined();
    expect(hit!.matchedOn).toBe('property');
    expect(hit!.score).toBe(0.8);
  });

  it('ignores non-TEXT (VARIANT) property values — TEXT-only scope', () => {
    const r = findNodes(overrideTree, { query: 'Большой', limit: 20 });
    expect(r.find((m) => m.node.id === '2')).toBeUndefined();
  });

  it('a purely-numeric term still skips property matching (noise guard preserved)', () => {
    const r = findNodes(overrideTree, { query: '29', limit: 20 });
    expect(r.find((m) => m.node.id === '3')).toBeUndefined();
  });

  it('a real characters/name hit still outranks a property hit', () => {
    const root = {
      id: 'r', name: 'root', type: 'FRAME', children: [
        { id: 'n', name: 'привязать карту', type: 'TEXT' },
        { id: 'p', name: 'hdr', type: 'INSTANCE',
          componentProperties: { t: { type: 'TEXT', value: 'привязать карту' } } },
      ],
    } as any;
    const m = findNodes(root, { query: 'привязать карту', limit: 10 });
    expect(m[0].node.id).toBe('n');
    expect(m[0].matchedOn).toBe('name');
  });

  it('matchedOverrideText returns the matched value for preview, else undefined', () => {
    expect(matchedOverrideText(overrideTree.children[0], 'привязать карту')).toBe('Как привязать карту');
    expect(matchedOverrideText(overrideTree.children[1], 'Большой')).toBeUndefined();
  });

  it('matchedOverrideText checks every TEXT override, not just the first', () => {
    const node = {
      id: 'multi', name: 'multi', type: 'INSTANCE',
      componentProperties: {
        'First#0:0': { type: 'TEXT', value: 'Первый заголовок' },
        'Second#0:1': { type: 'TEXT', value: 'Второй заголовок' },
      },
    };
    expect(matchedOverrideText(node, 'Второй')).toBe('Второй заголовок');
  });

  it('matchedOverrideText(node, undefined) returns undefined (empty-terms early return)', () => {
    expect(matchedOverrideText(overrideTree.children[0], undefined)).toBeUndefined();
  });

  it('overridePreview falls back to the first TEXT override when the query is a typo (no exact term match)', () => {
    expect(matchedOverrideText(overrideTree.children[0], 'привзать')).toBeUndefined();
    expect(overridePreview(overrideTree.children[0], 'привзать')).toBe('Как привязать карту');
  });

  it('fuzzy tolerates a typo in an override value and reports matchedOn:property', () => {
    const r = findNodes(overrideTree, { query: 'привязать картуу', fuzzy: true, limit: 20 });
    expect(r.find((m) => m.node.id === '1')?.matchedOn).toBe('property');
  });
});
