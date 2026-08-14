import { describe, it, expect } from 'vitest';
import { renderReport } from '../../src/domain/layout-spec/report.js';
import type { PairResult, VerificationReceipt } from '../../src/domain/layout-spec/types.js';

const pair: PairResult = {
  node_id: '12:360', label: 'drawer-body', selector: '.drawer-body',
  rows: [
    { prop: 'size.w', figma: 343, dom: 343, status: 'pass' },
    { prop: 'gap[0] title↔reasons', figma: 20, dom: 48, delta: 28, status: 'fail' },
    { prop: 'component', figma: 'listItem/basic', dom: 'label.custom-radio', status: 'warn', note: 'heuristic' },
  ],
  summary: { pass: 1, fail: 1, warn: 1, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
};

describe('renderReport', () => {
  it('renders header, per-pair block with non-pass rows only, and totals', () => {
    const md = renderReport({ file: 'AbCdEf012345', tolerancePx: 1, pairs: [pair], frame: { node_id: '12:1000', width: 375 } });
    expect(md).toContain('Verified against Figma');
    expect(md).toContain('**drawer-body** (node 12:360 ↔ .drawer-body)');
    expect(md).toContain('❌ gap[0] title↔reasons: Figma 20 / DOM 48 (Δ28)');
    expect(md).toContain('⚠️ component: Figma listItem/basic / DOM label.custom-radio — heuristic');
    expect(md).not.toContain('size.w'); // pass rows aren't listed
    expect(md).toMatch(/Total: ✅1 ❌1 ⚠️1 ⏭0 ℹ️0 — discrepancies found/);
  });

  // C-footer: the deep-TEXT hint must name the real remedy "raise max_depth (up to 8)", as the
  // per-row unchecked notes already do (diff.ts) — the footer used to advise only "add a pair".
  it('footer typography hint names the max_depth remedy (not just "add a pair")', () => {
    const md = renderReport({ file: 'AbCdEf012345', tolerancePx: 1, pairs: [pair], depthLevels: 4 });
    expect(md).toContain('typography checked to 4 nesting levels');
    expect(md).toContain('raise max_depth (up to 8)');
    expect(md).toContain('add a separate pair on the TEXT node');
  });

  it('reports clean verdict and omitted pairs', () => {
    const clean: PairResult = { ...pair, rows: [pair.rows[0]], summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 } };
    const md = renderReport({ file: 'AbCdEf012345', tolerancePx: 1, pairs: [clean], omittedPairs: 2 });
    expect(md).toMatch(/no discrepancies above tolerance/);
    expect(md).toContain('2 pairs');
    expect(md).toContain('included in the aggregate verdict');
    expect(md).not.toContain('already measured');
    expect(md).not.toContain('call compare again');
  });

  it('surfaces a pass-status unwrapped row even though other pass rows are suppressed (I1)', () => {
    const withUnwrapped: PairResult = {
      ...pair,
      rows: [...pair.rows, { prop: 'unwrapped', figma: 'dom', dom: 'div', status: 'pass', note: 'cardinality fixed by auto-descent' }],
    };
    const md = renderReport({ file: 'AbCdEf012345', tolerancePx: 1, pairs: [withUnwrapped] });
    expect(md).toContain('unwrapped');
  });

  it('renders info rows with ℹ️ icon and counts info in per-pair header + total', () => {
    const withInfo: PairResult = {
      node_id: '1:1', label: 'drawer', rows: [
        { prop: 'size.w', figma: 420, dom: 409, delta: 11, status: 'info', note: 'fixed overlay: width is informational (see overlay_width)' },
      ],
      summary: { pass: 0, fail: 0, warn: 0, skip: 0, info: 1, demoted: 0, unchecked: 0, review: 0 },
    };
    const md = renderReport({ file: 'AbCdEf012345', tolerancePx: 1, pairs: [withInfo] });
    expect(md).toContain('ℹ️ size.w');
    expect(md).toMatch(/\*\*drawer\*\*.*ℹ️1/);
    expect(md).toMatch(/Total:.*ℹ️1/);
  });

  it('footer: NOT_COVERED only icons + icons narrowing', () => {
    const md = renderReport({ file: 'f', tolerancePx: 1, pairs: [] });
    expect(md).toContain('NOT covered by this tool (verify visually): icon-glyph');
    expect(md).toContain('icon-font/mask-image');
    expect(md).not.toContain('box-shadow');
    expect(md).not.toContain('border-color');
    expect(md).toContain('size/position/color are measured');
    // the icon claim is MODE-DEPENDENT: a caller-supplied notCovered list (the dom-dom fork)
    // must NOT get the color claim its own not-covered line disclaims
    const dd = renderReport({ headerLine: 'x', tolerancePx: 1, pairs: [], notCovered: ['icons'] });
    expect(dd).not.toContain('size/position/color are measured');
    expect(dd).toContain('does not check glyph/shape or icon color in this mode');
  });

  it('renders an optional preflight warning BEFORE the per-pair sections', () => {
    const md = renderReport({
      file: 'AbCdEf012345', tolerancePx: 1, pairs: [pair],
      preflight: 'frame w464, overlay 420 — check the breakpoint variant (find_breakpoint_variant)',
    });
    const preflightIdx = md.indexOf('find_breakpoint_variant');
    const pairIdx = md.indexOf('drawer-body');
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(pairIdx);
  });
});

