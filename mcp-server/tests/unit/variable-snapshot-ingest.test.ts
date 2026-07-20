import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createVariableSnapshotIngest, type SnapshotIngestDeps } from '../../src/multi-tenant/variable-snapshot-ingest.js';

let server: Server; let base: string; let calls: any;
beforeEach(async () => {
  calls = {};
  const deps: SnapshotIngestDeps = {
    verifyToken: async (t) => (t === 'good' ? 'u1' : null),
    replaceSnapshot: async (userId, lib, entries) => { calls.replace = { userId, lib, count: entries.length }; calls.entriesArg = entries; },
  };
  const app = express();
  app.use('/api/variables', createVariableSnapshotIngest(deps));
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const a = server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const body = { library_file_key: 'LIB', entries: [{ key: 'b2b2c4d6', value: '#f00', resolved_type: 'COLOR', name: 'bg' }] };
const post = (b: unknown, auth?: string) => fetch(`${base}/api/variables/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(b) });

describe('variable-snapshot ingest', () => {
  it('401 without bearer', async () => { expect((await post(body)).status).toBe(401); });
  it('403 with bad token', async () => { expect((await post(body, 'bad')).status).toBe(403); });
  it('400 without library_file_key', async () => { expect((await post({ entries: body.entries }, 'good')).status).toBe(400); });
  // Destructive-path lock: an absent/non-array `entries` used to be coerced to [], slip past the 422
  // guard (raw.length === 0) and WIPE the stored snapshot with a 200 {stored:0}. It must be a 400 and
  // replaceSnapshot must never be reached.
  it('400 when entries is absent — replaceSnapshot NOT called (no silent wipe)', async () => {
    const res = await post({ library_file_key: 'LIB' }, 'good');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/entries must be an array/);
    expect(calls.replace).toBeUndefined();
  });
  it('400 when entries is not an array — replaceSnapshot NOT called (no silent wipe)', async () => {
    for (const bad of [{}, 'x', 7, null]) {
      calls = {};
      const res = await post({ library_file_key: 'LIB', entries: bad }, 'good');
      expect(res.status).toBe(400);
      expect(calls.replace).toBeUndefined();
    }
  });
  it('200 for an EXPLICIT empty entries array — the deliberate clear still replaces with []', async () => {
    const res = await post({ library_file_key: 'LIB', entries: [] }, 'good');
    expect(res.status).toBe(200);
    expect(calls.replace).toEqual({ userId: 'u1', lib: 'LIB', count: 0 });
    expect(calls.entriesArg).toEqual([]);
    expect(await res.json()).toEqual({ stored: 0, received: 0 });
  });
  it('422 when entries present but all malformed', async () => {
    const res = await post({ library_file_key: 'LIB', entries: [{ value: '#f00' }] }, 'good');
    expect(res.status).toBe(422); expect(calls.replace).toBeUndefined();
  });
  it('200 stores normalized entries for the token owner', async () => {
    const res = await post(body, 'good');
    expect(res.status).toBe(200);
    expect(calls.replace).toEqual({ userId: 'u1', lib: 'LIB', count: 1 });
    expect((await res.json()).stored).toBe(1);
  });
  it('answers the CORS preflight OPTIONS with 204 + Figma-scoped headers', async () => {
    const res = await fetch(`${base}/api/variables/snapshot`, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', origin: 'https://www.figma.com' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.figma.com');
    expect((res.headers.get('access-control-allow-headers') || '').toLowerCase()).toContain('authorization');
    expect((res.headers.get('access-control-allow-methods') || '')).toContain('POST');
  });
  it('includes Access-Control-Allow-Origin on the POST response', async () => {
    const res = await post(body, 'good');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.figma.com');
  });
});
