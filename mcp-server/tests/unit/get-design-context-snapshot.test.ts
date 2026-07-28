import { describe, it, expect } from 'vitest';
import { registerGetDesignContextTool } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { SnapshotHit } from '../../src/multi-tenant/variable-snapshot-db.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

// Node binds an EXTERNAL library variable (a cross-library alias id) on its fills.
// The local variables index does NOT contain it (it only knows 'V:1'), so the local
// resolveToken returns null and we would normally degrade to the raw paint hex. The
// snapshot resolver must extract the 40-hex published key from the alias id and look
// it up by key.
const EXT_ALIAS_ID = 'VariableID:abcdef0123456789abcdef0123456789abcdef01/9:9';
const EXT_KEY = 'abcdef0123456789abcdef0123456789abcdef01';
const frame = {
  id: '1:5', name: 'Hero', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 80 },
  fills: [{ type: 'SOLID', color: { r: 0.482, g: 0.380, b: 0.965 } }],
  boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: EXT_ALIAS_ID } },
};

function harness(opts: {
  snapshot?: (ids: string[]) => Promise<Map<string, SnapshotHit>>;
  getVariablesLocal?: FigmaApi['getVariablesLocal'];
} = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
      getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getNodesRaw: async () => ({ nodes: { '1:5': { document: frame } } }),
      // Local index knows only V:1 (a different variable). EXT:9 is external.
      getVariablesLocal: opts.getVariablesLocal ?? (async () => ({ meta: {
        variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: { 'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 0, g: 0, b: 0 } } } },
      } })),
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars: 40000,
    ...(opts.snapshot ? { variableSnapshot: { lookup: opts.snapshot } } : {}),
  };
  registerGetDesignContextTool(server, deps);
  return (a: any): Promise<any> => call('get_design_context', a);
}

