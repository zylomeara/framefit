import { describe, it, expect } from 'vitest';
import { frameCoverage, buildVerification, rankOf } from '../../src/domain/layout-spec/verification.js';
import { summarize, diffPair } from '../../src/domain/layout-spec/diff.js';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import type { LayoutSpec, SpecChild, DiffRow, PairResult, PairSummary, SpecRect, CaptureInfo, DomSnapshotOk, BlockingItem } from '../../src/domain/layout-spec/types.js';

// Fixtures: frameCoverage reads children/childrenTruncated/node.id/axis/type; SpecChild — id/children.
// figWorthy = (children.length ?? 0) !== 1 → a leaf (0 children) is worthy; a 1-child wrapper unwraps.
// axis is set on the CONTAINER so partial spacing is raised (gated on auto-layout); type — for decor leaves.
type ScOpts = { axis?: 'row' | 'col'; truncated?: boolean; type?: string; imageFill?: boolean; cause?: 'depth' | 'breadth' | 'budget' };
const sc = (id: string, children?: SpecChild[], opts: ScOpts = {}): SpecChild =>
  ({ id, name: id, type: opts.type ?? 'FRAME', rect: { x: 0, y: 0, w: 10, h: 10 },
    ...(opts.axis ? { axis: opts.axis } : {}), ...(opts.imageFill ? { imageFill: true } : {}),
    ...(children ? { children } : {}), ...(opts.truncated ? { childrenTruncated: true } : {}),
    ...(opts.cause ? { truncationCause: opts.cause } : {}) }) as SpecChild;
const frame = (children: SpecChild[], opts: { truncated?: boolean; axis?: 'row' | 'col'; id?: string } = {}): LayoutSpec =>
  ({ node: { id: opts.id ?? 'F:0', name: 'frame', type: 'FRAME' }, children,
    ...(opts.axis ? { axis: opts.axis } : {}), ...(opts.truncated ? { childrenTruncated: true } : {}) }) as unknown as LayoutSpec;
const ids = (...xs: string[]): Set<string> => new Set(xs);
const pair = (node_id: string, rows: DiffRow[], selector?: string): PairResult =>
  ({ node_id, ...(selector ? { selector } : {}), rows, summary: summarize(rows) }) as PairResult;
const pass = (prop: string): DiffRow => ({ prop, figma: 1, dom: 1, status: 'pass' });
const meta = (source: 'deep' | 'pair_fetch' = 'deep', depth = 8): { depth: number; source: 'deep' | 'pair_fetch' } => ({ depth, source });

describe('frameCoverage — frame-coverage frontier (thread A)', () => {
  it('all regions paired directly → covered=worthy, nothing left', () => {
    const fc = frameCoverage(frame([sc('A'), sc('B')]), ids('A', 'B'), meta());
    expect(fc).toMatchObject({ worthy: 2, covered: 2, uncovered: [], partial: [], enumeration_truncated: false });
  });

  it('a region with no pair inside → uncovered', () => {
    const fc = frameCoverage(frame([sc('A'), sc('B')]), ids('A'), meta());
    expect(fc.uncovered).toEqual(['B']);
    expect(fc.covered).toBe(1);
  });

  it('nothing paired → all regions uncovered', () => {
    const fc = frameCoverage(frame([sc('A'), sc('B')]), ids(), meta());
    expect(fc.uncovered.sort()).toEqual(['A', 'B']);
    expect(fc.covered).toBe(0);
  });

  it('ONE of two children paired → region covered, sibling c2 uncovered (#12: not a false green), not partial', () => {
    const fc = frameCoverage(frame([sc('R', [sc('c1'), sc('c2')])]), ids('c1'), meta());
    expect(fc.covered).toBe(1);
    expect(fc.uncovered).toEqual(['c2']); // the sibling isn't verified — used to be silently "covered"
    expect(fc.partial).toEqual([]); // only 1 child paired — no between-spacing
  });

  it('#1 RECURSION: a spacing hole on a NESTED container (A,B under W under R) + an uncovered sibling Z', () => {
    // R (2 worthy children: W and Z). W (2 children A,B). Pairs only on A,B. The spacing between A,B is a
    // property of W, which nobody measured (isolated pairs A,B are blind to it). Plus Z has no pair at all.
    const R = sc('R', [sc('W', [sc('A'), sc('B')], { axis: 'row' }), sc('Z')]);
    const fc = frameCoverage(frame([R]), ids('A', 'B'), meta());
    expect(fc.partial).toEqual(['W']);   // the nested spacing hole is caught
    expect(fc.uncovered).toEqual(['Z']); // the uncovered sibling
    expect(fc.enumeration_truncated).toBe(false);
  });

  it('#4/#9 DEEP-CUT: a pair beyond the slice (region truncated, id not in the tree) → truncated, NOT a false uncovered', () => {
    const fc = frameCoverage(frame([sc('R', undefined, { truncated: true })]), ids('deepNodeBelowCut'), meta());
    expect(fc.uncovered).toEqual([]);          // we don't cry "add_pair" — the pair could be beyond the slice
    expect(fc.enumeration_truncated).toBe(true);
  });

  it('SPACING HOLE: ≥2 direct children paired, container not → partial (between-pair spacing)', () => {
    const fc = frameCoverage(frame([sc('R', [sc('c1'), sc('c2')], { axis: 'row' })]), ids('c1', 'c2'), meta());
    expect(fc.partial).toEqual(['R']);
    expect(fc.uncovered).toEqual([]);
    expect(fc.covered).toBe(1);
  });

  it('container paired itself → covered, NOT partial (its pair measures the children spacing)', () => {
    const fc = frameCoverage(frame([sc('R', [sc('c1'), sc('c2')])]), ids('R'), meta());
    expect(fc.partial).toEqual([]);
    expect(fc.covered).toBe(1);
  });

  it('#3 ANTI-CRY-WOLF: a container WITHOUT auto-layout + 2 paired children → NOT partial (spacing unmeasurable → diff gives skip)', () => {
    const fc = frameCoverage(frame([sc('R', [sc('c1'), sc('c2')])]), ids('c1', 'c2'), meta()); // R without axis
    expect(fc.partial).toEqual([]); // a pair on R would give a children-skip — the flag is useless
    expect(fc.covered).toBe(1);
  });

  it('unwrap: a 1-child wrapper W→X — the region is addressed by X (the worthy descendant), not by the wrapper', () => {
    const fc = frameCoverage(frame([sc('W', [sc('X')])]), ids(), meta());
    expect(fc.worthy).toBe(1);
    expect(fc.uncovered).toEqual(['X']); // not 'W'
  });

  it('childrenTruncated on the frame → enumeration_truncated (enumeration incomplete)', () => {
    const fc = frameCoverage(frame([sc('A')], { truncated: true }), ids('A'), meta());
    expect(fc.enumeration_truncated).toBe(true);
  });

  it('childrenTruncated on a partial region → enumeration_truncated (siblings could have been missed)', () => {
    const fc = frameCoverage(frame([sc('R', [sc('c1'), sc('c2')], { axis: 'row', truncated: true })]), ids('c1', 'c2'), meta());
    expect(fc.enumeration_truncated).toBe(true);
    expect(fc.partial).toEqual(['R']);
  });

  it('#5/#6/#7 UNWRAP BOUNDARY: a pair on the WRAPPER W (not on the unwrapped X) → region covered, not uncovered', () => {
    const fc = frameCoverage(frame([sc('W', [sc('X')])]), ids('W'), meta()); // the wrapper W is paired, not X
    expect(fc.uncovered).toEqual([]);
    expect(fc.covered).toBe(1);
  });

  it('unwrap does NOT go through a childrenTruncated wrapper (there could be more children beyond the slice)', () => {
    // W is "single-child" ONLY within the slice; childrenTruncated → there could be c2,c3. We don't unwrap into X.
    const fc = frameCoverage(frame([sc('W', [sc('X')], { truncated: true })]), ids('X'), meta());
    expect(fc.enumeration_truncated).toBe(true); // W isn't paired itself, enumeration is truncated
  });

  it('#1 FRAME-ROOT: ≥2 top regions paired, the auto-layout frame itself NOT paired → partial on the FRAME (gap R1↔R2)', () => {
    const fc = frameCoverage(frame([sc('R1'), sc('R2')], { axis: 'row', id: 'F:1' }), ids('R1', 'R2'), meta());
    expect(fc.partial).toEqual(['F:1']); // the inter-region gap (the frame's auto-layout) was measured by nobody
    expect(fc.uncovered).toEqual([]);
  });

  it('ANTI-CRY-WOLF #1: a frame WITHOUT auto-layout + 2 regions paired → NOT partial (no gap)', () => {
    const fc = frameCoverage(frame([sc('R1'), sc('R2')]), ids('R1', 'R2'), meta()); // frame without axis
    expect(fc.partial).toEqual([]);
  });

  it('frame paired ITSELF + regions → NOT partial (its pair measures the inter-region gap)', () => {
    const fc = frameCoverage(frame([sc('R1'), sc('R2')], { axis: 'row', id: 'F:1' }), ids('F:1', 'R1', 'R2'), meta());
    expect(fc.partial).toEqual([]);
  });

  it('#2 DECOR LEAF: a background RECTANGLE / a divider VECTOR — NOT regions (don\'t flood uncovered), a TEXT sibling — yes', () => {
    const section = sc('S', [
      sc('bg', undefined, { type: 'RECTANGLE' }),
      sc('heading', undefined, { type: 'TEXT' }),
      sc('divider', undefined, { type: 'VECTOR' }),
      sc('body', undefined, { type: 'TEXT' }),
    ], { axis: 'col' });
    const fc = frameCoverage(frame([section]), ids('heading'), meta());
    expect(fc.uncovered).toEqual(['body']); // the TEXT sibling isn't verified
    expect(fc.uncovered).not.toContain('bg');       // background — decor, we don't flag it
    expect(fc.uncovered).not.toContain('divider');  // divider — decor
  });

  it('#2b IMAGE-FILL: a RECTANGLE/ELLIPSE with an image = CONTENT (region), unpaired → uncovered (not a false green)', () => {
    const section = sc('S', [
      sc('bg', undefined, { type: 'RECTANGLE' }),                          // solid → decor, not a region
      sc('avatar', undefined, { type: 'ELLIPSE', imageFill: true }),       // IMAGE-fill → content, a region
      sc('heading', undefined, { type: 'TEXT' }),
    ], { axis: 'col' });
    const fc = frameCoverage(frame([section]), ids('heading'), meta());
    expect(fc.uncovered).toContain('avatar'); // the image content isn't verified — honestly uncovered
    expect(fc.uncovered).not.toContain('bg'); // background decor — we don't flag it
  });
});

