import type { FigmaApi } from '../../ports/figma-api.js';
import { FigmaApiError } from '../../ports/errors.js';
import { tagBytes } from '../../infrastructure/response-size.js';
import type { RawComment, NodeRefMap } from '../../domain/types.js';
import type { Logger } from '../../infrastructure/logger.js';
import type { Semaphore } from '../../infrastructure/semaphore.js';
import { buildFileStructure } from '../../domain/file-structure.js';
import type { FileStructure, RawDocumentNode } from '../../domain/file-structure.js';
import type {
  RawFileResponse, RawNodesResponse, ImagesResult, ImageOptions, ImageFillsResult, RawImageFillsResponse,
  RawVariablesResponse, FileVersion,
  RawTeamLibrary, PublishedComponent, PublishedComponentSet, PublishedStyle, PagedCursor,
  PublishedComponentMeta,
} from '../../domain/figma-raw.js';

const BASE_URL = 'https://api.figma.com/v1';

type CommentsResponse = { comments: RawComment[] };

type NodeDoc = {
  document: { id: string; name: string; type: string };
};

type NodesResponse = {
  nodes: Record<string, NodeDoc | null>;
};

// The negative cache in caching-figma-api.ts arms on this phrase and on nothing else: a timeout is
// the only network failure worth remembering, because it is the one that costs the caller its whole
// budget. Thrower and matcher both read it from here, so a reword cannot silently disarm the cache -
// which it could, with the entire suite green, when the phrase was a literal on both sides and
// hand-copied into eight assertions besides.
export { TIMEOUT_PHRASE, isTimeoutMessage } from '../../ports/errors.js';
import { TIMEOUT_PHRASE } from '../../ports/errors.js';
export const timeoutMessage = (ms: number, note = ''): string =>
  `Figma request ${TIMEOUT_PHRASE} after ${ms}ms${note}`;

export class FigmaRestAdapter implements FigmaApi {
  constructor(
    private readonly token: string,
    private readonly logger: Logger,
    private readonly fileStructureDepth: number = 4,
    // Default aligns with config.FIGMA_TIMEOUT_MS (90s). The variables/comments
    // endpoints can be slow on large files; server.ts overrides per-call via timeout_ms.
    private readonly requestTimeoutMs: number = 90000,
    private readonly onRequest?: () => void,
    private readonly semaphore?: Semaphore,
    // Optional ABSOLUTE deadline (epoch ms) for the whole call. When set, request() clamps its
    // per-request timeout to min(requestTimeoutMs, deadlineAt - now) computed at DISPATCH — after
    // any semaphore queue wait — so a stale cap can't run in full behind a slow holder. A request
    // dequeued past the deadline throws the timeout-shaped error in ~1ms without touching the
    // network, freeing the slot so the queue drains instead of compounding.
    private readonly deadlineAt?: number,
    // Per-fetch byte cap (high OOM-backstop). Default 128MB; server wires config.MAX_FETCH_BYTES.
    // request() streams the body and aborts past this, so a pathological >cap document can't spike RSS.
    private readonly maxFetchBytes: number = 128 * 1024 * 1024,
  ) {}