describe('renderReport — honest demoted signal in the summary', () => {
  const mkPair = (over: Partial<PairResult>): PairResult => ({
    node_id: '1:1', label: 'row', selector: '.row', rows: [], coverage: { measured: [], skipped: [] },
    summary: { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 }, ...over,
  });
  it('E1: a fully-demoted pair (fail=0, demoted>0) does NOT read as clean', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair({
      rows: [{ prop: 'padding-right', figma: 0, dom: 157, delta: 157, status: 'demoted', note: 'spacer justify-content: space-between …' }],
      summary: { pass: 2, fail: 0, warn: 0, skip: 0, info: 0, demoted: 1, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('🟰');
    expect(md).toContain('not verified');
    expect(md).toContain('verify visually');
    expect(md).not.toContain('no discrepancies above tolerance');
  });
  it('E1b: the counter token 🟰N is present in the HEADER and the Total (isolated lock of demHead/demTotal, not the per-row 🟰)', () => {
    // The per-row 🟰 (rowLine: "- 🟰 padding-right …") masks toContain('🟰') in E1/E3 — if demHead/demTotal
    // were removed, E1/E3 would stay green. Here we lock the counter token itself via the adjacency
    // "❌0 🟰1 ⚠️0", which the per-row 🟰 does not produce. Mutation: remove demHead → header "❌0 ⚠️0" →
    // RED; remove demTotal → Total "❌0 ⚠️0" → RED.
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair({
      rows: [{ prop: 'padding-right', figma: 0, dom: 157, delta: 157, status: 'demoted', note: 'spacer …' }],
      summary: { pass: 2, fail: 0, warn: 0, skip: 0, info: 0, demoted: 1, unchecked: 0, review: 0 },
    })] });
    // the head-specific anchor "): " (close of label↔selector) — otherwise the substring "❌0 🟰1 ⚠️0"
    // also matches the Total line (demTotal), masking the removal of demHead.
    expect(md).toMatch(/\): ✅2 ❌0 🟰1 ⚠️0/);     // demHead (pair header)
    expect(md).toMatch(/Total: ✅2 ❌0 🟰1 ⚠️0/);   // demTotal (Total)
  });
  it('E2: a clean pair (demoted=0) — verdict byte-for-byte, no 🟰 and no "not verified"', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair({
      rows: [{ prop: 'size.w', figma: 100, dom: 100, status: 'pass' }],
      summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).not.toContain('🟰');
    expect(md).toContain('no discrepancies above tolerance');
    expect(md).not.toContain('not verified');
  });
  it('E3: fail>0 dominates (verdict "discrepancies found"), but the 🟰 counter is in the header', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair({
      rows: [
        { prop: 'gap[0]', figma: 20, dom: 48, delta: 28, status: 'fail' },
        { prop: 'padding-right', figma: 0, dom: 157, delta: 157, status: 'demoted', note: 'spacer …' },
      ],
      summary: { pass: 0, fail: 1, warn: 0, skip: 0, info: 0, demoted: 1, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('discrepancies found');
    expect(md).toContain('🟰');
  });
});

