import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, ensureSchema, getSharedPool, getUserSettings, setReadOnly } from '../../src/multi-tenant/db.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('multi-tenant user_settings', () => {
  beforeAll(async () => { initDb(url!); await ensureSchema(); });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => { await getSharedPool().query('TRUNCATE user_settings'); });

  it('defaults to read_only=true for an unknown user (no row)', async () => {
    expect((await getUserSettings('newbie')).read_only).toBe(true);
  });
  it('setReadOnly(false) upserts and persists; getUserSettings reflects it', async () => {
    await setReadOnly('u1', false);
    expect((await getUserSettings('u1')).read_only).toBe(false);
    await setReadOnly('u1', true);
    expect((await getUserSettings('u1')).read_only).toBe(true);
  });
  it('is isolated per user', async () => {
    await setReadOnly('u1', false);
    expect((await getUserSettings('u1')).read_only).toBe(false);
    expect((await getUserSettings('u2')).read_only).toBe(true);
  });
});
