import { describe, it, expect, vi, afterEach } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { Semaphore } from '../../src/infrastructure/semaphore.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Minimal Response-like for getDocumentRaw's request<RawFileResponse>.
const okDoc = () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ document: { id: '0:0', name: 'r', type: 'DOCUMENT' }, nodes: {} }),
}) as unknown as Response;

describe('FigmaRestAdapter deadline-aware requests (R9-F1)', () => {
  it('(1) an already-past deadlineAt rejects with a timed-out FigmaApiError WITHOUT issuing fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // 7th positional param = deadlineAt, already in the past.
    const adapter = new FigmaRestAdapter('tok', logger, 4, 90000, undefined, undefined, Date.now() - 1000);
    await expect(adapter.getComments('FILEKEY')).rejects.toMatchObject({
      kind: 'network', message: expect.stringContaining('timed out'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();   // exited before the network call
  });

  it('(2) with a live deadline shorter than timeoutMs, the abort fires at the deadline (fetch invoked, aborted early)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      }) as Promise<Response>);

    // timeoutMs=90s but deadline only 5s out → effectiveMs clamps to the deadline.
    const adapter = new FigmaRestAdapter('tok', logger, 4, 90000, undefined, undefined, Date.now() + 5000);
    const p = adapter.getComments('FILEKEY');
    p.catch(() => { /* avoid unhandled rejection during timer advance */ });

    // fetch was actually issued (unlike case 1), and we are not aborted before the deadline.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    // ...and it aborts once the deadline (not the 90s timeout) elapses.
    await vi.advanceTimersByTimeAsync(1001);
    await expect(p).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('timed out') });
  });

  it('(3) a semaphore-queued call whose deadline expired while waiting exits immediately after dequeue and frees the slot', async () => {
    const sem = new Semaphore(1);
    const events: string[] = [];
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => { releaseHolder = r; });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('holderKey')) { events.push('holder-fetch'); await holderGate; return okDoc(); }
      if (u.includes('liveKey')) { events.push('live-fetch'); return okDoc(); }
      events.push('expired-fetch');   // MUST NOT happen — the deadline check short-circuits first
      return okDoc();
    }));

    const holder = new FigmaRestAdapter('tok', logger, 4, 90000, undefined, sem);                       // no deadline
    const expired = new FigmaRestAdapter('tok', logger, 4, 90000, undefined, sem, Date.now() - 1);      // deadline already gone
    const live = new FigmaRestAdapter('tok', logger, 4, 90000, undefined, sem, Date.now() + 90000);     // healthy deadline

    // holder acquires the single slot synchronously and blocks on the gate; the other two queue FIFO.
    const pHolder = holder.getDocumentRaw('holderKey', 2);
    const pExpired = expired.getDocumentRaw('expiredKey', 2);
    const pLive = live.getDocumentRaw('liveKey', 2);

    // Release the holder → slot passes to `expired` (which must bail in ~1ms, freeing it) → then `live`.
    releaseHolder();

    await expect(pExpired).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('timed out') });
    await expect(pLive).resolves.toBeDefined();     // the next queued caller proceeded — slot was not pinned
    await expect(pHolder).resolves.toBeDefined();
    expect(events).not.toContain('expired-fetch');  // the expired request never touched the network
    expect(events).toContain('live-fetch');
  });
});
