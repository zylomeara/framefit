import { describe, it, expect, vi } from 'vitest';
import { CacheBudget } from '../../src/infrastructure/cache-budget.js';

describe('CacheBudget', () => {
  it('tracks total across add/remove', () => {
    const b = new CacheBudget(1000);
    const t1 = b.add(100, () => {});
    const t2 = b.add(200, () => {});
    expect(b.total()).toBe(300);
    b.remove(t1);
    expect(b.total()).toBe(200);
    b.remove(t2);
    expect(b.total()).toBe(0);
  });

  it('over-budget add evicts globally-oldest until it fits', () => {
    const b = new CacheBudget(250);
    const evictA = vi.fn(); const evictB = vi.fn(); const evictC = vi.fn();
    b.add(100, evictA);          // oldest
    b.add(100, evictB);
    b.add(100, evictC);          // total would be 300 > 250 → evict A (oldest)
    expect(evictA).toHaveBeenCalledTimes(1);
    expect(evictB).not.toHaveBeenCalled();
    expect(evictC).not.toHaveBeenCalled();
    expect(b.total()).toBe(200); // B + C
  });

  it('touch refreshes recency → a touched entry is evicted later', () => {
    const b = new CacheBudget(250);
    const evictA = vi.fn(); const evictB = vi.fn();
    const tA = b.add(100, evictA);
    b.add(100, evictB);
    b.touch(tA);                 // A now most-recent → B is oldest
    b.add(100, () => {});        // total 300 > 250 → evict oldest = B
    expect(evictB).toHaveBeenCalledTimes(1);
    expect(evictA).not.toHaveBeenCalled();
  });

  it('never evicts the just-added entry, even if it alone exceeds budget', () => {
    const b = new CacheBudget(50);
    const evict = vi.fn();
    b.add(100, evict);           // 100 > 50 but it is the entry just added → do not self-evict
    expect(evict).not.toHaveBeenCalled();
    expect(b.total()).toBe(100); // over budget but honest; M3a's oversized-skip prevents this upstream
  });

  it('remove is idempotent (double remove, or remove after evict, is a no-op)', () => {
    const b = new CacheBudget(1000);
    const t = b.add(100, () => {});
    b.remove(t);
    expect(() => b.remove(t)).not.toThrow();
    expect(b.total()).toBe(0);
  });
});
