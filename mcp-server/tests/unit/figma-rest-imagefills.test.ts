import { describe, it, expect, afterEach, vi } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.unstubAllGlobals());
const api = () => new FigmaRestAdapter('figd_x', logger, 4, 30000);

describe('getImageFills', () => {
  it('returns the imageRef→url map from GET /v1/files/:key/images meta.images', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toContain('/files/abc/images');
      return new Response(JSON.stringify({ meta: { images: { aaa: 'https://x/aaa', bbb: 'https://x/bbb' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    expect(await api().getImageFills('abc')).toEqual({ images: { aaa: 'https://x/aaa', bbb: 'https://x/bbb' } });
  });

  it('returns empty images when meta.images is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await api().getImageFills('abc')).toEqual({ images: {} });
  });
});
