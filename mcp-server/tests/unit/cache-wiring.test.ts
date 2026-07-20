import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { makeReadCaches } from '../../src/infrastructure/server.js';
import { CacheBudget } from '../../src/infrastructure/cache-budget.js';
import { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import { loadConfig } from '../../src/infrastructure/config.js';

const logger = pino({ level: 'silent' });

describe('cache budget single-instance wiring (M3b)', () => {
  it('all read caches from makeReadCaches share ONE budget (aggregate accounting)', () => {
    const config = loadConfig({});
    const budget = new CacheBudget(1_000_000);
    const rc = makeReadCaches(config, logger, budget);
    // A weighted set in docCache AND one in nodeCache must both land in the SAME budget total.
    rc.docCache.set('d', {} as never, 100);
    rc.nodeCache.set('n', {} as never, 200);
    expect(budget.total()).toBe(300); // proves both caches reference the same budget instance
  });

  it('without a budget, makeReadCaches still works (behavior-preserving)', () => {
    const config = loadConfig({});
    const rc = makeReadCaches(config, logger); // no budget
    expect(() => rc.docCache.set('d', {} as never, 100)).not.toThrow();
    expect(rc.docCache.get('d')).toBeDefined();
  });
});

describe('FileStructureCache count cap (M3b)', () => {
  it('evicts the oldest entry beyond maxEntries', () => {
    const c = new FileStructureCache(60_000, () => 1000, 1 /* maxEntries */);
    c.set('a', { root: { id: 'a' } } as never);
    c.set('b', { root: { id: 'b' } } as never); // size 2 > 1 → oldest 'a' evicted
    expect(c.get('a')).toBeNull();
    expect(c.get('b')).not.toBeNull();
  });
});
