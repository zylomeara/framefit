// mcp-server/tests/unit/layout-spec-match-profiles.test.ts
// match-profiles: schema + tolerance resolution + structTol decoupling of the structural detectors.
import { describe, it, expect, vi } from 'vitest';
import {
  registerCompareNodeToDomTool,
  resolveTolerance,
  buildFixPlan,
  type MatchProfile,
} from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import {
  diffPair, deriveCoverage, coverageHoleRows, dimensionOf, summarize,
  LAYOUT_VISUAL_DIMS, PROFILE_PASS_THROUGH, applyLayoutProfileScope,
} from '../../src/domain/layout-spec/diff.js';
import { buildVerification, rankOf } from '../../src/domain/layout-spec/verification.js';
import { auditContainer, type AuditKid } from '../../src/domain/layout-spec/spacing-audit.js';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import type { LayoutSpec, DomSnapshotOk, SpecChild, DomChild, DiffRow, PairResult, CaptureInfo, VerificationReceipt } from '../../src/domain/layout-spec/types.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode, RawVariablesResponse } from '../../src/domain/figma-raw.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

// ─────────────────────────────────────────────────────────────────────────────
// resolveTolerance — the resolution unit (omitted-vs-explicit is distinguishable, since the schema
// does NOT carry a zod default). Rule: strict + an explicit tolerance_px is a validation error.
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles — resolveTolerance', () => {
  it('(strict, undefined) → 0 (no error)', () => {
    expect(resolveTolerance('strict', undefined)).toBe(0);
  });
  it('(strict, 0) → 0 (an explicit 0 does not contradict strict)', () => {
    expect(resolveTolerance('strict', 0)).toBe(0);
  });
  it('(strict, 2) → throws with "contradiction"', () => {
    expect(() => resolveTolerance('strict', 2)).toThrow(/strict.*contradiction/i);
    // exact message: substring anchors (the number N, "remove tolerance_px", "token-aware")
    try { resolveTolerance('strict', 2); } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('2px');
      expect(m).toContain('remove tolerance_px');
      expect(m).toContain('token-aware');
    }
  });
  it('(token-aware, undefined) → 1 (default-in-code)', () => {
    expect(resolveTolerance('token-aware', undefined)).toBe(1);
  });
  it('(token-aware, 3) → 3 (the explicit value is respected)', () => {
    expect(resolveTolerance('token-aware', 3)).toBe(3);
  });
  it('(token-aware, 0) → 0 (an explicit 0 is respected, not overwritten by the ?? 1 default)', () => {
    expect(resolveTolerance('token-aware', 0)).toBe(0);
  });
  it('(layout, undefined) → 1; (layout, 3) → 3 (layout behaves like token-aware on tolerance)', () => {
    expect(resolveTolerance('layout', undefined)).toBe(1);
    expect(resolveTolerance('layout', 3)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diffPair fixtures (mirror of layout-spec-diff.test.ts).
// ─────────────────────────────────────────────────────────────────────────────
const spec = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '1:1', name: 'card', type: 'FRAME' },
  rect: { x: 0, y: 0, w: 343, h: 120 }, axis: 'col',
  children: [
    { id: '1:2', name: 'title', type: 'TEXT', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { id: '1:3', name: 'list', type: 'FRAME', rect: { x: 16, y: 56, w: 311, h: 40 } },
  ],
  ...over,
});
const snap = (over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 120 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, transformed: false,
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 120, scrollHeight: 120,
  children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 84, w: 311, h: 40 } },
  ],
  ...over,
});

// nested-TEXT children (mirror of the reorder fixtures in layout-spec-diff.test.ts) — the anchor map is built
// from the child's own textSnippet (buildNestedAnchorMap includeOwnText).
const inst = (id: string, t: string, x: number): SpecChild => ({ id, name: id, type: 'INSTANCE',
  rect: { x, y: 0, w: 100, h: 40 }, children: [{ id: `${id}t`, name: t, type: 'TEXT',
  rect: { x, y: 0, w: 90, h: 18 }, textSnippet: t }] }) as SpecChild;
const domI = (t: string, x: number): DomChild => ({ kind: 'element', tag: 'article',
  rect: { x, y: 0, w: 100, h: 40 }, children: [{ kind: 'element', tag: 'span',
  rect: { x, y: 0, w: 90, h: 18 }, text: t }] }) as DomChild;

const has = (rows: ReturnType<typeof diffPair>, prop: string): boolean => rows.some((r) => r.prop === prop);
const rowOf = (rows: ReturnType<typeof diffPair>, prop: string) => rows.find((r) => r.prop === prop);

