import { describe, it, expect, vi } from 'vitest';
import { registerGetMetadataTool } from '../../src/adapters/driving/tools/get-metadata-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function harness(api: Partial<FigmaApi>, maxResultChars = 40000) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(),
      getFileStructure: async () => ({}) as any, getImages: async () => ({ images: {} }),
      getVariablesLocal: async () => ({}), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getDocumentRaw: async () => ({ name: 'F', lastModified: 'X', version: '1', document: { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: [{ id: '1:0', name: 'Page', type: 'CANVAS' }] } }),
      getNodesRaw: async () => ({ nodes: {} }),
      ...api,
    } as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars,
  };
  registerGetMetadataTool(server, deps);
  return (a: any): Promise<any> => call('get_metadata', a);
}

describe('get_metadata tool', () => {
  it('whole-file: returns sparse tree of the document', async () => {
    const run = harness({});
    const res = await run({ file: 'abc', depth: 3 });
    const text = res.content[0].text as string;
    expect(text).toContain('"name":"Page"');
    expect(text).toContain('"type":"CANVAS"');
  });

  it('node-scoped: uses getNodesRaw when node_id given', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:5': { document: { id: '1:5', name: 'Hero', type: 'FRAME' } } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 2 });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:5'], 2);
    expect(res.content[0].text).toContain('"name":"Hero"');
  });

  it('errors on bad file', async () => {
    const run = harness({});
    const res = await run({ file: '@@@', depth: 2 });
    expect(res.isError).toBe(true);
  });

  it('auto-reduces depth instead of refusing when over budget', async () => {
    const big = { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: Array.from({ length: 40 }, (_, i) => ({
      id: `1:${i}`, name: `frame-${i}`, type: 'FRAME',
      absoluteBoundingBox: { x: i, y: i, width: 100, height: 50 },
      children: [{ id: `2:${i}`, name: `child-${i}`, type: 'TEXT', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } }],
    })) };
    const run = harness({ getDocumentRaw: async () => ({ name: 'F', lastModified: 'X', version: '1', document: big }) }, 1500);
    const res = await run({ file: 'abc', depth: 4 });
    const out = JSON.parse(res.content[0].text);
    expect(res.isError).toBeUndefined();
    expect(out.degraded).toBe(true);              // it degraded rather than refused
    expect(out.depth).toBeLessThan(4);            // depth was reduced
    expect(out.name).toBe('Doc');                 // real tree, not a warning stub
    expect(res.content[0].text).not.toMatch(/Re-run with a lower depth/);
    // Co-lock on delivery ≤ budget (compact measure + truncation stub). Live measures @1500: compact+stub
    // → delivered 1392 ≤ 1500 (GREEN); compact-without-stub → 1608 > 1500 (RED — truncation block after
    // the measure); current pretty → 971 ≤ 1500 (over-clamp masks it). We never exceed the budget.
    expect(res.content[0].text.length).toBeLessThanOrEqual(1500);
  });

  it('returns the tree untouched (degraded:false) when it fits', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:5': { document: { id: '1:5', name: 'Hero', type: 'FRAME' } } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 2 });
    const out = JSON.parse(res.content[0].text);
    expect(out.degraded).toBe(false);
    expect(out.name).toBe('Hero');
  });
});
