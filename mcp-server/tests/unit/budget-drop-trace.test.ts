// The budget drop trace (the clamped fail-pair debt, panel-locked): a pair whose FAIL is
// clamped out by the response budget used to vanish from delivery entirely - complete:false
// with an EMPTY blocking[], the report printing 'Only inherent items remain' and 'no defects
// found ... see verification.blocking' at an empty list. Panel decisions (38 findings):
// NO keep-priority reorder (post-condense greens are nearly free; the sort would drop
// spacing-audit evidence by design), NO blocking item (Gate 5B one-module rule; a post-sort
// append is invisible below the report's 15-slice; no executable action) - the carriers are
// verification.notes[] (human, renders in both report branches) + omitted_pair_indices
// (machine replay key) and omitted_pair_ids (display-only labels). The trace is a
// PURE function of (all results, kept) computed inside buildOutput - measured by the
// serialize closure, never a mutation of the shared receipt. compare_dom_to_dom additionally
// gains the EXISTING condense tier (it was full -> clamp, the only relief being whole-pair
// drops - the debt's most reachable home).
import { describe, it, expect, vi } from 'vitest';
import { registerCompareNodeToDomTool } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import { registerCompareDomToDomTool } from '../../src/adapters/driving/tools/compare-dom-to-dom-tool.js';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { DomSnapshotOk, VerificationReceipt } from '../../src/domain/layout-spec/types.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function figmaHarness(api: Partial<FigmaApi>, maxResultChars = 40000) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars };
  registerCompareNodeToDomTool(server, deps);
  return (a: Record<string, unknown>): Promise<any> => call('compare_node_to_dom', a);
}
function domDomHarness(maxResultChars = 40000) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => ({} as FigmaApi), defaultToken: undefined, logger, maxResultChars };
  registerCompareDomToDomTool(server, deps);
  return (a: Record<string, unknown>): Promise<any> => call('compare_dom_to_dom', a);
}
const parse = (r: { content: { text: string }[] }): any => JSON.parse(r.content[0].text);
const dropNotes = (out: any): string[] =>
  (out.verification.notes ?? []).filter((n: string) => n.includes('response budget'));

// One card, matched cleanly by cleanDom; redDom diverges on the children's x (offset fail).
const card: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 },
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [
    { id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: { x: 16, y: 12, width: 200, height: 24 } },
    { id: '1:3', name: 'list', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 40 } },
  ],
};
// paddings + client*/scrollHeight are load-bearing: without them every pair carries an
// extractor_outdated blocking item, verification.blocking is never empty, and the
// blocking-empty branch these tests lock (the replaced inherent-only caveat) is UNREACHABLE -
// the wave measured the not.toContain asserts as unfalsifiable under the padding-less fixture.
const cleanDom = {
  schema: 7, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 343, clientHeight: 120, scrollHeight: 120,
  scroll: { top: 0, left: 0 }, transformed: false,
  children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 40 } },
  ],
};
const redDom = { ...cleanDom, children: cleanDom.children.map((c) => ({ ...c, rect: { ...c.rect, x: 30 } })) };

// Self-calibration (meta-lesson #69): budget boundaries are measured by a run, never guessed.
// mixedPairs: four clean + the RED pair LAST - a prefix clamp drops the red first.
const mixedPairs = [
  ...Array.from({ length: 4 }, (_, i) => ({ node_id: '1:1', dom: cleanDom, label: `clean-${i}` })),
  { node_id: '1:1', dom: redDom, label: 'red-tail' },
];

