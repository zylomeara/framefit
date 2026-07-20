import { describe, it, expect, vi, afterEach } from 'vitest';
import { TtlCache } from '../../src/infrastructure/node-cache.js';
import { CacheBudget } from '../../src/infrastructure/cache-budget.js';

afterEach(() => vi.useRealTimers());

describe('TtlCache', () => {
  it('returns set value before TTL, null after', () => {
    vi.useFakeTimers();
    const c = new TtlCache<number>(1000);
    c.set('k', 42);
    expect(c.get('k')).toBe(42);
    vi.advanceTimersByTime(1500);
    expect(c.get('k')).toBeNull();
  });
  it('distinct keys are independent', () => {
    const c = new TtlCache<string>(10_000);
    c.set('a', 'x'); c.set('b', 'y');
    expect(c.get('a')).toBe('x');
    expect(c.get('b')).toBe('y');
    expect(c.get('c')).toBeNull();
  });
  it('bounds size: evicts oldest beyond maxEntries; get refreshes recency (LRU)', () => {
    const c = new TtlCache<number>(10_000, 2);
    c.set('a', 1); c.set('b', 2);
    expect(c.get('a')).toBe(1);   // touch a → a is now most-recent
    c.set('c', 3);                // over cap → evict least-recent = b
    expect(c.get('b')).toBeNull();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });
  // R6-F1: delete() lets a positive-cache success invalidate a sibling negative marker so the
  // marker cannot outlive definitive contradicting evidence.
  it('delete() removes a key immediately; a deleted key misses even before its TTL', () => {
    const c = new TtlCache<number>(10_000);
    c.set('k', 1);
    c.delete('k');
    expect(c.get('k')).toBeNull();
  });
  it('delete() on an absent key is a harmless no-op', () => {
    const c = new TtlCache<number>(10_000);
    expect(() => c.delete('nope')).not.toThrow();
  });
});

describe('TtlCache oversized-entry skip (M3a)', () => {
  it('entry over maxEntryBytes is not cached (get → null)', () => {
    const c = new TtlCache<string>(60_000, 1000, 100);
    c.set('k', 'v', 500); // 500 > 100 cap
    expect(c.get('k')).toBeNull();
  });
  it('entry at/under cap is cached normally', () => {
    const c = new TtlCache<string>(60_000, 1000, 100);
    c.set('k', 'v', 50);
    expect(c.get('k')).toBe('v');
  });
  it('oversized set clears a prior smaller entry (never serves stale)', () => {
    const c = new TtlCache<string>(60_000, 1000, 100);
    c.set('k', 'small', 10);
    c.set('k', 'big', 500);     // oversized → skip AND clear prior
    expect(c.get('k')).toBeNull();
  });
  it('default (no cap, no weight) unchanged — caches as before', () => {
    const c = new TtlCache<string>(60_000);
    c.set('k', 'v');            // byteWeight defaults 0, maxEntryBytes Infinity
    expect(c.get('k')).toBe('v');
  });
});

describe('TtlCache × CacheBudget conservation (M3b)', () => {
  afterEach(() => vi.useRealTimers());

  it('total() stays equal to the sum of live weighted entries across ops', () => {
    const b = new CacheBudget(1_000_000);
    const c = new TtlCache<string>(60_000, 1000, Infinity, undefined, b);
    c.set('a', 'x', 100);
    c.set('b', 'y', 200);
    expect(b.total()).toBe(300);
    c.set('a', 'x2', 150);          // replace a (100 → 150): remove old, add new
    expect(b.total()).toBe(350);
    c.delete('b');                  // -200
    expect(b.total()).toBe(150);
    c.set('z', 'z', 0);             // 0-byte → NOT registered
    expect(b.total()).toBe(150);
    c.get('a');                     // hit → touch, no total change
    expect(b.total()).toBe(150);
  });

  it('oversized-skip replacing a prior weighted entry releases the prior bytes (no leak)', () => {
    // Scenario B: a cached weighted entry is replaced by an oversized one → prior token must be removed
    // BEFORE the skip early-return, else the old bytes leak forever.
    const b = new CacheBudget(1_000_000);
    const c = new TtlCache<string>(60_000, 1000, 100 /* maxEntryBytes */, undefined, b);
    c.set('k', 'small', 40);       // cached + budgeted (40)
    expect(b.total()).toBe(40);
    c.set('k', 'big', 500);        // 500 > 100 cap → skipped, but prior 40 must be released
    expect(c.get('k')).toBeNull(); // not cached (oversized)
    expect(b.total()).toBe(0);     // prior bytes freed, nothing leaked
  });

  it('count-cap eviction decrements the budget (no leak)', () => {
    const b = new CacheBudget(1_000_000);
    const c = new TtlCache<string>(60_000, 1 /* maxEntries */, Infinity, undefined, b);
    c.set('a', 'x', 100);
    c.set('b', 'y', 100);           // size 2 > 1 → evict oldest 'a' → budget -100
    expect(c.get('a')).toBeNull();
    expect(b.total()).toBe(100);    // only 'b' remains
  });

  it('TTL-expiry removal decrements the budget', () => {
    vi.useFakeTimers();
    const b = new CacheBudget(1_000_000);
    const c = new TtlCache<string>(10, 1000, Infinity, undefined, b);
    c.set('a', 'x', 100);
    expect(b.total()).toBe(100);
    vi.advanceTimersByTime(20);
    expect(c.get('a')).toBeNull();  // expired → removed
    expect(b.total()).toBe(0);
  });

  it('global eviction across two caches sharing one budget', () => {
    const b = new CacheBudget(250);
    const c1 = new TtlCache<string>(60_000, 1000, Infinity, undefined, b);
    const c2 = new TtlCache<string>(60_000, 1000, Infinity, undefined, b);
    c1.set('a', 'x', 100);          // oldest, in c1
    c2.set('b', 'y', 100);          // in c2
    c2.set('c', 'z', 100);          // total 300 > 250 → evict oldest = c1's 'a'
    expect(c1.get('a')).toBeNull(); // evicted from the OTHER cache
    expect(b.total()).toBe(200);
  });
});
