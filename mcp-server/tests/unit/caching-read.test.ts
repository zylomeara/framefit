import { describe, it, expect, vi, afterEach } from 'vitest';
import { CachingFigmaApiAdapter } from '../../src/adapters/driven/caching-figma-api.js';
import { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import { TtlCache } from '../../src/infrastructure/node-cache.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.useRealTimers());

function fakeApi(over: Partial<FigmaApi> = {}): FigmaApi {
  return {
    getComments: async () => [],
    resolveNodes: async () => new Map(),
    getFileStructure: async () => ({ nodeById: new Map(), pageNameByNodeId: new Map(), childrenByNodeId: new Map() }) as any,
    getDocumentRaw: async () => ({ name: 'F', lastModified: 'X', version: '1', document: { id: '0:0', name: 'D', type: 'DOCUMENT' } }),
    getNodesRaw: async () => ({ nodes: {} }),
    getImages: async () => ({ images: {} }),
    getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
    getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
    getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }),
    getFileComponents: async () => [],
    getFileComponentSets: async () => [],
    getImageFills: async () => ({ images: {} }),
    getComponent: async () => ({ key: 'k', file_key: 'F', node_id: '1:1', name: 'C' }),
    ...over,
  } as unknown as FigmaApi;
}

function build(inner: FigmaApi) {
  return new CachingFigmaApiAdapter(inner, new FileStructureCache(300_000), logger, {
    nodeCache: new TtlCache(300_000),
    variablesCache: new TtlCache(300_000),
    versionCache: new TtlCache(60_000),
    librariesCache: new TtlCache(300_000),
    componentCache: new TtlCache(300_000),
    docCache: new TtlCache(300_000),
    componentSetsCache: new TtlCache(300_000),
    imageFillsCache: new TtlCache(300_000),
  });
}

describe('CachingFigmaApiAdapter read caching', () => {
  it('caches getNodesRaw by version; same version → one upstream call', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:2': { document: { id: '1:2', name: 'A', type: 'FRAME' } } } }));
    const getFileVersion = vi.fn(async () => ({ version: 'v1', name: 'F', lastModified: 'X' }));
    const c = build(fakeApi({ getNodesRaw, getFileVersion }));
    await c.getNodesRaw('abc', ['1:2'], 4);
    await c.getNodesRaw('abc', ['1:2'], 4);
    expect(getNodesRaw).toHaveBeenCalledTimes(1);
  });

  it('new version busts the node cache', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: {} }));
    let v = 'v1';
    const getFileVersion = vi.fn(async () => ({ version: v, name: 'F', lastModified: 'X' }));
    const c = build(fakeApi({ getNodesRaw, getFileVersion }));
    await c.getNodesRaw('abc', ['1:2'], 4);
    v = 'v2';
    vi.useFakeTimers(); vi.advanceTimersByTime(61_000);
    await c.getNodesRaw('abc', ['1:2'], 4);
    expect(getNodesRaw).toHaveBeenCalledTimes(2);
  });

  it('caches getDocumentRaw by version; same version → one upstream call', async () => {
    const getDocumentRaw = vi.fn(async () => ({ name: 'F', lastModified: 'X', version: '1', document: { id: '0:0', name: 'D', type: 'DOCUMENT' } }));
    const getFileVersion = vi.fn(async () => ({ version: 'v1', name: 'F', lastModified: 'X' }));
    const c = build(fakeApi({ getDocumentRaw, getFileVersion }));
    await c.getDocumentRaw('abc', 4);
    await c.getDocumentRaw('abc', 4);
    expect(getDocumentRaw).toHaveBeenCalledTimes(1);
  });

  it('caches getFileComponentSets by fileKey; same key → one upstream call', async () => {
    const getFileComponentSets = vi.fn(async () => [{ key: 'SK', file_key: 'LIB', node_id: '2:1', name: 'S', description: 'd' }]);
    const c = build(fakeApi({ getFileComponentSets }));
    await c.getFileComponentSets('abc');
    await c.getFileComponentSets('abc');
    expect(getFileComponentSets).toHaveBeenCalledTimes(1);
  });

  it('caches getImageFills by version; same version → one upstream call', async () => {
    const getImageFills = vi.fn(async () => ({ images: { a: 'u' } }));
    const getFileVersion = vi.fn(async () => ({ version: 'v1', name: 'F', lastModified: 'X' }));
    const c = build(fakeApi({ getImageFills, getFileVersion }));
    await c.getImageFills('abc');
    await c.getImageFills('abc');
    expect(getImageFills).toHaveBeenCalledTimes(1);
  });

  it('passes getImages straight through (never cached)', async () => {
    const getImages = vi.fn(async () => ({ images: { '1:2': 'u' } }));
    const c = build(fakeApi({ getImages }));
    await c.getImages('abc', ['1:2'], { format: 'png' });
    await c.getImages('abc', ['1:2'], { format: 'png' });
    expect(getImages).toHaveBeenCalledTimes(2);
  });
  it('dedups concurrent cold getNodesRaw: one version probe + one node fetch', async () => {
    let nodeCalls = 0, verCalls = 0;
    const getNodesRaw = vi.fn(async () => { nodeCalls++; await new Promise((r) => setTimeout(r, 5)); return { nodes: { '1:2': { document: { id: '1:2', name: 'A', type: 'FRAME' } } } }; });
    const getFileVersion = vi.fn(async () => { verCalls++; await new Promise((r) => setTimeout(r, 5)); return { version: 'v1', name: 'F', lastModified: 'X' }; });
    const c = build(fakeApi({ getNodesRaw, getFileVersion }));
    await Promise.all([c.getNodesRaw('abc', ['1:2'], 4), c.getNodesRaw('abc', ['1:2'], 4), c.getNodesRaw('abc', ['1:2'], 4)]);
    expect(nodeCalls).toBe(1);
    expect(verCalls).toBe(1);
  });
});
