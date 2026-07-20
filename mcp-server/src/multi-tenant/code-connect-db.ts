// mcp-server/src/multi-tenant/code-connect-db.ts
// Per-user Code Connect mappings + CI keys. ensureCodeConnectSchema runs at MT
// boot alongside ensureSchema(). CI keys are stored as sha256 hashes (the
// plaintext fmcp_ci_… is shown once). Mappings are looked up by (file_key,node_id).
import { createHash, randomBytes } from 'crypto';
import type { StoredMapping, MappingHit } from '../domain/code-connect.js';
import { getSharedPool } from './db.js';

export type { MappingHit }; // re-export for callers that import it alongside the lookup

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function ensureCodeConnectSchema(): Promise<void> {
  const p = getSharedPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS ci_keys (
      id               SERIAL PRIMARY KEY,
      keycloak_user_id VARCHAR NOT NULL,
      label            VARCHAR NOT NULL,
      key_hash         VARCHAR NOT NULL UNIQUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ci_keys_user ON ci_keys (keycloak_user_id);

    CREATE TABLE IF NOT EXISTS code_connect_mappings (
      keycloak_user_id    VARCHAR NOT NULL,
      component_file_key  VARCHAR NOT NULL,
      component_node_id   VARCHAR NOT NULL,
      label               VARCHAR NOT NULL,
      component_name      VARCHAR NOT NULL DEFAULT '',
      source              TEXT NOT NULL DEFAULT '',
      template            TEXT NOT NULL DEFAULT '',
      template_data       JSONB NOT NULL DEFAULT '{}',
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (keycloak_user_id, component_file_key, component_node_id, label)
    );
  `);
}

/** Test-only helper; harmless in prod (never called there). */
export async function truncateCodeConnectForTests(): Promise<void> {
  const p = getSharedPool();
  await p.query('TRUNCATE ci_keys RESTART IDENTITY');
  await p.query('TRUNCATE code_connect_mappings');
}

export interface CiKeyRow { id: number; label: string; created_at: Date; last_used_at: Date | null }

export async function createCiKey(userId: string, label: string): Promise<{ id: number; plaintext: string }> {
  const plaintext = 'fmcp_ci_' + randomBytes(24).toString('hex');
  const result = await getSharedPool().query(
    'INSERT INTO ci_keys (keycloak_user_id, label, key_hash) VALUES ($1, $2, $3) RETURNING id',
    [userId, label, hashKey(plaintext)],
  );
  return { id: result.rows[0].id, plaintext };
}

export async function listCiKeys(userId: string): Promise<CiKeyRow[]> {
  const result = await getSharedPool().query(
    'SELECT id, label, created_at, last_used_at FROM ci_keys WHERE keycloak_user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return result.rows;
}

export async function revokeCiKey(userId: string, id: number): Promise<boolean> {
  const result = await getSharedPool().query(
    'DELETE FROM ci_keys WHERE keycloak_user_id = $1 AND id = $2',
    [userId, id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function resolveCiKey(plaintext: string): Promise<string | null> {
  const result = await getSharedPool().query(
    'UPDATE ci_keys SET last_used_at = NOW() WHERE key_hash = $1 RETURNING keycloak_user_id',
    [hashKey(plaintext)],
  );
  return result.rows[0]?.keycloak_user_id ?? null;
}

export async function replaceMappings(userId: string, mappings: StoredMapping[]): Promise<void> {
  const p = getSharedPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM code_connect_mappings WHERE keycloak_user_id = $1', [userId]);
    for (const m of mappings) {
      await client.query(
        `INSERT INTO code_connect_mappings
           (keycloak_user_id, component_file_key, component_node_id, label, component_name, source, template, template_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (keycloak_user_id, component_file_key, component_node_id, label) DO UPDATE
           SET component_name = EXCLUDED.component_name, source = EXCLUDED.source,
               template = EXCLUDED.template, template_data = EXCLUDED.template_data, updated_at = NOW()`,
        [userId, m.component_file_key, m.component_node_id, m.label, m.component_name, m.source, m.template, JSON.stringify(m.template_data)],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead after a failed COMMIT */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function lookupMappings(
  userId: string,
  refs: { file_key: string; node_id: string }[],
): Promise<Map<string, MappingHit>> {
  const out = new Map<string, MappingHit>();
  if (refs.length === 0) return out;
  const fileKeys = [...new Set(refs.map((r) => r.file_key))];
  const nodeIds = [...new Set(refs.map((r) => r.node_id))];
  const result = await getSharedPool().query(
    `SELECT component_file_key, component_node_id, label, component_name, source, template, template_data
     FROM code_connect_mappings
     WHERE keycloak_user_id = $1 AND component_file_key = ANY($2) AND component_node_id = ANY($3)
     ORDER BY component_file_key, component_node_id, label`,
    [userId, fileKeys, nodeIds],
  );
  // The SQL uses ANY(fileKeys) × ANY(nodeIds), which overfetches cross pairs
  // (a file_key from one ref combined with a node_id from another). Keep only the
  // exact (file_key,node_id) pairs that were actually requested.
  const wanted = new Set(refs.map((r) => `${r.file_key}|${r.node_id}`));
  for (const row of result.rows) {
    const key = `${row.component_file_key}|${row.component_node_id}`;
    if (!wanted.has(key)) continue;
    // A component may have multiple label rows (React, Vue, …) for one node. We
    // surface one snippet per node; ORDER BY label + keep-first makes the choice
    // deterministic (first label alphabetically). Full multi-label output is deferred.
    if (out.has(key)) continue;
    out.set(key, {
      component_name: row.component_name, source: row.source, template: row.template,
      template_data: row.template_data, label: row.label,
    });
  }
  return out;
}
