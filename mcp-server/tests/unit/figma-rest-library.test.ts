import { describe, it, expect, afterEach, vi } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string) => { status?: number; body: unknown }) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const api = () => new FigmaRestAdapter('figd_x', logger, 4, 30000);

describe('FigmaRestAdapter library methods', () => {
  it('getTeamLibrary fetches components, component_sets, styles', async () => {
    stub((url) => {
      if (url.includes('/teams/T1/components')) return { body: { meta: { components: [{ key: 'c1', file_key: 'F', node_id: '1:1', name: 'Button', description: 'primary' }] } } };
      if (url.includes('/teams/T1/component_sets')) return { body: { meta: { component_sets: [{ key: 's1', file_key: 'F', node_id: '2:1', name: 'ButtonSet', description: '' }] } } };
      if (url.includes('/teams/T1/styles')) return { body: { meta: { styles: [{ key: 'st1', file_key: 'F', node_id: '3:1', name: 'color/brand', description: '', style_type: 'FILL' }] } } };
      throw new Error(`unexpected ${url}`);
    });
    const lib = await api().getTeamLibrary('T1');
    expect(lib.components[0].name).toBe('Button');
    expect(lib.componentSets[0].name).toBe('ButtonSet');
    expect(lib.styles[0].style_type).toBe('FILL');
  });

  it('getTeamLibrary follows cursor.after pagination', async () => {
    const fn = stub((url) => {
      if (url.includes('/components')) {
        if (url.includes('after=10')) return { body: { meta: { components: [{ key: 'c2', file_key: 'F', node_id: '1:2', name: 'B2', description: '' }] } } };
        return { body: { meta: { components: [{ key: 'c1', file_key: 'F', node_id: '1:1', name: 'B1', description: '' }], cursor: { after: 10 } } } };
      }
      return { body: { meta: { component_sets: [], styles: [] } } };
    });
    const lib = await api().getTeamLibrary('T1');
    expect(lib.components.map((c) => c.key)).toEqual(['c1', 'c2']);
    expect(fn.mock.calls.filter(([u]) => (u as string).includes('/components')).length).toBe(2);
  });

  it('getFileComponents returns the file library components', async () => {
    stub((url) => {
      expect(url).toContain('/files/abc/components');
      return { body: { meta: { components: [{ key: 'c1', file_key: 'lib1', node_id: '1:1', name: 'Card', description: '' }] } } };
    });
    const comps = await api().getFileComponents('abc');
    expect(comps[0].file_key).toBe('lib1');
  });

  it('getTeamLibrary maps 403 to forbidden', async () => {
    stub(() => ({ status: 403, body: { err: 'no' } }));
    await expect(api().getTeamLibrary('T1')).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('stops at the page cap and warns when the cursor still dangles (truncation)', async () => {
    const warnings: unknown[] = [];
    const spyLogger = { ...logger, warn: (obj: unknown) => { warnings.push(obj); } } as typeof logger;
    // every /components page returns 1 item + a dangling cursor → would loop forever without the cap
    const fn = stub((url) => {
      if (url.includes('/components')) return { body: { meta: { components: [{ key: 'c', file_key: 'F', node_id: '1:1', name: 'B', description: '' }], cursor: { after: 999 } } } };
      return { body: { meta: { component_sets: [], styles: [] } } };
    });
    const adapter = new FigmaRestAdapter('figd_x', spyLogger, 4, 30000);
    const lib = await adapter.getTeamLibrary('T1');
    const compCalls = fn.mock.calls.filter(([u]) => (u as string).includes('/components')).length;
    expect(compCalls).toBe(20);                 // capped at 20 pages
    expect(lib.components.length).toBe(20);
    expect(warnings.length).toBeGreaterThan(0); // truncation warned
  });
});
