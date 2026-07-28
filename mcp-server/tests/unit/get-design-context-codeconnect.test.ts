import { describe, it, expect } from 'vitest';
import { registerGetDesignContextTool } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
const frame = { id: '1:5', name: 'Card', type: 'FRAME', children: [{ id: '1:6', name: 'Btn', type: 'INSTANCE', componentId: 'C:1' }] };

function harness(withCodeConnect: boolean) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
      getVariablesLocal: async () => { throw Object.assign(new Error('no'), {}); },
      getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
      getNodesRaw: async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1' } } } } }),
      getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button' }),
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars: 40000,
    ...(withCodeConnect ? { codeConnect: { lookup: async () => new Map([['LIB|7:7', { component_name: 'Button', source: 's', template: 't', template_data: { imports: ['import {Button}'] }, label: 'React' }]]) } } : {}),
  };
  registerGetDesignContextTool(server, deps);
  return (a: any): Promise<any> => call('get_design_context', a);
}

function mkDoc(opts: { getComponent?: FigmaApi['getComponent']; getFileComponentSets?: FigmaApi['getFileComponentSets']; getNodesRaw?: FigmaApi['getNodesRaw']; withCodeConnect?: boolean }) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
      getVariablesLocal: async () => { throw new Error('no'); },
      getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
      getNodesRaw: opts.getNodesRaw ?? (async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1' } } } } })),
      getComponent: opts.getComponent ?? (async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button' })),
      getFileComponentSets: opts.getFileComponentSets ?? (async () => []),
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars: 40000,
    ...(opts.withCodeConnect ? { codeConnect: { lookup: async () => new Map() } } : {}),
  };
  registerGetDesignContextTool(server, deps);
  return (a: any): Promise<any> => call('get_design_context', a);
}

const withDesc = async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button', description: 'Primary action', componentSetId: 'CS:1', documentationLinks: [{ uri: 'https://docs/btn' }] });

describe('get_design_context component descriptions', () => {
  it('includes component descriptions in a components map keyed by component id', async () => {
    const run = mkDoc({ getComponent: withDesc });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(body.components['C:1']).toMatchObject({ description: 'Primary action', docs: ['https://docs/btn'] });
    expect(body.components['C:1'].componentSet).toBeUndefined(); // no set list provided → set desc omitted
  });

  it('surfaces the component-SET description (componentSetId from the per-node components ref)', async () => {
    const run = mkDoc({
      // componentSetId lives on the components ref in the /nodes response, not on getComponent's meta.
      getNodesRaw: async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1', componentSetId: '2534:50016' } } } } }),
      getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'navbar / controlAccent', description: '' }),
      getFileComponentSets: async (fk: string) => fk === 'LIB' ? [{ key: 'SK', file_key: 'LIB', node_id: '2534:50016', name: 'navbar', description: 'navbar, topbar, навигация' }] : [],
    });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(body.components['C:1'].componentSet).toEqual({ name: 'navbar', description: 'navbar, topbar, навигация' });
    expect(body.components['C:1'].description).toBeUndefined();
  });

  it('omits the components map when include_component_docs is false', async () => {
    const run = mkDoc({ getComponent: withDesc });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.components).toBeUndefined();
  });

  it('surfaces descriptions even without Code Connect (single-tenant)', async () => {
    const run = mkDoc({ getComponent: withDesc });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(body.components['C:1'].description).toBe('Primary action');
    expect(body.codeConnect).toBeUndefined();
  });

  it('fetches each distinct component once even with docs + Code Connect both on', async () => {
    let calls = 0;
    const run = mkDoc({ withCodeConnect: true, getComponent: async (key: string) => { calls++; return { key, file_key: 'LIB', node_id: '7:7', name: 'Button', description: 'Primary action' }; } });
    await run({ file: 'abc', node_id: '1-5', depth: 4, include_component_docs: true });
    expect(calls).toBe(1);
  });
});

