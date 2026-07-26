// Postgres-backed storage of per-user Figma PATs. PATs are AES-256-GCM encrypted
// with AAD = keycloak_user_id (see crypto.ts). All read paths except explicit
// *WithPat/DefaultPat return safe rows (no encrypted_pat).
import pg from 'pg';
import { encrypt, decrypt } from './crypto.js';
import type { TokenStats } from '../infrastructure/status.js';

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
       (keycloak_user_id, label, encrypted_pat, pat_suffix, figma_handle, scopes, expires_at, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SAFE_COLUMNS}`,
    [userId, input.label, encrypted, suffix, input.figmaHandle, input.scopes, input.expiresAt, isDefault],
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
  const { rows: [agg] } = await getPool().query(`
    SELECT COUNT(*)::int AS stored,
           COUNT(*) FILTER (WHERE status = 'invalid')::int AS invalid_total,
           MAX(last_validated_at) AS last_validated_at,
           EXTRACT(EPOCH FROM now() - MAX(last_validated_at))::int AS validation_age_sec
    FROM figma_tokens`);
  const { rows: withoutDefault } = await getPool().query(`
    SELECT keycloak_user_id FROM figma_tokens
    GROUP BY keycloak_user_id HAVING COUNT(*) FILTER (WHERE is_default) = 0
    ORDER BY keycloak_user_id`);
  // expires_at is DATE: node-pg parses it at LOCAL midnight, so ::text is required or the day
  // shifts (same reason db.ts:99 already does this).
  const { rows: bad } = await getPool().query(`
    SELECT keycloak_user_id, label, expires_at::text AS expires_at,
           CASE WHEN status = 'invalid' THEN 'invalid' ELSE 'expired' END AS problem
    FROM figma_tokens
    WHERE is_default AND (status = 'invalid' OR (expires_at IS NOT NULL AND expires_at < CURRENT_DATE))
    ORDER BY keycloak_user_id`);
  const { rows: [soonest] } = await getPool().query(`
    SELECT keycloak_user_id, expires_at::text AS expires_at, (expires_at - CURRENT_DATE)::int AS days
    FROM figma_tokens
    WHERE is_default AND expires_at IS NOT NULL AND expires_at >= CURRENT_DATE
    ORDER BY expires_at ASC LIMIT 1`);
  return {
    stored: agg.stored, invalid_total: agg.invalid_total,
    users_without_default: withoutDefault.map((r) => r.keycloak_user_id),
    bad_defaults: bad.map((r) => ({ user: r.keycloak_user_id, label: r.label, problem: r.problem, expires_at: r.expires_at ?? null })),
    soonest_default_expiry: soonest ? { user: soonest.keycloak_user_id, expires_at: soonest.expires_at, days: soonest.days } : null,
    last_validated_at: agg.last_validated_at ? new Date(agg.last_validated_at).toISOString() : null,
    validation_age_sec: agg.validation_age_sec ?? null,
  };
}
