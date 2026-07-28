// mcp-server/tests/unit/dom-snapshot-auth-order.test.ts
// The upload route carries no HTTP-layer credential: the page being measured is at an arbitrary
// origin, so the capToken in the path is the credential. An anonymous caller must therefore be
// rejected by a Map lookup, not by a JSON.parse of up to 2MB plus N zod validations. The
// assertions are ordering assertions: they check WHICH rejection wins, because that is the only
// observable difference between the two orders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { startTestServer, type TestHttpServer } from '../helpers/http-test-server.js';
import { handleUpload, createDomSnapshotRoutes } from '../../src/infrastructure/dom-snapshot-routes.js';
import { DomSnapshotStore, MAX_SNAPSHOTS_PER_POST } from '../../src/infrastructure/dom-snapshot-store.js';
import { createLogger } from '../../src/infrastructure/logger.js';

// The full OK variant of DomSnapshotSchema, including the `.selector` the store requires.
// Same shape as dom-snapshot-routes.test.ts - the schema has required `innerWidth`, `borders`,
// `scroll` and `children`, so a two-field stand-in would silently fail validation and turn the
// happy-path lock into a 422 that proves nothing.
const validSnapshot = (selector = '.card') => ({
  schema: 1,
  selector,
  innerWidth: 300,
  rect: { x: 0, y: 0, w: 100, h: 40 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 },
  children: [],
});

describe('unknown capToken wins over every body-shaped rejection', () => {
  it('unknown token + syntactically invalid JSON -> 404, not 400', () => {
    const r = handleUpload(new DomSnapshotStore(), 'deadbeef', '{not json');
    expect(r.status).toBe(404);
  });

  it('unknown token + a body that would fail schema validation -> 404, not 422', () => {
    const body = JSON.stringify({ snapshots: Array.from({ length: 50 }, () => ({ nope: true })) });
    const r = handleUpload(new DomSnapshotStore(), 'deadbeef', body);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain('schema validation');
  });

  it('unknown token + a huge well-formed body -> 404 (the parse never earned the right to run)', () => {
    const body = JSON.stringify({ snapshots: Array.from({ length: 5000 }, () => validSnapshot()) });
    const r = handleUpload(new DomSnapshotStore(), 'deadbeef', body);
    expect(r.status).toBe(404);
  });

  it('an EXPIRED token is rejected the same way as an unknown one', () => {
    let now = 0;
    const store = new DomSnapshotStore(() => now);
    const tok = store.mint('owner');
    now = 3 * 60 * 60 * 1000;   // past the hard cap
    expect(handleUpload(store, tok, '{not json').status).toBe(404);
  });

  it('expired and unknown are byte-for-byte the same response (no token-existence oracle)', () => {
    let now = 0;
    const store = new DomSnapshotStore(() => now);
    const tok = store.mint('owner');
    now = 3 * 60 * 60 * 1000;
    const expired = handleUpload(store, tok, '{not json');
    const unknown = handleUpload(store, 'deadbeef', '{not json');
    expect(expired.status).toBe(unknown.status);
    expect(expired.body).toEqual(unknown.body);
  });

  it('the pre-auth 404 is the same response the store authority itself emits', () => {
    // A caller probing for live tokens must not be able to tell the cheap gate from the
    // StoreError arm behind it. Reach that arm by disabling the gate on a subclass, so the
    // request falls through to store.upload and its unknown_token throw.
    class GateOpenStore extends DomSnapshotStore {
      override hasToken(): boolean { return true; }
    }
    const body = JSON.stringify({ snapshots: [validSnapshot()] });
    const gate = handleUpload(new DomSnapshotStore(), 'deadbeef', body);
    const authority = handleUpload(new GateOpenStore(), 'deadbeef', body);

    expect(gate.status).toBe(404);
    expect(authority.status).toBe(404);
    expect(authority.body).toEqual(gate.body);
  });
});

describe('the element-count cap is enforced before per-element validation', () => {
  it('an over-cap array is refused by COUNT, with no per-element details', () => {
    const store = new DomSnapshotStore();
    const tok = store.mint('owner');
    const body = JSON.stringify({ snapshots: Array.from({ length: 5000 }, () => ({ nope: true })) });
    const r = handleUpload(store, tok, body);
    expect(r.status).toBe(413);
    // `details` is the per-element loop's output. Its ABSENCE is the proof the loop did not run.
    expect(r.body).not.toHaveProperty('details');
    expect(JSON.stringify(r.body)).toContain(String(MAX_SNAPSHOTS_PER_POST));
  });

  it('exactly MAX_SNAPSHOTS_PER_POST is still under the cap and reaches per-element validation', () => {
    // Off-by-one lock: `>=` instead of `>` in the count gate turns a legal full batch into a 413.
    const store = new DomSnapshotStore();
    const tok = store.mint('owner');
    const body = JSON.stringify({
      snapshots: Array.from({ length: MAX_SNAPSHOTS_PER_POST }, (_, i) => validSnapshot(`.c${i}`)),
    });
    const r = handleUpload(store, tok, body);
    expect(r.status).toBe(200);
  });
});

