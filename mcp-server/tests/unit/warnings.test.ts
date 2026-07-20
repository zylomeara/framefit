import { describe, it, expect } from 'vitest';
import { computeWarnings } from '../../src/application/get-comments.js';

const B = 40000;

describe('computeWarnings', () => {
  it('no warnings for a small complete result', () => {
    expect(computeWarnings({ total_matching: 10, next_offset: null, payload_size: 1000, budget: B, clamped: false })).toEqual([]);
  });

  it('more_available when next_offset is set', () => {
    const w = computeWarnings({ total_matching: 100, next_offset: 50, payload_size: 1000, budget: B, clamped: false });
    expect(w.map((x) => x.code)).toContain('more_available');
  });

  it('broad_filter when total_matching > 500', () => {
    const w = computeWarnings({ total_matching: 870, next_offset: null, payload_size: 1000, budget: B, clamped: false });
    expect(w.map((x) => x.code)).toContain('broad_filter');
  });

  it('large_result when payload exceeds 75% of budget and not clamped', () => {
    const w = computeWarnings({ total_matching: 10, next_offset: null, payload_size: 35_000, budget: B, clamped: false });
    expect(w.map((x) => x.code)).toContain('large_result');
  });

  it('auto_clamped when clamped, and NOT large_result', () => {
    const w = computeWarnings({ total_matching: 10, next_offset: null, payload_size: 39_000, budget: B, clamped: true });
    const codes = w.map((x) => x.code);
    expect(codes).toContain('auto_clamped');
    expect(codes).not.toContain('large_result');
  });

  it('combines more_available + broad_filter + auto_clamped', () => {
    const w = computeWarnings({ total_matching: 870, next_offset: 200, payload_size: 39_000, budget: B, clamped: true });
    expect(w.map((x) => x.code).sort()).toEqual(['auto_clamped', 'broad_filter', 'more_available']);
  });
});
