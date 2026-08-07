import { describe, it, expect, afterEach, vi } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.unstubAllGlobals());
function stub(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(url).toContain('/components/CKEY');
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
}
const api = () => new FigmaRestAdapter('figd_x', logger, 4, 30000);

describe('getComponent', () => {
  it('resolves a component key to its library file_key + node_id', async () => {
    // GET /v1/components/:key returns { meta: <component fields directly> }
    stub({ meta: { key: 'CKEY', file_key: 'LIB', node_id: '7:7', name: 'Button' } });
    const c = await api().getComponent('CKEY');
    expect(c).toMatchObject({ file_key: 'LIB', node_id: '7:7', name: 'Button' });
  });
  it('maps 404 to not_found', async () => {
    stub({ err: 'x' }, 404);
    await expect(api().getComponent('CKEY')).rejects.toMatchObject({ kind: 'not_found' });
  });
  it('throws not_found when a 200 response has no usable meta', async () => {
    stub({ meta: null });
    await expect(api().getComponent('CKEY')).rejects.toMatchObject({ kind: 'not_found' });
  });
  it('normalizes Figma snake_case component_set_id → componentSetId', async () => {
    stub({ meta: { key: 'CKEY', file_key: 'LIB', node_id: '7:7', name: 'Btn', component_set_id: '12:395' } });
    expect((await api().getComponent('CKEY')).componentSetId).toBe('12:395');
  });
  it('normalizes snake_case documentation_links → documentationLinks', async () => {
    stub({ meta: { key: 'CKEY', file_key: 'LIB', node_id: '7:7', name: 'Btn', documentation_links: [{ uri: 'http://d' }] } });
    expect((await api().getComponent('CKEY')).documentationLinks).toEqual([{ uri: 'http://d' }]);
  });
});

describe('getFileComponentSets', () => {
  it('returns the file library component sets from meta.component_sets', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toContain('/files/abc/component_sets');
      return new Response(JSON.stringify({ meta: { component_sets: [{ key: 'SK', file_key: 'LIB', node_id: '12:395', name: 'navbar', description: 'navbar, topbar' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const sets = await api().getFileComponentSets('abc');
    expect(sets).toEqual([{ key: 'SK', file_key: 'LIB', node_id: '12:395', name: 'navbar', description: 'navbar, topbar' }]);
  });
  it('returns [] when meta.component_sets is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await api().getFileComponentSets('abc')).toEqual([]);
  });
});
