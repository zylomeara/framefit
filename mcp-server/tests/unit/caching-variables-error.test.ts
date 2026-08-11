import { describe, it, expect, vi, afterEach } from 'vitest';
import { CachingFigmaApiAdapter, type ReadCaches } from '../../src/adapters/driven/caching-figma-api.js';
import { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import { TtlCache } from '../../src/infrastructure/node-cache.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import { timeoutMessage, isTimeoutMessage } from '../../src/adapters/driven/figma-rest.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.useRealTimers());

function fakeApi(over: Partial<FigmaApi> = {}): FigmaApi {
  return {
    getComments: async () => [],
    resolveNodes: async () => new Map(),
    getFileStructure: async () => ({ nodeById: new Map(), pageNameByNodeId: new Map(), childrenByNodeId: new Map() }) as any,
    getDocumentRaw: async () => ({ name: 'F', lastModified: 'X', version: '1', document: { id: '0:0', name: 'D', type: 'DOCUMENT' } }),
    getNodesRaw: async () => ({ nodes: {} }),
    getImages: async () => ({ images: {} }),
    getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
    getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
    getTeamLibrary: async () => ({ components: [], componentSets: [], styles: [] }),
    getFileComponents: async () => [],
    getFileComponentSets: async () => [],
    getImageFills: async () => ({ images: {} }),
    getComponent: async () => ({ key: 'k', file_key: 'F', node_id: '1:1', name: 'C' }),
    ...over,
  } as unknown as FigmaApi;
}

function freshCaches(): ReadCaches {
  return {
    nodeCache: new TtlCache(300_000),
    variablesCache: new TtlCache(300_000),
    variablesErrorCache: new TtlCache<string>(600_000),
    versionCache: new TtlCache(60_000),
    librariesCache: new TtlCache(300_000),
    componentCache: new TtlCache(300_000),
    docCache: new TtlCache(300_000),
    componentSetsCache: new TtlCache(300_000),
    imageFillsCache: new TtlCache(300_000),
  };
}

// Default timeoutMs mirrors the server factory (always passes a concrete cap — timeoutMs ??
// FIGMA_TIMEOUT_MS=90s), so negative-cache markers carry capMs and the cap-aware READ engages.
// `caches` is a parameter so a test can share ONE readCaches across adapters with different caps.
// The `shortenedTimeout` opts-key is GONE (dead-field removal) — capMs
// semantics now come from `timeoutMs` alone (no boolean "is this shortened" flag at all).
function makeApi(over: Partial<FigmaApi>, opts?: { timeoutMs?: number }, caches = freshCaches()) {
  return new CachingFigmaApiAdapter(fakeApi(over), new FileStructureCache(300_000), logger, caches, { timeoutMs: 90_000, ...opts });
}