describe('renderReport — honest review signal (awaiting token confirmation) in the summary', () => {
  // Durability lock whole-branch minor b: review>0 must (1) gate the verdict (notVerified.push "awaiting
  // token confirmation", report.ts) and (2) emit the counter token 📝N (revHead/revTotal). Neither the
  // demoted/unchecked/holes tests nor the rest of the suite set review>0 → a refactor that dropped the
  // review gate OR the 📝 counter would pass the whole suite SILENTLY = a silent false green (a "token mode
  // unconfirmed" pair would collapse into "no discrepancies"). The R1/R1b/R2/R3 set catches each mutation.
  const mkPairR = (over: Partial<PairResult>): PairResult => ({
    node_id: '1:1', label: 'row', selector: '.row', rows: [], coverage: { measured: [], skipped: [] },
    summary: { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 }, ...over,
  });
  it('R1: a review pair with DIVERGED values (fail=0, review>0) does NOT read as clean — "awaiting token confirmation"', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPairR({
      rows: [{ prop: 'fill', figma: '#8b6afb', dom: '#7a59ea', status: 'review', note: 'token mode not confirmed' }],
      summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 1 },
    })] });
    expect(md).toContain('awaiting token confirmation');       // mutation: remove the review push → it disappears
    expect(md).toContain('verify visually');
    expect(md).not.toContain('no discrepancies above tolerance'); // ← would have been a silent false green
  });
  it('R1a: a review pair with byte-equal values is advisory — green verdict, 📝 stays visible', () => {
    // Live-run p.11: "the node's mode is not confirmed" over two identical hexes is a property of the
    // design file, not of the code; the verdict must mirror verification.complete (which no longer
    // gates on such rows), while the 📝 counter and the row itself keep the residue visible.
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPairR({
      rows: [{ prop: 'fill', figma: '#8b6afb', dom: '#8b6afb', status: 'review', note: 'token mode not confirmed' }],
      summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 1 },
    })] });
    expect(md).toContain('no discrepancies above tolerance');
    expect(md).not.toContain('awaiting token confirmation');
    expect(md).toMatch(/Total: ✅1 ❌0 📝1/); // visible, just not a blocker
  });
  it('R1b: the counter token 📝N in the HEADER and the Total (isolated lock of revHead/revTotal)', () => {
    // Mutation: remove revHead → header "❌0 ⚠️0" → RED; remove revTotal → Total "❌0 ⚠️0" → RED. The head
    // anchor "): " separates the header from the Total (otherwise the substring matches both lines, masking
    // the removal of revHead).
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPairR({
      rows: [{ prop: 'fill', figma: '#8b6afb', dom: '#8b6afb', status: 'review', note: 'token mode not confirmed' }],
      summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 1 },
    })] });
    expect(md).toMatch(/\): ✅1 ❌0 📝1 ⚠️0/);    // revHead (pair header)
    expect(md).toMatch(/Total: ✅1 ❌0 📝1 ⚠️0/);  // revTotal (Total)
  });
  it('R2: a clean pair (review=0) — verdict byte-for-byte, no 📝 and no "awaiting confirmation"', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPairR({
      rows: [{ prop: 'size.w', figma: 100, dom: 100, status: 'pass' }],
      summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).not.toContain('📝');
    expect(md).toContain('no discrepancies above tolerance');
    expect(md).not.toContain('awaiting token confirmation');
  });
  it('R3: fail>0 dominates (verdict "discrepancies found"), but the 📝 counter is in the header', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPairR({
      rows: [
        { prop: 'gap[0]', figma: 20, dom: 48, delta: 28, status: 'fail' },
        { prop: 'fill', figma: '#8b6afb', dom: '#8b6afb', status: 'review', note: 'token mode not confirmed' },
      ],
      summary: { pass: 0, fail: 1, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 1 },
    })] });
    expect(md).toContain('discrepancies found');
    expect(md).toContain('📝');
  });
});

