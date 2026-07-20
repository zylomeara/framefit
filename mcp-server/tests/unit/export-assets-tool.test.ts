import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExportAssetsTool } from '../../src/adapters/driving/tools/export-assets-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';

const logger = createLogger({ level: 'silent' });

function harness(over: Partial<FigmaApi> = {}) {
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server = { tool: (n: string, _d: string, _s: unknown, h: (a: any) => Promise<any>) => { handlers[n] = h; } } as unknown as McpServer;
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any,
      getImages: async (_fileKey: string, ids: string[], opts: any) =>
        ({ images: Object.fromEntries(ids.map((id) => [id, `https://s3/${id}.${opts.format}`])) }),
      getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getNodesRaw: async () => ({ nodes: {} }),
      getVariablesLocal: async () => ({ meta: { variableCollections: {}, variables: {} } }),
      ...over,
    } as FigmaApi),
    defaultToken: 'figd_x', logger,
  };
  registerExportAssetsTool(server, deps);
  return handlers.export_assets;
}

describe('export_assets tool', () => {
  it('returns signed urls per node id', async () => {
    const run = harness();
    const res = await run({ file: 'abc', node_ids: ['1:2', '3:4'], format: 'png' });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.assets).toHaveLength(2);
    expect(body.assets[0]).toMatchObject({ node_id: '1:2', url: 'https://s3/1:2.png' });
    expect(body.assets[1]).toMatchObject({ node_id: '3:4', url: 'https://s3/3:4.png' });
    expect(body.format).toBe('png');
  });

  it('returns url:null for a node id that failed to render', async () => {
    const run = harness({
      getImages: async () => ({ images: { '1:2': null } }),
    });
    const res = await run({ file: 'abc', node_ids: ['1:2'], format: 'svg' });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.assets[0].url).toBeNull();
  });

  it('returns isError for an invalid node id format', async () => {
    const run = harness();
    const res = await run({ file: 'abc', node_ids: ['not-a-valid-id'], format: 'png' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/invalid node id/i);
  });

  it('deduplicates node ids that normalize to the same id (1-2 and 1:2)', async () => {
    const run = harness();
    const res = await run({ file: 'abc', node_ids: ['1-2', '1:2'], format: 'png' });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0]).toMatchObject({ node_id: '1:2', url: 'https://s3/1:2.png' });
  });

  it('does not fetch raw images by default', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: {} }));
    const getImageFills = vi.fn(async () => ({ images: {} }));
    const run = harness({ getNodesRaw, getImageFills });
    const res = await run({ file: 'abc', node_ids: ['1:2'], format: 'png' });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.assets[0].raw_images).toBeUndefined();
    expect(getNodesRaw).not.toHaveBeenCalled();
    expect(getImageFills).not.toHaveBeenCalled();
  });

  it('include_raw_images attaches the original image-fill urls per node', async () => {
    const run = harness({
      getNodesRaw: async (_f: string, _ids: string[]) => ({ nodes: { '1:2': { document: { id: '1:2', name: 'N', type: 'FRAME', fills: [{ type: 'IMAGE', imageRef: 'aaa' }] } } } }),
      getImageFills: async () => ({ images: { aaa: 'https://figma/aaa', bbb: 'https://figma/bbb' } }),
    });
    const res = await run({ file: 'abc', node_ids: ['1:2'], format: 'png', include_raw_images: true });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.assets[0].url).toBe('https://s3/1:2.png'); // render url contract unchanged
    expect(body.assets[0].raw_images).toEqual([{ imageRef: 'aaa', url: 'https://figma/aaa' }]);
  });

  it('omits an imageRef that is missing from the image-fills map', async () => {
    const run = harness({
      getNodesRaw: async () => ({ nodes: { '1:2': { document: { id: '1:2', name: 'N', type: 'FRAME', fills: [{ type: 'IMAGE', imageRef: 'zzz' }] } } } }),
      getImageFills: async () => ({ images: {} }),
    });
    const res = await run({ file: 'abc', node_ids: ['1:2'], format: 'png', include_raw_images: true });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.assets[0].raw_images).toEqual([]);
  });

  it('skips getImageFills entirely when the subtree has no IMAGE fills', async () => {
    const getImageFills = vi.fn(async () => ({ images: {} }));
    const run = harness({
      getNodesRaw: async () => ({ nodes: { '1:2': { document: { id: '1:2', name: 'N', type: 'FRAME', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] } } } }),
      getImageFills,
    });
    const res = await run({ file: 'abc', node_ids: ['1:2'], format: 'png', include_raw_images: true });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.assets[0].raw_images).toEqual([]);
    expect(getImageFills).not.toHaveBeenCalled();
  });
});
