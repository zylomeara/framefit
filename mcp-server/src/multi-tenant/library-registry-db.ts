// mcp-server/src/multi-tenant/library-registry-db.ts
// Per-user registry: which DS teams a user registered, and the variable-library files
// discovered in them. ensureLibraryRegistrySchema runs at MT boot. Mirrors code-connect/
// variable-snapshot db style.
import { getSharedPool } from './db.js';
import type { DiscoveredLibrary } from './team-discovery.js';

export interface LibraryRow { team_id: string; file_key: string; name: string; vars: number; last_synced_at: Date | null }

export async function ensureLibraryRegistrySchema(): Promise<void> {
  await getSharedPool().query(`
    CREATE TABLE IF NOT EXISTS registered_teams (
      keycloak_user_id VARCHAR NOT NULL,
      team_id          VARCHAR NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (keycloak_user_id, team_id)
    );
    CREATE TABLE IF NOT EXISTS library_files (
      keycloak_user_id VARCHAR NOT NULL,
      team_id          VARCHAR NOT NULL,
      file_key         VARCHAR NOT NULL,
      name             VARCHAR NOT NULL DEFAULT '',
      vars             INTEGER NOT NULL DEFAULT 0,
      last_synced_at   TIMESTAMPTZ,
      PRIMARY KEY (keycloak_user_id, file_key)
    );
    CREATE INDEX IF NOT EXISTS idx_library_files_user ON library_files (keycloak_user_id);
  `);
}

export async function truncateRegistryForTests(): Promise<void> {
  const p = getSharedPool();
  await p.query('TRUNCATE registered_teams');
  await p.query('TRUNCATE library_files');
}

export async function addTeam(userId: string, teamId: string): Promise<void> {
  await getSharedPool().query(
    'INSERT INTO registered_teams (keycloak_user_id, team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [userId, teamId],
  );
}
export async function listTeams(userId: string): Promise<string[]> {
  const r = await getSharedPool().query('SELECT team_id FROM registered_teams WHERE keycloak_user_id=$1 ORDER BY created_at', [userId]);
  return r.rows.map((x) => x.team_id);
}
export async function removeTeam(userId: string, teamId: string): Promise<void> {
  const client = await getSharedPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM library_variables WHERE keycloak_user_id=$1 AND file_key IN (SELECT file_key FROM library_files WHERE keycloak_user_id=$1 AND team_id=$2)',
      [userId, teamId],
    );
    await client.query(
      'DELETE FROM library_collections WHERE keycloak_user_id=$1 AND file_key IN (SELECT file_key FROM library_files WHERE keycloak_user_id=$1 AND team_id=$2)',
      [userId, teamId],
    );
    await client.query('DELETE FROM library_files WHERE keycloak_user_id=$1 AND team_id=$2', [userId, teamId]);
    await client.query('DELETE FROM registered_teams WHERE keycloak_user_id=$1 AND team_id=$2', [userId, teamId]);
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* dead */ } throw e; } finally { client.release(); }
}
export async function setLibraries(userId: string, teamId: string, libs: DiscoveredLibrary[], preserve?: string[] | 'all'): Promise<void> {
  const client = await getSharedPool().connect();
  try {
    await client.query('BEGIN');
    // Eviction is safe only under full knowledge (spec): 'all' keeps every previous row (the
    // team's enumeration was incomplete); a key list shields enumerated-but-failed files. A
    // preserved row is NOT re-inserted — it stays byte-identical, so its untouched
    // last_synced_at is the honest staleness signal (no extra column needed).
    if (preserve !== 'all') {
      if (preserve?.length) {
        await client.query('DELETE FROM library_files WHERE keycloak_user_id=$1 AND team_id=$2 AND NOT (file_key = ANY($3))', [userId, teamId, preserve]);
      } else {
        await client.query('DELETE FROM library_files WHERE keycloak_user_id=$1 AND team_id=$2', [userId, teamId]);
      }
    }
    for (const l of libs) {
      await client.query(
        `INSERT INTO library_files (keycloak_user_id, team_id, file_key, name, vars, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (keycloak_user_id, file_key) DO UPDATE SET team_id=EXCLUDED.team_id, name=EXCLUDED.name, vars=EXCLUDED.vars, last_synced_at=NOW()`,
        [userId, teamId, l.file_key, l.name, l.vars],
      );
    }
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* dead */ } throw e; } finally { client.release(); }
}
export async function listLibraries(userId: string): Promise<LibraryRow[]> {
  const r = await getSharedPool().query(
    'SELECT team_id, file_key, name, vars, last_synced_at FROM library_files WHERE keycloak_user_id=$1 ORDER BY name', [userId]);
  return r.rows;
}

/** Direct PK lookup — deliberately NO process cache: a stale `true` after removeTeam would keep
 * asserting library_default_modes for an unregistered file (spec review). */
export async function hasLibraryFile(userId: string, fileKey: string): Promise<boolean> {
  const r = await getSharedPool().query('SELECT 1 FROM library_files WHERE keycloak_user_id=$1 AND file_key=$2 LIMIT 1', [userId, fileKey]);
  return (r.rowCount ?? 0) > 0;
}
