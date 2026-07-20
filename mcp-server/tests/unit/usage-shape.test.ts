import { describe, it, expect } from 'vitest';
import { shapeUsage } from '../../src/multi-tenant/usage-shape.js';

describe('shapeUsage', () => {
  it('zero-fills a 7-day window ending at today, computes today + last7, sorted by last7 desc', () => {
    const rows = [
      { token_label: 'work', day: '2026-06-12', count: 5 },
      { token_label: 'work', day: '2026-06-10', count: 2 },
      { token_label: 'ci', day: '2026-06-12', count: 1 },
      { token_label: 'work', day: '2026-06-01', count: 99 },
    ];
    const out = shapeUsage(rows, '2026-06-12', 7);
    expect(out.map((r) => r.label)).toEqual(['work', 'ci']);
    const work = out.find((r) => r.label === 'work')!;
    expect(work.daily).toHaveLength(7);
    expect(work.daily[6]).toBe(5);
    expect(work.daily[4]).toBe(2);
    expect(work.today).toBe(5);
    expect(work.last7).toBe(7);
    const ci = out.find((r) => r.label === 'ci')!;
    expect(ci.today).toBe(1);
    expect(ci.last7).toBe(1);
  });

  it('returns [] for no rows', () => {
    expect(shapeUsage([], '2026-06-12', 7)).toEqual([]);
  });
});
