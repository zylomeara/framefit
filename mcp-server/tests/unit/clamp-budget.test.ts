import { describe, it, expect } from 'vitest';
import { clampToBudget } from '../../src/application/get-comments.js';

const ser = (xs: string[]) => xs.join(''); // each item length = string length

describe('clampToBudget', () => {
  it('returns all when under budget', () => {
    const r = clampToBudget(['aa', 'bb'], 100, ser);
    expect(r.kept).toEqual(['aa', 'bb']);
    expect(r.clamped).toBe(false);
  });

  it('shrinks to the largest prefix that fits', () => {
    // each item 10 chars; budget 25 → only 2 fit (20 <= 25, 30 > 25)
    const items = ['xxxxxxxxxx', 'yyyyyyyyyy', 'zzzzzzzzzz'];
    const r = clampToBudget(items, 25, ser);
    expect(r.kept.length).toBe(2);
    expect(r.clamped).toBe(true);
  });

  it('keeps at least one item even if it exceeds budget', () => {
    const r = clampToBudget(['this-one-item-is-huge'], 5, ser);
    expect(r.kept.length).toBe(1);
    expect(r.clamped).toBe(false); // 1 of 1 → nothing dropped
  });

  it('empty input', () => {
    expect(clampToBudget([], 100, ser)).toEqual({ kept: [], clamped: false });
  });
});