describe('buildVerification — receipt assembly + blocking', () => {
  it('clean pairs without a frame → scope pairs, complete=true, blocking empty', () => {
    const v = buildVerification([pair('A', [pass('size.w')])], { depthLevels: 4 });
    expect(v).toMatchObject({ complete: true, scope: 'pairs', pairs: { checked: 1, clean: 1 }, blocking: [] });
    expect(v.frame_coverage).toBeUndefined();
  });

  it('clean pairs + a fully covered frame → scope frame, complete=true', () => {
    const v = buildVerification([pair('A', [pass('size.w')]), pair('B', [pass('size.w')])],
      { frame: frame([sc('A'), sc('B')]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    expect(v.complete).toBe(true);
    expect(v.scope).toBe('frame');
    expect(v.frame_coverage).toMatchObject({ worthy: 2, covered: 2 });
  });

  it('structure_mismatch → complete=false, blocking add_pairs_on_children', () => {
    const v = buildVerification([pair('A', [pass('size.w'),
      { prop: 'structure_mismatch', status: 'warn', note: '2 vs 3' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.pairs.clean).toBe(0);
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'structure_mismatch', action: 'add_pairs_on_children', node_id: 'A' }));
  });

  it('unchecked typography depth<8 → raise_max_depth; depth=8 → add_text_pair', () => {
    const row: DiffRow = { prop: 'typography_descent[item]', status: 'unchecked', note: 'below the slice' };
    const v4 = buildVerification([pair('A', [row])], { depthLevels: 4 });
    expect(v4.blocking).toContainEqual(expect.objectContaining({ kind: 'truncated_text', action: 'raise_max_depth' }));
    const v8 = buildVerification([pair('A', [row])], { depthLevels: 8 });
    expect(v8.blocking).toContainEqual(expect.objectContaining({ kind: 'truncated_text', action: 'add_text_pair' }));
  });

  // (b) viewport ergonomics: geometry-unchecked used to go down the
  // UNCONDITIONAL uncheckedToBlocking branch → truncated_text/raise_max_depth — "raise max_depth" on a
  // WINDOW-WIDTH problem (and on scroll/rotated) was actively false navigation (max_depth fixes nothing here).
  // Branch by note: a viewport cause → actionable fix_viewport with numbers in detail; other env
  // (scroll/transform/rotated/rect≈0) → resolve_skip; typography — as before (control test above and below).
  it('(b) geometry+viewport → kind viewport / action fix_viewport with numbers in detail (fixes "raise max_depth")', () => {
    const row: DiffRow = {
      prop: 'geometry', status: 'unchecked', figma: 1920, dom: 1429,
      note: 'viewport 1429 vs frame 1920 — adjust the window width OR pass expected_overlay_width (fixed overlay) / check the breakpoint variant (find_breakpoint_variant)',
    };
    const v = buildVerification([pair('A', [row])], { depthLevels: 4 });
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'viewport', action: 'fix_viewport', detail: row.note }));
  });

  it('(b) geometry WITHOUT viewport (scroll) → kind skip / resolve_skip (NOT truncated_text — the second lie is fixed)', () => {
    const row: DiffRow = { prop: 'geometry', status: 'unchecked', note: 'scroll≠0 — reset the container scroll' };
    const v = buildVerification([pair('A', [row])], { depthLevels: 4 });
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'skip', action: 'resolve_skip' }));
    expect(v.blocking.every((b) => b.action !== 'raise_max_depth')).toBe(true);
  });

  it('(b) control: typography-unchecked → the prior truncated_text/raise_max_depth (the branch did not touch the real typography rows)', () => {
    const row: DiffRow = { prop: 'typography[card]', status: 'unchecked', note: 'below the DFS cap' };
    const v = buildVerification([pair('A', [row])], { depthLevels: 4 });
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'truncated_text', action: 'raise_max_depth' }));
  });

  // Linkage lock: a REAL geometry row via diffPair (not hand-written) — proves that the text of the note
  // written by diff.ts (the word "viewport") and the uncheckedToBlocking matcher (r.note.includes('viewport'))
  // did not drift apart. A desync on either side colors this test.
  it('linkage lock: a real diffPair row (viewport cause) via buildVerification → kind viewport/action fix_viewport', () => {
    const figSpec: LayoutSpec = { node: { id: '1:1', name: 'card', type: 'FRAME' },
      rect: { x: 0, y: 0, w: 343, h: 120 } } as unknown as LayoutSpec;
    const dom: DomSnapshotOk = {
      schema: 1, status: 'ok', selector: '.card', innerWidth: 1429,
      rect: { x: 0, y: 0, w: 343, h: 120 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, transformed: false,
      paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 120, scrollHeight: 120,
      children: [],
    };
    const rows = diffPair(figSpec, dom, { tolerancePx: 1, frameWidth: 1920 });
    const v = buildVerification([pair('1:1', rows)], { depthLevels: 4 });
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'viewport', action: 'fix_viewport' }));
  });

  it('ANTI-CRY-WOLF: demoted-only → complete=false, but blocking EMPTY (inherent, don\'t push "fix")', () => {
    const v = buildVerification([pair('A', [{ prop: 'size.w', figma: 100, dom: 200, status: 'demoted', note: 'hug/fill' }])],
      { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking).toEqual([]);
    expect(v.pairs.clean).toBe(0);
  });

  it('fail → complete=false, blocking EMPTY (a defect is fixed from the ❌ rows, not through coverage)', () => {
    const v = buildVerification([pair('A', [{ prop: 'gap[0]', figma: 8, dom: 48, delta: 40, status: 'fail' }])],
      { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking).toEqual([]);
  });

  it('node not found → blocking not_found/fix_pair', () => {
    const v = buildVerification([pair('A', [{ prop: 'node', status: 'warn', note: 'not found' }])],
      { depthLevels: 4 });
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'not_found', action: 'fix_pair', node_id: 'A' }));
  });

  it('skip row → blocking skip/resolve_skip', () => {
    const v = buildVerification([pair('A', [{ prop: 'size.h', status: 'skip', note: 'scroll container' }])],
      { depthLevels: 4 });
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'skip', action: 'resolve_skip' }));
    expect(v.complete).toBe(false);
  });

  it('an uncovered frame region → blocking uncovered_region/add_pair, complete=false', () => {
    const v = buildVerification([pair('A', [pass('size.w')])],
      { frame: frame([sc('A'), sc('B')]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    expect(v.complete).toBe(false);
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'uncovered_region', action: 'add_pair', node_id: 'B' }));
  });

  it('a frame spacing hole → blocking unchecked_spacing/add_container_pair', () => {
    const v = buildVerification([pair('c1', [pass('size.w')]), pair('c2', [pass('size.w')])],
      { frame: frame([sc('R', [sc('c1'), sc('c2')], { axis: 'row' })]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    expect(v.complete).toBe(false);
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'unchecked_spacing', action: 'add_container_pair', node_id: 'R' }));
  });

  it('frame enumeration truncated → blocking children_truncated + complete=false EVEN with clean pairs', () => {
    const v = buildVerification([pair('A', [pass('size.w')])],
      { frame: frame([sc('A')], { truncated: true }), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    expect(v.complete).toBe(false);
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'children_truncated', action: 'raise_max_depth' }));
  });

  it('id normalization: a pair "2338-1" covers the region "2338:1" (not a false uncovered)', () => {
    const v = buildVerification([pair('2338-1', [pass('size.w')])],
      { frame: frame([sc('2338:1')]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    expect(v.frame_coverage?.uncovered).toEqual([]);
    expect(v.complete).toBe(true);
  });

  it('#8 an ineffective pair (node-not-found) does NOT cover the region → region uncovered', () => {
    // There's a pair on A, but the node wasn't found (nothing verified) → region A still has no coverage.
    const v = buildVerification([pair('A', [{ prop: 'node', status: 'warn', note: 'not found' }])],
      { frame: frame([sc('A')]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    expect(v.frame_coverage?.uncovered).toEqual(['A']); // we don't inflate covered
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'not_found' }));
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'uncovered_region', node_id: 'A' }));
    expect(v.complete).toBe(false);
  });

  it('#10 frame_node_id given, but the frame not found → scope frame, blocking frame_missing, complete=false (not silently green)', () => {
    const v = buildVerification([pair('A', [pass('size.w')])], { frameRequested: true, depthLevels: 4 });
    expect(v.scope).toBe('frame');
    expect(v.complete).toBe(false);
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'frame_missing', action: 'fix_frame_id' }));
    expect(v.frame_coverage).toBeUndefined();
  });

  it('#13 a long blocking is truncated in JSON (blocking_capped) — complete still false', () => {
    const regions = Array.from({ length: 50 }, (_, i) => sc(`r${i}`));
    const v = buildVerification([pair('r0', [pass('size.w')])], { frame: frame(regions), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    expect(v.blocking.length).toBe(40);      // BLOCKING_CAP
    expect(v.blocking_capped).toBeGreaterThan(0);
    expect(v.complete).toBe(false);
  });
});

