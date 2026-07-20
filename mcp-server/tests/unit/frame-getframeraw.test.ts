import { describe, it, expect, vi } from 'vitest';
import { CachingFigmaApiAdapter } from '../../src/adapters/driven/caching-figma-api.js';
import { FrameHydrationStore, makeFrameHandle } from '../../src/infrastructure/frame-hydration-store.js';
import { Semaphore } from '../../src/infrastructure/semaphore.js';
import { tagBytes } from '../../src/infrastructure/response-size.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { RawNodesResponse } from '../../src/domain/figma-raw.js';
import type { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import { makeReadCaches } from '../../src/infrastructure/server.js';
import { loadConfig } from '../../src/infrastructure/config.js';

const logger = createLogger({ level: 'silent' });
// mock raw of a controllable wire size (tagBytes so sizeOf reads it, as FigmaRestAdapter would)
const raw = (id: string, wire = 1000): RawNodesResponse => {
  const r: RawNodesResponse = { nodes: { [id]: { document: { id, name: id, type: 'FRAME' } as any } } };
  tagBytes(r, wire);
  return r;
};

function makeAdapter(inner: Partial<FigmaApi>, store: FrameHydrationStore, owner = 'u1', opts: any = {}) {
  const config = loadConfig({});
  const fileStructure = { get: () => undefined, set: () => {} } as unknown as FileStructureCache;
  const read = makeReadCaches(config, logger, undefined, store, owner);
  return new CachingFigmaApiAdapter(inner as FigmaApi, fileStructure, logger, read, {
    frameMaxParseBytes: config.FRAME_MAX_PARSE_BYTES,
    frameParseMultiplier: config.FRAME_PARSE_MULTIPLIER,
    materializeGovernor: new Semaphore(1),
    ...opts,
  });
}

const version = { version: 'v1', lastModified: 'x' } as any;

describe('CachingFigmaApiAdapter.getFrameRaw', () => {
  it('MISS: fetches at requestedMaxDepth+1, holds it, returns hydrated:true', async () => {
    const getNodesRaw = vi.fn(async () => raw('a'));
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store);
    const res = await a.getFrameRaw('fk', ['a'], 4);
    expect(getNodesRaw).toHaveBeenCalledWith('fk', ['a'], 5); // depth = max_depth+1
    expect(res.heldDepth).toBe(5);
    expect(res.hydrated).toBe(true);
    expect(res.effectiveMaxDepth).toBe(4);
  });

  it('HIT (deeper held): no fetch, returns held raw and effectiveMaxDepth == requested', async () => {
    const getNodesRaw = vi.fn(async () => raw('a'));
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    // seed a depth-9 hold under the same key the adapter will compute
    store.setIfDeeper('u1', 'fk|v1|frame:a', raw('deep'), 9, 100);
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store);
    const res = await a.getFrameRaw('fk', ['a'], 4);
    expect(getNodesRaw).not.toHaveBeenCalled();
    expect(res.heldDepth).toBe(9);
    expect(res.effectiveMaxDepth).toBe(4);
    expect(Object.keys(res.raw.nodes)[0]).toBe('deep');
  });

  it('over parse cap: hydrated:false, NOT held (a second call re-fetches)', async () => {
    const getNodesRaw = vi.fn(async () => raw('big', 999_999_999)); // way over FRAME_MAX_PARSE_BYTES
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store);
    const first = await a.getFrameRaw('fk', ['big'], 4);
    expect(first.hydrated).toBe(false);
    const second = await a.getFrameRaw('fk', ['big'], 4);
    expect(second.hydrated).toBe(false);
    expect(getNodesRaw).toHaveBeenCalledTimes(2); // not held → re-fetched
  });

  it('bypasses nodeCache: getFrameRaw does not populate the shared nodeCache', async () => {
    const getNodesRaw = vi.fn(async () => raw('a'));
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store);
    await a.getFrameRaw('fk', ['a'], 4);
    // a subsequent getNodesRaw for the same ids+depth still hits the network (nodeCache empty)
    await a.getNodesRaw('fk', ['a'], 5);
    expect(getNodesRaw).toHaveBeenCalledTimes(2);
  });

  it('monotonic race: concurrent want-4 and want-6 → two fetches; the deeper hold wins', async () => {
    let calls = 0;
    const getNodesRaw = vi.fn(async (_fk: string, _ids: string[], depth: number) => { calls += 1; return raw(`d${depth}`); });
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store);
    const [r4, r6] = await Promise.all([a.getFrameRaw('fk', ['a'], 4), a.getFrameRaw('fk', ['a'], 6)]);
    expect(calls).toBe(2); // distinct fetch depths → two in-flight (dedup key includes depth)
    const held = store.get('u1', 'fk|v1|frame:a', 5);
    expect(held?.heldDepth).toBe(7); // want-6 fetched depth 7, deeper wins
    expect([r4.heldDepth, r6.heldDepth]).toContain(7);
  });

  it('backoff-clamp: a deep fetch aborts (too_large) but a shallower raw is held → serve it clamped', async () => {
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    store.setIfDeeper('u1', 'fk|v1|frame:a', raw('shallow'), 5, 100); // prior depth-5 hold
    const getNodesRaw = vi.fn(async () => { throw new FigmaApiError('too_large', 0, 'boom'); });
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store);
    const res = await a.getFrameRaw('fk', ['a'], 8); // wants depth 9, aborts
    expect(res.hydrated).toBe(true);
    expect(res.heldDepth).toBe(5);
    expect(res.effectiveMaxDepth).toBe(4); // clamp to heldDepth - 1
    expect(Object.keys(res.raw.nodes)[0]).toBe('shallow');
  });

  it('backoff with NO held fallback re-throws (honest failure)', async () => {
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    const getNodesRaw = vi.fn(async () => { throw new FigmaApiError('too_large', 0, 'boom'); });
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store);
    await expect(a.getFrameRaw('fk', ['a'], 8)).rejects.toThrow(/too_large|boom/);
  });

  it('backoff clamp fires ONLY on too_large: a non-too_large error propagates even WITH a held fallback (never-mask)', async () => {
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    store.setIfDeeper('u1', 'fk|v1|frame:a', raw('shallow'), 5, 100); // prior depth-5 hold present
    // A hard upstream failure (5xx) is NOT a size abort — it must NOT be masked as a shallower success.
    const getNodesRaw = vi.fn(async () => { throw new FigmaApiError('upstream', 500, 'boom'); });
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store);
    await expect(a.getFrameRaw('fk', ['a'], 8)).rejects.toThrow(/boom|upstream/);
  });

  it('gates the parse-into-heap through the materialize governor (MISS path)', async () => {
    const getNodesRaw = vi.fn(async () => raw('a'));
    const getFileVersion = vi.fn(async () => version);
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    const governor = new Semaphore(1);
    const runSpy = vi.spyOn(governor, 'run');
    const a = makeAdapter({ getNodesRaw, getFileVersion }, store, 'u1', { materializeGovernor: governor });
    await a.getFrameRaw('fk', ['a'], 4);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