describe('get_design_context Code Connect enrichment', () => {
  it('attaches a snippet for an instance when mappings exist', async () => {
    const run = harness(true);
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const body = JSON.parse(res.content[0].text);
    expect(body.codeConnect['1:6']).toMatchObject({ component: 'Button', imports: ['import {Button}'] });
  });
  it('no codeConnect field when deps.codeConnect is absent (single-tenant)', async () => {
    const run = harness(false);
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const body = JSON.parse(res.content[0].text);
    expect(body.codeConnect).toBeUndefined();
  });

  it('R4-F4: a component_docs fetch error records a degraded_stage (not just a log line)', async () => {
    const run = mkDoc({
      // componentSetId on the ref makes the docs path fetch the set list; that fetch throws a plain
      // (non-rate_limited) error, so the whole enrichment fan-out lands in the outer catch.
      getNodesRaw: async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1', componentSetId: 'CS:1' } } } } }),
      getFileComponentSets: async () => { throw new Error('sets boom'); },
    });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();                                  // docs are optional — call still succeeds
    expect(body.degraded_stages).toContainEqual({ stage: 'component_docs', reason: 'error' });
  });

  it('R4-F4: a code_connect lookup error records a degraded_stage', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getVariablesLocal: async () => { throw new Error('no'); },
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
        getNodesRaw: async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1' } } } } }),
        getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button' }),
        getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      codeConnect: { lookup: async () => { throw new Error('cc boom'); } },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();
    expect(body.degraded_stages).toContainEqual({ stage: 'code_connect', reason: 'error' });
    expect(body.degraded_stages).not.toContainEqual({ stage: 'component_docs', reason: 'error' }); // wantDocs was false
  });

  it('R5-F4: a docs failure AFTER Code Connect succeeded degrades ONLY component_docs (payload stays consistent)', async () => {
    // CC resolution runs first and produces its payload; the LATER set-docs fetch throws. The
    // response must carry the real codeConnect data AND must NOT list code_connect as degraded —
    // a stage cannot be simultaneously present and failed.
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getVariablesLocal: async () => { throw new Error('no'); },
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
        getNodesRaw: async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1', componentSetId: 'CS:1' } } } } }),
        getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button' }),
        getFileComponentSets: async () => { throw new Error('sets boom'); },
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      codeConnect: { lookup: async () => new Map([['LIB|7:7', { component_name: 'Button', source: 's', template: 't', template_data: { imports: ['import {Button}'] }, label: 'React' }]]) },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4, include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();
    expect(body.codeConnect['1:6']).toMatchObject({ component: 'Button' });   // CC payload survived
    expect(body.degraded_stages).toContainEqual({ stage: 'component_docs', reason: 'error' });
    expect((body.degraded_stages ?? []).some((d: any) => d.stage === 'code_connect')).toBe(false);
  });

  it('R7-F1: CC resolves EMPTY (zero mappings) + a LATER docs failure must NOT mark code_connect degraded', async () => {
    // CC lookup completes successfully with zero mappings (a real, unremarkable outcome — e.g. no
    // Code Connect published for this component). The LATER docs fetch throws a plain error. Before
    // the fix, `codeConnect === undefined` (an empty payload looks identical to "never ran") made the
    // shared catch falsely attribute the docs failure to code_connect too.
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getVariablesLocal: async () => { throw new Error('no'); },
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
        getNodesRaw: async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1', componentSetId: 'CS:1' } } } } }),
        getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button' }),
        getFileComponentSets: async () => { throw new Error('sets boom'); },
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      codeConnect: { lookup: async () => new Map() },   // resolves — legitimately zero mappings
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4, include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();
    expect(body.codeConnect).toBeUndefined();                         // legitimately empty — not an error
    expect(body.degraded_stages).toContainEqual({ stage: 'component_docs', reason: 'error' });
    expect((body.degraded_stages ?? []).some((d: any) => d.stage === 'code_connect')).toBe(false);
  });

  it('R10-F1: a code_connect lookup failure does not block docs — docs succeed independently', async () => {
    // codeConnect.lookup throws a plain error; the shared keyToMeta getComponent fetch already
    // completed (withDesc succeeds), so the docs path CAN and must still succeed. Before the fix,
    // CC and docs shared one try/catch: the throw skipped the docs block entirely, yet the blanket
    // `if (wantDocs && !docsResolved)` check falsely marked component_docs degraded too.
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getVariablesLocal: async () => { throw new Error('no'); },
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
        getNodesRaw: async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1' } } } } }),
        getComponent: withDesc,
        getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      codeConnect: { lookup: async () => { throw new Error('cc boom'); } },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4, include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();
    expect(body.components['C:1']).toMatchObject({ description: 'Primary action' });   // docs produced!
    expect(body.degraded_stages).toContainEqual({ stage: 'code_connect', reason: 'error' });
    expect(body.degraded_stages).not.toContainEqual(expect.objectContaining({ stage: 'component_docs' }));
  });

  it('surfaces rate_limited from getComponent (does not silently drop snippets)', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getVariablesLocal: async () => { throw Object.assign(new Error('no'), {}); },
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }), getFileComponents: async () => [],
        getNodesRaw: async () => ({ nodes: { '1:5': { document: frame, components: { 'C:1': { key: 'KEY1' } } } } }),
        getComponent: async () => { throw new FigmaApiError('rate_limited', 429, 'slow down'); },
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      codeConnect: { lookup: async () => new Map() },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/rate_limited|rate limit/i);
  });
});
