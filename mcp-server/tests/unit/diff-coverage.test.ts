import { describe, it, expect } from 'vitest';
import { deriveCoverage, NOT_COVERED_BY_TOOL, summarize, condenseBulkPass } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import type { DiffRow } from '../../src/domain/layout-spec/types.js';

describe('deriveCoverage', () => {
  it('measured = the axes of actually emitted non-skip rows, auto by prop', () => {
    const rows: DiffRow[] = [
      { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
      { prop: 'size.h', figma: 40, dom: 41, status: 'fail', delta: 1 },
      { prop: 'gap[0] a↔b', figma: 8, dom: 8, status: 'pass' },
      { prop: 'padding-left', figma: 16, dom: 16, status: 'pass' },
      { prop: 'font-size[title]', figma: 14, dom: 14, status: 'pass' },
      { prop: 'color[title]', figma: '#111', dom: '#111', status: 'pass' },
      { prop: 'corner-radius', figma: 8, dom: 8, status: 'pass' },
    ];
    const cov = deriveCoverage(rows);
    expect(cov.measured).toEqual(['border-radius', 'color', 'font-size', 'gap', 'padding', 'size']);
    expect(cov.skipped).toEqual([]);
  });

  it('skip rows → skipped with a reason; meta rows excluded', () => {
    const rows: DiffRow[] = [
      { prop: 'snapshot', figma: null, dom: 'ok', status: 'warn' }, // meta — not a dim
      { prop: 'geometry', status: 'skip', note: 'viewport ≠ frame' },
      { prop: 'typography[body]', status: 'skip', note: 'TEXT below the slice' },
    ];
    const cov = deriveCoverage(rows);
    expect(cov.measured).toEqual([]);
    expect(cov.skipped).toEqual([
      { dim: 'geometry', reason: 'viewport ≠ frame' },
      { dim: 'typography', reason: 'TEXT below the slice' },
    ]);
  });

  it('unchecked rows → skipped (not measured), like skip', () => {
    const cov = deriveCoverage([
      { prop: 'typography[body]', status: 'unchecked', note: 'below the slice' },
      { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
    ]);
    expect(cov.measured).toEqual(['size']);
    expect(cov.skipped.map((s) => s.dim)).toContain('typography');
  });

  it('component info → skipped (identity NOT measured), not measured', () => {
    const cov = deriveCoverage([
      { prop: 'component', figma: 'x', dom: 'y', status: 'info', note: 'no signal' },
      { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
    ]);
    expect(cov.measured).not.toContain('component');
    expect(cov.skipped).toEqual([{ dim: 'component', reason: 'component identity: signal absent' }]);
  });
  it('component warn/pass → measured (as before)', () => {
    const cov = deriveCoverage([{ prop: 'component', figma: 'x', dom: 'y', status: 'warn' }]);
    expect(cov.measured).toContain('component');
  });

  it('meta/structural/ref rows do NOT leak into measured (I3)', () => {
    const rows: DiffRow[] = [
      { prop: 'snapshot_ref', figma: null, dom: 'error', status: 'warn' },
      { prop: 'structure_mismatch', status: 'warn', note: 'child count' },
      { prop: 'children_truncated', status: 'warn' },
      { prop: 'layout_axis_mismatch', status: 'warn' },
      { prop: 'children', status: 'skip', note: 'no auto-layout' },
    ];
    const cov = deriveCoverage(rows);
    expect(cov.measured).toEqual([]); // none settled as a false axis
    expect(cov.skipped).toEqual([]);
  });

  it('NOT_COVERED_BY_TOOL names the structural holes', () => {
    expect(NOT_COVERED_BY_TOOL).toEqual(['icons']);
  });

  it('a matched border → coverage contains border-color and border-width', () => {
    const rows: DiffRow[] = [
      { prop: 'border-color', figma: '#ff0000', dom: '#ff0000', status: 'pass' },
      { prop: 'border-width', figma: 2, dom: 2, status: 'pass' },
    ];
    const cov = deriveCoverage(rows);
    expect(cov.measured).toEqual(['border-color', 'border-width']);
  });

  it('children_reorder ∈ COVERAGE_META: coverage.measured is not polluted; a pair with fail is unclean', () => {
    // children_reorder — fail itself blocks green (buildVerification anyFail); the registry is needed
    // ONLY so deriveCoverage does not count the row as a visual coverage axis.
    const rows: DiffRow[] = [
      { prop: 'children_reorder', status: 'fail', figma: 'child order', dom: 'reordered',
        note: 'fig[0]«X» found at position dom[2] (expected dom[0]) — fix the order' },
      { prop: 'offset-cross[1] title', figma: 0, dom: 0, status: 'pass' },
    ];
    const cov = deriveCoverage(rows);
    expect(cov.measured).not.toContain('children_reorder');
    expect(cov.measured).toEqual(['offset-cross']);
    // mutation "'children_reorder' removed from COVERAGE_META" → measured contains 'children_reorder' → RED
    const v = buildVerification([{ node_id: 'A', rows, summary: summarize(rows), coverage: cov }], { depthLevels: 4 });
    expect(v.pairs.clean).toBe(0); // existing anyFail mechanic: fail → the pair is unclean
    expect(v.complete).toBe(false);
  });
});

describe('condenseBulkPass (budget cascade)', () => {
  const mk = (rows: any[]): any => ({ node_id: '1:1', rows,
    summary: { pass: rows.filter((r: any) => r.status === 'pass').length, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    coverage: { measured: ['size'], skipped: [] } });
  const bulkPass = (prop: string) => ({ prop, figma: 1, dom: 1, status: 'pass' });

  it('CRITICAL lock: unwrapped + style_anchor + pass-with-note survive; exactly the bulk is condensed', () => {
    const p = mk([
      { prop: 'unwrapped', figma: 'dom', dom: 'div', status: 'pass', note: 'wrappers unwrapped' },
      { prop: 'style_anchor', figma: '-', dom: 'div.x', status: 'pass', note: 'style axes read from the carrier' },
      { prop: 'fill', figma: '#111', dom: '#111', status: 'pass', note: 'Figma raw literal; DOM tokenizes the same hex — not a defect' },
      { prop: 'gap[0] a↔b', figma: 8, dom: 8, status: 'warn', note: 'diverged' },
      ...Array.from({ length: 20 }, (_, i) => bulkPass(`font-size[t${i}]`)),
    ]);
    const [c] = condenseBulkPass([p]);
    expect(c.rows.find((r) => r.prop === 'unwrapped')).toBeDefined();
    expect(c.rows.find((r) => r.prop === 'style_anchor')).toBeDefined();
    expect(c.rows.find((r) => r.prop === 'fill')).toBeDefined();      // pass with a note survived
    expect(c.rows.find((r) => r.prop === 'gap[0] a↔b')).toBeDefined(); // warn is never condensed
    const cond = c.rows.find((r) => r.prop === 'passes_condensed')!;
    expect(cond.figma).toBe(20);
    expect(cond.note).toContain('font-size');
    expect(c.rows.filter((r) => r.prop.startsWith('font-size'))).toHaveLength(0);
    expect(c.summary).toBe(p.summary);   // carried over, not recomputed
    expect(c.coverage).toBe(p.coverage); // carried over, not recomputed
  });
  it('a pair with no bulk-pass — no passes_condensed and no changes at all (the same rows-equivalent object)', () => {
    const p = mk([{ prop: 'size.w', figma: 1, dom: 2, status: 'fail' }]);
    const [c] = condenseBulkPass([p]);
    expect(c.rows.find((r) => r.prop === 'passes_condensed')).toBeUndefined();
    expect(c.rows).toHaveLength(1);
  });
  it('coverage: passes_condensed — not an axis (deriveCoverage over condensed rows does not drift)', () => {
    const [c] = condenseBulkPass([mk([bulkPass('font-size[x]'), bulkPass('size.w')])]);
    const cov = deriveCoverage(c.rows);
    expect(cov.measured).not.toContain('passes_condensed');
  });
});
