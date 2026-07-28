import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { startTestServer, type TestHttpServer } from '../helpers/http-test-server.js';
import { createAccountsRouter, type AccountsApiDeps } from '../../src/multi-tenant/accounts-api.js';
import type { LibraryRow } from '../../src/multi-tenant/library-registry-db.js';

// ---- fakes ------------------------------------------------------------------

const TEAM_ID = '1234567890123456789';

const fakeLibraries: LibraryRow[] = [
  { team_id: TEAM_ID, file_key: 'abc123', name: 'Design Tokens', vars: 42, last_synced_at: null },
];

function makeRegistryFake() {
  const addTeam = vi.fn<(a: string, b: string) => Promise<void>>().mockResolvedValue(undefined);
  const listTeams = vi.fn<(a: string) => Promise<{ team_id: string }[]>>().mockResolvedValue([{ team_id: TEAM_ID }]);
  const removeTeam = vi.fn<(a: string, b: string) => Promise<boolean>>().mockResolvedValue(true);
  const listLibraries = vi.fn<(a: string) => Promise<LibraryRow[]>>().mockResolvedValue(fakeLibraries);
  const discover = vi.fn<(a: string, b: string) => Promise<{ file_key: string; name: string; vars: number }[]>>()
    .mockResolvedValue([{ file_key: 'abc123', name: 'Design Tokens', vars: 42 }]);
  return { addTeam, listTeams, removeTeam, listLibraries, discover };
}

function makeSyncFake() {
  return {
    start: vi.fn<(a: string, b?: string) => { status: 'started' | 'already_running'; startedAt?: number }>(
      () => ({ status: 'started', startedAt: 123 }),
    ),
    status: vi.fn<(a: string) => { state: 'idle' | 'running' | 'done' | 'error'; startedAt?: number }>(
      () => ({ state: 'running', startedAt: 123 }),
    ),
  };
}

function makeRemoveTokenFake() {
  return vi.fn<(a: string, b: string) => Promise<boolean>>().mockResolvedValue(false);
}

function baseDeps(overrides: Partial<AccountsApiDeps> = {}): AccountsApiDeps {
  return {
    encryptionKey: 'a'.repeat(64),
    validatePat: async () => ({ ok: true, handle: 'h' }),
    db: {
      listTokens: async () => [],
      addToken: async () => ({}) as any,
      removeToken: makeRemoveTokenFake(),
      setDefaultToken: async () => false,
      getTokenWithPat: async () => null,
      updateValidation: async () => {},
    },
    ...overrides,
  };
}

// ---- harness ----------------------------------------------------------------

let server: TestHttpServer;
let removeTokenSpy: ReturnType<typeof makeRemoveTokenFake>;

function makeApp(deps: AccountsApiDeps, userId = 'u1') {
  const app = express();
  app.use(express.json());
  app.use((_q, res, next) => { res.locals.userId = userId; next(); });
  app.use('/accounts', createAccountsRouter(deps));
  return app;
}

async function startApp(deps: AccountsApiDeps, userId = 'u1') {
  const app = makeApp(deps, userId);
  server = await startTestServer(app);
}

afterEach(() => server.close());

// ---- tests ------------------------------------------------------------------