describe('negative variables-error cache', () => {
  it('a failed getVariablesLocal is remembered: second call throws instantly with the cached: prefix', async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      // R11-F1: the write gate is now an explicit WHITELIST keyed on FigmaApiError kind, not a
      // blacklist — 'upstream' (5xx) is cacheable evidence, so this fixture uses a real
      // FigmaApiError (a plain Error is NEVER cached now — see the dedicated test below).
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('upstream', 500, 'Figma had an internal error'); },
    };
    const api = makeApi(inner);
    await expect(api.getVariablesLocal('F')).rejects.toThrow('internal error');
    await expect(api.getVariablesLocal('F')).rejects.toThrow(/^cached: /);
    expect(calls).toBe(1);                            // second call never reached the inner api
  });

  // R8-F3: 'forbidden' is a per-TOKEN verdict, never cacheable (see the dedicated describe below)
  // — so the kind-preserving-reconstruction property is now pinned with 'upstream' (a
  // token-INDEPENDENT kind that IS cacheable), not 'forbidden'.
  it('the cached rethrow preserves FigmaApiError kind/status (kind-preserving reconstruction)', async () => {
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { throw new FigmaApiError('upstream', 500, 'Figma had an internal error'); },
    };
    const api = makeApi(inner);
    await expect(api.getVariablesLocal('F')).rejects.toThrow('internal error');
    const err = await api.getVariablesLocal('F').then(() => null, (e) => e);
    expect(err).toBeInstanceOf(FigmaApiError);
    expect((err as FigmaApiError).kind).toBe('upstream');
    expect((err as FigmaApiError).status).toBe(500);
    expect((err as Error).message.startsWith('cached: ')).toBe(true); // classifier contract stays
  });

  // R11-F1: the negative-cache WRITE gate is now an explicit WHITELIST (matches the class-level
  // comment's promise: only 'upstream' (5xx) / 'unknown_4xx' (400) / a timeout are cacheable — see
  // capMs-semantics above for how the timeout's cap gets bounded on READ), not a blacklist. The
  // prior behavior here — stamping an ARBITRARY non-FigmaApiError exception as kind:'upstream' and
  // caching it — was itself unverified evidence (a transient
  // ECONNRESET, or any other thrown value, is not proof the endpoint is broken). Narrowed: a
  // non-FigmaApiError exception is NEVER cached now.
  it('a non-FigmaApiError exception (e.g. a plain Error) is NEVER negative-cached', async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new Error('boom'); },
    };
    const api = makeApi(inner);
    await expect(api.getVariablesLocal('F')).rejects.toThrow('boom');
    await expect(api.getVariablesLocal('F')).rejects.toThrow('boom');   // reached inner again — no marker
    expect(calls).toBe(2);
  });

  // R11-F1: a non-timeout 'network' FigmaApiError (e.g. a connection reset) is NOT cacheable
  // evidence the endpoint is broken — it's a transient connectivity blip, not the 'timed out'
  // shape the class comment's "timeout" carve-out names. Only a message containing 'timed out' is
  // a cacheable timeout (any cap — the shortened-cap carve-out was dropped, see the
  // capMs-semantics describe block below); every other 'network'-kinded failure is never written,
  // regardless of cap.
  it("a non-timeout 'network' FigmaApiError (e.g. ECONNRESET) is NEVER negative-cached, even under a full cap", async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('network', 0, 'Could not reach Figma API: ECONNRESET'); },
    };
    const api = makeApi(inner, { timeoutMs: 90_000 });
    await expect(api.getVariablesLocal('F')).rejects.toThrow('ECONNRESET');
    await expect(api.getVariablesLocal('F')).rejects.toThrow('ECONNRESET');   // reached inner again — no marker
    expect(calls).toBe(2);
  });

  // R11-F1: 'unknown_4xx' (400 — malformed regardless of who's asking) is named as cacheable
  // evidence in the class-level comment but had no dedicated pin; added here for completeness.
  it("a 'unknown_4xx' (400) failure IS negative-cached (token-independent, malformed-request evidence)", async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('unknown_4xx', 400, 'Figma rejected the request'); },
    };
    const api = makeApi(inner);
    await expect(api.getVariablesLocal('F')).rejects.toThrow('rejected the request');
    await expect(api.getVariablesLocal('F')).rejects.toThrow(/^cached: /);
    expect(calls).toBe(1);
  });

  it('rate_limited is NEVER negative-cached', async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('rate_limited', 429, 'slow down', 5); },
    };
    const api = makeApi(inner);
    await expect(api.getVariablesLocal('F')).rejects.toThrow('slow down');
    await expect(api.getVariablesLocal('F')).rejects.toThrow('slow down');   // real call again
    expect(calls).toBe(2);
  });

  // DELIBERATE UPDATE: the lock that used
  // to live here ("a timeout observed under a SHORTENED cap is NOT cap-independent evidence, so
  // shortenedTimeout must SUPPRESS the write") has been DELETED. That suppression rested on a false
  // premise: it would have made every WARM 20s-capped compare-tool call (VARIABLES_FETCH_CAP_MS)
  // re-pay the full 20s timeout on EVERY call — a regression against today's write-once-cached-
  // forever behavior. The `shortenedTimeout` boolean field itself is gone (dead-field
  // removal). Suppression is replaced by capMs-semantics: a capped timeout DOES write a marker
  // (below), and the cap-aware READ (`this.timeoutMs <= parsed.capMs`) is monotonic on its own —
  // "didn't answer within 20s" is valid evidence exactly for callers configured to wait no longer
  // than 20s, and a call with a LARGER budget bypasses the marker to really try (see the mirror
  // group below). The three tests below replace the deleted lock's intent.
  describe('capMs-semantics replaces shortened-cap suppression', () => {
    it('a capped (20s) timeout WRITES a marker with capMs=20000', async () => {
      let calls = 0;
      const inner = {
        getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
        getVariablesLocal: async () => { calls++; throw new FigmaApiError('network', 0, 'Figma request timed out after 20000ms'); },
      };
      const api = makeApi(inner, { timeoutMs: 20_000 });
      await expect(api.getVariablesLocal('F')).rejects.toThrow('timed out');     // writes marker capMs=20000
      expect(calls).toBe(1);
      // Second call of the SAME (20k) adapter — inner is NOT touched, cached rethrow.
      await expect(api.getVariablesLocal('F')).rejects.toThrow(/^cached: /);
      expect(calls).toBe(1);
    });

    it('a reader with a LARGER budget (timeoutMs=90000) passes PAST the capMs=20000 marker — a real fetch', async () => {
      let calls = 0;
      const inner = {
        getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
        getVariablesLocal: async () => { calls++; throw new FigmaApiError('network', 0, 'Figma request timed out after 20000ms'); },
      };
      const caches = freshCaches();
      const a20 = makeApi(inner, { timeoutMs: 20_000 }, caches);
      await expect(a20.getVariablesLocal('F')).rejects.toThrow('timed out');     // marker written by the 20k adapter (shared read cache)
      expect(calls).toBe(1);
      const a90 = makeApi(inner, { timeoutMs: 90_000 }, caches);
      await expect(a90.getVariablesLocal('F')).rejects.toThrow('timed out');     // bypass → inner CALLED again (not cached:)
      expect(calls).toBe(2);
    });

    it('a second 20k reader reuses the marker (inner NOT called)', async () => {
      let calls = 0;
      const inner = {
        getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
        getVariablesLocal: async () => { calls++; throw new FigmaApiError('network', 0, 'Figma request timed out after 20000ms'); },
      };
      const caches = freshCaches();
      const a20first = makeApi(inner, { timeoutMs: 20_000 }, caches);
      await expect(a20first.getVariablesLocal('F')).rejects.toThrow('timed out');
      expect(calls).toBe(1);
      const a20second = makeApi(inner, { timeoutMs: 20_000 }, caches);
      await expect(a20second.getVariablesLocal('F')).rejects.toThrow(/^cached: /);
      expect(calls).toBe(1);                                                     // inner NOT called by the second 20k reader
    });
  });

  // Non-timeout, token-INDEPENDENT failures (400/500) are cap-independent evidence and are STILL
  // written under a small cap — the endpoint is genuinely broken regardless of how long we waited.
  // (R8-F3: 'forbidden' is NOT such a failure — it's a per-token verdict, not endpoint health — see
  // the dedicated describe below; this fixture uses 'upstream'/500 instead.)
  it('a non-timeout, token-independent failure (500) IS negative-cached under a small cap too', async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('upstream', 500, 'Figma had an internal error'); },
    };
    const api = makeApi(inner, { timeoutMs: 25_000 });
    await expect(api.getVariablesLocal('F')).rejects.toThrow('internal error');
    const err = await api.getVariablesLocal('F').then(() => null, (e) => e);
    expect(err).toBeInstanceOf(FigmaApiError);
    expect((err as FigmaApiError).kind).toBe('upstream');
    expect((err as Error).message.startsWith('cached: ')).toBe(true);
    expect(calls).toBe(1);                                                    // second call (same 25s cap) served from the marker
  });

  // Under the FULL default cap (e.g. get_variables' 90s), a timeout IS real evidence the endpoint
  // is broken and is negative-cached (existing behavior, kept intact — capMs-semantics applies
  // uniformly regardless of cap size, see the describe block above).
  it('a TIMEOUT under the full default cap is negative-cached (real evidence)', async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('network', 0, 'Figma request timed out after 90000ms'); },
    };
    const api = makeApi(inner, { timeoutMs: 90_000 });
    await expect(api.getVariablesLocal('F')).rejects.toThrow('timed out');
    await expect(api.getVariablesLocal('F')).rejects.toThrow(/^cached: /);
    expect(calls).toBe(1);
  });

  // R4-F1/F3: the negative-cache READ is cap-aware. A marker written under a 90s cap must NOT be
  // served to a call configured to wait LONGER (get_variables' documented timeout_ms escalation, up
  // to 120s) — that call must bypass the marker and really try. Its success then wins for everyone.
  it('a 90s-cap marker is BYPASSED by a 120s-cap escalation, whose success then overwrites the world', async () => {
    let calls = 0;
    let fail = true;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => {
        calls++;
        if (fail) throw new FigmaApiError('network', 0, 'Figma request timed out after 90000ms');
        return { meta: { variables: {}, variableCollections: {} } };
      },
    };
    const caches = freshCaches();
    const a90 = makeApi(inner, { timeoutMs: 90_000 }, caches);
    await expect(a90.getVariablesLocal('F')).rejects.toThrow('timed out');   // writes marker capMs=90000
    expect(calls).toBe(1);

    // The endpoint was just slow, not broken. A 120s escalation (this.timeoutMs=120000 > capMs=90000)
    // bypasses the stale marker and reaches inner — and succeeds.
    fail = false;
    const a120 = makeApi(inner, { timeoutMs: 120_000 }, caches);
    await expect(a120.getVariablesLocal('F')).resolves.toBeTruthy();         // bypassed → really tried
    expect(calls).toBe(2);

    // That success populated the POSITIVE cache (checked before the negative marker), so a third
    // call back at the 90s cap now gets the positive result — no inner call, no stale error.
    const a90b = makeApi(inner, { timeoutMs: 90_000 }, caches);
    await expect(a90b.getVariablesLocal('F')).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });

  // The mirror case: a call whose cap is <= the marker cap is served the instant cached error —
  // waiting no longer than what already failed cannot help, so bypassing would only burn budget.
  it('a marker is served to a call whose cap is <= the marker cap (no pointless retry)', async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('network', 0, 'Figma request timed out after 90000ms'); },
    };
    const caches = freshCaches();
    const a90 = makeApi(inner, { timeoutMs: 90_000 }, caches);
    await expect(a90.getVariablesLocal('F')).rejects.toThrow('timed out');   // writes marker capMs=90000
    expect(calls).toBe(1);
    const a25 = makeApi(inner, { timeoutMs: 25_000 }, caches);
    await expect(a25.getVariablesLocal('F')).rejects.toThrow(/^cached: /);   // 25000 <= 90000 → served instantly
    expect(calls).toBe(1);                                                    // inner NOT reached
  });

  it('a later SUCCESS on a new version bypasses the old marker (version-keyed)', async () => {
    let version = 'v1';
    let fail = true;
    const inner = {
      getFileVersion: async () => ({ version, name: 'F', lastModified: 'X' }),
      // R11-F1: a whitelisted kind ('upstream') so a marker is actually WRITTEN at v1 — a plain
      // Error is never cached now, which would make this test vacuously true (nothing to bypass).
      getVariablesLocal: async () => { if (fail) throw new FigmaApiError('upstream', 500, 'boom'); return { meta: { variables: {}, variableCollections: {} } }; },
    };
    const api = makeApi(inner);
    await expect(api.getVariablesLocal('F')).rejects.toThrow('boom');
    version = 'v2'; fail = false;                     // published change -> new version key
    // Bust the adapter's own getFileVersion cache (TTL 60s in this harness) so the
    // second call actually observes v2 — same pattern as caching-read.test.ts's
    // "new version busts the node cache".
    vi.useFakeTimers(); vi.advanceTimersByTime(61_000);
    await expect(api.getVariablesLocal('F')).resolves.toBeTruthy();
  });

  // R6-F1: a SUCCESS is definitive contradicting evidence for a prior failure at the SAME
  // fileKey|version — the negative marker must not outlive it. Bug: the success path wrote the
  // positive cache but never cleared the sibling negative marker; with positive TTL (5min) <
  // negative TTL (10min hardcoded), the stale marker RESURFACES once the positive entry expires,
  // instantly denying a call that the system itself already proved works.
  it('a SUCCESS clears the sibling negative marker: it cannot resurface after the positive TTL expires', async () => {
    let calls = 0;
    let fail = true;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => {
        calls++;
        if (fail) throw new FigmaApiError('network', 0, 'Figma request timed out after 90000ms');
        return { meta: { variables: {}, variableCollections: {} } };
      },
    };
    // freshCaches(): variablesCache TTL 300_000 (positive, 5min) < variablesErrorCache TTL
    // 600_000 (negative, 10min hardcoded) — matches production defaults. Uses the full 90s-cap
    // timeout path so a marker actually gets WRITTEN with capMs=90000 (any cap writes now under
    // capMs-semantics — the 90s cap here is just what the 120s-escalation assert
    // below needs, not a special "cacheable" carve-out).
    const caches = freshCaches();
    const a90 = makeApi(inner, { timeoutMs: 90_000 }, caches);
    await expect(a90.getVariablesLocal('F')).rejects.toThrow('timed out');   // writes marker capMs=90000
    expect(calls).toBe(1);

    // Escalated call (120s > 90s marker cap) bypasses the marker, reaches inner, and succeeds —
    // this success must clear the marker.
    fail = false;
    const a120 = makeApi(inner, { timeoutMs: 120_000 }, caches);
    await expect(a120.getVariablesLocal('F')).resolves.toBeTruthy();
    expect(calls).toBe(2);

    // Advance fake time past the POSITIVE TTL (300_000ms) but still within the NEGATIVE TTL
    // (600_000ms) — same version throughout, so a stale (un-cleared) marker would still be live.
    vi.useFakeTimers();
    vi.advanceTimersByTime(301_000);

    // Next call at the ORIGINAL marker cap (90s) must reach the inner api again — no stale
    // marker served. Pre-fix this would be instantly rejected with the cached: marker and `calls`
    // would stay at 2.
    const a90b = makeApi(inner, { timeoutMs: 90_000 }, caches);
    await expect(a90b.getVariablesLocal('F')).resolves.toBeTruthy();
    expect(calls).toBe(3);
  });

  // R8-F3 (major): the marker key is `fileKey|version` — it has NO token dimension. Every caller
  // in the process shares one marker regardless of which token asked. 'forbidden'/'auth'/
  // 'not_found' are verdicts about WHICH TOKEN asked (scope, plan tier, visibility) — not about
  // the file or the endpoint — so caching one token's denial and serving it to a DIFFERENT,
  // possibly stronger token (e.g. a weak token's 403 served to an Enterprise token) is unsound.
  // Only token-INDEPENDENT evidence ('upstream' 5xx, 'unknown_4xx' 400, full-cap timeout) may be
  // negative-cached — see the write-rule comment in caching-figma-api.ts's catch.
  describe('R8-F3: token-dependent kinds are never negative-cached', () => {
    it("forbidden (403) is NEVER negative-cached — a weak token's denial must not poison a different token's call", async () => {
      let calls = 0;
      const inner = {
        getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
        getVariablesLocal: async () => { calls++; throw new FigmaApiError('forbidden', 403, 'Figma denied variables access'); },
      };
      const api = makeApi(inner);
      await expect(api.getVariablesLocal('F')).rejects.toThrow('denied');
      // Second call — with the fix, never cached — reaches the real API again (strictly more
      // honest: a DIFFERENT token asking would genuinely need its own real answer).
      await expect(api.getVariablesLocal('F')).rejects.toThrow('denied');
      expect(calls).toBe(2);
    });

    it('auth (401) is NEVER negative-cached (token-dependent verdict)', async () => {
      let calls = 0;
      const inner = {
        getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
        getVariablesLocal: async () => { calls++; throw new FigmaApiError('auth', 401, 'Figma rejected the token (401).'); },
      };
      const api = makeApi(inner);
      await expect(api.getVariablesLocal('F')).rejects.toThrow('rejected the token');
      await expect(api.getVariablesLocal('F')).rejects.toThrow('rejected the token');
      expect(calls).toBe(2);
    });

    it('not_found (404) is NEVER negative-cached (token-dependent visibility verdict)', async () => {
      let calls = 0;
      const inner = {
        getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
        getVariablesLocal: async () => { calls++; throw new FigmaApiError('not_found', 404, 'Figma file not found or no access.'); },
      };
      const api = makeApi(inner);
      await expect(api.getVariablesLocal('F')).rejects.toThrow('not found');
      await expect(api.getVariablesLocal('F')).rejects.toThrow('not found');
      expect(calls).toBe(2);
    });

    it('forbidden is never cached even under a SHORTENED cap (not just exempted by the timeout rule)', async () => {
      let calls = 0;
      const inner = {
        getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
        getVariablesLocal: async () => { calls++; throw new FigmaApiError('forbidden', 403, 'Figma denied variables access'); },
      };
      const api = makeApi(inner, { timeoutMs: 25_000 });
      await expect(api.getVariablesLocal('F')).rejects.toThrow('denied');
      await expect(api.getVariablesLocal('F')).rejects.toThrow('denied');
      expect(calls).toBe(2);
    });
  });

  // R8-F1 (major): delete-on-success (variablesErrorCache.delete in the success path) can be
  // raced — a fast success deletes the marker, then a SLOW concurrent failure (a stale request
  // that lost the race) writes a fresh marker AFTER the success, resurrecting "broken" for a file
  // that a proven-good response just answered. Fix: before WRITING a failure marker, check the
  // sibling positive cache for a live entry at the same key — a live success eclipses the
  // failure as stale evidence, so the write is skipped entirely.
  it('R8-F1: a late concurrent failure does not resurrect the marker after a proven success (eclipse guard)', async () => {
    const caches = freshCaches();
    // Adapter B (slow): its fetch is started FIRST but stays pending — simulating a concurrent
    // request already in flight when the fast winner (adapter A) completes.
    let rejectSlowFetch!: (e: unknown) => void;
    const failApi = makeApi({
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: () => new Promise((_resolve, reject) => { rejectSlowFetch = reject; }),
    }, {}, caches);
    const failPromise = failApi.getVariablesLocal('F');

    // Adapter A (fast): a DIFFERENT concurrent request for the SAME fileKey|version that
    // completes first, populating the positive cache — no error marker exists yet at this point.
    const okApi = makeApi({
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
    }, {}, caches);
    await expect(okApi.getVariablesLocal('F')).resolves.toBeTruthy();
    expect(caches.variablesErrorCache?.get('F|v1')).toBeNull(); // nothing written yet (sanity)

    // NOW let adapter B's stale fetch fail — AFTER the success already landed. Pre-fix this would
    // still write a fresh marker, resurrecting "broken" for a file the system just proved works.
    rejectSlowFetch(new FigmaApiError('network', 0, 'Figma request timed out after 90000ms'));
    await expect(failPromise).rejects.toThrow('timed out');

    // The failure must NOT have written a marker — the live success eclipses it as stale evidence.
    expect(caches.variablesErrorCache?.get('F|v1')).toBeNull();
  });
});

