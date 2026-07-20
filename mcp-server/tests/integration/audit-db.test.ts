import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb } from '../../src/multi-tenant/db.js';
import {
  ensureAuditSchema, truncateAuditForTests,
  recordAuditEvent, listAuditEvents, deleteOldAuditEvents,
} from '../../src/multi-tenant/audit-db.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('audit db', () => {
  beforeAll(async () => { initDb(url!); await ensureAuditSchema(); });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => { await truncateAuditForTests(); });

  it('records and lists per-user, newest first, scoped by user', async () => {
    await recordAuditEvent('u1', { action: 'token.add', target: 'work', outcome: 'success', meta: { figma_handle: 'anna' } });
    await recordAuditEvent('u1', { action: 'token.remove', target: 'old', outcome: 'success' });
    await recordAuditEvent('u2', { action: 'team.add', target: '139', outcome: 'success' });

    const u1 = await listAuditEvents('u1', { limit: 50 });
    expect(u1).toHaveLength(2);
    expect(u1[0].action).toBe('token.remove');
    expect(u1[1].action).toBe('token.add');
    expect(u1[1].target).toBe('work');

    const u2 = await listAuditEvents('u2', { limit: 50 });
    expect(u2).toHaveLength(1);
    expect(u2[0].action).toBe('team.add');
  });

  it('limit caps the result set', async () => {
    for (let i = 0; i < 5; i++) await recordAuditEvent('u1', { action: 'sync.start', target: null, outcome: 'success' });
    expect(await listAuditEvents('u1', { limit: 3 })).toHaveLength(3);
  });

  it('deleteOldAuditEvents prunes rows older than N days', async () => {
    await recordAuditEvent('u1', { action: 'token.add', target: 'keep', outcome: 'success' });
    const { getSharedPool } = await import('../../src/multi-tenant/db.js');
    await getSharedPool().query("INSERT INTO audit_log (keycloak_user_id, action, target, outcome, created_at) VALUES ('u1','old',NULL,'success', NOW() - INTERVAL '100 days')");
    const deleted = await deleteOldAuditEvents(90);
    expect(deleted).toBe(1);
    const rows = await listAuditEvents('u1', { limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe('keep');
  });
});