  async getComments(fileKey: string): Promise<RawComment[]> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/comments?as_md=true`;
    const payload = await this.request<CommentsResponse>(url);
    return payload.comments;
  }

  async resolveNodes(
    fileKey: string,
    ids: string[],
    options: { depth?: number } = {},
  ): Promise<NodeRefMap> {
    if (ids.length === 0) return new Map();
    const depth = options.depth ?? 1;
    const idsParam = ids.join(',');
    // depth=1 returns each node without its descendants — typically all we
    // need (just node.name). Without depth, Figma returns the full subtree
    // per node, which for 200+ IDs in a complex file can be many MB and
    // exceed our 30s timeout during body transfer even though headers arrive
    // in seconds.
    const url =
      `${BASE_URL}/files/${encodeURIComponent(fileKey)}/nodes` +
      `?ids=${encodeURIComponent(idsParam)}&depth=${depth}`;
    const payload = await this.request<NodesResponse>(url);

    // Real Figma API: nodes payload is keyed by the requested id; each value
    // carries the node document. The page name (ancestor Canvas) is NOT
    // available from /nodes — getting it would require a second call to
    // /files/:key and tree traversal. For MVP we set page_name = ''; the
    // formatter falls back to showing "on <node_name>" without page info.
    const map: NodeRefMap = new Map();
    for (const [id, doc] of Object.entries(payload.nodes ?? {})) {
      if (!doc) continue;
      map.set(id, { name: doc.document.name, page_name: '' });
    }
    return map;
  }

  async getDocumentRaw(fileKey: string, depth = 4): Promise<RawFileResponse> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}?depth=${depth}`;
    return this.runHeavy(() => this.request<RawFileResponse>(url));
  }

  async getNodesRaw(fileKey: string, ids: string[], depth = 4): Promise<RawNodesResponse> {
    if (ids.length === 0) return { nodes: {} };
    const url =
      `${BASE_URL}/files/${encodeURIComponent(fileKey)}/nodes` +
      `?ids=${encodeURIComponent(ids.join(','))}&depth=${depth}`;
    return this.runHeavy(() => this.request<RawNodesResponse>(url));
  }

  // The bare REST adapter holds no store — passthrough at max_depth+1, never hydrated, no clamp.
  // The real hold/reslice logic lives in CachingFigmaApiAdapter.
  async getFrameRaw(fileKey: string, ids: string[], requestedMaxDepth: number): Promise<import('../../ports/figma-api.js').FrameRawResult> {
    const fetchDepth = requestedMaxDepth + 1;
    const raw = await this.getNodesRaw(fileKey, ids, fetchDepth);
    return { raw, heldDepth: fetchDepth, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
  }

  async getImages(fileKey: string, ids: string[], opts: ImageOptions): Promise<ImagesResult> {
    if (ids.length === 0) return { images: {} };
    const scale = opts.format === 'svg' ? undefined : (opts.scale ?? 2);
    const scaleParam = scale !== undefined ? `&scale=${scale}` : '';
    const url =
      `${BASE_URL}/images/${encodeURIComponent(fileKey)}` +
      `?ids=${encodeURIComponent(ids.join(','))}&format=${opts.format}${scaleParam}`;
    const payload = await this.request<{ err: string | null; images: Record<string, string | null> }>(url);
    // GET /v1/images reports render/export failures INSIDE a 200 body, so mapStatus never sees them
    // and a body-first rule scoped to status mapping cannot reach this channel. This field was
    // typed and then dropped, so get_screenshot / export_assets answered a failed render with an
    // empty image set and no reason at all - strictly worse than a misleading message.
    //
    // Same bounded, sanitized quoting as mapStatus, through the SAME parser and the SAME
    // interpolator (no second quoting path). kind stays 'upstream' - a genuine upstream failure,
    // already in caching-figma-api's negative-cache whitelist - because a NEW kind would change
    // five kind-branching call sites, four of which construct FigmaApiError directly and so have
    // no gate that would notice.
    if (typeof payload.err === 'string' && payload.err.length > 0) {
      const reason = upstreamReason(JSON.stringify({ err: payload.err }));
      // No fixed remedy pinned onto the quote. The first version ended every one of these with
      // "Open the node in Figma to confirm it exists and has visible content" - true for
      // "Node not found", false for a rate limit and for a too-large render, whose bodies exclude
      // that premise outright. This endpoint answers with several unrelated reasons and sends no
      // discriminator between them, so the only honest tail points at the reason itself. With
      // nothing quotable (a reason that sanitizes away entirely) the message says so instead of
      // pretending to carry one.
      throw new FigmaApiError('upstream', 200,
        reason === undefined
          ? 'Figma could not render this export and gave a reason this server could not read.'
            + ' Retry once; if it repeats, check the node ids, the format and the scale in this call.'
          : `Figma could not render this export.${quoteUpstream(reason)}`
            + ' Figma named that itself, so act on it before changing anything else about this call.',
        undefined, reason);
    }
    return { images: payload.images ?? {} };
  }

  async getVariablesLocal(fileKey: string): Promise<RawVariablesResponse> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/variables/local`;
    return this.runHeavy(() => this.request<RawVariablesResponse>(url));
  }

  async getFileVersion(fileKey: string): Promise<FileVersion> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}?depth=1`;
    const payload = await this.request<RawFileResponse>(url);
    return { version: payload.version, name: payload.name, lastModified: payload.lastModified };
  }

  async getTeamLibrary(teamId: string): Promise<RawTeamLibrary> {
    const [components, componentSets, styles] = await Promise.all([
      this.pageAll<PublishedComponent>(`teams/${encodeURIComponent(teamId)}/components`, 'components'),
      this.pageAll<PublishedComponentSet>(`teams/${encodeURIComponent(teamId)}/component_sets`, 'component_sets'),
      this.pageAll<PublishedStyle>(`teams/${encodeURIComponent(teamId)}/styles`, 'styles'),
    ]);
    return { components, componentSets, styles };
  }

  async getTeamProjects(teamId: string): Promise<{ id: string; name: string }[]> {
    const r = await this.request<{ projects?: { id: string; name: string }[] }>(`${BASE_URL}/teams/${encodeURIComponent(teamId)}/projects`);
    return r.projects ?? [];
  }

  async getProjectFiles(projectId: string): Promise<{ key: string; name: string }[]> {
    const r = await this.request<{ files?: { key: string; name: string }[] }>(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/files`);
    return r.files ?? [];
  }

  async getFileComponents(fileKey: string): Promise<PublishedComponent[]> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/components`;
    const payload = await this.request<{ meta?: { components?: PublishedComponent[] } }>(url);
    return payload.meta?.components ?? [];
  }

  async getFileComponentSets(fileKey: string): Promise<PublishedComponentSet[]> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/component_sets`;
    const payload = await this.request<{ meta?: { component_sets?: PublishedComponentSet[] } }>(url);
    return payload.meta?.component_sets ?? [];
  }

  async getImageFills(fileKey: string): Promise<ImageFillsResult> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/images`;
    const payload = await this.request<RawImageFillsResponse>(url);
    return { images: payload.meta?.images ?? {} };
  }

  async getComponent(key: string): Promise<PublishedComponentMeta> {
    const url = `${BASE_URL}/components/${encodeURIComponent(key)}`;
    const payload = await this.request<{ meta?: PublishedComponentMeta & { component_set_id?: string; documentation_links?: { uri: string }[] } }>(url);
    const m = payload.meta;
    if (!m?.file_key || !m?.node_id) {
      throw new FigmaApiError('not_found', 200, `Component ${key} has no library location (file_key/node_id)`);
    }
    // Figma REST returns these in snake_case (like file_key/node_id); normalize to our camelCase fields.
    return {
      ...m,
      componentSetId: m.componentSetId ?? m.component_set_id,
      documentationLinks: m.documentationLinks ?? m.documentation_links,
    };
  }

  // Follows Figma's numeric cursor.after pagination; caps at MAX_PAGES (20k items)
  // as a safety bound against runaway loops. Warns if the cursor still dangles at
  // the cap so callers know the corpus was silently truncated.
  private async pageAll<T>(path: string, metaKey: string): Promise<T[]> {
    const MAX_PAGES = 20; // 20k items — well beyond any real design system; bounds runaway loops
    const out: T[] = [];
    let after: number | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const afterParam = after !== undefined ? `&after=${after}` : '';
      const url = `${BASE_URL}/${path}?page_size=1000${afterParam}`;
      const payload = await this.request<{ meta?: Record<string, unknown> & { cursor?: PagedCursor } }>(url);
      const items = (payload.meta?.[metaKey] as T[] | undefined) ?? [];
      out.push(...items);
      const next = payload.meta?.cursor?.after;
      if (next === undefined || items.length === 0) return out;
      if (page === MAX_PAGES - 1) {
        // Cursor still dangles at the cap — library is larger than MAX_PAGES*page_size.
        // Surface it instead of silently truncating the search corpus.
        this.logger.warn({ path, returned: out.length }, 'figma.library_truncated');
        return out;
      }
      after = next;
    }
    return out;
  }

  async getFileStructure(fileKey: string): Promise<FileStructure> {
    const url =
      `${BASE_URL}/files/${encodeURIComponent(fileKey)}` +
      `?depth=${this.fileStructureDepth}`;
    try {
      const payload = await this.request<{ document: RawDocumentNode }>(url);
      return buildFileStructure(payload.document);
    } catch (err) {
      // Big files can time out on first fetch; Figma warms its render cache,
      // so an immediate retry usually succeeds. Retry once on network errors.
      if (err instanceof FigmaApiError && err.kind === 'network') {
        this.logger.info({ file_key_prefix: fileKey.slice(0, 8) }, 'figma.structure_retry');
        const payload = await this.request<{ document: RawDocumentNode }>(url);
        return buildFileStructure(payload.document);
      }
      throw err;
    }
  }

  async postComment(fileKey: string, input: { message: string }): Promise<RawComment> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/comments`;
    return this.request<RawComment>(url, { method: 'POST', body: { message: input.message }, writeOp: 'comment_post' });
  }

  async replyComment(fileKey: string, commentId: string, input: { message: string }): Promise<RawComment> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/comments`;
    return this.request<RawComment>(url, { method: 'POST', body: { message: input.message, comment_id: commentId }, writeOp: 'comment_reply' });
  }

  /** Figma has no resolve endpoint; this is a DELETE, and the method name says so. */
  async deleteComment(fileKey: string, commentId: string): Promise<void> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/comments/${encodeURIComponent(commentId)}`;
    await this.request<unknown>(url, { method: 'DELETE', writeOp: 'comment_delete' });
  }

  // Heavy subtree fetches (whole-file / node subtrees) go through the shared semaphore
  // so concurrent multi-MB payloads don't starve the event loop or spike RSS. Light
  // endpoints (components, version, comments, images) are NOT bounded — they must not
  // queue behind a 100MB whole-file fetch.
  private runHeavy<T>(fn: () => Promise<T>): Promise<T> {
    return this.semaphore ? this.semaphore.run(fn) : fn();
  }

  // Streaming read bounded by maxFetchBytes. A single whole-file response can be ~110MB; res.text()
  // buffers it unbounded before we could react. We accumulate chunks and count DECOMPRESSED bytes
  // (native fetch already decoded gzip/br → res.body yields resident bytes), aborting past the cap so a
  // pathological >cap document cannot spike RSS / OOM the process. Under the cap the concatenated text
  // is byte-identical to res.text() → JSON.parse sees exactly the same input (regression-locked).
  private async readCapped(
    res: Response, controller: AbortController, safeUrl: string,
  ): Promise<{ text: string; bytes: number }> {
    // NO-STREAM FALLBACK FIRST (before any res.headers/res.body access): native fetch always gives a
    // res.body ReadableStream, but hand-rolled test stubs (and any exotic runtime) may be a bare object
    // with only { ok, status, text() } — no .body AND no .headers. Handling them here means we never call
    // res.headers.get() / res.body.getReader() on an object that lacks them (that would throw TypeError and
    // redden the suite). Still bound post-hoc so the guard holds even on this path.
    if (!res.body) {
      const text = await res.text();
      const bytes = Buffer.byteLength(text);
      if (bytes > this.maxFetchBytes) throw new FigmaApiError('too_large', 0, this.tooLargeMessage(bytes, safeUrl));
      return { text, bytes };
    }
    // Real stream. Coarse fast-path: a declared Content-Length already over the cap lets us bail before
    // streaming a doomed download. NOT a guarantee — CloudFront chunks/gzips, so the header is often absent
    // or reflects compressed size; the streaming counter below is the real guard. Optional-chain headers
    // defensively (a body-bearing stub could still omit them).
    const declared = Number(res.headers?.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxFetchBytes) {
      controller.abort();
      throw new FigmaApiError('too_large', 0, this.tooLargeMessage(declared, safeUrl));
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > this.maxFetchBytes) {
        controller.abort();           // cancel the in-flight download; stop buffering
        throw new FigmaApiError('too_large', 0, this.tooLargeMessage(bytes, safeUrl));
      }
      chunks.push(value);
    }
    // TextDecoder (default utf-8, ignoreBOM:false) matches res.text() EXACTLY: it strips a leading BOM
    // (which .toString('utf8') would keep → JSON.parse('﻿{…}') throws), preserves interior bytes and
    // multi-byte sequences reassembled across chunk boundaries, and yields '' for an empty buffer. This is
    // the byte-identical guarantee — do NOT swap back to Buffer.toString('utf8').
    return { text: new TextDecoder().decode(Buffer.concat(chunks)), bytes };
  }

  private tooLargeMessage(bytes: number, safeUrl: string): string {
    const mb = (bytes / 1048576).toFixed(0);
    const cap = (this.maxFetchBytes / 1048576).toFixed(0);
    return `Figma response for ${safeUrl} is ~${mb}MB, over the ${cap}MB cap. `
      + `Narrow the request: fetch specific node ids (get_design_context / get_metadata with a node_id) `
      + `or a sub-frame instead of the whole file.`;
  }

  private async request<T>(url: string, init?: { method?: string; body?: unknown; writeOp?: WriteOp }): Promise<T> {
    this.onRequest?.();
    const started = Date.now();
    // Deadline-aware cap, evaluated HERE (after any semaphore queue wait), not at construction.
    const effectiveMs = this.deadlineAt !== undefined
      ? Math.min(this.requestTimeoutMs, this.deadlineAt - Date.now())
      : this.requestTimeoutMs;
    if (effectiveMs <= 0) {
      // Dequeued (or invoked) past the deadline — bail before issuing the fetch so this runs in ~1ms
      // and frees any semaphore slot immediately. 'timed out' + kind 'network' keep every existing
      // timeout classifier matching. queuedBailout marks it as queue evidence, NOT endpoint
      // evidence — the negative variables cache must never store this shape (a marker meaning
      // "our queue was full" would be served for 10 minutes as "Figma's endpoint is broken").
      throw new FigmaApiError('network', 0, timeoutMessage(0, ' (deadline exceeded while queued)'), undefined, undefined, true);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveMs);
    const safeUrl = new URL(url).pathname + new URL(url).search;
    const method = init?.method ?? 'GET';

    const headers: Record<string, string> = { 'X-Figma-Token': this.token };
    let bodyStr: string | undefined;
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(init.body);
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      const latency_ms = Date.now() - started;
      this.logger.info(
        { method, url_path: safeUrl, status: res.status, latency_ms },
        'figma.request',
      );

      if (!res.ok) {
        const body = await safeReadText(res);
        // Truncated body kept server-side only; never echoed to the MCP client.
        this.logger.warn(
          { method, url_path: safeUrl, status: res.status, body },
          'figma.request_failed',
        );
        throw mapStatus(res, body, init?.writeOp);
      }
      const { text, bytes } = await this.readCapped(res, controller, safeUrl);
      this.logger.info(
        { method, url_path: safeUrl, status: res.status, latency_ms,
          bytes, rss_mb: Math.round(process.memoryUsage().rss / 1048576) },
        'figma.request_done',
      );
      const parsed = (text ? JSON.parse(text) : {}) as T;
      tagBytes(parsed as unknown, bytes);   // cache .set sites read this back via sizeOf() for oversized-skip
      return parsed;
    } catch (err) {
      if (err instanceof FigmaApiError) throw err;
      if ((err as { name?: string }).name === 'AbortError') {
        // Report the cap that actually fired (the deadline-clamped effectiveMs), not the nominal
        // requestTimeoutMs — with no deadline the two are identical.
        throw new FigmaApiError('network', 0, timeoutMessage(effectiveMs));
      }
      const msg = (err as Error).message ?? String(err);
      throw new FigmaApiError('network', 0, `Could not reach Figma API: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Server-side cut, deliberately unchanged at 200: this same value is logged as