// ─────────────────────────────────────────────────────────────────────────────
// (b): the MEASUREMENT site (size.w numRow) reads the RAW tol — strict tightens measurements.
// Δ=0.5 → fail at tolerancePx 0 / pass at 1. Also a lock "size is NOT clamped to structTol": if
// size.w read structTol=1, it would pass even at 0 → the test would catch an over-clamp of the measurement.
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles — measurement (size) under the raw tol', () => {
  const leafSpec = spec({ axis: undefined, rect: { x: 0, y: 0, w: 100, h: 100 }, children: [] });
  const leafDom = snap({ rect: { x: 0, y: 0, w: 100.5, h: 100 }, clientWidth: 100.5, clientHeight: 100, scrollHeight: 100, children: [] });

  it('Δ=0.5 → size.w FAIL at tolerancePx 0 (strict tightens the measurement)', () => {
    const rows = diffPair(leafSpec, leafDom, { tolerancePx: 0 });
    expect(rowOf(rows, 'size.w')?.status).toBe('fail');
  });
  it('Δ=0.5 → size.w PASS at tolerancePx 1 (token-aware sanity; size is a measurement, not structTol)', () => {
    const rows = diffPair(leafSpec, leafDom, { tolerancePx: 1 });
    expect(rowOf(rows, 'size.w')?.status).toBe('pass');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c): STRUCTURAL detectors are clamped to structTol=max(tol,1) — under strict tol=0 sub-pixel
// fractions do NOT tear the layout apart. Mutation locks (verified live): "structTol=tol" → these tests RED.
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles — structural detectors under strict (structTol clamp)', () => {
  // children_reorder cushion (tieAt): two near-tied (main-start 0.3px) children, sub-pixel
  // reordered between the sides. At structTol=1 they're tied → the detector stays silent (a correct
  // layout within a fraction). Mutation "cushion=tol" under tol=0: the tie breaks → a false reorder.
  // The dom document order is MONOTONIC (Beta@100.0, Alpha@100.3) → the monotonicity guard does not interfere,
  // isolating exactly on the detector's cushion.
  const reorderSpec = spec({ rect: { x: 0, y: 0, w: 220, h: 40 }, axis: 'row',
    children: [inst('1:1', 'Alpha', 100.0), inst('1:2', 'Beta', 100.3)] });
  const reorderDom = snap({ rect: { x: 0, y: 0, w: 220, h: 40 }, clientWidth: 220, clientHeight: 40, scrollHeight: 40,
    children: [domI('Beta', 100.0), domI('Alpha', 100.3)] });

  it('reorder-cushion: near-tied fractions, a correct layout → NO children_reorder at tolerancePx 0 (structTol=1 mutes)', () => {
    const rows = diffPair(reorderSpec, reorderDom, { tolerancePx: 0 });
    expect(has(rows, 'children_reorder')).toBe(false);   // mutation "cushion=tol" → children_reorder appears → RED
    expect(has(rows, 'layout_axis_mismatch')).toBe(false); // sanity: the monotonicity guard did not interfere
  });

  it('reorder-cushion: the same input at tolerancePx 1 (default) → also NO reorder (byte-for-byte with the prior)', () => {
    const rows = diffPair(reorderSpec, reorderDom, { tolerancePx: 1 });
    expect(has(rows, 'children_reorder')).toBe(false);
  });

  // monotonicity guard (:508): the dom document order is sub-pixel non-monotonic ([X@100.3, X@100.0]).
  // Identical text 'X' on both → an anchor collision → the reorder detector stays silent (isolation on the guard).
  // structTol=1: 100.0 < 100.3-1 = 99.3 → false → no layout_axis_mismatch. Mutation "structTol=tol"
  // under tol=0: 100.0 < 100.3 → true → a false layout_axis_mismatch.
  const monoSpec = spec({ rect: { x: 0, y: 0, w: 220, h: 40 }, axis: 'row',
    children: [inst('1:1', 'X', 100.0), inst('1:2', 'X', 100.3)] });
  const monoDom = snap({ rect: { x: 0, y: 0, w: 220, h: 40 }, clientWidth: 220, clientHeight: 40, scrollHeight: 40,
    children: [domI('X', 100.3), domI('X', 100.0)] });

  it('monotonicity guard: sub-pixel non-monotonicity of the document order → NO layout_axis_mismatch at tolerancePx 0 (structTol=1)', () => {
    const rows = diffPair(monoSpec, monoDom, { tolerancePx: 0 });
    expect(has(rows, 'layout_axis_mismatch')).toBe(false); // mutation "structTol=tol" → layout_axis_mismatch appears → RED
    expect(has(rows, 'children_reorder')).toBe(false);     // sanity: identical text → the detector stays silent
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool harness (mirror of compare-node-to-dom-tool.test.ts).
// ─────────────────────────────────────────────────────────────────────────────
const logger = createLogger({ level: 'silent' });
const emptyVars: RawVariablesResponse = { meta: { variables: {}, variableCollections: {} } };

function harness(api: Partial<FigmaApi>, maxResultChars = 40000, extra: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars, ...extra };
  registerCompareNodeToDomTool(server, deps);
  return (a: any): Promise<any> => call('compare_node_to_dom', a);
}

// card 343×120 VERTICAL, 2 children; okDom with a diverging gap (figma 20 / dom 48) → gap-fail + size-pass
// = a variety of rows (rows/summary/coverage/verification/markdown are non-trivial for the twin).
const card: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 },
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [
    { id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: { x: 16, y: 12, width: 200, height: 24 } },
    { id: '1:3', name: 'list', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 40 } },
  ],
};
const okDom = {
  schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false,
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 120, scrollHeight: 120,
  children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 84, w: 311, h: 40 } },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// (d): BYTE TWIN. A call WITHOUT tolerance_px AND WITHOUT match_profile must give EXACTLY the same
