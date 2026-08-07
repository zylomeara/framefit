import { describe, it, expect, vi } from 'vitest';
import { buildSetNames, resolveSetNames } from '../../src/adapters/driving/tools/component-set-names.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';

const logger = createLogger({ level: 'silent' });
const api = (over: Partial<FigmaApi> = {}) => ({
  getComponent: vi.fn(async (key: string) => ({ key, file_key: 'lib1', node_id: 'n1', name: 'comp' })),
  getFileComponentSets: vi.fn(async () => [{ node_id: '4:1', name: 'listItem' }]),
  ...over,
} as unknown as FigmaApi);

describe('buildSetNames (meta-first resolution)', () => {
  it('meta covers setId → name from meta, REST is NOT called', async () => {
    const a = api();
    const names = await buildSetNames(a, {
      components: { '5:1': { key: 'k1', name: 'type=active, size=Big', componentSetId: '12:380' } },
      componentSets: { '12:380': { key: 'sk1', name: 'promo banner' } },
    }, logger);
    expect(names.get('12:380')).toBe('promo banner');
    expect((a.getComponent as any)).not.toHaveBeenCalled();
    expect((a.getFileComponentSets as any)).not.toHaveBeenCalled();
  });
  it('remote instance: meta under the same componentSetId → name from meta, no REST', async () => {
    const a = api();
    const names = await buildSetNames(a, {
      components: { '5:9': { key: 'rk', name: 'Size=Big', remote: true, componentSetId: 'S:1' } },
      componentSets: { 'S:1': { key: 'rsk', name: 'Banner', remote: true } },
    }, logger);
    expect(names.get('S:1')).toBe('Banner');
    expect((a.getComponent as any)).not.toHaveBeenCalled();
  });
  it('fallback scope: REST is called ONLY for a setId outside meta (a covered key is not fetched)', async () => {
    const a = api({ getFileComponentSets: vi.fn(async () => [{ node_id: '9:9', name: 'fromRest' }]) } as any);
    const names = await buildSetNames(a, {
      components: {
        '5:1': { key: 'covered', componentSetId: '4:1' },
        '5:2': { key: 'uncovered', componentSetId: '9:9' },
      },
      componentSets: { '4:1': { key: 'sk', name: 'MetaName' } },
    }, logger);
    expect(names.get('4:1')).toBe('MetaName');
    expect(names.get('9:9')).toBe('fromRest');
    expect((a.getComponent as any).mock.calls.map((c: any[]) => c[0])).toEqual(['uncovered']);
  });
  it('meta wins on merge: a REST set with the same node_id does not overwrite the meta name', async () => {
    const a = api({ getFileComponentSets: vi.fn(async () => [{ node_id: '4:1', name: 'RestName' }, { node_id: '9:9', name: 'Other' }]) } as any);
    const names = await buildSetNames(a, {
      components: { '5:1': { key: 'covered', componentSetId: '4:1' }, '5:2': { key: 'unc', componentSetId: '9:9' } },
      componentSets: { '4:1': { key: 'sk', name: 'MetaName' } },
    }, logger);
    expect(names.get('4:1')).toBe('MetaName');
    expect(names.get('9:9')).toBe('Other');
  });
  it('name guard: a meta set WITHOUT name is not counted as covered → goes to fallback', async () => {
    const a = api({ getFileComponentSets: vi.fn(async () => [{ node_id: '4:1', name: 'fromRest' }]) } as any);
    const names = await buildSetNames(a, {
      components: { '5:1': { key: 'k1', componentSetId: '4:1' } },
      componentSets: { '4:1': { key: 'sk' } }, // name is missing
    }, logger);
    expect(names.get('4:1')).toBe('fromRest');
    expect((a.getComponent as any)).toHaveBeenCalled();
  });
  it('control miss: no meta and REST fails → empty Map, no throw', async () => {
    const a = api({ getComponent: vi.fn(async () => { throw new Error('404'); }) } as any);
    const names = await buildSetNames(a, { components: { '5:1': { key: 'k1', componentSetId: '4:1' } } }, logger);
    expect(names.size).toBe(0);
  });
  it('entry null/undefined/empty → empty Map with no calls', async () => {
    const a = api();
    expect((await buildSetNames(a, null, logger)).size).toBe(0);
    expect((await buildSetNames(a, undefined, logger)).size).toBe(0);
    expect((a.getComponent as any)).not.toHaveBeenCalled();
  });
});

describe('resolveSetNames (allSettled, both loops)', () => {
  it('loop 1: of two keys, one getComponent throws → the second set resolves', async () => {
    const a = api({
      getComponent: vi.fn(async (key: string) => {
        if (key === 'bad') throw new Error('404 not published');
        return { key, file_key: 'lib1', node_id: 'n', name: 'c' };
      }),
      getFileComponentSets: vi.fn(async () => [{ node_id: '4:1', name: 'listItem' }]),
    } as any);
    const names = await resolveSetNames(a, {
      'i1': { key: 'bad', componentSetId: '4:1' },
      'i2': { key: 'good', componentSetId: '4:1' },
    }, logger);
    expect(names.get('4:1')).toBe('listItem');
  });
  it('loop 2: of two file_keys, one getFileComponentSets throws → sets of the second land in Map', async () => {
    const a = api({
      getComponent: vi.fn(async (key: string) => ({ key, file_key: key === 'k1' ? 'f1' : 'f2', node_id: 'n', name: 'c' })),
      getFileComponentSets: vi.fn(async (fk: string) => {
        if (fk === 'f1') throw new Error('403');
        await new Promise((r) => setTimeout(r, 10)); // success SLOWER than the reject: with Promise.all
        // the f1 reject escapes the await fail-fast → catch, while the f2 side-effect (setNames.set) has
        // not yet run by the time of the synchronous assert → Map without 'survivor' → RED
        return [{ node_id: '9:9', name: 'survivor' }];
      }),
    } as any);
    const names = await resolveSetNames(a, {
      'i1': { key: 'k1', componentSetId: '4:1' },
      'i2': { key: 'k2', componentSetId: '9:9' },
    }, logger);
    expect(names.get('9:9')).toBe('survivor');
  });
});
