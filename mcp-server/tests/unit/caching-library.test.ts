import { describe, it, expect, vi } from 'vitest';
import { CachingFigmaApiAdapter } from '../../src/adapters/driven/caching-figma-api.js';
import { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import { TtlCache } from '../../src/infrastructure/node-cache.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';

const logger = createLogger({ level: 'silent' });

function fakeApi(over: Partial<FigmaApi> = {}): FigmaApi {
  return {
    getComments: async () => [], resolveNodes: async () => new Map(),
    getFileStructure: async () => ({}) as any, getDocumentRaw: async () => ({}) as any,
    getNodesRaw: async () => ({ nodes: {} }), getImages: async () => ({ images: {} }),
    getVariablesLocal: async () => ({}), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
    getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }),
    getFileComponents: async () => [],
    getComponent: async () => ({ key: 'k', file_key: 'F', node_id: '1:1', name: 'C' }),
    ...over,
  } as unknown as FigmaApi;
}
function build(inner: FigmaApi) {
  return new CachingFigmaApiAdapter(inner, new FileStructureCache(300_000), logger, {
    nodeCache: new TtlCache(300_000), variablesCache: new TtlCache(300_000),
    versionCache: new TtlCache(60_000), librariesCache: new TtlCache(300_000),
    componentCache: new TtlCache(300_000), docCache: new TtlCache(300_000),
    componentSetsCache: new TtlCache(300_000), imageFillsCache: new TtlCache(300_000),
  });
}

describe('CachingFigmaApiAdapter library caching', () => {
  it('caches getTeamLibrary by teamId; second call hits cache', async () => {
    const getTeamLibrary = vi.fn(async () => ({ components: [{ key: 'c', file_key: 'F', node_id: '1:1', name: 'B', description: '' }], componentSets: [], styles: [] }));
    const c = build(fakeApi({ getTeamLibrary }));
    await c.getTeamLibrary('T1');
    await c.getTeamLibrary('T1');
    expect(getTeamLibrary).toHaveBeenCalledTimes(1);
  });
  it('different teamId → separate upstream calls', async () => {
    const getTeamLibrary = vi.fn(async () => ({ components: [], componentSets: [], styles: [] }));
    const c = build(fakeApi({ getTeamLibrary }));
    await c.getTeamLibrary('T1');
    await c.getTeamLibrary('T2');
    expect(getTeamLibrary).toHaveBeenCalledTimes(2);
  });
  it('getFileComponents passes through (not cached)', async () => {
    const getFileComponents = vi.fn(async () => []);
    const c = build(fakeApi({ getFileComponents }));
    await c.getFileComponents('abc');
    await c.getFileComponents('abc');
    expect(getFileComponents).toHaveBeenCalledTimes(2);
  });
});