// The negative cache is what turns a 90-second variables hang into a one-off per file: it arms on a
// timeout and on nothing else. That armament used to rest on two independent string literals in two
// files - the adapter built one, the cache matched the other - while the eight assertions in this
// file threw errors they wrote themselves. So rewording the adapter's message disarmed the cache
// with the whole suite green. They now read one symbol; this asserts the round trip.
describe('the phrase the adapter throws is the phrase the negative cache arms on', () => {
  it('round-trips, and is not a predicate that says yes to everything', () => {
    expect(isTimeoutMessage(timeoutMessage(20_000))).toBe(true);
    expect(isTimeoutMessage(timeoutMessage(0, ' (deadline exceeded while queued)'))).toBe(true);
    expect(isTimeoutMessage('cached: ' + timeoutMessage(20_000))).toBe(true); // the replay path keeps it
    expect(isTimeoutMessage('Figma API 500 Internal Server Error')).toBe(false); // co-lock: it discriminates
  });
});

// evidence-reach line (panel-locked): the too-large 400 is Figma's LOAD-DEPENDENT ~55s job
// limit, not permanent evidence - yet the standard marker semantics locked out the tool's own
// "retry first" advice for the full 10min TTL, and at the schema-max cap (120000) the bypass
// rule (timeoutMs > capMs) has nowhere to go: the ceiling was unbypassable. The fix
// discriminates on the ERROR, not the cap: too-large markers carry a soft expiry inside the
// marker JSON; after it, a reader with a budget >= the marker's cap passes through to Figma;
// sub-cap readers keep the cached serve for the hard TTL (a 20s compare must not burn 20s on
// a guaranteed-lost retry of a ~55s job). Old markers without the field decode to today's
// behavior. Separately: a deadline-exceeded-WHILE-QUEUED bailout is evidence about THIS
// process's queue, never about the endpoint - it must never be cacheable.
describe('too-large 400: soft-expiring marker (the ceiling fix)', () => {
  const tooLarge = () => new FigmaApiError('unknown_4xx', 400, 'Figma returned 400',
    undefined, 'Request too large. If applicable, filter by query params.');

  it('at the schema-max cap: served cached within the soft window, re-hits Figma after it', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw tooLarge(); },
    };
    const caches = freshCaches();
    const a120 = makeApi(inner, { timeoutMs: 120_000 }, caches);
    await expect(a120.getVariablesLocal('F')).rejects.toThrow('400');   // writes marker capMs=120000
    expect(calls).toBe(1);
    // within the soft window: same-cap retry is served cached (herd protection intact)
    const b120 = makeApi(inner, { timeoutMs: 120_000 }, caches);
    await expect(b120.getVariablesLocal('F')).rejects.toThrow(/^cached: /);
    expect(calls).toBe(1);
    // after the soft window: the same-cap retry passes through - a REAL attempt (the ceiling row:
    // 120000 is the schema max, there is no larger budget to escalate to)
    vi.advanceTimersByTime(61_000);
    const c120 = makeApi(inner, { timeoutMs: 120_000 }, caches);
    await expect(c120.getVariablesLocal('F')).rejects.toThrow('400');
    expect(calls).toBe(2);
  });

  it('a FIGMA_TIMEOUT_MS raised ABOVE the schema max still leaves a retry path', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw tooLarge(); },
    };
    const caches = freshCaches();
    const a = makeApi(inner, { timeoutMs: 150_000 }, caches);           // config has NO schema max
    await expect(a.getVariablesLocal('F')).rejects.toThrow('400');
    vi.advanceTimersByTime(61_000);
    const b = makeApi(inner, { timeoutMs: 150_000 }, caches);
    await expect(b.getVariablesLocal('F')).rejects.toThrow('400');      // really retried
    expect(calls).toBe(2);
  });

  it('herd: a burst of same-cap readers inside the soft window costs exactly one Figma call', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw tooLarge(); },
    };
    const caches = freshCaches();
    await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).rejects.toThrow('400');
    for (let i = 0; i < 3; i++) {
      await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).rejects.toThrow(/^cached: /);
    }
    expect(calls).toBe(1);
  });

  it('a sub-cap reader (the 20s compare shape) keeps the cached serve even after the soft window', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw tooLarge(); },
    };
    const caches = freshCaches();
    await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).rejects.toThrow('400');
    vi.advanceTimersByTime(61_000);
    const compareShaped = makeApi(inner, { timeoutMs: 20_000 }, caches);
    await expect(compareShaped.getVariablesLocal('F')).rejects.toThrow(/^cached: /);
    expect(calls).toBe(1);                       // a 20s budget cannot beat a ~55s job - no burn
  });

  it('the within-window cached error NAMES when retry becomes possible (for a capable reader)', async () => {
    vi.useFakeTimers();
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { throw tooLarge(); },
    };
    const caches = freshCaches();
    await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).rejects.toThrow('400');
    const err = await makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F').then(() => null, (e) => e);
    expect((err as Error).message).toMatch(/^cached: /);         // the classifier contract stays
    expect((err as Error).message).toMatch(/retry.*\b\d+s/i);    // the wait is named, not implied
  });

  it('the hint is NEVER promised to a sub-cap reader - it cannot act on it at its budget', async () => {
    // wave lock: a mutation dropping the `timeoutMs >= capMs` condition on the hint would tell
    // the 20s compare shape "retry becomes possible in ~Ns" - false at that budget (the marker
    // keeps denying sub-cap readers for the hard TTL by design).
    vi.useFakeTimers();
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { throw tooLarge(); },
    };
    const caches = freshCaches();
    await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).rejects.toThrow('400');
    const err = await makeApi(inner, { timeoutMs: 20_000 }, caches).getVariablesLocal('F').then(() => null, (e) => e);
    expect((err as Error).message).toMatch(/^cached: /);
    expect((err as Error).message).not.toMatch(/retry becomes possible/);
  });

  it('other classes are byte-identical: an elapsed timeout and a 500 get NO soft expiry', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('upstream', 500, 'Figma had an internal error'); },
    };
    const caches = freshCaches();
    await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).rejects.toThrow('internal');
    vi.advanceTimersByTime(61_000);              // past where a soft window WOULD open
    await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).rejects.toThrow(/^cached: /);
    expect(calls).toBe(1);                       // still served cached - the 600s semantics
  });

  it('a success after the window deletes the marker and lands the positive entry for sub-cap readers', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let fail = true;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => {
        calls++;
        if (fail) throw tooLarge();
        return { meta: { variables: {}, variableCollections: {} } };
      },
    };
    const caches = freshCaches();
    await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).rejects.toThrow('400');
    vi.advanceTimersByTime(61_000);
    fail = false;                                // the load-dependent job went through this time
    await expect(makeApi(inner, { timeoutMs: 120_000 }, caches).getVariablesLocal('F')).resolves.toBeTruthy();
    // the 20s compare now reads the positive entry - the D-branch road is open
    const compareShaped = makeApi(inner, { timeoutMs: 20_000 }, caches);
    await expect(compareShaped.getVariablesLocal('F')).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });
});

