import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { startTestServer, type TestHttpServer } from '../helpers/http-test-server.js';
import { createAccountsRouter, type AccountsApiDeps } from '../../src/multi-tenant/accounts-api.js';

// ---- helpers ---------------------------------------------------------------

let server: TestHttpServer;

function makeDepsWithBridgeToken(): AccountsApiDeps {
  return {
    encryptionKey: 'a'.repeat(64),
    validatePat: async () => ({ ok: true, handle: 'h' }),
    db: {
      listTokens: async () => [], addToken: async () => ({}) as any, removeToken: async () => false,
      setDefaultToken: async () => false, getTokenWithPat: async () => null, updateValidation: async () => {},
    },
    bridgeToken: {
      issue: async (userId: string) => ({
        token: `tok-for-${userId}`,
        expires_at: '2026-06-10T00:00:00Z',
        scope: 'variables:snapshot',
      }),
    },
  };
}

function makeDepsWithoutBridgeToken(): AccountsApiDeps {
  return {
    encryptionKey: 'a'.repeat(64),
    validatePat: async () => ({ ok: true, handle: 'h' }),
    db: {
      listTokens: async () => [], addToken: async () => ({}) as any, removeToken: async () => false,
      setDefaultToken: async () => false, getTokenWithPat: async () => null, updateValidation: async () => {},
    },
  };
}

function makeApp(deps: AccountsApiDeps) {
  const app = express(); app.use(express.json());
  app.use((_q, res, next) => { res.locals.userId = 'u1'; next(); });
  app.use('/accounts', createAccountsRouter(deps));
  return app;
}

afterEach(() => server.close());

// ---- tests -----------------------------------------------------------------

describe('accounts bridge-token', () => {
  describe('when bridgeToken dep is present', () => {
    beforeEach(async () => {
      const app = makeApp(makeDepsWithBridgeToken());
      server = await startTestServer(app);
    });

    it('POST /accounts/bridge-token returns 201 with token and scope', async () => {
      const res = await fetch(`${server.base}/accounts/bridge-token`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = await res.json() as { token: string; scope: string };
      expect(body.token).toBe('tok-for-u1');
      expect(body.scope).toBe('variables:snapshot');
    });
  });

  describe('when bridgeToken dep is absent', () => {
    beforeEach(async () => {
      const app = makeApp(makeDepsWithoutBridgeToken());
      server = await startTestServer(app);
    });

    it('POST /accounts/bridge-token returns 404', async () => {
      const res = await fetch(`${server.base}/accounts/bridge-token`, { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });
});
