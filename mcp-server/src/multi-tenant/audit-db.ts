// mcp-server/src/multi-tenant/audit-db.ts
import type { Logger } from '../infrastructure/logger.js';
import { getSharedPool } from './db.js';

export interface AuditEntry {
  action: string;
  target: string | null;
  outcome: string;
  meta?: Record<string, unknown>;
}

export interface AuditEventRow {
  id: number;
  action: string;
  target: string | null;
  outcome: string;
  created_at: Date;
}

export async function ensureAuditSchema(): Promise<void> {
  await getSharedPool().query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id               SERIAL PRIMARY KEY,
      keycloak_user_id VARCHAR NOT NULL,
      action           VARCHAR NOT NULL,
      target           VARCHAR,
      outcome          VARCHAR NOT NULL,
      meta             JSONB NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (keycloak_user_id, created_at DESC);
  `);
}

export async function recordAuditEvent(userId: string, entry: AuditEntry): Promise<void> {
  await getSharedPool().query(
    'INSERT INTO audit_log (keycloak_user_id, action, target, outcome, meta) VALUES ($1,$2,$3,$4,$5)',
    [userId, entry.action, entry.target, entry.outcome, JSON.stringify(entry.meta ?? {})],
  );
}

export async function listAuditEvents(userId: string, opts: { limit: number }): Promise<AuditEventRow[]> {
  const r = await getSharedPool().query(
    'SELECT id, action, target, outcome, created_at FROM audit_log WHERE keycloak_user_id=$1 ORDER BY created_at DESC LIMIT $2',
    [userId, opts.limit],
  );
  return r.rows as AuditEventRow[];
}

export async function deleteOldAuditEvents(days: number): Promise<number> {
  const r = await getSharedPool().query(
    "DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::interval",
    [String(days)],
  );
  return r.rowCount ?? 0;
}

/** Test-only helper; harmless in prod (never called there). */
export async function truncateAuditForTests(): Promise<void> {
  await getSharedPool().query('TRUNCATE audit_log RESTART IDENTITY');
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuditRetentionDeps {
  logger: Logger;
  retentionDays?: number;
  intervalMs?: number;
  deleteOld?: (days: number) => Promise<number>;
}

/** Daily cron that prunes audit_log older than retentionDays (default 90). Mirrors startNightlyValidation. */
export function startAuditRetention(deps: AuditRetentionDeps): () => void {
  const intervalMs = deps.intervalMs ?? DAY_MS;
  const days = deps.retentionDays ?? 90;
  const del = deps.deleteOld ?? deleteOldAuditEvents;
  const run = async (): Promise<void> => {
    try {
      const deleted = await del(days);
      deps.logger.info({ deleted, days }, 'audit.retention');
    } catch (err) {
      deps.logger.error({ err: (err as Error).message }, 'audit.retention_failed');
    }
  };
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