describe('compare_node_to_dom: the drop trace', () => {
  const api = () => ({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: card } } })) });

  it('a clamped-out RED pair leaves the full trace, and the delivery still fits the budget', async () => {
    // calibration: budget=1 -> the floor delivery (1 kept pair + the trace); then budget=floorLen
    // must fit WITH the trace present - the both-halves assert (a note alone or a fit alone
    // each passes for one of the two bugs: unmeasured delivery vs measured-but-undelivered).
    const floor = await figmaHarness(api(), 1)({ file: 'abc', pairs: mixedPairs });
    const floorLen = floor.content[0].text.length;
    const res = await figmaHarness(api(), floorLen)({ file: 'abc', pairs: mixedPairs });
    const out = parse(res);
    expect(out.omitted_pairs).toBeGreaterThan(0);
    expect(out.omitted_pair_ids).toHaveLength(out.omitted_pairs);
    expect(out.omitted_pair_indices).toEqual(
      Array.from({ length: out.omitted_pairs }, (_, i) => out.pairs.length + i),
    );
    expect(out.omitted_pair_indices).toHaveLength(out.omitted_pair_ids.length);
    expect(out.omitted_pair_ids).toContain('red-tail');       // labels, not the shared node_id '1:1'
    expect(out.hydration).toHaveLength(out.pairs.length);     // duplicate node ids cannot leak omitted receipts
    expect(out.hydration.map((h: any) => h.pair_index)).toEqual(
      Array.from({ length: out.pairs.length }, (_, i) => i),
    );
    const notes = dropNotes(out);
    expect(notes).toHaveLength(1);                            // probe purity: no per-probe accumulation
    expect(notes[0]).toMatch(/FAILing/);                      // the dropped red is attributed
    expect(notes[0]).toMatch(/omitted_pair_indices/);            // duplicate-safe remediation is named
    expect(notes[0]).toMatch(/originalArgs\.pairs\[i\]/);
    expect(res.content[0].text.length).toBeLessThanOrEqual(floorLen);
    // the three false sentences are gone: the verdict is red, nothing claims inherent-only.
    // The fixture reaches the EXACT debt shape (complete:false with an EMPTY blocking[]) - the
    // not.toContain below is falsifiable only because the blocking-empty branch really renders,
    // so the replacement sentence is asserted POSITIVELY beside it.
    expect(out.verification.blocking).toHaveLength(0);
    expect(out.report_markdown).toContain('discrepancies found');
    expect(out.report_markdown).toContain('NOT an inherent-only remainder');
    expect(out.report_markdown).not.toContain('no defects found');
    expect(out.report_markdown).not.toContain('Only inherent items remain');
    expect(out.verification.complete).toBe(false);            // unchanged: receipt over ALL pairs
  });

  it('the serialize closure MEASURES the trace: delivery at the kept=2 boundary equals the budget that selected it', async () => {
    // The robust measure==delivery lock at a NON-floor boundary. lo = the smallest budget at
    // which the clamp keeps 2 (bisection; kept is monotone in budget, step exactly 1 - swept).
    // With the closure measuring the trace, that threshold IS the delivered length: l2.len ===
    // lo, an identity. The measure-direction mutant (M-MEASURE: trace emitted by the final
    // call, invisible to the closure) shifts lo DOWN by the trace bytes while the delivery
    // keeps them - l2.len > lo, red (verified live in both comparators). The floorLen probes
    // above also catch this mutant today, but only because the repaired fixture's trace
    // quantum (585 bytes) exceeds its pair quantum (482) - a relation a future fixture edit
    // can silently flip back (the pre-repair fixture had 497 vs 835 and the whole suite
    // stayed green under the mutant). This identity holds for ANY fixture whose trace is
    // non-empty, which is what makes it the lock rather than the luck.
    const runAt = async (budget: number) => {
      const res = await figmaHarness(api(), budget)({ file: 'abc', pairs: mixedPairs });
      return { len: res.content[0].text.length, kept: parse(res).pairs.length };
    };
    const full = await runAt(400000);
    let lo = 1, hi = full.len; // smallest budget with kept >= 2
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await runAt(mid)).kept >= 2) hi = mid; else lo = mid + 1;
    }
    const l2 = await runAt(lo);
    expect(l2.kept).toBe(2);
    expect(l2.len).toBe(lo);
  });

  it('an all-green clamped batch discloses without degrading the verdict (anti-cry-wolf)', async () => {
    const pairs = Array.from({ length: 5 }, (_, i) => ({ node_id: '1:1', dom: cleanDom, label: `clean-${i}` }));
    const floor = await figmaHarness(api(), 1)({ file: 'abc', pairs });
    const out = parse(await figmaHarness(api(), floor.content[0].text.length)({ file: 'abc', pairs }));
    expect(out.omitted_pairs).toBeGreaterThan(0);
    expect(out.omitted_pair_ids.length).toBe(out.omitted_pairs);
    expect(out.omitted_pair_indices).toEqual(
      Array.from({ length: out.omitted_pairs }, (_, i) => out.pairs.length + i),
    );
    expect(out.verification.complete).toBe(true);
    const notes = dropNotes(out);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toMatch(/FAILing/);                  // nothing red was dropped - no false alarm
    expect(out.report_markdown).not.toContain('discrepancies found');
  });

  it('an unclamped response carries none of the new surface', async () => {
    const out = parse(await figmaHarness(api(), 400000)({ file: 'abc', pairs: mixedPairs }));
    expect(out.omitted_pairs).toBeUndefined();
    expect(out.omitted_pair_ids).toBeUndefined();
    expect(out.omitted_pair_indices).toBeUndefined();
    expect(dropNotes(out)).toHaveLength(0);
  });

  it('duplicate display ids replay the exact original positions', async () => {
    const pairs = [
      { node_id: '1:1', dom: cleanDom, label: 'duplicate' },
      { node_id: '1:1', dom: cleanDom, label: 'duplicate' },
      { node_id: '1:1', dom: redDom, label: 'duplicate' },
    ];
    const out = parse(await figmaHarness(api(), 1)({ file: 'abc', pairs }));
    expect(out.pairs).toHaveLength(1);
    expect(out.omitted_pair_ids).toEqual(['duplicate', 'duplicate']);
    expect(out.omitted_pair_indices).toEqual([1, 2]);

    const replay = out.omitted_pair_indices.map((i: number) => pairs[i]);
    const replayed = parse(await figmaHarness(api(), 400000)({ file: 'abc', pairs: replay }));
    expect(replayed.pairs.map((p: any) => p.summary.fail)).toEqual([0, 2]);
  });

  it('the floor overflow stays honest: budget=1 still names the dropped pairs', async () => {
    // pre-existing ceiling: clampToBudget keeps at least 1 pair even over budget - the trace
    // must ride that delivery too (no fits-budget assert here, the overflow is deliberate).
    const out = parse(await figmaHarness(api(), 1)({ file: 'abc', pairs: mixedPairs }));
    expect(out.omitted_pairs).toBeGreaterThan(0);
    expect(out.omitted_pair_ids).toContain('red-tail');
    expect(dropNotes(out)).toHaveLength(1);
  });
});