// (c) dominant_blocker: ≥2 checked pairs silenced by ONE
// viewport cause → one loud aggregate instead of N quiet lines in blocking. Numbers are taken ONLY from the
// structural fields of the geometry row (r.figma/r.dom as number) — other geometry causes
// (scroll/rotated/transform/rect≈0) carry no fields and don't count in vpRows.
describe('(c) dominant_blocker — viewport aggregate of ≥2 pairs', () => {
  const vpRow = (dom: number, figmaW = 1920): DiffRow =>
    ({ prop: 'geometry', status: 'unchecked', figma: figmaW, dom, note: `viewport ${dom} vs frame ${figmaW} — adjust the window width` });
  const scrollRow: DiffRow = { prop: 'geometry', status: 'unchecked', note: 'scroll≠0 — reset the container scroll' };

  it('3 viewport pairs → dominant_blocker aggregates all three (kind/pairs/window/frame)', () => {
    const v = buildVerification([
      pair('A', [vpRow(1429)]), pair('B', [vpRow(1429)]), pair('C', [vpRow(1429)]),
    ], { depthLevels: 4 });
    expect(v.dominant_blocker).toEqual({ kind: 'viewport', pairs: 3, window: 1429, frame: 1920 });
  });

  it('1 viewport pair → dominant_blocker ABSENT (serialization lock: the key is not in JSON, not merely undefined)', () => {
    const v = buildVerification([pair('A', [vpRow(1429)])], { depthLevels: 4 });
    expect(v.dominant_blocker).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain('dominant_blocker');
  });

  // threshold mutation lock (m1: ">= 2" → ">= 1"): exactly ONE structural viewport row (the second pair is a
  // scroll-geometry WITHOUT figma/dom fields, not counted) — under correct code it's ABSENT, under the
  // threshold mutation it would become present.
  it('2 pairs: ONE viewport + ONE scroll-geometry without fields → ABSENT (one cause — not a dominant)', () => {
    const v = buildVerification([pair('A', [vpRow(1429)]), pair('B', [scrollRow])], { depthLevels: 4 });
    expect(v.dominant_blocker).toBeUndefined();
  });

  // NEGATIVE CONTROL (the most expensive regression "cry wolf on a healthy
  // flow"): healthy pairs (viewport within tolerance, status pass) must NEVER produce a
  // dominant_blocker — vpRows is built ONLY from status:'unchecked' geometry rows.
  it('NEGATIVE CONTROL: 2+ correct-width pairs (viewport pass) → dominant_blocker undefined', () => {
    const passRow: DiffRow = { prop: 'viewport', figma: 1920, dom: 1920, status: 'pass' };
    const v = buildVerification([pair('A', [passRow]), pair('B', [passRow])], { depthLevels: 4 });
    expect(v.dominant_blocker).toBeUndefined();
  });

  it('mixed-window: 2 pairs with DIFFERENT innerWidth (1429, 1200) → window is taken from the FIRST pair', () => {
    const v = buildVerification([pair('A', [vpRow(1429)]), pair('B', [vpRow(1200)])], { depthLevels: 4 });
    expect(v.dominant_blocker).toMatchObject({ kind: 'viewport', pairs: 2, window: 1429, frame: 1920 });
  });
});

