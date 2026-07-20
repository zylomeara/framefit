import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createAccountsRouter, type AccountsApiDeps } from '../../src/multi-tenant/accounts-api.js';

let server: Server; let base: string;
function deps(): AccountsApiDeps {
  return {
    encryptionKey: 'a'.repeat(64),
    validatePat: async () => ({ ok: true, handle: 'h' }),
    db: {
      listTokens: async () => [], addToken: async () => ({}) as any, removeToken: async () => false,
      setDefaultToken: async () => false, getTokenWithPat: async () => null, updateValidation: async () => {},
    },
    ciKeys: {
      createCiKey: async (_u, label) => ({ id: 1, plaintext: 'fmcp_ci_secret', label } as any),
      listCiKeys: async () => [{ id: 1, label: 'ci', created_at: new Date(), last_used_at: null }],
      revokeCiKey: async (_u, id) => id === 1,
    },
  };
}
beforeEach(async () => {
  const app = express(); app.use(express.json());
  app.use((_q, res, next) => { res.locals.userId = 'u1'; next(); });
  app.use('/accounts', createAccountsRouter(deps()));
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const a = server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('accounts CI keys', () => {
  it('POST /accounts/ci-keys returns the plaintext ONCE', async () => {
    const res = await fetch(`${base}/accounts/ci-keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'ci' }) });
    expect(res.status).toBe(201);
    expect((await res.json()).ci_key).toBe('fmcp_ci_secret');
  });
  it('GET /accounts/ci-keys lists without secrets', async () => {
    const res = await fetch(`${base}/accounts/ci-keys`);
    const body = await res.json();
    expect(body[0].label).toBe('ci');
    expect(JSON.stringify(body)).not.toContain('fmcp_ci_');
  });
  it('DELETE /accounts/ci-keys/:id revokes', async () => {
    expect((await fetch(`${base}/accounts/ci-keys/1`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/accounts/ci-keys/2`, { method: 'DELETE' })).status).toBe(404);
  });
});
