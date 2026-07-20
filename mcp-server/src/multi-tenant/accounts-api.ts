// /accounts router used by the portal. Deps are injected (not via
// module-level imports) so the router unit-tests with fakes. The router assumes
// an upstream middleware put the authenticated user's id into res.locals.userId.
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { FigmaTokenRow, AddTokenInput } from './db.js';
import type { PatValidation } from './validate-pat.js';
import type { LibraryRow } from './library-registry-db.js';
import type { DiscoveredLibrary } from './team-discovery.js';
import { auditActionFor, auditOutcomeFor, auditTargetFrom } from './audit-mapping.js';

export interface AccountsApiDeps {
  encryptionKey: string;
  validatePat: (pat: string) => Promise<PatValidation>;
  db: {
    listTokens(userId: string): Promise<FigmaTokenRow[]>;
    addToken(userId: string, input: AddTokenInput, encryptionKey: string): Promise<FigmaTokenRow>;
    removeToken(userId: string, label: string): Promise<boolean>;
    setDefaultToken(userId: string, label: string): Promise<boolean>;
    getTokenWithPat(
      userId: string,
      label: string,
      encryptionKey: string,
    ): Promise<{ row: FigmaTokenRow; pat: string } | null>;
    updateValidation(id: number, status: 'active' | 'invalid', userId: string): Promise<void>;
  };
  ciKeys?: {
    createCiKey(userId: string, label: string): Promise<{ id: number; plaintext: string }>;
    listCiKeys(userId: string): Promise<{ id: number; label: string; created_at: Date; last_used_at: Date | null }[]>;
    revokeCiKey(userId: string, id: number): Promise<boolean>;
  };
  bridgeToken?: {
    issue(userId: string): Promise<{ token: string; expires_at: string; scope: string }>;
  };
  registry?: {
    addTeam(userId: string, teamId: string): Promise<void>;
    listTeams(userId: string): Promise<{ team_id: string }[]>;
    removeTeam(userId: string, teamId: string): Promise<boolean>;
    listLibraries(userId: string): Promise<LibraryRow[]>;
    discover(userId: string, teamId: string): Promise<DiscoveredLibrary[]>;
  };
  sync?: {
    start(userId: string, teamId?: string): { status: 'started' | 'already_running'; startedAt?: number };
    status(userId: string): {
      state: 'idle' | 'running' | 'done' | 'error';
      startedAt?: number;
      finishedAt?: number;
      result?: { libraries: number; variables: number; skipped: number };
      error?: string;
    };
  };
  settings?: {
    getUserSettings(userId: string): Promise<{ read_only: boolean }>;
    setReadOnly(userId: string, readOnly: boolean): Promise<void>;
  };
  audit?: {
    record(userId: string, entry: { action: string; target: string | null; outcome: string; meta?: Record<string, unknown> }): Promise<void>;
    list(userId: string, opts: { limit: number }): Promise<{ id: number; action: string; target: string | null; outcome: string; created_at: Date }[]>;
  };
  usage?: {
    summary(userId: string): Promise<{ label: string; today: number; last7: number; daily: number[] }[]>;
  };
}

