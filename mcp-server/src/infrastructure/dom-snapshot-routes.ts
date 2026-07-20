// mcp-server/src/infrastructure/dom-snapshot-routes.ts
// POST /api/dom-snapshots/:capToken — public, capability-authed (opaque
// capToken minted by get_layout_spec, see dom-snapshot-store.ts) upload
// endpoint for browser-captured DOM snapshots. Deliberately OUTSIDE JWT and
// mounted BEFORE the global express.json() parser in both server variants —
// same precedent as code-connect-ingest.ts / variable-snapshot-ingest.ts: an
// arbitrary browser page (via the bookmarklet/devtools extractor) has no way
// to obtain a Bearer JWT, so auth here is the capToken itself.
//
// Middleware order in this router is load-bearing:
//   1) CORS FIRST — every response (including error responses further down
//      the chain) must carry ACAO:*, or a browser reports a bare "Failed to
//      fetch" instead of surfacing the real HTTP status.
//   2) express.text({ type: '*/*', limit: '2mb' }) — accepts both text/plain
//      (the in-page extractor) and application/json (curl/manual testing).
//   3) the POST handler.
//   4) a router-level error middleware: express.text's PayloadTooLargeError
//      (err.type === 'entity.too.large') maps to a clean 413; anything else
//      is handed to next(err) so the host server's own catch-all still owns
//      truly unexpected failures (without this, the multi-tenant server's
//      catch-all at server.ts turns oversize bodies into a bare 500).
//
// The core is the pure, dependency-injected `handleUpload` — JSON.parse ->
// per-element DomSnapshotSchema.safeParse -> store.upload -> StoreError-to-HTTP
// mapping — with no Express types in its signature, so it's unit-testable
// without supertest (not a devDep here, and the brief says not to add it).
import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import type { Logger } from 'pino';
import { DomSnapshotStore, StoreError } from './dom-snapshot-store.js';
import { DomSnapshotSchema, DOM_SNAPSHOT_SCHEMA_VERSION } from '../adapters/driving/tools/dom-snapshot-schema.js';
import { EXTRACTOR_JS } from '../adapters/driving/tools/dom-extractor.js';
import { widthNoiseTolerance } from '../domain/layout-spec/tolerance.js';

export interface DomSnapshotRoutesDeps {
  store: DomSnapshotStore;
  logger: Logger;
}

export interface HandleUploadResult {
  status: number;
  body: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Pure core of the upload endpoint: no Express types, no I/O beyond the
 * injected store. Returns an HTTP-shaped result the router just writes out.
 */
export function handleUpload(store: DomSnapshotStore, capToken: string, rawBody: string): HandleUploadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'body is not valid JSON' } };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.snapshots)) {
    return { status: 400, body: { error: 'body must be { snapshots: [...] }' } };
  }
  const snapshots: unknown[] = parsed.snapshots;

  const details: { index: number; message: string }[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const result = DomSnapshotSchema.safeParse(snapshots[i]);
    if (!result.success) {
      details.push({ index: i, message: result.error.issues[0]?.message ?? 'invalid snapshot' });
    }
  }
  if (details.length > 0) {
    return { status: 422, body: { error: 'one or more snapshots failed schema validation', details } };
  }

  try {
    const entry = store.upload(capToken, snapshots);

    // (a') POST preflight: an early width signal AT CAPTURE TIME. The rule is ASYMMETRIC —
    // silent on a match with any expected width (multi-breakpoint flow
    //  ) OR on a window WIDER than max (max-width/centered layouts are legitimate); warn
    // ONLY on "narrower" = guaranteed reflow (the M2 case). ok-narrowing is mandatory: failed forms
    // do not carry innerWidth. A warning is NOT a rejection (overlays are legitimate).
    const meta = store.getMeta(capToken);
    let viewportWarning: string | undefined;
    const widths = meta?.expectedWidths ?? [];
    if (widths.length > 0) {
      const iw = (snapshots as { innerWidth?: unknown }[])
        .map((s) => s.innerWidth).find((w): w is number => typeof w === 'number');
      if (iw !== undefined
          && !widths.some((w) => Math.abs(iw - w) <= widthNoiseTolerance(w))
          && iw <= Math.max(...widths)) {
        const nearest = widths.reduce((a, b) => (Math.abs(b - iw) < Math.abs(a - iw) ? b : a));
        viewportWarning = `window ${iw}px does not match any requested node width (${[...widths].sort((a, b) => a - b).join(', ')}) — if you are capturing breakpoint ${nearest}: resize to ${nearest} and re-capture BEFORE compare`;
      }
    }

    return {
      status: 200,
      body: {
        snapshot_ref: entry.ref,
        selectors: entry.selectors,
        expires_at: new Date(entry.expiresAt).toISOString(),
        ...(viewportWarning ? { viewport_warning: viewportWarning } : {}),
      },
    };
  } catch (err) {
    if (err instanceof StoreError) {
      switch (err.code) {
        case 'unknown_token':
          return { status: 404, body: { error: 'upload token expired or unknown — re-run get_layout_spec' } };
        case 'too_many':
        case 'store_full':
          return { status: 413, body: { error: err.message } };
        case 'missing_selector':
          return { status: 422, body: { error: 'snapshot without selector field' } };
      }
    }
    throw err;
  }
}