describe('causes aggregation + enumeration fields + advice matrix', () => {
  it('causes aggregate as a set over all slice points (walk + root)', () => {
    // frame root truncated cause breadth + walk latches budget/depth → union of all three
    const f = frame([sc('A', [sc('a1')], { truncated: true, cause: 'budget' }), sc('B', undefined, { truncated: true, cause: 'depth' })], { truncated: true });
    (f as any).truncationCause = 'breadth'; // the root cause — branch (b) of the Acc initializer
    const fc = frameCoverage(f, ids('a1'), meta());
    expect(fc.enumeration_causes!.sort()).toEqual(['breadth', 'budget', 'depth']);
    expect(fc.enumeration_source).toBe('deep'); expect(fc.enumeration_depth).toBe(8);
  });

  it('MUTATION LOCK A-imp-1: propagating truncated through a NON-truncated node does NOT inject a false depth', () => {
    // frame → K1 (NOT truncated, worthy: 2 children G+H, NOTHING paired) → G (truncated, cause breadth).
    // walk(K1): kids untouched, subtreeTrunc → the top-loop `else if (res.truncated)` (line 90) runs on the
    // NON-truncated K1. Causes are exactly ['breadth'] (latch only on G.selfTrunc); the mutation "add a cause
    // at propagation point 90 with ?? depth" would yield ['breadth','depth'] → RED.
    const f = frame([sc('K1', [sc('G', undefined, { truncated: true, cause: 'breadth' }), sc('H')])]);
    const fc = frameCoverage(f, ids(), meta());
    expect(fc.enumeration_causes).toEqual(['breadth']);
  });

  it('MUTATION LOCK of the SECOND propagation point (verification.ts:95): an auto-layout container, 1 paired + 1 unpaired child — the unpaired one itself is NOT truncated, but its DESCENDANT is breadth-truncated', () => {
    // R (axis) → c1 (paired, leaf) + c2 (NOT paired, NOT truncated itself — truncationCause undefined, type
    // INSTANCE so it stays a worthy region and doesn't unwrap into c2a) → c2a (truncated, cause breadth).
    // walk(c2) returns {touched:false, truncated:true} BEFORE line 94 (kids.length>0, touchedKids empty →
    // early return line 86) — the loop 94-101 itself runs on the TOP walk(R), where x.k.node is c2 (not
    // truncated, truncationCause undefined). Correct code at line 95 does NOT touch causes (only
    // acc.truncated=true) — the cause 'breadth' is already injected below (line 80, on c2a.selfTrunc).
    // The mutation "acc.causes.add(x.k.node.truncationCause ?? 'depth')" at line 95 would inject a false
    // 'depth' (c2.truncationCause===undefined) on top of the honest 'breadth' → the set bloats.
    const c2a = sc('c2a', undefined, { truncated: true, cause: 'breadth' });
    const c2 = sc('c2', [c2a], { type: 'INSTANCE' });
    const c1 = sc('c1');
    const R = sc('R', [c1, c2], { axis: 'row' });
    const fc = frameCoverage(frame([R]), ids('c1'), meta());
    expect(fc.enumeration_causes).toEqual(['breadth']);
  });

  it('MUTATION LOCK of the depth<8 subguard (verification.ts:263): pair_fetch@8 (capped max_depth) + depth-cause → caveat "deeper than 9 levels", NO raise_max_depth', () => {
    // pair_fetch@8 is reachable in prod (max_depth caps at 8, depthLevels=effDepth) — the subguard
    // `enumMeta.depth < 8` must stay true ONLY when depth really is <8, else raise_max_depth would be
    // proposed at already-maximal depth (an unexecutable advice — there's nowhere deeper to enumerate).
    const v = buildVerification([], {
      frame: frame([sc('A', undefined, { truncated: true, cause: 'depth' })]),
      frameRequested: true, depthLevels: 8, enumeration: { depth: 8, source: 'pair_fetch' },
    });
    expect(v.blocking.every((b) => b.action !== 'raise_max_depth')).toBe(true);
    expect(v.frame_coverage!.enumeration_note).toMatch(/deeper than 9 levels/);
  });

  it('matrix: pair_fetch@<8 + depth → blocking raise_max_depth (the remedy is valid)', () => {
    const v = buildVerification([], { frame: frame([sc('A', undefined, { truncated: true, cause: 'depth' })]), frameRequested: true, depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    expect(v.blocking.some((b) => b.kind === 'children_truncated' && b.action === 'raise_max_depth')).toBe(true);
  });

  it('matrix: deep@8 + depth → caveat, NO raise_max_depth (mutation lock: raise lies here)', () => {
    const v = buildVerification([], { frame: frame([sc('A', undefined, { truncated: true, cause: 'depth' })]), frameRequested: true, depthLevels: 8, enumeration: { depth: 8, source: 'deep' } });
    expect(v.blocking.every((b) => b.action !== 'raise_max_depth')).toBe(true);
    expect(v.frame_coverage!.enumeration_note).toMatch(/deeper than 9 levels/);
    expect(v.complete).toBe(false); // truncated honestly holds it red
  });

  it('matrix: budget/breadth → caveat "wider than the budget", without raise_max_depth (unexecutable)', () => {
    const v = buildVerification([], { frame: frame([sc('A', undefined, { truncated: true, cause: 'breadth' })]), frameRequested: true, depthLevels: 8, enumeration: { depth: 8, source: 'deep' } });
    expect(v.blocking.every((b) => b.action !== 'raise_max_depth')).toBe(true);
    expect(v.frame_coverage!.enumeration_note).toMatch(/wider than the enumeration budget/);
  });

  it('deep@<8 (backoff-clamp) + depth → caveat "to N levels"', () => {
    const v = buildVerification([], { frame: frame([sc('A', undefined, { truncated: true, cause: 'depth' })]), frameRequested: true, depthLevels: 4, enumeration: { depth: 6, source: 'deep' } });
    expect(v.frame_coverage!.enumeration_note).toMatch(/to 6 levels/);
  });

  it('list caps: 70 uncovered → 60 in the list + uncovered_capped 10; complete computed BEFORE the cut', () => {
    const kids = Array.from({ length: 70 }, (_, i) => sc(`k${i}`, undefined, { type: 'INSTANCE' }));
    const fc = frameCoverage(frame(kids), ids(), meta());
    expect(fc.uncovered).toHaveLength(60); expect(fc.uncovered_capped).toBe(10); expect(fc.worthy).toBe(70);
  });

  it('anti-flood: 19 same-kind card siblings without pairs → ONE blocking add_pair with "19 similar"', () => {
    const kids = [sc('c0', undefined, { type: 'INSTANCE' }), ...Array.from({ length: 19 }, (_, i) => sc(`c${i + 1}`, undefined, { type: 'INSTANCE' }))];
    kids.forEach((k) => ((k as any).name = 'card'));
    const v = buildVerification([pair('c0', [pass('size.w')])], { frame: frame([sc('L', kids, { axis: 'col' })]), frameRequested: true, depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    const adds = v.blocking.filter((b) => b.kind === 'uncovered_region');
    expect(adds).toHaveLength(1);
    // "first 3 of 19" locks the new honest suffix (not a silent "…") — the regex depends on "of N".
    expect(adds[0].detail).toMatch(/19 similar .*card.*first 3 of 19/);
  });

  it('report: enumeration provenance + note render (NOT vacuous — real asserts)', () => {
    // non-complete branch: truncated deep@8 with a note
    const v1 = buildVerification([], { frame: frame([sc('A', undefined, { truncated: true, cause: 'depth' })]), frameRequested: true, depthLevels: 8, enumeration: { depth: 8, source: 'deep' } });
    const md1 = renderReport({ file: 'F', tolerancePx: 1, pairs: [], verification: v1 });
    expect(md1).toContain('enumeration: deep@8');
    expect(md1).toContain('deeper than 9 levels');
    // COMPLETE branch (A-min: the early return report.ts:104-106 also carries provenance)
    const v2 = buildVerification([pair('A', [pass('size.w')])], { frame: frame([sc('A')]), frameRequested: true, depthLevels: 8, enumeration: { depth: 8, source: 'deep' } });
    const md2 = renderReport({ file: 'F', tolerancePx: 1, pairs: [pair('A', [pass('size.w')])], verification: v2 });
    expect(md2).toContain('enumeration: deep@8');
  });
});

const sum = (over: Partial<PairSummary> = {}): PairSummary =>
  ({ pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0, ...over });
const pairFromRows = (rows: DiffRow[]): PairResult => {
  const s = sum();
  for (const r of rows) (s as any)[r.status] += 1;
  return { node_id: '1:1', rows, summary: s };
};

describe('review gate', () => {
  it('a review row forces complete=false and a blocking item', () => {
    const v = buildVerification([pairFromRows([{ prop: 'color[x]', status: 'review', note: 'confirm token' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking.some((b) => b.kind === 'unconfirmed_token')).toBe(true);
  });
  it('a benign info-only pair stays complete=true (info never gates)', () => {
    const v = buildVerification([pairFromRows([{ prop: 'color[x]', status: 'info', note: 'oklch — verify visually' }])], { depthLevels: 4 });
    expect(v.complete).toBe(true);
  });

  it('a review row forbids the green headline', () => {
    const p = pairFromRows([{ prop: 'color[x]', status: 'review', note: 'confirm token' }]);
    const v = buildVerification([p], { depthLevels: 4 });
    const md = renderReport({ file: 'F', tolerancePx: 1, pairs: [p], depthLevels: 4, verification: v });
    expect(md).not.toContain('no discrepancies above tolerance');
    expect(md).toContain('CHECK INCOMPLETE');
  });

  // Live-run p.11: a badge ran 11 pass / 0 fail and still complete:false — the only blocker was
  // confirm_token on a color where BOTH sides read the same byte-for-byte hex. "The node's mode is
  // not confirmed" is a property of the design file, not of the code under review; a perpetually
  // red gate teaches the reader to explain red away — the exact erosion the gate exists to prevent.
  it('a review row with byte-equal values neither blocks nor holds complete false', () => {
    const v = buildVerification([pairFromRows([{ prop: 'color[badge]', figma: '#242429', dom: '#242429',
      status: 'review', note: 'mode unconfirmed', token: 'tok/badge', tokenReason: 'mode-unconfirmed' }])], { depthLevels: 4 });
    expect(v.complete).toBe(true);
    expect(v.blocking).toEqual([]);
  });
  it('the value match is case-insensitive (hex casing is presentation, not value)', () => {
    const v = buildVerification([pairFromRows([{ prop: 'color[x]', figma: '#ABCDEF', dom: '#abcdef',
      status: 'review', note: 'confirm', token: 'tok/x', tokenReason: 'semantic-confirm' }])], { depthLevels: 4 });
    expect(v.complete).toBe(true);
    expect(v.blocking).toEqual([]);
  });
  it('control: diverged values still block and hold complete false', () => {
    const v = buildVerification([pairFromRows([{ prop: 'color[x]', figma: '#111111', dom: '#222222',
      status: 'review', note: 'confirm', token: 'tok/x', tokenReason: 'mode-unconfirmed' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking.some((b) => b.kind === 'unconfirmed_token')).toBe(true);
  });
  it('control: a missing side still blocks (nothing was matched)', () => {
    const v = buildVerification([pairFromRows([{ prop: 'color[x]', figma: null, dom: '#222222',
      status: 'review', note: 'the token cannot be checked', tokenReason: 'fig-unresolved' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking.some((b) => b.kind === 'unconfirmed_token')).toBe(true);
  });
  it('a matched-value review row keeps the green headline and stays visible as a review count', () => {
    const p = pairFromRows([{ prop: 'color[badge]', figma: '#242429', dom: '#242429',
      status: 'review', note: 'mode unconfirmed', token: 'tok/badge', tokenReason: 'mode-unconfirmed' }]);
    const v = buildVerification([p], { depthLevels: 4 });
    const md = renderReport({ file: 'F', tolerancePx: 1, pairs: [p], depthLevels: 4, verification: v });
    expect(md).toContain('no discrepancies above tolerance');
    expect(md).not.toContain('awaiting token confirmation');
    expect(md).toContain('📝1'); // the row is not hidden — only no longer a blocker
  });
  // Adversarial pass, two holes in the same change:
  it('a review row whose values are DIFFERENT tokens (gradient provenance class) still blocks', () => {
    const v = buildVerification([pairFromRows([{ prop: 'gradient-token', figma: 'grad/brand', dom: '--legacy',
      status: 'review', note: 'both from a token — confirm the semantics', token: 'grad/brand', tokenReason: 'semantic-confirm' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking.some((b) => b.kind === 'unconfirmed_token')).toBe(true);
  });
  it('a pair whose only finding is an advisory matched review counts clean (no self-contradictory receipt)', () => {
    const v = buildVerification([pairFromRows([
      { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
      { prop: 'color[x]', figma: '#242429', dom: '#242429', status: 'review', note: 'mode unconfirmed', token: 'tok/x', tokenReason: 'mode-unconfirmed' },
    ])], { depthLevels: 4 });
    expect(v.complete).toBe(true);
    expect(v.pairs.clean).toBe(1); // complete:true with clean 0/1 would contradict itself
  });

  it('matched-value rows do not join the confirm_token aggregation (no phantom places)', () => {
    const matched = pairFromRows([{ prop: 'color[a]', figma: '#333333', dom: '#333333',
      status: 'review', note: 'confirm', token: 'tok/y', tokenReason: 'semantic-confirm' }]);
    const diverged = pairFromRows([{ prop: 'color[b]', figma: '#333333', dom: '#444444',
      status: 'review', note: 'confirm', token: 'tok/y', tokenReason: 'mode-unconfirmed' }]);
    const v = buildVerification([matched, diverged], { depthLevels: 4 });
    const toks = v.blocking.filter((b) => b.kind === 'unconfirmed_token');
    expect(toks).toHaveLength(1);
    expect((toks[0] as { places?: unknown[] }).places).toBeUndefined(); // 1 real place → single-record format
  });
});

// ── confirm-token-aggregation: two-axis cross-pair grouping of confirm_token in blocking ──
describe('confirm_token aggregation (two-axis, cross-pair)', () => {
  const mk = (node_id: string, rows: any[]): any => ({ node_id, rows,
    summary: { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: rows.filter((r) => r.status === 'review').length } });
  const rev = (prop: string, token?: string, tokenReason?: string, note = 'confirm') =>
    ({ prop, status: 'review', note, ...(token ? { token } : {}), ...(tokenReason ? { tokenReason } : {}) });
  const blockingOf = (pairs: any[]) => buildVerification(pairs, { depthLevels: 4 }).blocking.filter((b: any) => b.kind === 'unconfirmed_token');

  it('axis-1: 7 places of one token across TWO pairs → one record ×7, reasons, full places, detail cap-3', () => {
    const p1 = mk('1:1', [rev('color[a]', 'text color/primary', 'layered-undecidable'), rev('color[b]', 'text color/primary', 'layered-undecidable'),
      rev('color[c]', 'text color/primary', 'layered-undecidable'), rev('fill', 'text color/primary', 'inherited')]);
    const p2 = mk('2:2', [rev('color[d]', 'text color/primary', 'inherited'), rev('color[e]', 'text color/primary', 'not-captured'),
      rev('color[f]', 'text color/primary', 'semantic-confirm')]);
    const b = blockingOf([p1, p2]);
    expect(b).toHaveLength(1);
    expect(b[0].places).toHaveLength(7);
    expect(b[0].detail).toContain('×7 places');
    expect(b[0].detail).toContain('layered-undecidable ×3');
    expect(b[0].detail).toContain('and 4 more');
    expect(b[0].node_id).toBe('1:1');
  });
  it('two tokens → two records', () => {
    const p = mk('1:1', [rev('a', 'tok/one', 'inherited'), rev('b', 'tok/one', 'inherited'), rev('c', 'tok/two', 'inherited'), rev('d', 'tok/two', 'inherited')]);
    expect(blockingOf([p])).toHaveLength(2);
  });
  it('the (paint) sentinel is NOT a token group: two rows of different paints go to axis-2 by reason', () => {
    const p = mk('1:1', [rev('a', '(paint)', 'semantic-confirm'), rev('b', '(paint)', 'semantic-confirm')]);
    const b = blockingOf([p]);
    expect(b).toHaveLength(1);
    expect(b[0].detail).not.toContain('"(paint)"');
    expect(b[0].detail).toContain('semantic-confirm');
  });
  it('(style: Brand) — a distinguishable name, groups as a token', () => {
    const p = mk('1:1', [rev('a', '(style: Brand)', 'semantic-confirm'), rev('b', '(style: Brand)', 'semantic-confirm')]);
    const b = blockingOf([p]);
    expect(b).toHaveLength(1);
    expect(b[0].detail).toContain('(style: Brand)');
  });
  it('axis-2 from a REAL factory: fig-unresolved rows group', () => {
    const p = mk('1:1', [rev('color[a]', undefined, 'fig-unresolved'), rev('color[b]', undefined, 'fig-unresolved')]);
    const b = blockingOf([p]);
    expect(b).toHaveLength(1);
    expect(b[0].detail).toContain('fig-unresolved');
  });
  it('axis-2: 12 token-less bound-unresolved → one record; another reason — separate', () => {
    const rows = Array.from({ length: 12 }, (_, i) => rev(`color[${i}]`, undefined, 'bound-unresolved'));
    const p = mk('1:1', [...rows, rev('x', undefined, 'fig-unresolved')]);
    const b = blockingOf([p]);
    expect(b).toHaveLength(2);
    const big = b.find((x: any) => x.detail.includes('×12'))!;
    expect(big.detail).toContain('bound-unresolved');
    expect(big.places).toHaveLength(12);
  });
  it('legacy (no token and no tokenReason) → direct push with note (no places)', () => {
    const p = mk('1:1', [rev('a', undefined, undefined, 'old note')]);
    const b = blockingOf([p]);
    expect(b).toHaveLength(1);
    expect(b[0].detail).toBe('old note');
    expect(b[0].places).toBeUndefined();
  });
  it('a group of 1 place → a single record of the prior format (detail = note, no places)', () => {
    const p = mk('1:1', [rev('a', 'tok/solo', 'inherited', 'solo note')]);
    const b = blockingOf([p]);
    expect(b[0].detail).toBe('solo note');
    expect(b[0].places).toBeUndefined();
  });
  it('an empty token string → not a token key (axis-2)', () => {
    const p = mk('1:1', [rev('a', '', 'inherited'), rev('b', '', 'inherited')]);
    const b = blockingOf([p]);
    expect(b).toHaveLength(1);
    expect(b[0].detail).toContain('inherited');
  });
  it('Transport budget: 100 places of one token → places capped at 60, places_capped:40, detail honestly carries ×100', () => {
    const rows = Array.from({ length: 100 }, (_, i) => rev(`color[${i}]`, 'tok/flood', 'inherited'));
    const p = mk('1:1', rows);
    const b = blockingOf([p]);
    expect(b).toHaveLength(1);
    expect(b[0].places).toHaveLength(60);
    expect((b[0] as any).places_capped).toBe(40);
    expect(b[0].detail).toContain('×100 places');
  });
  it('non-token blocking untouched; the token aggregate (rank 7) comes BEFORE skip (rank 10) — rankOf sort', () => {
    const p1 = mk('1:1', [rev('a', 'tok/x', 'inherited'), { prop: 'geometry', status: 'skip', note: 'skip' }]);
    const p2 = mk('2:2', [rev('b', 'tok/x', 'inherited')]);
    const all = buildVerification([p1, p2], { depthLevels: 4 }).blocking;
    const skipIdx = all.findIndex((b: any) => b.kind === 'skip');
    const tokIdx = all.findIndex((b: any) => b.kind === 'unconfirmed_token');
    expect(skipIdx).toBeGreaterThanOrEqual(0);
    expect(tokIdx).toBeGreaterThanOrEqual(0);
    expect(tokIdx).toBeLessThan(skipIdx); // the aggregate is more valuable than env: it used to be AFTER (appearance order) — the contract was changed deliberately
  });
});

// ── spacing_audit wiring — walk-collected captures, blocking rules, complete ──
describe('buildVerification — spacing_audit wiring', () => {
  const rect = (x: number, y: number, w = 10, h = 10): SpecRect => ({ x, y, w, h });
  // scR — a variant of sc() with an explicit rect (the base sc() hardcodes {x:0,y:0,w:10,h:10} on ALL nodes
  // — the audit geometry needs REAL differing rects to compute a real gap).
  const scR = (id: string, r: SpecRect, opts: ScOpts = {}): SpecChild => ({ ...sc(id, undefined, opts), rect: r }) as SpecChild;
  const cap = (ref: string | undefined, r: SpecRect, opts: { geometryUnchecked?: boolean } = {}): CaptureInfo => ({
    ...(ref !== undefined ? { ref } : {}), rect: r, geometryUnchecked: opts.geometryUnchecked ?? false,
  });

  it('T5-1: container L (col), A↔B paired with matching rects → spacing_audit pass, unchecked_spacing NOT emitted for L', () => {
    const A = scR('A', rect(0, 0));
    const B = scR('B', rect(0, 20));
    const L = sc('L', [A, B], { axis: 'col' });
    const captures = new Map<string, CaptureInfo>([
      ['A', cap('batch1', rect(0, 0))],
      ['B', cap('batch1', rect(0, 20))],
    ]);
    const v = buildVerification(
      [pair('A', [pass('size.w')]), pair('B', [pass('size.w')])],
      { frame: frame([L]), depthLevels: 4, enumeration: meta('pair_fetch', 4), captures },
    );
    expect(v.frame_coverage?.partial).toEqual(['L']);
    // Mutation lock: this SAME toEqual already checks the
    // whole entry shape, so adding fully_clean:true here is a DIRECT lock on the assignment in
    // verification.ts (the line "entry!.fully_clean = true"). Remove the assignment → actual loses the field →
    // exact-equality goes RED.
    expect(v.spacing_audit).toEqual([
      { container_id: 'L', axis: 'col', gaps: [{ between: ['A', 'B'], figma: 10, dom: 10, delta: 0, status: 'pass' }], insets_unverified: true, fully_clean: true },
    ]);
    expect(v.blocking.some((b) => b.node_id === 'L')).toBe(false); // suppressed — the audit explains itself
    // INSETS-INVARIANT MUTATION LOCK: complete MUST stay false even when the audit of L is fully clean.
    // L's insets (the container's padding) are NOT proven by the audit (insets_unverified:true) — "clearing"
    // complete here (e.g. "since the audit is clean, partial is closed") would be a frame-level false green.
    expect(v.complete).toBe(false);
  });

  it('T5-2: fail case — 2 fail gaps on ONE container → exactly ONE spacing_mismatch (dedup), unchecked_spacing absent', () => {
    const A = scR('A', rect(0, 0));
    const B = scR('B', rect(20, 0));
    const C = scR('C', rect(40, 0));
    const M = sc('M', [A, B, C], { axis: 'row' });
    const captures = new Map<string, CaptureInfo>([
      ['A', cap('batch1', rect(0, 0))],
      ['B', cap('batch1', rect(30, 0))],  // figma gap 10, dom gap 20 → Δ10 fail
      ['C', cap('batch1', rect(60, 0))],  // figma gap 10, dom gap 20 → Δ10 fail
    ]);
    const v = buildVerification(
      [pair('A', [pass('size.w')]), pair('B', [pass('size.w')]), pair('C', [pass('size.w')])],
      { frame: frame([M]), depthLevels: 4, enumeration: meta('pair_fetch', 4), captures },
    );
    const mismatches = v.blocking.filter((b) => b.kind === 'spacing_mismatch' && b.node_id === 'M');
    expect(mismatches).toHaveLength(1);
    expect(v.blocking.some((b) => b.kind === 'unchecked_spacing' && b.node_id === 'M')).toBe(false);
  });

  it('T5-3: unchecked case (different refs) → unchecked_spacing item AS BEFORE (lock: the A1 behavior does not regress)', () => {
    const X = scR('X', rect(0, 0));
    const Y = scR('Y', rect(20, 0));
    const N = sc('N', [X, Y], { axis: 'row' });
    const captures = new Map<string, CaptureInfo>([
      ['X', cap('batch1', rect(0, 0))],
      ['Y', cap('batch2', rect(20, 0))], // different refs → gate1 unchecked
    ]);
    const v = buildVerification(
      [pair('X', [pass('size.w')]), pair('Y', [pass('size.w')])],
      { frame: frame([N]), depthLevels: 4, enumeration: meta('pair_fetch', 4), captures },
    );
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'unchecked_spacing', action: 'add_container_pair', node_id: 'N' }));
    expect(v.blocking.some((b) => b.kind === 'spacing_mismatch')).toBe(false);
  });

  it('T5-4: partial adjacency coverage (A,C paired of A,B,C, B WITHOUT a pair) → gaps not emitted + unchecked_spacing stays', () => {
    const A = scR('A', rect(0, 0));
    const B = scR('B', rect(20, 0));
    const C = scR('C', rect(40, 0));
    const P = sc('P', [A, B, C], { axis: 'row' });
    const captures = new Map<string, CaptureInfo>([
      ['A', cap('batch1', rect(0, 0))],
      ['C', cap('batch1', rect(40, 0))],
      // B is deliberately NOT paired (no pair('B', …) below) and has no captures entry
    ]);
    const v = buildVerification(
      [pair('A', [pass('size.w')]), pair('C', [pass('size.w')])],
      { frame: frame([P]), depthLevels: 4, enumeration: meta('pair_fetch', 4), captures },
    );
    expect(v.spacing_audit).toBeUndefined(); // no adjacent both-paired neighborhood — auditContainer returned undefined
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'unchecked_spacing', node_id: 'P' }));
  });

  it('T5-5: the frame root as a partial container (touchedTop≥2, frame.axis, frame not paired) → also audited', () => {
    const R1 = scR('R1', rect(0, 0));
    const R2 = scR('R2', rect(30, 0));
    const captures = new Map<string, CaptureInfo>([
      ['R1', cap('batch1', rect(0, 0))],
      ['R2', cap('batch1', rect(30, 0))],
    ]);
    const v = buildVerification(
      [pair('R1', [pass('size.w')]), pair('R2', [pass('size.w')])],
      { frame: frame([R1, R2], { axis: 'row', id: 'F:1' }), depthLevels: 4, enumeration: meta('pair_fetch', 4), captures },
    );
    expect(v.frame_coverage?.partial).toEqual(['F:1']);
    // A second mutation lock on fully_clean for a different
    // partial-container shape (the frame root, not nested) — the same shape assert catches an assignment regression.
    expect(v.spacing_audit).toEqual([
      { container_id: 'F:1', axis: 'row', gaps: [{ between: ['R1', 'R2'], figma: 20, dom: 20, delta: 0, status: 'pass' }], insets_unverified: true, fully_clean: true },
    ]);
  });

  it('T5-6: without opts.captures — spacing_audit not computed at all, unchecked_spacing as before (backward compat)', () => {
    const A = scR('A', rect(0, 0));
    const B = scR('B', rect(20, 0));
    const L = sc('L', [A, B], { axis: 'col' });
    const v = buildVerification(
      [pair('A', [pass('size.w')]), pair('B', [pass('size.w')])],
      { frame: frame([L]), depthLevels: 4, enumeration: meta('pair_fetch', 4) }, // opts.captures ABSENT
    );
    expect(v.spacing_audit).toBeUndefined();
    expect(v.blocking).toContainEqual(expect.objectContaining({ kind: 'unchecked_spacing', node_id: 'L' }));
  });

  it('shape-lock: JSON.stringify(verification) does NOT leak internal keys partialDetails/uncoveredMeta/pairedNode/chainNodes', () => {
    const A = scR('A', rect(0, 0));
    const B = scR('B', rect(0, 20));
    const L = sc('L', [A, B], { axis: 'col' });
    const captures = new Map<string, CaptureInfo>([
      ['A', cap('batch1', rect(0, 0))],
      ['B', cap('batch1', rect(0, 20))],
    ]);
    const v = buildVerification(
      [pair('A', [pass('size.w')]), pair('B', [pass('size.w')])],
      { frame: frame([L]), depthLevels: 4, enumeration: meta('pair_fetch', 4), captures },
    );
    const json = JSON.stringify(v);
    for (const leak of ['partialDetails', 'uncoveredMeta', 'pairedNode', 'chainNodes']) {
      expect(json).not.toContain(leak);
    }
  });
});

// ── Blocking priority order under the caps ──
// Both caps (JSON 40 / pretty 15) cut the TAIL. The rankOf sort at the source fixes both mirrors.
// GOLDEN RULE for fixtures: the lower rank is pushed LATER than the higher one — the sort must ACTUALLY
// reorder, otherwise the lock is vacuous (otherwise appearance==rank → the "ranks in one tier"
// mutant is byte-for-byte indistinguishable from correct).
describe('buildVerification — blocking priority order', () => {
  // rect/scR/cap — from the describe "spacing_audit wiring" (:582+), duplicated locally (semantics unchanged):
  // scR gives nodes REAL differing rects for the spacing_mismatch audit geometry.
  const rect = (x: number, y: number, w = 10, h = 10): SpecRect => ({ x, y, w, h });
  const scR = (id: string, r: SpecRect, opts: ScOpts = {}): SpecChild => ({ ...sc(id, undefined, opts), rect: r }) as SpecChild;
  const cap = (ref: string | undefined, r: SpecRect, opts: { geometryUnchecked?: boolean } = {}): CaptureInfo => ({
    ...(ref !== undefined ? { ref } : {}), rect: r, geometryUnchecked: opts.geometryUnchecked ?? false,
  });
  const scNamed = (id: string, name: string): SpecChild => ({ ...sc(id), name }) as SpecChild;
  const skipRow: DiffRow = { prop: 'geometry', status: 'skip', note: 'skip' };
  const extractorRow: DiffRow = { prop: 'extractor_outdated', status: 'warn', note: 'extractor outdated' };
  const structRow: DiffRow = { prop: 'structure_mismatch', status: 'skip', note: 'children diverged' };
  const revRow = (prop: string): DiffRow =>
    ({ prop, status: 'review', token: 'tok/x', tokenReason: 'inherited', note: 'confirm' });
  const revRowNamed = (prop: string, token: string): DiffRow =>
    ({ prop, status: 'review', token, tokenReason: 'inherited', note: 'confirm' });

  it('flip lock: the token aggregate and the uncovered group (rank 7) survive the top-15 under a flood of 45 skip pairs pushed EARLIER', () => {
    const skipPairs = Array.from({ length: 45 }, (_, i) => pair(`s${i}`, [skipRow]));
    const tokenPairs = [pair('t1', [revRow('color')]), pair('t2', [revRow('color')])];
    // 4 same-kind (SAME name!) uncovered siblings of one parent → GROUP count=4;
    // P — the only touched child → partial is not raised (no noise).
    const R = sc('R', [scNamed('u1', 'u'), scNamed('u2', 'u'), scNamed('u3', 'u'), scNamed('u4', 'u'), sc('P')]);
    const v = buildVerification([...skipPairs, ...tokenPairs, pair('P', [pass('size.w')])],
      { frame: frame([R]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    const top15 = v.blocking.slice(0, 15);
    expect(top15.some((b) => b.kind === 'unconfirmed_token' && b.places !== undefined)).toBe(true);
    expect(top15.some((b) => b.kind === 'uncovered_region' && b.count === 4)).toBe(true);
    // mutation "sort off" → RED: the skip pairs are pushed first and take the whole top-15
  });

  it('cross-rank lock: the push CONTRADICTS the rank — the sort must reorder (a two-tier mutant → RED)', () => {
    // Push order (real code): struct(rank 5, pair loop idx0) → extractor(rank 2, idx1) →
    // 41 uncovered GROUPS (rank 7, frame block groups-loop) → spacing_mismatch (rank 3, frame block
    // spacing-loop, LAST). Rank order: extractor(2) < spacing(3) < struct(5) < groups(7).
    // A correct sort REORDERS [5,2,7×41,3] → [2,3,5,7…]; the mutant "ranks in a tier" preserves the push.
    const structPair = pair('S', [structRow]);
    const extractorPair = pair('E', [extractorRow]);
    // spacing_mismatch: container M with axis, two paired children A/B with a fail gap via captures
    // (construction from describe "spacing_audit wiring": the same ref batch is mandatory, else gate1 gives
    // unchecked, not fail; figma gap 10 vs dom gap 20 → Δ10 fail at tolerancePx 1).
    const M = sc('M', [scR('A', rect(0, 0, 10, 10)), scR('B', rect(20, 0, 10, 10))], { axis: 'row' });
    const parents = Array.from({ length: 41 }, (_, i) =>
      sc(`R${i}`, [scNamed(`R${i}a`, 'card'), scNamed(`R${i}b`, 'card'), sc(`R${i}p`)]));
    const covered = parents.map((_, i) => pair(`R${i}p`, [pass('size.w')]));
    const captures = new Map<string, CaptureInfo>([
      ['A', cap('batch1', rect(0, 0, 10, 10))], ['B', cap('batch1', rect(30, 0, 10, 10))], // dom gap 20 vs figma 10 → fail
    ]);
    const v = buildVerification([structPair, extractorPair, pair('A', [pass('size.w')]), pair('B', [pass('size.w')]), ...covered],
      { frame: frame([M, ...parents]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' }, captures, tolerancePx: 1 });
    const idx = (pred: (b: BlockingItem) => boolean): number => v.blocking.findIndex(pred);
    const iExtractor = idx((b) => b.kind === 'extractor_outdated');
    const iSpacing = idx((b) => b.kind === 'spacing_mismatch');
    const iStruct = idx((b) => b.kind === 'structure_mismatch');
    const iGroup = idx((b) => b.kind === 'uncovered_region' && b.count === 2);
    expect(iExtractor).toBeGreaterThanOrEqual(0);
    expect(iSpacing).toBeGreaterThanOrEqual(0);
    expect(iGroup).toBeGreaterThanOrEqual(0);
    expect(iExtractor).toBeLessThan(iSpacing);  // 2 < 3 — swapping extractor↔spacing → RED
    expect(iSpacing).toBeLessThan(iStruct);     // 3 < 5 — CONTRADICTS the push (spacing pushed LAST, struct first) → two-tier mutant → RED
    expect(iStruct).toBeLessThan(iGroup);       // 5 < 7 — real rank-7 groups (count=2)
    expect(v.blocking_capped).toBeGreaterThan(0); // the flood really capped the tail, and ranks 2/3/5 survived (indices ≥0 above)
  });

  it('rank 1: frame_missing is pushed LAST (frame block), the sort lifts it ABOVE extractor (rank 2)', () => {
    // Push: extractor (pair loop) → frame_missing (frame block, the very end). Ranks: 1 < 2 —
    // a contradiction between push and rank → the sort must reorder; sort-off / tier mutant → RED.
    const v = buildVerification([pair('E', [extractorRow])], { frameRequested: true, depthLevels: 4 });
    const iMissing = v.blocking.findIndex((b) => b.kind === 'frame_missing');
    const iExtractor = v.blocking.findIndex((b) => b.kind === 'extractor_outdated');
    expect(iMissing).toBeGreaterThanOrEqual(0);
    expect(iExtractor).toBeGreaterThanOrEqual(0);
    expect(iMissing).toBeLessThan(iExtractor);
  });

  it('token aggregate-ness discriminator: the aggregate (places, rank 7) BEFORE the singleton (rank 8) pushed EARLIER', () => {
    // The singleton tok/solo enters tokenGroups FIRST (pair s comes earlier in the array) → is flushed first
    // → push [solo, aggregate]; ranks [8, 7] contradict → the sort reorders; the mutant "unconfirmed_token is
    // always 7" preserves the push → RED.
    const solo = pair('s', [revRowNamed('color', 'tok/solo')]);
    const agg1 = pair('a1', [revRowNamed('fill', 'tok/agg')]);
    const agg2 = pair('a2', [revRowNamed('fill', 'tok/agg')]);
    const v = buildVerification([solo, agg1, agg2], { depthLevels: 4 });
    const iAgg = v.blocking.findIndex((b) => b.kind === 'unconfirmed_token' && b.places !== undefined);
    const iSolo = v.blocking.findIndex((b) => b.kind === 'unconfirmed_token' && b.places === undefined);
    expect(iAgg).toBeGreaterThanOrEqual(0);
    expect(iSolo).toBeGreaterThanOrEqual(0);
    expect(iAgg).toBeLessThan(iSolo);
  });

  it('explicit rank 8 unchecked_spacing: BEFORE skip (rank 10) pushed EARLIER (mutant default=10 → RED)', () => {
    // unchecked_spacing: container W with axis, 2 paired children, WITHOUT captures → frame block;
    // the skip pair is pushed in the pair loop EARLIER. Ranks [10 pushed-first, 8 pushed-second] → the sort reorders.
    const W = sc('W', [sc('c1'), sc('c2')], { axis: 'row' });
    const v = buildVerification([pair('sk', [skipRow]), pair('c1', [pass('size.w')]), pair('c2', [pass('size.w')])],
      { frame: frame([W]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    const iUnchecked = v.blocking.findIndex((b) => b.kind === 'unchecked_spacing');
    const iSkip = v.blocking.findIndex((b) => b.kind === 'skip');
    expect(iUnchecked).toBeGreaterThanOrEqual(0);
    expect(iSkip).toBeGreaterThanOrEqual(0);
    expect(iUnchecked).toBeLessThan(iSkip);
  });

  it('rankOf directly: an unknown future kind → mid rank 8 (not silently sunk into the tail)', () => {
    expect(rankOf({ kind: 'future_kind_x', action: 'noop', detail: '' } as BlockingItem)).toBe(8);
    expect(rankOf({ kind: 'skip', action: 'resolve_skip', detail: '' } as BlockingItem)).toBe(10);
  });

  it('rankOf directly: the aggregate-ness discriminators are pinned to THEIR OWN fields (final M-A: b.places on uncovered — RED)', () => {
    // The symmetry of the rank-7 rows is a copy-paste trap: token looks at places, uncovered at count.
    // The cross-rank lock only proves group>5, NOT group==7 — this unit pins the derivation.
    expect(rankOf({ kind: 'uncovered_region', count: 2, action: 'add_pair', detail: '' } as BlockingItem)).toBe(7);
    expect(rankOf({ kind: 'uncovered_region', action: 'add_pair', detail: '' } as BlockingItem)).toBe(8);
    expect(rankOf({ kind: 'unconfirmed_token', places: [], action: 'confirm_token', detail: '' } as BlockingItem)).toBe(7);
    expect(rankOf({ kind: 'unconfirmed_token', action: 'confirm_token', detail: '' } as BlockingItem)).toBe(8);
  });

  it('stability within a rank: the relative order of same-rank items is preserved', () => {
    const v = buildVerification([pair('s1', [skipRow]), pair('s2', [skipRow])], { depthLevels: 4 });
    expect(v.blocking.filter((b) => b.kind === 'skip').map((b) => b.node_id)).toEqual(['s1', 's2']);
  });

  it('byte lock of texts: the sort does not change detail/kind/action of items (co-lock of content)', () => {
    const v = buildVerification([pair('s1', [skipRow]), pair('t1', [revRow('color')]), pair('t2', [revRow('color')])], { depthLevels: 4 });
    const byKind = Object.fromEntries(v.blocking.map((b) => [b.kind, b]));
    expect(byKind['skip'].detail).toBe('skip');
    expect(byKind['unconfirmed_token'].detail).toContain('×2 places');
  });

  it('count: the uncovered group carries count=N; a singleton — without count', () => {
    const R = sc('R', [scNamed('u1', 'u'), scNamed('u2', 'u'), sc('P')]);
    const Q = sc('Q', [sc('lone'), sc('P2')]);
    const v = buildVerification([pair('P', [pass('size.w')]), pair('P2', [pass('size.w')])],
      { frame: frame([R, Q]), depthLevels: 4, enumeration: { depth: 4, source: 'pair_fetch' } });
    const group = v.blocking.find((b) => b.kind === 'uncovered_region' && b.count !== undefined);
    const single = v.blocking.find((b) => b.kind === 'uncovered_region' && b.count === undefined);
    expect(group?.count).toBe(2);
    expect(single).toBeDefined(); // mutation "count on a singleton" → RED
  });

  // Pretty-mirror lock: report.ts:177-183 inherits the rankOf sort from v.blocking (shared
  // source) — if pretty ever grows its OWN sort/filter (the "mirror desync" class), the high-rank aggregate
  // would stop being visible in the top-15 under a flood. The lock is mutation-verified below:
  // report.ts:178 slice(0,CAP)→slice(-CAP) colors exactly this test.
  it('pretty-mirror: the render top-15 carries the high-rank aggregate under a flood, "… N more" is honest (report.ts:177-183)', () => {
    const skipPairs = Array.from({ length: 45 }, (_, i) => pair(`s${i}`, [{ prop: 'geometry', status: 'skip', note: 'skip' } as DiffRow]));
    const tokenPairs = [pair('t1', [revRow('color')]), pair('t2', [revRow('color')])];
    const v = buildVerification([...skipPairs, ...tokenPairs], { depthLevels: 4 });
    const md = renderReport({ file: 'F', tolerancePx: 1, pairs: [...skipPairs, ...tokenPairs], verification: v });
    const lines = md.split('\n');
    const start = lines.findIndex((l) => l.startsWith('Remaining (blocking,'));
    expect(start).toBeGreaterThanOrEqual(0);
    const shown = lines.slice(start + 1).filter((l) => l.startsWith('- [')).slice(0, 15);
    expect(lines[start]).toContain(`${v.blocking.length + (v.blocking_capped ?? 0)}`); // the header is honest
    expect(shown.some((l) => l.includes('[confirm_token]'))).toBe(true); // the aggregate is in the top-15
    expect(md).toContain('more (full list in verification.blocking)'); // the tail is honestly counted
  });
});


// max_depth is capped at 8 by every schema that accepts it, so "raise max_depth" at 8 is an action
// nobody can carry out: the blocker never clears and verification.complete can never go true on a
// frame deep enough to hit it. Two sibling branches in this file were already guarded this way -
// uncheckedToBlocking swaps to add_text_pair, and the enumeration branch stops emitting a blocker at
// all. This was the last one, and it could not even see the depth: it was the only *ToBlocking that
// was called without it.
describe('a blocking item never names an action the caller cannot carry out', () => {
  const truncatedPair = {
    node_id: '1:1', selector: '.card',
    rows: [{ prop: 'children_truncated', status: 'warn' as const, note: 'the tail of children beyond the cap/depth was not checked' }],
    summary: { pass: 1, fail: 0, warn: 1, skip: 0, info: 0, unchecked: 0, review: 0 },
  } as unknown as Parameters<typeof buildVerification>[0][number];

  const childrenBlockers = (depthLevels: number) =>
    (buildVerification([truncatedPair], { depthLevels }).blocking ?? [])
      .filter((b) => b.kind === 'children_truncated');

  it('below the ceiling it still says raise max_depth, because there it works', () => {
    const b = childrenBlockers(4);
    expect(b).toHaveLength(1);                       // PRESENCE: the arm below is not quantifying over nothing
    expect(b[0].action).toBe('raise_max_depth');
  });

  it('AT the ceiling it names something executable instead', () => {
    const b = childrenBlockers(8);
    expect(b).toHaveLength(1);                       // still blocking - the hole is real, only the advice changed
    expect(b[0].action).toBe('add_pairs_on_children');
    expect(b[0].detail).toContain('maximum capture depth');
    expect(buildVerification([truncatedPair], { depthLevels: 8 }).complete).toBe(false);
  });
});

// ── exclude_regions — a coverage DEMAND is removable, a MEASUREMENT never is (spec p.4 + panel) ──
describe('exclude_regions', () => {
  const rectX = (x: number, y: number, w = 10, h = 10): SpecRect => ({ x, y, w, h });
  const scR2 = (id: string, r: SpecRect, opts: ScOpts = {}): SpecChild => ({ ...sc(id, undefined, opts), rect: r }) as SpecChild;
  const cap2 = (ref: string, r: SpecRect): CaptureInfo => ({ ref, rect: r, geometryUnchecked: false });
  const base = { depthLevels: 4, enumeration: meta('pair_fetch', 4) } as const;

  it('repro: 2 of 4 regions paired, the other 2 excluded → complete true, excluded listed by id', () => {
    const v = buildVerification([pair('A', [pass('size.w')]), pair('B', [pass('size.w')])],
      { ...base, frame: frame([sc('A'), sc('B'), sc('C'), sc('D')]), excludeRegions: ['C', 'D'] });
    expect(v.frame_coverage).toMatchObject({ worthy: 2, covered: 2, uncovered: [], excluded: ['C', 'D'] });
    expect(v.complete).toBe(true);
    expect(v.blocking).toEqual([]);
  });
  it('control: the same call without exclusions stays red and names both regions', () => {
    const v = buildVerification([pair('A', [pass('size.w')]), pair('B', [pass('size.w')])],
      { ...base, frame: frame([sc('A'), sc('B'), sc('C'), sc('D')]) });
    expect(v.complete).toBe(false);
    expect(v.frame_coverage?.uncovered.sort()).toEqual(['C', 'D']);
  });

  // Panel CRITICAL: the partial gates count PAIRED children; a naive exclusion dropped the count
  // below 2, the audit never ran, and a measured-in-principle gap fail went red→green with both
  // rects in captures. Resolution: touched-ness is UNCHANGED by exclusion — only demands go.
  it('CRITICAL lock: excluding a PAIRED sibling does not disarm the frame partial gate — the audit fail survives', () => {
    const A = scR2('A', rectX(0, 0));
    const B = scR2('B', rectX(0, 24)); // Figma gap 14
    const fr = frame([A, B], { axis: 'col' });
    const captures = new Map<string, CaptureInfo>([
      ['A', cap2('b1', rectX(0, 0))],
      ['B', cap2('b1', rectX(0, 40))], // DOM gap 30 — a real defect between the siblings
    ]);
    const v = buildVerification([pair('A', [pass('size.w')]), pair('B', [pass('size.w')])],
      { ...base, frame: fr, captures, excludeRegions: ['B'] });
    expect(v.frame_coverage?.partial).toContain('F:0'); // the frame-as-container gate fired
    expect(v.blocking.some((b) => b.kind === 'spacing_mismatch')).toBe(true);
    const md = renderReport({ file: 'f', tolerancePx: 1,
      pairs: [pair('A', [pass('size.w')]), pair('B', [pass('size.w')])], verification: v });
    expect(md).toContain('discrepancies found');
  });

  it('nested: an excluded unpaired child raises no demand; a non-excluded unpaired sibling still does', () => {
    const R = sc('R', [sc('C1'), sc('C2'), sc('C3')]);
    const v = buildVerification([pair('C2', [pass('size.w')])],
      { ...base, frame: frame([R]), excludeRegions: ['C1'] });
    expect(v.frame_coverage?.uncovered).toEqual(['C3']);
    expect(v.frame_coverage?.excluded).toEqual(['C1']);
    expect(v.blocking.some((b) => b.node_id === 'C1')).toBe(false);
  });

  it('a pair inside an excluded region still covers its parent — measurement facts survive exclusion', () => {
    // P carries TWO children so it stays its own worthy region (a single-child P would unwrap into
    // one chain with A2 and the exclusion would cut the whole region — a different, valid case).
    const P = sc('P', [sc('A2'), sc('B2')]);
    const v = buildVerification([pair('A2', [pass('size.w')])],
      { ...base, frame: frame([P, sc('D2')]), excludeRegions: ['A2'] });
    // P is covered THROUGH the excluded-but-paired child; B2 and D2 keep their demands.
    expect(v.frame_coverage?.uncovered.sort()).toEqual(['B2', 'D2']);
    expect(v.frame_coverage?.covered).toBe(1);
  });

  it('wrapper chain: excluding the wrapper id excludes the region, excluded[] carries the terminal id', () => {
    const wrapped = sc('W', [sc('T')]); // W unwraps to T (single-child chain)
    const v = buildVerification([pair('A', [pass('size.w')])],
      { ...base, frame: frame([sc('A'), wrapped]), excludeRegions: ['W'] });
    expect(v.frame_coverage?.excluded).toEqual(['T']);
    expect(v.frame_coverage?.uncovered).toEqual([]);
    expect(v.complete).toBe(true);
  });

  it('an unknown id is loud and non-blocking: excluded_not_found + a note naming the three causes', () => {
    const v = buildVerification([pair('A', [pass('size.w')])],
      { ...base, frame: frame([sc('A')]), excludeRegions: ['99:999'] });
    expect(v.frame_coverage?.excluded_not_found).toEqual(['99:999']);
    expect(v.complete).toBe(true); // a missed exclusion hid nothing
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair('A', [pass('size.w')])], verification: v });
    expect(md).toMatch(/not found among coverage regions/);
  });

  it('the frame root is not a legal exclusion: not_found + its own note, the frame partial gate survives', () => {
    const A = scR2('A3', rectX(0, 0));
    const B = scR2('B3', rectX(0, 24));
    const fr = frame([A, B], { axis: 'col' });
    const v = buildVerification([pair('A3', [pass('size.w')]), pair('B3', [pass('size.w')])],
      { ...base, frame: fr, excludeRegions: ['F:0'] });
    expect(v.frame_coverage?.excluded_not_found).toEqual(['F:0']);
    expect(v.frame_coverage?.partial).toContain('F:0'); // thread-A gate not suppressed
    expect((v.notes ?? []).some((n) => n.includes('frame root cannot be excluded'))).toBe(true);
  });

  it('vacuum: excluding every worthy region leaves complete to the pairs and says so', () => {
    const v = buildVerification([pair('A4', [pass('size.w')])],
      { ...base, frame: frame([sc('B4'), sc('C4')]), excludeRegions: ['B4', 'C4'] });
    expect(v.frame_coverage?.worthy).toBe(0);
    expect(v.complete).toBe(true);
    expect((v.notes ?? []).some((n) => n.includes('whole frame'))).toBe(true); // mutation lock on the warn
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair('A4', [pass('size.w')])], verification: v });
    expect(md).toContain('excluded by the caller');
  });

  it('frame_missing: exclusions are neither applied nor reported', () => {
    const v = buildVerification([pair('A', [pass('size.w')])],
      { ...base, frameRequested: true, excludeRegions: ['C'] });
    expect(v.blocking.some((b) => b.kind === 'frame_missing')).toBe(true);
    expect(v.frame_coverage).toBeUndefined();
    expect(v.notes ?? []).toEqual([]);
  });

  it('exclusions without a frame are loudly noted, never silently ignored', () => {
    const v = buildVerification([pair('A', [pass('size.w')])], { ...base, excludeRegions: ['C'] });
    expect((v.notes ?? []).some((n) => n.includes('no frame was given'))).toBe(true);
  });

  it('the dash form normalizes: 12-340 excludes 12:340', () => {
    const v = buildVerification([pair('A', [pass('size.w')])],
      { ...base, frame: frame([sc('A'), sc('12:340')]), excludeRegions: ['12-340'] });
    expect(v.frame_coverage?.excluded).toEqual(['12:340']);
    expect(v.complete).toBe(true);
  });

  it('the report shows exclusions even on the COMPLETE branch — green never hides them', () => {
    const v = buildVerification([pair('A', [pass('size.w')])],
      { ...base, frame: frame([sc('A'), sc('X')]), excludeRegions: ['X'] });
    expect(v.complete).toBe(true);
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [pair('A', [pass('size.w')])], verification: v });
    expect(md).toContain('excluded by the caller: 1');
  });
});

// ── p.7 carrier notes gate complete (adversarial-pass blocker: a warn here was a terminal green hole) ──
describe('typography carrier notes gate the machine verdict', () => {
  it('"carries none" → complete false, resolve_skip (nothing deeper exists, no text to pair)', () => {
    const v = buildVerification([pairFromRows([{ prop: 'typography[Button]', status: 'unchecked',
      note: 'the Figma node carries text, the captured DOM subtree carries none - the text is missing or lives outside this element; fix the pair or verify by eye' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking).toMatchObject([{ kind: 'skip', action: 'resolve_skip' }]);
  });
  it('"several nested text carriers" → add_text_pair at ANY depth (both are already captured — depth resolves nothing)', () => {
    const v = buildVerification([pairFromRows([{ prop: 'typography[Button]', status: 'unchecked',
      note: 'the DOM side has several nested text carriers - metrics not attributed; add a pair on the text node' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking).toMatchObject([{ kind: 'skip', action: 'add_text_pair' }]);
  });
  it('the beyond-cut carrier note keeps the depth-aware default (raise below 8)', () => {
    const v = buildVerification([pairFromRows([{ prop: 'typography[Button]', status: 'unchecked',
      note: 'the Figma node carries text, but no DOM text was captured and the subtree was truncated - the carrier may be beyond the slice: re-extract deeper or add a pair on the text node' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking).toMatchObject([{ kind: 'truncated_text', action: 'raise_max_depth' }]);
  });
});

// ── semantic-diverged: a POSITIVE codeSyntax collision gates even when the row values (hexes)
// are byte-equal — the one review reason exempt from the rowValuesMatched advisory demotion.
describe('semantic-diverged gates through the matched-value demotion', () => {
  it('matched-value semantic-diverged row → blocking non-empty, complete false', () => {
    const v = buildVerification([pairFromRows([{ prop: 'fill', figma: '#111111', dom: '#111111',
      status: 'review', note: 'wiring diverges', token: 'bg/x', tokenReason: 'semantic-diverged', domToken: '--ds-other' }])], { depthLevels: 4 });
    expect(v.complete).toBe(false);
    expect(v.blocking.some((b) => b.kind === 'unconfirmed_token')).toBe(true);
  });
  it('multi-place aggregation detail names the DISTINCT dom vars', () => {
    const p1 = pairFromRows([{ prop: 'fill', figma: '#111111', dom: '#111111',
      status: 'review', note: 'wiring diverges A', token: 'bg/x', tokenReason: 'semantic-diverged', domToken: '--a' }]);
    const p2 = pairFromRows([{ prop: 'fill', figma: '#222222', dom: '#222222',
      status: 'review', note: 'wiring diverges B', token: 'bg/x', tokenReason: 'semantic-diverged', domToken: '--b' }]);
    const v = buildVerification([p1, p2], { depthLevels: 4 });
    const toks = v.blocking.filter((b) => b.kind === 'unconfirmed_token');
    expect(toks).toHaveLength(1);
    const detail = (toks[0] as { detail?: string }).detail ?? '';
    expect(detail).toContain('--a');
    expect(detail).toContain('--b');
  });
  it('report mirror: the same matched-value semantic-diverged row lowers the Verdict (awaiting confirmation)', () => {
    const p = pairFromRows([{ prop: 'fill', figma: '#111111', dom: '#111111',
      status: 'review', note: 'wiring diverges', token: 'bg/x', tokenReason: 'semantic-diverged', domToken: '--ds-other' }]);
    const v = buildVerification([p], { depthLevels: 4 });
    const md = renderReport({ file: 'F', tolerancePx: 1, pairs: [p], depthLevels: 4, verification: v });
    expect(md).toContain('awaiting token confirmation');
  });
});