// figma.request_failed. The CLIENT-visible cut is UPSTREAM_REASON_MAX (120) and is applied by
// upstreamReason, which also refuses anything that is not a JSON string field.
async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Client-visible cut. The SERVER-side cut in safeReadText stays 200 and is NOT raised: the same
 * `body` value feeds the figma.request_failed log line, so raising it there would enlarge what an
 * intermediary can write into the operator's logs. The two cuts compose: a body over 200 chars is
 * truncated mid-JSON, fails to parse, and therefore contributes NOTHING to a client message.
 */
export const UPSTREAM_REASON_MAX = 120;

/**
 * Parse ONLY a string-valued `err`/`message` out of a JSON body, then bound and normalise it.
 *
 * This NARROWS - it does not delete - the rule stated in mapStatus below: "do not echo Figma's
 * response body to the client". A tool result is agent context, so an unstructured body (a
 * CloudFront edge page, a captive portal, a corporate TLS-inspecting proxy) must contribute
 * nothing at all rather than arrive as this server's diagnosis in this server's voice.
 *
 * Both field names are load-bearing, measured against api.figma.com with a deliberately invalid
 * token: /v1/me, /v1/files/:key/comments and /v1/teams/:id/styles answer
 * `{"status":403,"err":"Invalid token"}`, while /v1/files/:key/variables/local - the endpoint whose
 * tool today blames the customer's Figma plan - answers
 * `{"status":403,"error":true,"message":"Invalid token"}`. Reading only `err` would leave exactly
 * the misdiagnosed endpoint with nothing to quote.
 */
