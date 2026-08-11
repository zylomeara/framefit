// Batch 2 item 4 (panel-locked, 37 findings, 10 blockers): DS instances nest deeper than the
// max_depth ceiling and every such pair carried a permanent children_truncated blocking item
// whose advice named nothing. Two corrected premises drive the design: (1) the depth flag is
// a machine PROOF of a VISIBLE in-flow node beyond the cut (invisible service slots are
// filtered before the flag can fire), so complete NEVER releases - Road A is closed by the
// gate's own precondition; (2) the advice was never unexecutable, only UNADDRESSED - the cut
// node itself is captured on both sides and re-rooting restarts the depth budget. The ship:
// (D) every children_truncated blocking item names up to 3 cut-node addresses; (B) the
// narrow fully-evidenced case - ceiling reached (requested OR effective 8), at least one
// EXPLICIT fig 'depth' cause and no other/uncaused fig cuts, ZERO dom-side truncation, no
// structure_mismatch - stamps a structural depthCeilingTail flag on the row in diff.ts (the
// one place holding both trees); verification skips ONLY the blocking item via a call-site
// guard (holeToBlocking stays a pure mapper), aggregates ONE deduped receipt note, and
// complete stays false. Default-deny everywhere: an absent cause is never 'depth' (the
// frame walk's ?? 'depth' default is forbidden here); dom-dom never degrades (no cause
// channel exists in its synthesized spec).
import { describe, it, expect } from 'vitest';
import { diffPair, summarize, deriveCoverage } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import type { LayoutSpec, DomSnapshotOk, DomChild, SpecChild } from '../../src/domain/layout-spec/types.js';

const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const deepKid = (over: Partial<SpecChild> = {}): SpecChild => ({
  id: '7:2', name: 'body', type: 'FRAME', rect: R(0, 0, 300, 100),
  children: [{ id: '7:3', name: 'slot', type: 'FRAME', rect: R(0, 0, 300, 100),
    childrenTruncated: true, truncationCause: 'depth', ...over } as SpecChild],
});
const spec = (kids: SpecChild[], over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '7:1', name: 'card', type: 'FRAME' },
  rect: R(0, 0, 300, 100), axis: 'col',
  autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  children: kids, ...over,
});
const domKid = (over: Partial<DomChild> = {}): DomChild => ({
  kind: 'element', tag: 'div', rect: R(0, 0, 300, 100),
  children: [{ kind: 'element', tag: 'div', rect: R(0, 0, 300, 100) }], ...over,
});
const snap = (kids: DomChild[], over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.card', innerWidth: 1280,
  rect: R(0, 0, 300, 100), borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 300, clientHeight: 100, scrollHeight: 100,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  children: kids, ...over,
});
const ctRow = (rows: ReturnType<typeof diffPair>) => rows.find((r) => r.prop === 'children_truncated');
const pairOf = (rows: ReturnType<typeof diffPair>) =>
  ({ node_id: '7:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) });
const verify = (rows: ReturnType<typeof diffPair>, depthLevels: number, reqDepth?: number) =>
  buildVerification([pairOf(rows)], { depthLevels, tolerancePx: 1, ...(reqDepth !== undefined ? { requestedDepth: reqDepth } : {}) } as never);
const ctBlocking = (v: ReturnType<typeof buildVerification>) =>
  v.blocking.filter((b) => b.kind === 'children_truncated');

describe('derivation (diff level): the depthCeilingTail flag is positive-evidence only', () => {
  it('a descendant depth-pure cut + untruncated DOM + equal counts -> the row carries the flag', () => {
    const rows = diffPair(spec([deepKid()]), snap([domKid()]), { tolerancePx: 1 });
    const r = ctRow(rows);
    expect(r).toBeDefined();
    expect((r as { depthCeilingTail?: true }).depthCeilingTail).toBe(true);
  });
  it("cause 'breadth' -> NO flag", () => {
    const rows = diffPair(spec([deepKid({ truncationCause: 'breadth' })]), snap([domKid()]), { tolerancePx: 1 });
    expect((ctRow(rows) as { depthCeilingTail?: true }).depthCeilingTail).toBeUndefined();
  });
  it("cause 'budget' -> NO flag", () => {
    const rows = diffPair(spec([deepKid({ truncationCause: 'budget' })]), snap([domKid()]), { tolerancePx: 1 });
    expect((ctRow(rows) as { depthCeilingTail?: true }).depthCeilingTail).toBeUndefined();
  });
  it('an UNCAUSED cut -> NO flag (default-deny; the frame walk\'s ??-depth default is forbidden here)', () => {
    const rows = diffPair(spec([deepKid({ truncationCause: undefined })]), snap([domKid()]), { tolerancePx: 1 });
    expect((ctRow(rows) as { depthCeilingTail?: true }).depthCeilingTail).toBeUndefined();
  });
  it('ANY dom-side truncation -> NO flag (unattributable: budget and depth are identical on the wire)', () => {
    const rows = diffPair(spec([deepKid()]),
      snap([domKid({ children: [{ kind: 'element', tag: 'div', rect: R(0, 0, 300, 100), childrenTruncated: true }] })]),
      { tolerancePx: 1 });
    expect((ctRow(rows) as { depthCeilingTail?: true }).depthCeilingTail).toBeUndefined();
  });
  it('a structure_mismatch pair -> NO flag (children genuinely unpaired)', () => {
    const rows = diffPair(spec([deepKid(), { id: '7:9', name: 'extra', type: 'FRAME', rect: R(0, 100, 300, 40) }]),
      snap([domKid()]), { tolerancePx: 1 });
    if (rows.some((r) => r.prop === 'structure_mismatch')) {
      expect((ctRow(rows) as { depthCeilingTail?: true } | undefined)?.depthCeilingTail).toBeUndefined();
    }
  });
  it('mixed causes (one depth + one breadth) -> NO flag', () => {
    const rows = diffPair(spec([deepKid(), {
      id: '7:8', name: 'wide', type: 'FRAME', rect: R(0, 100, 300, 40),
      childrenTruncated: true, truncationCause: 'breadth' } as SpecChild]),
      snap([domKid(), domKid({ rect: R(0, 100, 300, 40), children: [] })]), { tolerancePx: 1 });
    expect((ctRow(rows) as { depthCeilingTail?: true }).depthCeilingTail).toBeUndefined();
  });
});

describe('routing (verification level): the ceiling degrades ONLY the blocking half', () => {
  const flagged = () => diffPair(spec([deepKid()]), snap([domKid()]), { tolerancePx: 1 });
  it('flagged row at depthLevels 8 -> NO children_truncated blocking, the aggregated note, complete stays FALSE', () => {
    const v = verify(flagged(), 8);
    expect(ctBlocking(v)).toEqual([]);
    expect((v.notes ?? []).some((n) => /ceiling/.test(n))).toBe(true);
    expect(v.complete).toBe(false);                       // the Road-A positive lock
  });
  it('flagged row at depthLevels 4 -> raise_max_depth as today', () => {
    const v = verify(flagged(), 4);
    expect(ctBlocking(v).some((b) => b.action === 'raise_max_depth')).toBe(true);
  });
  it('the clamp shape: requested 8, effective 6 -> the degrade applies', () => {
    const v = verify(flagged(), 6, 8);
    expect(ctBlocking(v)).toEqual([]);
    expect((v.notes ?? []).some((n) => /ceiling/.test(n))).toBe(true);
  });
  it('an UNflagged row at 8 keeps the addressable blocking item (the swap-lock arm)', () => {
    const rows = diffPair(spec([deepKid({ truncationCause: undefined })]), snap([domKid()]), { tolerancePx: 1 });
    const v = verify(rows, 8);
    const items = ctBlocking(v);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].action).toBe('add_pairs_on_children');
  });
});

