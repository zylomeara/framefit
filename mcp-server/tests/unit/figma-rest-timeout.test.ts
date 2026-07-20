import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });

describe('FigmaRestAdapter default request timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('defaults to 90000ms (aligned with FIGMA_TIMEOUT_MS), not 30000ms', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      }) as Promise<Response>);

    const adapter = new FigmaRestAdapter('tok', logger); // no 4th arg => default timeout
    const p = adapter.getComments('FILEKEY');
    p.catch(() => { /* avoid unhandled rejection during timer advance */ });

    await vi.advanceTimersByTimeAsync(30000);
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(60001);
    await expect(p).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('90000ms') });
  });
});
