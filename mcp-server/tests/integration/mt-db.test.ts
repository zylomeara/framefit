import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  initDb, closeDb, ensureSchema, pingDb, truncateForTests,
  listTokens, addToken, removeToken, setDefaultToken,
  getDefaultPat, getTokenWithPat, updateValidation, listAllTokensForValidation,
} from '../../src/multi-tenant/db.js';

const KEY = 'c'.repeat(64);
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('multi-tenant db', () => {
  beforeAll(async () => {
    initDb(url!);
    await ensureSchema();
  });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => { await truncateForTests(); });

  it('pingDb works after init', async () => {
    await expect(pingDb()).resolves.toBeUndefined();
  });

  it('first token becomes default; list returns safe fields without PAT', async () => {
    const row = await addToken('u1', { label: 'work', pat: 'figd_AAAA1234', figmaHandle: 'testuser', scopes: ['file_content:read'], expiresAt: '2026-09-01' }, KEY);
    expect(row.is_default).toBe(true);
    expect(row.pat_suffix).toBe('1234');

    const list = await listTokens('u1');
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('figd_');
    expect(list[0].expires_at).toBe('2026-09-01');
  });

  it('addToken stamps last_validated_at when the caller passes validatedAt (the portal already validated the PAT)', async () => {
    const before = Date.now();
    const row = await addToken('u1', { label: 'work', pat: 'figd_FRESH1234', figmaHandle: 'testuser', scopes: [], expiresAt: null, validatedAt: new Date() }, KEY);
    expect(row.last_validated_at).not.toBeNull();
    expect(new Date(row.last_validated_at!).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('addToken leaves last_validated_at null when validatedAt is not provided (unchanged pre-existing behaviour)', async () => {
    const row = await addToken('u1', { label: 'work', pat: 'figd_NOVALIDATE', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    expect(row.last_validated_at).toBeNull();
  });

  it('getDefaultPat decrypts; isolated per user', async () => {
    await addToken('u1', { label: 'work', pat: 'figd_USER1', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    await addToken('u2', { label: 'work', pat: 'figd_USER2', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    expect((await getDefaultPat('u1', KEY))?.pat).toBe('figd_USER1');
    expect((await getDefaultPat('u2', KEY))?.pat).toBe('figd_USER2');
    expect(await getDefaultPat('nobody', KEY)).toBeNull();
  });

  it('duplicate label for same user violates unique constraint (23505)', async () => {
    await addToken('u1', { label: 'work', pat: 'figd_A', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    await expect(
      addToken('u1', { label: 'work', pat: 'figd_B', figmaHandle: null, scopes: [], expiresAt: null }, KEY),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('setDefaultToken switches default atomically', async () => {
    await addToken('u1', { label: 'a', pat: 'figd_A', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    await addToken('u1', { label: 'b', pat: 'figd_B', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    expect(await setDefaultToken('u1', 'b')).toBe(true);
    const list = await listTokens('u1');
    expect(list.find((t) => t.label === 'b')?.is_default).toBe(true);
    expect(list.find((t) => t.label === 'a')?.is_default).toBe(false);
  });

  it('removeToken deletes; getTokenWithPat returns decrypted pat', async () => {
    await addToken('u1', { label: 'a', pat: 'figd_A', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    const got = await getTokenWithPat('u1', 'a', KEY);
    expect(got?.pat).toBe('figd_A');
    expect(await removeToken('u1', 'a')).toBe(true);
    expect(await getTokenWithPat('u1', 'a', KEY)).toBeNull();
  });

  it('updateValidation + listAllTokensForValidation drive the nightly job', async () => {
    const row = await addToken('u1', { label: 'a', pat: 'figd_A', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    const all = await listAllTokensForValidation();
    expect(all.map((t) => t.id)).toContain(row.id);
    await updateValidation(row.id, 'invalid', 'u1');
    const list = await listTokens('u1');
    expect(list[0].status).toBe('invalid');
    expect(list[0].last_validated_at).not.toBeNull();
  });

  it('setDefaultToken with unknown label keeps the current default (rolls back)', async () => {
    await addToken('u1', { label: 'a', pat: 'figd_A', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    expect(await setDefaultToken('u1', 'NOPE')).toBe(false);
    expect((await getDefaultPat('u1', KEY))?.label).toBe('a'); // default survived
  });

  it('db enforces single default per user (partial unique index)', async () => {
    await addToken('u1', { label: 'a', pat: 'figd_A', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    await addToken('u1', { label: 'b', pat: 'figd_B', figmaHandle: null, scopes: [], expiresAt: null }, KEY);
    // Switch default twice to different labels; only one default must survive each time
    expect(await setDefaultToken('u1', 'b')).toBe(true);
    const list1 = await listTokens('u1');
    expect(list1.filter((t) => t.is_default)).toHaveLength(1);
    expect(list1.find((t) => t.label === 'b')?.is_default).toBe(true);

    expect(await setDefaultToken('u1', 'a')).toBe(true);
    const list2 = await listTokens('u1');
    expect(list2.filter((t) => t.is_default)).toHaveLength(1);
    expect(list2.find((t) => t.label === 'a')?.is_default).toBe(true);
  });
});
