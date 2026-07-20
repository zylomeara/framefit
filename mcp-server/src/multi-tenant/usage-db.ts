// mcp-server/src/multi-tenant/usage-db.ts
import type { Logger } from '../infrastructure/logger.js';
import { getSharedPool } from './db.js';
import { shapeUsage, type UsageSummaryRow, type UsageRawRow } from './usage-shape.js';

export async function ensureUsageSchema(): Promise<void> {
  await getSharedPool().query(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      keycloak_user_id VARCHAR NOT NULL,
      token_label      VARCHAR NOT NULL,
      day              DATE NOT NULL,
      count            BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (keycloak_user_id, token_label, day)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_day ON usage_counters (keycloak_user_id, day DESC);
  `);
}

export async function recordUsage(userId: string, label: string): Promise<void> {
  await getSharedPool().query(
    `INSERT INTO usage_counters (keycloak_user_id, token_label, day, count)
     VALUES ($1, $2, CURRENT_DATE, 1)
     ON CONFLICT (keycloak_user_id, token_label, day)
     DO UPDATE SET count = usage_counters.count + 1`,
    [userId, label],
  );
}

export async function getUsageSummary(userId: string, days = 7): Promise<UsageSummaryRow[]> {
  const p = getSharedPool();
  const todayRes = await p.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today");
  const today = todayRes.rows[0].today as string;
  const rowsRes = await p.query(
    `SELECT token_label, to_char(day, 'YYYY-MM-DD') AS day, count::int AS count
     FROM usage_counters
     WHERE keycloak_user_id = $1 AND day > CURRENT_DATE - $2::int`,
    [userId, days],
  );
  return shapeUsage(rowsRes.rows as UsageRawRow[], today, days);
}

export async function deleteOldUsage(days: number): Promise<number> {
  const r = await getSharedPool().query(
    "DELETE FROM usage_counters WHERE day < CURRENT_DATE - ($1 || ' days')::interval",
    [String(days)],
  );
  return r.rowCount ?? 0;
}

/** Test-only helper. */
export async function truncateUsageForTests(): Promise<void> {
  await getSharedPool().query('TRUNCATE usage_counters');
}

const DAY_MS = 24 * 60 * 60 * 1000;
export interface UsageRetentionDeps {
  logger: Logger;
  retentionDays?: number;
  intervalMs?: number;
  deleteOld?: (days: number) => Promise<number>;
}
export function startUsageRetention(deps: UsageRetentionDeps): () => void {
  const intervalMs = deps.intervalMs ?? DAY_MS;
  const days = deps.retentionDays ?? 90;
  const del = deps.deleteOld ?? deleteOldUsage;
  const run = async (): Promise<void> => {
    try {
      const deleted = await del(days);
      deps.logger.info({ deleted, days }, 'usage.retention');
    } catch (err) {
      deps.logger.error({ err: (err as Error).message }, 'usage.retention_failed');
    }
  };
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