// rows/summary/coverage/verification as an explicit tolerance_px:1, + top-level tolerance_px===1 +
// header "tolerance 1px". The twin OMITS BOTH — otherwise the default-in-code path is not executed and a mutation
// "the site reads the raw args.tolerance_px" would survive (raw undefined → diffPair NaN failures / header
// "tolerance undefinedpx" / top-level tolerance_px:undefined). Invariant: "rows/summary/
// coverage byte-for-byte on the default".
describe('match-profiles — byte twin (omitted ⟺ explicit tolerance_px:1)', () => {
  it('omitted tolerance_px+match_profile == explicit tolerance_px:1 (rows/summary/coverage/verification), tolerance_px===1, header "tolerance 1px"', async () => {
    const mkApi = () => ({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: card } } })), getVariablesLocal: vi.fn(async () => emptyVars) });
    const runOmit = harness(mkApi());
    const runExplicit = harness(mkApi());

    const omitOut = JSON.parse((await runOmit({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }] })).content[0].text);
    const explicitOut = JSON.parse((await runExplicit({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }, ] , tolerance_px: 1 })).content[0].text);

    // byte-for-byte on the NON-additive axes (pairs = rows/summary/coverage/source, verification)
    expect(omitOut.pairs).toEqual(explicitOut.pairs);
    expect(omitOut.verification).toEqual(explicitOut.verification);
    expect(omitOut.summary).toEqual(explicitOut.summary);
    // the top-level field + the header reflect the RESOLVED 1
    expect(omitOut.tolerance_px).toBe(1);
    expect(omitOut.report_markdown).toContain('tolerance 1px');
    // sanity: the twin is really non-trivial (there is a pair with coverage and at least one gap-fail)
    expect(omitOut.pairs[0].coverage).toBeDefined();
    expect(omitOut.pairs[0].rows.some((r: any) => r.prop.startsWith('gap') && r.status === 'fail')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (a-tool): resolution INSIDE the runTool callback — strict+explicit>0 → {isError:true} (not an uncaught SDK).
// strict without tolerance → tolerance_px:0 + header "tolerance 0px". Lock "silent tolerance priority
// under strict" (mutation: strict would return raw instead of throwing → no isError → RED).
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles — tool provenance of the profile', () => {
  const mkApi = () => ({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: card } } })), getVariablesLocal: vi.fn(async () => emptyVars) });

  it('match_profile:strict + tolerance_px:2 → isError with "contradiction"', async () => {
    const run = harness(mkApi());
    const res = await run({ file: 'abc', match_profile: 'strict', tolerance_px: 2, pairs: [{ node_id: '1:1', dom: okDom }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('contradiction');
    expect(res.content[0].text).toContain('2px');
  });

  it('match_profile:strict without tolerance_px → tolerance_px:0 + header "tolerance 0px" (no error)', async () => {
    const run = harness(mkApi());
    const res = await run({ file: 'abc', match_profile: 'strict', pairs: [{ node_id: '1:1', dom: okDom }] });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text);
    expect(out.tolerance_px).toBe(0);
    expect(out.report_markdown).toContain('tolerance 0px');
  });

  it('match_profile:token-aware explicit == default (omitted): tolerance_px===1', async () => {
    const run = harness(mkApi());
    const out = JSON.parse((await run({ file: 'abc', match_profile: 'token-aware', pairs: [{ node_id: '1:1', dom: okDom }] })).content[0].text);
    expect(out.tolerance_px).toBe(1);
  });
});

// Type-level lock: MatchProfile — three allowed literals (compile-time, no-op at runtime).
const _profiles: MatchProfile[] = ['strict', 'layout', 'token-aware'];
void _profiles;

// ═════════════════════════════════════════════════════════════════════════════
// Layout profile: layout scope (axis registry + profileScoped skips) + the MACHINE honesty gate
// (sentinel scope_incomplete).
// ═════════════════════════════════════════════════════════════════════════════

// A collapsible fixture: typography (font-*), text color, fill, corner-radius, component —
// on top of the usual allowlist geometry (size/gap/padding/offset-cross). All geometric axes pass.
const t2Spec = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '2:1', name: 'promo', type: 'FRAME' },
  rect: { x: 0, y: 0, w: 343, h: 120 }, axis: 'col',
  fillHex: '#111111', cornerRadius: 8,
  component: { id: 'c1', name: 'PromoCard', setName: 'PromoCard' },
  children: [
    { id: '2:2', name: 'title', type: 'TEXT', rect: { x: 16, y: 12, w: 200, h: 24 },
      text: { fontSize: 16, fontWeight: 700, fontFamily: 'Inter', colorHex: '#ff0000' } },
    { id: '2:3', name: 'list', type: 'FRAME', rect: { x: 16, y: 56, w: 311, h: 40 } },
  ],
  ...over,
});
const t2Dom = (over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => snap({
  styles: { backgroundColor: '#222222', borderRadius: 8 },
  componentHints: { tag: 'div', classList: ['promo-card'], data: {} },
  children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 },
      styles: { fontSize: 16, fontWeight: 400, fontFamily: 'Inter', color: '#00ff00' },
      // p.7 migration: the carrier routing compares wrappers no more - the title owns its text
      children: [{ kind: 'text', rect: { x: 16, y: 12, w: 200, h: 24 }, text: 'Title' }] },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 40 } },
  ],
  ...over,
});

const pairRes = (id: string, rows: DiffRow[]): PairResult =>
  ({ node_id: id, rows, summary: summarize(rows), coverage: deriveCoverage(rows) });