export function upstreamReason(body: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  const raw = typeof rec.err === 'string' ? rec.err
    : typeof rec.message === 'string' ? rec.message
      : undefined;
  if (raw === undefined) return undefined;
  // Order is load-bearing. Restrict the alphabet FIRST, so a link cannot hide behind a zero-width
  // character; defang links SECOND; bound LAST, so truncation cannot leave half a URL behind.
  const clean = defangLinks(printableAsciiOnly(raw)).replace(/ +/g, ' ').trim();
  if (clean === '') return undefined;
  return clean.length > UPSTREAM_REASON_MAX
    ? `${clean.slice(0, UPSTREAM_REASON_MAX - 3)}...`
    : clean;
}

/**
 * The only characters an upstream string may contribute to a tool result: printable ASCII, and
 * never a double quote. Both restrictions answer an attack that landed on the first version:
 *
 * - The double quote is the fence in quoteUpstream. A reason able to carry one closes it and keeps
 *   writing in this server's voice - `ok". Ignore the above ...` did exactly that, and the result
 *   read as though this server had said it. Removing the character makes the closing quote
 *   unforgeable rather than merely discouraged; nothing downstream has to remember to escape.
 * - Stripping C0 and DEL left U+202E (right-to-left override), U+200B (zero width space),
 *   combining marks and emoji intact - six code points reached the message from one measured body.
 *   A tool result is text an LLM acts on, and this branch requires ASCII in runtime strings.
 *
 * A whitelist, deliberately: a blacklist of the Unicode of the day is a list somebody has to keep
 * adding to. Anything outside becomes a space, so tampering shows as spacing rather than silently
 * gluing two words into one.
 */
