import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { startTestServer, type TestHttpServer } from '../helpers/http-test-server.js';
import { createAccountsRouter, type AccountsApiDeps, daysLeft } from '../../src/multi-tenant/accounts-api.js';
import type { FigmaTokenRow } from '../../src/multi-tenant/db.js';

function fakeRow(over: Partial<FigmaTokenRow> = {}): FigmaTokenRow {
  return {
    id: 1, keycloak_user_id: 'u1', label: 'work', pat_suffix: '1234',
    figma_handle: 'testuser', scopes: ['file_content:read'], expires_at: '2026-09-01',
    status: 'active', last_validated_at: null, is_default: true,
    created_at: new Date(), updated_at: new Date(), ...over,
  };
}

let server: TestHttpServer;
let deps: AccountsApiDeps;
let calls: Record<string, unknown[]>;

beforeEach(async () => {
  calls = {};
  const track = (name: string, ret: unknown) => (...args: unknown[]) => {
    calls[name] = args;
    return Promise.resolve(ret);
  };
  deps = {
    encryptionKey: 'a'.repeat(64),
    validatePat: track('validatePat', { ok: true, handle: 'testuser' }) as AccountsApiDeps['validatePat'],
    db: {
      listTokens: track('listTokens', [fakeRow()]) as AccountsApiDeps['db']['listTokens'],
      addToken: track('addToken', fakeRow()) as AccountsApiDeps['db']['addToken'],
      removeToken: track('removeToken', true) as AccountsApiDeps['db']['removeToken'],
      setDefaultToken: track('setDefaultToken', true) as AccountsApiDeps['db']['setDefaultToken'],
      getTokenWithPat: track('getTokenWithPat', { row: fakeRow(), pat: 'figd_X' }) as AccountsApiDeps['db']['getTokenWithPat'],
      updateValidation: track('updateValidation', undefined) as AccountsApiDeps['db']['updateValidation'],
    },
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.userId = 'u1'; next(); });
  app.use('/accounts', createAccountsRouter(deps));
  server = await startTestServer(app);
});

afterEach(() => server.close());

describe('accounts api', () => {
  it('GET /accounts returns safe rows with days_left', async () => {
    const res = await fetch(`${server.base}/accounts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].label).toBe('work');
    expect(typeof body[0].days_left).toBe('number');
    expect(JSON.stringify(body)).not.toContain('encrypted');
  });

  it('POST /accounts validates PAT then stores it', async () => {
    const res = await fetch(`${server.base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'work', pat: 'figd_secret_token_value', expires_at: '2026-09-01' }),
    });
    expect(res.status).toBe(201);
    expect(calls.validatePat).toEqual(['figd_secret_token_value']);
    const [userId, input] = calls.addToken as [string, { figmaHandle: string; validatedAt?: Date }];
    expect(userId).toBe('u1');
    expect(input.figmaHandle).toBe('testuser');
    // We just validated this PAT (deps.validatePat resolved ok above) - that moment must be passed
    // through to addToken, not thrown away. Without this, status's stale/never-validated count would
    // treat every freshly added token as unvalidated until the next nightly sweep.
    expect(input.validatedAt).toBeInstanceOf(Date);
    expect(Date.now() - input.validatedAt!.getTime()).toBeLessThan(5000);
  });

  it('POST /accounts rejects a PAT Figma refuses', async () => {
    deps.validatePat = async () => ({ ok: false, status: 403 });
    const res = await fetch(`${server.base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'work', pat: 'figd_dead_token_value' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/403/);
  });

  it('POST /accounts rejects missing fields and bad label', async () => {
    for (const body of [{}, { label: 'a' }, { pat: 'figd_x_long_enough' }, { label: 'bad/slash', pat: 'figd_x_long_enough' }]) {
      const res = await fetch(`${server.base}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('POST /accounts maps unique violation to 409', async () => {
    deps.db.addToken = async () => { const e: any = new Error('dup'); e.code = '23505'; throw e; };
    const res = await fetch(`${server.base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'work', pat: 'figd_secret_token_value' }),
    });
    expect(res.status).toBe(409);
  });

  it('DELETE /accounts/:label → 200/404', async () => {
    expect((await fetch(`${server.base}/accounts/work`, { method: 'DELETE' })).status).toBe(200);
    deps.db.removeToken = async () => false;
    expect((await fetch(`${server.base}/accounts/none`, { method: 'DELETE' })).status).toBe(404);
  });

  it('PUT /accounts/:label/default → 200/404', async () => {
    expect((await fetch(`${server.base}/accounts/work/default`, { method: 'PUT' })).status).toBe(200);
    deps.db.setDefaultToken = async () => false;
    expect((await fetch(`${server.base}/accounts/none/default`, { method: 'PUT' })).status).toBe(404);
  });

  it('POST /accounts/:label/validate revalidates and persists status', async () => {
    deps.validatePat = async () => ({ ok: false, status: 403 });
    const res = await fetch(`${server.base}/accounts/work/validate`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('invalid');
    expect(calls.updateValidation).toEqual([1, 'invalid', 'u1']);
  });
});

describe('daysLeft', () => {
  const NOW = new Date('2026-06-08T12:00:00Z');
  it('returns null for null expiry', () => {
    expect(daysLeft(null, NOW)).toBeNull();
  });
  it('counts whole days to a future date (UTC)', () => {
    expect(daysLeft('2026-06-18', NOW)).toBe(10);
  });
  it('is zero/negative for today and past', () => {
    expect(daysLeft('2026-06-08', NOW)).toBe(0);
    expect(daysLeft('2026-06-07', NOW)).toBe(-1);
  });
});
