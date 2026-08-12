// Batch 2 item 6 (C): six node_id schemas moved from the strict to the compound pattern
// (get_screenshot, get_metadata, get_design_context, find_nodes, get_text_styles,
// get_variables - the census itself is locked by Gate 5A2's full walk), and export_assets'
// BODY validator (its schema is deliberately patternless - Gate 5A2b) accepts the compound
// form too. /images acceptance was MEASURED live before this shipped: an instance child's
// compound id returned a signed url with the exact key echoed. These are the
// handler-level locks: normalization reaches the port with the compound id intact
// (dash segments normalized to colons), and export_assets' silent-null case is named.
import { describe, it, expect, vi } from 'vitest';
import { registerGetMetadataTool } from '../../src/adapters/driving/tools/get-metadata-tool.js';
import { registerGetScreenshotTool } from '../../src/adapters/driving/tools/get-screenshot-tool.js';
import { registerGetTextStylesTool } from '../../src/adapters/driving/tools/get-text-styles-tool.js';
import { registerExportAssetsTool } from '../../src/adapters/driving/tools/export-assets-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
const CID = 'I12:340;56:7890';
const deps = (api: Partial<FigmaApi>): ToolDeps =>
  ({ buildApi: () => api as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 }) as ToolDeps;

describe('compound ids reach the port normalized (dash segments -> colons, I prefix kept)', () => {
  it('get_metadata', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { [CID]: { document: { id: CID, name: 'body', type: 'FRAME' } } } }));
    const { server, call } = makeFakeMcpServer();
    registerGetMetadataTool(server, deps({ getNodesRaw }));
    const res = await call('get_metadata', { file: 'abc', node_id: 'I12-340;56-7890', depth: 2 });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', [CID], expect.anything());
    expect(res.isError).not.toBe(true);
  });

  it('get_text_styles', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { [CID]: { document: { id: CID, name: 'body', type: 'FRAME' } } } }));
    const { server, call } = makeFakeMcpServer();
    registerGetTextStylesTool(server, deps({ getNodesRaw }));
    const res = await call('get_text_styles', { file: 'abc', node_id: 'I12-340;56-7890', depth: 4 });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', [CID], expect.anything());
    expect(res.isError).not.toBe(true);
  });

  it('get_screenshot: the /nodes pre-probe and /images carry the SAME compound id, keyed response resolves', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { [CID]: { document: {
      id: CID, name: 'body', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 } } } } }));
    const getImages = vi.fn(async () => ({ images: { [CID]: 'https://img.example/x' } }));
    const { server, call } = makeFakeMcpServer();
    registerGetScreenshotTool(server, deps({ getNodesRaw, getImages }));
    const res = await call('get_screenshot', { file: 'abc', node_id: 'I12-340;56-7890' });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', [CID], 1);
    expect(getImages).toHaveBeenCalledWith('abc', [CID], expect.anything());
    const out = JSON.parse(res.content[0].text as string);
    expect(out.url).toBe('https://img.example/x');
    expect(out.node_id).toBe(CID);
  });
});

describe('export_assets: the body validator (patternless schema) accepts compound, refuses malformed, names silent nulls', () => {
  const run = (api: Partial<FigmaApi>) => {
    const { server, call } = makeFakeMcpServer();
    registerExportAssetsTool(server, deps(api));
    return (a: unknown): Promise<{ isError?: boolean; content: { text?: string }[] }> => call('export_assets', a as never);
  };

  it('a compound id yields an asset row, not isError', async () => {
    const getImages = vi.fn(async () => ({ images: { [CID]: 'https://img.example/a' } }));
    const res = await run({ getImages })({ file: 'abc', node_ids: ['I12-340;56-7890'] });
    expect(res.isError).not.toBe(true);
    const out = JSON.parse(res.content[0].text as string);
    expect(out.assets).toEqual([{ node_id: CID, url: 'https://img.example/a' }]);
  });

  it('a malformed id is refused by the body with the server message naming the compound form', async () => {
    const res = await run({})({ file: 'abc', node_ids: ['not-an-id'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/nested-instance id/);
  });

  it('an id absent from the /images map gets a note naming it - never a bare url:null', async () => {
    const getImages = vi.fn(async () => ({ images: {} as Record<string, string> }));
    const res = await run({ getImages })({ file: 'abc', node_ids: [CID] });
    const out = JSON.parse(res.content[0].text as string);
    expect(out.assets[0].url).toBeNull();
    expect(out.assets[0].note).toContain(CID);
  });

  it('a rendered-but-null entry (Figma explicitly could not render) keeps url:null WITHOUT the absent-id note', async () => {
    const getImages = vi.fn(async () => ({ images: { [CID]: null } as never }));
    const res = await run({ getImages })({ file: 'abc', node_ids: [CID] });
    const out = JSON.parse(res.content[0].text as string);
    expect(out.assets[0].url).toBeNull();
    expect(out.assets[0].note).toBeUndefined();
  });
});
