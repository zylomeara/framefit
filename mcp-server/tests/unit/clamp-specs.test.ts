import { describe, it, expect } from 'vitest';
import { clampSpecsToBudget } from '../../src/adapters/driving/tools/clamp-specs.js';

const entry = (node_id: string, fill: number) => ({ node_id, spec: { blob: 'x'.repeat(fill) } });

describe('clampSpecsToBudget', () => {
  it('keeps all when under budget', () => {
    const specs = [entry('a', 10), entry('b', 10)];
    const r = clampSpecsToBudget(specs, 1_000_000);
    expect(r.kept).toHaveLength(2);
    expect(r.omitted).toEqual([]);
  });

  it('prefix-keeps, suffix-omits the tail node_ids by order', () => {
    const specs = [entry('a', 400), entry('b', 400), entry('c', 400)];
    const r = clampSpecsToBudget(specs, 500); // compact: a (434B) fits, a+b (868) exceeds 500
    expect(r.kept.map((k) => k.node_id)).toEqual(['a']);
    expect(r.omitted).toEqual(['b', 'c']);
  });

  it('once omitting starts, everything after is omitted (contiguous suffix)', () => {
    const specs = [entry('a', 400), entry('big', 5000), entry('small', 1)];
    const r = clampSpecsToBudget(specs, 900);
    expect(r.kept.map((k) => k.node_id)).toEqual(['a']);
    expect(r.omitted).toEqual(['big', 'small']); // 'small' NOT re-admitted after the big skip
  });

  it('always keeps the first entry even if it alone exceeds budget', () => {
    const specs = [entry('a', 5000), entry('b', 1)];
    const r = clampSpecsToBudget(specs, 100);
    expect(r.kept.map((k) => k.node_id)).toEqual(['a']);
    expect(r.omitted).toEqual(['b']);
  });

  it('measures the DELIVERED serialization (compact by default), not pretty (anti-desync lock)', () => {
    // Nested spec — the compact/pretty gap comes from nesting/newlines, not long strings.
    const nested = (id: string) => ({
      node_id: id,
      spec: {
        node: 'Frame', rect: { x: 0, y: 0, w: 300, h: 600 },
        layout: { mode: 'VERTICAL', gap: 8, pad: { t: 16, r: 16, b: 16, l: 16 } },
        children: Array.from({ length: 30 }, (_, i) => ({
          id: `c${i}`, name: `Item ${i}`, type: 'TEXT', rect: { x: 0, y: i * 20, w: 300, h: 20 },
          text: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400, lineHeight: 20, letterSpacing: 0, color: '#111', align: 'left', valign: 'top' },
          textSnippet: 'some snippet text here', children: [],
        })),
      },
    });
    const a = nested('a'), b = nested('b');
    const compactSum = JSON.stringify(a).length + JSON.stringify(b).length;                 // measured ≈ 16772
    const prettySum = JSON.stringify(a, null, 2).length + JSON.stringify(b, null, 2).length; // measured ≈ 31840
    const budget = compactSum + 100;                                                         // ≈ 16872

    // Prove the budget genuinely distinguishes the two measurements (not vacuous):
    expect(compactSum).toBeLessThanOrEqual(budget);   // COMPACT (delivered) → keeps BOTH
    expect(prettySum).toBeGreaterThan(budget);        // a PRETTY measurement (the drift) → keeps ONE

    const r = clampSpecsToBudget([a, b], budget);
    expect(r.kept.map((k) => k.node_id)).toEqual(['a', 'b']); // compact behavior; pretty would give ['a']
    expect(r.omitted).toEqual([]);
  });
});
