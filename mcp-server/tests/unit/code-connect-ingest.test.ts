import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { startTestServer, type TestHttpServer } from '../helpers/http-test-server.js';
import { createCodeConnectIngest, type IngestDeps } from '../../src/multi-tenant/code-connect-ingest.js';

let server: TestHttpServer; let calls: any;
beforeEach(async () => {
  calls = {};
  const deps: IngestDeps = {
    resolveCiKey: async (k) => (k === 'fmcp_ci_good' ? 'u1' : null),
    replaceMappings: async (userId, mappings) => { calls.replace = { userId, count: mappings.length }; },
  };
  const app = express();
  app.use('/api/code-connect', createCodeConnectIngest(deps));
  server = await startTestServer(app);
});
afterEach(() => server.close());

const docs = [{ figmaNode: 'https://figma.com/file/F/Lib?node-id=1-5', label: 'React', component: 'Button', source: '', template: 't', templateData: {} }];

describe('code-connect ingest', () => {
  it('401 without a CI key', async () => {
    const res = await fetch(`${server.base}/api/code-connect/mappings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs }) });
    expect(res.status).toBe(401);
  });
  it('403 for an unknown CI key', async () => {
    const res = await fetch(`${server.base}/api/code-connect/mappings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ci-key': 'fmcp_ci_bad' }, body: JSON.stringify({ docs }) });
    expect(res.status).toBe(403);
  });
  it('stores normalized mappings for the key owner', async () => {
    const res = await fetch(`${server.base}/api/code-connect/mappings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ci-key': 'fmcp_ci_good' }, body: JSON.stringify({ docs }) });
    expect(res.status).toBe(200);
    expect(calls.replace).toEqual({ userId: 'u1', count: 1 });
    expect((await res.json()).stored).toBe(1);
  });
  it('400 on malformed body', async () => {
    const res = await fetch(`${server.base}/api/code-connect/mappings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ci-key': 'fmcp_ci_good' }, body: JSON.stringify({ nope: true }) });
    expect(res.status).toBe(400);
  });

  it('422 when all docs are unparseable (refuses to wipe mappings)', async () => {
    const res = await fetch(`${server.base}/api/code-connect/mappings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ci-key': 'fmcp_ci_good' },
      body: JSON.stringify({ docs: [{ figmaNode: 'no-node-id', component: 'X' }] }),
    });
    expect(res.status).toBe(422);
    expect(calls.replace).toBeUndefined();
  });
});