const LABEL_RE = /^[a-zA-Z0-9 _.-]{1,64}$/;
const TEAM_ID_RE = /^\d{4,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function daysLeft(expiresAt: string | null, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const exp = new Date(`${expiresAt}T00:00:00Z`);
  return Math.ceil((exp.getTime() - now.getTime()) / MS_PER_DAY) || 0;
}

function toSafe(row: FigmaTokenRow) {
  return {
    label: row.label,
    pat_suffix: row.pat_suffix,
    figma_handle: row.figma_handle,
    scopes: row.scopes,
    expires_at: row.expires_at,
    days_left: daysLeft(row.expires_at),
    status: row.status,
    last_validated_at: row.last_validated_at,
    is_default: row.is_default,
  };
}

function userId(res: Response): string {
  return res.locals.userId as string;
}

export function createAccountsRouter(deps: AccountsApiDeps): Router {
  const router = Router();

  // Audit: one finish-listener emits a row for every mutating admin action.
  // action <- route map, outcome <- status, target <- params/body, rich meta <- res.locals.auditMeta.
  router.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      if (!deps.audit) return;
      const action = auditActionFor(req.method, req.route?.path);
      if (!action) return;
      const uid = res.locals.userId as string | undefined;
      if (!uid) return;
      const meta = (res.locals.auditMeta as Record<string, unknown> | undefined) ?? {};
      void deps.audit
        .record(uid, { action, target: auditTargetFrom(req.params, req.body), outcome: auditOutcomeFor(res.statusCode), meta })
        .catch(() => { /* never let auditing break a request */ });
    });
    next();
  });

  router.get('/', async (_req: Request, res: Response) => {
    const rows = await deps.db.listTokens(userId(res));
    res.json(rows.map(toSafe));
  });

  router.post('/', async (req: Request, res: Response) => {
    const { label, pat, expires_at } = (req.body ?? {}) as {
      label?: string;
      pat?: string;
      expires_at?: string;
    };
    if (typeof label !== 'string' || !LABEL_RE.test(label)) {
      res.status(400).json({ error: 'label is required: 1-64 chars, [a-zA-Z0-9 _.-]' });
      return;
    }
    if (typeof pat !== 'string' || pat.trim().length < 16) {
      res.status(400).json({ error: 'pat is required (a Figma personal access token)' });
      return;
    }
    if (expires_at !== undefined && !DATE_RE.test(expires_at)) {
      res.status(400).json({ error: 'expires_at must be YYYY-MM-DD' });
      return;
    }

    const validation = await deps.validatePat(pat.trim());
    if (!validation.ok) {
      res.status(400).json({ error: `Figma rejected the token (HTTP ${validation.status}). Check the PAT and its scopes.` });
      return;
    }

    try {
      const row = await deps.db.addToken(
        userId(res),
        { label, pat: pat.trim(), figmaHandle: validation.handle, scopes: [], expiresAt: expires_at ?? null },
        deps.encryptionKey,
      );
      res.locals.auditMeta = { figma_handle: validation.handle };
      res.status(201).json(toSafe(row));
    } catch (error: unknown) {
      if ((error as { code?: string }).code === '23505') {
        res.status(409).json({ error: `Token "${label}" already exists` });
      } else {
        throw error;
      }
    }
  });

  // --- Teams registry routes (registered BEFORE /:label to avoid route collision) ---

  router.post('/teams', async (req: Request, res: Response) => {
    if (!deps.registry) { res.status(404).json({ error: 'Team registry unavailable' }); return; }
    const { team_id } = (req.body ?? {}) as { team_id?: string };
    if (typeof team_id !== 'string' || !TEAM_ID_RE.test(team_id)) {
      res.status(400).json({ error: 'team_id is required (numeric Figma team id)' });
      return;
    }
    // Instant register: no synchronous discovery (that ran for ~2+ min and hung the
    // request). Discovery + pull now happen in the background sync (POST /sync).
    await deps.registry.addTeam(userId(res), team_id);
    res.status(201).json({ team_id });
  });

  router.get('/teams', async (_req: Request, res: Response) => {
    if (!deps.registry) { res.json({ teams: [], libraries: [] }); return; }
    res.json({
      teams: await deps.registry.listTeams(userId(res)),
      libraries: await deps.registry.listLibraries(userId(res)),
    });
  });

  router.delete('/teams/:id', async (req: Request, res: Response) => {
    if (!deps.registry) { res.status(404).json({ error: 'Team registry unavailable' }); return; }
    if (!TEAM_ID_RE.test(req.params.id)) { res.status(400).json({ error: 'bad team id' }); return; }
    const ok = await deps.registry.removeTeam(userId(res), req.params.id);
    if (ok) res.json({ ok: true }); else res.status(404).json({ error: 'Team not registered' });
  });

  // Per-team sync: kick off a background sync scoped to ONE registered team. Registered
  // among the /teams routes (BEFORE the generic /:label routes) so it does not collide.
  router.post('/teams/:id/sync', async (req: Request, res: Response) => {
    if (!deps.sync) { res.status(404).json({ error: 'Sync unavailable' }); return; }
    if (!TEAM_ID_RE.test(req.params.id)) { res.status(400).json({ error: 'bad team id' }); return; }
    const out = deps.sync.start(userId(res), req.params.id);
    res.status(202).json(out);
  });

  // Kick off a background sync and return immediately (202). The actual discovery +
  // variable pull run fire-and-forget on the server; the portal polls GET /sync.
  router.post('/sync', async (_req: Request, res: Response) => {
    if (!deps.sync) { res.status(404).json({ error: 'Sync unavailable' }); return; }
    const out = deps.sync.start(userId(res));
    res.status(202).json(out);
  });

  // Status for the portal poll loop. Reports idle/running/done/error.
  router.get('/sync', async (_req: Request, res: Response) => {
    if (!deps.sync) { res.json({ state: 'idle' }); return; }
    res.json(deps.sync.status(userId(res)));
  });

  router.get('/settings', async (_req: Request, res: Response) => {
    if (!deps.settings) { res.status(404).json({ error: 'Settings unavailable' }); return; }
    const s = await deps.settings.getUserSettings(userId(res));
    res.json({ read_only: s.read_only });
  });

  router.put('/settings', async (req: Request, res: Response) => {
    if (!deps.settings) { res.status(404).json({ error: 'Settings unavailable' }); return; }
    const { read_only } = (req.body ?? {}) as { read_only?: unknown };
    if (typeof read_only !== 'boolean') { res.status(400).json({ error: 'read_only is required (boolean)' }); return; }
    await deps.settings.setReadOnly(userId(res), read_only);
    res.json({ read_only });
  });

  router.get('/audit', async (req: Request, res: Response) => {
    if (!deps.audit) { res.json({ events: [] }); return; }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json({ events: await deps.audit.list(userId(res), { limit }) });
  });

  router.get('/usage', async (_req: Request, res: Response) => {
    if (!deps.usage) { res.json({ usage: [] }); return; }
    res.json({ usage: await deps.usage.summary(userId(res)) });
  });

  // --- Generic /:label routes (AFTER named routes to avoid collision) ---

  router.delete('/:label', async (req: Request, res: Response) => {
    const removed = await deps.db.removeToken(userId(res), req.params.label);
    if (removed) res.json({ ok: true });
    else res.status(404).json({ error: `Token "${req.params.label}" not found` });
  });

  router.put('/:label/default', async (req: Request, res: Response) => {
    const updated = await deps.db.setDefaultToken(userId(res), req.params.label);
    if (updated) res.json({ ok: true });
    else res.status(404).json({ error: `Token "${req.params.label}" not found` });
  });

  router.post('/:label/validate', async (req: Request, res: Response) => {
    const found = await deps.db.getTokenWithPat(userId(res), req.params.label, deps.encryptionKey);
    if (!found) {
      res.status(404).json({ error: `Token "${req.params.label}" not found` });
      return;
    }
    const validation = await deps.validatePat(found.pat);
    const status = validation.ok ? 'active' : 'invalid';
    await deps.db.updateValidation(found.row.id, status, userId(res));
    res.locals.auditMeta = { status };
    res.json({
      label: found.row.label,
      status,
      figma_handle: validation.ok ? validation.handle : found.row.figma_handle,
    });
  });

  router.post('/ci-keys', async (req: Request, res: Response) => {
    if (!deps.ciKeys) { res.status(404).json({ error: 'CI keys unavailable' }); return; }
    const label = (req.body as { label?: string })?.label;
    if (typeof label !== 'string' || !LABEL_RE.test(label)) {
      res.status(400).json({ error: 'label is required: 1-64 chars [a-zA-Z0-9 _.-]' });
      return;
    }
    const { id, plaintext } = await deps.ciKeys.createCiKey(userId(res), label);
    res.status(201).json({ id, label, ci_key: plaintext, note: 'Store this now — it is not shown again. Use it as X-CI-Key for POST /api/code-connect/mappings.' });
  });

  router.get('/ci-keys', async (_req: Request, res: Response) => {
    if (!deps.ciKeys) { res.json([]); return; }
    res.json(await deps.ciKeys.listCiKeys(userId(res)));
  });

  router.delete('/ci-keys/:id', async (req: Request, res: Response) => {
    if (!deps.ciKeys) { res.status(404).json({ error: 'CI keys unavailable' }); return; }
    if (!/^\d+$/.test(req.params.id)) { res.status(400).json({ error: 'bad id' }); return; }
    const id = Number(req.params.id);
    const ok = await deps.ciKeys.revokeCiKey(userId(res), id);
    if (ok) res.json({ ok: true }); else res.status(404).json({ error: 'CI key not found' });
  });

  router.post('/bridge-token', async (_req: Request, res: Response) => {
    if (!deps.bridgeToken) { res.status(404).json({ error: 'Bridge tokens unavailable' }); return; }
    const out = await deps.bridgeToken.issue(userId(res));
    res.status(201).json({ ...out, note: 'Paste into the Figma plugin. Scoped to variable-snapshot upload; expires.' });
  });

  return router;
}