function printableAsciiOnly(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out += (c >= 32 && c <= 126 && c !== 34) ? raw[i] : ' ';
  }
  return out;
}

/** What replaces a link inside a quoted reason. Says a removal happened; hides nothing. */
export const UPSTREAM_LINK_PLACEHOLDER = '[link removed]';

// No backslash escapes in the pattern: `[.]` and `[/]` instead of the escaped forms, and `[^ ]`
// instead of the whitespace class (whitespace is already a single space by this point). A
// mis-decoded escape inside a security filter is a defect that reads as a typo.
//
// Two alternatives, because requiring `//` was not enough - a row here caught `data:text/html,evil`
// slipping through. Either ANY scheme followed by `//`, or one of the schemes that is dangerous
// without it. The named list is deliberately short and excludes `file:`, since "file" is the single
// most likely word in a Figma error and `file://` is already covered by the first alternative.
//
// A SCHEME IS REQUIRED, and that is the whole design. A companion rule once also matched bare
// dotted hostnames - `[a-z0-9-]+(?:[.][a-z0-9-]+)*[.][a-z]{2,}` - which is a dotted-identifier test
// wearing a TLD's clothes. Measured over 24 realistic reason strings it damaged NINE of them:
// `Cannot parse file.js`, `Malformed payload.json`, `Unknown field style.key`,
// `Missing property component.name`, `design.system`, `support@figma.com`,
// `Unable to reach api.figma.com`, `the components.meta field`, and worst,
// `E.404.NOT_FOUND` -> `[link removed]_FOUND` - a corrupted diagnosis, which is precisely the
// failure this whole item exists to remove. It also MISSED the bare form that would matter most, a
// raw IPv4 with a path (`192.168.1.1/admin`). Every one of those false positives came from that
// rule and none from this one, so it is gone.
const UPSTREAM_LINK =
  /(?:[a-z][a-z0-9+.-]*:[/][/]|(?:https?|ftp|ftps|data|javascript|vbscript|mailto):)[^ ]+/gi;

