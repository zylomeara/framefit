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
    return this.request<RawComment>(url, { method: 'POST', body: { message: input.message }, writeScopeHint: true });
  }

  async replyComment(fileKey: string, commentId: string, input: { message: string }): Promise<RawComment> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/comments`;
    return this.request<RawComment>(url, { method: 'POST', body: { message: input.message, comment_id: commentId }, writeScopeHint: true });
  }

  async resolveComment(fileKey: string, commentId: string): Promise<void> {
    const url = `${BASE_URL}/files/${encodeURIComponent(fileKey)}/comments/${encodeURIComponent(commentId)}`;
    await this.request<unknown>(url, { method: 'DELETE', writeScopeHint: true });
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

  private async request<T>(url: string, init?: { method?: string; body?: unknown; writeScopeHint?: boolean }): Promise<T> {
    this.onRequest?.();
    const started = Date.now();
    // Deadline-aware cap, evaluated HERE (after any semaphore queue wait), not at construction.
    const effectiveMs = this.deadlineAt !== undefined
      ? Math.min(this.requestTimeoutMs, this.deadlineAt - Date.now())
      : this.requestTimeoutMs;
    if (effectiveMs <= 0) {
      // Dequeued (or invoked) past the deadline — bail before issuing the fetch so this runs in ~1ms
      // and frees any semaphore slot immediately. 'timed out' + kind 'network' keep every existing
      // timeout classifier matching.
      throw new FigmaApiError('network', 0, 'Figma request timed out after 0ms (deadline exceeded while queued)');
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
        throw mapStatus(res, body, init?.writeScopeHint);
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
        throw new FigmaApiError('network', 0, `Figma request timed out after ${effectiveMs}ms`);
      }
      const msg = (err as Error).message ?? String(err);
      throw new FigmaApiError('network', 0, `Could not reach Figma API: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '';
  }
}

function mapStatus(res: Response, body: string, writeScopeHint?: boolean): FigmaApiError {
  const status = res.status;
  if (status === 401) {
    return new FigmaApiError('auth', 401, 'Figma rejected the token (401).');
  }
  if (status === 403) {
    if (/scope/i.test(body)) {
      const scopeMsg = writeScopeHint
        ? 'Figma rejected the token (403). Check scopes: file_comments:write.'
        : 'Figma rejected the token (403). Check scopes: file_comments:read, file_content:read.';
      return new FigmaApiError('auth', 403, scopeMsg);
    }
    const forbiddenMsg = writeScopeHint
      ? 'Figma denied access (403). The PAT needs the file_comments:write scope, or does not have edit access to this file.'
      : 'Figma denied access to this file. Token may not have access.';
    return new FigmaApiError('forbidden', 403, forbiddenMsg);
  }
  if (status === 404) {
    return new FigmaApiError('not_found', 404, 'Figma file not found or no access.');
  }
  if (status === 429) {
    const retry = parseInt(res.headers.get('retry-after') ?? '', 10);
    return new FigmaApiError(
      'rate_limited',
      429,
      `Figma rate limit hit. Retry-After: ${Number.isFinite(retry) ? retry : 'unknown'}s.`,
      Number.isFinite(retry) ? retry : undefined,
    );
  }
  if (status >= 500) {
    return new FigmaApiError(
      'upstream',
      status,
      `Figma upstream error (${status}). Try again later.`,
    );
  }
  return new FigmaApiError(
    'unknown_4xx',
    status,
    // Do not echo Figma's response body to the client (it may carry request
    // context). The truncated body is logged server-side at the call site.
    `Figma returned ${status}.`,
  );
}
