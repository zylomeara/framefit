import { afterEach, describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import { registerGetScreenshotTool } from '../../src/adapters/driving/tools/get-screenshot-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

afterEach(() => vi.unstubAllGlobals());

async function png(color = 0xefeff5ff, width = 3, height = 3): Promise<Buffer> {
  return new Jimp({ width, height, color }).getBuffer('image/png');
}

function harness(getImages: FigmaApi['getImages'], width = 100, height = 100) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getNodesRaw: async (_f: string, ids: string[]) => ({
        nodes: Object.fromEntries(ids.map((id) => [id, {
          document: { id, name: 'node', absoluteBoundingBox: { x: 0, y: 0, width, height } },
        }])),
      }),
      getImages,
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger,
  };
  registerGetScreenshotTool(server, deps);
  return (args: Record<string, unknown>) => call('get_screenshot', args);
}

const probe = { x: 0.5, y: 0.5, space: 'normalized' as const, radius: 0, expected: '#efeff5', tolerance: 2 };

describe('get_screenshot color probe', () => {
  it('adds an OK probe receipt to URL output with one extra PNG download and no extra render request', async () => {
    const getImages = vi.fn(async () => ({ images: { '1:5': 'https://signed/main.png' } }));
    const fetchSpy = vi.fn(async () => new Response(await png() as unknown as BodyInit, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await harness(getImages as unknown as FigmaApi['getImages'])({
      file: 'abc', node_id: '1:5', format: 'png', probe,
    });

    const output = JSON.parse(textOf(result.content[0]));
    expect(output.color_probe).toMatchObject({
      status: 'ok', source_coordinates: { x: 1, y: 1, width: 3, height: 3 },
      sampled_rgba: { r: 239, g: 239, b: 245, a: 255 }, expected: '#efeff5', tolerance: 2, matches_expected: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getImages).toHaveBeenCalledTimes(1);
  });

  it('keeps a rendered URL when PNG sampling is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const result = await harness(async () => ({ images: { '1:5': 'https://signed/main.png' } }))({
      file: 'abc', node_id: '1:5', format: 'png', probe,
    });

    const output = JSON.parse(textOf(result.content[0]));
    expect(output.url).toBe('https://signed/main.png');
    expect(output.color_probe).toEqual({ status: 'unavailable', reason: 'rendered PNG could not be sampled' });
  });

  it('samples the main PNG before a distinct preview render and keeps the existing metadata item', async () => {
    const main = await png();
    const previewImage = await png(0x102030ff, 200, 200);
    const getImages = vi.fn(async (_file: string, _ids: string[], options: { scale: number }) => ({
      images: { '1:5': options.scale === 2 ? 'https://signed/main.png' : 'https://signed/preview.png' },
    }));
    const fetchSpy = vi.fn(async (url: string) => new Response(
      (url === 'https://signed/main.png' ? main : previewImage) as unknown as BodyInit,
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    const preview = await harness(getImages as unknown as FigmaApi['getImages'], 4000, 4000)({
      file: 'abc', node_id: '1:5', format: 'png', scale: 2, return: 'preview', probe,
    });
    const previewMeta = JSON.parse(textOf(preview.content.find((content) => content.type === 'text')));
    expect(preview.content).toHaveLength(2);
    expect(previewMeta.color_probe).toMatchObject({
      status: 'ok', source_coordinates: { x: 1, y: 1, width: 3, height: 3 },
      sampled_rgba: { r: 239, g: 239, b: 245, a: 255 }, matches_expected: true,
    });
    expect(getImages.mock.calls.map((call) => call[2]?.scale)).toEqual([2, 0.19]);
    expect((fetchSpy.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
      'https://signed/main.png', 'https://signed/preview.png',
    ]);
    const deliveredPreviewBlock = preview.content[0];
    if (deliveredPreviewBlock.type !== 'image') throw new Error('preview must deliver an image block');
    const deliveredPreview = await Jimp.read(Buffer.from(deliveredPreviewBlock.data, 'base64'));
    expect(deliveredPreview.getPixelColor(0, 0)).toBe(0x102030ff);
  });

  it('samples the main PNG before a distinct focus render and keeps the existing metadata item', async () => {
    const main = await png();
    const focusImage = await png(0x102030ff, 200, 200);
    const getImages = vi.fn(async (_file: string, _ids: string[], options: { scale: number }) => ({
      images: { '1:5': options.scale === 2 ? 'https://signed/main.png' : 'https://signed/focus.png' },
    }));
    const fetchSpy = vi.fn(async (url: string) => new Response(
      (url === 'https://signed/main.png' ? main : focusImage) as unknown as BodyInit,
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    const focus = await harness(getImages as unknown as FigmaApi['getImages'], 4000, 4000)({
      file: 'abc', node_id: '1:5', format: 'png', scale: 2, focus: { x: 0.5, y: 0.5 }, probe,
    });
    const focusMeta = JSON.parse(textOf(focus.content.find((content) => content.type === 'text')));
    expect(focus.content).toHaveLength(2);
    expect(focusMeta.color_probe).toMatchObject({
      status: 'ok', source_coordinates: { x: 1, y: 1, width: 3, height: 3 },
      sampled_rgba: { r: 239, g: 239, b: 245, a: 255 }, matches_expected: true,
    });
    expect(getImages.mock.calls.map((call) => call[2]?.scale)).toEqual([2, 0.53]);
    expect((fetchSpy.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
      'https://signed/main.png', 'https://signed/focus.png',
    ]);
  });

  it('adds exactly one metadata item to inline output when probing', async () => {
    const fetchSpy = vi.fn(async () => new Response(await png() as unknown as BodyInit, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await harness(async () => ({ images: { '1:5': 'https://signed/main.png' } }))({
      file: 'abc', node_id: '1:5', format: 'png', return: 'inline', probe,
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('image');
    expect(JSON.parse(textOf(result.content[1])).color_probe.status).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects probes for non-PNG output', async () => {
    const getImages = vi.fn(async () => ({ images: { '1:5': 'https://signed/main.jpg' } }));
    const result = await harness(getImages as unknown as FigmaApi['getImages'])({
      file: 'abc', node_id: '1:5', format: 'jpg', probe,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result.content[0])).toMatch(/probe.*PNG|PNG.*probe/i);
    expect(getImages).not.toHaveBeenCalled();
  });

  it('rejects a pixel probe outside the delivered full-node raster', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(await png() as unknown as BodyInit, { status: 200 })));
    const result = await harness(async () => ({ images: { '1:5': 'https://signed/main.png' } }))({
      file: 'abc', node_id: '1:5', format: 'png', probe: { ...probe, x: 3, y: 0, space: 'pixel' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result.content[0])).toMatch(/outside the rendered PNG/);
  });
});
