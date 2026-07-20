// mcp-server/src/multi-tenant/code-connect-ingest.ts
// POST /api/code-connect/mappings — a tenant's CI uploads `figma connect parse`
// output (CodeConnectJSON[]). Authed by X-CI-Key (not JWT — CI can't do OAuth).
// Full per-user replace, so re-running CI is idempotent.
import { Router, type Request, type Response } from 'express';
import express from 'express';
import { normalizeDocs, type CodeConnectJSON, type StoredMapping } from '../domain/code-connect.js';

export interface IngestDeps {
  resolveCiKey: (plaintext: string) => Promise<string | null>;
  replaceMappings: (userId: string, mappings: StoredMapping[]) => Promise<void>;
}

export function createCodeConnectIngest(deps: IngestDeps): Router {
  const router = Router();
  router.use(express.json({ limit: '8mb' }));

  router.post('/mappings', async (req: Request, res: Response) => {
    const ciKey = req.headers['x-ci-key'];
    if (typeof ciKey !== 'string' || !ciKey) {
      res.status(401).json({ error: 'X-CI-Key required' });
      return;
    }
    const userId = await deps.resolveCiKey(ciKey);
    if (!userId) {
      res.status(403).json({ error: 'Invalid CI key' });
      return;
    }
    const docs = (req.body as { docs?: unknown })?.docs;
    if (!Array.isArray(docs)) {
      res.status(400).json({ error: 'Body must be { docs: CodeConnectJSON[] } (output of `figma connect parse`)' });
      return;
    }
    const mappings = normalizeDocs(docs as CodeConnectJSON[]);
    if (docs.length > 0 && mappings.length === 0) {
      res.status(422).json({ error: 'All docs had unparseable figmaNode URLs; refusing to replace mappings with an empty set. Check the figmaNode URLs in your `figma connect parse` output.', received: docs.length });
      return;
    }
    await deps.replaceMappings(userId, mappings);
    // skipped = docs whose figmaNode had no recognizable file key / node-id.
    res.json({ stored: mappings.length, received: docs.length, skipped: docs.length - mappings.length });
  });

  return router;
}
