import { describe, it, expect } from 'vitest';
import { summarizeTokens, filterTokens, dedupeTokens, canonicalizeCollections } from '../../src/domain/variables-summary.js';
import type { Token } from '../../src/domain/variables-summary.js';

function t(over: Partial<Token>): Token {
  return {
    name: 'some/token',
    type: 'COLOR',
    value: '#ffffff',
    collection: 'Brand',
    ...over,
  };
}

describe('summarizeTokens', () => {
  it('counts total and resolved_via buckets correctly', () => {
    const tokens: Token[] = [
      t({ name: 'a', value: '#fff', resolved_via: undefined }),        // local
      t({ name: 'b', value: '#000', resolved_via: 'graph' }),          // graph
      t({ name: 'c', value: '#aaa', resolved_via: 'snapshot' }),       // snapshot
      t({ name: 'd', value: null, alias: true }),                      // unresolved
    ];
    const s = summarizeTokens(tokens);
    expect(s.total).toBe(4);
    expect(s.resolved_via.local).toBe(1);
    expect(s.resolved_via.graph).toBe(1);
    expect(s.resolved_via.snapshot).toBe(1);
    expect(s.unresolved).toBe(1);
  });

  it('counts by_type', () => {
    const tokens: Token[] = [
      t({ type: 'COLOR' }),
      t({ type: 'COLOR' }),
      t({ type: 'FLOAT' }),
    ];
    const s = summarizeTokens(tokens);
    expect(s.by_type['COLOR']).toBe(2);
    expect(s.by_type['FLOAT']).toBe(1);
  });
});

describe('filterTokens', () => {
  const tokens: Token[] = [
    t({ name: 'colors/red',  collection: 'Colors', type: 'COLOR', value: '#f00' }),
    t({ name: 'colors/blue', collection: 'Colors', type: 'COLOR', value: '#00f' }),
    t({ name: 'spacing/sm',  collection: 'Spacing', type: 'FLOAT', value: 8 }),
    t({ name: 'ext/bg',      collection: 'External', type: 'COLOR', value: null, alias: true }),
  ];

  it('returns all when no filters specified', () => {
    expect(filterTokens(tokens, {})).toHaveLength(4);
  });

  it('filters by collection case-insensitive substring', () => {
    const res = filterTokens(tokens, { collection: 'colors' });
    expect(res).toHaveLength(2);
    expect(res.every((t) => t.collection === 'Colors')).toBe(true);
  });

  it('filters by name substring', () => {
    const res = filterTokens(tokens, { name: 'colors/' });
    expect(res).toHaveLength(2);
  });

  it('filters by type case-insensitive exact', () => {
    const res = filterTokens(tokens, { type: 'float' });
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('spacing/sm');
  });

  it('filters unresolved_only', () => {
    const res = filterTokens(tokens, { unresolved_only: true });
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('ext/bg');
  });
});

describe('dedupeTokens', () => {
  it('collapses rows identical in (name, collection, value, type), keeping the first', () => {
    const out = dedupeTokens([
      t({ name: 'bg/level 1', collection: 'Theme', value: '#fff', resolved_via: 'graph' }),
      t({ name: 'bg/level 1', collection: 'Theme', value: '#fff', resolved_via: 'snapshot' }),
      t({ name: 'bg/level 1', collection: 'Theme', value: '#000' }), // different value → kept
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].resolved_via).toBe('graph');
  });

  it('keeps rows identical in (name, collection, value, type) but differing only by modes', () => {
    // Case A: same 4 core fields, DIFFERENT per-mode maps → both must survive (the modes key change).
    const out = dedupeTokens([
      t({ name: 'text/accent', collection: 'Theme', value: '#a73afd', type: 'COLOR',
        modes: { Default: '#a73afd', Dusk: '#8b6afb' }, mode_dependent: true }),
      t({ name: 'text/accent', collection: 'Theme', value: '#a73afd', type: 'COLOR',
        modes: { Default: '#a73afd', Dawn: '#c9a7ff' }, mode_dependent: true }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('collapses rows identical in (name, collection, value, type) AND modes', () => {
    // Case B: identical in all five fields including modes → still collapses to one.
    const out = dedupeTokens([
      t({ name: 'text/accent', collection: 'Theme', value: '#a73afd', type: 'COLOR',
        modes: { Default: '#a73afd', Dusk: '#8b6afb' }, mode_dependent: true }),
      t({ name: 'text/accent', collection: 'Theme', value: '#a73afd', type: 'COLOR',
        modes: { Default: '#a73afd', Dusk: '#8b6afb' }, mode_dependent: true }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('canonicalizeCollections', () => {
  it('collapses case-variant collection names to the first-seen spelling', () => {
    const out = canonicalizeCollections([
      t({ name: 'a', collection: 'Theme' }),
      t({ name: 'b', collection: 'theme' }),
    ]);
    expect(out.map((x) => x.collection)).toEqual(['Theme', 'Theme']);
  });
});
