import type { FigmaApi } from '../../ports/figma-api.js';
import { sizeOf } from '../../infrastructure/response-size.js';
import { residentBytes, withinParseCap } from '../../infrastructure/frame-budget.js';
import type { FrameHandle } from '../../infrastructure/frame-hydration-store.js';
import type { Semaphore } from '../../infrastructure/semaphore.js';
import type { FrameRawResult } from '../../ports/figma-api.js';
import type { NodeRefMap, RawComment } from '../../domain/types.js';
import type { FileStructure } from '../../domain/file-structure.js';
import type { FileStructureCache } from '../../infrastructure/file-structure-cache.js';
import type { TtlCache } from '../../infrastructure/node-cache.js';
import type { Logger } from '../../infrastructure/logger.js';
import { FigmaApiError, type FigmaApiErrorKind } from '../../ports/errors.js';
import type {
  RawFileResponse, RawNodesResponse, ImagesResult, ImageOptions, ImageFillsResult,
  RawVariablesResponse, FileVersion,
  RawTeamLibrary, PublishedComponent, PublishedComponentSet, PublishedComponentMeta,
} from '../../domain/figma-raw.js';

export interface ReadCaches {
  nodeCache: TtlCache<RawNodesResponse>;
  variablesCache: TtlCache<RawVariablesResponse>;
  /**
   * Negative cache for getVariablesLocal failures, keyed like variablesCache
   * (fileKey|version) so a published change self-heals. Stores a structured
   * JSON marker `{ kind, status, message, capMs }` so the rethrow can
   * reconstruct a real FigmaApiError. `capMs` is the timeout cap under which
   * the failure was observed, so a later call with a LARGER budget (get_variables'
   * documented `timeout_ms` escalation, up to 120s) bypasses a marker written
   * under a shorter cap rather than being served stale. Own short TTL: a broken
   * variables endpoint (hangs/5xx/4xx) otherwise burns its full timeout on
   * EVERY call in a session that hits the same file dozens of times.
   * WHITELIST, TOKEN-INDEPENDENT EVIDENCE ONLY (R8-F3, R11-F1): the marker key
   * (`fileKey|version`) has NO token dimension — every caller in the process
   * shares one marker regardless of which token asked. The write is an EXPLICIT
   * WHITELIST (not a blacklist of known-bad kinds): only `'upstream'` (5xx),
   * `'unknown_4xx'` (400), and a full-cap timeout may ever be written — see the
   * write-rule comment in getVariablesLocal's catch. Everything else is never
   * written: `'forbidden'`/`'auth'`/`'not_found'` are verdicts about WHICH TOKEN
   * asked (scope/plan tier/visibility), not about the file or the endpoint;
   * `rate_limited` is transient and carries its own retry-after; a non-timeout
   * `'network'` failure (e.g. ECONNRESET) is a transient connectivity blip, not
   * proof the endpoint is broken; and a non-FigmaApiError exception carries no
   * verified kind at all. Optional so callers that build ReadCaches without it
   * keep working (falls back to no negative caching).
   */
  variablesErrorCache?: TtlCache<string>;
  versionCache: TtlCache<FileVersion>;
  librariesCache: TtlCache<RawTeamLibrary>;
  componentCache: TtlCache<PublishedComponentMeta>;
  componentSetsCache: TtlCache<PublishedComponentSet[]>;
  imageFillsCache: TtlCache<ImageFillsResult>;
  docCache: TtlCache<RawFileResponse>;
  /** Owner-bound handle onto the shared FrameHydrationStore. Optional so callers that
   *  build ReadCaches without hydration keep working (getFrameRaw falls back to inner.getNodesRaw). */
  frameCache?: FrameHandle;
}

