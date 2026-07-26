// mcp-server/src/multi-tenant/library-graph-db.ts
// Per-user library variable graph: variables (published key + valuesByMode) and their
// collections' default modes. loadGraph() materialises in-memory maps for the resolver.
import { getSharedPool } from './db.js';
import { buildGraphMaps } from '../domain/variable-graph.js';
import type { GraphStats } from '../infrastructure/status.js';

export interface GraphVar { library_key: string; local_id: string; collection_id: string; values_by_mode: Record<string, unknown>; name: string; resolved_type: string }
export interface GraphColl { collection_id: string; default_mode: string; modes: unknown; name?: string; key?: string }
export interface GraphNode { name: string; valuesByMode: Record<string, unknown>; collectionId: string; fileKey: string }
export interface LoadedGraph {
  byKey: Map<string, GraphNode>; byLocal: Map<string, GraphNode>;
  collDefaultMode: Map<string, string>;
  // Populated by loadGraph() from library_collections.modes (JSONB) via rowsToGraphInput.
  // key = fileKey|collectionId; kept structurally in sync with domain Graph.
  collModes: Map<string, { modeId: string; name: string }[]>;
  collNames: Map<string, string>;
  collKeys: Map<string, string>;                                  // key = fileKey|collectionId (only non-empty)
}

export async function ensureLibraryGraphSchema(): Promise<void> {
  await getSharedPool().query(`
    CREATE TABLE IF NOT EXISTS library_variables (
      keycloak_user_id VARCHAR NOT NULL,
      file_key         VARCHAR NOT NULL,
      library_key      VARCHAR NOT NULL DEFAULT '',
      local_id         VARCHAR NOT NULL,
      collection_id    VARCHAR NOT NULL DEFAULT '',
      values_by_mode   JSONB NOT NULL DEFAULT '{}'::jsonb,
      name             VARCHAR NOT NULL DEFAULT '',
      resolved_type    VARCHAR NOT NULL DEFAULT '',
      PRIMARY KEY (keycloak_user_id, file_key, local_id)
    );
    CREATE INDEX IF NOT EXISTS idx_libvars_key ON library_variables (keycloak_user_id, library_key);
    CREATE TABLE IF NOT EXISTS library_collections (
      keycloak_user_id VARCHAR NOT NULL,
      file_key         VARCHAR NOT NULL,
      collection_id    VARCHAR NOT NULL,
      default_mode     VARCHAR NOT NULL DEFAULT '',
      modes            JSONB NOT NULL DEFAULT '[]'::jsonb,
      name             VARCHAR NOT NULL DEFAULT '',
      key              VARCHAR NOT NULL DEFAULT '',
      PRIMARY KEY (keycloak_user_id, file_key, collection_id)
    );
    -- Additive migration for pre-existing installs: CREATE IF NOT EXISTS never alters an
    -- existing table, so the column must also be added explicitly (idempotent).
    ALTER TABLE library_collections ADD COLUMN IF NOT EXISTS name VARCHAR NOT NULL DEFAULT '';
    ALTER TABLE library_collections ADD COLUMN IF NOT EXISTS key VARCHAR NOT NULL DEFAULT '';
  `);
}

export async function truncateLibraryGraphForTests(): Promise<void> {
  const p = getSharedPool();
  await p.query('TRUNCATE library_variables');
  await p.query('TRUNCATE library_collections');
}

export async function replaceLibrary(userId: string, fileKey: string, vars: GraphVar[], colls: GraphColl[]): Promise<void> {
  const client = await getSharedPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM library_variables WHERE keycloak_user_id=$1 AND file_key=$2', [userId, fileKey]);
    await client.query('DELETE FROM library_collections WHERE keycloak_user_id=$1 AND file_key=$2', [userId, fileKey]);
    for (const v of vars) {
      await client.query(
        `INSERT INTO library_variables (keycloak_user_id, file_key, library_key, local_id, collection_id, values_by_mode, name, resolved_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (keycloak_user_id, file_key, local_id) DO UPDATE
           SET library_key=EXCLUDED.library_key, collection_id=EXCLUDED.collection_id, values_by_mode=EXCLUDED.values_by_mode, name=EXCLUDED.name, resolved_type=EXCLUDED.resolved_type`,
        [userId, fileKey, v.library_key, v.local_id, v.collection_id, JSON.stringify(v.values_by_mode), v.name, v.resolved_type],
      );
    }
    for (const c of colls) {
      await client.query(
        `INSERT INTO library_collections (keycloak_user_id, file_key, collection_id, default_mode, modes, name, key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (keycloak_user_id, file_key, collection_id) DO UPDATE SET default_mode=EXCLUDED.default_mode, modes=EXCLUDED.modes, name=EXCLUDED.name, key=EXCLUDED.key`,
        [userId, fileKey, c.collection_id, c.default_mode, JSON.stringify(c.modes), c.name ?? '', c.key ?? ''],
      );
    }
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch { /* dead */ } throw e; } finally { client.release(); }
}

