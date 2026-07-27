// Postgres-backed storage of per-user Figma PATs. PATs are AES-256-GCM encrypted
// with AAD = keycloak_user_id (see crypto.ts). All read paths except explicit
// *WithPat/DefaultPat return safe rows (no encrypted_pat).
import pg from 'pg';
import { encrypt, decrypt } from './crypto.js';
import { NIGHTLY_INTERVAL_SEC, type TokenStats } from '../infrastructure/status.js';

const { Pool } = pg;

export interface FigmaTokenRow {
  id: number;
  keycloak_user_id: string;
  label: string;
  pat_suffix: string;
  figma_handle: string | null;
  scopes: string[];
  expires_at: string | null; // 'YYYY-MM-DD'
  status: 'active' | 'invalid';
  last_validated_at: Date | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AddTokenInput {
  label: string;
  pat: string;
  figmaHandle: string | null;
  scopes: string[];
  expiresAt: string | null; // 'YYYY-MM-DD'
  // The moment the caller already confirmed this PAT is valid (e.g. the portal's add route calls
  // validatePat() synchronously before addToken() - accounts-api.ts). Optional: a caller that has
  // NOT just validated the PAT (or a raw insert path) omits it and last_validated_at stays NULL,
  // same as before. Recording it here is not an invention - it is the validation that already
  // happened, persisted instead of thrown away.
  validatedAt?: Date;
}

let pool: pg.Pool | null = null;

export function initDb(databaseUrl: string, onError?: (err: Error) => void): void {
  pool = new Pool({ connectionString: databaseUrl });
  // pg re-emits idle-client errors on the Pool. Without a listener Node turns it
  // into an uncaughtException (process exit) — e.g. on a Postgres restart. Absorb
  // it here; the next query reconnects via the pool.
  pool.on('error', (err) => { onError?.(err); });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function getPool(): pg.Pool {
  if (!pool) throw new Error('Database not initialized. Call initDb() first.');
  return pool;
}

/** Shared pool accessor for sibling MT modules (code-connect-db). Throws if initDb wasn't called. */
export function getSharedPool(): pg.Pool {
  return getPool();
}

export async function pingDb(): Promise<void> {
  await getPool().query('SELECT 1');
}

export async function ensureSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS figma_tokens (
      id                 SERIAL PRIMARY KEY,
      keycloak_user_id   VARCHAR NOT NULL,
      label              VARCHAR NOT NULL,
      encrypted_pat      TEXT NOT NULL,
      pat_suffix         VARCHAR(4) NOT NULL,
      figma_handle       VARCHAR,
      scopes             TEXT[] NOT NULL DEFAULT '{}',
      expires_at         DATE,
      status             VARCHAR NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid')),
      last_validated_at  TIMESTAMPTZ,
      is_default         BOOLEAN NOT NULL DEFAULT false,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_figma_tokens_user_label UNIQUE (keycloak_user_id, label)
    );
    CREATE INDEX IF NOT EXISTS idx_figma_tokens_user ON figma_tokens (keycloak_user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_figma_tokens_user_default
      ON figma_tokens (keycloak_user_id) WHERE is_default;
    CREATE TABLE IF NOT EXISTS user_settings (
      keycloak_user_id   VARCHAR PRIMARY KEY,
      read_only          BOOLEAN NOT NULL DEFAULT true,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/** Test-only helper; harmless in prod (never called there). */
export async function truncateForTests(): Promise<void> {
  await getPool().query('TRUNCATE figma_tokens RESTART IDENTITY');
}

const SAFE_COLUMNS = `id, keycloak_user_id, label, pat_suffix, figma_handle, scopes,
  expires_at::text AS expires_at, status, last_validated_at, is_default, created_at, updated_at`;

/** Distinct keycloak user ids that have at least one registered PAT. Operator-CLI `users` command. */
export async function listUsers(): Promise<string[]> {
  const result = await getPool().query(
    'SELECT DISTINCT keycloak_user_id FROM figma_tokens ORDER BY keycloak_user_id',
  );
  return result.rows.map((r) => r.keycloak_user_id);
}

export async function listTokens(userId: string): Promise<FigmaTokenRow[]> {
  const result = await getPool().query(
    `SELECT ${SAFE_COLUMNS} FROM figma_tokens WHERE keycloak_user_id = $1
     ORDER BY is_default DESC, label`,
    [userId],
  );
  return result.rows;
}

export async function addToken(
  userId: string,
  input: AddTokenInput,
  encryptionKey: string,
): Promise<FigmaTokenRow> {
  const p = getPool();
  const encrypted = encrypt(input.pat, encryptionKey, userId);
  const suffix = input.pat.slice(-4);
  const existing = await p.query(
    'SELECT COUNT(*)::int AS n FROM figma_tokens WHERE keycloak_user_id = $1',
    [userId],
  );
  const isDefault = existing.rows[0].n === 0;
  const result = await p.query(
    `INSERT INTO figma_tokens
       (keycloak_user_id, label, encrypted_pat, pat_suffix, figma_handle, scopes, expires_at, is_default, last_validated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SAFE_COLUMNS}`,
    [userId, input.label, encrypted, suffix, input.figmaHandle, input.scopes, input.expiresAt, isDefault, input.validatedAt ?? null],
  );
  return result.rows[0];
}

export async function removeToken(userId: string, label: string): Promise<boolean> {
  const result = await getPool().query(
    'DELETE FROM figma_tokens WHERE keycloak_user_id = $1 AND label = $2',
    [userId, label],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setDefaultToken(userId: string, label: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE figma_tokens SET is_default = false, updated_at = NOW() WHERE keycloak_user_id = $1',
      [userId],
    );
    const result = await client.query(
      'UPDATE figma_tokens SET is_default = true, updated_at = NOW() WHERE keycloak_user_id = $1 AND label = $2',
      [userId, label],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getDefaultPat(
  userId: string,
  encryptionKey: string,
): Promise<{ pat: string; label: string; status: 'active' | 'invalid' } | null> {
  const result = await getPool().query(
    'SELECT encrypted_pat, label, status FROM figma_tokens WHERE keycloak_user_id = $1 AND is_default = true',
    [userId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { pat: decrypt(row.encrypted_pat, encryptionKey, userId), label: row.label, status: row.status };
}

export async function getTokenWithPat(
  userId: string,
  label: string,
  encryptionKey: string,
): Promise<{ row: FigmaTokenRow; pat: string } | null> {
  const result = await getPool().query(
    `SELECT ${SAFE_COLUMNS}, encrypted_pat FROM figma_tokens
     WHERE keycloak_user_id = $1 AND label = $2`,
    [userId, label],
  );
  if (result.rows.length === 0) return null;
  const { encrypted_pat, ...row } = result.rows[0];
  return { row, pat: decrypt(encrypted_pat, encryptionKey, userId) };
}

export async function updateValidation(id: number, status: 'active' | 'invalid', userId: string): Promise<void> {
  await getPool().query(
    'UPDATE figma_tokens SET status = $1, last_validated_at = NOW(), updated_at = NOW() WHERE id = $2 AND keycloak_user_id = $3',
    [status, id, userId],
  );
}

export async function listAllTokensForValidation(): Promise<
  { id: number; keycloak_user_id: string; encrypted_pat: string }[]
> {
  const result = await getPool().query(
    'SELECT id, keycloak_user_id, encrypted_pat FROM figma_tokens',
  );
  return result.rows;
}

export interface UserSettings { read_only: boolean; }

/** Per-user settings; defaults to read_only=true (write disabled) when no row exists. */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const result = await getPool().query('SELECT read_only FROM user_settings WHERE keycloak_user_id = $1', [userId]);
  if (result.rows.length === 0) return { read_only: true };
  return { read_only: result.rows[0].read_only };
}

export async function setReadOnly(userId: string, readOnly: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO user_settings (keycloak_user_id, read_only) VALUES ($1, $2)
     ON CONFLICT (keycloak_user_id) DO UPDATE SET read_only = EXCLUDED.read_only, updated_at = NOW()`,
    [userId, readOnly],
  );
}

/** Global (no user filter, by design) read-only aggregate of PAT health, for `framefit status`.
 *  READS ONLY - a missing relation must surface as a Postgres error naming it, not be repaired. */
export async function tokenStats(): Promise<TokenStats> {
  // Both thresholds derive from the ONE constant the `tokens` check itself uses
  // (2 * NIGHTLY_INTERVAL_SEC for "stale", NIGHTLY_INTERVAL_SEC for "too young to judge yet") -
  // passed in as query parameters rather than hand-copied `interval` literals, so the SQL and the
  // check can never drift apart on what "48 hours" or "24 hours" means.
  const staleThresholdSec = 2 * NIGHTLY_INTERVAL_SEC;
  const { rows: [agg] } = await getPool().query(
    `SELECT COUNT(*)::int AS stored,
            -- NON-default invalids only. An invalid DEFAULT is reported by name through
            -- bad_defaults below, and the tokens check prints this count on that same fail line:
            -- counting all invalid rows made one invalid default read as "u1 (invalid)" PLUS
            -- "invalid_non_default: 1", i.e. a second, non-existent problem to go hunt.
            COUNT(*) FILTER (WHERE status = 'invalid' AND NOT is_default)::int AS invalid_non_default,
            CASE WHEN MIN(last_validated_at) IS NULL THEN NULL
                 ELSE GREATEST(0, EXTRACT(EPOCH FROM now() - MIN(last_validated_at)))::int END AS validation_age_sec,
            -- A row younger than one nightly interval is exempt: the validator has not had a chance
            -- to see it yet, so a NULL (or old) last_validated_at on a brand-new row is not evidence
            -- of a dead validator - only a genuinely OLD row still lacking recent validation is.
            COUNT(*) FILTER (
              WHERE created_at < now() - (interval '1 second' * $1::int)
                AND (last_validated_at IS NULL OR last_validated_at < now() - (interval '1 second' * $2::int))
            )::int AS stale_or_unvalidated_total,
            bool_or(last_validated_at > now()) AS future_validation_detected
     FROM figma_tokens`,
    [NIGHTLY_INTERVAL_SEC, staleThresholdSec],
  );
  const { rows: withoutDefault } = await getPool().query(`
    SELECT keycloak_user_id FROM figma_tokens
    GROUP BY keycloak_user_id HAVING COUNT(*) FILTER (WHERE is_default) = 0
    ORDER BY keycloak_user_id`);
  // A user can register a Figma team and never add a token at all - invisible to the query above,
  // which only sees rows that already exist in figma_tokens. registered_teams belongs to
  // library-registry-db.ts, but this is a plain read of its table (same pattern graphStats() already
  // uses to read registered_teams from this sibling module), so no import is needed for it.
  const { rows: withoutAnyToken } = await getPool().query(`
    SELECT DISTINCT rt.keycloak_user_id
    FROM registered_teams rt
    LEFT JOIN figma_tokens ft ON ft.keycloak_user_id = rt.keycloak_user_id
    WHERE ft.keycloak_user_id IS NULL
    ORDER BY rt.keycloak_user_id`);
  // expires_at is DATE: node-pg parses it at LOCAL midnight, so ::text is required or the day
  // shifts (same reason db.ts:99 already does this).
  const { rows: bad } = await getPool().query(`
    SELECT keycloak_user_id, label, expires_at::text AS expires_at,
           CASE WHEN status = 'invalid' THEN 'invalid' ELSE 'expired' END AS problem
    FROM figma_tokens
    WHERE is_default AND (status = 'invalid' OR (expires_at IS NOT NULL AND expires_at < CURRENT_DATE))
    ORDER BY keycloak_user_id`);
  // Tie-broken by keycloak_user_id: without it, two defaults sharing the same expires_at resolve in
  // whatever order Postgres happens to scan them, making the winner nondeterministic.
  const { rows: [soonest] } = await getPool().query(`
    SELECT keycloak_user_id, expires_at::text AS expires_at, (expires_at - CURRENT_DATE)::int AS days
    FROM figma_tokens
    WHERE is_default AND expires_at IS NOT NULL AND expires_at >= CURRENT_DATE
    ORDER BY expires_at ASC, keycloak_user_id ASC LIMIT 1`);
  return {
    stored: agg.stored, invalid_non_default: agg.invalid_non_default,
    users_without_default: withoutDefault.map((r) => r.keycloak_user_id),
    users_without_any_token: withoutAnyToken.map((r) => r.keycloak_user_id),
    bad_defaults: bad.map((r) => ({ user: r.keycloak_user_id, label: r.label, problem: r.problem, expires_at: r.expires_at ?? null })),
    soonest_default_expiry: soonest ? { user: soonest.keycloak_user_id, expires_at: soonest.expires_at, days: soonest.days } : null,
    // The age of the OLDEST validation, not of the most recent: MAX() let one freshly re-validated
    // token (e.g. a manual portal action) mask every other stale row and report a dead nightly
    // validator as healthy (five defaults 30 days stale + one revalidated a minute ago used to read
    // as "60s ago, all healthy"). MIN() ignores NULLs (never-validated rows), which is exactly why
    // stale_or_unvalidated_total exists as an independent count that does not ignore them.
    validation_age_sec: agg.validation_age_sec ?? null,
    stale_or_unvalidated_total: agg.stale_or_unvalidated_total,
    future_validation_detected: agg.future_validation_detected ?? false,
  };
}
