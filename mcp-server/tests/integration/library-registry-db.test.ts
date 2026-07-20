import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb } from '../../src/multi-tenant/db.js';
import { ensureLibraryRegistrySchema, truncateRegistryForTests, addTeam, listTeams, removeTeam, setLibraries, listLibraries } from '../../src/multi-tenant/library-registry-db.js';
import { ensureLibraryGraphSchema, truncateLibraryGraphForTests, replaceLibrary, loadGraph } from '../../src/multi-tenant/library-graph-db.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('library-registry-db', () => {
  beforeAll(async () => { initDb(url!); await ensureLibraryRegistrySchema(); await ensureLibraryGraphSchema(); });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => { await truncateRegistryForTests(); await truncateLibraryGraphForTests(); });

  it('add/list/remove teams per user (addTeam idempotent)', async () => {
    await addTeam('u1', 'T1'); await addTeam('u1', 'T1');
    expect(await listTeams('u1')).toEqual(['T1']);
    expect(await listTeams('u2')).toEqual([]);
    await removeTeam('u1', 'T1');
    expect(await listTeams('u1')).toEqual([]);
  });
  it('setLibraries replaces per (user,team); listLibraries returns all for user', async () => {
    await addTeam('u1', 'T1');
    await setLibraries('u1', 'T1', [{ file_key: 'a', name: 'DS Colors', vars: 5 }]);
    await setLibraries('u1', 'T1', [{ file_key: 'b', name: 'DS Spacing', vars: 9 }]);
    const libs = await listLibraries('u1');
    expect(libs.map((l) => l.file_key)).toEqual(['b']);
    expect(libs[0].name).toBe('DS Spacing');
  });
  it('per-user isolation for libraries', async () => {
    await addTeam('u1', 'T1'); await setLibraries('u1', 'T1', [{ file_key: 'a', name: 'X', vars: 1 }]);
    expect(await listLibraries('u2')).toEqual([]);
  });

  it('removeTeam cascades graph rows (library_variables + library_collections) and does not affect other users', async () => {
    // --- seed user 1, team T1 ---
    await addTeam('u1', 'T1');
    await setLibraries('u1', 'T1', [{ file_key: 'fk1', name: 'DS Colors', vars: 1 }]);
    await replaceLibrary('u1', 'fk1', [
      { library_key: 'lib/color/brand', local_id: 'lid1', collection_id: 'coll1', values_by_mode: { mode1: '#fff' }, name: 'Brand', resolved_type: 'COLOR' },
    ], [
      { collection_id: 'coll1', default_mode: 'mode1', modes: ['mode1'] },
    ]);

    // --- seed user 2 (isolation) — separate team + graph rows ---
    await addTeam('u2', 'T2');
    await setLibraries('u2', 'T2', [{ file_key: 'fk2', name: 'DS Spacing', vars: 1 }]);
    await replaceLibrary('u2', 'fk2', [
      { library_key: 'lib/spacing/base', local_id: 'lid2', collection_id: 'coll2', values_by_mode: { mode1: 8 }, name: 'Base', resolved_type: 'FLOAT' },
    ], [
      { collection_id: 'coll2', default_mode: 'mode1', modes: ['mode1'] },
    ]);

    // --- remove u1/T1 ---
    await removeTeam('u1', 'T1');

    // registered_teams + library_files cleaned up
    expect(await listTeams('u1')).toEqual([]);
    expect(await listLibraries('u1')).toEqual([]);

    // graph rows for u1 must be gone
    const g1 = await loadGraph('u1');
    expect(g1.byKey.size).toBe(0);
    expect(g1.byLocal.size).toBe(0);

    // u2's graph rows must be untouched
    const g2 = await loadGraph('u2');
    expect(g2.byKey.size).toBe(1);
    expect(g2.byLocal.size).toBe(1);
    expect(await listTeams('u2')).toEqual(['T2']);
  });

  it('setLibraries preserve: shielded rows stay byte-identical; others evict; upserts run', async () => {
    await addTeam('u1', 'T1');
    await setLibraries('u1', 'T1', [{ file_key: 'keep', name: 'Old Keep', vars: 3 }, { file_key: 'drop', name: 'Old Drop', vars: 4 }]);
    const before = (await listLibraries('u1')).find((l) => l.file_key === 'keep')!;
    await setLibraries('u1', 'T1', [{ file_key: 'fresh', name: 'Fresh', vars: 7 }], ['keep']);
    const after = await listLibraries('u1');
    expect(after.map((l) => l.file_key).sort()).toEqual(['fresh', 'keep']);      // 'drop' evicted
    const kept = after.find((l) => l.file_key === 'keep')!;
    expect(kept.name).toBe('Old Keep');
    expect(kept.vars).toBe(3);
    expect(kept.last_synced_at?.toISOString()).toBe(before.last_synced_at?.toISOString());  // untouched
  });

  it("setLibraries preserve 'all': no eviction at all, upserts still run", async () => {
    await addTeam('u1', 'T1');
    await setLibraries('u1', 'T1', [{ file_key: 'a', name: 'A', vars: 1 }, { file_key: 'b', name: 'B', vars: 2 }]);
    await setLibraries('u1', 'T1', [{ file_key: 'a', name: 'A2', vars: 9 }], 'all');
    const libs = await listLibraries('u1');
    expect(libs.map((l) => l.file_key).sort()).toEqual(['a', 'b']);              // 'b' survived
    expect(libs.find((l) => l.file_key === 'a')!.name).toBe('A2');               // upsert applied
  });
});