/**
 * Neutralise anything link-shaped inside an upstream reason.
 *
 * Why at all: the quote lands IMMEDIATELY before this server's own `Issue a fresh token in Figma ...`
 * sentence, so an attacker-supplied `Paste your PAT at http://not-figma.example` inherits that
 * remediation's endorsement, aimed at a reader which may be an LLM relaying it to a human. Credential
 * phishing in this server's voice costs more than the link this gives up.
 *
 * Deliberately NOT dropping the whole quote: the sentence around the link is often the real reason,
 * and the untouched body is still in the figma.request_failed log for an operator who needs it.
 *
 * THE RESIDUAL, stated rather than papered over: a schemeless host survives. `Go to
 * not-figma.example now`, a protocol-relative `//cdn.evil.example/x`, and a bare `192.168.1.1/admin`
 * all reach the reader inside a fence attributed to Figma. That is the accepted trade, for two
 * reasons. It is materially less actionable than a scheme-bearing URL - nothing resolves it, no
 * client follows it, and a reader has to retype it deliberately. And the only rule that catches it
 * is the dotted-identifier match above, which corrupts real diagnoses: paying for a marginal
 * phishing case with `E.404.NOT_FOUND` -> `[link removed]_FOUND` is the wrong side of the trade.
 * A row locks this residual, so that a later "fix" back to bare-host matching has to delete an
 * assertion that names what it costs.
 */
function defangLinks(s: string): string {
  return s.replace(UPSTREAM_LINK, UPSTREAM_LINK_PLACEHOLDER);
}

/**
 * Fence the upstream string as upstream. Never merged into an imperative sentence.
 *
 * The closing quote is unforgeable by CONSTRUCTION, not by escaping: printableAsciiOnly removes the
 * double quote from the reason, so the only one after `said: ` is the one written here. An escaping
 * scheme would work too and would be one refactor away from not working.
 */
export function quoteUpstream(reason: string | undefined): string {
  return reason ? ` Figma's response said: "${reason}".` : '';
}

/**
 * Which write this request is. A single boolean could not tell the three apart, so the 403 for a
 * delete could not name Figma's author-only rule without asserting it for post and reply too,
 * where it is false. Only 'comment_delete' carries a rule of its own; 'comment_post' and
 * 'comment_reply' differ solely in naming which call failed, because Figma applies the same rule
 * to both - inventing a further difference would be inventing a discriminator Figma does not send.
 */
export type WriteOp = 'comment_post' | 'comment_reply' | 'comment_delete';

/**
 * Recognise Figma's own reason strings. Matched against the PARSED reason, never the raw body, so
 * an HTML interstitial that happens to contain the words "Invalid token" can never be promoted
 * into a confident diagnosis. An unrecognised reason falls through to a message that names every
 * possibility without choosing - Figma sends no discriminator for those, and inventing one is the
 * defect this whole item exists to remove.
 */
