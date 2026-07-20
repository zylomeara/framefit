import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb } from '../../src/multi-tenant/db.js';
import { ensureVariableSnapshotSchema, truncateVariableSnapshotForTests, replaceSnapshot, lookupSnapshot } from '../../src/multi-tenant/variable-snapshot-db.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('variable-snapshot db', () => {
  beforeAll(async () => { initDb(url!); await ensureVariableSnapshotSchema(); });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => { await truncateVariableSnapshotForTests(); });

  it('replace then lookup by library_key for the owner', async () => {
    await replaceSnapshot('u1', 'LIB', [{ key: 'b2b2c4d6', value: '#ff0000', resolved_type: 'COLOR', name: 'bg' }]);
    const m = await lookupSnapshot('u1', ['b2b2c4d6', '99999999']);
    expect(m.get('b2b2c4d6')?.value).toBe('#ff0000');
    expect(m.has('99999999')).toBe(false);
  });
  it('full per-(user,library) replace is idempotent', async () => {
    await replaceSnapshot('u1', 'LIB', [{ key: 'aaaa1111', value: '#000', resolved_type: 'COLOR', name: 'a' }]);
    await replaceSnapshot('u1', 'LIB', [{ key: 'bbbb2222', value: '#fff', resolved_type: 'COLOR', name: 'b' }]);
    const m = await lookupSnapshot('u1', ['aaaa1111', 'bbbb2222']);
    expect(m.has('aaaa1111')).toBe(false);
    expect(m.get('bbbb2222')?.value).toBe('#fff');
  });
  it('snapshots are per-user isolated', async () => {
    await replaceSnapshot('u1', 'LIB', [{ key: 'aaaa1111', value: '#000', resolved_type: 'COLOR', name: 'a' }]);
    expect((await lookupSnapshot('u2', ['aaaa1111'])).size).toBe(0);
  });
  it('replace of one library does not wipe another library of the same user', async () => {
    await replaceSnapshot('u1', 'LIBA', [{ key: 'aaaa1111', value: '#000', resolved_type: 'COLOR', name: 'a' }]);
    await replaceSnapshot('u1', 'LIBB', [{ key: 'bbbb2222', value: '#fff', resolved_type: 'COLOR', name: 'b' }]);
    const m = await lookupSnapshot('u1', ['aaaa1111', 'bbbb2222']);
    expect(m.size).toBe(2);
  });
});