describe('accounts teams – POST /teams', () => {
  let registry: ReturnType<typeof makeRegistryFake>;

  beforeEach(async () => {
    registry = makeRegistryFake();
    removeTokenSpy = makeRemoveTokenFake();
    const deps = baseDeps({ registry, db: { ...baseDeps().db, removeToken: removeTokenSpy } });
    await startApp(deps);
  });

  it('registers a team instantly and returns 201 with {team_id} (no discovery)', async () => {
    const res = await fetch(`${server.base}/accounts/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: TEAM_ID }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { team_id: string };
    expect(body.team_id).toBe(TEAM_ID);
  });

  it('calls addTeam but does NOT call discover (discovery moved to background sync)', async () => {
    await fetch(`${server.base}/accounts/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: TEAM_ID }),
    });
    expect(registry.addTeam).toHaveBeenCalledWith('u1', TEAM_ID);
    expect(registry.discover).not.toHaveBeenCalled();
  });

  it('returns 400 for non-numeric team_id', async () => {
    const res = await fetch(`${server.base}/accounts/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing team_id', async () => {
    const res = await fetch(`${server.base}/accounts/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('accounts teams – POST /teams without registry dep', () => {
  beforeEach(async () => {
    await startApp(baseDeps()); // no registry
  });

  it('returns 404 when registry dep is absent', async () => {
    const res = await fetch(`${server.base}/accounts/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: TEAM_ID }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('Team registry unavailable');
  });
});

describe('accounts teams – GET /teams', () => {
  let registry: ReturnType<typeof makeRegistryFake>;

  beforeEach(async () => {
    registry = makeRegistryFake();
    await startApp(baseDeps({ registry }));
  });

  it('returns teams and libraries scoped to userId', async () => {
    const res = await fetch(`${server.base}/accounts/teams`);
    expect(res.status).toBe(200);
    const body = await res.json() as { teams: { team_id: string }[]; libraries: LibraryRow[] };
    expect(body.teams).toEqual([{ team_id: TEAM_ID }]);
    expect(body.libraries[0].file_key).toBe('abc123');
    expect(registry.listTeams).toHaveBeenCalledWith('u1');
    expect(registry.listLibraries).toHaveBeenCalledWith('u1');
  });
});

describe('accounts teams – GET /teams without registry dep', () => {
  beforeEach(async () => {
    await startApp(baseDeps()); // no registry
  });

  it('returns empty teams/libraries gracefully', async () => {
    const res = await fetch(`${server.base}/accounts/teams`);
    expect(res.status).toBe(200);
    const body = await res.json() as { teams: unknown[]; libraries: unknown[] };
    expect(body).toEqual({ teams: [], libraries: [] });
  });
});

describe('accounts teams – DELETE /teams/:id', () => {
  let registry: ReturnType<typeof makeRegistryFake>;

  beforeEach(async () => {
    registry = makeRegistryFake();
    removeTokenSpy = makeRemoveTokenFake();
    const deps = baseDeps({ registry, db: { ...baseDeps().db, removeToken: removeTokenSpy } });
    await startApp(deps);
  });

  it('removes team and returns {ok:true}', async () => {
    const res = await fetch(`${server.base}/accounts/teams/${TEAM_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(registry.removeTeam).toHaveBeenCalledWith('u1', TEAM_ID);
  });

  it('does NOT call removeToken (no route collision with /:label)', async () => {
    await fetch(`${server.base}/accounts/teams/${TEAM_ID}`, { method: 'DELETE' });
    expect(removeTokenSpy).not.toHaveBeenCalled();
  });

  it('returns 404 when removeTeam returns false', async () => {
    registry.removeTeam.mockResolvedValueOnce(false);
    const res = await fetch(`${server.base}/accounts/teams/${TEAM_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('Team not registered');
  });

  it('returns 400 for bad (non-numeric) team id', async () => {
    const res = await fetch(`${server.base}/accounts/teams/not-an-id`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });
});

describe('accounts teams – DELETE /teams/:id without registry dep', () => {
  beforeEach(async () => {
    await startApp(baseDeps()); // no registry
  });

  it('returns 404 when registry dep is absent', async () => {
    const res = await fetch(`${server.base}/accounts/teams/${TEAM_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('Team registry unavailable');
  });
});

describe('accounts teams – POST /sync (kick off background sync)', () => {
  let syncFake: ReturnType<typeof makeSyncFake>;

  beforeEach(async () => {
    syncFake = makeSyncFake();
    await startApp(baseDeps({ sync: syncFake }));
  });

  it('returns 202 with {status:"started"} and calls start with userId', async () => {
    const res = await fetch(`${server.base}/accounts/sync`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await res.json() as { status: string; startedAt?: number };
    expect(body.status).toBe('started');
    expect(syncFake.start).toHaveBeenCalledWith('u1');
  });
});

describe('accounts teams – POST /teams/:id/sync (per-team sync)', () => {
  let syncFake: ReturnType<typeof makeSyncFake>;

  beforeEach(async () => {
    syncFake = makeSyncFake();
    await startApp(baseDeps({ sync: syncFake }));
  });

  it('returns 202 {status:"started"} and calls start with (userId, teamId)', async () => {
    const res = await fetch(`${server.base}/accounts/teams/${TEAM_ID}/sync`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('started');
    expect(syncFake.start).toHaveBeenCalledWith('u1', TEAM_ID);
  });

  it('returns 400 for a bad (non-numeric) team id', async () => {
    const res = await fetch(`${server.base}/accounts/teams/not-an-id/sync`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(syncFake.start).not.toHaveBeenCalled();
  });
});

describe('accounts teams – POST /teams/:id/sync without sync dep', () => {
  beforeEach(async () => {
    await startApp(baseDeps()); // no sync
  });

  it('returns 404 when sync dep is absent', async () => {
    const res = await fetch(`${server.base}/accounts/teams/${TEAM_ID}/sync`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('Sync unavailable');
  });
});

describe('accounts teams – GET /sync (status for polling)', () => {
  let syncFake: ReturnType<typeof makeSyncFake>;

  beforeEach(async () => {
    syncFake = makeSyncFake();
    await startApp(baseDeps({ sync: syncFake }));
  });

  it('returns 200 with the status object', async () => {
    const res = await fetch(`${server.base}/accounts/sync`);
    expect(res.status).toBe(200);
    const body = await res.json() as { state: string; startedAt?: number };
    expect(body).toEqual({ state: 'running', startedAt: 123 });
    expect(syncFake.status).toHaveBeenCalledWith('u1');
  });
});

describe('accounts teams – /sync without sync dep', () => {
  beforeEach(async () => {
    await startApp(baseDeps()); // no sync
  });

  it('POST returns 404 when sync dep is absent', async () => {
    const res = await fetch(`${server.base}/accounts/sync`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('Sync unavailable');
  });

  it('GET returns {state:"idle"} when sync dep is absent', async () => {
    const res = await fetch(`${server.base}/accounts/sync`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'idle' });
  });
});

describe('accounts teams – userId isolation', () => {
  let registry: ReturnType<typeof makeRegistryFake>;

  it('passes the correct userId when res.locals.userId differs', async () => {
    registry = makeRegistryFake();
    // Start a fresh server with userId = 'user-XYZ'
    const deps = baseDeps({ registry });
    const app = makeApp(deps, 'user-XYZ');
    const alt = await startTestServer(app);

    try {
      await fetch(`${alt.base}/accounts/teams`);
      expect(registry.listTeams).toHaveBeenCalledWith('user-XYZ');
      expect(registry.listTeams).not.toHaveBeenCalledWith('u1');
    } finally {
      await alt.close();
    }
  });
});
