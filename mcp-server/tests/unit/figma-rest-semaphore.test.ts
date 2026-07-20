import { describe, it, expect, vi, afterEach } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { Semaphore } from '../../src/infrastructure/semaphore.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => { vi.restoreAllMocks(); });

function stubFetch(track: { inflight: number; peak: number }) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    track.inflight++; track.peak = Math.max(track.peak, track.inflight);
    await new Promise((r) => setTimeout(r, 10));
    track.inflight--;
    return { ok: true, status: 200, text: async () => JSON.stringify({ document: { id: '0:0', name: 'r', type: 'FRAME' }, nodes: {} }) } as unknown as Response;
  }));
}

describe('FigmaRestAdapter heavy-fetch concurrency', () => {
  it('serializes heavy fetches under a Semaphore(1)', async () => {
    const track = { inflight: 0, peak: 0 };
    stubFetch(track);
    const api = new FigmaRestAdapter('tok', logger, 4, 90000, undefined, new Semaphore(1));
    await Promise.all([api.getDocumentRaw('k', 2), api.getNodesRaw('k', ['1:2'], 2)]);
    expect(track.peak).toBe(1);
  });

  it('runs unbounded when no Semaphore is provided', async () => {
    const track = { inflight: 0, peak: 0 };
    stubFetch(track);
    const api = new FigmaRestAdapter('tok', logger, 4, 90000); // no semaphore
    await Promise.all([api.getDocumentRaw('k', 2), api.getNodesRaw('k', ['1:2'], 2)]);
    expect(track.peak).toBe(2);
  });

  it('serializes getVariablesLocal under the Semaphore(1) alongside heavy fetches', async () => {
    const track = { inflight: 0, peak: 0 };
    stubFetch(track);
    const api = new FigmaRestAdapter('tok', logger, 4, 90000, undefined, new Semaphore(1));
    await Promise.all([api.getVariablesLocal('k'), api.getNodesRaw('k', ['1:2'], 2)]);
    expect(track.peak).toBe(1);
  });
});
