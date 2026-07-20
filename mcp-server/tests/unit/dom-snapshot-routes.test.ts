// mcp-server/tests/unit/dom-snapshot-routes.test.ts
// Unit tests for the public DOM-snapshot upload endpoint. No supertest (not in
// devDeps, deliberately not added): the pure core
// `handleUpload(store, capToken, rawBody)` is exercised directly (JSON parse,
// per-element Zod validation, StoreError -> HTTP mapping), and the router-level
// error middleware (413 on oversize bodies) is exercised as a plain function
// call rather than over a real oversize HTTP request.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { DomSnapshotStore } from '../../src/infrastructure/dom-snapshot-store.js';
import { handleUpload, domSnapshotErrorMiddleware, createDomSnapshotRoutes } from '../../src/infrastructure/dom-snapshot-routes.js';
import { createLogger } from '../../src/infrastructure/logger.js';

// A snapshot that satisfies DomSnapshotSchema's OK variant in full, including
// the optional `.selector` field the store requires at upload time.
function validSnapshot(selector = '.title') {
  return {
    schema: 1,
    selector,
    innerWidth: 300,
    rect: { x: 0, y: 0, w: 100, h: 50 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 },
    children: [],
  };
}

describe('handleUpload', () => {
  it('happy path: 200 with a snapshot_ref, selectors, and ISO expires_at', () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a');
    const body = JSON.stringify({ snapshots: [validSnapshot()] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(200);
    const b = result.body as { snapshot_ref: string; selectors: string[]; expires_at: string };
    expect(typeof b.snapshot_ref).toBe('string');
    expect(b.snapshot_ref.length).toBeGreaterThan(0);
    expect(b.selectors).toEqual(['.title']);
    expect(() => new Date(b.expires_at).toISOString()).not.toThrow();
    expect(new Date(b.expires_at).toISOString()).toBe(b.expires_at);
  });

  it('unparseable JSON body -> 400', () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a');

    const result = handleUpload(store, token, '{not json');

    expect(result.status).toBe(400);
  });

  it('parseable but wrong shape (snapshots not an array) -> 400', () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a');

    const result = handleUpload(store, token, JSON.stringify({ snapshots: 'nope' }));

    expect(result.status).toBe(400);
  });

  it('invalid snapshot per Zod schema -> 422 with the failing index', () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a');
    const body = JSON.stringify({ snapshots: [validSnapshot('.ok'), { garbage: true }] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(422);
    const b = result.body as { error: string; details: { index: number; message: string }[] };
    expect(b.details).toHaveLength(1);
    expect(b.details[0].index).toBe(1);
    expect(typeof b.details[0].message).toBe('string');
  });

  it('Zod-valid snapshot without .selector -> 422 "snapshot without selector field"', () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a');
    const noSelector = validSnapshot();
    delete (noSelector as { selector?: string }).selector;
    const body = JSON.stringify({ snapshots: [noSelector] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(422);
    expect((result.body as { error: string }).error).toBe('snapshot without selector field');
  });

  it('unknown/expired cap token -> 404, message tells the caller to re-run get_layout_spec', () => {
    const store = new DomSnapshotStore();
    const body = JSON.stringify({ snapshots: [validSnapshot()] });

    const result = handleUpload(store, 'never-minted-token', body);

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toContain('re-run get_layout_spec');
  });

  it('does not call store.upload when Zod validation rejects a snapshot (422 short-circuits before the store)', () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a');
    const uploadSpy = vi.spyOn(store, 'upload');
    const body = JSON.stringify({ snapshots: [{ garbage: true }] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(422);
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

// (a') POST window-width preflight: mint-meta {expectedWidths} on the
// capToken drives an early honest-signal when the browser's innerWidth is a guaranteed reflow vs
// every requested node's width — see dom-snapshot-routes.ts handleUpload for the asymmetric rule.
describe('handleUpload — (a\') viewport preflight warning', () => {
  function okSnapshot(selector: string, innerWidth: number) {
    return { ...validSnapshot(selector), innerWidth };
  }

  it("(a') POST: innerWidth narrower than all widths → viewport_warning with the list and the nearest", () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a', { expectedWidths: [1920] });
    const body = JSON.stringify({ snapshots: [okSnapshot('.title', 1429)] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(200);
    const warning = (result.body as { viewport_warning?: string }).viewport_warning;
    expect(warning).toMatch(/1429/);
    expect(warning).toMatch(/1920/);
    expect(warning).toMatch(/resize/);
  });

  it("(a') POST asymmetry: innerWidth WIDER than max → NO warning (max-width layouts are legitimate)", () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a', { expectedWidths: [1440] });
    const body = JSON.stringify({ snapshots: [okSnapshot('.title', 1920)] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(200);
    expect((result.body as { viewport_warning?: string }).viewport_warning).toBeUndefined();
  });

  it("(a') POST: a match with ANY of the widths (multi-breakpoint) → NO warning", () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a', { expectedWidths: [1920, 375] });
    const body = JSON.stringify({ snapshots: [okSnapshot('.title', 375)] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(200);
    expect((result.body as { viewport_warning?: string }).viewport_warning).toBeUndefined();
  });

  it("(a') nearest lock: [375, 1920] order ≠ proximity — advises 1920, sorted list 375, 1920", () => {
    const store = new DomSnapshotStore();
    // Order MATTERS: widths[0]=375 is definitely NOT the nearest to 1429 — reduce must find the real
    // minimum by |Δ|, not take the first element. The "nearest = widths[0]" mutation → RED here (m4).
    const token = store.mint('owner-a', { expectedWidths: [375, 1920] });
    const body = JSON.stringify({ snapshots: [okSnapshot('.title', 1429)] });

    const result = handleUpload(store, token, body);

    const warning = (result.body as { viewport_warning?: string }).viewport_warning;
    expect(warning).toMatch(/breakpoint 1920/);
    expect(warning).not.toMatch(/breakpoint 375/);
    // The "remove .sort()" mutation → the list would stay in mint order (375, 1920 happens to match
    // the sorted one here) — a real RED gate on sort needs the reverse order.
    expect(warning).toMatch(/375, 1920/);
  });

  it("(a') sort lock (reverse mint order): [1920, 375] → the list is STILL sorted 375, 1920", () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a', { expectedWidths: [1920, 375] });
    const body = JSON.stringify({ snapshots: [okSnapshot('.title', 1429)] });

    const result = handleUpload(store, token, body);

    const warning = (result.body as { viewport_warning?: string }).viewport_warning;
    expect(warning).toMatch(/375, 1920/);
    expect(warning).not.toMatch(/1920, 375/);
  });

  it("(a') meta-less token → response byte-for-byte identical to the old one (no viewport_warning)", () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a'); // the old single-argument mint, no meta
    const body = JSON.stringify({ snapshots: [okSnapshot('.title', 1429)] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(200);
    expect(Object.keys(result.body as object).sort()).toEqual(['expires_at', 'selectors', 'snapshot_ref']);
  });

  it("(a') a batch entirely of failed forms (no innerWidth) → no warning and no crash", () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a', { expectedWidths: [1920] });
    const body = JSON.stringify({ snapshots: [{ status: 'not_found', selector: '.missing' }] });

    const result = handleUpload(store, token, body);

    expect(result.status).toBe(200);
    expect((result.body as { viewport_warning?: string }).viewport_warning).toBeUndefined();
  });

  it("(a') POST negative control: innerWidth matches max → body identical to the meta-less baseline (field absent, not an undefined string)", () => {
    const store = new DomSnapshotStore();
    const token = store.mint('owner-a', { expectedWidths: [1920] });
    const body = JSON.stringify({ snapshots: [okSnapshot('.title', 1920)] });

    const result = handleUpload(store, token, body);

    const b = result.body as Record<string, unknown>;
    expect('viewport_warning' in b).toBe(false);
    expect(Object.keys(b).sort()).toEqual(['expires_at', 'selectors', 'snapshot_ref']);
  });
});

describe('domSnapshotErrorMiddleware', () => {
  function fakeRes() {
    const res: { statusCode?: number; body?: unknown; status: (n: number) => typeof res; json: (b: unknown) => typeof res } = {
      status(n: number) { this.statusCode = n; return this; },
      json(b: unknown) { this.body = b; return this; },
    };
    return res;
  }

  it('entity.too.large -> 413 with a body-size message', () => {
    const res = fakeRes();
    const next = vi.fn();

    domSnapshotErrorMiddleware({ type: 'entity.too.large' }, {} as never, res as never, next);

    expect(res.statusCode).toBe(413);
    expect((res.body as { error: string }).error).toContain('send fewer snapshots per POST');
    expect((res.body as { error: string }).error).toContain('upload_url');
    expect(next).not.toHaveBeenCalled();
  });

  it('any other error -> passed through to next(err), no response written', () => {
    const res = fakeRes();
    const next = vi.fn();
    const err = new Error('boom');

    domSnapshotErrorMiddleware(err, {} as never, res as never, next);

    expect(res.statusCode).toBeUndefined();
    expect(next).toHaveBeenCalledWith(err);
  });
});

// GET /extractor.js — versioned canonical extractor endpoint . Exercised over a
// real HTTP server (same pattern as variable-snapshot-ingest.test.ts), not supertest, so status code +
// headers are asserted for real rather than reconstructed from a mocked Response.
describe('GET /extractor.js', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const app = express();
    app.use('/api/dom-snapshots', createDomSnapshotRoutes({ store: new DomSnapshotStore(), logger: createLogger({ level: 'silent' }) }));
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('200, text/javascript, Cache-Control: no-cache, schema-versioned + parseable canonical extractor body', async () => {
    const res = await fetch(`${base}/api/dom-snapshots/extractor.js`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toBe('no-cache');

    const body = await res.text();
    expect(body).toContain('window.__figmaDomDiff = ');
    expect(body).toContain('schema v5');
    // parse-only (not run): a syntax error here would silently produce a
    // broken script-tag injection in the browser with no useful error.
    expect(() => new Function(body)).not.toThrow();
  });

  it('CORS Access-Control-Allow-Methods includes GET (the header must not lie about what this router serves)', async () => {
    const res = await fetch(`${base}/api/dom-snapshots/extractor.js`);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  });
});
