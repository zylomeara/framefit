import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb } from '../../src/multi-tenant/db.js';
import {
  ensureUsageSchema, truncateUsageForTests,
  recordUsage, getUsageSummary, deleteOldUsage,
} from '../../src/multi-tenant/usage-db.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('usage db', () => {
  beforeAll(async () => { initDb(url!); await ensureUsageSchema(); });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => { await truncateUsageForTests(); });

  it('recordUsage upserts today, incrementing on repeat; summary reflects today/last7', async () => {
    await recordUsage('u1', 'work');
    await recordUsage('u1', 'work');
    await recordUsage('u1', 'ci');
    const summary = await getUsageSummary('u1', 7);
    const work = summary.find((r) => r.label === 'work')!;
    expect(work.today).toBe(2);
    expect(work.last7).toBe(2);
    expect(work.daily).toHaveLength(7);
    expect(work.daily[6]).toBe(2);
    expect(summary.find((r) => r.label === 'ci')!.today).toBe(1);
  });

  it('summary is per-user', async () => {
    await recordUsage('u1', 'work');
    await recordUsage('u2', 'work');
    expect((await getUsageSummary('u2', 7)).find((r) => r.label === 'work')!.today).toBe(1);
    expect(await getUsageSummary('u3', 7)).toEqual([]);
  });

  it('deleteOldUsage prunes days older than N', async () => {
    await recordUsage('u1', 'work');
    const { getSharedPool } = await import('../../src/multi-tenant/db.js');
    await getSharedPool().query("INSERT INTO usage_counters (keycloak_user_id, token_label, day, count) VALUES ('u1','old', CURRENT_DATE - 100, 7)");
    const deleted = await deleteOldUsage(90);
    expect(deleted).toBe(1);
    const summary = await getUsageSummary('u1', 7);
    expect(summary.map((r) => r.label)).toEqual(['work']);
  });
});
