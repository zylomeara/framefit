// Batch 2 item 4 (panel-locked, 37 findings, 10 blockers): DS instances nest deeper than the
// max_depth ceiling and every such pair carried a permanent children_truncated blocking item
// whose advice named nothing. Two corrected premises drive the design: (1) the depth flag is
// a machine PROOF of a VISIBLE in-flow node beyond the cut (invisible service slots are
// filtered before the flag can fire), so complete NEVER releases from this path - the gate's
// own precondition closes that road; (2) the advice was never unexecutable, only UNADDRESSED
// - a cut DESCENDANT is captured itself and re-rooting restarts the depth budget (a ROOT cut
// has no such address and keeps the generic wording). The ship:
// (D) every children_truncated blocking item names up to 3 cut-descendant addresses per side
// (fig ids pairable directly; dom paths as navigation, never as selectors); (B) the narrow
// fully-evidenced case - ceiling reached (requested OR effective 8), at least one EXPLICIT
// fig 'depth' cause and no other/uncaused fig cuts, ZERO dom-side truncation, no
// structure_mismatch, no unwrap repair (manufactured cardinality is not zip evidence) -
// stamps a structural depthCeilingTail flag on the row in diff.ts (the one place holding
// both trees); verification skips ONLY the blocking item via a call-site guard
// (holeToBlocking stays a pure mapper), aggregates ONE deduped receipt note keyed by
// label ?? node_id, and complete stays false. Default-deny everywhere: an absent cause is
// never 'depth' (the frame walk's ?? 'depth' default is forbidden here); dom-dom never
// degrades (no cause channel exists in its synthesized spec).
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
  it('a SALVAGED structure_mismatch pair -> NO flag (children genuinely unpaired; hard asserts - a total mismatch returns before the truncation block, only salvage coexists with the row)', () => {
    // 3 fig text kids (one depth-cut) vs 2 dom text kids: text anchors salvage the subset,
    // the structure_mismatch row is pushed WITHOUT an early return, and the truncation block
    // still runs - the one reachable state where the noMismatch guard term matters.
    const txt = (id: string, snippet: string, y: number, over: Partial<SpecChild> = {}): SpecChild => ({
      id, name: snippet, type: 'TEXT', rect: R(16, y, 100, 20), textSnippet: snippet, ...over } as SpecChild);
    const domTxt = (text: string, y: number): DomChild =>
      ({ kind: 'element', tag: 'span', rect: R(16, y, 100, 20), text }) as DomChild;
    const rows = diffPair(
      spec([txt('7:2', 'Alpha', 0, { childrenTruncated: true, truncationCause: 'depth' }),
        txt('7:3', 'Beta', 20), txt('7:4', 'Gamma', 40)], { rect: R(0, 0, 300, 60) }),
      snap([domTxt('Alpha', 0), domTxt('Gamma', 40)], { rect: R(0, 0, 300, 60), clientHeight: 60, scrollHeight: 60 }),
      { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'structure_mismatch')).toBe(true);
    const r = ctRow(rows);
    expect(r).toBeDefined();
    expect((r as { depthCeilingTail?: true }).depthCeilingTail).toBeUndefined();
  });
  it('an unwrap-repaired pair carrying a depth cut -> NO flag (root-level equality was manufactured by expanding a wrapper)', () => {
    const wrapper: SpecChild = { id: '7:5', name: 'wrap', type: 'FRAME', rect: R(0, 0, 300, 100),
      children: [
        { id: '7:2', name: 'body', type: 'FRAME', rect: R(0, 0, 300, 50),
          childrenTruncated: true, truncationCause: 'depth' } as SpecChild,
        { id: '7:3', name: 'slot', type: 'FRAME', rect: R(0, 50, 300, 50) },
      ] };
    const rows = diffPair(spec([wrapper]), snap([
      domKid({ rect: R(0, 0, 300, 50), children: [] }),
      domKid({ rect: R(0, 50, 300, 50), children: [] }),
    ]), { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'unwrapped')).toBe(true);   // the repair actually fired
    const r = ctRow(rows);
    expect(r).toBeDefined();                                       // the cut is still visible
    expect((r as { depthCeilingTail?: true }).depthCeilingTail).toBeUndefined();
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
    expect(v.complete).toBe(false);                       // complete never releases from this path
    expect(v.pairs).toEqual({ checked: 1, clean: 0 });    // the degraded pair still loses clean (clean<checked is a machine surface)
  });
  it('the note ids follow the budgetDropNote convention (label ?? node_id) and dedupe repeats', () => {
    const rows = flagged();
    const two = [{ ...pairOf(rows), label: 'hero' }, { ...pairOf(rows), label: 'hero-b' }];
    const v = buildVerification(two as never, { depthLevels: 8, tolerancePx: 1 } as never);
    const note = (v.notes ?? []).find((n) => /ceiling/.test(n)) ?? '';
    expect(note).toContain('2 pair(s)');
    expect(note).toContain('hero, hero-b');               // labels, not the shared node_id twice
    const vDup = buildVerification([pairOf(rows), pairOf(rows)] as never, { depthLevels: 8, tolerancePx: 1 } as never);
    const noteDup = (vDup.notes ?? []).find((n) => /ceiling/.test(n)) ?? '';
    expect(noteDup).toContain('2 pair(s)');
    expect(noteDup.match(/7:1/g)).toHaveLength(1);        // same id shown once
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
  it('fig addresses cap at 3 - a fourth cut is not named', () => {
    const cut = (id: string, y: number): SpecChild => ({ id, name: 'k', type: 'FRAME', rect: R(0, y, 300, 20),
      childrenTruncated: true } as SpecChild);
    const rows = diffPair(spec([cut('7:29', 0), cut('7:39', 20), cut('7:49', 40), cut('7:59', 60)]),
      snap([domKid({ rect: R(0, 0, 300, 20), children: [] }), domKid({ rect: R(0, 20, 300, 20), children: [] }),
        domKid({ rect: R(0, 40, 300, 20), children: [] }), domKid({ rect: R(0, 60, 300, 20), children: [] })]),
      { tolerancePx: 1 });
    const note = ctRow(rows)!.note ?? '';
    expect(note).toContain('cut at: 7:29, 7:39, 7:49');
    expect(note).not.toContain('7:59');
  });
  it('a DOM-side cut with a path is named as NAVIGATION, never as a selector to paste', () => {
    const rows = diffPair(spec([deepKid()]),
      snap([domKid({ children: [{ kind: 'element', tag: 'div', rect: R(0, 0, 300, 100),
        childrenTruncated: true, path: '> :nth-child(1) > :nth-child(1)' } as DomChild] })]),
      { tolerancePx: 1 });
    const note = ctRow(rows)!.note ?? '';
    expect(note).toContain("DOM-side cut below: > :nth-child(1) > :nth-child(1) (navigate from the pair's selector - not a standalone selector)");
  });
  it('a PATHLESS dom cut is not named at all (a bare tag addresses nothing)', () => {
    const rows = diffPair(spec([deepKid()]),
      snap([domKid({ children: [{ kind: 'element', tag: 'span', rect: R(0, 0, 300, 100),
        childrenTruncated: true } as DomChild] })]),
      { tolerancePx: 1 });
    const note = ctRow(rows)!.note ?? '';
    expect(note).not.toContain('DOM-side');
    expect(note).not.toContain('span');
  });
  it('a ROOT-level cut is NOT an address - no suffix, no self-referential recipe (re-rooting at the root restarts nothing)', () => {
    const rows = diffPair(spec([{ id: '7:2', name: 'body', type: 'FRAME', rect: R(0, 0, 300, 100) }],
      { childrenTruncated: true, truncationCause: 'breadth' } as Partial<LayoutSpec>),
      snap([domKid({ children: [] })]), { tolerancePx: 1 });
    const note = ctRow(rows)!.note ?? '';
    expect(note).not.toContain('cut at:');
    expect(note).not.toContain('pair root itself');
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
  it('empty blocking with an open FAIL row keeps the imperative - blocking emptiness alone is NOT the hatch predicate', async () => {
    const { renderReport } = await import('../../src/domain/layout-spec/report.js');
    // A plain fail mints no blocking item (blocking is coverage, fails are the verdict):
    // before the wave fix this shape read "Only inherent items remain ... you may proceed"
    // over an unfixed discrepancy.
    const failRows = [{ prop: 'size.w', status: 'fail', figma: 300, dom: 200, delta: 100 }] as never[];
    const v = buildVerification([pairOf(failRows as never)] as never, { depthLevels: 4, tolerancePx: 1 } as never);
    expect(v.blocking).toEqual([]);
    expect(v.complete).toBe(false);
    const md = renderReport({ file: 'abc', tolerancePx: 1, depthLevels: 4,
      pairs: [pairOf(failRows as never) as never], verification: v });
    expect(md).toContain('do NOT say "done"');
    expect(md).not.toContain('Only inherent items remain');
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
