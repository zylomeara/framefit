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
//   2) the capToken gate, POST-only, PINNED BETWEEN CORS AND THE PARSER. Both
//      ends of that sandwich are requirements, not preferences:
//        - AFTER CORS, because the commonest 404 here is an aged-out token and
//          the page must be able to READ that 404. A gate above the CORS
//          middleware turns the one error this route exists to explain into
//          the bare "Failed to fetch" the design avoids.
//        - BEFORE express.text, because the capToken lives in the URL PATH.
//          Nothing about authenticating this request needs the body, so an
//          anonymous caller must not get to make the server buffer up to 2mb
//          first. It also makes the 404 unconditional: with the gate below the
//          parser, a >2mb body from an unknown token was answered 413 by (4)
//          and never reached the token check at all.
//   3) express.text({ type: '*/*', limit: '2mb' }) - accepts both text/plain
//      (the in-page extractor) and application/json (curl/manual testing).
//   4) the POST handler.
//   5) a router-level error middleware: express.text's PayloadTooLargeError
//      (err.type === 'entity.too.large') maps to a clean 413; anything else
//      is handed to next(err) so the host server's own catch-all still owns
//      truly unexpected failures (without this, the multi-tenant server's
//      catch-all at server.ts turns oversize bodies into a bare 500). Still
//      reached by an AUTHENTICATED oversize POST - the gate at (2) shortens
//      the path for strangers, it does not lift the size limit for anyone.
//
// The core is the pure, dependency-injected `handleUpload`: store.hasToken ->
// JSON.parse -> element-count cap -> per-element DomSnapshotSchema.safeParse ->
// store.upload -> StoreError-to-HTTP mapping, with no Express types in its
// signature, so it's unit-testable without supertest (not a devDep here, and
// the brief says not to add it). That order is load-bearing, not stylistic:
// each step is strictly more expensive than the one before it, and only the
// first one authenticates the caller.
import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import type { Logger } from 'pino';
import { DomSnapshotStore, StoreError, MAX_SNAPSHOTS_PER_POST } from './dom-snapshot-store.js';
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

// The ONE wording for "your capToken is no good". Emitted by the pre-parse gate below AND by the
// StoreError arm at the bottom, from this single constant, so the two are byte-for-byte identical:
// a caller probing for live tokens must not be able to tell which of the two answered. Also the
// reason it says "expired or unknown" and not which - the store cannot tell them apart either
// (hasToken sweeps expired records away before it looks).
const UNKNOWN_TOKEN_ERROR = 'upload token expired or unknown - re-run get_layout_spec';

/**
 * Pure core of the upload endpoint: no Express types, no I/O beyond the
 * injected store. Returns an HTTP-shaped result the router just writes out.
 */
export function handleUpload(store: DomSnapshotStore, capToken: string, rawBody: string): HandleUploadResult {
  // AUTH FIRST. Everything below this line processes attacker-supplied bytes on a route that
  // carries no HTTP-layer credential by design: the page being measured lives at an arbitrary
  // origin, so the capToken in the path is the only thing standing in for one (see the header
  // above, and the ACAO:* the router sets). Measured on the previous order: a 400KB body of
  // 50,000 objects against a bogus token cost ~710ms of event loop and produced a 2.1MB
  // per-element error response, all of it before the token was looked at.
  //
  // Over HTTP this is the SECOND gate: the router runs the same check ahead of the body parser,
  // which is what actually spares the server the read. This one stays because handleUpload is a
  // public pure function with its own contract (a direct caller gets the same 404), and because
  // it keeps the check next to the work it guards rather than one file away.
  if (!store.hasToken(capToken)) {
    return { status: 404, body: { error: UNKNOWN_TOKEN_ERROR } };
  }

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

  // COUNT CAP BEFORE PER-ELEMENT VALIDATION. 50,000 tiny objects must cost one length read, not
  // 50,000 zod safeParse calls plus a details array with 50,000 entries in the response.
  // store.upload enforces the same constant and stays the authority.
  if (snapshots.length > MAX_SNAPSHOTS_PER_POST) {
    return {
      status: 413,
      body: { error: `at most ${MAX_SNAPSHOTS_PER_POST} snapshots per POST - send fewer per POST; upload_url accepts multiple POSTs under one capToken` },
    };
  }

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
        // Unreachable in practice now that hasToken gates the top of this function - kept because
        // the store is the authority on its own tokens, and a token that expires between the gate
        // and this call must still get the same answer, not a 500.
        case 'unknown_token':
          return { status: 404, body: { error: UNKNOWN_TOKEN_ERROR } };
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

  // (2) capToken gate - the real one, ahead of the body parser. Route-scoped to POST so
  // GET /extractor.js above is untouched; `next()` falls through to the parser and the handler
  // below for a live token. The credential is the path segment, so this costs a Map lookup and
  // reads none of the body.
  router.post('/:capToken', (req: Request, res: Response, next: NextFunction) => {
    if (store.hasToken(req.params.capToken)) {
      next();
      return;
    }
    // Prefix-only, same discipline as the handler's log line: the capToken is a write-only
    // bearer credential. `declaredBytes` is the client's own Content-Length claim, NOT a
    // measurement - we deliberately never read the body on this path.
    logger.info(
      { capTokenPrefix: req.params.capToken.slice(0, 8), declaredBytes: req.headers['content-length'] },
      'dom_snapshot.upload_rejected',
    );
    res.status(404).json({ error: UNKNOWN_TOKEN_ERROR });
    // Drain, do not destroy. The client is very likely still writing the body it was told
    // nothing about yet; discarding the remainder lets it finish and READ the 404. Tearing the
    // socket down instead surfaces in a browser as a network error, i.e. exactly the bare
    // "Failed to fetch" the CORS-first rule above exists to prevent. resume() discards without
    // buffering, so no snapshot bytes are retained.
    req.resume();
  });

  // (3) text/plain-or-anything body parser, capped at 2mb.
  router.use(express.text({ type: '*/*', limit: '2mb' }));

  // (4) POST handler.
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

  // (5) error middleware - MUST stay last so Express recognizes it (4-arity)
  // and routes express.text's PayloadTooLargeError here instead of falling
  // through to the host server's generic catch-all.
  router.use(domSnapshotErrorMiddleware);

  return router;
}