describe('renderReport — honest unchecked signal (not verified) in the summary', () => {
  const mkPair2 = (over: Partial<PairResult>): PairResult => ({
    node_id: '1:1', label: 'row', selector: '.row', rows: [], coverage: { measured: [], skipped: [] },
    summary: { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 }, ...over,
  });
  it('E1: unchecked-only (fail=0, demoted=0, unchecked>0) does NOT read as clean', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair2({
      rows: [{ prop: 'typography_descent[item]', status: 'unchecked', note: 'text below the slice, raise max_depth' }],
      summary: { pass: 8, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 1, review: 0 },
    })] });
    expect(md).toContain('👁');
    expect(md).toContain('not verified (out of reach)');
    expect(md).toContain('verify visually');
    expect(md).not.toContain('no discrepancies above tolerance');
  });
  it('E2: a clean pair (unchecked=0, demoted=0) — verdict byte-for-byte, no 👁', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair2({
      rows: [{ prop: 'size.w', figma: 100, dom: 100, status: 'pass' }],
      summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).not.toContain('👁');
    expect(md).toContain('no discrepancies above tolerance');
    expect(md).not.toContain('not verified');
  });
  it('E2b: demoted-only (demoted>0, unchecked=0) — "CHECK INCOMPLETE: … (demoted)", no 👁', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair2({
      rows: [{ prop: 'padding-right', figma: 0, dom: 157, delta: 157, status: 'demoted', note: 'spacer …' }],
      summary: { pass: 2, fail: 0, warn: 0, skip: 0, info: 0, demoted: 1, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('CHECK INCOMPLETE: 1 not verified (demoted)');
    expect(md).toContain('verify visually');
    expect(md).not.toContain('no discrepancies above tolerance');
    expect(md).not.toContain('👁');
    expect(md).not.toContain('(out of reach)');
    expect(md).not.toContain('(structure/truncation/environment)');
  });
  it('E3: combo (demoted>0 && unchecked>0) — verdict contains BOTH (demoted) AND (out of reach)', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair2({
      rows: [
        { prop: 'padding-right', figma: 0, dom: 157, delta: 157, status: 'demoted', note: 'spacer …' },
        { prop: 'typography[item]', status: 'unchecked', note: 'below the slice' },
      ],
      summary: { pass: 3, fail: 0, warn: 0, skip: 0, info: 0, demoted: 1, unchecked: 1, review: 0 },
    })] });
    expect(md).toContain('not verified (demoted)');
    expect(md).toContain('not verified (out of reach)');
    expect(md).toContain('👁');
  });
  it('E4: fail>0 dominates, but the 👁 counter is in the header', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair2({
      rows: [
        { prop: 'gap[0]', figma: 20, dom: 48, delta: 28, status: 'fail' },
        { prop: 'geometry', status: 'unchecked', note: 'viewport ≠ frame' },
      ],
      summary: { pass: 0, fail: 1, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 1, review: 0 },
    })] });
    expect(md).toContain('discrepancies found');
    // the head anchor "): " isolates the counter token from the per-row 👁 (rowLine "- 👁 geometry …"),
    // otherwise toContain('👁') is vacuous (satisfied by the row regardless of the header token).
    expect(md).toMatch(/\): ✅0 ❌1 👁1 ⚠️0/);
  });
  it('E1b: the counter token 👁N in the HEADER and the Total (isolated lock, not the per-row 👁)', () => {
    // The per-row 👁 (rowLine) masks toContain('👁'); the head anchor "): " (absent in the Total) catches
    // removal of the head token, the Total anchor catches the total token. Both mutations separately → RED.
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkPair2({
      rows: [{ prop: 'typography[item]', status: 'unchecked', note: 'below the slice' }],
      summary: { pass: 8, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 1, review: 0 },
    })] });
    expect(md).toMatch(/\): ✅8 ❌0 👁1 ⚠️0/);     // head token
    expect(md).toMatch(/Total: ✅8 ❌0 👁1 ⚠️0/);   // Total token
  });
});