// dom-dom: many matched children -> many note-less pass rows = bulk that condenseBulkPass
// collapses. reference vs candidate diverge on padding-top for the red pair only.
// borderColors is load-bearing for the same reason as cleanDom's paddings: 1px borders with
// no color yield a resolve_skip blocking item PER PAIR, and blocking never empties.
const bulkyState = (firstCardY: number): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.shelf', innerWidth: 768,
  rect: { x: 0, y: 0, w: 768, h: 4000 },
  borders: { top: 1, right: 1, bottom: 1, left: 1 },
  borderColors: { top: '#e0e0e0', right: '#e0e0e0', bottom: '#e0e0e0', left: '#e0e0e0' },
  paddings: { top: 24, right: 16, bottom: 24, left: 16 },
  clientWidth: 766, clientHeight: 3998, scrollHeight: 3998,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', backgroundColor: '#ffffff', borderRadius: 0, opacity: 1 },
  children: Array.from({ length: 30 }, (_, i) => (
    { kind: 'element' as const, tag: 'div', rect: { x: 17, y: firstCardY + i * 130, w: 734, h: 114 } })),
});
const domDomPairs = (nClean: number) => [
  ...Array.from({ length: nClean }, (_, i) => (
    { label: `shelf-${i}`, reference: { dom: bulkyState(366) }, candidate: { dom: bulkyState(366) } })),
  { label: 'red-shelf', reference: { dom: bulkyState(366) }, candidate: { dom: bulkyState(306) } },
];