type VarRow = { file_key: string; library_key: string; local_id: string; collection_id: string; values_by_mode: unknown; name: string };
type CollRow = { file_key: string; collection_id: string; default_mode: string; modes?: unknown; name?: string; key?: string };

/**
 * Pure row → buildGraphMaps-input mapping (one entry per row; no grouping, no DB).
 * Exported for unit testing without a DB — see tests/unit/library-graph-modes.test.ts.
 */
export function rowsToGraphInput(
  varRows: VarRow[],
  collRows: CollRow[],
): {
  vars: { library_key: string; local_id: string; collection_id: string; values_by_mode: Record<string, unknown>; name: string; fileKey: string }[];
  colls: { collection_id: string; default_mode: string; modes: { modeId: string; name: string }[]; name: string; key: string; fileKey: string }[];
} {
  return {
    vars: varRows.map((row) => ({
      library_key: row.library_key, local_id: row.local_id, collection_id: row.collection_id,
      values_by_mode: (row.values_by_mode ?? {}) as Record<string, unknown>, name: row.name, fileKey: row.file_key,
    })),
    colls: collRows.map((row) => ({
      collection_id: row.collection_id, default_mode: row.default_mode,
      modes: (row.modes ?? []) as { modeId: string; name: string }[], name: row.name ?? '', key: row.key ?? '', fileKey: row.file_key,
    })),
  };
}

export async function loadGraph(userId: string): Promise<LoadedGraph> {
  const p = getSharedPool();
  // ORDER BY: deterministic row order so buildGraphMaps' byKey "last write wins" winner is stable across re-syncs.
  const vr = await p.query('SELECT file_key, library_key, local_id, collection_id, values_by_mode, name FROM library_variables WHERE keycloak_user_id=$1 ORDER BY file_key, local_id', [userId]);
  const cr = await p.query('SELECT file_key, collection_id, default_mode, modes, name, key FROM library_collections WHERE keycloak_user_id=$1 ORDER BY file_key, collection_id', [userId]);
  const { vars, colls } = rowsToGraphInput(vr.rows, cr.rows);
  return buildGraphMaps(vars, colls);
}

/** Global (no user filter, by design) read-only aggregate of the library graph, for
 *  `framefit status`. READS ONLY - a missing relation must surface as a Postgres error naming it. */
export async function graphStats(): Promise<GraphStats> {
  const { rows: [f] } = await getSharedPool().query(`
    SELECT COUNT(*)::int AS libraries, MIN(last_synced_at) AS oldest, MAX(last_synced_at) AS newest,
           EXTRACT(EPOCH FROM now() - MIN(last_synced_at))::int AS oldest_age_sec
    FROM library_files`);
  const { rows: [v] } = await getSharedPool().query('SELECT COUNT(*)::int AS variables FROM library_variables');
  // DISTINCT team_id, not a bare row count: two users registering the SAME team_id is one team, not
  // two - COUNT(*) over registered_teams counts (user, team) registrations, which overstates it.
  const { rows: [t] } = await getSharedPool().query('SELECT COUNT(DISTINCT team_id)::int AS teams FROM registered_teams');
  // Global counts can look healthy on the orphan rows of a departed user while the only ACTIVE
  // account resolves nothing: nothing deletes library_files on user deletion (library-registry-db.ts:59).
  // Joined on (user, team), not user alone: a user who synced only SOME of several registered teams
  // still has a per-team gap for the rest, invisible to a join that only checks "does this user have
  // *a* library anywhere" (their one synced team would mask every other team's gap).
  const { rows: empty } = await getSharedPool().query(`
    SELECT DISTINCT keycloak_user_id FROM (
      SELECT rt.keycloak_user_id, rt.team_id
      FROM registered_teams rt
      LEFT JOIN library_files lf
        ON lf.keycloak_user_id = rt.keycloak_user_id AND lf.team_id = rt.team_id
      GROUP BY rt.keycloak_user_id, rt.team_id
      HAVING COUNT(lf.file_key) = 0
    ) gaps
    ORDER BY keycloak_user_id`);
  return {
    libraries: f.libraries, variables: v.variables, teams: t.teams,
    users_with_teams_and_no_libraries: empty.map((r) => r.keycloak_user_id),
    oldest_synced_at: f.oldest ? new Date(f.oldest).toISOString() : null,
    oldest_age_sec: f.oldest_age_sec ?? null,
    newest_synced_at: f.newest ? new Date(f.newest).toISOString() : null,
  };
}