// Decorator: caches getFileStructure (legacy) + version-keyed node/variables
// trees. Comments, images, document-raw pass through.
// NOTE: in single-tenant HTTP the cache is shared and keyed by fileKey+version,
// not by token — a caller passing its own figma_token can hit another caller's
// cached tree. This is fine for stdio (one user) and the env-token deploy; the
// multi-tenant path isolates caches per user (see server.ts readCachesFor).
// The same applies to the team-library cache (keyed by teamId): in single-tenant
// HTTP it is shared across callers; published library content is low-sensitivity.
export class CachingFigmaApiAdapter implements FigmaApi {
  private inflight = new Map<string, Promise<FileStructure>>();
  private readInflight = new Map<string, Promise<unknown>>();

  private dedup<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const existing = this.readInflight.get(key) as Promise<R> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.readInflight.delete(key));
    this.readInflight.set(key, p);
    return p;
  }

  /**
   * This instance's per-call timeout cap (ms). The server factory passes it for BOTH the default
   * and explicit-timeout paths (timeoutMs ?? config.FIGMA_TIMEOUT_MS), so it is always defined in
   * production. Stamped onto negative-cache markers as `capMs` and compared on READ so a call
   * configured to wait LONGER than a prior failure (get_variables' documented timeout_ms
   * escalation) bypasses the stale marker and really tries. Optional so ad-hoc callers still work.
   */
  private readonly timeoutMs?: number;

  private readonly frameMaxParseBytes: number;
  private readonly frameParseMultiplier: number;
  private readonly materializeGovernor?: Semaphore;

  constructor(
    private readonly inner: FigmaApi,
    private readonly cache: FileStructureCache,
    private readonly logger: Logger,
    private readonly read?: ReadCaches,
    opts?: { timeoutMs?: number;
      frameMaxParseBytes?: number; frameParseMultiplier?: number; materializeGovernor?: Semaphore },
  ) {
    this.timeoutMs = opts?.timeoutMs;
    this.frameMaxParseBytes = opts?.frameMaxParseBytes ?? Infinity; // no cap → always hold (tests/stdio)
    this.frameParseMultiplier = opts?.frameParseMultiplier ?? 1;
    this.materializeGovernor = opts?.materializeGovernor;
  }

  getComments(fileKey: string): Promise<RawComment[]> {
    return this.inner.getComments(fileKey);
  }

  resolveNodes(fileKey: string, ids: string[], options?: { depth?: number }): Promise<NodeRefMap> {
    return this.inner.resolveNodes(fileKey, ids, options);
  }

  async getDocumentRaw(fileKey: string, depth?: number): Promise<RawFileResponse> {
    if (!this.read) return this.inner.getDocumentRaw(fileKey, depth);
    const { version } = await this.getFileVersion(fileKey);
    const key = `${fileKey}|${version}|doc|${depth ?? 'def'}`;
    const cached = this.read.docCache.get(key);
    if (cached) {
      this.logger.info({ file_key_prefix: fileKey.slice(0, 8) }, 'cache.hit_doc');
      return cached;
    }
    const res = await this.dedup(`doc|${key}`, () => this.inner.getDocumentRaw(fileKey, depth));
    this.read.docCache.set(key, res, sizeOf(res));
    return res;
  }

  getImages(fileKey: string, ids: string[], opts: ImageOptions): Promise<ImagesResult> {
    return this.inner.getImages(fileKey, ids, opts);
  }

  async getFileVersion(fileKey: string): Promise<FileVersion> {
    if (!this.read) return this.inner.getFileVersion(fileKey);
    const cached = this.read.versionCache.get(fileKey);
    if (cached) return cached;
    const v = await this.dedup(`ver|${fileKey}`, () => this.inner.getFileVersion(fileKey));
    this.read.versionCache.set(fileKey, v);
    return v;
  }

  async getNodesRaw(fileKey: string, ids: string[], depth = 4): Promise<RawNodesResponse> {
    if (!this.read || ids.length === 0) return this.inner.getNodesRaw(fileKey, ids, depth);
    const { version } = await this.getFileVersion(fileKey);
    const key = `${fileKey}|${version}|${[...ids].sort().join(',')}|${depth}`;
    const cached = this.read.nodeCache.get(key);
    if (cached) {
      this.logger.info({ file_key_prefix: fileKey.slice(0, 8) }, 'cache.hit_nodes');
      return cached;
    }
    const res = await this.dedup(`nodes|${key}`, () => this.inner.getNodesRaw(fileKey, ids, depth));
    this.read.nodeCache.set(key, res, sizeOf(res));
    return res;
  }

  async getFrameRaw(fileKey: string, ids: string[], requestedMaxDepth: number): Promise<FrameRawResult> {
    const fetchDepth = requestedMaxDepth + 1;
    const handle = this.read?.frameCache;
    if (!handle || ids.length === 0) {
      const raw = await this.inner.getNodesRaw(fileKey, ids, fetchDepth); // bypass nodeCache
      return { raw, heldDepth: fetchDepth, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
    }
    const { version } = await this.getFileVersion(fileKey);
    const key = `${fileKey}|${version}|frame:${[...ids].sort().join(',')}`;
    const held = handle.get(key, fetchDepth);
    if (held) {
      this.logger.info({ file_key_prefix: fileKey.slice(0, 8), held_depth: held.heldDepth }, 'cache.hit_frame');
      return { raw: held.raw, heldDepth: held.heldDepth, hydrated: true, effectiveMaxDepth: requestedMaxDepth };
    }
    try {
      // dedup key includes fetchDepth so concurrent DIFFERENT depths run as two fetches (the
      // deeper wins via setIfDeeper); identical same-depth requests share one fetch.
      return await this.dedup(`frame|${key}|${fetchDepth}`,
        () => this.materializeFrame(handle, fileKey, ids, fetchDepth, key, requestedMaxDepth));
    } catch (e) {
      // Backoff-clamp: a deep fetch aborted (readCapped too_large). If a shallower raw is still
      // held, serve it clamped so the projection never peeks an absent level (else under-report
      // "there is more below" = false-green). No held fallback → honest re-throw.
      // Only too_large degrades (deep fetch un-retryable); other errors (auth/5xx/network) propagate.
      const fallback = e instanceof FigmaApiError && e.kind === 'too_large' ? handle.get(key, 1) : undefined;
      if (fallback) {
        this.logger.info({ file_key_prefix: fileKey.slice(0, 8), held_depth: fallback.heldDepth }, 'cache.frame_backoff_clamp');
        return { raw: fallback.raw, heldDepth: fallback.heldDepth, hydrated: true,
          effectiveMaxDepth: Math.min(requestedMaxDepth, fallback.heldDepth - 1) };
      }
      throw e;
    }
  }

  private async materializeFrame(handle: FrameHandle, fileKey: string, ids: string[],
    fetchDepth: number, key: string, requestedMaxDepth: number): Promise<FrameRawResult> {
    const run = async (): Promise<FrameRawResult> => {
      const raw = await this.inner.getNodesRaw(fileKey, ids, fetchDepth); // bypass nodeCache
      const wire = sizeOf(raw);
      if (!withinParseCap(wire, this.frameMaxParseBytes)) {
        // Over parse cap: deliver once, DON'T hold (hydrated:false). Never claim held.
        this.logger.info({ file_key_prefix: fileKey.slice(0, 8), bytes: wire, cap: this.frameMaxParseBytes }, 'frame_cache.skip_oversized');
        return { raw, heldDepth: fetchDepth, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
      }
      handle.setIfDeeper(key, raw, fetchDepth, residentBytes(wire, this.frameParseMultiplier));
      return { raw, heldDepth: fetchDepth, hydrated: true, effectiveMaxDepth: requestedMaxDepth };
    };
    // Gate the parse-into-heap through the process-wide governor so N concurrent hydrations can't
    // multiply the transient parse spike. Absent a governor (ad-hoc adapters), run ungated.
    return this.materializeGovernor ? this.materializeGovernor.run(run) : run();
  }

  async getVariablesLocal(fileKey: string): Promise<RawVariablesResponse> {
    if (!this.read) return this.inner.getVariablesLocal(fileKey);
    const { version } = await this.getFileVersion(fileKey);
    const key = `${fileKey}|${version}`;
    const cached = this.read.variablesCache.get(key);
    if (cached) return cached;
    // Negative cache: a broken variables endpoint (hangs/5xx/4xx) otherwise burns its full timeout
    // on EVERY call — real sessions hit the same file dozens of times. Version-keyed like the
    // positive cache, own short TTL; only TOKEN-INDEPENDENT evidence is ever written here (see the
    // WRITE rule below) so a cache hit is always safe to serve to ANY token. The marker is
    // structured JSON so the rethrow reconstructs a real FigmaApiError (kind/status preserved); the
    // 'cached: ' MESSAGE prefix is a contract with get_design_context's degraded-stage classifier.
    const knownError = this.read.variablesErrorCache?.get(key);
    if (knownError !== null && knownError !== undefined) {
      // Cap-aware READ. The marker records `capMs` — the timeout cap under which the failure was
      // observed. Serve the cached error ONLY when THIS call is configured to wait no LONGER than
      // that cap (this.timeoutMs <= capMs): a call with a LARGER budget than what already failed is
      // the tool's own documented escalation (get_variables' timeout_ms, up to 120s) and MUST
      // bypass the marker to really try — otherwise a 90s-cap timeout marker would instantly deny a
      // 120s retry, defeating the escalation. A marker without capMs (shouldn't exist in-memory —
      // the server factory always passes a timeoutMs) or a call with no known timeoutMs cannot make
      // the comparison → bypass (fall through to a real fetch).
      const parsed = JSON.parse(knownError) as { kind: FigmaApiErrorKind; status: number; message: string; capMs?: number };
      if (this.timeoutMs !== undefined && parsed.capMs !== undefined && this.timeoutMs <= parsed.capMs) {
        this.logger.info({ file_key_prefix: fileKey.slice(0, 8) }, 'cache.hit_vars_error');
        throw new FigmaApiError(parsed.kind, parsed.status, `cached: ${parsed.message}`);
      }
    }
    try {
      const res = await this.dedup(`vars|${key}`, () => this.inner.getVariablesLocal(fileKey));
      this.read.variablesCache.set(key, res, sizeOf(res));
      // A SUCCESS is definitive contradicting evidence for a prior failure at this SAME
      // fileKey|version — the negative marker must not outlive it. Without this, since the
      // positive TTL (5min default) is shorter than the negative marker's TTL (10min hardcoded),
      // a stale marker would RESURFACE once the positive entry expires and instantly deny a call
      // the system itself just proved works.
      this.read.variablesErrorCache?.delete(key);
      return res;
    } catch (e) {
      // Negative-cache WRITE rule — an EXPLICIT WHITELIST (matches the class-level
      // ReadCaches.variablesErrorCache comment above: only 'upstream'/'unknown_4xx'/a full-cap
      // timeout are cacheable). This is deliberately a whitelist, not a blacklist of known-bad
      // kinds — an allow-list can never silently start caching a NEW error kind (or an arbitrary
      // non-FigmaApiError exception) just because nobody added it to an exclusion list yet.
      //
      // Token-independence (R8-F3): the class-level comment above rationalizes SHARING a
      // fileKey|version-keyed cache across every caller in the process because it's low-
      // sensitivity PUBLISHED CONTENT — if the file exposes variables at all, every valid token
      // sees the same tree, so one caller's fetch harmlessly warms another's read (see the
      // decorator-level NOTE on getTeamLibrary/getFileStructure for the same reasoning). That
      // reasoning does NOT extend to a NEGATIVE marker: 'forbidden' (403), 'auth' (401), and
      // 'not_found' (404) are verdicts about WHICH TOKEN asked — its scope, plan tier, or
      // visibility — not about the file's content or the endpoint's health. A weak token's 403
      // must never deny a DIFFERENT, possibly stronger (e.g. Enterprise) token asking the same
      // fileKey|version 10 minutes later. So these three kinds are never written, regardless of
      // cap — they are simply absent from the whitelist below.
      //
      // Cacheable evidence is EXACTLY: 'upstream' (5xx — the endpoint itself is broken),
      // 'unknown_4xx' (400 — malformed regardless of who's asking), and ANY timeout (kind
      // 'network' with a 'timed out' message) — see below. EVERYTHING else is never written:
      // rate_limited (transient, carries its own retry-after); forbidden/auth/not_found
      // (token-dependent verdicts, see above); a non-timeout 'network' failure such as ECONNRESET
      // (a transient connectivity blip, not proof the endpoint is broken); and any non-FigmaApiError
      // exception (no verified kind at all — stamping an arbitrary thrown value as kind:'upstream'
      // would itself be unverified evidence).
      //
      // Latency fix (an earlier design rested on a false premise in the earlier
      // design): a capped compare-tool call (20s, VARIABLES_FETCH_CAP_MS) now writes its timeout too
      // — a prior `isTimeout && !this.shortenedTimeout` SUPPRESSED the write for any shortened cap,
      // which would have made every WARM 20s call re-pay the full 20s timeout every time (a
      // regression against today's write-once-cached-forever). The fix drops the suppression: the
      // marker already carries `capMs: this.timeoutMs` (below), and the cap-aware READ above
      // (`this.timeoutMs <= parsed.capMs`) is monotonic on its own — "didn't answer within 20s" is
      // valid evidence for exactly the callers configured to wait no longer than 20s; a call with a
      // LARGER budget (get_variables 90-120s, get_design_context's 25s) reads `this.timeoutMs >
      // capMs` and bypasses the marker to really try. The "poisoning the shared cache" fear that
      // motivated the old suppression predates the cap-aware READ and is fully addressed by it — a
      // shorter-cap marker can never deny a longer-cap caller. The genuinely-broken-file case still
      // gets cached via any caller's timeout (whatever cap it ran under) or its fast
      // token-independent 4xx/5xx moods.
      const isTimeout = e instanceof FigmaApiError && e.kind === 'network' && e.message.includes('timed out');
      // Eclipse guard (R8-F1): delete-on-success (above) can be raced — a fast success deletes any
      // existing marker, then a SLOW concurrent failure for the SAME key (a stale request that lost
      // the race) lands here and would write a FRESH marker, resurrecting "broken" for a file a
      // proven-good response just answered once its positive TTL outlives this write. A live entry
      // in the sibling positive cache for this EXACT key is definitive contradicting evidence
      // ALREADY present — this failure is stale, so skip the write entirely rather than re-poison it.
      const eclipsedBySuccess = this.read.variablesCache.get(key) !== null;
      // The `instanceof` check stays INLINE in this condition (rather than hoisted into its own
      // boolean) so TS narrows `e` to FigmaApiError for the `e.kind`/`e.status` marker read below —
      // `e` is `unknown` here (strict catch-clause typing) and narrowing does not propagate through
      // an intermediate `const` boolean.
      if (e instanceof FigmaApiError
          && (e.kind === 'upstream' || e.kind === 'unknown_4xx' || isTimeout)
          && !eclipsedBySuccess) {
        // capMs stamps the cap under which this failure was observed, so the cap-aware READ above
        // can let a larger-budget escalation bypass it.
        const marker = { kind: e.kind, status: e.status, message: e.message, capMs: this.timeoutMs };
        this.read.variablesErrorCache?.set(key, JSON.stringify(marker));
      }
      throw e;
    }
  }

  async getFileStructure(fileKey: string): Promise<FileStructure> {
    const cached = this.cache.get(fileKey);
    if (cached) {
      this.logger.info({ file_key_prefix: fileKey.slice(0, 8) }, 'cache.hit');
      return cached;
    }
    const existing = this.inflight.get(fileKey);
    if (existing) return existing;
    this.logger.info({ file_key_prefix: fileKey.slice(0, 8) }, 'cache.miss');
    const p = (async () => {
      try {
        const s = await this.inner.getFileStructure(fileKey);
        this.cache.set(fileKey, s);
        return s;
      } finally {
        this.inflight.delete(fileKey);
      }
    })();
    this.inflight.set(fileKey, p);
    return p;
  }

  async getTeamLibrary(teamId: string): Promise<RawTeamLibrary> {
    if (!this.read) return this.inner.getTeamLibrary(teamId);
    const cached = this.read.librariesCache.get(teamId);
    if (cached) {
      this.logger.info({ team: teamId }, 'cache.hit_library');
      return cached;
    }
    const res = await this.dedup(`lib|${teamId}`, () => this.inner.getTeamLibrary(teamId));
    this.read.librariesCache.set(teamId, res);
    return res;
  }

  getTeamProjects(teamId: string) { return this.inner.getTeamProjects(teamId); }

  getProjectFiles(projectId: string) { return this.inner.getProjectFiles(projectId); }

  getFileComponents(fileKey: string): Promise<PublishedComponent[]> {
    return this.inner.getFileComponents(fileKey);
  }

  // Published library content is low-churn → cache by fileKey only (matches librariesCache semantics).
  async getFileComponentSets(fileKey: string): Promise<PublishedComponentSet[]> {
    if (!this.read) return this.inner.getFileComponentSets(fileKey);
    const cached = this.read.componentSetsCache.get(fileKey);
    if (cached) return cached;
    const res = await this.dedup(`csets|${fileKey}`, () => this.inner.getFileComponentSets(fileKey));
    this.read.componentSetsCache.set(fileKey, res);
    return res;
  }

  // Image-fill URLs are short-lived but the imageRef→URL map is file-content → cache version-keyed.
  async getImageFills(fileKey: string): Promise<ImageFillsResult> {
    if (!this.read) return this.inner.getImageFills(fileKey);
    const { version } = await this.getFileVersion(fileKey);
    const key = `${fileKey}|${version}|imagefills`;
    const cached = this.read.imageFillsCache.get(key);
    if (cached) return cached;
    const res = await this.dedup(`imgfills|${key}`, () => this.inner.getImageFills(fileKey));
    // Intentionally UNWEIGHTED: getImageFills rewraps into a fresh { images } object, so the byte-tag on
    // the raw payload doesn't ride along (sizeOf would be a dead 0). Harmless — an imageRef→URL map is a
    // few MB of short presigned URLs, never near CACHE_MAX_ENTRY_BYTES; not an OOM vector. If ever needed,
    // tag the rewrapped result in FigmaRestAdapter.getImageFills (follow-up).
    this.read.imageFillsCache.set(key, res);
    return res;
  }

  postComment(fileKey: string, input: { message: string }) { return this.inner.postComment(fileKey, input); }
  replyComment(fileKey: string, commentId: string, input: { message: string }) { return this.inner.replyComment(fileKey, commentId, input); }
  resolveComment(fileKey: string, commentId: string) { return this.inner.resolveComment(fileKey, commentId); }

  async getComponent(key: string): Promise<PublishedComponentMeta> {
    if (!this.read) return this.inner.getComponent(key);
    const cached = this.read.componentCache.get(key);
    if (cached) return cached;
    const res = await this.dedup(`comp|${key}`, () => this.inner.getComponent(key));
    this.read.componentCache.set(key, res);
    return res;
  }
}
