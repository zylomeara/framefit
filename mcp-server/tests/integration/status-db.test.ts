import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getSharedPool, ensureSchema, tokenStats } from '../../src/multi-tenant/db.js';
import { ensureLibraryRegistrySchema } from '../../src/multi-tenant/library-registry-db.js';
import { ensureLibraryGraphSchema, graphStats } from '../../src/multi-tenant/library-graph-db.js';

// TEST_DATABASE_URL, never DATABASE_URL: that is the production variable name, CI sets only this
// one (ci.yml:54), and every neighbouring integration file uses it.
const url = process.env.TEST_DATABASE_URL;
const q = (sql: string, params: unknown[] = []) => getSharedPool().query(sql, params);

describe.skipIf(!url)('status SQL helpers', () => {
  beforeAll(async () => {
    initDb(url!);
    await ensureSchema(); await ensureLibraryRegistrySchema(); await ensureLibraryGraphSchema();
    await q("DELETE FROM figma_tokens WHERE keycloak_user_id LIKE 'st-%'");
    await q("DELETE FROM library_files WHERE keycloak_user_id LIKE 'st-%'");
    await q("DELETE FROM library_variables WHERE keycloak_user_id LIKE 'st-%'");
    await q("DELETE FROM registered_teams WHERE keycloak_user_id LIKE 'st-%'");
    await q(`INSERT INTO figma_tokens (keycloak_user_id, label, encrypted_pat, pat_suffix, status, is_default, last_validated_at, expires_at)
             VALUES ('st-ok','default','x','abcd','active',true, now() - interval '1 hour', CURRENT_DATE + 30)`);
    await q(`INSERT INTO figma_tokens (keycloak_user_id, label, encrypted_pat, pat_suffix, status, is_default)
             VALUES ('st-nodefault','ci','x','efgh','active',false)`);
    await q(`INSERT INTO figma_tokens (keycloak_user_id, label, encrypted_pat, pat_suffix, status, is_default, expires_at)
             VALUES ('st-expired','default','x','ijkl','active',true, CURRENT_DATE - 1)`);
    await q(`INSERT INTO figma_tokens (keycloak_user_id, label, encrypted_pat, pat_suffix, status, is_default)
             VALUES ('st-bad','default','x','mnop','invalid',true)`);
    await q(`INSERT INTO registered_teams (keycloak_user_id, team_id) VALUES ('st-ok','111'), ('st-empty','222')`);
    await q(`INSERT INTO library_files (keycloak_user_id, team_id, file_key, name, vars, last_synced_at)
             VALUES ('st-ok','111','st-fk1','DS',2, now() - interval '2 hours')`);
    await q(`INSERT INTO library_variables (keycloak_user_id, file_key, local_id, name, resolved_type)
             VALUES ('st-ok','st-fk1','1:1','color/bg','COLOR'), ('st-ok','st-fk1','1:2','color/fg','COLOR')`);
  });

  afterAll(async () => {
    await q("DELETE FROM figma_tokens WHERE keycloak_user_id LIKE 'st-%'");
    await q("DELETE FROM library_files WHERE keycloak_user_id LIKE 'st-%'");
    await q("DELETE FROM library_variables WHERE keycloak_user_id LIKE 'st-%'");
    await q("DELETE FROM registered_teams WHERE keycloak_user_id LIKE 'st-%'");
    await closeDb();
  });

  // These helpers aggregate GLOBALLY and other integration files truncate the same tables in
  // parallel, so assert only membership and lower bounds - never an exact global count.
  it('names users who hold tokens but no default', async () => {
    expect((await tokenStats()).users_without_default).toContain('st-nodefault');
  });

  it('classifies an expired default PAT and an invalid one', async () => {
    const s = await tokenStats();
    expect(s.bad_defaults).toContainEqual(expect.objectContaining({ user: 'st-expired', problem: 'expired' }));
    expect(s.bad_defaults).toContainEqual(expect.objectContaining({ user: 'st-bad', problem: 'invalid' }));
  });

  it('returns expires_at as a calendar date string, not a shifted timestamp', async () => {
    const s = await tokenStats();
    const expired = s.bad_defaults.find((b) => b.user === 'st-expired')!;
    expect(expired.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('computes validation age in SQL from the database clock', async () => {
    const s = await tokenStats();
    expect(s.validation_age_sec).not.toBeNull();
    expect(s.validation_age_sec!).toBeGreaterThanOrEqual(0);
  });

  it('counts libraries and variables and names users with teams but no libraries', async () => {
    const g = await graphStats();
    expect(g.libraries).toBeGreaterThanOrEqual(1);
    expect(g.variables).toBeGreaterThanOrEqual(2);
    expect(g.teams).toBeGreaterThanOrEqual(2);
    expect(g.users_with_teams_and_no_libraries).toContain('st-empty');
    expect(g.oldest_age_sec!).toBeGreaterThanOrEqual(0);
  });
});

// Proof that status READS only. Isolated in its own schema so no shared table is ever dropped:
// the helpers resolve unqualified names through search_path, so an empty schema makes every table
// "missing" without touching the real ones.
describe.skipIf(!url)('status SQL helpers never create anything', () => {
  const probeUrl = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c search_path=status_probe')}`;

  beforeAll(async () => {
    initDb(url!);
    await q('CREATE SCHEMA IF NOT EXISTS status_probe');
    await closeDb();
    initDb(probeUrl);
  });

  afterAll(async () => {
    await closeDb();
    initDb(url!);
    await q('DROP SCHEMA IF EXISTS status_probe CASCADE');
    await closeDb();
  });

  it('errors on a missing relation and creates nothing', async () => {
    await expect(tokenStats()).rejects.toThrow(/figma_tokens/);
    await expect(graphStats()).rejects.toThrow(/library_/);
    for (const t of ['figma_tokens', 'library_files', 'library_variables', 'registered_teams']) {
      const { rows } = await q(`SELECT to_regclass('status_probe.${t}') AS t`);
      expect(rows[0].t).toBeNull();
    }
  });
});