describe('get_design_context cross-library snapshot resolution', () => {
  it('uses the snapshot hex for an external bound variable instead of the raw paint hex', async () => {
    const seen: string[][] = [];
    const run = harness({
      snapshot: async (keys) => { seen.push(keys); return new Map([[EXT_KEY, { value: '#00ff00', resolved_type: 'COLOR', name: 'lib/green' }]]); },
    });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('#00ff00');            // snapshot hex wins over raw paint hex
    expect(text).not.toContain('#7b61f6');         // raw paint hex must NOT appear
    expect(seen[0]).toContain(EXT_KEY);            // the extracted published key was looked up
  });

  it('falls back to raw paint hex when the snapshot has no hit for the external id', async () => {
    const run = harness({ snapshot: async () => new Map() });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('#7b61f6');             // raw paint hex fallback
  });

  it('does not fail the tool when the snapshot lookup throws (degrades to raw hex)', async () => {
    const run = harness({ snapshot: async () => { throw new Error('db down'); } });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('#7b61f6');
  });

  it('single-tenant (no variableSnapshot) behaviour is unchanged — raw hex for external var', async () => {
    const run = harness();
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('#7b61f6');
  });

  it('prefers the LOCAL token name over the snapshot hex when the binding resolves locally', async () => {
    // Local index now DOES name the bound id (V:1); snapshot is present but must not win.
    const localFrame = { ...frame, boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } } };
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getNodesRaw: async () => ({ nodes: { '1:5': { document: localFrame } } }),
        getVariablesLocal: async () => ({ meta: {
          variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
          variables: { 'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 0, g: 0, b: 0 } } } },
        } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      variableSnapshot: { lookup: async () => new Map([['V:1', { value: '#00ff00', resolved_type: 'COLOR', name: 'lib/green' }]]) },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('color/brand/primary');  // local name wins
    expect(text).not.toContain('#00ff00');           // snapshot hex must not appear
  });
});

describe('get_design_context cross-library graph resolution', () => {
  it('uses the graph hex for an external bound variable (graph preferred over snapshot)', async () => {
    // variableGraph is present and knows EXT_KEY → '#abcdef'; snapshot is also present
    // but must NOT be called (graph wins).
    const snapshotCalled: string[][] = [];
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getNodesRaw: async () => ({ nodes: { '1:5': { document: frame } } }),
        getVariablesLocal: async () => ({ meta: {
          variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
          variables: { 'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 0, g: 0, b: 0 } } } },
        } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      variableGraph: { resolve: (k) => k === EXT_KEY ? { value: '#abcdef' } : undefined },
      variableSnapshot: { lookup: async (keys) => { snapshotCalled.push(keys); return new Map(); } },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('#abcdef');              // graph hex wins
    expect(text).not.toContain('#7b61f6');          // raw paint hex must NOT appear
    expect(snapshotCalled).toHaveLength(0);         // snapshot was never called
  });

  it('falls back to raw paint hex when the graph has no hit for the external key', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getNodesRaw: async () => ({ nodes: { '1:5': { document: frame } } }),
        getVariablesLocal: async () => ({ meta: {
          variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
          variables: { 'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 0, g: 0, b: 0 } } } },
        } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      variableGraph: { resolve: () => undefined },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('#7b61f6');              // raw paint hex fallback
  });

  it('graph-first + per-key snapshot fallback: graph resolves one key, snapshot resolves the other; lookup called with only missed key', async () => {
    // Two external bound vars: one on fills (EXT_ALIAS_ID / EXT_KEY) one on strokes (NEW_KEY).
    // Graph resolves EXT_KEY; snapshot resolves NEW_KEY only.
    const NEW_KEY = 'cccccccccccccccccccccccccccccccccccccccc'; // 40 hex chars
    const NEW_ALIAS_ID = `VariableID:${NEW_KEY}/3:3`;
    const dualFrame = {
      id: '1:5', name: 'Hero', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 80 },
      fills: [{ type: 'SOLID', color: { r: 0.482, g: 0.380, b: 0.965 } }],
      strokes: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 } }],
      boundVariables: {
        fills: { type: 'VARIABLE_ALIAS', id: EXT_ALIAS_ID },
        strokes: { type: 'VARIABLE_ALIAS', id: NEW_ALIAS_ID },
      },
    };
    const snapshotCalls: string[][] = [];
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getNodesRaw: async () => ({ nodes: { '1:5': { document: dualFrame } } }),
        getVariablesLocal: async () => ({ meta: {
          variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
          variables: { 'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 0, g: 0, b: 0 } } } },
        } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      variableGraph: { resolve: (k) => k === EXT_KEY ? { value: '#abcdef' } : undefined },
      variableSnapshot: { lookup: async (keys) => { snapshotCalls.push(keys); return new Map([[NEW_KEY, { value: '#cccccc', resolved_type: 'COLOR', name: 'lib/stroke' }]]); } },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    // graph hex for fills (EXT_KEY resolved by graph)
    expect(text).toContain('#abcdef');
    // snapshot hex for strokes (NEW_KEY resolved by snapshot fallback)
    expect(text).toContain('#cccccc');
    // snapshot lookup was called exactly once, with only the missed key (NEW_KEY), not EXT_KEY
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).not.toContain(EXT_KEY);
    expect(snapshotCalls[0]).toContain(NEW_KEY);
  });

  it('snapshot path still works when no variableGraph is present (existing behaviour preserved)', async () => {
    const seen: string[][] = [];
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getNodesRaw: async () => ({ nodes: { '1:5': { document: frame } } }),
        getVariablesLocal: async () => ({ meta: {
          variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
          variables: { 'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 0, g: 0, b: 0 } } } },
        } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      variableSnapshot: { lookup: async (keys) => { seen.push(keys); return new Map([[EXT_KEY, { value: '#00ff00', resolved_type: 'COLOR', name: 'lib/green' }]]); } },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('#00ff00');              // snapshot hex wins
    expect(text).not.toContain('#7b61f6');          // raw paint must NOT appear
    expect(seen[0]).toContain(EXT_KEY);             // snapshot was called
  });
});
