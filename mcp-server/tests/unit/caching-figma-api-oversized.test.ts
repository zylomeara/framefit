import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { CachingFigmaApiAdapter, type ReadCaches } from '../../src/adapters/driven/caching-figma-api.js';
import { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import { TtlCache } from '../../src/infrastructure/node-cache.js';
import { tagBytes } from '../../src/infrastructure/response-size.js';

const logger = pino({ level: 'silent' });

function caches(cap: number): ReadCaches {
  return {
    nodeCache: new TtlCache(60_000, 1000, cap), variablesCache: new TtlCache(60_000, 1000, cap),
    variablesErrorCache: new TtlCache(60_000, 1000, cap), versionCache: new TtlCache(60_000, 1000, cap),
    librariesCache: new TtlCache(60_000, 1000, cap), componentCache: new TtlCache(60_000, 1000, cap),
    componentSetsCache: new TtlCache(60_000, 1000, cap), imageFillsCache: new TtlCache(60_000, 1000, cap),
    docCache: new TtlCache(60_000, 1000, cap),
  };
}

function innerWith(doc: unknown) {
  return {
    getDocumentRaw: vi.fn(async () => doc),
    getFileVersion: vi.fn(async () => ({ version: 'v1', name: 'n', lastModified: 'm' })),
  } as any;
}

describe('caching-figma-api oversized doc skip (M3a t3)', () => {
  it('oversized doc is delivered but NOT cached → second call re-fetches', async () => {
    const doc = { name: 'big', document: { id: '0:0' } } as any;
    tagBytes(doc, 500);                     // over the 100-byte cap below
    const inner = innerWith(doc);
    const api = new CachingFigmaApiAdapter(inner, new FileStructureCache(60_000), logger, caches(100));
    const r1 = await api.getDocumentRaw('K');
    const r2 = await api.getDocumentRaw('K');
    expect(r1).toBe(doc);
    expect(r2).toBe(doc);
    expect(inner.getDocumentRaw).toHaveBeenCalledTimes(2); // not cached → re-fetched
  });

  it('under-cap doc is cached → second call served from cache', async () => {
    const doc = { name: 'small', document: { id: '0:0' } } as any;
    tagBytes(doc, 50);                      // under the 100-byte cap
    const inner = innerWith(doc);
    const api = new CachingFigmaApiAdapter(inner, new FileStructureCache(60_000), logger, caches(100));
    await api.getDocumentRaw('K');
    await api.getDocumentRaw('K');
    expect(inner.getDocumentRaw).toHaveBeenCalledTimes(1); // cached → single fetch
  });
});