// ─────────────────────────────────────────────────────────────────────────────
// (a): profile-skip — collapsing non-layout axes per-dim (the typography family → ONE
// 'typography' skip), coverage.skipped carries {dim, reason, profileScoped}.
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (a) profile-skip: collapsing non-layout axes', () => {
  const tokenRows = diffPair(t2Spec(), t2Dom(), { tolerancePx: 1 });
  const layoutRows = diffPair(t2Spec(), t2Dom(), { tolerancePx: 1, profile: 'layout' });

  it('token-aware sanity: font-weight fail and fill fail are alive in the fixture', () => {
    expect(tokenRows.some((r) => r.prop.startsWith('font-weight') && r.status === 'fail')).toBe(true);
    expect(rowOf(tokenRows, 'fill')?.status).toBe('fail');
  });

  // Final F1: the scope-dispatch gate is mutation-locked — collapsing works EXACTLY under layout.
  // The mutant `profile === 'layout' || profile === 'strict'` gave a LIVE false-green: the fill-fail
  // silently collapsed into a profileScoped skip, but there is no sentinel under strict → complete:true on
  // a screen with a real color defect. No prior lock caught this (the whole suite passed around it).
  it('F1 strict/token-aware NEVER collapse: style-fails are alive, no profileScoped rows', () => {
    for (const profile of ['strict', 'token-aware'] as const) {
      const rows = diffPair(t2Spec(), t2Dom(), { tolerancePx: profile === 'strict' ? 0 : 1, profile });
      expect(rows.some((r) => r.profileScoped), profile).toBe(false);         // NO collapsing
      expect(rowOf(rows, 'fill')?.status, profile).toBe('fail');              // the color defect is alive
      expect(rows.some((r) => r.prop.startsWith('font-weight') && r.status === 'fail'), profile).toBe(true);
    }
  });

  it('layout: NO font-*/color rows; there is EXACTLY ONE profileScoped typography skip', () => {
    expect(layoutRows.some((r) => r.prop.startsWith('font-'))).toBe(false);
    expect(layoutRows.some((r) => r.prop.startsWith('color['))).toBe(false); // no measured color rows (the skip carries a bare dim)
    const t = layoutRows.filter((r) => r.prop === 'typography');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: 'skip', profileScoped: true });
    expect(t[0].note).toContain('outside the layout profile');
    expect(t[0].note).toContain('token-aware');
  });

  it('layout: fill/border-radius/component/color collapsed per-dim into separate skips', () => {
    for (const dim of ['fill', 'border-radius', 'component', 'color']) {
      const row = rowOf(layoutRows, dim);
      expect(row?.status).toBe('skip');
      expect(row?.profileScoped).toBe(true);
    }
    expect(has(layoutRows, 'corner-radius')).toBe(false); // the original row is gone, the skip carries the dim
  });

  it('layout: allowlist geometry is alive (size/gap/padding/offset-cross)', () => {
    expect(rowOf(layoutRows, 'size.w')?.status).toBe('pass');
    expect(layoutRows.some((r) => r.prop.startsWith('gap['))).toBe(true);
    expect(layoutRows.some((r) => r.prop.startsWith('padding-'))).toBe(true);
    expect(layoutRows.some((r) => r.prop.startsWith('offset-cross'))).toBe(true);
  });

  it('deriveCoverage: the profileScoped branch BEFORE the generic skip → skipped carries {dim, reason, profileScoped:true}', () => {
    const cov = deriveCoverage(layoutRows);
    const typo = cov.skipped.find((s) => s.dim === 'typography');
    expect(typo).toMatchObject({ profileScoped: true });
    expect(typo?.reason).toContain('outside the layout profile');
    expect(cov.skipped.filter((s) => s.profileScoped === true).map((s) => s.dim).sort())
      .toEqual(['border-radius', 'color', 'component', 'fill', 'typography']);
    expect(cov.measured).toContain('size');
    expect(cov.measured).toContain('gap');
    expect(cov.measured).not.toContain('fill');
    expect(cov.measured).not.toContain('font-weight');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATUS gate: ONLY measured statuses collapse (pass/fail/warn/info/review);
// skip/unchecked — environmental trust channels — NEVER (mutation "status gate removed" → RED).
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — STATUS gate: skip/unchecked never collapse', () => {
  it('layout: typography[title]-unchecked (DOM without computed styles) is ALIVE, the neighboring fill is collapsed', () => {
    const dom = t2Dom({ children: [
      // p.7 migration: the node owns its (styles-less) text, so the row stays the same unchecked
      { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 },
        children: [{ kind: 'text', rect: { x: 16, y: 12, w: 200, h: 24 }, text: 'Title' }] }, // WITHOUT styles → unchecked
      { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 40 } },
    ] });
    const rows = diffPair(t2Spec(), dom, { tolerancePx: 1, profile: 'layout' });
    const unc = rows.find((r) => r.prop === 'typography[title]');
    expect(unc?.status).toBe('unchecked');
    expect(unc?.profileScoped).toBeUndefined();
    expect(rows.some((r) => r.prop === 'fill' && r.profileScoped === true)).toBe(true); // the filter worked alongside
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b): pass-through UNCONDITIONALLY — meta (COVERAGE_META) and geometry survive layout
// with THEIR OWN status. Mutations "meta into collapsing" / "geometry into collapsing" → RED.
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (b) pass-through: meta and geometry survive layout', () => {
  it('layout_axis_mismatch fail is ALIVE under layout', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 220, h: 40 }, axis: 'row',
      children: [inst('1:1', 'A', 0), inst('1:2', 'B', 100)] });
    const d = snap({ rect: { x: 0, y: 0, w: 220, h: 40 }, clientWidth: 220, clientHeight: 40, scrollHeight: 40,
      children: [domI('B', 100), domI('A', 0)] });
    const rows = diffPair(s, d, { tolerancePx: 1, profile: 'layout' });
    expect(rowOf(rows, 'layout_axis_mismatch')?.status).toBe('fail');
  });

  it('CATEGORY, not status: a hypothetical measured geometry row survives layout (union {geometry})', () => {
    // The differ today emits geometry only as unchecked (the status gate duplicates the protection) — a direct lock
    // on the union: measured geometry survives ONLY via PROFILE_PASS_THROUGH ∋ 'geometry'.
    // Mutation "geometry outside the union" → the row would collapse → RED.
    const rows: DiffRow[] = [{ prop: 'geometry', status: 'warn', note: 'a hypothetical measured env signal' }];
    expect(applyLayoutProfileScope(rows)).toEqual(rows);
  });

  it('geometry-unchecked (window ≠ frame) is ALIVE under layout + dominant_blocker is alive', () => {
    const mk = () => diffPair(spec(), snap(), { tolerancePx: 1, profile: 'layout', frameWidth: 800 });
    const rows1 = mk(); const rows2 = mk();
    const g = rowOf(rows1, 'geometry');
    expect(g?.status).toBe('unchecked');
    expect(g?.figma).toBe(800);
    expect(g?.dom).toBe(375);
    const v = buildVerification([pairRes('1:1', rows1), pairRes('1:9', rows2)],
      { frameRequested: false, depthLevels: 4, matchProfile: 'layout' });
    expect(v.dominant_blocker).toEqual({ kind: 'viewport', pairs: 2, window: 375, frame: 800 });
    expect(v.complete).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c): FILTERED subsequence assert — the allowlist∪PASS_THROUGH slice of rows is identical
// between profiles; the fixture MUST carry ≥1 collapsible axis (otherwise the assert is vacuous).
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (c) layout geometry == token-aware (filtered subsequence)', () => {
  it('rows over allowlist∪PASS_THROUGH byte-for-byte; a collapsible axis is present in the fixture', () => {
    const tokenRows = diffPair(t2Spec(), t2Dom(), { tolerancePx: 1 });
    const layoutRows = diffPair(t2Spec(), t2Dom(), { tolerancePx: 1, profile: 'layout' });
    expect(layoutRows.some((r) => r.profileScoped === true)).toBe(true); // a mandatory collapsible axis
    const pred = (r: DiffRow): boolean =>
      LAYOUT_VISUAL_DIMS.has(dimensionOf(r.prop)) || PROFILE_PASS_THROUGH.has(dimensionOf(r.prop));
    expect(layoutRows.filter(pred)).toEqual(tokenRows.filter(pred));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d1): clean allowlist geometry → blocking === [sentinel] as the ONLY item,
// complete === false (mutation "no sentinel" → RED: blocking empty / complete true).
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (d1) machine gate: clean geometry does not give complete', () => {
  const cleanDom = snap({ children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 40 } },
  ] });

  it('layout: blocking === [scope_incomplete/run_token_aware], complete === false, receipt.match_profile', () => {
    const rows = diffPair(spec(), cleanDom, { tolerancePx: 1, profile: 'layout' });
    expect(rows.every((r) => r.status === 'pass')).toBe(true); // sanity: clean geometry
    const v = buildVerification([pairRes('1:1', rows)], { frameRequested: false, depthLevels: 4, matchProfile: 'layout' });
    expect(v.blocking).toHaveLength(1);
    expect(v.blocking[0].kind).toBe('scope_incomplete');
    expect(v.blocking[0].action).toBe('run_token_aware');
    expect(v.blocking[0].detail).toContain('token-aware');
    expect(v.complete).toBe(false);
    expect(v.match_profile).toBe('layout');
  });

  it('token-aware on the same input: complete === true, blocking empty (the gate is a profile property)', () => {
    const rows = diffPair(spec(), cleanDom, { tolerancePx: 1 });
    const v = buildVerification([pairRes('1:1', rows)], { frameRequested: false, depthLevels: 4, matchProfile: 'token-aware' });
    expect(v.complete).toBe(true);
    expect(v.blocking).toEqual([]);
    expect(v.match_profile).toBe('token-aware');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d2): the ranked lock. The golden rule: the sentinel is pushed LAST, rank 0 —
// the sort MUST move it first. Mutation "rankOf default" (case removed → 8) → the sentinel
// stays AFTER a rank-equal unconfirmed_token (stable sort) → RED.
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (d2) sentinel ranked lock', () => {
  it('rankOf(scope_incomplete) === 0 — a unique minimum (strictly below frame_missing=1)', () => {
    expect(rankOf({ kind: 'scope_incomplete', action: 'run_token_aware', detail: '' })).toBe(0);
    expect(rankOf({ kind: 'frame_missing', action: 'fix_frame_id', detail: '' })).toBe(1);
  });

  it('environmental holes of rank ≥8 are pushed EARLIER, the sentinel LAST → blocking[0] = scope_incomplete', () => {
    const review: DiffRow = { prop: 'color', status: 'review', note: 'confirm the token', token: 'text/primary', tokenReason: 'semantic-confirm' };
    const envSkip: DiffRow = { prop: 'size.h', status: 'skip', note: 'scroll container: height uninformative' };
    const v = buildVerification(
      [pairRes('3:1', [review]), pairRes('3:2', [envSkip]), pairRes('3:3', [envSkip])],
      { frameRequested: false, depthLevels: 4, matchProfile: 'layout' });
    expect(v.blocking.map((b) => b.kind)).toEqual(['scope_incomplete', 'unconfirmed_token', 'skip', 'skip']);
    expect(v.complete).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e): profile-skips are NOT coverage holes: coverageHoleRows excludes them,
// blocking WITHOUT a resolve_skip flood (mutation "profileScoped into holes" → RED).
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (e) profile-skips outside the hole channel', () => {
  it('coverageHoleRows empty; blocking === [sentinel], no resolve_skip; the pair is clean', () => {
    const layoutRows = diffPair(t2Spec(), t2Dom(), { tolerancePx: 1, profile: 'layout' });
    expect(layoutRows.some((r) => r.profileScoped === true)).toBe(true);
    expect(coverageHoleRows(layoutRows)).toEqual([]);
    const v = buildVerification([pairRes('2:1', layoutRows)], { frameRequested: false, depthLevels: 4, matchProfile: 'layout' });
    expect(v.blocking.some((b) => b.action === 'resolve_skip')).toBe(false);
    expect(v.blocking.map((b) => b.kind)).toEqual(['scope_incomplete']);
    expect(v.pairs.clean).toBe(1); // the scope narrowing does not flood: the pair is clean WITHIN the scope, the gate keeps complete=false
  });

  it('an environmental skip (not profileScoped) REMAINS a hole under layout', () => {
    const scrollDom = t2Dom({ scrollHeight: 400 }); // scroll container → size.h env-skip
    const layoutRows = diffPair(t2Spec(), scrollDom, { tolerancePx: 1, profile: 'layout' });
    const holes = coverageHoleRows(layoutRows);
    expect(holes.some((r) => r.prop === 'size.h')).toBe(true);
    expect(holes.every((r) => r.profileScoped !== true)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f): fix_plan under layout carries no edits for unmeasured axes (their rows are absent).
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (f) fix_plan under layout', () => {
  const failDom = () => t2Dom({ rect: { x: 0, y: 0, w: 353, h: 120 }, clientWidth: 353 }); // size.w Δ10 fail

  it('token-aware sanity: the plan carries both fill and size.w', () => {
    const rows = diffPair(t2Spec(), failDom(), { tolerancePx: 1 });
    const edits = (buildFixPlan(rows, undefined)?.fix_plan ?? []).flatMap((g) => g.edits);
    expect(edits.some((e) => e.prop === 'size.w')).toBe(true);
    expect(edits.some((e) => e.prop === 'fill')).toBe(true);
  });

  it('layout: the size.w edit is present, NO color/typography edits', () => {
    const rows = diffPair(t2Spec(), failDom(), { tolerancePx: 1, profile: 'layout' });
    const edits = (buildFixPlan(rows, undefined)?.fix_plan ?? []).flatMap((g) => g.edits);
    expect(edits.some((e) => e.prop === 'size.w')).toBe(true);
    expect(edits.some((e) => e.prop === 'fill' || e.prop.startsWith('color') || e.prop.startsWith('font-'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g): receipt.match_profile in all three modes == the input (via the tool, the single source —
// the parsed arg). Layout — e2e: the producer DiffOptions.profile is really forwarded (rows collapsed).
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (g) receipt.match_profile in all three modes', () => {
  const cardFill: RawSceneNode = {
    ...card,
    fills: [{ type: 'SOLID', visible: true, color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } }],
  } as RawSceneNode;
  const okDomFill = { ...okDom, styles: { backgroundColor: '#444444' } };
  const mkApi = () => ({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: cardFill } } })), getVariablesLocal: vi.fn(async () => emptyVars) });

  it('omitted → token-aware; the fill axis is alive on the default', async () => {
    const out = JSON.parse((await harness(mkApi())({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDomFill }] })).content[0].text);
    expect(out.verification.match_profile).toBe('token-aware');
    expect(out.pairs[0].rows.some((r: DiffRow) => r.prop === 'fill' && r.status === 'fail')).toBe(true);
  });

  it('layout → layout; e2e: fill collapsed into a profileScoped skip, sentinel FIRST, complete=false, coverage.skipped carries the marker', async () => {
    const out = JSON.parse((await harness(mkApi())({ file: 'abc', match_profile: 'layout', pairs: [{ node_id: '1:1', dom: okDomFill }] })).content[0].text);
    expect(out.verification.match_profile).toBe('layout');
    expect(out.pairs[0].rows.some((r: DiffRow) => r.prop === 'fill' && r.status === 'fail')).toBe(false);
    expect(out.pairs[0].rows.some((r: DiffRow) => r.prop === 'fill' && r.status === 'skip' && r.profileScoped === true)).toBe(true);
    expect(out.verification.complete).toBe(false);
    expect(out.verification.blocking[0].kind).toBe('scope_incomplete');
    expect(out.pairs[0].coverage.skipped.some((s: { dim: string; profileScoped?: true }) => s.dim === 'fill' && s.profileScoped === true)).toBe(true);
  });

  it('strict → strict', async () => {
    const out = JSON.parse((await harness(mkApi())({ file: 'abc', match_profile: 'strict', pairs: [{ node_id: '1:1', dom: okDomFill }] })).content[0].text);
    expect(out.verification.match_profile).toBe('strict');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (h): component — warn/info-only TODAY (an invariant lock: if it ever becomes a fail —
// under layout it collapses DELIBERATELY, as identity out of scope).
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — (h) component warn/info-only invariant', () => {
  it('the component row is never a fail (matched → pass, no-hit → warn)', () => {
    const matched = diffPair(t2Spec(), t2Dom(), { tolerancePx: 1 });
    expect(rowOf(matched, 'component')?.status).toBe('pass');
    const noHit = diffPair(t2Spec(), t2Dom({ componentHints: { tag: 'div', classList: ['xyzqq'], data: {} } }), { tolerancePx: 1 });
    expect(rowOf(noHit, 'component')?.status).toBe('warn');
  });

  it('layout: component (measured pass/warn/info) collapsed into a profileScoped skip', () => {
    const rows = diffPair(t2Spec(), t2Dom({ componentHints: { tag: 'div', classList: ['xyzqq'], data: {} } }),
      { tolerancePx: 1, profile: 'layout' });
    expect(rowOf(rows, 'component')).toMatchObject({ status: 'skip', profileScoped: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review T1 (owned by T2): spacing-audit inFlowNeighbors — the STRUCTURAL gate is clamped to
// Math.max(tol,1); the measurement (effTol) stays raw. Mutation "cushion=tol" → RED.
// ─────────────────────────────────────────────────────────────────────────────
describe('match-profiles layout — spacing-audit: structural gate under strict (clamp 1px)', () => {
  const kid = (id: string, x: number): AuditKid => {
    const node: SpecChild = { id, name: id, type: 'FRAME', rect: { x, y: 0, w: 100, h: 40 } };
    return { child: node, pairedId: id, pairedNode: node };
  };
  const kids = [kid('10:1', 0), kid('10:2', 99.7)]; // sub-pixel overlap 0.3px on the main axis

  it('a sub-pixel overlap at tolerancePx 0 does NOT drop the gate into unchecked; the measurement is raw (Δ0.5 → fail)', () => {
    const caps = new Map<string, CaptureInfo>([
      ['10:1', { ref: 'r1', rect: { x: 0, y: 0, w: 100, h: 40 }, geometryUnchecked: false }],
      ['10:2', { ref: 'r1', rect: { x: 99.7, y: 0, w: 100, h: 40 }, geometryUnchecked: false }],
    ]);
    const audit = auditContainer('R', 'row', kids, caps, 0)!;
    expect(audit.gaps[0].status).toBe('pass'); // mutation "cushion=tol": the gate collapses → unchecked → RED

    const capsOff = new Map<string, CaptureInfo>([
      ['10:1', { ref: 'r1', rect: { x: 0, y: 0, w: 100, h: 40 }, geometryUnchecked: false }],
      ['10:2', { ref: 'r1', rect: { x: 100.2, y: 0, w: 100, h: 40 }, geometryUnchecked: false }],
    ]);
    const audit2 = auditContainer('R', 'row', kids, capsOff, 0)!;
    expect(audit2.gaps[0].status).toBe('fail'); // Δ0.5 > effTol 0 — the measurement is NOT clamped
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Markdown header: provenance (match_profile FROM verification.match_profile — NOT a new
// parallel renderReport channel) + rendering the profileScoped coverage skips.
// ═════════════════════════════════════════════════════════════════════════════

describe('match-profiles report — markdown header: profile provenance', () => {
  const cleanPair: PairResult = {
    node_id: '1:1', label: 'x', rows: [{ prop: 'size.w', figma: 10, dom: 10, status: 'pass' }],
    summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
  };
  const baseArgs = { file: 'abc', tolerancePx: 1, pairs: [cleanPair] };

  it('without verification (legacy call) → the header carries "profile token-aware" (deliberate default explicitness, NOT a silent omission)', () => {
    const md = renderReport(baseArgs);
    expect(md).toContain('profile token-aware');
  });

  it('verification.match_profile:"token-aware" explicit → the header carries "profile token-aware"', () => {
    const v: VerificationReceipt = { complete: true, scope: 'pairs', pairs: { checked: 1, clean: 1 }, blocking: [], match_profile: 'token-aware' };
    const md = renderReport({ ...baseArgs, verification: v });
    expect(md).toContain('profile token-aware');
  });

  it('verification.match_profile:"strict" → the header carries "profile strict", WITHOUT the layout warning', () => {
    const v: VerificationReceipt = { complete: true, scope: 'pairs', pairs: { checked: 1, clean: 1 }, blocking: [], match_profile: 'strict' };
    const md = renderReport({ ...baseArgs, tolerancePx: 0, verification: v });
    expect(md).toContain('tolerance 0px, profile strict');
    expect(md).not.toContain('OUT OF scope');
  });

  it('verification.match_profile:"layout" → the header carries "profile layout" + a separate warning line "typography/colors/styles OUT OF scope" RIGHT after the heading', () => {
    const v: VerificationReceipt = {
      complete: false, scope: 'pairs', pairs: { checked: 1, clean: 1 },
      blocking: [{ kind: 'scope_incomplete', action: 'run_token_aware', detail: 'layout profile: typography/colors/styles are out of scope — before "verified against the design" run token-aware or strict' }],
      match_profile: 'layout',
    };
    const md = renderReport({ ...baseArgs, verification: v });
    const lines = md.split('\n');
    const headingIdx = lines.findIndex((l) => l.startsWith('Verified against Figma'));
    expect(lines[headingIdx]).toContain('profile layout');
    // heading, '', warning — the "Provenance" block text
    expect(lines[headingIdx + 2]).toBe('⚠️ layout profile — typography/colors/styles OUT OF scope');
  });

  // Mutation lock: "header without profile" → RED. A byte anchor on the heading format —
  // a mutation "profile removed from the header" breaks the regex regardless of WHAT exactly was cut.
  it('MUTATION LOCK: the header ALWAYS carries the token ", profile <name>)" — regardless of mode', () => {
    for (const mp of ['strict', 'layout', 'token-aware'] as const) {
      const v: VerificationReceipt = { complete: true, scope: 'pairs', pairs: { checked: 1, clean: 1 }, blocking: [], match_profile: mp };
      const heading = renderReport({ ...baseArgs, verification: v }).split('\n')[0];
      expect(heading).toMatch(/, profile (strict|layout|token-aware)\):$/);
    }
  });
});

describe('match-profiles report — profileScoped skips: render coverage.skipped separately from environmental ones', () => {
  it('a profileScoped skip renders as ONE summary line "⏭ outside profile scope: …", WITHOUT the "Figma — / DOM —" placeholder; an environmental skip renders AS BEFORE (per-row, with its own reason)', () => {
    const rows: DiffRow[] = [
      { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
      { prop: 'typography', status: 'skip', profileScoped: true, note: 'axis outside the layout profile — verify with the token-aware/strict profile' },
      { prop: 'fill', status: 'skip', profileScoped: true, note: 'axis outside the layout profile — verify with the token-aware/strict profile' },
      { prop: 'size.h', status: 'skip', note: 'scroll container: height uninformative' }, // environmental skip, NOT a profile one
    ];
    const pair: PairResult = { node_id: '1:1', label: 'card', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [pair] });

    // profile one: a single summary line, both dims together, the explicit phrase "outside profile scope"
    expect(md).toContain('⏭ outside profile scope: typography, fill — verify with the token-aware/strict profile');
    // per-row "Figma — / DOM —" for typography/fill is gone (rowLine would give it)
    expect(md).not.toContain('typography: Figma');
    expect(md).not.toContain('fill: Figma');

    // the environmental skip stays AS BEFORE — per-row, with its own reason, WITHOUT the profile phrase
    expect(md).toContain('⏭ size.h: Figma — / DOM — — scroll container: height uninformative');
    expect(md).not.toContain('outside profile scope: size.h');
  });

  it('no profileScoped skips (a normal token-aware/strict run) → no summary line at all', () => {
    const rows: DiffRow[] = [
      { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
      { prop: 'fill', figma: '#111111', dom: '#222222', status: 'fail' },
    ];
    const pair: PairResult = { node_id: '1:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [pair] });
    expect(md).not.toContain('outside profile scope');
  });

  // MUTATION LOCK: if the profileScoped row is not excluded from the rowLine loop, the dim "typography"
  // is mentioned TWICE (per-row AND in the summary) — we count the substring occurrences.
  it('MUTATION LOCK: a profileScoped row is NOT duplicated (rowLine + summary) — exactly one mention of "typography"', () => {
    const rows: DiffRow[] = [
      { prop: 'typography', status: 'skip', profileScoped: true, note: 'axis outside the layout profile — verify with the token-aware/strict profile' },
    ];
    const pair: PairResult = { node_id: '1:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [pair] });
    // Count within the pair section only (before the Total: footer, which carries an unrelated
    // "typography checked to N levels" note). A missed rowLine exclusion adds a per-row "typography: Figma …"
    // line to the pair section → count 2.
    const pairSection = md.slice(0, md.indexOf('Total:'));
    const occurrences = pairSection.split('typography').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('match-profiles report — e2e: report_markdown carries the profile provenance via the tool', () => {
  const cardFillE2e: RawSceneNode = {
    ...card,
    fills: [{ type: 'SOLID', visible: true, color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } }],
  } as RawSceneNode;
  const okDomFillE2e = { ...okDom, styles: { backgroundColor: '#444444' } };
  const mkApiE2e = () => ({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: cardFillE2e } } })), getVariablesLocal: vi.fn(async () => emptyVars) });

  it('layout: report_markdown carries "profile layout" in the header, the OUT-OF-scope warning and the summary line "outside profile scope: fill"', async () => {
    const out = JSON.parse((await harness(mkApiE2e())({ file: 'abc', match_profile: 'layout', pairs: [{ node_id: '1:1', dom: okDomFillE2e }] })).content[0].text);
    expect(out.report_markdown).toContain('profile layout');
    expect(out.report_markdown).toContain('⚠️ layout profile — typography/colors/styles OUT OF scope');
    expect(out.report_markdown).toContain('outside profile scope: fill');
  });

  it('strict: report_markdown carries "profile strict"', async () => {
    const out = JSON.parse((await harness(mkApiE2e())({ file: 'abc', match_profile: 'strict', pairs: [{ node_id: '1:1', dom: okDomFillE2e }] })).content[0].text);
    expect(out.report_markdown).toContain('profile strict');
  });

  it('omitted (default) → report_markdown carries "profile token-aware"', async () => {
    const out = JSON.parse((await harness(mkApiE2e())({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDomFillE2e }] })).content[0].text);
    expect(out.report_markdown).toContain('profile token-aware');
  });
});