function reasonFamily(reason: string | undefined): 'dead_token' | 'plan_limit' | 'scope' | undefined {
  if (reason === undefined) return undefined;
  // Captured live: `curl -H 'X-Figma-Token: <invalid>' https://api.figma.com/v1/me`
  // -> {"status":403,"err":"Invalid token"}. Figma lumps revoked, mistyped and expired into it.
  if (/invalid token/i.test(reason)) return 'dead_token';
  // Figma's documented 403 strings for an endpoint the file's plan, or the account's tier, does not
  // include. The ONLY branch allowed to talk about plans - see the excludes on the Invalid-token
  // row of tests/unit/figma-error-diagnosis.test.ts.
  //
  // "Incorrect account type" joined this family because leaving it unclassified produced a
  // CONTRADICTORY composite one layer up: this function fell through to the message saying the
  // token may be revoked, mistyped or expired, and get_variables then appended that Figma had named
  // a plan or account-type limit rather than a token problem. The reader was told to do both, and
  // each half was correct on its own - which is why only a test over the DELIVERED text catches it.
  //
  // KIND MOVEMENT, stated as the CLASS it is rather than as the example I happened to synthesise
  // (my first version named one probe body and a reader would have concluded the freeze was
  // narrower than it is). The moved class is EXACTLY:
  //
  //   a 403 whose parsed reason matches /incorrect account type/i AND ALSO matches /scope/i
  //     -> was kind 'auth' (it reached the scope branch), is now kind 'forbidden'
  //
  // in either body shape (`err` or `message`), on every call shape, for any number of distinct
  // reason strings in that class - a review sweep found two plausible ones where I had synthesised
  // one. A reason matching /incorrect account type/i WITHOUT a scope does not move at all: both
  // plan_limit and the fallthrough return 'forbidden' at 403. Nothing else in the table moves; the
  // direction is toward the frozen 403 default, which takes the choice of kind away from an
  // intermediary rather than giving it any. Locked by a row that iterates the class, not an example.
  // Provenance for the string itself: cited by the task-11 brief, NOT captured - I have no account
  // whose tier refuses an endpoint. Same standing as its neighbour.
  if (/limited by figma plan|incorrect account type/i.test(reason)) return 'plan_limit';
  // The scope test used to run against the RAW body, and BEFORE this function. Two things followed,
  // both reproduced: an HTML interstitial containing the word "scope" produced kind 'auth' and this
  // server's most confident quote-free sentence, letting an intermediary CHOOSE the kind five call
  // sites branch on; and a body that said `Invalid token` while carrying "scope" anywhere else took
  // the scope branch, asserting a cause Figma had already excluded and resurrecting the write-scope
  // sentence on a delete. Ranked below dead_token on purpose: when Figma names the token, the token
  // is the answer.
  if (/scope/i.test(reason)) return 'scope';
  return undefined;
}

const REISSUE = ' Issue a fresh token in Figma (Settings -> Security -> Personal access tokens)'
  + ' and give this server the new value.';

/**
 * One diagnosis for a dead token, shared by 401 and 403 on purpose. The same token yields 403 on
 * every endpoint probed here and 401 on others, so the status must NOT change what the reader is
 * told; only the number in the parentheses differs.
 */
function deadTokenMessage(status: number, quoted: string): string {
  return `Figma rejected the token (${status}).${quoted}`
    + ' The token is revoked, mistyped, or past its expiry - Figma PATs last at most 90 days, and'
    + ' Figma answers all three the same way.'
    + REISSUE;
}

function forbiddenMessage(writeOp: WriteOp | undefined, quoted: string): string {
  const scopeAndAccess = ' Either the token lacks the file_comments:write scope, or the account'
    + ' behind it cannot comment on this file. Both are visible in Figma: the scopes on the'
    + ' Personal access tokens page, and your comment access by opening the file.';
  switch (writeOp) {
    case 'comment_delete':
      // Figma's comments reference: only the person who made a comment may delete it. Stated for
      // the delete alone - it is false for post and reply, which is why the caller passes which
      // write this is instead of one boolean for all three.
      return `Figma denied this delete (403).${quoted}`
        + ' Either the token lacks the file_comments:write scope, or the comment is not yours:'
        + ' Figma only lets you delete a comment you posted, and no scope changes that.'
        + ' Check the scopes on the Personal access tokens page in Figma; if the comment is'
        + " someone else's, no token will delete it.";
    case 'comment_post':
      return `Figma denied this comment (403).${quoted}` + scopeAndAccess;
    case 'comment_reply':
      return `Figma denied this reply (403).${quoted}` + scopeAndAccess;
    default:
      return `Figma denied access (403).${quoted}`
        + ' This server cannot tell which of these it is: the token may be revoked, mistyped or'
        + ' expired; it may lack a scope this endpoint needs; or the account behind it may not have'
        + ' access to this file. Open the file in Figma as that account to separate the access case'
        + ' from the token cases.';
  }
}