export interface ExtractorScriptResponse {
  status: number;
  contentType: string;
  cacheControl: string;
  body: string;
}

/**
 * Pure core of GET /extractor.js: the canonical, schema-versioned DOM extractor, served so
 * get_layout_spec's default 'loader' extractor_mode can point the browser at a script tag
 * (see buildExtractorLoader in dom-extractor.ts) instead of the caller re-pasting the ~90-line
 * EXTRACTOR_JS verbatim into every tool call. No Express types in the signature — unit-testable
 * directly, same rationale as handleUpload above.
 */
export function buildExtractorScriptResponse(): ExtractorScriptResponse {
  return {
    status: 200,
    contentType: 'text/javascript',
    cacheControl: 'no-cache',
    body: '// framefit canonical extractor; schema v' + DOM_SNAPSHOT_SCHEMA_VERSION + '\nwindow.__figmaDomDiff = ' + EXTRACTOR_JS + ';',
  };
}

/**
 * Router-level error middleware. Exported standalone (not just wired into the
 * router) so it's unit-testable as a plain function call, without spinning up
 * a real oversize HTTP request to trigger express.text's own error path.
 */
export function domSnapshotErrorMiddleware(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (isRecord(err) && err.type === 'entity.too.large') {
    res.status(413).json({ error: 'body exceeds 2mb — send fewer snapshots per POST; upload_url accepts multiple POSTs (the limit is per batch, not per session)' });
    return;
  }
  next(err);
}

export function createDomSnapshotRoutes(deps: DomSnapshotRoutesDeps): Router {
  const { store, logger } = deps;
  const router = Router();

  // (1) CORS first — must precede everything else, including the error
  // middleware at the bottom of this router, so every response (success or
  // error) carries ACAO:*.
  router.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // (1b) GET /extractor.js — versioned canonical extractor script, right next to CORS and before
  // the POST route/body parser below (no request body on a GET, so express.text() isn't needed
  // first; method+path both differ from POST /:capToken, so there's no routing conflict).
  router.get('/extractor.js', (_req: Request, res: Response) => {
    const r = buildExtractorScriptResponse();
    res.status(r.status).set('Content-Type', r.contentType).set('Cache-Control', r.cacheControl).send(r.body);
  });

  // (2) text/plain-or-anything body parser, capped at 2mb.
  router.use(express.text({ type: '*/*', limit: '2mb' }));

  // (3) POST handler.
  router.post('/:capToken', (req: Request, res: Response) => {
    const capToken = req.params.capToken;
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const bytes = Buffer.byteLength(rawBody);

    const result = handleUpload(store, capToken, rawBody);

    const body = isRecord(result.body) ? result.body : {};
    const refPrefix = typeof body.snapshot_ref === 'string' ? body.snapshot_ref.slice(0, 8) : undefined;
    const count = Array.isArray(body.selectors) ? body.selectors.length : undefined;
    // Prefix-only: the full capToken is a write-only bearer credential (see
    // dom-snapshot-store.ts) and must never land in application logs.
    logger.info({ capTokenPrefix: capToken.slice(0, 8), refPrefix, count, bytes }, 'dom_snapshot.upload');

    res.status(result.status).json(result.body);
  });

  // (4) error middleware — MUST stay last so Express recognizes it (4-arity)
  // and routes express.text's PayloadTooLargeError here instead of falling
  // through to the host server's generic catch-all.
  router.use(domSnapshotErrorMiddleware);

  return router;
}