describe('the happy path and the honest body errors are unchanged', () => {
  it('a known token with a valid snapshot still uploads', () => {
    const store = new DomSnapshotStore();
    const tok = store.mint('owner');
    const r = handleUpload(store, tok, JSON.stringify({ snapshots: [validSnapshot()] }));
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('snapshot_ref');
  });

  it('a KNOWN token with invalid JSON still gets the 400 that names the real problem', () => {
    const store = new DomSnapshotStore();
    const tok = store.mint('owner');
    expect(handleUpload(store, tok, '{not json').status).toBe(400);
  });

  it('a KNOWN token with an under-cap invalid array still gets the 422 with details', () => {
    const store = new DomSnapshotStore();
    const tok = store.mint('owner');
    const r = handleUpload(store, tok, JSON.stringify({ snapshots: [{ nope: true }] }));
    expect(r.status).toBe(422);
    expect(r.body).toHaveProperty('details');
  });
});

// Round 2: the gate that matters is the ROUTER's, not handleUpload's. handleUpload only ever sees
// a body express.text has already buffered, so a check inside it cannot stop the read - and cannot
// answer at all for a body the parser rejects first. These run over a real HTTP server (same
// pattern as the GET /extractor.js block in dom-snapshot-routes.test.ts) because the thing under
// test IS the middleware order; a direct handleUpload call cannot observe it.
describe('the capToken gate sits ahead of the body parser', () => {
  let server: TestHttpServer;
  let store: DomSnapshotStore;
  let liveToken: string;

  // Comfortably over express.text's 2mb limit, so the parser would answer 413 if it got there.
  const OVERSIZE = JSON.stringify({ snapshots: [{ pad: 'x'.repeat(3 * 1024 * 1024) }] });

  beforeEach(async () => {
    store = new DomSnapshotStore();
    liveToken = store.mint('owner-a');
    const app = express();
    app.use('/api/dom-snapshots', createDomSnapshotRoutes({ store, logger: createLogger({ level: 'silent' }) }));
    server = await startTestServer(app);
  });
  afterEach(() => server.close());

  const post = (token: string, body: string) => fetch(`${server.base}/api/dom-snapshots/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body,
  });

  it('a body OVER the parser limit with a dead token gets 404, not 413', async () => {
    // The contract is "an unknown or expired token returns 404 regardless of the body". With the
    // gate below express.text that sentence was false at the HTTP boundary: the parser's
    // PayloadTooLargeError reached the error middleware and answered 413 without ever consulting
    // the token. This is the assertion that makes the sentence true without a caveat.
    const res = await post('deadbeef', OVERSIZE);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain('re-run get_layout_spec');
  });

  it('the size limit SURVIVES for a live token: over-limit body still gets 413', async () => {
    // The gate shortens the path for strangers; it must not become a way to lift the 2mb cap for
    // anyone who holds a token. Delete the size limit and this row is the one that notices.
    const res = await post(liveToken, OVERSIZE);
    expect(res.status).toBe(413);
    expect((await res.json() as { error: string }).error).toContain('2mb');
  });

  it('the dead-token 404 is readable by a browser page (ACAO survives the hoist)', async () => {
    // The gate must sit BELOW the CORS middleware. Above it, the commonest error on this route -
    // an aged-out token - reaches the page as a bare "Failed to fetch" with no status to show.
    const res = await post('deadbeef', OVERSIZE);
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('the OPTIONS preflight still short-circuits with its CORS headers', async () => {
    const res = await fetch(`${server.base}/api/dom-snapshots/deadbeef`, {
      method: 'OPTIONS',
      headers: { origin: 'https://page.example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('a live token still falls through the gate to the real handler', async () => {
    const res = await post(liveToken, JSON.stringify({ snapshots: [validSnapshot()] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('snapshot_ref');
  });

  it('an EXPIRED token gets the same 404 as an unknown one at the HTTP boundary too', async () => {
    let now = 0;
    const clocked = new DomSnapshotStore(() => now);
    const tok = clocked.mint('owner-a');
    now = 3 * 60 * 60 * 1000;   // past the hard cap
    const app = express();
    app.use('/api/dom-snapshots', createDomSnapshotRoutes({ store: clocked, logger: createLogger({ level: 'silent' }) }));
    const expired = await startTestServer(app);
    try {
      const url = `${expired.base}/api/dom-snapshots/${tok}`;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: OVERSIZE });
      expect(res.status).toBe(404);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await expired.close();
    }
  });

  it('GET /extractor.js is not caught by the POST-scoped gate', async () => {
    const res = await fetch(`${server.base}/api/dom-snapshots/extractor.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('window.__figmaDomDiff = ');
  });
});
