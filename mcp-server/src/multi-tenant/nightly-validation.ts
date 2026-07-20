// mcp-server/src/multi-tenant/nightly-validation.ts
// Re-validates every stored PAT once per day (PATs expire after ≤90 days). A row
// failure (corrupt ciphertext, network) is logged and skipped — one bad token
// must not block the rest. Deps are injectable for tests.
import type { Logger } from '../infrastructure/logger.js';
import { decrypt } from './crypto.js';
import { listAllTokensForValidation, updateValidation } from './db.js';
import { validatePat, type PatValidation } from './validate-pat.js';

export interface NightlyDeps {
  encryptionKey: string;
  logger: Logger;
  intervalMs?: number;
  listAll?: () => Promise<{ id: number; keycloak_user_id: string; encrypted_pat: string }[]>;
  validate?: (pat: string) => Promise<PatValidation>;
  update?: (id: number, status: 'active' | 'invalid', userId: string) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function startNightlyValidation(deps: NightlyDeps): () => void {
  const intervalMs = deps.intervalMs ?? DAY_MS;
  const listAll = deps.listAll ?? listAllTokensForValidation;
  const validate = deps.validate ?? validatePat;
  const update = deps.update ?? updateValidation;

  const run = async (): Promise<void> => {
    try {
      const rows = await listAll();
      let invalid = 0;
      for (const row of rows) {
        try {
          const pat = decrypt(row.encrypted_pat, deps.encryptionKey, row.keycloak_user_id);
          const result = await validate(pat);
          await update(row.id, result.ok ? 'active' : 'invalid', row.keycloak_user_id);
          if (!result.ok) invalid++;
        } catch (err) {
          deps.logger.warn({ token_id: row.id, err: (err as Error).message }, 'nightly.row_failed');
        }
      }
      deps.logger.info({ checked: rows.length, invalid }, 'nightly.done');
    } catch (err) {
      deps.logger.error({ err: (err as Error).message }, 'nightly.run_failed');
    }
  };

  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();

  return () => clearInterval(timer);
}