describe('queued-bailout is never cacheable (evidence about our queue, not the endpoint)', () => {
  it('a deadline-exceeded-while-queued failure writes NO marker; the next call really tries', async () => {
    let calls = 0;
    let queued = true;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => {
        calls++;
        if (queued)

          throw Object.assign(
            new FigmaApiError('network', 0, timeoutMessage(0, ' (deadline exceeded while queued)')),
            { queuedBailout: true });
        return { meta: { variables: {}, variableCollections: {} } };
      },
    };
    const caches = freshCaches();
    const a = makeApi(inner, { timeoutMs: 25_000 }, caches);
    await expect(a.getVariablesLocal('F')).rejects.toThrow('timed out');
    queued = false;
    const b = makeApi(inner, { timeoutMs: 25_000 }, caches);             // same cap - would be denied by a marker
    await expect(b.getVariablesLocal('F')).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });

  it('the pair: an ELAPSED timeout under the same cap still writes its marker', async () => {
    let calls = 0;
    const inner = {
      getFileVersion: async () => ({ version: 'v1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('network', 0, timeoutMessage(25_000)); },
    };
    const caches = freshCaches();
    await expect(makeApi(inner, { timeoutMs: 25_000 }, caches).getVariablesLocal('F')).rejects.toThrow('timed out');
    await expect(makeApi(inner, { timeoutMs: 25_000 }, caches).getVariablesLocal('F')).rejects.toThrow(/^cached: /);
    expect(calls).toBe(1);
  });

  it('the REAL throw site carries the flag: a queued bailout from figma-rest is distinguishable', async () => {
    // the flag must come from the adapter itself, not only from this test's fixture - import-level lock
    const { FigmaRestAdapter } = await import('../../src/adapters/driven/figma-rest.js');
    const rest = new FigmaRestAdapter('figd_x', logger, 4, 1000, undefined, undefined, Date.now() - 1);
    const err = await rest.getVariablesLocal('F').then(() => null, (e) => e);
    expect(err).toBeInstanceOf(FigmaApiError);
    expect((err as { queuedBailout?: boolean }).queuedBailout).toBe(true);
    expect((err as Error).message).toContain('while queued');
  });
});