describe('addressability (D): the surviving blocking names the cut nodes', () => {
  it('the row note and the at-8 item detail carry the cut node address', () => {
    const rows = diffPair(spec([deepKid({ truncationCause: undefined })]), snap([domKid()]), { tolerancePx: 1 });
    expect(ctRow(rows)!.note).toMatch(/7:3/);
    const v = verify(rows, 8);
    expect(ctBlocking(v)[0].detail).toMatch(/7:3/);
  });
});

describe('the report contract: the done imperative belongs to actionable blocking only', () => {
  it('empty blocking -> no "do NOT say done"; non-empty -> present', async () => {
    const { renderReport } = await import('../../src/domain/layout-spec/report.js');
    const flagged = diffPair(spec([deepKid()]), snap([domKid()]), { tolerancePx: 1 });
    const vEmpty = verify(flagged, 8);
    const mdEmpty = renderReport({ file: 'abc', tolerancePx: 1, depthLevels: 8,
      pairs: [pairOf(flagged) as never], verification: vEmpty });
    expect(vEmpty.blocking).toEqual([]);
    expect(mdEmpty).not.toContain('do NOT say "done"');
    expect(mdEmpty).toMatch(/ceiling/);                    // the note renders as the warn line
    const vBlocked = verify(flagged, 4);
    const mdBlocked = renderReport({ file: 'abc', tolerancePx: 1, depthLevels: 4,
      pairs: [pairOf(flagged) as never], verification: vBlocked });
    expect(mdBlocked).toContain('do NOT say "done"');
  });
});

describe('dom-dom never degrades (no cause channel exists)', () => {
  it('reference-side truncation + max_depth 8 -> the blocking item is still minted', async () => {
    const { diffDomPair } = await import('../../src/domain/layout-spec/dom-dom.js');
    // the reference ROOT carries the cut: dom-dom copies only the root flag into its
    // synthesized spec (childToSpec propagates no nested flags - pre-existing), and the
    // synthesized cut carries NO cause - the default-deny gate can never see 'depth'.
    const ref = snap([domKid()], { childrenTruncated: true });
    const cand = snap([domKid()]);
    const rows = diffDomPair(ref, cand, { tolerancePx: 1, maxDepth: 8 });
    const v = buildVerification([{ node_id: 'card', label: 'card', rows, summary: summarize(rows), coverage: deriveCoverage(rows) }],
      { depthLevels: 8, tolerancePx: 1, mode: 'dom-dom' });
    expect(ctBlocking(v).length).toBeGreaterThan(0);
  });
});
