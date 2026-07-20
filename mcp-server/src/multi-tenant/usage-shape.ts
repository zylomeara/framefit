// mcp-server/src/multi-tenant/usage-shape.ts
export interface UsageRawRow { token_label: string; day: string; count: number; }
export interface UsageSummaryRow { label: string; today: number; last7: number; daily: number[]; }

/** Shape raw (label, day 'YYYY-MM-DD', count) rows into per-token summaries with a
 *  zero-filled `daily` array (oldest→newest, length `days`) ending at `today`. Sorted by last7 desc. */
export function shapeUsage(rows: UsageRawRow[], today: string, days: number): UsageSummaryRow[] {
  const window: string[] = [];
  const base = new Date(`${today}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    window.push(d.toISOString().slice(0, 10));
  }
  const idx = new Map(window.map((s, i) => [s, i] as const));
  const byLabel = new Map<string, number[]>();
  for (const r of rows) {
    const i = idx.get(r.day);
    if (i === undefined) continue;
    let daily = byLabel.get(r.token_label);
    if (!daily) { daily = new Array(days).fill(0); byLabel.set(r.token_label, daily); }
    daily[i] += r.count;
  }
  const out: UsageSummaryRow[] = [];
  for (const [label, daily] of byLabel) {
    out.push({ label, today: daily[days - 1], last7: daily.reduce((a, b) => a + b, 0), daily });
  }
  out.sort((a, b) => b.last7 - a.last7);
  return out;
}
