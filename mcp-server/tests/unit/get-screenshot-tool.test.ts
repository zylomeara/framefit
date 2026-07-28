import { describe, it, expect, vi, afterEach } from 'vitest';
import { Jimp } from 'jimp';
import { registerGetScreenshotTool } from '../../src/adapters/driving/tools/get-screenshot-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.unstubAllGlobals());

function harness(getImages: FigmaApi['getImages'], getNodesRaw?: FigmaApi['getNodesRaw']) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [],
      resolveNodes: async (_f: string, ids: string[]) => new Map(ids.map((i) => [i, { name: 'n', page_name: 'p' }])),
      getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any,
      // default: every requested node exists with a 360×891 bbox (so happy-path screenshots proceed to getImages)
      getNodesRaw: getNodesRaw ?? (async (_f: string, ids: string[]) => ({
        nodes: Object.fromEntries(ids.map((i) => [i, { document: { id: i, name: 'n', absoluteBoundingBox: { x: 0, y: 0, width: 360, height: 891 } }, components: {} }])),
      })),
      getVariablesLocal: async () => ({}), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getImages,
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger,
  };
  registerGetScreenshotTool(server, deps);
  return (a: Record<string, unknown>) => call('get_screenshot', a);
}

describe('get_screenshot tool', () => {
  it('url mode (default): returns the signed URL + dimensions without downloading', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const run = harness(async () => ({ images: { '1:5': 'https://s3/i.png' } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png', scale: 2 });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.url).toBe('https://s3/i.png');
    expect(body.original_width).toBe(360);
    expect(body.original_height).toBe(891);
    expect(body.width).toBe(720); // 360 × scale 2
    expect(body.height).toBe(1782); // 891 × scale 2
    expect(body.note).toMatch(/curl/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('url mode for svg: keeps original dims but omits scaled width/height', async () => {
    const run = harness(async () => ({ images: { '1:5': 'https://s3/i.svg' } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'svg' });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.url).toBe('https://s3/i.svg');
    expect(body.original_width).toBe(360);
    expect(body.width).toBeUndefined();
  });

  it('PNG inline: downloads the signed URL and returns base64 image content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/png' } })));
    const run = harness(async () => ({ images: { '1:5': 'https://s3/i.png' } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png', scale: 2, return: 'inline' });
    const img = res.content.find((c) => c.type === 'image')!;
    expect(img).toBeTruthy();
    expect(img.mimeType).toBe('image/png');
    expect(img.data).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  it('SVG inline: returns markup as text (no download to base64)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg>x</svg>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })));
    const run = harness(async () => ({ images: { '1:5': 'https://s3/i.svg' } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'svg', return: 'inline' });
    expect(res.content[0].text).toContain('<svg>');
  });

  it('errors when Figma returns no image for the node', async () => {
    const run = harness(async () => ({ images: { '1:5': null } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png' });
    expect(res.isError).toBe(true);
  });

  it('fast "not found" when the node does not exist — skips the slow /images call', async () => {
    const getImages = vi.fn(async () => ({ images: {} }));
    const run = harness(getImages as unknown as FigmaApi['getImages'], async () => ({ nodes: {} }));
    const res = await run({ file: 'abc', node_id: '9-9', format: 'png' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(getImages).not.toHaveBeenCalled();
  });

  it('rejects an oversized image (Content-Length over cap) with a lower-scale hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { 'content-type': 'image/png', 'content-length': String(20 * 1024 * 1024) },
    })));
    const run = harness(async () => ({ images: { '1:5': 'https://s3/big.png' } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png', scale: 4, return: 'inline' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/scale/i);
  });

  it('rejects when the downloaded body exceeds the cap even without Content-Length', async () => {
    const big = new Uint8Array(9 * 1024 * 1024); // 9MB > 8MB cap
    vi.stubGlobal('fetch', vi.fn(async () => new Response(big, { status: 200, headers: { 'content-type': 'image/png' } })));
    const run = harness(async () => ({ images: { '1:5': 'https://s3/big.png' } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png', return: 'inline' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/large|scale/i);
  });

  it('preview mode: returns a downscaled inline image plus the full-res url (one call)', async () => {
    // Large node (4000×4000) → preview auto-scales down to ≈768px longest side.
    const getNodesRaw = (async (_f: string, ids: string[]) => ({
      nodes: Object.fromEntries(ids.map((i) => [i, { document: { id: i, name: 'n', absoluteBoundingBox: { x: 0, y: 0, width: 4000, height: 4000 } }, components: {} }])),
    })) as unknown as FigmaApi['getNodesRaw'];
    const getImages = vi.fn(async (_f: string, ids: string[], opts: any) => ({
      images: { [ids[0]]: `https://s3/${opts.scale}.png` },
    })) as unknown as FigmaApi['getImages'];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { 'content-type': 'image/png' } })));
    const run = harness(getImages, getNodesRaw);
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png', scale: 2, return: 'preview' });
    const img = res.content.find((c) => c.type === 'image')!;
    const meta = JSON.parse(textOf(res.content.find((c) => c.type === 'text')));
    expect(img.mimeType).toBe('image/png');
    expect(img.data).toBe(Buffer.from([9, 9, 9]).toString('base64'));
    expect(meta.preview_scale).toBeCloseTo(0.19, 2); // 768 / 4000
    expect(meta.full_res_url).toBe('https://s3/2.png');  // url rendered at requested scale 2
    expect(meta.original_width).toBe(4000);
    expect(meta.preview_width).toBe(Math.round(4000 * 0.19));   // 760
    expect(meta.preview_height).toBe(Math.round(4000 * 0.19));  // 760
  });

  it('preview mode: never upscales past the requested scale', async () => {
    const getImages = vi.fn(async (_f: string, ids: string[], opts: any) => ({
      images: { [ids[0]]: `https://s3/${opts.scale}.png` },
    })) as unknown as FigmaApi['getImages'];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } })));
    const run = harness(getImages); // default node 360×891 (longest 891 > 768 → slight downscale)
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png', scale: 1, return: 'preview' });
    const meta = JSON.parse(textOf(res.content.find((c) => c.type === 'text')));
    expect(meta.preview_scale).toBeLessThanOrEqual(1);
    expect(meta.preview_scale).toBeCloseTo(0.86, 2); // 768 / 891
    expect(meta.preview_width).toBe(Math.round(360 * meta.preview_scale));
    expect(meta.preview_height).toBe(Math.round(891 * meta.preview_scale));
    expect(getImages).toHaveBeenCalled();
  });

  it('SVG inline: errors on a non-200 download (HTTP status preserved)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>err</html>', { status: 500, headers: { 'content-type': 'text/html' } })));
    const run = harness(async () => ({ images: { '1:5': 'https://s3/i.svg' } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'svg', return: 'inline' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/HTTP 500/);
  });

  it('focus mode: returns a zoomed PNG crop centered on the point, with region + full_res_url', async () => {
    const png = await new Jimp({ width: 200, height: 200, color: 0x3366ccff }).getBuffer('image/png');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })));
    const getImages = vi.fn(async (_f: string, ids: string[], opts: any) => ({
      images: { [ids[0]]: `https://s3/${opts.format}-${opts.scale}.png` },
    })) as unknown as FigmaApi['getImages'];
    const run = harness(getImages); // default node 360×891
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png', scale: 2, focus: { x: 0.5, y: 0.5 } });
    const img = res.content.find((c) => c.type === 'image')!;
    const meta = JSON.parse(textOf(res.content.find((c) => c.type === 'text')));
    expect(img.mimeType).toBe('image/png');
    const out = await Jimp.read(Buffer.from(img.data, 'base64'));
    expect(out.bitmap.width).toBe(48);            // 2 × 0.12 × 200 (source image is 200 wide)
    expect(meta.region).toBeTruthy();
    expect(meta.full_res_url).toBe('https://s3/png-2.png'); // full-res keeps requested format+scale
    expect(meta.source_scale).toBe(2);            // 512/(2×0.12×360)=5.9 → clamped to min(scale,4)=2
  });

  it('focus mode: errors for svg (no raster to crop)', async () => {
    const run = harness(async () => ({ images: { '1:5': 'https://s3/i.svg' } }));
    const res = await run({ file: 'abc', node_id: '1-5', format: 'svg', focus: { x: 0.5, y: 0.5 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/raster|png/i);
  });

  it('focus mode: errors when the node has no bounding box', async () => {
    const noBbox = (async (_f: string, ids: string[]) => ({
      nodes: Object.fromEntries(ids.map((i) => [i, { document: { id: i, name: 'n' }, components: {} }])),
    })) as unknown as FigmaApi['getNodesRaw'];
    const run = harness(async () => ({ images: { '1:5': 'https://s3/i.png' } }), noBbox);
    const res = await run({ file: 'abc', node_id: '1-5', format: 'png', focus: { x: 0.5, y: 0.5 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/bounding box/i);
  });
});
