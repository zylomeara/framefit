// mcp-server/src/multi-tenant/variable-snapshot-db.ts
// Per-user, per-library resolved variable snapshots uploaded by the plugin.
// ensureVariableSnapshotSchema runs at MT boot. Lookup by published library_key.
import { getSharedPool } from './db.js';
import type { SnapshotEntry } from '../domain/variable-snapshot.js';

export interface SnapshotHit { value: string; resolved_type: string; name: string }

export async function ensureVariableSnapshotSchema(): Promise<void> {
  await getSharedPool().query(`
    CREATE TABLE IF NOT EXISTS variable_snapshots (
      keycloak_user_id  VARCHAR NOT NULL,
      library_file_key  VARCHAR NOT NULL,
      library_key       VARCHAR NOT NULL,
      value             TEXT NOT NULL,
      resolved_type     VARCHAR NOT NULL DEFAULT '',
      name              VARCHAR NOT NULL DEFAULT '',
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (keycloak_user_id, library_file_key, library_key)
    );
    CREATE INDEX IF NOT EXISTS idx_varsnap_lookup ON variable_snapshots (keycloak_user_id, library_key);
  `);
}

/** Test-only helper; harmless in prod. */
export async function truncateVariableSnapshotForTests(): Promise<void> {
  await getSharedPool().query('TRUNCATE variable_snapshots');
}

export async function replaceSnapshot(userId: string, libraryFileKey: string, entries: SnapshotEntry[]): Promise<void> {
  const client = await getSharedPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM variable_snapshots WHERE keycloak_user_id = $1 AND library_file_key = $2', [userId, libraryFileKey]);
    for (const e of entries) {
      await client.query(
        `INSERT INTO variable_snapshots (keycloak_user_id, library_file_key, library_key, value, resolved_type, name)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (keycloak_user_id, library_file_key, library_key) DO UPDATE
           SET value = EXCLUDED.value, resolved_type = EXCLUDED.resolved_type, name = EXCLUDED.name, updated_at = NOW()`,
        [userId, libraryFileKey, e.key, e.value, e.resolved_type, e.name],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* dead conn */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function lookupSnapshot(userId: string, keys: string[]): Promise<Map<string, SnapshotHit>> {
  const out = new Map<string, SnapshotHit>();
  if (keys.length === 0) return out;
  const uniqueKeys = [...new Set(keys)];
  const result = await getSharedPool().query(
    `SELECT library_key, value, resolved_type, name, updated_at FROM variable_snapshots
     WHERE keycloak_user_id = $1 AND library_key = ANY($2)
     ORDER BY updated_at DESC`,
    [userId, uniqueKeys],
  );
  for (const row of result.rows) {
    // Same library_key could exist under two libraries for one user; keep newest.
    if (out.has(row.library_key)) continue;
    out.set(row.library_key, { value: row.value, resolved_type: row.resolved_type, name: row.name });
  }
  return out;
}