describe('compare_dom_to_dom: condense tier + the drop trace', () => {
  it('D0: an over-budget bulk batch is rescued by condensation - ALL pairs delivered, red included', async () => {
    const pairs = domDomPairs(9);
    const big = await domDomHarness(400000)({ pairs });
    const fullLen = big.content[0].text.length;
    expect(parse(big).omitted_pairs).toBeUndefined();         // sanity: fits at a large budget
    const out = parse(await domDomHarness(fullLen - 1)({ pairs }));
    expect(out.omitted_pairs).toBeUndefined();                // condense rescued the whole batch
    expect(out.pairs).toHaveLength(10);
    expect(out.pairs[0].rows.find((r: any) => r.prop === 'passes_condensed')).toBeDefined();
    expect(out.pairs.find((p: any) => p.node_id === 'red-shelf').summary.fail).toBeGreaterThan(0);
  });

  it('a clamped-out RED pair leaves the same trace shapes as the Figma comparator', async () => {
    const pairs = domDomPairs(9);
    const floor = await domDomHarness(1)({ pairs });
    const floorLen = floor.content[0].text.length;
    const res = await domDomHarness(floorLen)({ pairs });
    const out = parse(res);
    expect(out.omitted_pairs).toBeGreaterThan(0);
    expect(out.omitted_pair_ids).toContain('red-shelf');
    expect(out.omitted_pair_indices).toEqual(
      Array.from({ length: out.omitted_pairs }, (_, i) => out.pairs.length + i),
    );
    expect(out.omitted_pair_indices).toHaveLength(out.omitted_pair_ids.length);
    const notes = dropNotes(out);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/FAILing/);
    expect(res.content[0].text.length).toBeLessThanOrEqual(floorLen);
    // the same reached-shape locks as the Figma comparator: blocking really empties here
    // (bulkyState carries borderColors), so the replacement sentence is asserted positively.
    expect(out.verification.blocking).toHaveLength(0);
    expect(out.report_markdown).toContain('discrepancies found');
    expect(out.report_markdown).toContain('NOT an inherent-only remainder');
    expect(out.report_markdown).not.toContain('Only inherent items remain');
  });

  it('duplicate labels replay exact dom-dom positions', async () => {
    const matching = bulkyState(420);
    const changed = { ...bulkyState(420), paddings: { top: 31, right: 16, bottom: 24, left: 16 } };
    const pairs = [
      { label: 'duplicate', reference: { dom: matching }, candidate: { dom: matching } },
      { label: 'duplicate', reference: { dom: matching }, candidate: { dom: matching } },
      { label: 'duplicate', reference: { dom: matching }, candidate: { dom: changed } },
    ];
    const out = parse(await domDomHarness(1)({ pairs }));
    expect(out.pairs).toHaveLength(1);
    expect(out.omitted_pair_ids).toEqual(['duplicate', 'duplicate']);
    expect(out.omitted_pair_indices).toEqual([1, 2]);

    const replay = out.omitted_pair_indices.map((i: number) => pairs[i]);
    const replayed = parse(await domDomHarness(400000)({ pairs: replay }));
    expect(replayed.pairs[0].summary.fail).toBe(0);
    expect(replayed.pairs[1].summary.fail).toBeGreaterThan(0);
  });

  it('dom-dom serialize measures the trace too: delivery at the kept=2 boundary equals its selecting budget', async () => {
    // the dom-dom twin of the M-MEASURE identity above (its quanta: trace 692 vs pair 643).
    const pairs = domDomPairs(9);
    const runAt = async (budget: number) => {
      const res = await domDomHarness(budget)({ pairs });
      return { len: res.content[0].text.length, kept: parse(res).pairs.length };
    };
    const full = await runAt(400000);
    let lo = 1, hi = full.len;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await runAt(mid)).kept >= 2) hi = mid; else lo = mid + 1;
    }
    const l2 = await runAt(lo);
    expect(l2.kept).toBe(2);
    expect(l2.len).toBe(lo);
  });

  it('an unclamped dom-dom response carries none of the new surface', async () => {
    const out = parse(await domDomHarness(400000)({ pairs: domDomPairs(2) }));
    expect(out.omitted_pair_ids).toBeUndefined();
    expect(out.omitted_pair_indices).toBeUndefined();
    expect(dropNotes(out)).toHaveLength(0);
  });
});

// The report unit: the two prose branches, in isolation from the tools.
const zeroSummary = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 };
const cleanPair = { node_id: 'a', label: 'a', rows: [], summary: { ...zeroSummary, pass: 1 }, coverage: { measured: ['size'], skipped: [] } } as any;
const emptyBlockingReceipt: VerificationReceipt = {
  complete: false, scope: 'pairs', pairs: { checked: 5, clean: 4 }, blocking: [],
} as VerificationReceipt;

describe('renderReport: the omittedFailPairs input', () => {
  it('flips the verdict to red - a measured FAIL is a defect, delivered or not', () => {
    const md = renderReport({ tolerancePx: 1, pairs: [cleanPair], verification: emptyBlockingReceipt,
      omittedPairs: 4, omittedFailPairs: 1, headerLine: 'x', sideLabels: ['reference', 'candidate'] });
    expect(md).toContain('discrepancies found');
    expect(md).not.toContain('no defects found');
  });
  it('replaces the inherent-only caveat when a dropped pair held the gate', () => {
    const md = renderReport({ tolerancePx: 1, pairs: [cleanPair], verification: emptyBlockingReceipt,
      omittedPairs: 4, omittedFailPairs: 1, headerLine: 'x', sideLabels: ['reference', 'candidate'] });
    expect(md).not.toContain('Only inherent items remain');
    expect(md).toMatch(/omitted_pair_indices/);
  });
  it('clean drops keep both existing sentences byte-stable (the crying-wolf decision holds)', () => {
    const md = renderReport({ tolerancePx: 1, pairs: [cleanPair], verification: emptyBlockingReceipt,
      omittedPairs: 4, headerLine: 'x', sideLabels: ['reference', 'candidate'] });
    expect(md).toContain('no defects found, but CHECK INCOMPLETE');
    expect(md).toContain('Only inherent items remain');
  });
});
