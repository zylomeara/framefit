import { describe, it, expect } from 'vitest';
import { registerGetLibrariesTool } from '../../src/adapters/driving/tools/get-libraries-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

const DOC = (components: any = {}, componentSets: any = {}) => ({
  name: 'F', lastModified: 'X', version: '1',
  document: { id: '0:0', name: 'Doc', type: 'DOCUMENT' },
  components, componentSets,
});

function harness(api: Partial<FigmaApi>) {
  const { server, call } = makeFakeMcpServer();
  const base = {
    getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
    getDocumentRaw: async () => DOC(), getNodesRaw: async () => ({ nodes: {} }), getImages: async () => ({ images: {} }),
    getVariablesLocal: async () => ({}), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
    getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
    getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'C' }),
  };
  const deps: ToolDeps = { buildApi: () => ({ ...base, ...api } as FigmaApi), defaultToken: 'figd_x', logger };
  registerGetLibrariesTool(server, deps);
  return (a: any): Promise<any> => call('get_libraries', a);
}

describe('get_libraries tool', () => {
  it('publishes from the file\'s own published components; no remote refs → consumes empty', async () => {
    const run = harness({
      getFileComponents: async () => [
        { key: 'a', file_key: 'abc', node_id: '1:1', name: 'Button', description: '' },
        { key: 'b', file_key: 'abc', node_id: '1:2', name: 'Card', description: '' },
      ],
      getDocumentRaw: async () => DOC({ 'C:1': { key: 'k1', name: 'Local', remote: false } }),
    });
    const res = await run({ file: 'abc' });
    const body = JSON.parse(res.content[0].text);
    expect(body.publishes.count).toBe(1);
    expect(body.publishes.libraries[0].file_key).toBe('abc');
    expect(body.publishes.libraries[0].component_count).toBe(2);
    expect(body.publishes.libraries[0].sample).toContain('Button');
    expect(body.consumes.count).toBe(0);
  });

  it('consumes: remote component refs resolved + grouped by source library, sorted by count', async () => {
    const run = harness({
      getDocumentRaw: async () => DOC({
        'C:1': { key: 'k1', remote: true },
        'C:2': { key: 'k2', remote: true },
        'C:3': { key: 'k3', remote: true },
      }),
      getComponent: async (key: string) => ({
        k1: { key: 'k1', file_key: 'libA', node_id: '2:1', name: 'Btn' },
        k2: { key: 'k2', file_key: 'libA', node_id: '2:2', name: 'Chip' },
        k3: { key: 'k3', file_key: 'libB', node_id: '3:1', name: 'Icon' },
      } as any)[key],
    });
    const res = await run({ file: 'abc' });
    const body = JSON.parse(res.content[0].text);
    expect(body.consumes.count).toBe(2);
    expect(body.consumes.libraries[0].file_key).toBe('libA');
    expect(body.consumes.libraries[0].component_count).toBe(2);
    expect(body.consumes.libraries[0].sample).toEqual(expect.arrayContaining(['Btn', 'Chip']));
    expect(body.consumes.libraries[1].file_key).toBe('libB');
  });

  it('includes remote componentSets alongside components', async () => {
    const run = harness({
      getDocumentRaw: async () => DOC({ 'C:1': { key: 'k1', remote: true } }, { 'S:1': { key: 'ks', remote: true } }),
      getComponent: async (key: string) => ({
        k1: { key: 'k1', file_key: 'libA', node_id: '2:1', name: 'Btn' },
        ks: { key: 'ks', file_key: 'libA', node_id: '2:9', name: 'BtnSet' },
      } as any)[key],
    });
    const res = await run({ file: 'abc' });
    const body = JSON.parse(res.content[0].text);
    expect(body.consumes.libraries[0].component_count).toBe(2);
    expect(body.consumes.libraries[0].sample).toEqual(expect.arrayContaining(['Btn', 'BtnSet']));
  });

  it('ignores local (non-remote) components for consumes', async () => {
    const run = harness({
      getDocumentRaw: async () => DOC({ 'C:1': { key: 'k1', remote: false }, 'C:2': { key: 'k2' } }),
    });
    const res = await run({ file: 'abc' });
    const body = JSON.parse(res.content[0].text);
    expect(body.consumes.count).toBe(0);
  });

  it('skips a component that fails to resolve and flags degraded', async () => {
    const run = harness({
      getDocumentRaw: async () => DOC({ 'C:1': { key: 'k1', remote: true }, 'C:2': { key: 'k2', remote: true } }),
      getComponent: async (key: string) => {
        if (key === 'k2') throw new Error('boom');
        return { key, file_key: 'libA', node_id: '2:1', name: 'Btn' };
      },
    });
    const res = await run({ file: 'abc' });
    const body = JSON.parse(res.content[0].text);
    expect(body.consumes.count).toBe(1);
    expect(body.degraded).toBe(true);
  });

  it('propagates rate limiting so the agent backs off', async () => {
    const run = harness({
      getDocumentRaw: async () => DOC({ 'C:1': { key: 'k1', remote: true } }),
      getComponent: async () => { throw new FigmaApiError('rate_limited', 429, 'slow down'); },
    });
    const res = await run({ file: 'abc' });
    expect(res.isError).toBe(true);
  });

  it('excludes a remote ref that resolves back to the queried file (self-reference)', async () => {
    const run = harness({
      getDocumentRaw: async () => DOC({ 'C:1': { key: 'k1', remote: true } }),
      getComponent: async () => ({ key: 'k1', file_key: 'abc', node_id: '1:9', name: 'Self' }),
    });
    const res = await run({ file: 'abc' });
    const body = JSON.parse(res.content[0].text);
    expect(body.consumes.count).toBe(0);
  });

  it('node_id scopes the consume scan to a subtree via getNodesRaw', async () => {
    const run = harness({
      getNodesRaw: async (_f: string, ids: string[]) => ({
        nodes: Object.fromEntries(ids.map((i) => [i, { document: { id: i, name: 'F', type: 'FRAME' }, components: { 'C:1': { key: 'k1', remote: true } } }])),
      }),
      getComponent: async () => ({ key: 'k1', file_key: 'libA', node_id: '2:1', name: 'Btn' }),
    });
    const res = await run({ file: 'abc', node_id: '1-5' });
    const body = JSON.parse(res.content[0].text);
    expect(body.consumes.libraries[0].file_key).toBe('libA');
  });

  it('errors on bad file', async () => {
    const run = harness({});
    const res = await run({ file: '@@@' });
    expect(res.isError).toBe(true);
  });
});
