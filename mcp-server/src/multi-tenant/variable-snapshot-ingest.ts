// mcp-server/src/multi-tenant/variable-snapshot-ingest.ts
// POST /api/variables/snapshot — the Figma plugin uploads Variable.resolveForConsumer(node) hex
// values for a library. Authed by a scoped bridge-token (Bearer). Full per-(user,
// library) replace, so re-running is idempotent.
import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { normalizeEntries, type SnapshotEntry } from '../domain/variable-snapshot.js';
import { extractBearerToken } from './jwt.js';

export interface SnapshotIngestDeps {
  verifyToken: (token: string) => Promise<string | null>;
  replaceSnapshot: (userId: string, libraryFileKey: string, entries: SnapshotEntry[]) => Promise<void>;
}

export function createVariableSnapshotIngest(deps: SnapshotIngestDeps): Router {
  const router = Router();
  router.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', 'https://www.figma.com');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'authorization, content-type');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  router.use(express.json({ limit: '16mb' }));
  router.post('/snapshot', async (req: Request, res: Response) => {
    const bearer = extractBearerToken(req.headers.authorization);
    if (!bearer) { res.status(401).json({ error: 'Bearer bridge-token required' }); return; }
    const userId = await deps.verifyToken(bearer);
    if (!userId) { res.status(403).json({ error: 'Invalid or expired bridge-token' }); return; }
    const b = (req.body ?? {}) as { library_file_key?: unknown; entries?: unknown };
    if (typeof b.library_file_key !== 'string' || !b.library_file_key) {
      res.status(400).json({ error: 'Body must be { library_file_key: string, entries: [] }' }); return;
    }
    // An ABSENT or non-array `entries` is a client bug, never an instruction to wipe. Coercing it to
    // [] (as this used to) slipped past the 422 guard below — raw.length === 0 — and called
    // replaceSnapshot(..., []) anyway: a silent destructive clear answered 200 {stored:0,received:0}.
    // An EXPLICIT `"entries": []` stays legal and still clears, because that one IS deliberate.
    if (!Array.isArray(b.entries)) {
      res.status(400).json({ error: 'entries must be an array' }); return;
    }
    const raw = b.entries;
    const entries = normalizeEntries(raw);
    if (raw.length > 0 && entries.length === 0) {
      res.status(422).json({ error: 'All entries malformed; refusing to replace snapshot with empty set.', received: raw.length }); return;
    }
    await deps.replaceSnapshot(userId, b.library_file_key, entries);
    res.json({ stored: entries.length, received: raw.length });
  });
  return router;
}
