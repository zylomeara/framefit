import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb } from '../../src/multi-tenant/db.js';
import { ensureLibraryGraphSchema, truncateLibraryGraphForTests, replaceLibrary, loadGraph } from '../../src/multi-tenant/library-graph-db.js';
import { resolveKey } from '../../src/domain/variable-graph.js';

const url = process.env.TEST_DATABASE_URL;
const K = 'k'.repeat(40);
describe.skipIf(!url)('library-graph-db', () => {
  beforeAll(async () => { initDb(url!); await ensureLibraryGraphSchema(); });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => { await truncateLibraryGraphForTests(); });

  it('replaceLibrary + loadGraph round-trips byKey/byLocal/collDefaultMode', async () => {
    await replaceLibrary('u1', 'LIB', [
      { library_key: K, local_id: 'VariableID:1:2', collection_id: 'C', values_by_mode: { m: { r: 1, g: 1, b: 1, a: 1 } }, name: 'bg', resolved_type: 'COLOR' },
    ], [{ collection_id: 'C', default_mode: 'm', modes: [{ modeId: 'm', name: 'Light' }] }]);
    const g = await loadGraph('u1');
    expect(g.byKey.get(K)?.name).toBe('bg');
    expect(g.byKey.get(K)?.fileKey).toBe('LIB');
    expect(g.byLocal.get('LIB|VariableID:1:2')?.collectionId).toBe('C');
    expect(g.collDefaultMode.get('LIB|C')).toBe('m');
    expect(g.byKey.get(K)?.valuesByMode).toEqual({ m: { r: 1, g: 1, b: 1, a: 1 } });
  });
  it('keys default mode per file_key — two files sharing collection_id resolve independently', async () => {
    const KA = 'a'.repeat(40), KB = 'b'.repeat(40);
    await replaceLibrary('u1', 'FILE_A',
      [{ library_key: KA, local_id: 'VariableID:1:1', collection_id: 'C', values_by_mode: { mLight: { r: 1, g: 1, b: 1, a: 1 }, mDark: { r: 0, g: 0, b: 0, a: 1 } }, name: 'bg', resolved_type: 'COLOR' }],
      [{ collection_id: 'C', default_mode: 'mLight', modes: [] }]);
    await replaceLibrary('u1', 'FILE_B',
      [{ library_key: KB, local_id: 'VariableID:1:1', collection_id: 'C', values_by_mode: { mLight: { r: 1, g: 1, b: 1, a: 1 }, mDark: { r: 0, g: 0, b: 0, a: 1 } }, name: 'bg', resolved_type: 'COLOR' }],
      [{ collection_id: 'C', default_mode: 'mDark', modes: [] }]);
    const g = await loadGraph('u1');
    expect(g.collDefaultMode.get('FILE_A|C')).toBe('mLight');
    expect(g.collDefaultMode.get('FILE_B|C')).toBe('mDark');
    expect(g.collDefaultMode.has('C')).toBe(false);
    expect(resolveKey(g, KA).value).toBe('#ffffff');
    expect(resolveKey(g, KB).value).toBe('#000000');
  });
  it('replaceLibrary replaces per (user,file_key); per-user isolation', async () => {
    await replaceLibrary('u1', 'LIB', [{ library_key: K, local_id: 'VariableID:1:1', collection_id: 'C', values_by_mode: { m: 1 }, name: 'a', resolved_type: 'FLOAT' }], []);
    await replaceLibrary('u1', 'LIB', [{ library_key: 'a'.repeat(40), local_id: 'VariableID:2:2', collection_id: 'C', values_by_mode: { m: 2 }, name: 'b', resolved_type: 'FLOAT' }], []);
    const g1 = await loadGraph('u1');
    expect(g1.byKey.has(K)).toBe(false);
    expect(g1.byKey.has('a'.repeat(40))).toBe(true);
    expect((await loadGraph('u2')).byKey.size).toBe(0);
  });
});
