import { describe, it, expect } from 'vitest';
import { registerGetCodeConnectMapTool } from '../../src/adapters/driving/tools/get-code-connect-map-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function harness(withCC: boolean) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }), getVariablesLocal: async () => ({}),
      getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
      getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button' }),
      getNodesRaw: async () => ({ nodes: { '1:6': { document: { id: '1:6', name: 'Btn', type: 'INSTANCE', componentId: 'C:1' }, components: { 'C:1': { key: 'KEY1' } } } } }),
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger,
    ...(withCC ? { codeConnect: { lookup: async () => new Map([['LIB|7:7', { component_name: 'Button', source: 's', template: 't', template_data: {}, label: 'React' }]]) } } : {}),
  };
  registerGetCodeConnectMapTool(server, deps);
  return (a: Record<string, unknown>) => call('get_code_connect_map', a);
}

function ccHarness(cc: any, apiOverrides: Partial<FigmaApi> = {}) {
  const { server, call } = makeFakeMcpServer();
  const baseApi = {
    getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
    getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }), getVariablesLocal: async () => ({}),
    getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
    getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
    getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button' }),
    getNodesRaw: async () => ({ nodes: { '1:6': { document: { id: '1:6', name: 'Btn', type: 'INSTANCE', componentId: 'C:1' }, components: { 'C:1': { key: 'KEY1' } } } } }),
  };
  const deps: ToolDeps = {
    buildApi: () => ({ ...baseApi, ...apiOverrides } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger,
    codeConnect: cc,
  };
  registerGetCodeConnectMapTool(server, deps);
  return (a: Record<string, unknown>) => call('get_code_connect_map', a);
}

describe('get_code_connect_map tool', () => {
  it('returns node_id→snippet for mapped instances', async () => {
    const run = harness(true);
    const res = await run({ file: 'abc', node_ids: ['1-6'] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.map['1:6']).toMatchObject({ component: 'Button' });
  });
  it('reports nothing when Code Connect is unavailable (single-tenant)', async () => {
    const run = harness(false);
    const res = await run({ file: 'abc', node_ids: ['1-6'] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.count).toBe(0);
  });
  it('reports partial misses via requested vs count', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }), getVariablesLocal: async () => ({}),
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
        getComponent: async (key: string) => (key === 'KEY1'
          ? { key, file_key: 'LIB', node_id: '7:7', name: 'Button' }
          : { key, file_key: 'LIB', node_id: '8:8', name: 'Card' }),
        getNodesRaw: async () => ({ nodes: {
          '1:6': { document: { id: '1:6', name: 'Btn', type: 'INSTANCE', componentId: 'C:1' }, components: { 'C:1': { key: 'KEY1' } } },
          '1:7': { document: { id: '1:7', name: 'Crd', type: 'INSTANCE', componentId: 'C:2' }, components: { 'C:2': { key: 'KEY2' } } },
        } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
      codeConnect: { lookup: async () => new Map([['LIB|7:7', { component_name: 'Button', source: 's', template: 't', template_data: {}, label: 'React' }]]) },
    };
    registerGetCodeConnectMapTool(server, deps);
    const res = await call('get_code_connect_map', { file: 'abc', node_ids: ['1-6', '1-7'] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.requested).toBe(2);
    expect(body.count).toBe(1);
    expect(body.map['1:6']).toMatchObject({ component: 'Button' });
    expect(body.map['1:7']).toBeUndefined();
  });

  it('exposes instances/resolvedComponents counters on success', async () => {
    const run = harness(true);
    const res = await run({ file: 'abc', node_ids: ['1-6'] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.instances).toBe(1);
    expect(body.resolvedComponents).toBe(1);
  });

  it('single-tenant empty result carries reason not_configured', async () => {
    const run = harness(false);
    const res = await run({ file: 'abc', node_ids: ['1-6'] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.count).toBe(0);
    expect(body.reason).toBe('not_configured');
    expect(body.note).toBeTruthy();
  });

  it('reports reason no_mappings when an instance resolves but has no mapping', async () => {
    const run = ccHarness({ lookup: async () => new Map() });
    const res = await run({ file: 'abc', node_ids: ['1-6'] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.count).toBe(0);
    expect(body.reason).toBe('no_mappings');
    expect(body.note).toMatch(/figma connect parse/);
  });

  it('reports reason no_instances when no requested node is an instance', async () => {
    const run = ccHarness(
      { lookup: async () => new Map() },
      { getNodesRaw: async () => ({ nodes: { '1:6': { document: { id: '1:6', name: 'Frame', type: 'FRAME' }, components: {} } } }) },
    );
    const res = await run({ file: 'abc', node_ids: ['1-6'] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.reason).toBe('no_instances');
    expect(body.note).toMatch(/instance/i);
  });

  it('reports reason components_unresolved when component resolution fails', async () => {
    const run = ccHarness(
      { lookup: async () => new Map() },
      { getComponent: async () => { throw new Error('boom'); } },
    );
    const res = await run({ file: 'abc', node_ids: ['1-6'] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.instances).toBe(1);
    expect(body.resolvedComponents).toBe(0);
    expect(body.reason).toBe('components_unresolved');
  });

  it('normalizes + resolves a URL-form nested-instance compound id', async () => {
    const restKey = 'I12:340;56:7890';   // the colon form Figma keys its /nodes response by
    const run = ccHarness(
      { lookup: async () => new Map([['LIB|7:7', { component_name: 'WayOfPayment', source: 's', template: 't', template_data: {}, label: 'React' }]]) },
      // Mock keys the response by the *correctly* normalized id, regardless of what the handler passes.
      { getNodesRaw: async () => ({ nodes: {
        [restKey]: { document: { id: restKey, name: 'way of payment', type: 'INSTANCE', componentId: 'C:1' }, components: { 'C:1': { key: 'KEY1' } } },
      } }) },
    );
    const res = await run({ file: 'abc', node_ids: ['I12-340;56-7890'] }); // URL/dash form input
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.map[restKey]).toMatchObject({ component: 'WayOfPayment' });
  });

  it('resolves a compound id via document.id fallback when Figma keys the entry differently', async () => {
    const wanted = 'I12:340;56:7890';
    const run = ccHarness(
      { lookup: async () => new Map([['LIB|7:7', { component_name: 'WayOfPayment', source: 's', template: 't', template_data: {}, label: 'React' }]]) },
      // Response is keyed by an arbitrary/different string, but document.id IS the requested compound id.
      { getNodesRaw: async () => ({ nodes: {
        'someOtherKey': { document: { id: wanted, name: 'way of payment', type: 'INSTANCE', componentId: 'C:1' }, components: { 'C:1': { key: 'KEY1' } } },
      } }) },
    );
    const res = await run({ file: 'abc', node_ids: [wanted] });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.map[wanted]).toMatchObject({ component: 'WayOfPayment' });
  });
});