function mapStatus(res: Response, body: string, writeOp?: WriteOp): FigmaApiError {
  const status = res.status;
  // Body-first: the status code alone cannot classify a dead token (the SAME token yields 401 on
  // one endpoint and 403 on another). Only a string-valued err/message is quoted, bounded and
  // sanitized - see upstreamReason above for what this deliberately refuses to echo.
  const reason = upstreamReason(body);
  const quoted = quoteUpstream(reason);
  const family = reasonFamily(reason);

  if (status === 401) {
    // Body-first here too, for a reason that was measured rather than assumed. A real 401 from
    // api.figma.com is NOT a dead token: `Authorization: Bearer figd_...` answers
    // {"status":401,"err":"figd_ tokens must be passed via X-Figma-Token header, not Authorization"}
    // on four endpoints. Telling that reader the token is "revoked, mistyped, or past its expiry"
    // names three causes Figma has excluded and hides the one it named. With no parseable reason at
    // all, a 401 does mean the credential was refused, so the dead-token diagnosis is the best
    // available and is used.
    if (family === 'dead_token' || reason === undefined) {
      return new FigmaApiError('auth', 401, deadTokenMessage(401, quoted), undefined, reason);
    }
    return new FigmaApiError('auth', 401,
      `Figma refused the request as unauthenticated (401).${quoted}`
      + ' Figma named that itself, so act on it before assuming anything about the token. For'
      + ' reference, this server always sends the PAT in the X-Figma-Token header.',
      undefined, reason);
  }
  if (status === 403) {
    // Body before caller context AND before the scope test: when Figma names the cause, this
    // server must not go on offering alternatives it has already excluded - not the write hints
    // below, and not the scope sentence either.
    if (family === 'dead_token') {
      return new FigmaApiError('forbidden', 403, deadTokenMessage(403, quoted), undefined, reason);
    }
    if (family === 'scope') {
      const scopeMsg = writeOp
        ? 'Figma rejected the token (403). Check scopes: file_comments:write.'
        : 'Figma rejected the token (403). Check scopes: file_comments:read, file_content:read.';
      return new FigmaApiError('auth', 403, scopeMsg + quoted, undefined, reason);
    }
    if (family === 'plan_limit') {
      // A reason can name BOTH a plan/account limit and a scope, and the sentence below tells the
      // reader that scoping is irrelevant - false over such a body, and this task's own defect
      // class. The DENIAL is what becomes conditional, NOT the ranking: reversing the ranking so a
      // scope-bearing body took the scope branch would hand an intermediary the kind back by
      // writing "scope" into a body, which is exactly what four measured bodies did before the
      // ranking was introduced. So plan still outranks scope, and when both are named this server
      // says it cannot tell which refused the call, because Figma does not say.
      const alsoScope = /scope/i.test(reason ?? '');
      return new FigmaApiError('forbidden', 403,
        `Figma denied access (403).${quoted}`
        + (alsoScope
          ? ' Figma named a plan or account-type limit AND a scope, and does not say which of them'
            + ' refused the call, so treat neither as excluded. Check the scopes on the Personal'
            + ' access tokens page in Figma, then ask whoever owns this file which endpoints its'
            + ' plan covers.'
          : " Figma named a limit on this file's Figma plan, not a problem with the token:"
            + ' re-issuing or re-scoping the token will not change it. Ask whoever owns this file in'
            + ' Figma which endpoints its plan covers.'),
        undefined, reason);
    }
    return new FigmaApiError('forbidden', 403, forbiddenMessage(writeOp, quoted), undefined, reason);
  }
  if (status === 404) {
    return new FigmaApiError('not_found', 404,
      `Figma returned 404.${quoted}`
      + ' That is either no such file key, or a file this token cannot see - Figma answers both the'
      + ' same way. Open the file URL in a browser signed in as the token owner: if it loads there'
      + ' and 404s here, the key is right and the token is the problem.',
      undefined, reason);
  }
  if (status === 429) {
    const retry = parseInt(res.headers.get('retry-after') ?? '', 10);
    // The wait instruction is conditional: with no Retry-After header the number renders as
    // "unknown", and "wait that long" after it would be an instruction the reader cannot follow.
    const wait = Number.isFinite(retry)
      ? ` Wait ${retry}s before retrying.`
      : ' Figma sent no Retry-After header; back off before retrying.';
    return new FigmaApiError(
      'rate_limited',
      429,
      // The unit belongs inside the finite branch: the previous form rendered the header-less case
      // as "Retry-After: unknowns.".
      `Figma rate limit hit. Retry-After: ${Number.isFinite(retry) ? `${retry}s` : 'unknown'}.${quoted}${wait}`,
      Number.isFinite(retry) ? retry : undefined,
      reason,
    );
  }
  if (status >= 500) {
    return new FigmaApiError(
      'upstream',
      status,
      `Figma upstream error (${status}). Try again later.${quoted}`,
      undefined,
      reason,
    );
  }
  return new FigmaApiError(
    'unknown_4xx',
    status,
    // Still no raw body here: `quoted` is the bounded, sanitized err/message string and nothing
    // else. The truncated body is logged server-side at the call site.
    `Figma returned ${status}.${quoted}`
    + ' Retrying this unchanged will get the same answer; change the request or the id it names.',
    undefined,
    reason,
  );
}