describe('renderReport — coverage holes in the verdict (live false green: warn/skip did not lower the total)', () => {
  const mkP = (over: Partial<PairResult>): PairResult => ({
    node_id: '1:1', label: 'row', selector: '.row', rows: [], coverage: { measured: [], skipped: [] },
    summary: { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 }, ...over,
  });

  it('BUG LOCK: structure_mismatch skipped children (warn, everything else pass) → NOT "no discrepancies" but "CHECK INCOMPLETE"', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkP({
      rows: [
        { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
        { prop: 'structure_mismatch', status: 'warn', note: 'visible child count did not match — pairwise metrics skipped' },
      ],
      summary: { pass: 1, fail: 0, warn: 1, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('CHECK INCOMPLETE: 1 not verified (structure/truncation/environment)');
    expect(md).toContain('do NOT treat as green');
    expect(md).not.toContain('no discrepancies above tolerance'); // ← was a false green
  });

  it('node not found (warn — the pair wasn\'t compared) → "CHECK INCOMPLETE", not green', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkP({
      rows: [{ prop: 'node', status: 'warn', note: 'node 1:1 not found in the file' }],
      summary: { pass: 0, fail: 0, warn: 1, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('CHECK INCOMPLETE: 1 not verified (structure/truncation/environment)');
    expect(md).not.toContain('no discrepancies above tolerance');
  });

  it('skip axis (children without auto-layout — not measured) → "CHECK INCOMPLETE"', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkP({
      rows: [
        { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
        { prop: 'children', status: 'skip', note: 'node without auto-layout — inter-element metrics not computed' },
      ],
      summary: { pass: 1, fail: 0, warn: 0, skip: 1, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('CHECK INCOMPLETE: 1 not verified (structure/truncation/environment)');
    expect(md).not.toContain('no discrepancies above tolerance');
  });

  it('ANTI-CRY-WOLF: component-only warn (metrics were measured, a caveat) → STAYS "no discrepancies"', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkP({
      rows: [
        { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
        { prop: 'component', figma: 'listItem/basic', dom: 'label.custom', status: 'warn', note: 'heuristic' },
      ],
      summary: { pass: 1, fail: 0, warn: 1, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('no discrepancies above tolerance'); // component is NOT a hole — don't flip to "incomplete"
    expect(md).not.toContain('CHECK INCOMPLETE');
  });

  it('ANTI-CRY-WOLF: fill-only warn (background maybe on another element) → STAYS "no discrepancies"', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkP({
      rows: [
        { prop: 'size.w', figma: 100, dom: 100, status: 'pass' },
        { prop: 'fill', figma: '#fff', dom: null, status: 'warn', note: 'the DOM element has no background' },
      ],
      summary: { pass: 1, fail: 0, warn: 1, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('no discrepancies above tolerance');
    expect(md).not.toContain('CHECK INCOMPLETE');
  });

  it('fail dominates over a hole: fail>0 + structure_mismatch → "discrepancies found" (no doubling)', () => {
    const md = renderReport({ file: 'abc', tolerancePx: 1, pairs: [mkP({
      rows: [
        { prop: 'gap[0] a↔b', figma: 20, dom: 48, delta: 28, status: 'fail' },
        { prop: 'structure_mismatch', status: 'warn', note: 'children did not match' },
      ],
      summary: { pass: 0, fail: 1, warn: 1, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
    })] });
    expect(md).toContain('discrepancies found');
    expect(md).not.toContain('no discrepancies above tolerance');
  });
});

describe('renderReport — "Check" block (A1 verification receipt)', () => {
  const cleanPair: PairResult = {
    node_id: 'A', label: 'a', selector: '.a',
    rows: [{ prop: 'size.w', figma: 10, dom: 10, status: 'pass' }],
    summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
  };
  const base = { file: 'abc', tolerancePx: 1, pairs: [cleanPair] };

  it('complete=true → "Check: COMPLETE ✅", the verdict stays green', () => {
    const verification: VerificationReceipt = {
      complete: true, scope: 'frame', pairs: { checked: 1, clean: 1 },
      frame_coverage: { worthy: 1, covered: 1, uncovered: [], partial: [], enumeration_truncated: false, enumeration_source: 'pair_fetch', enumeration_depth: 4 }, blocking: [],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('Check: COMPLETE ✅');
    expect(md).toContain('no discrepancies above tolerance');
  });

  it('scope pairs → note "ONLY the submitted pairs were checked, NOT the whole screen"', () => {
    const verification: VerificationReceipt = {
      complete: true, scope: 'pairs', pairs: { checked: 1, clean: 1 }, blocking: [],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('ONLY the submitted pairs were checked');
  });

  it('uncovered region → verdict degrades + "Check: INCOMPLETE" + blocking line [add_pair]', () => {
    const verification: VerificationReceipt = {
      complete: false, scope: 'frame', pairs: { checked: 1, clean: 1 },
      frame_coverage: { worthy: 2, covered: 1, uncovered: ['B'], partial: [], enumeration_truncated: false, enumeration_source: 'pair_fetch', enumeration_depth: 4 },
      blocking: [{ kind: 'uncovered_region', node_id: 'B', action: 'add_pair', detail: 'frame region unpaired' }],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('1 frame region(s) unpaired'); // the verdict accounted for frame coverage
    expect(md).not.toContain('no discrepancies above tolerance'); // ← would have been a frame-level false green
    expect(md).toContain('Check: INCOMPLETE');
    expect(md).toContain('Remaining (blocking, 1)');
    expect(md).toContain('[add_pair] node B');
  });

  it('a child blocker renders both the Figma node and the composed DOM selector', () => {
    const verification: VerificationReceipt = {
      complete: false, scope: 'pairs', pairs: { checked: 1, clean: 0 },
      blocking: [{
        kind: 'likely_misplaced_child', node_id: 'child-A', selector: ':is(.card, .panel) > :nth-child(2)',
        action: 'add_pair', detail: 'pair the child before editing the parent padding',
      }],
    };

    const md = renderReport({ ...base, verification });

    expect(md).toContain('[add_pair] node child-A ↔ :is(.card, .panel) > :nth-child(2)');
  });

  it('frame spacing hole → verdict "container(s) unpaired (spacing between children)"', () => {
    const verification: VerificationReceipt = {
      complete: false, scope: 'frame', pairs: { checked: 2, clean: 2 },
      frame_coverage: { worthy: 1, covered: 1, uncovered: [], partial: ['R'], enumeration_truncated: false, enumeration_source: 'pair_fetch', enumeration_depth: 4 },
      blocking: [{ kind: 'unchecked_spacing', node_id: 'R', action: 'add_container_pair', detail: 'children paired, container not' }],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('container(s) unpaired (spacing between children)');
    expect(md).toContain('[add_container_pair] node R');
  });

  // Mutation lock: the uncovered/partial JSON lists
  // are capped at 60 (capList, verification.ts), but the fixture frame carries 70 uncovered — the old prose
  // read the capped .length and lied "60 region(s)", understating the real count. We check BOTH points
  // (the renderReport notVerified line AND the renderVerification bits line) at once.
  it('FIX2: capped uncovered (60 in the list + uncovered_capped 10) — prose names the true total 70, not the capped 60', () => {
    const verification: VerificationReceipt = {
      complete: false, scope: 'frame', pairs: { checked: 1, clean: 1 },
      frame_coverage: {
        worthy: 70, covered: 0,
        uncovered: Array.from({ length: 60 }, (_, i) => `k${i}`), uncovered_capped: 10,
        partial: [], enumeration_truncated: false, enumeration_source: 'pair_fetch', enumeration_depth: 4,
      },
      blocking: [],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('70 frame region(s) unpaired');   // renderReport notVerified
    expect(md).not.toContain('60 frame region(s) unpaired');
    expect(md).toContain('regions unpaired 70');            // renderVerification bits
    expect(md).not.toContain('regions unpaired 60');
  });

  it('complete=false with an EMPTY blocking (demoted only) → "Only inherent items remain", no shouting', () => {
    const verification: VerificationReceipt = {
      complete: false, scope: 'pairs', pairs: { checked: 1, clean: 0 }, blocking: [],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('Only inherent items remain');
    expect(md).not.toContain('Remaining (blocking');
  });

  it('without verification → no "Check" block (backward compat)', () => {
    const md = renderReport(base);
    expect(md).not.toContain('Check:');
  });
});

// ── rendering the ⚖ spacing_audit block + the verdict accounting for audit-fail ──
describe('renderReport — spacing_audit (⚖) block + verdict', () => {
  const cleanPair: PairResult = {
    node_id: 'A', label: 'a', selector: '.a',
    rows: [{ prop: 'size.w', figma: 10, dom: 10, status: 'pass' }],
    summary: { pass: 1, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 },
  };
  const base = { file: 'abc', tolerancePx: 1, pairs: [cleanPair] };
  const baseV: VerificationReceipt = {
    complete: false, scope: 'frame', pairs: { checked: 1, clean: 1 },
    frame_coverage: { worthy: 1, covered: 1, uncovered: [], partial: ['L'], enumeration_truncated: false, enumeration_source: 'pair_fetch', enumeration_depth: 4 },
    blocking: [],
  };

  it('renders the ⚖ line with pass/fail/unchecked segments + one final insets note', () => {
    const verification: VerificationReceipt = {
      ...baseV,
      spacing_audit: [{
        container_id: 'L', axis: 'row',
        gaps: [
          { between: ['a', 'b'], figma: 24, dom: 24, delta: 0, status: 'pass' },
          { between: ['b', 'c'], figma: 24, dom: 31, delta: 7, status: 'fail', note: 'Δ7px (tolerance 1px incl. borders)' },
          { between: ['c', 'd'], figma: 10, status: 'unchecked', note: 'note' },
        ],
        insets_unverified: true,
      }],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('⚖ spacing-audit L: gap a↔b 24/24 ✅ · gap b↔c 24/31 ❌ Δ7 · gap c↔d 👁 (note)');
    expect(md).toContain('the container insets are not verified by the audit — for a fully green result add a container pair');
  });

  it('several spacing_audit entries → one ⚖ line PER container, but the final insets note is ONE (not duplicated)', () => {
    const verification: VerificationReceipt = {
      ...baseV,
      spacing_audit: [
        { container_id: 'L', axis: 'row', gaps: [{ between: ['a', 'b'], figma: 24, dom: 24, delta: 0, status: 'pass' }], insets_unverified: true },
        { container_id: 'M', axis: 'col', gaps: [{ between: ['x', 'y'], figma: 8, dom: 8, delta: 0, status: 'pass' }], insets_unverified: true },
      ],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('⚖ spacing-audit L:');
    expect(md).toContain('⚖ spacing-audit M:');
    const noteOccurrences = md.split('the container insets are not verified by the audit').length - 1;
    expect(noteOccurrences).toBe(1);
  });

  // VERDICT MUTATION LOCK (plan point 6): a fixture with total.fail===0 on ALL pairs (cleanPair — pass only)
  // — the verdict must move to "discrepancies found" EXACTLY because of a spacing_audit fail, not because of
  // total.fail. If auditFail is removed from the verdict condition in report.ts, this test goes red (the live
  // mutation is confirmed).
  it('MUTATION LOCK: pairs.fail===0 everywhere, but spacing_audit contains a fail → "discrepancies found"', () => {
    const verification: VerificationReceipt = {
      ...baseV,
      spacing_audit: [{
        container_id: 'L', axis: 'row',
        gaps: [{ between: ['a', 'b'], figma: 24, dom: 31, delta: 7, status: 'fail', note: 'Δ7px' }],
        insets_unverified: true,
      }],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('discrepancies found');
  });

  it('spacing_audit absent (undefined) → no ⚖ block at all (backward compat)', () => {
    const md = renderReport({ ...base, verification: baseV });
    expect(md).not.toContain('⚖');
  });

  // Mutation lock: the fully_clean container L verified ALL expected
  // between-children gaps (the audit passed entirely) — the old prose still counted L under "unpaired
  // (spacing between children)", mis-attributing ALREADY-verified spacing as unverified. We check BOTH
  // points (the notVerified line in renderReport + the bits line in renderVerification within "Check: INCOMPLETE").
  it('a fully_clean spacing audit reports the separate unverified-container debt without calling spacing unchecked', () => {
    const verification: VerificationReceipt = {
      ...baseV,
      frame_coverage: { ...baseV.frame_coverage!, unverified_containers: ['L'] },
      spacing_audit: [{
        container_id: 'L', axis: 'row',
        gaps: [{ between: ['a', 'b'], figma: 24, dom: 24, delta: 0, status: 'pass' }],
        insets_unverified: true, fully_clean: true,
      }],
    };
    const md = renderReport({ ...base, verification });
    expect(md).not.toContain('unpaired (spacing between children)');
    expect(md).not.toContain('containers unpaired (spacing)');
    expect(md).toContain('own layout/insets of 1 container(s) not verified');
  });

  it('reports a clean frame-spacing audit alongside separate nested own-layout debt', () => {
    const verification: VerificationReceipt = {
      ...baseV,
      frame_coverage: {
        ...baseV.frame_coverage!,
        partial: ['F:0', 'L'],
        unverified_containers: ['L'],
      },
      spacing_audit: [{
        container_id: 'F:0', axis: 'row',
        gaps: [{ between: ['a', 'b'], figma: 24, dom: 24, delta: 0, status: 'pass' }],
        insets_unverified: true, fully_clean: true,
      }],
    };

    const md = renderReport({
      ...base,
      frame: { node_id: 'F:0' },
      verification,
    });

    expect(md).toContain('own layout/insets of 1 container(s) not verified');
    expect(md).toContain(
      'insets of 1 container(s) not verified (between-children gaps clean per audit)',
    );
  });

  // Counter-fixture (mandatory symmetric lock): WITHOUT fully_clean (an unchecked audit, the gap not verified
  // — e.g. different dom_ref batches) the old line must stay in place — fully_clean is NOT guessed, only an
  // explicitly set field suppresses the mis-attribution.
  it('FIX3 counter-fixture: an unchecked audit (NOT fully_clean) — the old line "container(s) unpaired (spacing between children)" stays in place', () => {
    const verification: VerificationReceipt = {
      ...baseV,
      spacing_audit: [{
        container_id: 'L', axis: 'row',
        gaps: [{ between: ['a', 'b'], figma: 24, status: 'unchecked', note: 'gap not verified: pairs from different captures' }],
        insets_unverified: true,
      }],
      blocking: [{ kind: 'unchecked_spacing', node_id: 'L', action: 'add_container_pair', detail: 'children paired, container not' }],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('1 container(s) unpaired (spacing between children)');
    expect(md).toContain('containers unpaired (spacing) 1');
    expect(md).not.toContain('insets of 1 container(s) not verified');
  });

  // Mutation lock: an empty blocking (nothing actionable) with a fully_clean
  // audit — the generic caveat used to name only "demoted/out of reach", silently hiding the THIRD honest
  // reason ("container insets with a clean audit"), which here is the only remainder.
  it('FIX4: empty blocking + fully_clean audit → extended caveat wording ("…/container insets with a clean audit")', () => {
    const verification: VerificationReceipt = {
      ...baseV,
      spacing_audit: [{
        container_id: 'L', axis: 'row',
        gaps: [{ between: ['a', 'b'], figma: 24, dom: 24, delta: 0, status: 'pass' }],
        insets_unverified: true, fully_clean: true,
      }],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('Only inherent items remain (demoted/out of reach/container insets with a clean audit) — verify visually, no auto-actions.');
    expect(md).not.toContain('Only inherent items remain (demoted/out of reach) — verify visually, no auto-actions.');
  });

  // Counter-fixture: without a fully_clean audit (empty blocking, no spacing_audit at all) — the old short
  // wording MUST stay byte-for-byte (the mutation "always the long wording" → RED).
  it('FIX4 counter-fixture: empty blocking WITHOUT a fully_clean audit → the old wording untouched', () => {
    const verification: VerificationReceipt = {
      complete: false, scope: 'pairs', pairs: { checked: 1, clean: 0 }, blocking: [],
    };
    const md = renderReport({ ...base, verification });
    expect(md).toContain('Only inherent items remain (demoted/out of reach) — verify visually, no auto-actions.');
    expect(md).not.toContain('container insets with a clean audit');
  });
});
