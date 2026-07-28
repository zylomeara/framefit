import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { startTestServer, type TestHttpServer } from '../helpers/http-test-server.js';
import { createAccountsRouter, type AccountsApiDeps } from '../../src/multi-tenant/accounts-api.js';
import type { FigmaTokenRow } from '../../src/multi-tenant/db.js';

function fakeRow(over: Partial<FigmaTokenRow> = {}): FigmaTokenRow {
  return {
    id: 1, keycloak_user_id: 'u1', label: 'work', pat_suffix: '1234',
    figma_handle: null, scopes: [], expires_at: null,
    status: 'active', last_validated_at: null, is_default: true,
    created_at: new Date(), updated_at: new Date(), ...over,
  };
}

let server: TestHttpServer;
let settingsCalls: { fn: string; args: unknown[] }[];
let deps: AccountsApiDeps;

beforeEach(async () => {
  settingsCalls = [];

  const settingsStore: Record<string, { read_only: boolean }> = {};

  deps = {
    encryptionKey: 'a'.repeat(64),
    validatePat: async () => ({ ok: true, handle: 'testuser' }),
    db: {
      listTokens: async () => [fakeRow()],
      addToken: async () => fakeRow(),
      removeToken: async () => true,
      setDefaultToken: async () => true,
      getTokenWithPat: async () => ({ row: fakeRow(), pat: 'figd_X' }),
      updateValidation: async () => {},
    },
    settings: {
      getUserSettings: async (userId: string) => {
        settingsCalls.push({ fn: 'getUserSettings', args: [userId] });
        return settingsStore[userId] ?? { read_only: true };
      },
      setReadOnly: async (userId: string, readOnly: boolean) => {
        settingsCalls.push({ fn: 'setReadOnly', args: [userId, readOnly] });
        settingsStore[userId] = { read_only: readOnly };
      },
    },
  };

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.userId = 'u1'; next(); });
  app.use('/accounts', createAccountsRouter(deps));
  server = await startTestServer(app);
});

afterEach(() => server.close());

describe('GET /accounts/settings', () => {
  it('returns read_only and calls getUserSettings with userId', async () => {
    const res = await fetch(`${server.base}/accounts/settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ read_only: true });
    expect(settingsCalls[0]).toEqual({ fn: 'getUserSettings', args: ['u1'] });
  });

  it('returns 404 when settings dep is absent', async () => {
    delete (deps as any).settings;
    const res = await fetch(`${server.base}/accounts/settings`);
    expect(res.status).toBe(404);
  });
});

describe('PUT /accounts/settings', () => {
  it('updates read_only=false and echoes; calls setReadOnly with [u1, false]', async () => {
    const res = await fetch(`${server.base}/accounts/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ read_only: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ read_only: false });
    expect(settingsCalls[0]).toEqual({ fn: 'setReadOnly', args: ['u1', false] });
  });

  it('rejects non-boolean read_only with 400', async () => {
    const res = await fetch(`${server.base}/accounts/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ read_only: 'yes' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/read_only/);
  });

  it('returns 404 when settings dep is absent', async () => {
    delete (deps as any).settings;
    const res = await fetch(`${server.base}/accounts/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ read_only: true }),
    });
    expect(res.status).toBe(404);
  });
});
