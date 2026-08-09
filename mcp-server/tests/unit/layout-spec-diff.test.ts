// mcp-server/tests/unit/layout-spec-diff.test.ts
import { describe, it, expect } from 'vitest';
import { diffPair, summarize, widthNoiseTolerance, deriveCoverage, coverageHoleRows } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import { buildLayoutSpec } from '../../src/domain/layout-spec/projector.js';
import type { LayoutSpec, DomSnapshotOk, SpecChild, DomChild } from '../../src/domain/layout-spec/types.js';
import { SNIPPET_CAP } from '../../src/domain/layout-spec/types.js';
import { domContentUnknown } from '../../src/domain/layout-spec/pair-matcher.js';
import { DOM_SNAPSHOT_SCHEMA_VERSION } from '../../src/adapters/driving/tools/dom-snapshot-schema.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const spec = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '1:1', name: 'card', type: 'FRAME' },
  rect: { x: 0, y: 0, w: 343, h: 120 }, axis: 'col',
  children: [
    { id: '1:2', name: 'title', type: 'TEXT', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { id: '1:3', name: 'list', type: 'FRAME', rect: { x: 16, y: 56, w: 311, h: 40 } }, // gap 20
  ],
  ...over,
});

const snap = (over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 1, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 120 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, transformed: false,
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 120, scrollHeight: 120,
  children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 84, w: 311, h: 40 } }, // gap 48
  ],
  ...over,
});

const row = (rows: ReturnType<typeof diffPair>, prefix: string) => rows.find((r) => r.prop.startsWith(prefix));

describe('diffPair — guards & structure & gaps', () => {
  it('failed snapshot → single warn row', () => {
    const rows = diffPair(spec(), { status: 'not_found', selector: '.gone' }, { tolerancePx: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prop: 'snapshot', status: 'warn' });
  });

  it('transform/scroll/viewport reasons collapse geometry into one skip row', () => {
    const rows = diffPair(spec(), snap({ transformed: true, scroll: { top: 40, left: 0 }, innerWidth: 1280 }),
      { tolerancePx: 1, frameWidth: 375 });
    const geo = row(rows, 'geometry');
    expect(geo?.status).toBe('unchecked');
    expect(geo?.note).toMatch(/transform/);
    expect(geo?.note).toMatch(/scroll/);
    expect(geo?.note).toMatch(/viewport/);
    expect(row(rows, 'size.w')).toBeUndefined();
    expect(row(rows, 'gap[')).toBeUndefined();
  });

  it('viewport pass row emitted when frameWidth given and matches', () => {
    const rows = diffPair(spec(), snap(), { tolerancePx: 1, frameWidth: 375 });
    expect(row(rows, 'viewport')).toMatchObject({ figma: 375, dom: 375, status: 'pass' });
  });

  it('size compared with tolerance', () => {
    const rows = diffPair(spec(), snap({ rect: { x: 0, y: 0, w: 343.6, h: 140 },
      clientWidth: 343.6, clientHeight: 140, scrollHeight: 140 }), { tolerancePx: 1 });
    expect(row(rows, 'size.w')?.status).toBe('pass');
    expect(row(rows, 'size.h')).toMatchObject({ status: 'fail', delta: 20 });
  });

  it('regression Δ1: title→list 48 vs 20 → gap fail with delta 28', () => {
    const rows = diffPair(spec(), snap(), { tolerancePx: 1 });
    const gap = row(rows, 'gap[0]');
    expect(gap).toMatchObject({ figma: 20, dom: 48, delta: 28, status: 'fail' });
    expect(gap?.prop).toBe('gap[0] title↔list');
  });

  // The advice on a structure mismatch used to be "raise max_depth", which cannot return a child the
  // extractor excluded for being out of flow. Measured live: a fixed site header vanished this way.
  it('an out-of-flow child is named, together with the action that can actually reach it', () => {
    const rows = diffPair(spec(), snap({ children: [snap().children[0]], outOfFlow: 2 }), { tolerancePx: 1 });
    const note = row(rows, 'structure_mismatch')?.note ?? '';
    expect(note).toContain('2 DOM child(ren) are out of flow');
    expect(note).toContain('a deeper capture will NOT reveal them');
    expect(note).toContain('pair such an element directly');
  });

  it('and says nothing of the kind when nothing was out of flow', () => {
    // the co-lock: without it the clause could be unconditional and the test above would still pass
    const rows = diffPair(spec(), snap({ children: [snap().children[0]] }), { tolerancePx: 1 });
    expect(row(rows, 'structure_mismatch')?.note ?? '').not.toContain('out of flow');
  });

  // The same class in the other direction (live-run p.2/p.8): the SPEC filter drops ABSOLUTE
  // overlays/modals, the child counts then differ, and without a name the reader goes hunting
  // for a capture knob. The projector now counts them (LayoutSpec.outOfFlow) — the mismatch
  // note must name the Figma side symmetrically.
  it('a Figma-side out-of-flow child is named symmetrically in the mismatch note', () => {
    const rows = diffPair({ ...spec(), outOfFlow: 3 }, snap({ children: [snap().children[0]] }), { tolerancePx: 1 });
    const note = row(rows, 'structure_mismatch')?.note ?? '';
    expect(note).toContain('3 Figma child(ren) are out of flow');
    expect(note).toContain('pair such a node directly');
  });

  it('cardinality mismatch → structure_mismatch warn, no pairwise rows', () => {
    const rows = diffPair(spec(), snap({ children: [snap().children[0]] }), { tolerancePx: 1 });
    const sm = row(rows, 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    expect(String(sm?.figma)).toContain('title');
    expect(String(sm?.dom)).toContain('h2');
    expect(row(rows, 'gap[')).toBeUndefined();
  });

  it('non-monotonic DOM children → layout_axis_mismatch fail, no gap rows', () => {
    const rows = diffPair(spec(), snap({ children: [
      { kind: 'element', tag: 'h2', rect: { x: 16, y: 84, w: 200, h: 24 } },
      { kind: 'element', tag: 'div', rect: { x: 16, y: 12, w: 311, h: 40 } },
    ] }), { tolerancePx: 1 });
    expect(row(rows, 'layout_axis_mismatch')?.status).toBe('fail');
    expect(row(rows, 'gap[')).toBeUndefined();
  });

  it('no auto-layout → children skip row', () => {
    const rows = diffPair(spec({ axis: undefined }), snap(), { tolerancePx: 1 });
    expect(row(rows, 'children')?.status).toBe('skip');
  });

  it('rect≈0 on either side → geometry skip (likely hidden)', () => {
    const rows = diffPair(spec({ rect: { x: 0, y: 0, w: 0.5, h: 120 } }), snap(), { tolerancePx: 1 });
    expect(row(rows, 'geometry')?.status).toBe('unchecked');
    expect(row(rows, 'geometry')?.note).toMatch(/rect≈0/);
  });

  // (b) viewport ergonomics: for a viewport reason the geometry row carries STRUCTURAL
  // numbers (figma/dom) — verification.ts/the header need not parse the note's prose to build
  // actionable advice (fix_viewport with numbers). Other geometry reasons carry no fields (nothing to carry).
  it('(b) viewport-off: the geometry row carries structural figma/dom numbers (for the header — do not parse prose)', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 1429 }), { tolerancePx: 1, frameWidth: 1920 });
    const geo = row(rows, 'geometry');
    expect(geo).toMatchObject({ status: 'unchecked', figma: 1920, dom: 1429 });
  });

  // PREMISE LOCK for docs/coverage.md's "Viewport must match the frame width" row. That row now
  // states the guard is SYMMETRIC: diff.ts computes
  // `Math.abs(d.innerWidth - opts.frameWidth) > widthNoiseTolerance(opts.frameWidth)`, so a 1920px
  // window against a 1440px frame is 480 over a tolerance of max(24, 72) = 72 and is refused exactly
  // like a narrower one. Before this commit the row claimed the opposite -- "a WIDER window with a
  // centered layout is fine" -- which describes the upload-time viewport_warning in
  // dom-snapshot-routes.ts (asymmetric by an explicit `iw <= Math.max(...widths)`), not this guard.
  // Green by construction today; it exists so the sentence cannot quietly become wrong.
  //
  // IT TAKES BOTH ROWS. The row above measures a NARROWER window, this one a WIDER window, and each
  // one-directional rewrite of the guard is caught by exactly one of them -- measured, not assumed:
  // rewriting it as `opts.frameWidth - d.innerWidth > ...` (fire only when narrower, the shape the
  // old prose described) fails THIS row and leaves the one above green, while
  // `d.innerWidth - opts.frameWidth > ...` fails the one above and leaves this one green. Deleting
  // either row therefore reopens one direction of the claim.
  //
  // A wider window WAS already present in this file before this row -- the collapse test at the top
  // of this block passes innerWidth 1280 against frameWidth 375 -- but it is not a premise lock: it
  // also sets `transformed` and a non-zero scroll, and either of those produces the unchecked
  // geometry row on its own, so it locks only the substring "viewport" in the joined note. It would
  // stay green if the viewport reason stopped demoting geometry entirely. This row carries no other
  // reason, so the demotion itself is what it asserts.
  it('(b) premise lock: a WIDER window is refused exactly like a narrower one -- the guard is symmetric', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 1920 }), { tolerancePx: 1, frameWidth: 1440 });
    const geo = row(rows, 'geometry');
    expect(geo).toMatchObject({ prop: 'geometry', status: 'unchecked', figma: 1440, dom: 1920 });
    // The note names the viewport, which is what verification.ts branches on to emit fix_viewport.
    expect(geo?.note).toMatch(/viewport 1920 vs frame 1440/);
    // Not measured at all -- no geometry row survives, which is the half of the claim that makes the
    // tutorial's status table file this under `skip`/`unchecked` rather than `info`/`demoted`.
    expect(row(rows, 'size.w')).toBeUndefined();
  });

  it('(b) control: a scroll reason (not viewport) → geometry row WITHOUT figma/dom fields', () => {
    const rows = diffPair(spec(), snap({ scroll: { top: 40, left: 0 } }), { tolerancePx: 1 });
    const geo = row(rows, 'geometry');
    expect(geo?.status).toBe('unchecked');
    expect(geo?.figma).toBeUndefined();
    expect(geo?.dom).toBeUndefined();
  });

  it('summarize counts statuses', () => {
    const s = summarize([{ prop: 'a', status: 'pass' }, { prop: 'b', status: 'fail' }, { prop: 'c', status: 'fail' }]);
    expect(s).toEqual({ pass: 1, fail: 2, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 });
  });

  it('summarize counts info', () => {
    const s = summarize([{ prop: 'a', status: 'pass' }, { prop: 'b', status: 'info' }, { prop: 'c', status: 'info' }]);
    expect(s).toEqual({ pass: 1, fail: 0, warn: 0, skip: 0, info: 2, demoted: 0, unchecked: 0, review: 0 });
  });

  it('summarize counts demoted separately from info', () => {
    const s = summarize([{ prop: 'a', status: 'demoted' }, { prop: 'b', status: 'info' }]);
    expect(s).toEqual({ pass: 0, fail: 0, warn: 0, skip: 0, info: 1, demoted: 1, unchecked: 0, review: 0 });
  });
  it('deriveCoverage: a demoted row = measured (not skipped)', () => {
    const cov = deriveCoverage([{ prop: 'padding-right', status: 'demoted' }]);
    expect(cov.measured).toContain('padding');
    expect(cov.skipped).toEqual([]);
  });
  it('summarize counts unchecked separately from skip', () => {
    const s = summarize([{ prop: 'geometry', status: 'unchecked' }, { prop: 'size.h', status: 'skip' }]);
    expect(s).toEqual({ pass: 0, fail: 0, warn: 0, skip: 1, info: 0, demoted: 0, unchecked: 1, review: 0 });
  });
});

describe('diffPair — E: hug-vs-fill container (Figma hug / DOM fill)', () => {
  // Live acceptance repro (btns 12:371): Figma hugs the content by width (395 = 197+gap8+190),
  // DOM stretches to the parent (956), the buttons are pinned left, the DOM buttons carry an internal padding 28
  // (Figma's lies deeper → 0 at the measured level). This gave 4 false ❌: size.w/gap/padding-l/padding-r.
  const btnsSpec = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({
    node: { id: '1:1', name: 'btns', type: 'FRAME' }, rect: { x: 0, y: 0, w: 395, h: 52 }, axis: 'row',
    hugWidth: true,
    children: [
      { id: '1:2', name: 'btn0', type: 'INSTANCE', rect: { x: 0, y: 0, w: 197, h: 52 } },
      { id: '1:3', name: 'btn1', type: 'INSTANCE', rect: { x: 205, y: 0, w: 190, h: 52 } }, // border-box gap 8
    ],
    ...over,
  });
  const btnsDom = (over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => snap({
    rect: { x: 0, y: 0, w: 956, h: 52 }, clientWidth: 956, clientHeight: 52, scrollHeight: 52,
    paddings: { top: 0, right: 0, bottom: 0, left: 0 },
    children: [
      { kind: 'element', tag: 'button', rect: { x: 0, y: 0, w: 197, h: 52 }, paddings: { top: 4, right: 28, bottom: 4, left: 28 } },
      { kind: 'element', tag: 'button', rect: { x: 205, y: 0, w: 190, h: 52 }, paddings: { top: 4, right: 28, bottom: 4, left: 28 } },
    ],
    ...over,
  });

  it('hug-vs-fill: size.w + padding demoted 🟰, gap by border-box → pass (not a false ❌ 8 vs 64)', () => {
    const rows = diffPair(btnsSpec(), btnsDom(), { tolerancePx: 1 });
    expect(row(rows, 'size.w')).toMatchObject({ status: 'demoted' });
    expect(row(rows, 'size.w')?.note).toContain('container hug');
    const gap = row(rows, 'gap[');
    expect(gap).toMatchObject({ figma: 8, dom: 8, status: 'pass' });
    expect(gap?.note).toContain('border-box');
    expect(rows.find((r) => r.prop === 'padding-left')?.status).toBe('demoted');
    expect(rows.find((r) => r.prop === 'padding-right')?.status).toBe('demoted');
    expect(rows.some((r) => r.status === 'fail')).toBe(false); // not a single false ❌
  });

  it('GATE: Figma fixed-width (without hugWidth) + DOM wider → a REAL ❌ (not demoted), gap content-edge', () => {
    const rows = diffPair(btnsSpec({ hugWidth: undefined }), btnsDom(), { tolerancePx: 1 });
    expect(row(rows, 'size.w')).toMatchObject({ figma: 395, dom: 956, status: 'fail' });
    expect(row(rows, 'gap[')).toMatchObject({ figma: 8, dom: 64, status: 'fail' }); // content-edge subtracts the buttons' padding
    expect(row(rows, 'gap[')?.note ?? '').not.toContain('border-box');
  });

  it('hug, but DOM NOT wider (== 395) → no demotion, an ordinary content-edge pass', () => {
    const rows = diffPair(btnsSpec(), btnsDom({
      rect: { x: 0, y: 0, w: 395, h: 52 }, clientWidth: 395,
      children: [
        { kind: 'element', tag: 'button', rect: { x: 0, y: 0, w: 197, h: 52 }, paddings: { top: 0, right: 0, bottom: 0, left: 0 } },
        { kind: 'element', tag: 'button', rect: { x: 205, y: 0, w: 190, h: 52 }, paddings: { top: 0, right: 0, bottom: 0, left: 0 } },
      ],
    }), { tolerancePx: 1 });
    expect(row(rows, 'size.w')).toMatchObject({ figma: 395, dom: 395, status: 'pass' });
    expect(row(rows, 'gap[')?.note ?? '').not.toContain('border-box'); // the ordinary path
  });

  it('col + hugWidth + DOM wider: size.w demotion, but the vertical main-axis gap is NOT forced to border-box', () => {
    const s: LayoutSpec = {
      node: { id: '1:1', name: 'stack', type: 'FRAME' }, rect: { x: 0, y: 0, w: 200, h: 88 },
      axis: 'col', hugWidth: true,
      children: [
        { id: '1:2', name: 'a', type: 'FRAME', rect: { x: 0, y: 0, w: 200, h: 40 } },
        { id: '1:3', name: 'b', type: 'FRAME', rect: { x: 0, y: 48, w: 200, h: 40 } }, // gap 8
      ],
    };
    const d = snap({
      rect: { x: 0, y: 0, w: 400, h: 88 }, clientWidth: 400, clientHeight: 88, scrollHeight: 88,
      paddings: { top: 0, right: 0, bottom: 0, left: 0 },
      children: [
        { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 200, h: 40 }, paddings: { top: 0, right: 0, bottom: 0, left: 0 } },
        { kind: 'element', tag: 'div', rect: { x: 0, y: 48, w: 200, h: 40 }, paddings: { top: 0, right: 0, bottom: 0, left: 0 } },
      ],
    });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(row(rows, 'size.w')?.status).toBe('demoted'); // width = the cross axis for col, but still incomparable
    expect(row(rows, 'gap[')?.note ?? '').not.toContain('border-box'); // the vertical gap is untouched (hugFillMainAxis=false)
  });
});

describe('diffPair — content-edge calibration', () => {
  it('padding-absorbed spacing is caught via content-edge gaps (acceptance case title→radio)', () => {
    // The title wrapper with padding-bottom 48 (broken) / 20 (fixed); the border-box gap = 0 in both.
    // The Figma reference is fixed: the gap 20 is "baked" into the wrapper's padding-bottom (contentEnd = 44−20 = 24, list y44 → gap 20)
    const specRef: LayoutSpec = {
      node: { id: '1:1', name: 'body', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 300 }, axis: 'col',
      children: [
        { id: '1:2', name: 'titleWrap', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 44 },
          paddings: { top: 0, right: 0, bottom: 20, left: 0 } },
        { id: '1:3', name: 'list', type: 'FRAME', rect: { x: 0, y: 44, w: 343, h: 200 } },
      ],
    };
    const domWith = (domPadBottom: number): DomSnapshotOk => ({
      schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 343, h: 300 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 300, scrollHeight: 300,
      scroll: { top: 0, left: 0 }, transformed: false,
      children: [
        { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 24 + domPadBottom },
          paddings: { top: 0, right: 0, bottom: domPadBottom, left: 0 } },
        { kind: 'element', tag: 'ul', rect: { x: 0, y: 24 + domPadBottom, w: 343, h: 200 } },
      ],
    });
    // Broken: DOM padding 48 → visual gap 48 vs reference 20 → fail Δ28
    const broken = diffPair(specRef, domWith(48), { tolerancePx: 1 });
    expect(broken.find((r) => r.prop.startsWith('gap[0]'))).toMatchObject({ figma: 20, dom: 48, delta: 28, status: 'fail' });
    // Fixed: 20 → pass (previously 0↔0 in both phases — a blind spot)
    const fixed = diffPair(specRef, domWith(20), { tolerancePx: 1 });
    expect(fixed.find((r) => r.prop.startsWith('gap[0]'))).toMatchObject({ figma: 20, dom: 20, status: 'pass' });
  });

  it('container own padding does not pollute padding_effective (level-mismatch case drawer)', () => {
    // A DOM wrapper with padding 16/146: content-edge paddings match figma 0/0.
    const s = spec(); // col, children y12..36 and y56..96 in rect y0 h120 — figma padding-top 12
    const d = snap({
      rect: { x: 0, y: 0, w: 343, h: 282 },
      paddings: { top: 16, right: 0, bottom: 146, left: 0 }, clientWidth: 343, clientHeight: 282, scrollHeight: 282,
      children: [
        { kind: 'element', tag: 'h2', rect: { x: 16, y: 28, w: 200, h: 24 } },   // 16(top pad)+12
        { kind: 'element', tag: 'div', rect: { x: 16, y: 72, w: 311, h: 40 } },  // gap 20 = figma
      ],
    });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'padding-top')).toMatchObject({ figma: 12, dom: 12, status: 'pass' });
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))?.status).toBe('pass');
    // size.h: 282 − 16 − 146 = 120 = figma 120 − 0 → pass
    expect(rows.find((r) => r.prop === 'size.h')?.status).toBe('pass');
  });

  it('scrollbar excluded from size.w; scroll container turns size.h into honest skip (acceptance case)', () => {
    // Numbers of acceptance case (c): scrollbar 11px; scrollHeight 900 vs clientHeight 316
    const d = snap({
      rect: { x: 0, y: 0, w: 409, h: 316 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 27.5, bottom: 0, left: 27.5 }, // domW = 409 − 11(scrollbar) − 55 = 343 = figma
      clientWidth: 398, clientHeight: 316, scrollHeight: 900,
    });
    const rows = diffPair(spec(), d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'size.w')).toMatchObject({ figma: 343, dom: 343, status: 'pass' });
    const h = rows.find((r) => r.prop === 'size.h');
    expect(h?.status).toBe('skip');
    expect(h?.note).toContain('scroll container');
  });

  it('stale snapshot (no paddings) → border-box mode + extractor_outdated warn, old numbers intact', () => {
    const stale = snap(); delete (stale as unknown as Record<string, unknown>).paddings;
    delete (stale as unknown as Record<string, unknown>).clientWidth; delete (stale as unknown as Record<string, unknown>).clientHeight;
    delete (stale as unknown as Record<string, unknown>).scrollHeight;
    const rows = diffPair(spec(), stale, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'extractor_outdated')?.status).toBe('warn');
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))).toMatchObject({ figma: 20, dom: 48, status: 'fail' }); // prior numbers

    // Scenario (b): figma paddings are also gated by contentMode — otherwise the asymmetry gives false fails on stale
    const sPadded: LayoutSpec = { ...spec(), autoLayout: { padding: { top: 12, right: 0, bottom: 0, left: 0 } },
      children: [
        { ...spec().children[0], paddings: { top: 0, right: 0, bottom: 20, left: 0 } },
        spec().children[1],
      ] };
    const rows2 = diffPair(sPadded, stale, { tolerancePx: 1 });
    // border-box numbers: figma padding-top = 12 (WITHOUT subtracting autoLayout 12), gap = 20 (WITHOUT subtracting paddings.bottom 20)
    expect(rows2.find((r) => r.prop === 'padding-top')).toMatchObject({ figma: 12, dom: 12, status: 'pass' });
    expect(rows2.find((r) => r.prop.startsWith('gap[0]'))).toMatchObject({ figma: 20, dom: 48 });
  });

  it('text-node children: no offset-cross, no padding-end from trailing text (acceptance case 153.2)', () => {
    const s: LayoutSpec = { node: { id: '1:1', name: 'item', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 48 },
      axis: 'row', children: [
        { id: '1:2', name: 'radio', type: 'INSTANCE', rect: { x: 16, y: 14, w: 20, h: 20 } },
        { id: '1:3', name: 'Content', type: 'FRAME', rect: { x: 52, y: 0, w: 275, h: 48 } },
      ] };
    const d = snap({
      rect: { x: 0, y: 0, w: 343, h: 48 }, paddings: { top: 0, right: 0, bottom: 0, left: 0 },
      clientWidth: 343, clientHeight: 48, scrollHeight: 48,
      children: [
        { kind: 'element', tag: 'input', rect: { x: 16, y: 14, w: 20, h: 20 } },
        { kind: 'text', rect: { x: 52, y: 14.3, w: 121.8, h: 19.5 }, text: 'Дорого' }, // intrinsic, centered
      ],
    });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'offset-cross[1] Content')).toBeUndefined();  // text → not emitted
    expect(rows.find((r) => r.prop === 'padding-right')).toBeUndefined();            // trailing text → not emitted
    expect(rows.find((r) => r.prop === 'offset-cross[0] radio')?.status).toBe('pass');
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))?.status).toBe('pass');       // 52−36=16 both sides
  });

  it('children_truncated → warn note', () => {
    const rows = diffPair({ ...spec(), childrenTruncated: true }, snap(), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'children_truncated')?.status).toBe('warn');
  });

  // previously only the pair's root level was checked (spec.childrenTruncated ||
  // d.childrenTruncated) — truncation on a NESTED node (deeper than the direct figKids/domKids2) was silent.
  // Neither the LayoutSpec root nor the direct figKid ("list") carries childrenTruncated — the flag is only
  // on the grandchild ("deep") — proving REAL recursion, not a one-off second level.
  it('children_truncated (recursive, fig side) — truncation on a NESTED figKid (not the root, not the direct figKids level) → warn', () => {
    const s = spec({ children: [
      spec().children[0],
      { ...spec().children[1], children: [
        { id: '1:9', name: 'deep', type: 'FRAME', rect: { x: 0, y: 0, w: 100, h: 10 }, childrenTruncated: true },
      ] },
    ] });
    const rows = diffPair(s, snap(), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'children_truncated')?.status).toBe('warn');
  });

  it('children_truncated (recursive, dom side) — truncation on a NESTED domKid (symmetric with the fig side) → warn', () => {
    const d = snap({ children: [
      snap().children[0],
      { ...snap().children[1], children: [
        { kind: 'element', tag: 'span', rect: { x: 0, y: 0, w: 100, h: 10 }, childrenTruncated: true },
      ] },
    ] });
    const rows = diffPair(spec(), d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'children_truncated')?.status).toBe('warn');
  });

  it('children_truncated is NOT emitted when there is no truncation anywhere (not at the root, not nested, not on fig, not on dom)', () => {
    const rows = diffPair(spec(), snap(), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'children_truncated')).toBeUndefined();
  });

  it('nested-TEXT typography rows carry the descent note (forwarding textFromNested into typographyRows)', () => {
    const s: LayoutSpec = { node: { id: '1:1', name: 'p', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 48 },
      axis: 'col', children: [
        { id: '1:2', name: 'wrap', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 24 },
          text: { fontSize: 19, fontWeight: 650 }, textFromNested: true },
      ] };
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 48 }, clientWidth: 343, clientHeight: 48, scrollHeight: 48,
      children: [{ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 24 },
        styles: { fontSize: 18, fontWeight: 650 },
        // p.7 migration: the carrier routing compares wrappers no more - the node owns its text here
        children: [{ kind: 'text', rect: { x: 0, y: 0, w: 343, h: 24 }, text: 'wrap text' }] }] });
    const fs = diffPair(s, d, { tolerancePx: 1 }).find((r) => r.prop === 'font-size[wrap]');
    expect(fs?.status).toBe('fail');
    expect(fs?.note).toContain('nested TEXT');
  });

  it('ambiguous auto-descent, no spec-tree children (fallback): honest skip, NOT silence', () => {
    // The old fixture (no children): the descent physically has nothing to work with (children are absent
    // on both sides) — the auto-descent fallback branch must remain an honest skip, not silently
    // swallow typography. The note now describes EXACTLY the fallback (the descent found no children in the slice),
    // not "ambiguity" — the matching itself did not even reach here (figs.items.length === 0).
    const s: LayoutSpec = { node: { id: '1:1', name: 'p', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 48 },
      axis: 'col', children: [
        { id: '1:2', name: 'wrap2', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 24 }, textAmbiguous: true },
      ] };
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 48 }, clientWidth: 343, clientHeight: 48, scrollHeight: 48,
      children: [{ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 24 } }] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'typography[wrap2]')).toMatchObject({ status: 'unchecked' });
    expect(rows.find((r) => r.prop === 'typography[wrap2]')?.note).toContain('the descent did not find');
    expect(rows.find((r) => r.prop === 'typography[wrap2]')?.note).toContain('add');
  });

  it('textBeyondCut → skip row referencing the depth slice (5.6)', () => {
    const s: LayoutSpec = { node: { id: '1:1', name: 'p', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 48 },
      axis: 'col', children: [
        { id: '1:2', name: 'wrap3', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 24 }, textBeyondCut: true },
      ] };
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 48 }, clientWidth: 343, clientHeight: 48, scrollHeight: 48,
      children: [{ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 24 } }] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const t = rows.find((r) => r.prop === 'typography[wrap3]');
    expect(t?.status).toBe('unchecked');
    expect(t?.note).toContain('depth slice');
  });

  it('textUncertain: exactly one TEXT found, but the path was truncated by a cap → note contains uniqueness (5.6)', () => {
    const s: LayoutSpec = { node: { id: '1:1', name: 'p', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 48 },
      axis: 'col', children: [
        { id: '1:2', name: 'wrap4', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 24 },
          text: { fontSize: 19, fontWeight: 650 }, textFromNested: true, textUncertain: true },
      ] };
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 48 }, clientWidth: 343, clientHeight: 48, scrollHeight: 48,
      children: [{ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 24 },
        styles: { fontSize: 19, fontWeight: 650 },
        children: [{ kind: 'text', rect: { x: 0, y: 0, w: 343, h: 24 }, text: 'wrap4 text' }] }] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const fs = rows.find((r) => r.prop === 'font-size[wrap4]');
    expect(fs?.note).toContain('uniqueness');
  });
});

describe('diffPair — cardinality-repair unwrap (5.3)', () => {
  // ── Test 1: title→radio (4v1, acceptance structure) ──
  const unwrapSpec = (): LayoutSpec => ({
    node: { id: '2:1', name: 'list', type: 'FRAME' },
    rect: { x: 0, y: 0, w: 343, h: 400 }, axis: 'col',
    autoLayout: { padding: { top: 16, right: 0, bottom: 0, left: 0 } },
    children: [0, 1, 2, 3].map((i) => ({
      id: `2:${10 + i}`, name: `item${i}`, type: 'FRAME',
      rect: { x: 16, y: 16 + i * 44, w: 311, h: 40 },
    })),
  });
  const unwrapDom = (offset: number): DomSnapshotOk => ({
    schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 343, h: 400 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 16, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 400, scrollHeight: 400,
    scroll: { top: 0, left: 0 }, transformed: false,
    children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 16, w: 343, h: 384 },
        children: [0, 1, 2, 3].map((i) => ({
          kind: 'element', tag: 'li', rect: { x: 16, y: offset + i * 44, w: 311, h: 40 },
        })) },
    ],
  });

  it('fixed: substitutes at the figma positions → padding-top pass, gaps pass, size.w pass (border-box)', () => {
    const rows = diffPair(unwrapSpec(), unwrapDom(16), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'padding-top')).toMatchObject({ figma: 16, dom: 16, status: 'pass' });
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))?.status).toBe('pass');
    expect(rows.find((r) => r.prop.startsWith('gap[1]'))?.status).toBe('pass');
    expect(rows.find((r) => r.prop.startsWith('gap[2]'))?.status).toBe('pass');
    expect(rows.find((r) => r.prop === 'size.w')?.status).toBe('pass');
  });

  it('broken: all 4 substitutes shifted by +28 → padding-top fail Δ28, unwrapped row (figma=dom, dom contains div), gaps still pass', () => {
    const rows = diffPair(unwrapSpec(), unwrapDom(44), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'padding-top')).toMatchObject({ figma: 16, dom: 44, delta: 28, status: 'fail' });
    const unwrapped = rows.find((r) => r.prop === 'unwrapped');
    expect(unwrapped).toMatchObject({ figma: 'dom', status: 'pass' });
    expect(String(unwrapped?.dom)).toContain('div');
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))?.status).toBe('pass');
    expect(rows.find((r) => r.prop.startsWith('gap[1]'))?.status).toBe('pass');
    expect(rows.find((r) => r.prop.startsWith('gap[2]'))?.status).toBe('pass');
  });

  // ── Test 2: Body case (1v2, chrome parity) ──
  it('Body case (1v2): padding-left/gap/size.w pass via unwrapBase, unwrapped row (figma=figma, dom contains Body)', () => {
    const s: LayoutSpec = {
      node: { id: '3:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'row',
      children: [
        { id: '3:2', name: 'Body', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 60 },
          paddings: { top: 0, right: 0, bottom: 0, left: 12 },
          children: [
            { id: '3:3', name: 'Start', type: 'FRAME', rect: { x: 12, y: 0, w: 20, h: 60 } },
            { id: '3:4', name: 'Content', type: 'FRAME', rect: { x: 44, y: 0, w: 200, h: 60 } },
          ] },
      ],
    };
    const d: DomSnapshotOk = {
      schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 343, h: 60 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 12 }, clientWidth: 343, clientHeight: 60, scrollHeight: 60,
      scroll: { top: 0, left: 0 }, transformed: false,
      children: [
        { kind: 'element', tag: 'span', rect: { x: 12, y: 0, w: 20, h: 60 } },
        { kind: 'element', tag: 'div', rect: { x: 44, y: 0, w: 200, h: 60 } },
      ],
    };
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'padding-left')).toMatchObject({ figma: 12, dom: 12, status: 'pass' });
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))?.status).toBe('pass');
    expect(rows.find((r) => r.prop === 'size.w')).toMatchObject({ figma: 343, dom: 343, status: 'pass' });
    const unwrapped = rows.find((r) => r.prop === 'unwrapped');
    expect(unwrapped).toMatchObject({ figma: 'figma', status: 'pass' });
    expect(String(unwrapped?.dom)).toContain('Body');
  });

  // ── Test 3: post-check refusals ──
  it('rejected: children beyond the capture cut (dom wrapper without a children field)', () => {
    const rows = diffPair(spec(), snap({ children: [
      { kind: 'element', tag: 'section', rect: { x: 0, y: 0, w: 343, h: 120 } },
    ] }), { tolerancePx: 1 });
    const sm = row(rows, 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    expect(sm?.note).toContain('rejected: children beyond the capture cut');
  });

  it('rejected: level truncated by a cap (dom wrapper childrenTruncated)', () => {
    const rows = diffPair(spec(), snap({ children: [
      { kind: 'element', tag: 'section', rect: { x: 0, y: 0, w: 343, h: 120 },
        children: [
          { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
          { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 40 } },
        ], childrenTruncated: true },
    ] }), { tolerancePx: 1 });
    const sm = row(rows, 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    expect(sm?.note).toContain('rejected: level truncated by a cap');
  });

  it('rejected: wrapper is empty (dom wrapper children:[])', () => {
    const rows = diffPair(spec(), snap({ children: [
      { kind: 'element', tag: 'section', rect: { x: 0, y: 0, w: 343, h: 120 }, children: [] },
    ] }), { tolerancePx: 1 });
    const sm = row(rows, 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    expect(sm?.note).toContain('rejected: wrapper is empty');
  });

  it('rejected: substitutes overlap along the axis (dom wrapper, both children equal start)', () => {
    const rows = diffPair(spec(), snap({ children: [
      { kind: 'element', tag: 'section', rect: { x: 0, y: 0, w: 343, h: 120 },
        children: [
          { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
          { kind: 'element', tag: 'div', rect: { x: 16, y: 12, w: 311, h: 40 } }, // equal start along the col axis (y)
        ] },
    ] }), { tolerancePx: 1 });
    const sm = row(rows, 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    expect(sm?.note).toContain('rejected: substitutes overlap');
  });

  it('rejected: result > 10 children (unwrap yields 11 substitutes)', () => {
    const wrapKids: SpecChild[] = Array.from({ length: 11 }, (_, i) => ({
      id: `9:${i}`, name: `k${i}`, type: 'FRAME', rect: { x: 0, y: i * 10, w: 100, h: 8 },
    }));
    const s: LayoutSpec = {
      node: { id: '9:1', name: 'root', type: 'FRAME' }, rect: { x: 0, y: 0, w: 100, h: 110 }, axis: 'col',
      children: [{ id: '9:2', name: 'wrap', type: 'FRAME', rect: { x: 0, y: 0, w: 100, h: 110 }, children: wrapKids }],
    };
    const domKids = Array.from({ length: 11 }, (_, i) => ({
      kind: 'element' as const, tag: 'li', rect: { x: 0, y: i * 10, w: 100, h: 8 },
    }));
    const d: DomSnapshotOk = {
      schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 100, h: 110 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 100, clientHeight: 110, scrollHeight: 110,
      scroll: { top: 0, left: 0 }, transformed: false,
      children: domKids,
    };
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = row(rows, 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    expect(sm?.note).toMatch(/rejected.*> 10/);
  });

  it('1v1 does not trigger unwrap: neither an unwrapped row nor structure_mismatch', () => {
    const rows = diffPair(spec(), snap(), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'unwrapped')).toBeUndefined();
    expect(rows.find((r) => r.prop === 'structure_mismatch')).toBeUndefined();
  });

  // ── Test 4: offset-cross box-edges (axis col, cross=x) ──
  it("offset-cross box-edges: child's own padCross no longer subtracted (axis col, cross=x)", () => {
    const s: LayoutSpec = {
      node: { id: '4:1', name: 'buttons', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 120 }, axis: 'col',
      children: [
        { id: '4:2', name: 'btn1', type: 'FRAME', rect: { x: 16, y: 0, w: 100, h: 40 } },
        { id: '4:3', name: 'btn2', type: 'FRAME', rect: { x: 16, y: 44, w: 100, h: 40 } },
      ],
    };
    const d: DomSnapshotOk = {
      schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 343, h: 120 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 120, scrollHeight: 120,
      scroll: { top: 0, left: 0 }, transformed: false,
      children: [
        { kind: 'element', tag: 'button', rect: { x: 16, y: 0, w: 100, h: 40 },
          paddings: { top: 0, right: 0, bottom: 0, left: 28 } }, // the child's padCross — must not be subtracted
        { kind: 'element', tag: 'button', rect: { x: 16, y: 44, w: 100, h: 40 } },
      ],
    };
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'offset-cross[0] btn1')).toMatchObject({ figma: 16, dom: 16, status: 'pass' });
    expect(rows.find((r) => r.prop === 'padding-left')).toBeUndefined(); // main axis col → padding-top/bottom, not -left
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))?.status).toBe('pass');
  });
});

describe('diffPair — unwrapBase scoped to main axis only (cross stays content-edge)', () => {
  // Acceptance-2 replica: fig-root autoLayout.padding.left=16 (a legitimate
  // inline-padding), dom-root paddings.left=0. Each side is self-consistent
  // (the child sits exactly on its side's content-edge) — offset-cross does NOT validate
  // "whether the root padding matches between fig and dom", only the child's position within
  // the content-box. figKids trigger unwrap (1 wrapper → 4 substitutes), dom is already flat (4).
  const unwrapFig = (): LayoutSpec => ({
    node: { id: '5:1', name: 'list', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 200 }, axis: 'col',
    autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 16 } },
    children: [
      { id: '5:2', name: 'wrap', type: 'FRAME', rect: { x: 16, y: 0, w: 311, h: 200 },
        children: [0, 1, 2, 3].map((i) => ({
          id: `5:${10 + i}`, name: `item${i}`, type: 'FRAME',
          rect: { x: 16, y: i * 44, w: 311, h: 40 },
        })) },
    ],
  });
  const flatDom = (): DomSnapshotOk => ({
    schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 343, h: 200 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 200, scrollHeight: 200,
    scroll: { top: 0, left: 0 }, transformed: false,
    children: [0, 1, 2, 3].map((i) => ({
      kind: 'element' as const, tag: 'li', rect: { x: 0, y: i * 44, w: 343, h: 40 },
    })),
  });

  it('repro: unwrapBase no longer suppresses the cross content-edge — all 4 offset-cross pass (was Δ16×4 fail)', () => {
    const rows = diffPair(unwrapFig(), flatDom(), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'unwrapped')).toMatchObject({ figma: 'figma', status: 'pass' });
    const crossRows = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crossRows).toHaveLength(4);
    for (const r of crossRows) {
      expect(r).toMatchObject({ figma: 0, dom: 0, status: 'pass' });
      expect(r.delta).toBeUndefined();
    }
    expect(rows.filter((r) => r.prop.startsWith('offset-cross') && r.status === 'fail')).toHaveLength(0);
  });

  it('invariance: the same geometry as a direct pair (no wrapper, 4v4, unwrap not triggered) → identical offset-cross numbers', () => {
    const directSpec: LayoutSpec = {
      node: { id: '6:1', name: 'list', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 200 }, axis: 'col',
      autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 16 } },
      children: [0, 1, 2, 3].map((i) => ({
        id: `6:${10 + i}`, name: `item${i}`, type: 'FRAME',
        rect: { x: 16, y: i * 44, w: 311, h: 40 },
      })),
    };
    const unwrapRows = diffPair(unwrapFig(), flatDom(), { tolerancePx: 1 });
    const directRows = diffPair(directSpec, flatDom(), { tolerancePx: 1 });
    expect(directRows.find((r) => r.prop === 'unwrapped')).toBeUndefined(); // sanity: a direct pair does not trigger unwrap
    for (let i = 0; i < 4; i += 1) {
      const u = unwrapRows.find((r) => r.prop === `offset-cross[${i}] item${i}`);
      const dRow = directRows.find((r) => r.prop === `offset-cross[${i}] item${i}`);
      expect(u).toBeDefined();
      expect(dRow).toBeDefined();
      expect(u).toMatchObject({ figma: dRow?.figma, dom: dRow?.dom, status: dRow?.status });
    }
  });
});

describe('diffPair — cross base after unwrap = unwrapped wrapper content-edge (per side)', () => {
  // ── PREFIX sub-A: dom-side unwrap, but the wrapper ITSELF carries extra padding (16) on top of
  // a padding-less root — the substitutes "protrude" 16px inward relative to the root base.
  // Cross must be fixed by the wrapper base; the main axis (shift +28, the broken variant) stays
  // an honest fail — it is measured from the root base (unwrapBase), not from the wrapper.
  const prefixFig = (): LayoutSpec => ({
    node: { id: '7:1', name: 'list', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 200 }, axis: 'col',
    autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    children: [0, 1, 2, 3].map((i) => ({
      id: `7:${10 + i}`, name: `item${i}`, type: 'FRAME',
      rect: { x: 0, y: i * 44, w: 343, h: 40 },
    })),
  });
  const prefixDom = (): DomSnapshotOk => ({
    schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 343, h: 200 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 200, scrollHeight: 200,
    scroll: { top: 0, left: 0 }, transformed: false,
    children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 200 },
        paddings: { top: 0, right: 0, bottom: 0, left: 16 },
        children: [0, 1, 2, 3].map((i) => ({
          kind: 'element', tag: 'li', rect: { x: 16, y: 28 + i * 44, w: 327, h: 40 },
        })) },
    ],
  });

  it('repro PREFIX sub-A: offset-cross 0/0 pass via the wrapper base (was fig 0 vs dom 16 fail on the root base)', () => {
    const rows = diffPair(prefixFig(), prefixDom(), { tolerancePx: 1 });
    const crossRows = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crossRows).toHaveLength(4);
    for (const r of crossRows) expect(r).toMatchObject({ figma: 0, dom: 0, status: 'pass' });
  });

  it('repro PREFIX sub-A: the main axis is untouched — padding-top Δ28 fail preserved (root base)', () => {
    const rows = diffPair(prefixFig(), prefixDom(), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'padding-top')).toMatchObject({ figma: 0, dom: 28, delta: 28, status: 'fail' });
  });

  it('repro PREFIX sub-A: the unwrapped row is present (dom-side, wrapper=div)', () => {
    const rows = diffPair(prefixFig(), prefixDom(), { tolerancePx: 1 });
    const unwrapped = rows.find((r) => r.prop === 'unwrapped');
    expect(unwrapped).toMatchObject({ figma: 'dom', status: 'pass' });
    expect(String(unwrapped?.dom)).toContain('div');
  });

  // ── HEAD sub-B (does not regress, dom-side mirror): the root carries the padding itself (16),
  // the wrapper adds 0 of its own — the substitute sits exactly on the wrapper's content-edge, which
  // matches the root's content-edge. Already passed on the root base (PR #47); the wrapper base
  // must give the same result.
  const headFig = (): LayoutSpec => ({
    node: { id: '8:1', name: 'list', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 200 }, axis: 'col',
    autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 16 } },
    children: [0, 1, 2, 3].map((i) => ({
      id: `8:${10 + i}`, name: `item${i}`, type: 'FRAME',
      rect: { x: 16, y: i * 44, w: 327, h: 40 },
    })),
  });
  const headDom = (): DomSnapshotOk => ({
    schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 343, h: 200 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 16 }, clientWidth: 343, clientHeight: 200, scrollHeight: 200,
    scroll: { top: 0, left: 0 }, transformed: false,
    children: [
      { kind: 'element', tag: 'div', rect: { x: 16, y: 0, w: 327, h: 200 },
        children: [0, 1, 2, 3].map((i) => ({
          kind: 'element', tag: 'li', rect: { x: 16, y: i * 44, w: 327, h: 40 },
        })) },
    ],
  });

  it('HEAD sub-B does not regress (dom-side wrapper, own padding 0): offset-cross 0/0 pass', () => {
    const rows = diffPair(headFig(), headDom(), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'unwrapped')).toMatchObject({ figma: 'dom', status: 'pass' });
    const crossRows = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crossRows).toHaveLength(4);
    for (const r of crossRows) expect(r).toMatchObject({ figma: 0, dom: 0, status: 'pass' });
  });

  // ── Invariance on the wrapper padding: the same geometry as PREFIX sub-A as a direct pair
  // (root = wrapper — root paddings.left=16, 4 direct children x=root.x+16, unwrap not
  // triggered) → the offset-cross numbers are identical to the unwrap run.
  it('invariance: the same geometry as PREFIX sub-A as a direct pair (the root carries the padding itself) → offset-cross identical to the unwrap run', () => {
    const directDom = (): DomSnapshotOk => ({
      schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 343, h: 200 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 16 }, clientWidth: 343, clientHeight: 200, scrollHeight: 200,
      scroll: { top: 0, left: 0 }, transformed: false,
      children: [0, 1, 2, 3].map((i) => ({
        kind: 'element' as const, tag: 'li', rect: { x: 16, y: 28 + i * 44, w: 327, h: 40 },
      })),
    });
    const unwrapRows = diffPair(prefixFig(), prefixDom(), { tolerancePx: 1 });
    const directRows = diffPair(prefixFig(), directDom(), { tolerancePx: 1 });
    expect(directRows.find((r) => r.prop === 'unwrapped')).toBeUndefined(); // sanity: 4v4, unwrap not triggered
    for (let i = 0; i < 4; i += 1) {
      const u = unwrapRows.find((r) => r.prop === `offset-cross[${i}] item${i}`);
      const dRow = directRows.find((r) => r.prop === `offset-cross[${i}] item${i}`);
      expect(u).toBeDefined();
      expect(dRow).toBeDefined();
      expect(u).toMatchObject({ figma: dRow?.figma, dom: dRow?.dom, status: dRow?.status });
    }
  });
});

describe('widthNoiseTolerance — a single formula (max 24px floor, otherwise 5%)', () => {
  it('floors at 24px below ref 480', () => {
    expect(widthNoiseTolerance(300)).toBe(24);
    expect(widthNoiseTolerance(420)).toBe(24);
  });

  it('uses 5% above ref 480', () => {
    expect(widthNoiseTolerance(1000)).toBe(50);
  });
});

describe('diffPair — expectedOverlayWidth (fix-overlay width policy)', () => {
  // ── size.w override: fail → info, all three branches (unwrapBase / contentMode / plain) ──
  const unwrapFigSize = (): LayoutSpec => ({
    node: { id: '10:1', name: 'wrapRoot', type: 'FRAME' }, rect: { x: 0, y: 0, w: 420, h: 100 }, axis: 'col',
    children: [0, 1].map((i) => ({
      id: `10:${i}`, name: `item${i}`, type: 'FRAME', rect: { x: 0, y: i * 50, w: 420, h: 50 },
    })),
  });
  const unwrapDomSize = (domW: number): DomSnapshotOk => ({
    schema: 1, status: 'ok', innerWidth: domW, rect: { x: 0, y: 0, w: domW, h: 100 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, transformed: false,
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: domW, clientHeight: 100, scrollHeight: 100,
    children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: domW, h: 100 },
        children: [0, 1].map((i) => ({ kind: 'element', tag: 'li', rect: { x: 0, y: i * 50, w: domW, h: 50 } })) },
    ],
  });

  it('size.w fail → info when expectedOverlayWidth given (unwrapBase branch)', () => {
    const rows = diffPair(unwrapFigSize(), unwrapDomSize(409), { tolerancePx: 1, expectedOverlayWidth: 420 });
    const sw = row(rows, 'size.w');
    expect(sw).toMatchObject({ figma: 420, dom: 409, delta: 11, status: 'demoted' });
    expect(sw?.note).toContain('overlay_width');
  });

  it('size.w fail → info when expectedOverlayWidth given (contentMode branch)', () => {
    const rows = diffPair(spec(), snap({ rect: { x: 0, y: 0, w: 300, h: 120 }, clientWidth: 300 }),
      { tolerancePx: 1, expectedOverlayWidth: 420 });
    const sw = row(rows, 'size.w');
    expect(sw?.status).toBe('demoted');
    expect(sw?.note).toContain('overlay_width');
  });

  it('size.w fail → info when expectedOverlayWidth given (plain branch, no contentMode)', () => {
    const stale = snap({ rect: { x: 0, y: 0, w: 409, h: 120 } });
    delete (stale as unknown as Record<string, unknown>).paddings;
    delete (stale as unknown as Record<string, unknown>).clientWidth;
    delete (stale as unknown as Record<string, unknown>).clientHeight;
    delete (stale as unknown as Record<string, unknown>).scrollHeight;
    const rows = diffPair(spec(), stale, { tolerancePx: 1, expectedOverlayWidth: 420 });
    const sw = row(rows, 'size.w');
    expect(sw).toMatchObject({ figma: 343, dom: 409, status: 'demoted' });
  });

  it('size.w pass stays pass when expectedOverlayWidth given (no override on non-fail)', () => {
    const rows = diffPair(spec(), snap(), { tolerancePx: 1, expectedOverlayWidth: 375 });
    expect(row(rows, 'size.w')).toMatchObject({ status: 'pass' });
    expect(row(rows, 'size.w')?.note).toBeUndefined();
  });

  // ── overlay_width row ──
  it('overlay_width row: info when within tolerance, independent of frameWidth', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 409 }), { tolerancePx: 1, expectedOverlayWidth: 420 });
    expect(row(rows, 'overlay_width')).toMatchObject({ figma: 420, dom: 409, delta: 11, status: 'info' });
  });

  it('overlay_width row: warn when outside tolerance', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 1280 }), { tolerancePx: 1, expectedOverlayWidth: 420 });
    expect(row(rows, 'overlay_width')).toMatchObject({ figma: 420, dom: 1280, status: 'warn' });
  });

  it('overlay_width row absent without expectedOverlayWidth', () => {
    const rows = diffPair(spec(), snap(), { tolerancePx: 1 });
    expect(row(rows, 'overlay_width')).toBeUndefined();
  });

  it('overlay_width row emitted even without frameWidth (no frame_node_id)', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 400 }), { tolerancePx: 1, expectedOverlayWidth: 420 });
    expect(row(rows, 'overlay_width')).toBeDefined();
  });

  // ── viewport gate: reason suppression under expectedOverlayWidth, otherwise the enriched text ──
  it('viewport mismatch suppressed by expectedOverlayWidth — geometry proceeds, no skip', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 420 }), { tolerancePx: 1, frameWidth: 464, expectedOverlayWidth: 420 });
    expect(row(rows, 'geometry')).toBeUndefined();
    expect(row(rows, 'gap[')).toBeDefined();
    expect(row(rows, 'overlay_width')).toMatchObject({ status: 'info' });
  });

  it('viewport mismatch without expectedOverlayWidth → geometry skip with enriched hint', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 420 }), { tolerancePx: 1, frameWidth: 464 });
    const geo = row(rows, 'geometry');
    expect(geo?.status).toBe('unchecked');
    expect(geo?.note).toContain('expected_overlay_width');
    expect(geo?.note).toContain('find_breakpoint_variant');
  });

  // Final adversarial of viewport ergonomics: the overlay guard on the spread of structural fields (diff.ts
  // :266-268) is gated by TWO conditions — `viewportOff && opts.expectedOverlayWidth === undefined`.
  // Weakening to a single `viewportOff` is invisible without a test with overlay suppression PLUS a second
  // (non-viewport) reason for the geometry row: here viewport is suppressed by the overlay (its role fully
  // taken over by the overlay_width row), but the geometry row is still emitted — by scroll≠0. The spread
  // of structural figma/dom fields on this geometry row must stay silent (otherwise verification.ts
  // (c) batch dominance would count it in vpRows → a false dominant "WINDOW WIDTH" on a REAL
  // scroll problem hidden under the overlay).
  it('overlay guard on the spread: viewport suppressed by expectedOverlayWidth, geometry emitted by scroll — WITHOUT figma/dom fields (otherwise false vpRows)', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 1429, scroll: { top: 40, left: 0 } }),
      { tolerancePx: 1, frameWidth: 1920, expectedOverlayWidth: 420 });
    const geo = row(rows, 'geometry');
    expect(geo).toBeDefined();
    expect(geo?.status).toBe('unchecked');
    expect(geo?.note).toContain('scroll');
    expect(geo?.note).not.toContain('viewport'); // the viewport-reason role is fully taken over by overlay_width
    expect(geo?.figma).toBeUndefined();
    expect(geo?.dom).toBeUndefined();
  });

  // Review fix (reviewer repro): the suppressed viewport reason made the reasons.length===0 branch
  // reachable with off-tolerance numbers → the viewport row hardcoded pass ({figma:464,dom:420,
  // status:'pass'} in JSON next to a correct preflight warn — a second contradicting signal about
  // one diagnosis, inflating summary.pass). Under expectedOverlayWidth the viewport row is NOT
  // emitted at all — its role is fully taken over by overlay_width.
  it('viewport row NOT emitted at all under expectedOverlayWidth (overlay_width supersedes it)', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 420 }), { tolerancePx: 1, frameWidth: 464, expectedOverlayWidth: 420 });
    expect(row(rows, 'viewport')).toBeUndefined();
    expect(row(rows, 'overlay_width')).toBeDefined();
  });

  it('positive control: viewport pass row still emitted WITHOUT expectedOverlayWidth when widths match', () => {
    const rows = diffPair(spec(), snap({ innerWidth: 420 }), { tolerancePx: 1, frameWidth: 420 });
    expect(row(rows, 'viewport')).toMatchObject({ figma: 420, dom: 420, status: 'pass' });
  });
});

describe('diffPair — typography auto-descent: content-first matching of TEXT descendants', () => {
  // root: 1 auto-layout FRAME child ("card") without direct text — matching everywhere goes through its
  // nested TEXT descendants (SpecChild.textSnippet/text ↔ DomChild kind:'text').
  // 1v1 cardinality (card↔div) — unwrap not triggered, a clean run of the new ladder.
  const mkSpec = (cardChildren: SpecChild[], cardOver: Partial<SpecChild> = {}): LayoutSpec => ({
    node: { id: '1:1', name: 'p', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 64 }, axis: 'col',
    children: [
      { id: '1:2', name: 'card', type: 'FRAME', rect: { x: 0, y: 0, w: 343, h: 64 }, children: cardChildren, ...cardOver },
    ],
  });
  const mkDom = (divChildren: DomChild[]): DomSnapshotOk => snap({
    rect: { x: 0, y: 0, w: 343, h: 64 }, clientWidth: 343, clientHeight: 64, scrollHeight: 64,
    children: [{ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 343, h: 64 }, children: divChildren }],
  });
  // Rows produced by the typography branch (skip/warn/font-* of the auto-descent) — excludes
  // offset-cross[…]/padding-*/unwrapped, which may also contain the name 'card'.
  const typographyRelated = (rows: ReturnType<typeof diffPair>) =>
    rows.filter((r) => r.prop.startsWith('typography') || r.prop.includes('→'));

  it('case 1: content bijection cross-links REORDERED TEXT pairs correctly (proved by differing fontSize)', () => {
    const s = mkSpec([
      { id: '1:3', name: 'title', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 24 },
        textSnippet: 'Заголовок', text: { fontSize: 19, fontWeight: 650 } },
      { id: '1:4', name: 'subtitle', type: 'TEXT', rect: { x: 0, y: 28, w: 200, h: 20 },
        textSnippet: 'Подпись карточки', text: { fontSize: 13, fontWeight: 400 } },
    ]);
    const d = mkDom([
      // deliberately REORDERED relative to the fig order
      { kind: 'text', rect: { x: 0, y: 28, w: 200, h: 20 }, text: 'Подпись карточки',
        styles: { fontSize: 13, fontWeight: 400 } },
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 24 }, text: 'Заголовок',
        styles: { fontSize: 19, fontWeight: 650 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const titleRow = rows.find((r) => r.prop === 'font-size[card→"Заголовок"]');
    const subRow = rows.find((r) => r.prop === 'font-size[card→"Подпись карточки"]');
    // The CORRECT cross-link is proven by the differing fontSize: title(19)↔title(19), subtitle(13)↔subtitle(13)
    // — if the link were positional/scrambled, we would get 19 vs 13 fail.
    expect(titleRow).toMatchObject({ figma: 19, dom: 19, status: 'pass' });
    expect(subRow).toMatchObject({ figma: 13, dom: 13, status: 'pass' });
    expect(titleRow?.note).toContain('by content');
    expect(subRow?.note).toContain('by content');
  });

  it('case 2: no content overlap, equal counts → matched by order (positional, not content)', () => {
    const s = mkSpec([
      { id: '1:3', name: 'lineA', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 },
        textSnippet: 'Alpha text', text: { fontSize: 12 } },
      { id: '1:4', name: 'lineB', type: 'TEXT', rect: { x: 0, y: 24, w: 200, h: 20 },
        textSnippet: 'Beta text', text: { fontSize: 16 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'Gamma text', styles: { fontSize: 20 } },
      { kind: 'text', rect: { x: 0, y: 24, w: 200, h: 20 }, text: 'Delta text', styles: { fontSize: 16 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // 0↔0: 12 vs 20 → an honest fail Δ8 (the content never matched — proving the positional link)
    expect(rows.find((r) => r.prop === 'font-size[card→"Alpha text"]')).toMatchObject({ figma: 12, dom: 20, delta: 8, status: 'fail' });
    expect(rows.find((r) => r.prop === 'font-size[card→"Beta text"]')).toMatchObject({ figma: 16, dom: 16, status: 'pass' });
    expect(rows.find((r) => r.prop === 'font-size[card→"Alpha text"]')?.note).toContain('by order');
    expect(rows.find((r) => r.prop === 'font-size[card→"Beta text"]')?.note).toContain('by order');
  });

  it('case 3: figs 3 / doms 2, 1 content match → 1 link + warn typography_descent with remainders [2] vs [1]', () => {
    const s = mkSpec([
      { id: '1:3', name: 'a', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 },
        textSnippet: 'MatchMe', text: { fontSize: 14 } },
      { id: '1:4', name: 'b', type: 'TEXT', rect: { x: 0, y: 24, w: 200, h: 20 },
        textSnippet: 'OnlyFigB', text: { fontSize: 10 } },
      { id: '1:5', name: 'c2', type: 'TEXT', rect: { x: 0, y: 48, w: 200, h: 20 },
        textSnippet: 'OnlyFigC', text: { fontSize: 10 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'MatchMe', styles: { fontSize: 14 } },
      { kind: 'text', rect: { x: 0, y: 24, w: 200, h: 20 }, text: 'OnlyDomY', styles: { fontSize: 10 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'font-size[card→"MatchMe"]')).toMatchObject({ figma: 14, dom: 14, status: 'pass' });
    const warn = rows.find((r) => r.prop === 'typography_descent[card]');
    expect(warn?.status).toBe('warn');
    expect(String(warn?.figma)).toContain('OnlyFigB');
    expect(String(warn?.figma)).toContain('OnlyFigC');
    expect(String(warn?.dom)).toContain('OnlyDomY');
    expect(String(warn?.dom)).not.toContain('MatchMe');
    // Anti-collision: the warn note must not contain the link substrings ('by content'/'by order') —
    // a consumer's naive substring filtering must not confuse a warn with a link.
    expect(warn?.note).not.toContain('by content');
    expect(warn?.note).not.toContain('by order');
  });

  it('case 4: duplicate snippets on both sides ("8 ₽"×2) → phase 1 skips them, phase 2 matches by order', () => {
    const s = mkSpec([
      { id: '1:3', name: 'p1', type: 'TEXT', rect: { x: 0, y: 0, w: 100, h: 20 },
        textSnippet: '8 ₽', text: { fontSize: 10 } },
      { id: '1:4', name: 'p2', type: 'TEXT', rect: { x: 0, y: 24, w: 100, h: 20 },
        textSnippet: '8 ₽', text: { fontSize: 14 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 100, h: 20 }, text: '8 ₽', styles: { fontSize: 99 } }, // a deliberate mismatch at position 0
      { kind: 'text', rect: { x: 0, y: 24, w: 100, h: 20 }, text: '8 ₽', styles: { fontSize: 14 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const fsRows = rows.filter((r) => r.prop === 'font-size[card→"8 ₽"]');
    expect(fsRows).toHaveLength(2);
    // A positional link (NOT by content — duplicates are excluded by phase 1): 0↔0 gives an honest fail,
    // proving the pair was not "guessed" by matching text.
    expect(fsRows[0]).toMatchObject({ figma: 10, dom: 99, delta: 89, status: 'fail' });
    expect(fsRows[1]).toMatchObject({ figma: 14, dom: 14, status: 'pass' });
    expect(fsRows[0].note).toContain('by order');
    expect(fsRows[1].note).toContain('by order');
  });

  it('case 5: both collections empty → no typography rows at all (as today)', () => {
    const s = mkSpec([]);
    const d = mkDom([]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(typographyRelated(rows)).toHaveLength(0);
  });

  it('case 6: direct c.text child is untouched (existing branch, byte-for-byte)', () => {
    const s: LayoutSpec = { node: { id: '1:1', name: 'p', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 24 },
      axis: 'col', children: [
        { id: '1:2', name: 'title', type: 'TEXT', rect: { x: 0, y: 0, w: 343, h: 24 },
          text: { fontSize: 19, fontWeight: 650 } },
      ] };
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 24 }, clientWidth: 343, clientHeight: 24, scrollHeight: 24,
      children: [{ kind: 'element', tag: 'h2', rect: { x: 0, y: 0, w: 343, h: 24 },
        styles: { fontSize: 19, fontWeight: 650 },
        children: [{ kind: 'text', rect: { x: 0, y: 0, w: 343, h: 24 }, text: 'title' }] }] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'font-size[title]')).toMatchObject({ figma: 19, dom: 19, status: 'pass' });
    expect(rows.some((r) => r.prop.startsWith('typography_descent'))).toBe(false);
  });

  it('case 7a: the old textAmbiguous fixture without children → fallback skip, NOT silence (see also the block above)', () => {
    // Duplicates the invariant from "ambiguous auto-descent, no spec-tree children" — kept here
    // next to the rest of the auto-descent ladder for completeness of scenario coverage in one file/section.
    const s = mkSpec([], { textAmbiguous: true });
    const d = mkDom([]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const t = rows.find((r) => r.prop === 'typography[card]');
    expect(t?.status).toBe('unchecked');
    expect(t?.note).toContain('the descent did not find');
  });

  it('case 7b: textAmbiguous WITH matched TEXT descendants (new fixture) → the descent matches, the fallback does NOT fire', () => {
    const s = mkSpec([
      { id: '1:3', name: 'only', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 },
        textSnippet: 'Единственный текст', text: { fontSize: 15 } },
    ], { textAmbiguous: true });
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'Единственный текст', styles: { fontSize: 15 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'typography[card]')).toBeUndefined(); // the fallback did NOT fire
    expect(rows.find((r) => r.prop === 'font-size[card→"Единственный текст"]')).toMatchObject({ figma: 15, dom: 15, status: 'pass' });
  });

  it('case 8: truncated fig subtree (childrenTruncated) without content overlap → NO order links, warn "truncated by the slice"', () => {
    const s = mkSpec([
      { id: '1:3', name: 'inner', type: 'FRAME', rect: { x: 0, y: 0, w: 200, h: 20 }, childrenTruncated: true,
        children: [
          { id: '1:4', name: 'deep', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 },
            textSnippet: 'FigOnly', text: { fontSize: 10 } },
        ] },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'DomOnly', styles: { fontSize: 10 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // The remainders are equal in length (1=1) — WITHOUT truncated this would give an order link; WITH truncated there is none.
    expect(rows.some((r) => r.prop.startsWith('font-size[card'))).toBe(false);
    const warn = rows.find((r) => r.prop === 'typography_descent[card]');
    expect(warn?.status).toBe('warn');
    expect(warn?.note).toContain('truncated by the projection slice');
    expect(warn?.note).not.toContain('by order'); // anti-collision with the order-link note
  });

  it('case 8b (silent hole): ALL visible TEXT matched by content, but the capture is truncated (childrenTruncated deeper) → unchecked typography_descent, NOT silence', () => {
    // Difference from case 8: there the content did NOT overlap (figRest.length>0 → there was already a warn).
    // Here figRest.length===0 (full match) — before the fix there was no row at all.
    const s = mkSpec([
      { id: '1:3', name: 'inner', type: 'FRAME', rect: { x: 0, y: 0, w: 200, h: 20 }, childrenTruncated: true,
        children: [
          { id: '1:4', name: 'deep', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 },
            textSnippet: 'MatchedText', text: { fontSize: 10 } },
        ] },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'MatchedText', styles: { fontSize: 10 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // The visible TEXT matched by content and passed (proving this is NOT a case-8 scenario).
    expect(rows.find((r) => r.prop === 'font-size[card→"MatchedText"]')).toMatchObject({ figma: 10, dom: 10, status: 'pass' });
    // The silent hole is gone: truncation is signaled by an explicit skip, even when everything visible matched.
    const skip = rows.find((r) => r.prop === 'typography_descent[card]');
    expect(skip?.status).toBe('unchecked');
    expect(skip?.note).toContain('deeper');
  });

  it('case 8d (compare-lock): DOM-side childrenTruncated:true WITHOUT children in the pair subtree (the new honest extractor form at the depth limit) → typography_descent unchecked, no crash', () => {
    // Mirror of case 8b, but the truncated node is now on the DOM side (the new honest form: depthLeft===0
    // + hasFlowContent → childrenTruncated:true WITHOUT .children — the extractor no longer pretends to be
    // a leaf). The fig side is clean (not truncated) — the only new driver here is collectDomTexts.
    const s = mkSpec([
      { id: '1:3', name: 'inner', type: 'FRAME', rect: { x: 0, y: 0, w: 200, h: 20 },
        children: [
          { id: '1:4', name: 'deep', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 },
            textSnippet: 'MatchedText', text: { fontSize: 10 } },
        ] },
    ]);
    const d = mkDom([
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 200, h: 20 },
        children: [
          { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'MatchedText', styles: { fontSize: 10 } },
          // Honest-truncation form: depth-limit hit, real content was below, no .children carried — not a fake leaf.
          { kind: 'element', tag: 'span', rect: { x: 0, y: 0, w: 50, h: 10 }, childrenTruncated: true },
        ] },
    ]);
    expect(() => diffPair(s, d, { tolerancePx: 1 })).not.toThrow();
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // The visible TEXT still matched by content (proving this is not a case-8 scenario).
    expect(rows.find((r) => r.prop === 'font-size[card→"MatchedText"]')).toMatchObject({ figma: 10, dom: 10, status: 'pass' });
    // Truncation on the DOM side is signaled by an honest skip — no silence, no crash.
    const skip = rows.find((r) => r.prop === 'typography_descent[card]');
    expect(skip?.status).toBe('unchecked');
    expect(skip?.note).toContain('deeper');
  });

  it('case 8c: NOT truncated and everything matched → still silent (no typography_descent row)', () => {
    // Control case (invariant): a clean successful descent without truncated must not
    // acquire a new row — the else-if is exclusive with if(figRest.length) and requires anyTruncated.
    const s = mkSpec([
      { id: '1:3', name: 'only', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 },
        textSnippet: 'CleanMatch', text: { fontSize: 12 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'CleanMatch', styles: { fontSize: 12 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'font-size[card→"CleanMatch"]')).toMatchObject({ figma: 12, dom: 12, status: 'pass' });
    expect(rows.find((r) => r.prop === 'typography_descent[card]')).toBeUndefined();
  });

  it('case 9a: asymmetry — figs=0, doms=[random text] → NEITHER rows NOR warn (a DOM badge is not a signal)', () => {
    const s = mkSpec([]); // no TEXT descendants on the fig side
    const d = mkDom([{ kind: 'text', rect: { x: 0, y: 0, w: 100, h: 20 }, text: 'RandomBadge', styles: { fontSize: 11 } }]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(typographyRelated(rows)).toHaveLength(0);
  });

  it('case 9b: asymmetry — figs=[TitleText], doms=0 → warn "unmatched in DOM" (a disappearance is a real signal)', () => {
    const s = mkSpec([
      { id: '1:3', name: 'title2', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 20 },
        textSnippet: 'TitleText', text: { fontSize: 18 } },
    ]);
    const d = mkDom([]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const warn = rows.find((r) => r.prop === 'typography_descent[card]');
    expect(warn?.status).toBe('warn');
    expect(String(warn?.figma)).toContain('TitleText');
    expect(String(warn?.dom)).toBe('[]');
  });

  // ── fuzzy-SNIPPET_CAP path of sameContent (review fixes): a raw snippet exactly SNIPPET_CAP chars → min-len
  // prefix comparison of the normalized strings instead of exact equality ──
  it('case f40-i: both raw snippets exactly SNIPPET_CAP chars, a common effective prefix (DOM cuts without collapse) → content link', () => {
    // fig: the projector collapses BEFORE the cut → already-normalized SNIPPET_CAP chars.
    // dom: the extractor cuts raw SNIPPET_CAP chars WITHOUT collapse — a double space inside →
    // after normSnippet SNIPPET_CAP-1 chars remain. Exact equality is fundamentally impossible;
    // the min-len prefix comparison (raw=SNIPPET_CAP) must link by content, not by order.
    const figSnippet = `${'A'.repeat(20)} ${'B'.repeat(99)}`;   // SNIPPET_CAP chars, collapsed
    const domRaw = `${'A'.repeat(20)}  ${'B'.repeat(98)}`;      // SNIPPET_CAP raw → SNIPPET_CAP-1 after collapse
    expect(figSnippet.length).toBe(SNIPPET_CAP); // anti-drift
    expect(domRaw.length).toBe(SNIPPET_CAP); // anti-drift (raw, before collapse)
    const s = mkSpec([
      { id: '1:3', name: 'para', type: 'TEXT', rect: { x: 0, y: 0, w: 300, h: 40 },
        textSnippet: figSnippet, text: { fontSize: 14 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 300, h: 40 }, text: domRaw, styles: { fontSize: 14 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const fs = rows.find((r) => r.prop === `font-size[card→"${'A'.repeat(20)}"]`);
    expect(fs).toMatchObject({ figma: 14, dom: 14, status: 'pass' });
    expect(fs?.note).toContain('by content'); // specifically phase 1, NOT the order fallback
    expect(rows.find((r) => r.prop === 'typography_descent[card]')).toBeUndefined();
  });

  it('case f40-guard: an empty/ultra-short dom text (inline-dom) does NOT vacuously match a SNIPPET_CAP-char fig paragraph', () => {
    // The canonical extractor does not emit empty texts; inline-dom can. Without the minLen<3 guard
    // an empty/single-char string would give a startsWith match with ANY SNIPPET_CAP-char snippet.
    const dTextSnippet = 'D'.repeat(SNIPPET_CAP);
    expect(dTextSnippet.length).toBe(SNIPPET_CAP); // anti-drift (otherwise f40-guard is vacuous — not a 40-row)
    const s = mkSpec([
      { id: '1:3', name: 'para', type: 'TEXT', rect: { x: 0, y: 0, w: 300, h: 40 },
        textSnippet: dTextSnippet, text: { fontSize: 14 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 300, h: 40 }, text: 'D', styles: { fontSize: 99 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // No content link; remainders 1v1 → phase 2 by order (an honest note), NOT a false "by content"
    const fs = rows.find((r) => r.prop.startsWith('font-size[card→'));
    expect(fs?.note).not.toContain('by content');
  });

  it('case f40-iii: two fig texts with one SNIPPET_CAP prefix → mutual uniqueness cuts off phase 1; remainders 2v1 → warn, no phase 2', () => {
    const full = 'C'.repeat(SNIPPET_CAP);
    expect(full.length).toBe(SNIPPET_CAP); // anti-drift
    const s = mkSpec([
      { id: '1:3', name: 'p1', type: 'TEXT', rect: { x: 0, y: 0, w: 300, h: 20 },
        textSnippet: full, text: { fontSize: 12 } },
      { id: '1:4', name: 'p2', type: 'TEXT', rect: { x: 0, y: 24, w: 300, h: 20 },
        textSnippet: 'C'.repeat(28), text: { fontSize: 16 } }, // shorter, but the same effective prefix
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 300, h: 20 }, text: full, styles: { fontSize: 12 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // Both fig texts match the single dom → figCandidates=2 → mutual-uniqueness reject;
    // remainders 2v1 unequal → no phase 2: not a single link, only an honest warn.
    expect(rows.some((r) => r.prop.startsWith('font-size[card'))).toBe(false);
    const warn = rows.find((r) => r.prop === 'typography_descent[card]');
    expect(warn?.status).toBe('warn');
    expect(String(warn?.figma)).toContain(`"${'C'.repeat(20)}"`);
    expect(String(warn?.dom)).toContain(`"${'C'.repeat(20)}"`);
  });

  it('case f40-iv: dom carries BOTH a short prefix AND the full SNIPPET_CAP sibling → order batch; the wrong-node gate is selective (substring confident, disjoint → warn)', () => {
    const full = 'D'.repeat(SNIPPET_CAP);
    expect(full.length).toBe(SNIPPET_CAP); // anti-drift
    const s = mkSpec([
      { id: '1:3', name: 'p1', type: 'TEXT', rect: { x: 0, y: 0, w: 300, h: 20 },
        textSnippet: full, text: { fontSize: 12 } },
      { id: '1:4', name: 'p2', type: 'TEXT', rect: { x: 0, y: 24, w: 300, h: 20 },
        textSnippet: 'Другой текст', text: { fontSize: 16 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 300, h: 20 }, text: 'D'.repeat(12), styles: { fontSize: 12 } }, // prefix of full
      { kind: 'text', rect: { x: 0, y: 24, w: 300, h: 20 }, text: full, styles: { fontSize: 16 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // full matches BOTH dom texts → domCandidates=2 → reject phase 1 for both fig; remainders 2v2 without
    // truncation → by order: p1↔short('D'×12), p2↔full('D'×SNIPPET_CAP).
    // p1: 'D'×SNIPPET_CAP vs 'D'×12 — SUBSTRING (same node, a cut) → the gate stays silent → confidently 12↔12 pass.
    const fsFull = rows.find((r) => r.prop === `font-size[card→"${'D'.repeat(20)}"]`);
    expect(fsFull).toMatchObject({ figma: 12, dom: 12, status: 'pass' });
    expect(fsFull?.note).toContain('by order');
    // p2: 'Другой текст' vs 'D'×SNIPPET_CAP — DISJOINT content → the wrong-node gate: NOT a confident row
    // (a matching size 16 would be false-green — the node is wrong), but an honest warn with both snippets.
    expect(rows.find((r) => r.prop === 'font-size[card→"Другой текст"]')).toBeUndefined();
    const divergeWarn = rows.find((r) => r.prop === 'typography_descent[card→"Другой текст"]');
    expect(divergeWarn?.status).toBe('warn');
    expect(String(divergeWarn?.figma)).toContain('Другой текст');
    expect(String(divergeWarn?.dom)).toContain('D'.repeat(20)); // linked specifically to the full 'D'×SNIPPET_CAP
    expect(divergeWarn?.note).toContain('wrong node');
    expect(divergeWarn?.note).not.toContain('by content');
    expect(divergeWarn?.note).not.toContain('by order');
    expect(rows.find((r) => r.prop === 'typography_descent[card]')).toBeUndefined(); // everything matched, no bare remainder
  });

  // ── Sub-cap precision: sameContent must require an EXACT match below SNIPPET_CAP — the minLen
  // prefix mode is justified ONLY at the cap itself (raw EXACTLY SNIPPET_CAP — a cut without a flag).
  // Two different FULL texts (both < SNIPPET_CAP) with a common 44-char prefix, diverging
  // further, must not link "by content" — otherwise any two different paragraphs with the same
  // beginning would be falsely confused long before the cap.
  it('case sub-cap: two different FULL texts (< SNIPPET_CAP) with a common 44-char prefix do NOT link by content (exact comparison, not prefix)', () => {
    const commonPrefix = 'P'.repeat(44); // common effective prefix — exactly 44 chars
    const figSnippet = `${commonPrefix}Z`; // 45 chars, a FULL text (not truncated by a cap)
    const domSnippet = commonPrefix; // 44 chars, a FULL text — diverges from fig at the 45th char
    expect(figSnippet.length).toBeLessThan(SNIPPET_CAP); // anti-drift
    expect(domSnippet.length).toBeLessThan(SNIPPET_CAP); // anti-drift
    const s = mkSpec([
      { id: '1:3', name: 'para', type: 'TEXT', rect: { x: 0, y: 0, w: 300, h: 20 },
        textSnippet: figSnippet, text: { fontSize: 14 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 300, h: 20 }, text: domSnippet, styles: { fontSize: 14 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // The single remaining pair still links — but via phase 2 (order fallback, 1v1 without
    // truncation), NOT via phase 1 (content bijection): an unconditional minLen prefix would give a false
    // "by content" link on the common 44 chars.
    const fs = rows.find((r) => r.prop.startsWith('font-size[card→'));
    expect(fs?.note).not.toContain('by content');
  });

  // ── Wrong-node gate on the order path (B, live bug on a settings screen) ──
  it('order-zip with DISJOINT content (input value vs label) → warn, NOT confident font-size/color from the wrong node', () => {
    // Metrics from a live repro, strings synthetic — the sanitisation wave replaced the product copy,
    // so «Синяя Груша» is invented and only the numbers are the repro's: Figma «Setting description»
    // «Временное» 13px/#808093 vs DOM input value 16px/#242429. Bijection misses (content differs), 1v1 order.
    // Cyrillic is disjoint → the gate fires (Latin-only tokens() would give [] and stay silent — this
    // test locks the unicode tokenizer contentTokens).
    const s = mkSpec([
      { id: '1:3', name: 'desc', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 17 },
        textSnippet: 'Временное', text: { fontSize: 13, colorHex: '#808093' } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'Синяя Груша',
        styles: { fontSize: 16, color: '#242429' } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    // NO confident metrics from the wrong node
    expect(rows.find((r) => r.prop === 'font-size[card→"Временное"]')).toBeUndefined();
    expect(rows.find((r) => r.prop === 'color[card→"Временное"]')).toBeUndefined();
    const warn = rows.find((r) => r.prop === 'typography_descent[card→"Временное"]');
    expect(warn?.status).toBe('warn');
    expect(String(warn?.figma)).toContain('Временное');
    expect(String(warn?.dom)).toContain('Синяя');
    expect(warn?.note).toContain('wrong node');
    expect(warn?.note).not.toContain('by content');
    expect(warn?.note).not.toContain('by order');
  });

  it('order-zip disjoint, but size+color MATCHED by chance → warn, not a silent pass (the false-green cousin)', () => {
    // The same wrong node, but size/color matched by chance — before the fix this was a silent ✅ (masking
    // an unchecked node). The content gate catches this too.
    const s = mkSpec([
      { id: '1:3', name: 'desc', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 17 },
        textSnippet: 'Временное', text: { fontSize: 13, colorHex: '#808093' } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 17 }, text: 'Синяя Груша',
        styles: { fontSize: 13, color: '#808093' } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'font-size[card→"Временное"]')).toBeUndefined();
    expect(rows.find((r) => r.prop === 'typography_descent[card→"Временное"]')?.status).toBe('warn');
  });

  it('order-zip with SUBSTRING content (same node, a real wrong size) → stays a confident fail, NOT masked into a warn', () => {
    // «Заголовок» ⊂ «Заголовок раздела» → substring → the gate stays silent → a real size defect (19 vs 15)
    // stays an honest fail. Proves: never-false-green cuts the other side too — we do not over-warn.
    const s = mkSpec([
      { id: '1:3', name: 'h', type: 'TEXT', rect: { x: 0, y: 0, w: 200, h: 24 },
        textSnippet: 'Заголовок', text: { fontSize: 19 } },
    ]);
    const d = mkDom([
      { kind: 'text', rect: { x: 0, y: 0, w: 200, h: 20 }, text: 'Заголовок раздела',
        styles: { fontSize: 15 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'font-size[card→"Заголовок"]')).toMatchObject({ figma: 19, dom: 15, status: 'fail' });
    expect(rows.find((r) => r.prop === 'typography_descent[card→"Заголовок"]')).toBeUndefined();
  });
});

describe('diffPair — TEXT-info demote (D) + child-padding provenance note (E)', () => {
  // ── D-size: root — a hug-width TEXT (textNode, WITHOUT textFixedWidth) ──
  const textRootSpec = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({
    node: { id: '9:1', name: 'label', type: 'TEXT' }, rect: { x: 0, y: 0, w: 288, h: 24 },
    textNode: true, children: [],
    ...over,
  });
  const textRootDomPlain = (w: number, h = 24): DomSnapshotOk => {
    const s = snap({ rect: { x: 0, y: 0, w, h } });
    delete (s as unknown as Record<string, unknown>).paddings;
    delete (s as unknown as Record<string, unknown>).clientWidth;
    delete (s as unknown as Record<string, unknown>).clientHeight;
    delete (s as unknown as Record<string, unknown>).scrollHeight;
    return s;
  };
  const textRootDomContent = (w: number, h = 24): DomSnapshotOk => snap({
    rect: { x: 0, y: 0, w, h }, clientWidth: w, clientHeight: h, scrollHeight: h,
    paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  it('hug-TEXT root: size.w 288 vs 224.6 → info (plain branch, no contentMode)', () => {
    const rows = diffPair(textRootSpec(), textRootDomPlain(224.6), { tolerancePx: 1 });
    const sw = row(rows, 'size.w');
    expect(sw).toMatchObject({ figma: 288, dom: 224.6, status: 'demoted' });
    expect(sw?.note).toContain('hug-width');
  });

  it('hug-TEXT root: size.w 288 vs 224.6 → info (contentMode branch)', () => {
    const rows = diffPair(textRootSpec(), textRootDomContent(224.6), { tolerancePx: 1 });
    const sw = row(rows, 'size.w');
    expect(sw).toMatchObject({ figma: 288, dom: 224.6, status: 'demoted' });
    expect(sw?.note).toContain('hug-width');
  });

  it('fixed-width TEXT root (textFixedWidth): size.w STAYS fail — designer-set width, a real defect', () => {
    const rows = diffPair(textRootSpec({ textFixedWidth: true }), textRootDomContent(224.6), { tolerancePx: 1 });
    expect(row(rows, 'size.w')).toMatchObject({ figma: 288, dom: 224.6, status: 'fail' });
  });

  it('hug-TEXT root: size.h mismatch stays fail (the D-size demotion is copied only to width)', () => {
    const rows = diffPair(textRootSpec(), textRootDomContent(288, 40), { tolerancePx: 1 });
    expect(row(rows, 'size.h')).toMatchObject({ status: 'fail' });
  });

  // ── D-padding-end: fig-last-TEXT hug ──
  const rowFixSpec = (figLastOver: Partial<SpecChild> = {}): LayoutSpec => ({
    node: { id: '2:1', name: 'row', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 48 }, axis: 'row',
    children: [
      { id: '2:2', name: 'icon', type: 'INSTANCE', rect: { x: 16, y: 14, w: 20, h: 20 } },
      { id: '2:3', name: 'label', type: 'TEXT', rect: { x: 52, y: 12, w: 291, h: 24 }, ...figLastOver },
    ],
  });
  const rowFixDom = (labelW: number): DomSnapshotOk => snap({
    rect: { x: 0, y: 0, w: 343, h: 48 }, paddings: { top: 0, right: 0, bottom: 0, left: 0 },
    clientWidth: 343, clientHeight: 48, scrollHeight: 48,
    children: [
      { kind: 'element', tag: 'i', rect: { x: 16, y: 14, w: 20, h: 20 } },
      { kind: 'element', tag: 'span', rect: { x: 52, y: 12, w: labelW, h: 24 } },
    ],
  });

  it('fig-last-TEXT hug + dom-last-element: padding-end 0 vs 79.4 → info', () => {
    const rows = diffPair(rowFixSpec(), rowFixDom(211.6), { tolerancePx: 1 });
    const pe = row(rows, 'padding-right');
    expect(pe).toMatchObject({ figma: 0, dom: 79.4, status: 'demoted' });
    expect(pe?.note).toContain('hug-width');
  });

  it('fig-last-TEXT fixed-width: padding-end STAYS fail', () => {
    const rows = diffPair(rowFixSpec({ textFixedWidth: true }), rowFixDom(211.6), { tolerancePx: 1 });
    expect(row(rows, 'padding-right')).toMatchObject({ status: 'fail' });
  });

  it('ordinary pair (fig-last not TEXT): padding-end fail as before', () => {
    const rows = diffPair(rowFixSpec({ type: 'FRAME' }), rowFixDom(211.6), { tolerancePx: 1 });
    expect(row(rows, 'padding-right')).toMatchObject({ status: 'fail' });
  });

  // ── E: provenance of a participating child's padding ──
  it("padding-start: fig child pad 6 → note 'includes the child's padding 6px'", () => {
    const s: LayoutSpec = { ...spec(), children: [
      { ...spec().children[0], paddings: { top: 6, right: 0, bottom: 0, left: 0 } },
      spec().children[1],
    ] };
    const p = row(diffPair(s, snap(), { tolerancePx: 1 }), 'padding-top');
    expect(p?.note).toContain("includes the child's padding 6px");
  });

  it("padding-start: only the dom child has pad 6 → note 'includes the DOM child's padding 6px'", () => {
    const d = snap({ children: [
      { ...snap().children[0], paddings: { top: 6, right: 0, bottom: 0, left: 0 } },
      snap().children[1],
    ] });
    const p = row(diffPair(spec(), d, { tolerancePx: 1 }), 'padding-top');
    expect(p?.note).toContain("includes the DOM child's padding 6px");
  });

  it('padding-start: both sides pad 0 → no note', () => {
    const p = row(diffPair(spec(), snap(), { tolerancePx: 1 }), 'padding-top');
    expect(p?.note).toBeUndefined();
  });

  it('E+D composition: fig-last-TEXT hug + non-zero padEnd → info WITH BOTH notes (E not lost)', () => {
    const s = rowFixSpec({ rect: { x: 52, y: 12, w: 286, h: 24 }, paddings: { top: 0, right: 5, bottom: 0, left: 0 } });
    const rows = diffPair(s, rowFixDom(211.6), { tolerancePx: 1 });
    const pe = row(rows, 'padding-right');
    expect(pe?.status).toBe('demoted');
    expect(pe?.note).toContain("includes the child's padding 5px");
    expect(pe?.note).toContain('hug-width');
  });

  it('text root + overlay override: the text demotion wins first, no double note (the overlay note is absent)', () => {
    const rows = diffPair(textRootSpec(), textRootDomPlain(224.6), { tolerancePx: 1, expectedOverlayWidth: 300 });
    const sw = row(rows, 'size.w');
    expect(sw?.status).toBe('demoted');
    expect(sw?.note).toContain('hug-width');
    expect(sw?.note).not.toContain('overlay_width');
    expect(sw?.note).not.toContain('fixed overlay');
  });
});

describe('diffPair — D-padding-end demote extends to hug containers with text content (transitive case)', () => {
  // A club-card plate: the last fig child is not a TEXT itself, but a hug-width FRAME wrapper
  // (a "Text" column) containing a title+subtitle. The same geometry as the direct
  // TEXT case (rowFixSpec/rowFixDom above) — one-to-one demotion comparability guaranteed.
  const hugRowSpec = (frameOver: Partial<SpecChild> = {}, kids: SpecChild[] = [
    { id: '2:4', name: 'title', type: 'TEXT', rect: { x: 52, y: 12, w: 291, h: 16 },
      textSnippet: 'Заголовок карточки', text: { fontSize: 16 } },
  ]): LayoutSpec => ({
    node: { id: '2:1', name: 'row', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 48 }, axis: 'row',
    children: [
      { id: '2:2', name: 'icon', type: 'INSTANCE', rect: { x: 16, y: 14, w: 20, h: 20 } },
      { id: '2:3', name: 'textCol', type: 'FRAME', rect: { x: 52, y: 12, w: 291, h: 24 }, hugWidth: true, children: kids, ...frameOver },
    ],
  });
  const hugRowDom = (labelW: number): DomSnapshotOk => ({
    schema: 1, status: 'ok', selector: '.row', innerWidth: 375,
    rect: { x: 0, y: 0, w: 343, h: 48 }, borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, transformed: false,
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 48, scrollHeight: 48,
    children: [
      { kind: 'element', tag: 'i', rect: { x: 16, y: 14, w: 20, h: 20 } },
      { kind: 'element', tag: 'div', rect: { x: 52, y: 12, w: labelW, h: 24 } },
    ],
  });

  it('plate repro: a hug-FRAME last child with text inside → padding-end 0 vs 79.4 → info (not fail)', () => {
    const rows = diffPair(hugRowSpec(), hugRowDom(211.6), { tolerancePx: 1 });
    const pe = row(rows, 'padding-right');
    expect(pe).toMatchObject({ figma: 0, dom: 79.4, status: 'demoted' });
    expect(pe?.note).toContain('hug-width');
  });

  it('E+D composition transitive: a hug-FRAME with its own padEnd + text inside → info WITH BOTH notes (E not lost)', () => {
    const s = hugRowSpec({ paddings: { top: 0, right: 5, bottom: 0, left: 0 } });
    const rows = diffPair(s, hugRowDom(211.6), { tolerancePx: 1 });
    const pe = row(rows, 'padding-right');
    expect(pe?.status).toBe('demoted');
    expect(pe?.note).toContain("includes the child's padding 5px");
    expect(pe?.note).toContain('hug-width');
  });

  it('guard: a hug-FRAME WITHOUT texts in the subtree (non-TEXT children) → padding-end stays fail', () => {
    const s = hugRowSpec({}, [{ id: '2:5', name: 'swatch', type: 'RECTANGLE', rect: { x: 52, y: 12, w: 291, h: 24 } }]);
    const rows = diffPair(s, hugRowDom(211.6), { tolerancePx: 1 });
    expect(row(rows, 'padding-right')).toMatchObject({ status: 'fail' });
  });

  it('guard: a NON-hug container (hugWidth absent) with texts inside → padding-end stays fail', () => {
    const s = hugRowSpec({ hugWidth: undefined });
    const rows = diffPair(s, hugRowDom(211.6), { tolerancePx: 1 });
    expect(row(rows, 'padding-right')).toMatchObject({ status: 'fail' });
  });
});

describe('diffPair — padding-end demote via DOM hug-evidence (fill column vs text-hugging DOM) [fix-2]', () => {
  // A club-card plate (spot-check PR #51 + live probing): the fig column "Text" is FILL
  // (hugWidth ABSENT — width set by the parent, does not hug content), but its DOM equivalent
  // actually hugs the text: the right edge of the dom column coincides with the right edge of the widest
  // text descendant. Geometry 1:1 with hugRowSpec/hugRowDom above (the same 0 vs 79.4) —
  // demotion comparability guaranteed.
  const fillColSpec = (kids: SpecChild[] = [
    { id: '2:4', name: 'title', type: 'TEXT', rect: { x: 52, y: 12, w: 200, h: 16 },
      textSnippet: 'Заголовок карточки', text: { fontSize: 16 } },
    { id: '2:5', name: 'subtitle', type: 'TEXT', rect: { x: 52, y: 30, w: 150, h: 12 },
      textSnippet: 'Подпись', text: { fontSize: 12 } },
  ]): LayoutSpec => ({
    node: { id: '2:1', name: 'row', type: 'FRAME' }, rect: { x: 0, y: 0, w: 343, h: 48 }, axis: 'row',
    children: [
      { id: '2:2', name: 'icon', type: 'INSTANCE', rect: { x: 16, y: 14, w: 20, h: 20 } },
      // FILL: hugWidth is NOT set — the width 291 is set by the parent auto-layout, not by the content.
      { id: '2:3', name: 'textCol', type: 'FRAME', rect: { x: 52, y: 12, w: 291, h: 24 }, children: kids },
    ],
  });
  const fillColDom = (divRectW: number, textChildren: DomChild[]): DomSnapshotOk => ({
    schema: 1, status: 'ok', selector: '.row', innerWidth: 375,
    rect: { x: 0, y: 0, w: 343, h: 48 }, borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, transformed: false,
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 48, scrollHeight: 48,
    children: [
      { kind: 'element', tag: 'i', rect: { x: 16, y: 14, w: 20, h: 20 } },
      { kind: 'element', tag: 'div', rect: { x: 52, y: 12, w: divRectW, h: 24 }, children: textChildren },
    ],
  });

  it('plate repro point-perfect: DOM hug-evidence (text exactly to the column edge) → padding-end 0 vs 79.4 → info', () => {
    const d = fillColDom(211.6, [
      { kind: 'text', text: 'Заголовок карточки', rect: { x: 52, y: 12, w: 211.6, h: 16 } }, // edge == 263.6 == column edge
      { kind: 'text', text: 'Подпись', rect: { x: 52, y: 30, w: 120, h: 12 } },
    ]);
    const rows = diffPair(fillColSpec(), d, { tolerancePx: 1 });
    const pe = row(rows, 'padding-right');
    expect(pe).toMatchObject({ figma: 0, dom: 79.4, status: 'demoted' });
    expect(pe?.note).toContain('hug-width');
  });

  it('structural-trailing guard: a dom column WIDER than its texts → padding-end stays fail (we do not hide a real defect)', () => {
    const d = fillColDom(280, [
      { kind: 'text', text: 'Заголовок карточки', rect: { x: 52, y: 12, w: 148, h: 16 } }, // edge 200, column up to 332 (Δ132 > tol)
      { kind: 'text', text: 'Подпись', rect: { x: 52, y: 30, w: 100, h: 12 } },
    ]);
    const rows = diffPair(fillColSpec(), d, { tolerancePx: 1 });
    expect(row(rows, 'padding-right')).toMatchObject({ status: 'fail' });
  });

  it('guard without fig texts: a fig column without textSnippet descendants + dom hug-evidence → stays fail (both conditions required)', () => {
    const s = fillColSpec([{ id: '2:6', name: 'swatch', type: 'RECTANGLE', rect: { x: 52, y: 12, w: 291, h: 24 } }]);
    const d = fillColDom(211.6, [
      { kind: 'text', text: 'Заголовок карточки', rect: { x: 52, y: 12, w: 211.6, h: 16 } },
    ]);
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(row(rows, 'padding-right')).toMatchObject({ status: 'fail' });
  });

  it('dom last kind:text: the padding-end branch is still fully suppressed (untouched by the fix)', () => {
    const d = fillColDom(211.6, []);
    const dTextLast: DomSnapshotOk = { ...d, children: [
      d.children[0],
      { kind: 'text', text: 'inline trailer', rect: { x: 52, y: 12, w: 100, h: 24 } },
    ] };
    const rows = diffPair(fillColSpec(), dTextLast, { tolerancePx: 1 });
    expect(row(rows, 'padding-right')).toBeUndefined();
  });
});

// Capture depth 3→4: typography bug measured 4 levels deep, THROUGH the real
// projector (buildLayoutSpec) — not a hand-built LayoutSpec. This is the point: diffPair's own
// DFS (collectFigTexts/collectDomTexts) has no hop limit, so once buildLayoutSpec actually
// projects L4 (depth mirror raised), the mismatch is caught. Before the depth mirrors are raised,
// the L3 node in the spec tree never gets a .children field at all — the L4 TEXT is invisible to
// buildLayoutSpec, and (independently) projector's collectTexts(c,2) auto-descend heuristic marks
// the L1 child textBeyondCut — which, before this task's diff.ts fix, hard-blocked collectFigTexts
// from ever running. Both must be fixed together for this scenario to go from silent/skip to a
// real fail.
describe('depth-4 capture: 4th-level typography bug measured, not silently lost', () => {
  const l4Text: RawSceneNode = {
    id: '1:5', name: 'value', type: 'TEXT', absoluteBoundingBox: { x: 20, y: 60, width: 80, height: 16 },
    characters: '99 ₽', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 12 },
  };
  const l3Item: RawSceneNode = { id: '1:4', name: 'item', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [l4Text] };
  const l2Row: RawSceneNode = { id: '1:3', name: 'row', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [l3Item] };
  const l1Wrap: RawSceneNode = { id: '1:2', name: 'wrap', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [l2Row] };
  const cardRaw: RawSceneNode = {
    id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 90 },
    layoutMode: 'VERTICAL', children: [l1Wrap],
  };

  const domL4 = (fontSize: number): DomSnapshotOk => ({
    schema: 1, status: 'ok', selector: '.card', innerWidth: 375,
    rect: { x: 0, y: 0, w: 343, h: 90 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 90, scrollHeight: 90,
    scroll: { top: 0, left: 0 }, transformed: false,
    children: [
      { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [
        { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [
          { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [
            { kind: 'text', rect: { x: 20, y: 60, w: 80, h: 16 }, text: '99 ₽', styles: { fontSize } },
          ] },
        ] },
      ] },
    ],
  });

  it('font-size bug on the 4th nesting level (ds-typography inside ds-list-item inside a card) is measured — NOT silently lost', () => {
    const spec4 = buildLayoutSpec(cardRaw);
    const rows = diffPair(spec4, domL4(20), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'font-size[wrap→"99 ₽"]')).toMatchObject({ figma: 12, dom: 20, status: 'fail' });
  });

  it('matching L4 font-size (no bug) → pass, not a false positive', () => {
    const spec4 = buildLayoutSpec(cardRaw);
    const rows = diffPair(spec4, domL4(12), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'font-size[wrap→"99 ₽"]')).toMatchObject({ figma: 12, dom: 12, status: 'pass' });
  });
});

// collectFigTexts (diff.ts) already DFS'd c.children recursively and already read
// childrenTruncated at ANY visited level — this was never broken. What the honest-truncation fix changed is
// the PRODUCER: buildLayoutSpec now actually SETS childrenTruncated at the real depth boundary when
// genuine content sits below it (previously that flag only ever appeared in hand-built SpecChild
// fixtures, never from the real projector). This is a regression lock that the free win really is
// free: run a card THROUGH buildLayoutSpec (not a hand-built LayoutSpec) whose direct pair-child
// ("wrap") has one matched TEXT descendant AND a sibling branch that runs past the depth boundary
// with real content below it — collectFigTexts must see truncated:true from the real projector output
// and diff.ts must surface it (mirrors case 8b's assertions, but the input is now the real thing).
describe('collectFigTexts regression: real buildLayoutSpec childrenTruncated flows into typography auto-descent', () => {
  // Matched branch: a real TEXT within the projection budget (captured, not truncated) — nested
  // TWO hops below "wrap" (wrap→aWrap→bWrap→textLeaf), not a direct sibling. A direct-sibling TEXT
  // would trip a DIFFERENT auto-descend heuristic (projector.ts collectTexts, hopsLeft=2, "c as a
  // whole is a simple TEXT wrapper") and get promoted onto wrap.text itself — bypassing
  // collectFigTexts entirely, which is not what this regression is about (see projector.ts's own
  // comment on why that hopsLeft stays at 2, decoupled from capture depth).
  const textLeaf: RawSceneNode = {
    id: '4:9', name: 'label', type: 'TEXT', absoluteBoundingBox: { x: 16, y: 56, width: 100, height: 16 },
    characters: 'MatchedText', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 12 },
  };
  const bWrap: RawSceneNode = { id: '4:8', name: 'bWrap', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 100, height: 16 }, children: [textLeaf] };
  const aWrap: RawSceneNode = { id: '4:7', name: 'aWrap', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 100, height: 16 }, children: [bWrap] };
  // Truncated branch: real in-flow content (l5) sits past the depth boundary (l4 is terminal —
  // depthLeft hits 0 constructing it, mirrors layout-spec-projector.test.ts case (a)) → l4 gets
  // childrenTruncated:true from the real projector, no fake .children.
  const l5: RawSceneNode = { id: '4:5', name: 'l5', type: 'FRAME', absoluteBoundingBox: { x: 200, y: 56, width: 10, height: 10 } };
  const l4: RawSceneNode = { id: '4:4', name: 'l4', type: 'FRAME', absoluteBoundingBox: { x: 200, y: 56, width: 40, height: 40 }, children: [l5] };
  const l3: RawSceneNode = { id: '4:3', name: 'l3', type: 'FRAME', absoluteBoundingBox: { x: 200, y: 56, width: 40, height: 40 }, children: [l4] };
  const l2: RawSceneNode = { id: '4:2', name: 'l2', type: 'FRAME', absoluteBoundingBox: { x: 200, y: 56, width: 40, height: 40 }, children: [l3] };
  const wrap: RawSceneNode = {
    id: '4:6', name: 'wrap', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 40 },
    children: [aWrap, l2],
  };
  const cardRaw: RawSceneNode = {
    id: '4:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 96 },
    layoutMode: 'VERTICAL', children: [wrap],
  };
  const domWrap: DomSnapshotOk = {
    schema: 1, status: 'ok', selector: '.card', innerWidth: 375,
    rect: { x: 0, y: 0, w: 343, h: 96 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 96, scrollHeight: 96,
    scroll: { top: 0, left: 0 }, transformed: false,
    children: [
      { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 40 }, children: [
        { kind: 'text', rect: { x: 16, y: 56, w: 100, h: 16 }, text: 'MatchedText', styles: { fontSize: 12 } },
      ] },
    ],
  };

  it('real projector depth-boundary childrenTruncated (deep, sibling to a matched TEXT) → typography_descent unchecked note, matched TEXT still measured', () => {
    const spec4 = buildLayoutSpec(cardRaw);
    const rows = diffPair(spec4, domWrap, { tolerancePx: 1 });
    // Matched TEXT still measured — proves this isn't the case-8 (no-overlap) scenario.
    expect(rows.find((r) => r.prop === 'font-size[wrap→"MatchedText"]')).toMatchObject({ figma: 12, dom: 12, status: 'pass' });
    // The real projector's childrenTruncated (on the l2 subtree's terminal l4 node, several hops
    // below "wrap") reached collectFigTexts and surfaced as an honest skip, not silence.
    const skip = rows.find((r) => r.prop === 'typography_descent[wrap]');
    expect(skip?.status).toBe('unchecked');
    expect(skip?.note).toContain('deeper');
  });
});

describe('descentFor — max_depth threads into the auto-descend TEXT cap', () => {
  // 20 TEXT descendants under one wrapper: exceeds the default cap (MAX_TEXT_DESCENT=15) but fits
  // whole under the max_depth:8 cap (descentFor(8)=30). Content is unique per item (item-0..item-19)
  // so phase-1 content-bijection matches every collected item on both sides — no order-matching
  // ambiguity muddies which cap actually fired.
  const mkFigText = (i: number): SpecChild => ({
    id: `t:${i}`, name: 't', type: 'TEXT', rect: { x: 0, y: i * 10, w: 100, h: 8 },
    textSnippet: `item-${i}`, text: { fontSize: 12 },
  });
  const mkDomText = (i: number): DomChild => ({ kind: 'text', rect: { x: 0, y: i * 10, w: 100, h: 8 }, text: `item-${i}`, styles: { fontSize: 12 } });
  const wrapFig: SpecChild = {
    id: 'w:1', name: 'wrap', type: 'FRAME', rect: { x: 0, y: 0, w: 100, h: 200 },
    children: Array.from({ length: 20 }, (_, i) => mkFigText(i)),
  };
  const wrapDom: DomChild = {
    kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 200 },
    children: Array.from({ length: 20 }, (_, i) => mkDomText(i)),
  };
  const s = spec({ children: [wrapFig] });
  const d = snap({ children: [wrapDom] });

  it('default (no maxDepth): 15-cap truncates — honest skip, the 20th item is not measured', () => {
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'typography_descent[wrap]')).toMatchObject({ status: 'unchecked' });
    expect(rows.some((r) => r.prop.startsWith('font-size[wrap→"item-19"'))).toBe(false);
  });

  it('maxDepth:8: 30-cap fits all 20 whole — no typography_descent row, the 20th item IS measured', () => {
    const rows = diffPair(s, d, { tolerancePx: 1, maxDepth: 8 });
    expect(rows.find((r) => r.prop === 'typography_descent[wrap]')).toBeUndefined();
    expect(rows.some((r) => r.prop.startsWith('font-size[wrap→"item-19"'))).toBe(true);
  });

  it('maxDepth:4 (explicit) is byte-for-byte the default (backward-compat)', () => {
    const rowsDefault = diffPair(s, d, { tolerancePx: 1 });
    const rowsExplicit4 = diffPair(s, d, { tolerancePx: 1, maxDepth: 4 });
    expect(rowsExplicit4).toEqual(rowsDefault);
  });
});

describe('🅰️-1: skip notes call max_depth (education before a manual drill)', () => {
  // a wrapper child with textBeyondCut and an empty auto-descent (a leaf beyond the projection cut)
  const beyondCutSpec = {
    node: { id: '1:1', name: 'card', type: 'FRAME' }, rect: { x: 0, y: 0, w: 300, h: 80 },
    axis: 'col' as const, autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    children: [
      { id: '1:2', name: 'listItem', type: 'FRAME', rect: { x: 0, y: 0, w: 300, h: 40 }, textBeyondCut: true as const },
    ],
  };
  const dom = {
    schema: 1, status: 'ok' as const, selector: '.card', innerWidth: 375,
    rect: { x: 0, y: 0, w: 300, h: 80 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 }, transformed: false,
    children: [{ kind: 'element' as const, tag: 'div', rect: { x: 0, y: 0, w: 300, h: 40 } }],
  };

  it('textBeyondCut skip note contains max_depth', () => {
    const rows = diffPair(beyondCutSpec as any, dom as any, { tolerancePx: 1 });
    const skip = rows.find((r: any) => typeof r.prop === 'string' && r.prop.startsWith('typography['));
    expect(skip?.status).toBe('unchecked');
    expect(skip?.note).toContain('max_depth');
  });

  it('textAmbiguous skip note contains max_depth', () => {
    const ambiguousSpec = {
      node: { id: '1:1', name: 'card', type: 'FRAME' }, rect: { x: 0, y: 0, w: 300, h: 80 },
      axis: 'col' as const, autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      children: [
        { id: '1:2', name: 'listItem', type: 'FRAME', rect: { x: 0, y: 0, w: 300, h: 40 }, textAmbiguous: true as const },
      ],
    };
    const rows = diffPair(ambiguousSpec as any, dom as any, { tolerancePx: 1 });
    const skip = rows.find((r: any) => typeof r.prop === 'string' && r.prop.startsWith('typography['));
    expect(skip?.status).toBe('unchecked');
    expect(skip?.note).toContain('max_depth');
  });

  it('truncation skip note (visible matched, capture truncated) contains max_depth', () => {
    const mkFigText = (i: number): SpecChild => ({
      id: `t:${i}`, name: 't', type: 'TEXT', rect: { x: 0, y: i * 10, w: 100, h: 8 },
      textSnippet: `item-${i}`, text: { fontSize: 12 },
    });
    const mkDomText = (i: number): DomChild => ({ kind: 'text', rect: { x: 0, y: i * 10, w: 100, h: 8 }, text: `item-${i}`, styles: { fontSize: 12 } });
    const wrapFig: SpecChild = {
      id: 'w:1', name: 'wrap', type: 'FRAME', rect: { x: 0, y: 0, w: 100, h: 200 },
      children: Array.from({ length: 20 }, (_, i) => mkFigText(i)),
    };
    const wrapDom: DomChild = {
      kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 200 },
      children: Array.from({ length: 20 }, (_, i) => mkDomText(i)),
    };
    const s = spec({ children: [wrapFig] });
    const d = snap({ children: [wrapDom] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const skip = rows.find((r) => r.prop.startsWith('typography_descent['));
    expect(skip?.status).toBe('unchecked');
    expect(skip?.note).toContain('max_depth');
  });
});

describe('🅱️: justify-content demotes a padding spacer → info', () => {
  // ⚠️ CRITICAL (caught by the plan's adversarial): the fixture MUST be ASYMMETRIC (Figma≠DOM) so that
  // the target padding row is a REAL fail BEFORE the demotion. A symmetric one (fig child==dom child)
  // gives delta 0 → status 'pass', and applyJustifyDemote touches only 'fail' → the demotion is a no-op, all
  // asserts red under CORRECT code, and the mutation SAFETY lock is VACUOUS.
  //
  // Trailing-fail: the Figma child ends at 240 (gap 60), DOM flush to 300 (gap 0)
  // → padding-right: figma (300-240)=60 vs dom (300-300)=0 → delta 60 → fail.
  const specTrail = {
    node: { id: '1:1', name: 'row', type: 'FRAME' }, rect: { x: 0, y: 0, w: 300, h: 40 },
    axis: 'row' as const, autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    children: [{ id: '1:2', name: 'a', type: 'FRAME', rect: { x: 0, y: 0, w: 240, h: 40 } }],
  };
  const domTrail = (jc?: string) => ({
    schema: 1, status: 'ok' as const, selector: '.row', innerWidth: 375,
    rect: { x: 0, y: 0, w: 300, h: 40 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 300, clientHeight: 40, scrollHeight: 40,
    scroll: { top: 0, left: 0 }, transformed: false,
    ...(jc ? { styles: { display: 'flex', justifyContent: jc } } : {}),
    children: [{ kind: 'element' as const, tag: 'div', rect: { x: 0, y: 0, w: 300, h: 40 } }],
  });
  const pr = (rows: any[]) => rows.find((r: any) => r.prop === 'padding-right');

  it('space-between → padding-right (a real fail 60 vs 0) is demoted to info', () => {
    const rows = diffPair(specTrail as any, domTrail('space-between') as any, { tolerancePx: 1 });
    expect(pr(rows)?.status).toBe('demoted');
    expect(pr(rows)?.note).toContain('justify-content');
  });
  it('SAFETY: flex-start → padding-right stays fail (a real defect is NOT hidden)', () => {
    expect(pr(diffPair(specTrail as any, domTrail('flex-start') as any, { tolerancePx: 1 }))?.status).toBe('fail');
  });
  it('SAFETY: no styles (old snapshot) → padding-right stays fail', () => {
    expect(pr(diffPair(specTrail as any, domTrail(undefined) as any, { tolerancePx: 1 }))?.status).toBe('fail');
  });
  it('SAFETY: display:block + justify-content:space-between (an inert ghost keyword) → padding-right stays fail', () => {
    // getComputedStyle().justifyContent returns the specified keyword REGARDLESS of display — but block
    // does not distribute free space (children sit flush in normal flow). Demoting ONLY by the jc value
    // (without checking display) would hide a REAL padding defect behind a false note "free space
    // distributed" — a utility class/breakpoint may leave justify-content on a block container.
    const domTrailBlock = {
      ...domTrail('space-between'),
      styles: { display: 'block', justifyContent: 'space-between' },
    };
    const rows = diffPair(specTrail as any, domTrailBlock as any, { tolerancePx: 1 });
    expect(pr(rows)?.status).toBe('fail');
  });

  // Leading-fail: the Figma child starts at 60 (gap 60), DOM flush-left (gap 0)
  // → padding-left: figma 60 vs dom 0 → fail; padding-right: figma 0 vs dom 60 → also fail.
  const specLead = {
    node: { id: '1:1', name: 'row', type: 'FRAME' }, rect: { x: 0, y: 0, w: 300, h: 40 },
    axis: 'row' as const, autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    children: [{ id: '1:2', name: 'a', type: 'FRAME', rect: { x: 60, y: 0, w: 240, h: 40 } }],
  };
  const domLead = (jc?: string) => ({
    schema: 1, status: 'ok' as const, selector: '.row', innerWidth: 375,
    rect: { x: 0, y: 0, w: 300, h: 40 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 300, clientHeight: 40, scrollHeight: 40,
    scroll: { top: 0, left: 0 }, transformed: false,
    ...(jc ? { styles: { display: 'flex', justifyContent: jc } } : {}),
    children: [{ kind: 'element' as const, tag: 'div', rect: { x: 0, y: 0, w: 240, h: 40 } }],
  });
  it('flex-end → padding-left (a real fail) demoted → info; trailing stays fail', () => {
    const rows = diffPair(specLead as any, domLead('flex-end') as any, { tolerancePx: 1 });
    expect(rows.find((r: any) => r.prop === 'padding-left')?.status).toBe('demoted');
    expect(rows.find((r: any) => r.prop === 'padding-right')?.status).toBe('fail');
  });
});

describe('border-color / border-width', () => {
  const domBorder = (colors: any, widths = { top: 2, right: 2, bottom: 2, left: 2 }) => ({
    schema: 1, innerWidth: 400, rect: { x: 0, y: 0, w: 100, h: 50 },
    borders: widths, borderColors: colors, scroll: { top: 0, left: 0 }, children: [],
  });

  it('uniform match → pass', () => {
    const rows = diffPair({ node: { id: '1', name: 'n', type: 'FRAME' }, strokeHex: '#ff0000', strokeWeight: 2, children: [] } as any,
      domBorder({ top: '#ff0000', right: '#ff0000', bottom: '#ff0000', left: '#ff0000' }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('pass');
    expect(rows.find((r) => r.prop === 'border-width')?.status).toBe('pass');
  });

  it('color mismatch → fail', () => {
    const rows = diffPair({ node: { id: '1', name: 'n', type: 'FRAME' }, strokeHex: '#ff0000', strokeWeight: 2, children: [] } as any,
      domBorder({ top: '#00ff00', right: '#00ff00', bottom: '#00ff00', left: '#00ff00' }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('fail');
  });

  it('mode-unconfirmed stroke token → mismatch degrades to review (group B, not fail/green)', () => {
    // The former boundColorNote demotion (warn); the mechanism was switched to a mode-resolved token:
    // mode_source:'default' = the mode is not confirmed → hex discrepancy → review (gating).
    const rows = diffPair({ node: { id: '1', name: 'n', type: 'FRAME' }, strokeHex: '#00ff00', strokeWeight: 2,
      strokeToken: { token: 'border/accent', hex: '#00ff00', mode: 'Lunar', mode_dependent: true, mode_source: 'default', all_modes: { Solar: '#ff0000', Lunar: '#00ff00' } }, children: [] } as any,
      domBorder({ top: '#ff0000', right: '#ff0000', bottom: '#ff0000', left: '#ff0000' }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('review');
  });

  it('per-side divergence → warn (not a false uniform)', () => {
    const rows = diffPair({ node: { id: '1', name: 'n', type: 'FRAME' }, strokeHex: '#ff0000', strokeWeight: 2, children: [] } as any,
      domBorder({ top: '#ff0000', right: '#00ff00', bottom: '#ff0000', left: '#ff0000' }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('warn');
  });

  it('oklch undefined side → warn (does not match as equality)', () => {
    const rows = diffPair({ node: { id: '1', name: 'n', type: 'FRAME' }, strokeHex: '#ff0000', strokeWeight: 2, children: [] } as any,
      domBorder({ top: undefined, right: undefined, bottom: undefined, left: undefined }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('warn');
  });

  it('one-sided (Figma stroke, DOM has no border) → warn', () => {
    const rows = diffPair({ node: { id: '1', name: 'n', type: 'FRAME' }, strokeHex: '#ff0000', strokeWeight: 2, children: [] } as any,
      domBorder({}, { top: 0, right: 0, bottom: 0, left: 0 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('warn');
  });

  it('both-absent → no border rows (byte-for-byte)', () => {
    const rows = diffPair({ node: { id: '1', name: 'n', type: 'FRAME' }, children: [] } as any,
      domBorder({}, { top: 0, right: 0, bottom: 0, left: 0 }) as any, { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'border-color' || r.prop === 'border-width')).toBe(false);
  });

  it('partial DOM border (bottom only) vs full-perimeter Figma stroke → warn, NOT pass (never-false-green)', () => {
    // the color matches on the active side — previously this gave a false pass; now an honest presence warn.
    const rows = diffPair({ node: { id: '1', name: 'n', type: 'FRAME' }, strokeHex: '#ff0000', strokeWeight: 2, children: [] } as any,
      domBorder({ top: '#ff0000', right: '#ff0000', bottom: '#ff0000', left: '#ff0000' },
        { top: 0, right: 0, bottom: 2, left: 0 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('warn');
    // we do not emit the width row in the partial case (presence is in question)
    expect(rows.some((r) => r.prop === 'border-width')).toBe(false);
  });
});

describe('box-shadow diff', () => {
  const specSh = (sh: any) => ({ node: { id: '1', name: 'n', type: 'FRAME' }, shadow: sh, children: [] });
  const domSh = (sh: any) => ({ schema: 1, innerWidth: 400, rect: { x: 0, y: 0, w: 100, h: 50 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 }, shadow: sh, scroll: { top: 0, left: 0 }, children: [] });

  it('both single, components match → pass rows (incl. spread)', () => {
    const rows = diffPair(specSh({ inner: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#0000001a', count: 1 }) as any,
      domSh({ inset: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#0000001a', count: 1 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'shadow-y')?.status).toBe('pass');
    expect(rows.find((r) => r.prop === 'shadow-spread')?.status).toBe('pass');
  });
  it('blur mismatch → fail', () => {
    const rows = diffPair(specSh({ inner: false, x: 0, y: 4, blur: 6, spread: 0, count: 1 }) as any,
      domSh({ inset: false, x: 0, y: 4, blur: 12, spread: 0, count: 1 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'shadow-blur')?.status).toBe('fail');
  });
  it('type inset vs drop → box-shadow fail', () => {
    const rows = diffPair(specSh({ inner: false, x: 0, y: 4, blur: 6, spread: 0, count: 1 }) as any,
      domSh({ inset: true, x: 0, y: 4, blur: 6, spread: 0, count: 1 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'box-shadow')?.status).toBe('fail');
  });
  it('count>1 → single warn, without per-component rows', () => {
    const rows = diffPair(specSh({ inner: false, x: 0, y: 4, blur: 6, spread: 0, count: 2 }) as any,
      domSh({ inset: false, x: 0, y: 4, blur: 6, spread: 0, count: 1 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'box-shadow')?.status).toBe('warn');
    expect(rows.some((r) => r.prop === 'shadow-y')).toBe(false);
  });
  it('spread matched → shadow-spread pass', () => {
    const rows = diffPair(specSh({ inner: false, x: 0, y: 4, blur: 6, spread: 4, count: 1 }) as any,
      domSh({ inset: false, x: 0, y: 4, blur: 6, spread: 4, count: 1 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'shadow-spread')?.status).toBe('pass');
  });
  it('spread diverged → shadow-spread fail (Figma spread from REST — the former Figma-only false-green closed)', () => {
    // previously the row was gated on ds.spread≠0 → Figma spread=5 / DOM spread=0 gave ZERO rows = a silent green.
    const rows = diffPair(specSh({ inner: false, x: 0, y: 4, blur: 6, spread: 5, count: 1 }) as any,
      domSh({ inset: false, x: 0, y: 4, blur: 6, spread: 0, count: 1 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'shadow-spread')?.status).toBe('fail');
  });
  it('one-sided (Figma shadow, DOM none) → box-shadow warn', () => {
    const rows = diffPair(specSh({ inner: false, x: 0, y: 4, blur: 6, spread: 0, count: 1 }) as any,
      domSh(undefined) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'box-shadow')?.status).toBe('warn');
  });
  it('color undefined on one side → shadow-color warn (not a silent skip)', () => {
    const rows = diffPair(specSh({ inner: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#0000001a', count: 1 }) as any,
      domSh({ inset: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: undefined, count: 1 }) as any, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'shadow-color')?.status).toBe('warn');
  });
  it('both-absent → no shadow rows (byte-for-byte)', () => {
    const rows = diffPair(specSh(undefined) as any, domSh(undefined) as any, { tolerancePx: 1 });
    expect(rows.some((r) => r.prop?.startsWith('shadow') || r.prop === 'box-shadow')).toBe(false);
  });
});

describe('diffPair — A2 structure_mismatch salvage', () => {
  // Text anchor → high-conf (scorePair text-exact +100). SpecChild.textSnippet ↔ DomChild.text.
  const txt = (id: string, snippet: string, x: number, y: number): SpecChild => ({
    id, name: snippet, type: 'TEXT', rect: { x, y, w: 100, h: 20 }, textSnippet: snippet,
  });
  const domTxt = (text: string, x: number, y: number): DomChild =>
    ({ kind: 'element', tag: 'span', rect: { x, y, w: 100, h: 20 }, text }) as DomChild;

  it('count mismatch + text anchor → salvage: diffs the high-conf subset, not a total skip', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'col',
      children: [txt('1:2', 'Alpha', 16, 0), txt('1:3', 'Beta', 16, 20), txt('1:4', 'Gamma', 16, 40)] });
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 60 },
      children: [domTxt('Alpha', 16, 0), domTxt('Gamma', 40, 40)] }); // no Beta; Gamma shifted on the cross axis x16→x40
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    expect(sm?.note).toMatch(/2 high-conf matched/);
    expect(sm?.note).toMatch(/Beta/); // the unmatched one is named
    const crossRows = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crossRows.length).toBe(2); // metrics for the matched ones are recovered
    expect(crossRows.some((r) => r.status === 'fail')).toBe(true); // Gamma x16→x40 = a defect, previously invisible
    expect(rows.some((r) => r.prop === 'padding-top' || r.prop === 'padding-bottom')).toBe(false); // padding skipped on the subset
  });

  it('a gap through an unmatched child is NOT computed (adjacency guard)', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'col',
      children: [txt('1:2', 'Alpha', 16, 0), txt('1:3', 'Beta', 16, 20), txt('1:4', 'Gamma', 16, 40)] });
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 60 }, children: [domTxt('Alpha', 16, 0), domTxt('Gamma', 16, 40)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.some((r) => r.prop.startsWith('gap'))).toBe(false); // Alpha(idx0)↔Gamma(idx2) not adjacent in fig
  });

  it('no high-conf (no text, only size/order) → total structure_mismatch, no child rows', () => {
    const nc = (id: string, w: number): SpecChild => ({ id, name: id, type: 'FRAME', rect: { x: 0, y: 0, w, h: 20 } });
    const s = spec({ axis: 'col', children: [nc('1:2', 100), nc('1:3', 50), nc('1:4', 30)] });
    const d = snap({ children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 20 } } as DomChild,
      { kind: 'element', tag: 'div', rect: { x: 0, y: 30, w: 50, h: 20 } } as DomChild] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'structure_mismatch')?.note).toMatch(/pairwise metrics skipped/); // total, not salvage
    expect(rows.some((r) => r.prop.startsWith('gap') || r.prop.startsWith('offset-cross'))).toBe(false);
  });

  it('a salvaged structure_mismatch stays a coverage HOLE (A1 receipt not green)', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 40 }, axis: 'col',
      children: [txt('1:2', 'Alpha', 16, 0), txt('1:3', 'Beta', 16, 20)] });
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 40 }, children: [domTxt('Alpha', 16, 0)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(coverageHoleRows(rows).some((r) => r.prop === 'structure_mismatch')).toBe(true);
  });

  // Adversarial findings #1/#3: high is reachable ONLY via text-exact (+100; size+order max ~45 <90),
  // so a duplicate text on EITHER side makes the margin depend on size+order (blind to cross position) →
  // a confident match of the WRONG duplicate is possible = confident-wrong. Duplicate text → cap medium (excluded from high).
  it('duplicate text in DOM → NOT high-salvage (does not diff an indistinguishable anchor) — closes confident-wrong #1', () => {
    // size (w20 vs w80 with a narrow parent w100) + order pull the margin to the WRONG Save (@x90, di0) ≥12 →
    // without the guard high on the wrong one → offset-cross fail against x90, although the true pair is Save@x10. Guard → medium.
    const smallTxt = (id: string, snippet: string, x: number, y: number, w: number): SpecChild =>
      ({ id, name: snippet, type: 'TEXT', rect: { x, y, w, h: 20 }, textSnippet: snippet });
    const smallDom = (text: string, x: number, y: number, w: number): DomChild =>
      ({ kind: 'element', tag: 'span', rect: { x, y, w, h: 20 }, text }) as DomChild;
    const s = spec({ rect: { x: 0, y: 0, w: 100, h: 80 }, axis: 'col',
      children: [smallTxt('1:2', 'Save', 10, 0, 80), smallTxt('1:3', 'Unique', 10, 60, 80)] });
    const d = snap({ rect: { x: 0, y: 0, w: 100, h: 80 },
      children: [smallDom('Save', 90, 0, 80), smallDom('Save', 10, 20, 20), smallDom('Unique', 10, 60, 80)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    expect(sm?.note).toMatch(/1 high-conf matched/); // only Unique; the duplicate Save is excluded (without the guard it would be 2)
    const crossRows = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crossRows.length).toBe(1); // only Unique (without the guard — 2, including a false fail on x90)
    expect(crossRows.some((r) => r.status === 'fail')).toBe(false); // zero confident-wrong on a duplicate anchor
  });

  it('duplicate text in FIGMA → NOT high-salvage (two Figma nodes of the same text are not diffed confidently) — #3', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'col',
      children: [txt('1:2', 'Save', 16, 0), txt('1:3', 'Save', 16, 20), txt('1:4', 'Unique', 16, 40)] });
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 60 },
      children: [domTxt('Save', 16, 0), domTxt('Unique', 16, 40)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'structure_mismatch')?.note).toMatch(/1 high-conf matched/); // both Save excluded
    const crossRows = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crossRows.length).toBe(1); // only Unique
    expect(crossRows.some((r) => r.status === 'fail')).toBe(false);
  });

  // Adversarial finding #2: under salvage the monotonicity guard iterates the RAW d.children (not the matched subset) —
  // it would catch a non-monotonicity on the unmatched ones and wipe the promised salvage rows with an early-return. Skipped under salvage.
  it('salvage + non-monotonic DOM doc order → salvage rows survive (monotonicity guard skipped) — #2', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 80 }, axis: 'col',
      children: [txt('1:2', 'Alpha', 16, 0), txt('1:3', 'Beta', 16, 20), txt('1:4', 'Gamma', 16, 40), txt('1:5', 'Delta', 16, 60)] });
    // DOM in DOC order is non-monotonic by y (Gamma@40, Alpha@0, Beta@20); no Delta → count 4≠3 → salvage.
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 80 },
      children: [domTxt('Gamma', 16, 40), domTxt('Alpha', 16, 0), domTxt('Beta', 16, 20)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'structure_mismatch')?.note).toMatch(/3 high-conf matched/);
    expect(rows.some((r) => r.prop === 'layout_axis_mismatch')).toBe(false); // guard skipped under salvage
    expect(rows.filter((r) => r.prop.startsWith('offset-cross')).length).toBe(3); // salvage metrics survived (not wiped)
  });

  // Re-review adversarial (important): high is reachable via text-exact, but snippets are cut at SNIPPET_CAP chars →
  // equality on a PREFIX does not prove the full text. Two DIFFERENT texts with the same first SNIPPET_CAP chars would give
  // +100 on a mis-pair (cross-collision, the duplicate counter does not catch it — each is unique after the cut). SNIPPET_CAP-char → cap medium.
  it('truncation-suspect (SNIPPET_CAP-char snippet) → NOT high-salvage (a prefix cross-collision is not diffed)', () => {
    const P40 = 'ABCDEFGHIJ'.repeat(12); // exactly SNIPPET_CAP chars — at the cut cap
    expect(P40.length).toBe(SNIPPET_CAP);
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'col',
      children: [txt('1:2', P40, 16, 0), txt('1:3', 'Short', 16, 40)] });
    // dom @x99 shares the first SNIPPET_CAP chars (a cut), but it is a DIFFERENT node; there is no true pair for P40 in the DOM.
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 60 },
      children: [domTxt(P40, 99, 0), domTxt('Extra', 16, 20), domTxt('Short', 16, 40)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'structure_mismatch')?.note).toMatch(/1 high-conf matched/); // only Short; P40 not high
    const crossRows = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crossRows.length).toBe(1); // only Short (without the guard P40 would match on x99 = a false cross-fail)
    expect(crossRows.some((r) => r.status === 'fail')).toBe(false);
  });

  // Re-review adversarial (minor): under salvage the matched dom children may overlap on the MAIN axis (flex-wrap:
  // after sorting by main-start they became neighbors, but in different cross bands) → the main gap would span a row boundary
  // = a meaningless number. Skipped with an honest note; a real 2D drift goes into offset-cross (the verdict is non-green).
  it('salvage + flex-wrap (overlap on the main axis) → gap skipped with a wrap note, not a false number', () => {
    // Figma: 1 row (row) A/B/C. DOM: the same A/B/C wrapped into 3 visual rows (x0) + deco@x100 → count 3≠4.
    const s = spec({ rect: { x: 0, y: 0, w: 300, h: 20 }, axis: 'row',
      children: [txt('1:2', 'A', 0, 0), txt('1:3', 'B', 100, 0), txt('1:4', 'C', 200, 0)] });
    const d = snap({ rect: { x: 0, y: 0, w: 120, h: 120 },
      children: [domTxt('A', 0, 0), domTxt('B', 0, 50), domTxt('C', 0, 100), domTxt('deco', 100, 0)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'structure_mismatch')?.note).toMatch(/3 high-conf matched/);
    const gapRows = rows.filter((r) => r.prop.startsWith('gap'));
    expect(gapRows.length).toBe(2); // A↔B, B↔C
    expect(gapRows.every((r) => r.status === 'skip')).toBe(true); // both skipped as wrap, not a false numeric fail
    expect(gapRows.every((r) => /wrap|overlap/.test(r.note ?? ''))).toBe(true);
    expect(gapRows.some((r) => r.status === 'fail')).toBe(false);
    // the real 2D drift survived in offset-cross (B/C in other rows) → the verdict is non-green
    expect(rows.filter((r) => r.prop.startsWith('offset-cross') && r.status === 'fail').length).toBeGreaterThan(0);
  });

  it('total-skip on a phase-0 truncation mute carries an actionable tail "raise max_depth" (spec-test 8)', () => {
    // instance children without their own textSnippet; a dom sibling with childrenTruncated → contentUnknown('truncation') →
    // phase-0 muted. A drill REALLY helps here — the CAPTURE is truncated (depth/budget), not the text length.
    const inst = (id: string): SpecChild => ({ id, name: id, type: 'INSTANCE', rect: { x: 0, y: 0, w: 100, h: 40 },
      children: [{ id: `${id}t`, name: 't', type: 'TEXT', rect: { x: 0, y: 0, w: 90, h: 18 }, textSnippet: `U${id}` }] }) as SpecChild;
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'col', children: [inst('1:2'), inst('1:3')] });
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 60 }, children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 40 }, childrenTruncated: true } as DomChild] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.note).toMatch(/pairwise metrics skipped/);          // the existing prefix is preserved
    expect(sm?.note).toMatch(/raise max_depth/);                   // the tail is present — the truncation branch
    expect(sm?.note).not.toMatch(/drill will not help/);
  });
  // Edge case (salvage-nested): the same total-skip branch, but the mute is from a DIFFERENT cause —
  // the text is FULL (not truncated by depth/budget), the snippet is just structurally cut at SNIPPET_CAP chars
  // (dom-extractor/projector .slice(0,SNIPPET_CAP)). "Raise max_depth" here would be a false promise —
  // a deeper extractor gives the same SNIPPET_CAP-char cut, a drill will not widen the boundary. A separate honest note.
  it('total-skip on a phase-0 longtext mute carries the tail "a drill will not help", NOT "raise max_depth" (spec-test 8b)', () => {
    const inst = (id: string): SpecChild => ({ id, name: id, type: 'INSTANCE', rect: { x: 0, y: 0, w: 100, h: 40 },
      children: [{ id: `${id}t`, name: 't', type: 'TEXT', rect: { x: 0, y: 0, w: 90, h: 18 }, textSnippet: `U${id}` }] }) as SpecChild;
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'col', children: [inst('1:2'), inst('1:3')] });
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 60 }, children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 40 }, text: 'z'.repeat(SNIPPET_CAP) } as DomChild] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.note).toMatch(/pairwise metrics skipped/);
    expect(sm?.note).toMatch(/drill will not help/);                    // the tail is present — the longtext branch
    expect(sm?.note).not.toMatch(/raise max_depth/);               // mutation "one note for both causes" → RED here
  });
  it('the longtext note carries the CURRENT threshold (≥120), not 40 (a runtime-string drift lock)', () => {
    // the longtext-mute fixture (like the existing test 8b), text 'z'.repeat(SNIPPET_CAP).
    const inst = (id: string): SpecChild => ({ id, name: id, type: 'INSTANCE', rect: { x: 0, y: 0, w: 100, h: 40 },
      children: [{ id: `${id}t`, name: 't', type: 'TEXT', rect: { x: 0, y: 0, w: 90, h: 18 }, textSnippet: `U${id}` }] }) as SpecChild;
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'col', children: [inst('1:2'), inst('1:3')] });
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 60 }, children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 40 }, text: 'z'.repeat(SNIPPET_CAP) } as DomChild] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.note).toContain(`≥${SNIPPET_CAP}`);      // first interpolation
    expect(sm?.note).toContain(`${SNIPPET_CAP})`);      // second interpolation ("cut at SNIPPET_CAP")
    expect(sm?.note).not.toContain('≥40');              // mutation "the literal 40 stayed" → RED
  });
  // Edge case: the truncation > longtext priority must survive a mixed-level fixture
  // (one dom sibling truncated + another dom sibling longtext) — the final note must stay
  // the truncation branch (a drill really helps somewhere on the level), not soften to longtext.
  it('total-skip on a mixed fixture (truncated sibling + longtext sibling) — the note stays the truncation branch (spec-test 8c)', () => {
    const inst = (id: string): SpecChild => ({ id, name: id, type: 'INSTANCE', rect: { x: 0, y: 0, w: 100, h: 40 },
      children: [{ id: `${id}t`, name: 't', type: 'TEXT', rect: { x: 0, y: 0, w: 90, h: 18 }, textSnippet: `U${id}` }] }) as SpecChild;
    // the count mismatch relies on 1 fig child against 2 dom children (otherwise 2≠2 would not trigger salvage at all)
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 60 }, axis: 'col', children: [inst('1:2')] });
    const longtextSibling: DomChild = { kind: 'element', tag: 'div', rect: { x: 0, y: 40, w: 100, h: 40 }, text: 'z'.repeat(SNIPPET_CAP) } as DomChild;
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 60 }, children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 40 }, childrenTruncated: true } as DomChild,
      longtextSibling] });
    // Anti-rot guard: without it the longtext arm could quietly evaporate (e.g. if
    // the z-text turned out shorter than SNIPPET_CAP due to a fixture drift) and "truncation wins"
    // would go green vacuously — the test would lock nothing about the priority.
    expect(domContentUnknown(longtextSibling)).toBe('longtext');
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.note).toMatch(/raise max_depth/);                   // truncation outweighs longtext
    expect(sm?.note).not.toMatch(/drill will not help/);
    // mutation "longtext priority over truncation" → the note would become "a drill will not help" → RED
  });
  it('total-skip WITHOUT a mute (phase-0 ran, no unique S) — NO tail (mutation "tail always" → RED)', () => {
    const nc = (id: string, w: number): SpecChild => ({ id, name: id, type: 'FRAME', rect: { x: 0, y: 0, w, h: 20 } });
    const s = spec({ axis: 'col', children: [nc('1:2', 100), nc('1:3', 50), nc('1:4', 30)] });
    const d = snap({ children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 20 } } as DomChild,
      { kind: 'element', tag: 'div', rect: { x: 0, y: 30, w: 50, h: 20 } } as DomChild] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.note).toMatch(/pairwise metrics skipped/);
    expect(sm?.note).not.toMatch(/raise max_depth/);
  });
  it('nested-high pairs are diffed with their original rects (metrics recovered; spec-test 1 at the diff level)', () => {
    const inst = (id: string, t: string, x: number, y: number): SpecChild => ({ id, name: id, type: 'INSTANCE',
      rect: { x, y, w: 100, h: 40 }, children: [{ id: `${id}t`, name: t, type: 'TEXT', rect: { x, y, w: 90, h: 18 }, textSnippet: t }] }) as SpecChild;
    const domI = (t: string, x: number, y: number): DomChild => ({ kind: 'element', tag: 'article', rect: { x, y, w: 100, h: 40 },
      children: [{ kind: 'element', tag: 'span', rect: { x, y, w: 90, h: 18 }, text: t }] }) as DomChild;
    const s = spec({ rect: { x: 0, y: 0, w: 343, h: 100 }, axis: 'col', children: [inst('1:2', 'Альфа', 16, 0), inst('1:3', 'Бета', 16, 50)] });
    const d = snap({ rect: { x: 0, y: 0, w: 343, h: 100 }, children: [domI('Альфа', 16, 0), domI('Бета', 40, 50), domI('Промо', 16, 90)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'structure_mismatch')?.note).toMatch(/2 high-conf matched/);
    const cross = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(cross.some((r) => r.status === 'fail')).toBe(true);       // Бета x16→x40 defect caught (previously total-skip)
  });

  // Edge case (children-reorder): the `!salvaged` gate on the detector
  // MUST hold — under salvage figKids/domKids2 are ALREADY narrowed to a high-conf BIJECTION (figSub/domSub above,
  // equal length by construction), so detectChildrenReorder COULD find a geometric permutation
  // WITHIN it, if it were called. fig A@x0 / B@x120; dom: B-text@x0, A-text@x120 (geometrically
  // swapped) + a third banner without text (keeps count-mismatch 2 fig vs 3 dom → salvage).
  it('a salvage bijection is geometrically swapped — the detector is NOT called under salvage (gate !salvaged)', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 340, h: 20 }, axis: 'row',
      children: [txt('1:2', 'Alpha', 0, 0), txt('1:3', 'Beta', 120, 0)] });
    const d = snap({ rect: { x: 0, y: 0, w: 340, h: 20 }, children: [
      domTxt('Beta', 0, 0), domTxt('Alpha', 120, 0),
      { kind: 'element', tag: 'div', rect: { x: 240, y: 0, w: 100, h: 20 } } as DomChild] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.note).toMatch(/2 high-conf matched/); // Alpha/Beta text-anchor high, banner unmatched
    expect(rows.some((r) => r.prop === 'children_reorder')).toBe(false);
    const crossRows = rows.filter((r) => r.prop.startsWith('offset-cross'));
    expect(crossRows.length).toBe(2); // the salvage note "metrics below" holds — the detector did not wipe them
    // mutation `!salvaged` → `true`: the detector would see the bijection fig0↔dom1/fig1↔dom0 (j≠i) → would push
    // a false children_reorder + movedIdx would wipe both offset-cross (crossRows.length would drop to 0) → RED here
  });
});

describe('diffPair — children_reorder (equal-count mis-order)', () => {
  const inst = (id: string, t: string, x: number): SpecChild => ({ id, name: id, type: 'INSTANCE',
    rect: { x, y: 0, w: 100, h: 40 }, children: [{ id: `${id}t`, name: t, type: 'TEXT',
    rect: { x, y: 0, w: 90, h: 18 }, textSnippet: t }] }) as SpecChild;
  const domI = (t: string, x: number): DomChild => ({ kind: 'element', tag: 'article',
    rect: { x, y: 0, w: 100, h: 40 }, children: [{ kind: 'element', tag: 'span',
    rect: { x, y: 0, w: 90, h: 18 }, text: t }] }) as DomChild;
  // typo-carrying fixtures: inst()/domI() above do NOT put SpecTypography/DomTypography on the nested TEXT —
  // collectFigTexts requires kid.text (the typo object) truthy, so in them typography rows are
  // never emitted (neither pass nor warn). Tests checking the movedIdx gate ON typography need
  // fixtures with real typography on both sides — otherwise the gate would have nothing to gate.
  const instT = (id: string, t: string, x: number): SpecChild => ({ id, name: id, type: 'INSTANCE',
    rect: { x, y: 0, w: 100, h: 40 }, children: [{ id: `${id}t`, name: t, type: 'TEXT',
    rect: { x, y: 0, w: 90, h: 18 }, textSnippet: t, text: { fontSize: 14 } }] }) as SpecChild;
  const domIT = (t: string, x: number): DomChild => ({ kind: 'element', tag: 'article',
    rect: { x, y: 0, w: 100, h: 40 }, children: [{ kind: 'element', tag: 'span',
    rect: { x, y: 0, w: 90, h: 18 }, text: t, styles: { fontSize: 14 } }] }) as DomChild;

  it('reordered content → fail children_reorder + map; mis-attribution cleaned: metrics [0]/[2] skipped, [1] alive (spec-test 1; panel: RED relies on the ABSENCE of children_reorder + gap/offset-cross counts — the typography_descent-warn even without the detector would not be a full green)', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [inst('1:1', 'Алый парус', 0), inst('1:2', 'Белый клык', 120), inst('1:3', 'Отверженные', 240)] });
    const d = snap({ rect: { x: 0, y: 0, w: 340, h: 40 },
      children: [domI('Отверженные', 0), domI('Белый клык', 120), domI('Алый парус', 240)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const cr = rows.find((r) => r.prop === 'children_reorder');
    expect(cr?.status).toBe('fail');
    expect(cr?.note).toMatch(/fig\[0\]«Алый парус».*dom\[2\]/);
    expect(cr?.note).toMatch(/fix the order/);
    expect(rows.some((r) => r.prop.startsWith('gap'))).toBe(false);           // all gaps are adjacent to [0]/[2]
    expect(rows.filter((r) => r.prop.startsWith('offset-cross')).map((r) => r.prop))
      .toEqual(['offset-cross[1] 1:2']);                                       // only the non-reordered one
    // mutation "detector not called" → rows all pass without children_reorder (a vacuous green) → RED
  });

  it('two-sided gap skip: a single moved=1 of four → gap[0] AND gap[1] skipped, gap[2] alive (spec-test 2)', () => {
    const s = spec({ rect: { x: 0, y: 0, w: 460, h: 40 }, axis: 'row',
      children: [inst('1:1', 'A1', 0), inst('1:2', 'B2', 120), inst('1:3', 'C3', 240), inst('1:4', 'D4', 360)] });
    const d = snap({ rect: { x: 0, y: 0, w: 460, h: 40 },
      children: [domI('B2', 0), domI('A1', 120), domI('C3', 240), domI('D4', 360)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'children_reorder')).toBe(true);
    const gaps = rows.filter((r) => r.prop.startsWith('gap')).map((r) => r.prop);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/^gap\[2\]/);
    // mutation "one-sided skip (only has(i))" → gap[1] is emitted (the count would match — RED relies
    // on the row-count toHaveLength(1), not on the value; panel clarified) → RED
  });

  it('wrap prefilter: the guard fires before the detector → layout_axis_mismatch first, children_reorder does not reach (spec-test 3)', () => {
    // PANEL FINDING (during implementation): a literal "2-row grid" with a repeating x on the
    // fig side (A1@0/C3@0, B2@120/D4@120, y always 0 in inst()) does NOT give the m3 mutation teeth — the tol-tie
    // gate of the detector (it stays silent on EQUAL main-start neighbors, tieAt) itself mutes any signal
    // regardless of the call order relative to the guard. The invariant "detector strictly after the guard" is really
    // checked by an input where (a) the RAW dom order is non-monotonic by x (the guard must fire first) AND
    // (b) the main-axis-sorted input gives a REAL detectable reorder (otherwise the mutation is a no-op) —
    // the same fig/dom content as test 1 (guaranteed detectable), but dom is given in a shuffled
    // document order: the x sequence 120→0→240 breaks monotonicity on the first step.
    const s = spec({ rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [inst('1:1', 'Алый парус', 0), inst('1:2', 'Белый клык', 120), inst('1:3', 'Отверженные', 240)] });
    const d = snap({ rect: { x: 0, y: 0, w: 340, h: 40 },
      children: [domI('Белый клык', 120), domI('Отверженные', 0), domI('Алый парус', 240)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'layout_axis_mismatch')).toBe(true);
    expect(rows.some((r) => r.prop === 'children_reorder')).toBe(false);
    // mutation "detector ABOVE the monotonicity guard" → after sorting domKids2 this input LITERALLY
    // matches test 1 (a real [0]↔[2] reorder) → the detector would find moved and manage to push
    // the row BEFORE the guard's early-return → RED
  });

  it('muted (longtext sibling) → NO row, metrics as today; correct order → byte-for-byte (spec-tests 5/8)', () => {
    // (a) one domI carries text ≥SNIPPET_CAP chars → the detector is muted (globally for the group) →
    // rows do NOT contain children_reorder; gaps/offset-cross are computed as before (the geometry engine
    // does not touch the content — movedIdx stays undefined, the full set of rows).
    const sMuted = spec({ rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [inst('1:1', 'Алый парус', 0), inst('1:2', 'Белый клык', 120), inst('1:3', 'Отверженные', 240)] });
    const dMuted = snap({ rect: { x: 0, y: 0, w: 340, h: 40 },
      children: [domI('Алый парус', 0), domI('Белый клык', 120), domI('z'.repeat(SNIPPET_CAP), 240)] });
    const mutedRows = diffPair(sMuted, dMuted, { tolerancePx: 1 });
    expect(mutedRows.some((r) => r.prop === 'children_reorder')).toBe(false);
    expect(mutedRows.filter((r) => r.prop.startsWith('gap'))).toHaveLength(2);
    expect(mutedRows.filter((r) => r.prop.startsWith('offset-cross'))).toHaveLength(3);

    // (b) correct order (the same fixtures as test 1, dom NOT reordered) → the detector stays silent (identity
    // bijection, undefined) → NO children_reorder, the full set of gaps/offset-cross — byte-for-byte with the
    // old behavior.
    const sOk = spec({ rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [inst('1:1', 'Алый парус', 0), inst('1:2', 'Белый клык', 120), inst('1:3', 'Отверженные', 240)] });
    const dOk = snap({ rect: { x: 0, y: 0, w: 340, h: 40 },
      children: [domI('Алый парус', 0), domI('Белый клык', 120), domI('Отверженные', 240)] });
    const okRows = diffPair(sOk, dOk, { tolerancePx: 1 });
    expect(okRows.some((r) => r.prop === 'children_reorder')).toBe(false);
    expect(okRows.filter((r) => r.prop.startsWith('gap'))).toHaveLength(2);
    expect(okRows.filter((r) => r.prop.startsWith('offset-cross'))).toHaveLength(3);
  });

  it('typography of a reordered one is skipped via the movedIdx parameter (spec skip-list)', () => {
    // instT/domIT (typography present) — otherwise the gate has nothing to gate (see the comment at the fixtures).
    // The same pattern as test 1: fig[0]/fig[2] reordered by content, fig[1] in place.
    const s = spec({ rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [instT('1:1', 'Алый парус', 0), instT('1:2', 'Белый клык', 120), instT('1:3', 'Отверженные', 240)] });
    const d = snap({ rect: { x: 0, y: 0, w: 340, h: 40 },
      children: [domIT('Отверженные', 0), domIT('Белый клык', 120), domIT('Алый парус', 240)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const t = rows.filter((r) => r.prop.startsWith('typography') || r.prop.startsWith('font-'));
    // Without the movedIdx gate fig[0]/fig[2] would be diffed AGAINST a geometrically-paired (but
    // content-mismatched) dom neighbor → a mis-attributed "possibly a wrong node" warn — the gate
    // clears them entirely (neither pass nor warn), not just hides them from the user.
    expect(t.some((r) => r.prop.includes('1:1') || r.prop.includes('1:3'))).toBe(false);
    expect(t.some((r) => r.prop.includes('1:2'))).toBe(true);
    // mutation "typography-forEach without the movedIdx gate" → 1:1/1:3 appear → RED
  });

  it('PARTIAL bijection: the dom side of the cross position is also skipped (panel-BLOCKER of the union skip)', () => {
    // fig: [Уникальный@0, Дубль@120, Дубль@240] / dom: [Дубль@0, Дубль@120, Уникальный@240] —
    // ONLY «Уникальный» fig[0]→dom[2] is anchored (duplicates are blocked by the phase-0 guard), movedIdx =
    // {0, 2} (union figIdx+domIdx). fig[2] itself is never anchored (duplicate block), but its dom slot
    // (2) carries shifted content via the fig[0] anchor — must be skipped too.
    const s = spec({ rect: { x: 0, y: 0, w: 340, h: 40 }, axis: 'row',
      children: [instT('1:1', 'Уникальный', 0), instT('1:2', 'Дубль', 120), instT('1:3', 'Дубль', 240)] });
    const d = snap({ rect: { x: 0, y: 0, w: 340, h: 40 },
      children: [domIT('Дубль', 0), domIT('Дубль', 120), domIT('Уникальный', 240)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'children_reorder')).toBe(true);
    expect(rows.some((r) => r.prop.startsWith('gap'))).toBe(false); // gap[0](0-1) and gap[1](1-2: has(2)) both skipped
    expect(rows.filter((r) => r.prop.startsWith('offset-cross')).map((r) => r.prop))
      .toEqual(['offset-cross[1] 1:2']);
    const t = rows.filter((r) => r.prop.startsWith('typography') || r.prop.startsWith('font-'));
    expect(t.some((r) => r.prop.includes('1:1') || r.prop.includes('1:3'))).toBe(false);
    // mutation "movedIdx by figIdx only" → dom[2] cross metrics (gap[1]/offset-cross[2]/typography[1:3])
    // are emitted → RED (panel-BLOCKER: a partial bijection leaks on the dom side)
  });

  it('enumeration cap: 7 permutations → 5 + "and 2 more" (spec-test 10)', () => {
    const words = ['Азбука', 'Берег', 'Ветер', 'Гора', 'Дом', 'Ель', 'Жук'];
    const domWords = [1, 2, 3, 4, 5, 6, 0].map((i) => words[i]); // rotate-by-1 — a derangement, no index coincides
    const s = spec({ rect: { x: 0, y: 0, w: 700, h: 40 }, axis: 'row',
      children: words.map((w, i) => inst(`1:${i + 1}`, w, i * 100)) });
    const d = snap({ rect: { x: 0, y: 0, w: 700, h: 40 },
      children: domWords.map((w, i) => domI(w, i * 100)) });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    const cr = rows.find((r) => r.prop === 'children_reorder');
    expect(cr?.status).toBe('fail');
    expect(cr?.note).toMatch(/and 2 more/);
    expect((cr?.note?.match(/fig\[\d+\]/g) ?? []).length).toBe(5);
  });

  // Belt-and-suspenders (low): a real 2D grid (2 rows × 2 columns), content in the CORRECT positions
  // on both sides — the monotonic guard (RAW d.children, doc order) must cut off at the row transition
  // (x: 0→120→0 non-monotonic) BEFORE the reorder detector. A direct GREEN lock against a future weakening
  // of the monotonic guard/tie gate: if it ever slips, a false children_reorder would surface here
  // on a legitimate grid (the detector is content-anchored, blind to "this is just the next row").
  it('a real 2D grid (2 rows, correct positions) → layout_axis_mismatch, the guard holds, NOT a false children_reorder', () => {
    const instXY = (id: string, t: string, x: number, y: number): SpecChild => ({ id, name: id, type: 'INSTANCE',
      rect: { x, y, w: 100, h: 40 }, children: [{ id: `${id}t`, name: t, type: 'TEXT',
      rect: { x, y, w: 90, h: 18 }, textSnippet: t }] }) as SpecChild;
    const domIXY = (t: string, x: number, y: number): DomChild => ({ kind: 'element', tag: 'article',
      rect: { x, y, w: 100, h: 40 }, children: [{ kind: 'element', tag: 'span',
      rect: { x, y, w: 90, h: 18 }, text: t }] }) as DomChild;
    const s = spec({ rect: { x: 0, y: 0, w: 340, h: 100 }, axis: 'row',
      children: [instXY('1:1', 'A', 0, 0), instXY('1:2', 'B', 120, 0), instXY('1:3', 'C', 0, 50), instXY('1:4', 'D', 120, 50)] });
    const d = snap({ rect: { x: 0, y: 0, w: 340, h: 100 },
      children: [domIXY('A', 0, 0), domIXY('B', 120, 0), domIXY('C', 0, 50), domIXY('D', 120, 50)] });
    const rows = diffPair(s, d, { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'layout_axis_mismatch')).toBe(true);
    expect(rows.some((r) => r.prop === 'children_reorder')).toBe(false);
  });
});

describe('diffPair — gradient integration into descriptiveRows (thread D)', () => {
  it('gradient token mismatch surfaces as fail row in full diff', () => {
    const spec = { rect:{x:0,y:0,w:200,h:100},
      gradient: { kind:'linear', angleDeg:90, stops:[{position:0,hex:'#000000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}], whole:{token:'brand'} } } as any;
    const dom = { schema:3, status:'ok', innerWidth:1200, rect:{x:0,y:0,w:200,h:100}, borders:{top:0,right:0,bottom:0,left:0}, scroll:{top:0,left:0}, children:[],
      styles: { gradient: { kind:'linear', angleDeg:90, stops:[{position:0,hex:'#000000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}], whole:{literal:true} } } } as any;
    const rows = diffPair(spec, dom, {} as any);
    expect(rows.some((r: any) => r.prop === 'gradient-token' && r.status === 'fail')).toBe(true);
  });
  it('multi-layer DOM → info row', () => {
    const spec = { rect:{x:0,y:0,w:200,h:100}, gradient: { kind:'linear', angleDeg:90, stops:[{position:0,hex:'#000000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}], whole:{literal:true} } } as any;
    const dom = { schema:3, status:'ok', innerWidth:1200, rect:{x:0,y:0,w:200,h:100}, borders:{top:0,right:0,bottom:0,left:0}, scroll:{top:0,left:0}, children:[],
      styles: { gradient: { kind:'linear', angleDeg:90, multiLayer:true, stops:[{position:0,hex:'#000000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}], whole:{literal:true} } } } as any;
    expect(diffPair(spec, dom, {} as any).some((r: any) => r.prop === 'gradient-layers' && r.status === 'info')).toBe(true);
  });
  it('multi-layer FIGMA (DOM single) → info row (closes the Task4 multiLayer mirror — otherwise the 2nd Figma layer is silently dropped = false-green)', () => {
    const spec = { rect:{x:0,y:0,w:200,h:100}, gradient: { kind:'linear', angleDeg:90, multiLayer:true, stops:[{position:0,hex:'#000000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}], whole:{literal:true} } } as any;
    const dom = { schema:3, status:'ok', innerWidth:1200, rect:{x:0,y:0,w:200,h:100}, borders:{top:0,right:0,bottom:0,left:0}, scroll:{top:0,left:0}, children:[],
      styles: { gradient: { kind:'linear', angleDeg:90, stops:[{position:0,hex:'#000000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}], whole:{literal:true} } } } as any;
    expect(diffPair(spec, dom, {} as any).some((r: any) => r.prop === 'gradient-layers' && r.status === 'info')).toBe(true);
  });
});

describe('paint-style tokenization reaches colorVerdict', () => {
  // Minimal DOM whose backgroundColor MATCHES the Figma fill hex, with a DOM-side background token
  // classification (literal by default) — so the fill row routes through colorVerdict on a hex-match.
  const domFill = (bgToken?: any, bg = '#ff0000') => ({
    schema: 1, status: 'ok', innerWidth: 400, rect: { x: 0, y: 0, w: 100, h: 50 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 },
    styles: { backgroundColor: bg, ...(bgToken ? { backgroundColorToken: bgToken } : {}) },
    children: [],
  });

  it('fill-style NAME × DOM hardcoded literal bg → fill row fail "tokenize" (branch D)', () => {
    // NAME arm: projector set spec.fillToken = {token:'(style: Brand/Primary)', hex}; hex matches DOM bg →
    // branch D fires. DOM classified literal → fail "tokenize".
    const s = { node: { id: '1', name: 'n', type: 'FRAME' }, fillHex: '#ff0000',
      fillToken: { token: '(style: Brand/Primary)', hex: '#ff0000' }, children: [] } as any;
    const fill = diffPair(s, domFill({ literal: true }) as any, { tolerancePx: 1 }).find((r) => r.prop === 'fill');
    expect(fill?.status).toBe('fail');
    expect(fill?.note).toContain('tokenize');
  });

  it('fill-style STATE (no name) × DOM literal hex-match → fill row fail "tokenize" (branch D, unified with NAME)', () => {
    // STATE arm (F1): projector now sets spec.fillToken = {token:'(paint)', hex} (NOT a *StyleTokenized flag).
    // A paint-style hex is mode-independent & reliable → routes through branch D exactly like NAME. hex matches
    // DOM bg + DOM classified literal → fail "tokenize" (NOT the old A2 review softening).
    const s = { node: { id: '1', name: 'n', type: 'FRAME' }, fillHex: '#ff0000',
      fillToken: { token: '(paint)', hex: '#ff0000' }, children: [] } as any;
    const fill = diffPair(s, domFill({ literal: true }) as any, { tolerancePx: 1 }).find((r) => r.prop === 'fill');
    expect(fill?.status).toBe('fail');
    expect(fill?.note).toContain('tokenize');
  });

  it('fill-style STATE (no name) hex DIVERGES from DOM literal → fill row fail "diverged" (branch C — the never-false-green fix)', () => {
    // The exact softening the final review found: a paint-STYLE node whose color GROSSLY DIVERGES (#ff0000 vs
    // #00ff00) was demoted fail→review by the old A2-before-hex gate. Unified STATE routes hex-diverge → branch C
    // → fail. It MUST now fail, not review.
    const s = { node: { id: '1', name: 'n', type: 'FRAME' }, fillHex: '#ff0000',
      fillToken: { token: '(paint)', hex: '#ff0000' }, children: [] } as any;
    const fill = diffPair(s, domFill({ literal: true }, '#00ff00') as any, { tolerancePx: 1 }).find((r) => r.prop === 'fill');
    expect(fill?.status).toBe('fail');
    expect(fill?.note).toContain('diverged');
  });

  it('G2: spec with no style token → fill row status unchanged from today (byte-identical)', () => {
    // regression guard: a plain literal-vs-literal fill with matching hex still passes exactly as before.
    const s = { node: { id: '1', name: 'n', type: 'FRAME' }, fillHex: '#ff0000', children: [] } as any;
    expect(diffPair(s, domFill({ literal: true }) as any, { tolerancePx: 1 }).find((r) => r.prop === 'fill')?.status).toBe('pass');
  });

  it('stroke-style STATE (no name) × DOM literal border → border-color row fail "tokenize" (branch D, unified)', () => {
    const s = { node: { id: '1', name: 'n', type: 'FRAME' }, strokeHex: '#0000ff', strokeWeight: 1,
      strokeToken: { token: '(paint)', hex: '#0000ff' }, children: [] } as any;
    const dom = { schema: 1, status: 'ok', innerWidth: 400, rect: { x: 0, y: 0, w: 100, h: 50 },
      borders: { top: 1, right: 1, bottom: 1, left: 1 },
      borderColors: { top: '#0000ff', right: '#0000ff', bottom: '#0000ff', left: '#0000ff' },
      borderColorsToken: { top: { literal: true }, right: { literal: true }, bottom: { literal: true }, left: { literal: true } },
      scroll: { top: 0, left: 0 }, children: [] } as any;
    const bc = diffPair(s, dom, { tolerancePx: 1 }).find((r) => r.prop === 'border-color');
    expect(bc?.status).toBe('fail');
    expect(bc?.note).toContain('tokenize');
  });

  it('text-color STATE (no name) × DOM literal color → color row fail "tokenize" (branch D, unified)', () => {
    const s = { node: { id: '1', name: 'n', type: 'TEXT' },
      text: { fontSize: 14, colorHex: '#000000', colorToken: { token: '(paint)', hex: '#000000' } }, children: [] } as any;
    const dom = { schema: 1, status: 'ok', innerWidth: 400, rect: { x: 0, y: 0, w: 100, h: 50 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 },
      styles: { color: '#000000', colorToken: { literal: true } },
      children: [{ kind: 'text', rect: { x: 0, y: 0, w: 100, h: 50 }, text: 'x' }] } as any;
    const col = diffPair(s, dom, { tolerancePx: 1 }).find((r) => r.prop === 'color');
    expect(col?.status).toBe('fail');
    expect(col?.note).toContain('tokenize');
  });
});

describe('review rows carry structural token/tokenReason (confirm_token aggregation)', () => {
  const base = { node: { id: '1', name: 'n', type: 'FRAME' }, rect: { x: 0, y: 0, w: 10, h: 10 }, children: [] };
  const dom = (styles: any) => ({ schema: 6, innerWidth: 100, rect: { x: 0, y: 0, w: 10, h: 10 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, children: [], styles });
  const fillRow = (spec: any, d: any) => diffPair(spec as any, d as any, { tolerancePx: 1 }).find((r) => r.prop === 'fill')!;

  it('mode-unconfirmed branch: token = name, tokenReason = mode-unconfirmed; note unchanged', () => {
    const r = fillRow({ ...base, fillHex: '#111111', fillToken: { token: 'bg/level 2', hex: '#111111', mode_dependent: true, mode_source: 'library' } },
      dom({ backgroundColor: '#111111' }));
    expect(r.status).toBe('review');
    expect(r.token).toBe('bg/level 2');
    expect(r.tokenReason).toBe('mode-unconfirmed');
    expect(r.note).toContain("the node's mode is not confirmed"); // byte-for-byte unchanged
  });
  it('bound-unresolved branch (:1008): token ABSENT, tokenReason = bound-unresolved', () => {
    const r = fillRow({ ...base, fillHex: '#111111', fillBoundVar: 'VariableID:x/1:2' }, dom({ backgroundColor: '#111111' }));
    expect(r.status).toBe('review');
    expect(r.token).toBeUndefined();
    expect(r.tokenReason).toBe('bound-unresolved');
  });
  it('fig-unresolved branch (:1004) — the ONLY live path: typography color (the fill gate :1112 does not reach it)', () => {
    // PANEL HIGH: via fill the branch is unreachable (gate if (spec.fillHex)); NO if (r) — a vacuum is forbidden.
    const spec = { ...base, text: { fontSize: 16, fontFamily: 'Inter', colorHex: undefined } };
    const d = dom({ color: '#111111', fontSize: 16, fontFamily: 'Inter' });
    // p.7 migration: the root carrier routing needs the node to own its text
    (d as any).children = [{ kind: 'text', rect: { x: 0, y: 0, w: 10, h: 10 }, text: 'x' }];
    const r = diffPair(spec as any, d as any, { tolerancePx: 1 }).find((x) => x.prop === 'color')!;
    expect(r.status).toBe('review');
    expect(r.tokenReason).toBe('fig-unresolved');
    expect(r.token).toBeUndefined();
    expect(r.note).toBe('Figma color not resolved — the token cannot be checked'); // byte-for-byte
  });
  it('snapshot-default branch: token present, tokenReason = snapshot-default', () => {
    const r = fillRow({ ...base, fillHex: '#111111', fillToken: { token: 'bg/x', hex: '#111111', snapshot_default: true } },
      dom({ backgroundColor: '#111111' }));
    expect(r.token).toBe('bg/x');
    expect(r.tokenReason).toBe('snapshot-default');
  });
  it('D-unknown branch: tokenReason = the open code from dt.unknown (inherited)', () => {
    const r = fillRow({ ...base, fillHex: '#111111', fillToken: { token: 'bg/x', hex: '#111111' } },
      dom({ backgroundColor: '#111111', backgroundColorToken: { unknown: 'inherited' } }));
    expect(r.token).toBe('bg/x');
    expect(r.tokenReason).toBe('inherited');
  });
  it('semantic-confirm branch: both from a token', () => {
    const r = fillRow({ ...base, fillHex: '#111111', fillToken: { token: 'bg/x', hex: '#111111' } },
      dom({ backgroundColor: '#111111', backgroundColorToken: { token: '--bg-x' } }));
    expect(r.token).toBe('bg/x');
    expect(r.tokenReason).toBe('semantic-confirm');
  });
  it('NON-review rows do not carry token/tokenReason (pass/fail/info)', () => {
    const pass = fillRow({ ...base, fillHex: '#111111' }, dom({ backgroundColor: '#111111' }));
    expect(pass.status).toBe('pass');
    expect(pass.token).toBeUndefined();
    expect((pass as any).tokenReason).toBeUndefined();
  });
});

describe('component identity: identity tokens + honest floors (p.0–p.3b)', () => {
  const specC = (component: any) => ({ node: { id: '1', name: 'n', type: 'FRAME' }, component, children: [] });
  const domC = (componentHints: any) => ({ schema: 1, innerWidth: 400, rect: { x: 0, y: 0, w: 100, h: 50 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, children: [],
    ...(componentHints !== undefined ? { componentHints } : {}) });
  const compRow = (spec: any, dom: any, opts: any = { tolerancePx: 1 }) =>
    diffPair(spec as any, dom as any, opts).find((r) => r.prop === 'component')!;
  const hints = (classList: string[], data: Record<string, string> = {}) => ({ tag: 'div', classList, data });

  // p.0 false-PASS: prop tokens do not match
  it('p.0: setName empty, name prop-only, DOM class active-badge → NOT pass (was a false matched by active)', () => {
    const r = compRow(specC({ id: 'c1', name: 'type=active, size=Big' }), domC(hints(['active-badge'])));
    expect(r.status).not.toBe('pass');
    expect(r.status).toBe('info'); // p.3b: variant props without a component set
    expect(r.note).toContain('variant props');
    expect(r.note).toContain('expected_component');
  });
  it('scope p.0: setName PRESENT → match by set identity (derived pair list+item), NOT by the prop token basic', () => {
    const r = compRow(specC({ id: 'c1', setName: 'listItem', name: 'Type=Basic' }), domC(hints(['ds-list-item_basic'])));
    expect(r.status).toBe('pass');
    expect(r.note).not.toContain('"basic"'); // anti-regression: props did not return to the match
  });
  it('control: setName Tag × class tag-chip → pass by the identity token', () => {
    const r = compRow(specC({ id: 'c1', setName: 'Tag', name: 'type=active' }), domC(hints(['tag-chip'])));
    expect(r.status).toBe('pass');
    expect(r.note).toContain('"tag"');
  });
  // p.1
  it('p.1: hints undefined → info with a note about componentHints', () => {
    const r = compRow(specC({ id: 'c1', setName: 'Tag' }), domC(undefined));
    expect(r.status).toBe('info');
    expect(r.note).toContain('componentHints');
    expect(r.note).toContain('expected_component');
  });
  // p.2
  it('p.2: domTokens empty (CSS-modules strip) → info, the ambiguity is named', () => {
    const r = compRow(specC({ id: 'c1', setName: 'Tag' }), domC({ tag: 'a', classList: ['x'], data: {} }));
    expect(r.status).toBe('info');
    expect(r.note).toContain('not used here at all');
    expect(r.note).toContain('expected_component');
  });
  it('control p.2: a partial signal card_x7f3a → warn path (the token card is alive)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'Banner' }), domC(hints(['card_x7f3a'])));
    expect(r.status).toBe('warn');
  });
  // p.3a
  it('p.3a: setUnresolved → info with a "did not resolve" note (not the mis-attribution "no set")', () => {
    const r = compRow(specC({ id: 'c1', name: 'type=active', setUnresolved: true }), domC(hints(['btn-primary'])));
    expect(r.status).toBe('info');
    expect(r.note).toContain('did not resolve');
    expect(r.note).toContain('expected_component');
  });
  it('p.3a takes priority over p.2: setUnresolved + empty domTokens → the non-resolve note (the Figma-side cause is more precise)', () => {
    const r = compRow(specC({ id: 'c1', name: 'type=active', setUnresolved: true }), domC({ tag: 'a', classList: [], data: {} }));
    expect(r.status).toBe('info');
    expect(r.note).toContain('did not resolve');
  });
  // F3 (final-review): a MUTATION LOCK of the p.1 → p.3a order. Both signals are signal-less SIMULTANEOUSLY
  // (DOM without componentHints AND a Figma-side setUnresolved) — the existing locks p.1 (:2528, without
  // setUnresolved) and p.3a (:2546, hints PRESENT) each hold only one branch at a time, so swapping
  // the two `else if` is invisible to them. Here both are true: the correct order yields p.1 (the DOM side
  // is signal-less by construction — it addresses what to fix more precisely). Mutation "p.3a over p.1" → the note
  // "did not resolve" instead of "componentHints" → RED.
  it('p.1 takes priority over p.3a: hints undefined + setUnresolved → the componentHints note (the DOM side is signal-less by construction)', () => {
    const r = compRow(specC({ id: 'c1', name: 'x', setUnresolved: true }), domC(undefined));
    expect(r.status).toBe('info');
    expect(r.note).toContain('componentHints');
    expect(r.note).not.toContain('did not resolve');
  });
  // a Cyrillic RESOLVED setName: tokens() is Latin-only → no identity tokens, but the set IS present
  it('a Cyrillic resolved setName → info with an honest note (NOT "no component set" and NOT "did not resolve" — mis-attribution #74)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'баннер подписки', name: 'тип=активный' }), domC(hints(['banner-root'])));
    expect(r.status).toBe('info');
    expect(r.note).toContain('yields no tokens');
    expect(r.note).not.toContain('variant props');
    expect(r.note).not.toContain('did not resolve');
    expect(r.note).toContain('expected_component');
  });
  // p.3b: separate notes
  it('p.3b a short/numeric name without a set → info with a note about tokens (NOT "variant props")', () => {
    const r = compRow(specC({ id: 'c1', name: 'ok' }), domC(hints(['btn-primary'])));
    expect(r.status).toBe('info');
    expect(r.note).toContain('yields no tokens');
    expect(r.note).not.toContain('variant props');
    expect(r.note).toContain('expected_component'); // spec test-9
  });
  // prop-only detection: Unicode/trim
  it('prop-only: space after a comma / Cyrillic / space in the value → info; a mixed name → warn path', () => {
    expect(compRow(specC({ id: 'c1', name: 'Type=Active, Size=Big' }), domC(hints(['zzz-yyy']))).status).toBe('info');
    expect(compRow(specC({ id: 'c1', name: 'type=Активная, size=Большой' }), domC(hints(['zzz-yyy']))).status).toBe('info');
    expect(compRow(specC({ id: 'c1', name: 'State=on hover' }), domC(hints(['zzz-yyy']))).status).toBe('info');
    expect(compRow(specC({ id: 'c1', name: 'Primary, size=Big' }), domC(hints(['zzz-yyy']))).status).toBe('warn'); // a segment without '=' → not prop-only
  });
  // expected_component byte-for-byte
  it('expected_component: substring match → pass; hints undefined + expected → the prior warn (the floor does not intercept)', () => {
    const ok = compRow(specC({ id: 'c1', name: 'x' }), domC(hints(['banner-root'])), { tolerancePx: 1, expectedComponent: 'banner' });
    expect(ok.status).toBe('pass');
    const miss = compRow(specC({ id: 'c1', name: 'x' }), domC(undefined), { tolerancePx: 1, expectedComponent: 'banner' });
    expect(miss.status).toBe('warn');
    expect(miss.note).toContain('substring');
  });
  // F2 (final-review): a MUTATION LOCK of expected_component's priority over the remediation floors.
  // The existing lock :2582 holds the pair (expected + hints undefined) → warn, but setUnresolved is not there,
  // so the mutation "the setUnresolved branch raised ABOVE expected" is invisible to it (setUnresolved falsy →
  // the branch does not fire). Here setUnresolved AND expected are simultaneous: an explicit name from the user
  // must intercept the substring remediation (pass), NOT sink into info "did not resolve".
  // Mutation "setUnresolved over expected" → status info + the non-resolve note → RED on both asserts.
  it('expected_component beats the floors: setUnresolved + expected → substring pass (the remediation is not intercepted)', () => {
    const r = compRow(specC({ id: 'c1', name: 'x', setUnresolved: true }), domC(hints(['banner-root'])), { tolerancePx: 1, expectedComponent: 'banner' });
    expect(r.status).toBe('pass');
    expect(r.note).toContain('substring');
  });
  it('spec test-9: ALL info paths carry expected_component in the note (param check)', () => {
    const infoRows = [
      compRow(specC({ id: 'c1', setName: 'Tag' }), domC(undefined)),                                        // p.1
      compRow(specC({ id: 'c1', setName: 'Tag' }), domC({ tag: 'a', classList: ['x'], data: {} })),          // p.2
      compRow(specC({ id: 'c1', name: 'type=active', setUnresolved: true }), domC(hints(['btn-primary']))),  // p.3a
      compRow(specC({ id: 'c1', name: 'type=active, size=Big' }), domC(hints(['active-badge']))),            // p.3b prop-only
      compRow(specC({ id: 'c1', name: 'ok' }), domC(hints(['btn-primary']))),                                // p.3b tokens
      compRow(specC({ id: 'c1', setName: 'баннер подписки', name: 'тип=активный' }), domC(hints(['banner-root']))), // Cyrillic
    ];
    for (const r of infoRows) {
      expect(r.status).toBe('info');
      expect(r.note).toContain('expected_component');
    }
  });

  // ── identity-tokenizer ──
  it('false-PASS killed with a LIVE set: a prop-value token does not match', () => {
    const r = compRow(specC({ id: 'c1', setName: 'Tag', name: 'type=active' }), domC(hints(['active-badge'])));
    expect(r.status).toBe('warn');
    expect(r.note).toContain('variant props excluded from the match');
  });
  it('control: the same set × .tag-chip → pass by base "tag"', () => {
    const r = compRow(specC({ id: 'c1', setName: 'Tag', name: 'type=active' }), domC(hints(['tag-chip'])));
    expect(r.status).toBe('pass');
    expect(r.note).toContain('"tag"');
  });
  it('camelCase↔kebab: listItem × ds-list-item → pass by the derived pair list+item', () => {
    const r = compRow(specC({ id: 'c1', setName: 'listItem' }), domC(hints(['ds-list-item'])));
    expect(r.status).toBe('pass');
    expect(r.note).toContain('"list"');
    expect(r.note).toContain('"item"');
  });
  it('the solid form is alive: listItem × class listitem_x7f3a → pass by base "listitem"', () => {
    const r = compRow(specC({ id: 'c1', setName: 'listItem' }), domC(hints(['listitem_x7f3a'])));
    expect(r.status).toBe('pass');
    expect(r.note).toContain('"listitem"');
  });
  it('co-occurrence gate: a single derived generic does NOT go green (listItem × ul.list → warn)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'listItem' }), domC({ tag: 'ul', classList: ['list'], data: {} }));
    expect(r.status).toBe('warn');
  });
  it('co-occurrence gate: DivWrapper × a bare div → warn (a tag does not go green alone)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'DivWrapper' }), domC({ tag: 'div', classList: [], data: {} }));
    expect(r.status).toBe('warn');
  });
  it('co-occurrence per-source: NavBar × class nav-bar → pass (both derived from ONE source)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'NavBar' }), domC({ tag: 'div', classList: ['nav-bar'], data: {} }));
    expect(r.status).toBe('pass');
  });
  it('the pool bypass is closed: ListItem × ["shopping-list","product-item"] → warn (derived from DIFFERENT classes do not sum)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'ListItem' }), domC(hints(['shopping-list', 'product-item'])));
    expect(r.status).toBe('warn');
  });
  it('per-source stricter: NavBar × <nav class="bar"> → warn (tag+a foreign class — not the name structure)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'NavBar' }), domC({ tag: 'nav', classList: ['bar'], data: {} }));
    expect(r.status).toBe('warn');
  });
  it('prop-detection charset: State=On/Off / Size=1.5x / Type=Active, (trailing comma) → info "variant props"', () => {
    for (const name of ['State=On/Off', 'Size=1.5x', 'Type=Active,']) {
      const r = compRow(specC({ id: 'c1', name }), domC(hints(['zzz-yyy'])));
      expect(r.status).toBe('info');
      expect(r.note).toContain('variant props');
    }
  });
  it('degenerate =x / foo= — NOT prop segments → go into identity/tokens', () => {
    const r = compRow(specC({ id: 'c1', name: 'foo=' }), domC(hints(['foo-box'])));
    expect(r.status).toBe('pass'); // tokens('foo=') → ['foo'] base — matches
    const r2 = compRow(specC({ id: 'c1', name: '=x' }), domC(hints(['zzz-yyy'])));
    expect(r2.status).toBe('info'); // not a prop segment, but no tokens → "short/numeric"
    expect(r2.note).toContain('yields no tokens');
  });
  it('per-segment: Primary, size=Big × .primary-btn → pass by "primary" (the prop segment is dropped)', () => {
    const r = compRow(specC({ id: 'c1', name: 'Primary, size=Big' }), domC(hints(['primary-btn'])));
    expect(r.status).toBe('pass');
    expect(r.note).toContain('"primary"');
  });
  it('domTokens symmetry: Banner × camelCase class bannerRoot → pass by base "banner"', () => {
    const r = compRow(specC({ id: 'c1', setName: 'Banner' }), domC(hints(['bannerRoot'])));
    expect(r.status).toBe('pass');
    expect(r.note).toContain('"banner"');
  });
  it('a Cyrillic set does not regress: identity empty → the same info note "yields no tokens"', () => {
    const r = compRow(specC({ id: 'c1', setName: 'баннер подписки', name: 'тип=активный' }), domC(hints(['banner-root'])));
    expect(r.status).toBe('info');
    expect(r.note).toContain('yields no tokens');
  });
  // F1 (final-review, MEDIUM false-PASS): data attributes are free text (test-ids, analytics
  // labels). The phrase data-testid="add shopping list item" contains the generic stems 'list'+'item' as
  // WORDS → co-occurrence "within one source" would be satisfied WITHOUT a structural name meaning →
  // a false PASS (before the branch it was an honest warn — a regression). Fix: derived co-occurrence sources =
  // ONLY tag + classList (structural names); data values STAY in the flat domTokens (the base hit
  // is alive, lock below). Mutation "data returned into domSources" → PASS instead of warn → RED.
  it('F1: ListItem × div.product-tile[data-testid="add shopping list item"] → warn (a data phrase is NOT a co-occurrence source)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'ListItem' }),
      domC({ tag: 'div', classList: ['product-tile'], data: { testid: 'add shopping list item' } }));
    expect(r.status).toBe('warn');
  });
  // F1 control: a base hit THROUGH data is alive (data values stay in the flat domTokens). Mutation
  // "data crossed out of domTokens too" → base 'banner' not found → warn → RED.
  it('F1 control: Banner × div[data-component="Banner"] → pass by base "banner" (data tokens alive in domTokens)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'Banner' }),
      domC({ tag: 'div', classList: [], data: { component: 'Banner' } }));
    expect(r.status).toBe('pass');
    expect(r.note).toContain('"banner"');
  });
  // F2 (final-review, LOW-MED): the `>= 2` threshold inside domSources.find(...). The sources are arranged so
  // that the INSUFFICIENT one ('list-thing' yields only 'list') comes BEFORE the sufficient one ('list-item' yields
  // 'list'+'item'). With the correct `>= 2` find skips the insufficient one → takes 'list-item' → pass.
  // Mutation `>= 1`: find grabs the FIRST 1-hit one ('list-thing') → derivedShared=['list'] →
  // downstream `>= 2` demotes to warn → RED (the false-WARN miss is caught).
  it('F2 threshold >=2: listItem × [list-thing, list-item] → pass (the insufficient source BEFORE the sufficient one)', () => {
    const r = compRow(specC({ id: 'c1', setName: 'listItem' }), domC(hints(['list-thing', 'list-item'])));
    expect(r.status).toBe('pass');
    expect(r.note).toContain('"list"');
    expect(r.note).toContain('"item"');
  });
});

describe('style anchor (v5): style axes are read from the carrier through transparent wrappers', () => {
  const bannerChild = (over: any = {}) => ({ kind: 'element', tag: 'div',
    classList: ['preference-questionnaire-banner'], rect: { x: 0, y: 0, w: 1280, h: 148 },
    styles: { borderRadius: 24, gradient: { kind: 'conic', stops: [], whole: { literal: true } } },
    data: { component: 'Banner' }, children: [], ...over });
  const wrapPair = (childOver: any = {}, rootOver: any = {}) => ({
    schema: 6, innerWidth: 1920, rect: { x: 0, y: 0, w: 1280, h: 148 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 },
    children: [bannerChild(childOver)], ...rootOver });
  // rect added to the verbatim brief: without spec.rect the geometry gate (:250 'no bbox') suppresses
  // the size rows, and the 'size.w' test would get no row. Matches the DOM root (1280×148) →
  // size.w pass, dom 1280 = 'the root's rect'. The only fixture change relative to the brief.
  const bannerSpec = (over: any = {}) => ({ node: { id: '1', name: 'banner_recs', type: 'INSTANCE' },
    rect: { x: 0, y: 0, w: 1280, h: 148 },
    cornerRadius: 24, component: { id: 'c1', setName: 'banner_recs', name: 'size=wide-desk' },
    children: [], ...over });
  const row = (rows: any[], p: string) => rows.find((r) => r.prop === p);

  it('live case: radius/gradient/component read from the carrier child; the style_anchor row is present', () => {
    const rows = diffPair(bannerSpec({ gradient: { kind: 'conic', stops: [], whole: { literal: true } } }) as any, wrapPair() as any, { tolerancePx: 1 });
    expect(row(rows, 'corner-radius')?.status).toBe('pass');   // 24/24 — the artifact fail is dead
    expect(row(rows, 'corner-radius')?.dom).toBe(24);
    expect(row(rows, 'style_anchor')?.status).toBe('pass');
    expect(row(rows, 'style_anchor')?.dom).toContain('preference-questionnaire-banner');
    expect(row(rows, 'component')?.status).toBe('pass');       // 'banner' from the child's classes
  });
  it('a wrapper with an opaque bg → NOT transparent: the anchor is not active, no style_anchor', () => {
    const rows = diffPair(bannerSpec() as any,
      wrapPair({}, { styles: { backgroundColor: '#ffffff' } }) as any, { tolerancePx: 1 });
    expect(row(rows, 'style_anchor')).toBeUndefined();
  });
  it('an inset child (1272 in 1280) → not transparent → no descent', () => {
    const rows = diffPair(bannerSpec() as any,
      wrapPair({ rect: { x: 4, y: 0, w: 1272, h: 148 } }) as any, { tolerancePx: 1 });
    expect(row(rows, 'style_anchor')).toBeUndefined();
  });
  it('a wrapper opacity<1 → NOT transparent (darkening — a carrier): no descent, opacity is checked against the wrapper', () => {
    const rows = diffPair(bannerSpec({ opacity: 1 }) as any,
      wrapPair({}, { styles: { opacity: 0.5 } }) as any, { tolerancePx: 1 });
    expect(row(rows, 'style_anchor')).toBeUndefined();
    expect(row(rows, 'opacity')?.status).toBe('fail'); // 1 vs 0.5 — not masked
  });
  it('a dom-only gradient of the anchor without spec.gradient → the gradient row surfaced (gate on sGradient)', () => {
    const rows = diffPair(bannerSpec() as any, wrapPair() as any, { tolerancePx: 1 });
    expect(rows.some((r) => r.prop.startsWith('gradient'))).toBe(true);
  });
  it('2 children / a text child / childrenTruncated → not transparent', () => {
    const two = wrapPair(); (two.children as any[]).push({ kind: 'element', tag: 'i', rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(row(diffPair(bannerSpec() as any, two as any, { tolerancePx: 1 }), 'style_anchor')).toBeUndefined();
    const txt = wrapPair({ kind: 'text' });
    expect(row(diffPair(bannerSpec() as any, txt as any, { tolerancePx: 1 }), 'style_anchor')).toBeUndefined();
    const trunc = wrapPair({}, { childrenTruncated: true });
    expect(row(diffPair(bannerSpec() as any, trunc as any, { tolerancePx: 1 }), 'style_anchor')).toBeUndefined();
  });
  it('a chain of 2 transparent → anchor at depth 2; an intermediate with gradient → stop on it', () => {
    const deep = wrapPair({ styles: {}, data: undefined, classList: ['mid'],
      children: [bannerChild()] });
    const rows = diffPair(bannerSpec() as any, deep as any, { tolerancePx: 1 });
    expect(row(rows, 'corner-radius')?.status).toBe('pass');
    expect(row(rows, 'style_anchor')?.dom).toMatch(/mid.*preference/);
    const midStyled = wrapPair({ styles: { gradient: { kind: 'linear', stops: [], whole: { literal: true } } },
      classList: ['mid'], children: [bannerChild()] });
    const rows2 = diffPair(bannerSpec() as any, midStyled as any, { tolerancePx: 1 });
    expect(row(rows2, 'style_anchor')?.dom).toContain('mid'); // anchor = mid (the gradient carrier), not deeper
  });
  it('schema gate: schema 4 → no descent (unit directly into diffPair, bypassing the handler)', () => {
    const v4 = { ...wrapPair(), schema: 4 };
    expect(row(diffPair(bannerSpec() as any, v4 as any, { tolerancePx: 1 }), 'style_anchor')).toBeUndefined();
  });
  it('no disappearances: an anchor without a radius field → corner-radius fail 24 vs 0', () => {
    const rows = diffPair(bannerSpec() as any, wrapPair({ styles: {} }) as any, { tolerancePx: 1 });
    const r = row(rows, 'corner-radius');
    expect(r?.status).toBe('fail');
    expect(r?.dom).toBe(0);
  });
  it('6bis: opacity per-axis default = 1 (not 0!): spec 0.5 + an anchor without opacity → fail 0.5 vs 1', () => {
    const rows = diffPair(bannerSpec({ opacity: 0.5 }) as any, wrapPair({ styles: {} }) as any, { tolerancePx: 1 });
    const r = row(rows, 'opacity');
    expect(r?.status).toBe('fail');
    expect(r?.dom).toBe(1);
  });
  it('geometry and justify — from the root: an active anchor does not change the size rows', () => {
    const rows = diffPair(bannerSpec() as any, wrapPair() as any, { tolerancePx: 1 });
    expect(row(rows, 'size.w')?.dom).toBe(1280); // the root's rect, not the anchor's
  });
  it('component: the child data-component="Banner" gives a base hit banner', () => {
    const rows = diffPair(bannerSpec() as any, wrapPair({ classList: ['x'] }) as any, { tolerancePx: 1 });
    expect(row(rows, 'component')?.status).toBe('pass');
    expect(row(rows, 'component')?.note).toContain('"banner"');
  });
  it('coverage: style_anchor not in measured/skipped', () => {
    const rows = diffPair(bannerSpec() as any, wrapPair() as any, { tolerancePx: 1 });
    const cov = deriveCoverage(rows);
    expect(cov.measured).not.toContain('style_anchor');
    expect(cov.skipped.map((s: any) => s.dim)).not.toContain('style_anchor');
  });

  // lock #1: the anchor carries gradient, the ROOT does not (wrapPair without
  // styles), spec.gradient MATCHES the anchor's (kind/stops/whole) → gradientVerdict must receive
  // arg2 = sGradient (the anchor), not d.styles?.gradient (the root) — otherwise (mutation "arg2 = d.styles?.gradient")
  // domG would be read as undefined (the root is empty), and gradientVerdict would collapse the match into
  // a fig-only warn/fail (the 'gradient' row "the background may be on another element") instead of an honest pass.
  it('lock arg2 gradientVerdict: the anchor carries gradient, the root does not, spec.gradient matches the anchor → no gradient-fail/warn', () => {
    const rows = diffPair(
      bannerSpec({ gradient: { kind: 'conic', stops: [], whole: { literal: true } } }) as any,
      wrapPair() as any,
      { tolerancePx: 1 },
    );
    expect(row(rows, 'style_anchor')?.status).toBe('pass'); // the anchor is active — sGradient read from the child
    // the generic 'gradient' fig-only/dom-only stub must NOT appear — both are present and checked
    expect(rows.some((r) => r.prop === 'gradient')).toBe(false);
    expect(row(rows, 'gradient-token')?.status).toBe('pass');
    expect(rows.filter((r) => r.prop.startsWith('gradient')).some((r) => r.status === 'fail')).toBe(false);
  });

  // lock #2: the anchor is same-size (required for activity), but spec.rect
  // is out of sync with the DOM root (1275 vs 1280) — size.w must be read FROM THE ROOT (d.rect, geometryRows
  // does not know about the anchor) even with an active style_anchor. anchor.rect is always ≡ root.rect (same-size — part
  // of the transparentChild gate), so the dom value 1280 proves "geometry from the root", not a random
  // coincidence — the Figma side deliberately diverges (1275) so the fail is visible and drives the fig/dom pair.
  it('rect desync: an active anchor does not confuse the geometry — size.w read FROM THE ROOT (fig 1275 vs dom 1280 → fail)', () => {
    const spec = bannerSpec({ rect: { x: 0, y: 0, w: 1275, h: 148 } });
    const rows = diffPair(spec as any, wrapPair() as any, { tolerancePx: 1 });
    expect(row(rows, 'style_anchor')?.status).toBe('pass');
    const sw = row(rows, 'size.w');
    expect(sw?.status).toBe('fail');
    expect(sw?.figma).toBe(1275);
    expect(sw?.dom).toBe(1280); // the root's d.rect.w — not the anchor's (both would match numerically, but the semantics is "from the root")
  });

  // F1 (final-review): the same-size gate is an HONESTY GATE, not a metric. The user's tolerancePx
  // (up to 10) must NOT weaken it: styleAnchor is called with Math.min(tol,1). A child inset by up to 8px
  // under tol=10 would otherwise be "transparent" → the wrapper's style (radius 0) is masked by the child's (radius 24).
  it('F1: tol=10 + an inset child (1272 in 1280, radius 24) + wrapper radius 0 → NO descent, corner-radius fail 24 vs 0', () => {
    const dom = wrapPair({ rect: { x: 4, y: 0, w: 1272, h: 148 } }, { styles: { borderRadius: 0 } });
    const rows = diffPair(bannerSpec() as any, dom as any, { tolerancePx: 10 });
    expect(row(rows, 'style_anchor')).toBeUndefined();
    const r = row(rows, 'corner-radius');
    expect(r?.status).toBe('fail');
    expect(r?.figma).toBe(24);
    expect(r?.dom).toBe(0);
  });

  // F2 (final-review): a raster bgImage:true on the WRAPPER → not transparent (a real visible background,
  // invisible to the gradient detector) — a descent through it would mask the wrapper's background.
  it('F2: a wrapper with bgImage:true → NOT transparent, no descent', () => {
    const dom = wrapPair({}, { styles: { bgImage: true } });
    expect(row(diffPair(bannerSpec() as any, dom as any, { tolerancePx: 1 }), 'style_anchor')).toBeUndefined();
  });

  // F4 (final-review): schema undefined was NOT covered by `d.schema < 5` (undefined<5 === false) → a descent
  // on a non-v5 snapshot, where the compact "no field = no style" semantics is not guaranteed. Fix: !(schema>=5).
  it('F4: a snapshot without schema → no descent (the guard let undefined through)', () => {
    const dom: any = { ...wrapPair(), schema: undefined };
    expect(row(diffPair(bannerSpec() as any, dom as any, { tolerancePx: 1 }), 'style_anchor')).toBeUndefined();
  });

  // F5 (final-review): cap-out MAX_STYLE_DESCENT — after 3 steps cur may STILL be a transparent
  // wrapper (the carrier is deeper than the chain) → false-red + a lying note "read from the carrier". Post-check:
  // if transparentChild(cur) still returns a child → the anchor is NOT activated (return undefined).
  it('F5: 4 nested transparent + the carrier at depth 4 → no style_anchor (the cap-out is honest)', () => {
    const twrap = (kids: any[], cls: string) => ({ kind: 'element', tag: 'div', classList: [cls],
      rect: { x: 0, y: 0, w: 1280, h: 148 }, styles: {}, children: kids });
    const dom = wrapPair({ styles: {}, data: undefined, classList: ['w1'],
      children: [twrap([twrap([bannerChild()], 'w3')], 'w2')] });
    expect(row(diffPair(bannerSpec() as any, dom as any, { tolerancePx: 1 }), 'style_anchor')).toBeUndefined();
  });

  // F6 (final-review): the style_anchor row is emitted ONLY with ≥1 Figma style axis — otherwise the note
  // "axes read" without a single comparison (a nit about nothing). The anchor is active (the wrapper is transparent), but the spec is empty.
  it('F6: a spec without style axes + a transparent wrapper → no style_anchor row', () => {
    const bareSpec = { node: { id: '1', name: 'x', type: 'FRAME' }, rect: { x: 0, y: 0, w: 1280, h: 148 }, children: [] };
    expect(row(diffPair(bareSpec as any, wrapPair() as any, { tolerancePx: 1 }), 'style_anchor')).toBeUndefined();
  });
});

// =================================================================================================
// D7 -- THE INVARIANT, stated once and verbatim:
//   a DOM radius that is not one comparable px number does not return `status: "pass"` against a
//   Figma radius.
//
// It started as "an asymmetric DOM radius" and had to widen twice, both times because a measurement
// found another input reaching `pass` with nothing asymmetric about it: an h/v pair (`8px / 4px`,
// four identical corners, an 8-by-4 ELLIPSE passing a Figma 8 that describes a circle) and a
// percentage (`50%` on a 300x40 box, real corners 150px and 20px, passing a Figma 50). The stable
// statement is about what Figma can be compared against -- one px number -- not about symmetry.
//
// WHY NOT A FAIL, AND WHY NOT AN OMISSION. The Figma side carries ONE px `cornerRadius`, so there is
// nothing on its side to compare a per-corner, percentage or elliptical radius against: a fail would
// be an alarm about a difference nobody measured. And dropping the row is not neutral either -- an
// absent row makes the pair clean with no trace, and a reader cannot tell "measured and fine" from
// "not present", which is the same false green wearing a different coat (docs/coverage.md's headline
// promise is that a green verdict never includes what was not measured). `unchecked` is the third
// status this project keeps for exactly this: measured enough to know we cannot judge it, and a
// human must look.
// =================================================================================================
describe('D7: a DOM radius that is not one comparable px number never passes against a Figma radius', () => {
  const row = (rows: any[], p: string) => rows.find((r) => r.prop === p);
  const radiusSpec = { node: { id: '1:1', name: 'card', type: 'FRAME' },
    rect: { x: 0, y: 0, w: 100, h: 40 }, cornerRadius: 8, children: [] };
  const flatDom = (styles: any, over: any = {}) => ({ schema: DOM_SNAPSHOT_SCHEMA_VERSION, status: 'ok',
    innerWidth: 400, rect: { x: 0, y: 0, w: 100, h: 40 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 },
    children: [], styles, ...over });

  it('the flag alone (what the extractor emits): an unchecked corner-radius row, not a silent omission', () => {
    const rows = diffPair(radiusSpec as any, flatDom({ borderRadiusUncomparable: true }) as any, { tolerancePx: 1 });
    const r = row(rows, 'corner-radius');
    expect(r, 'no corner-radius row at all: an omitted row is a false green of its own').toBeDefined();
    expect(r.status).toBe('unchecked');
    expect(r.figma).toBe(8);
    expect(r.dom).toBeNull();
    expect(r.note).toContain('not one comparable px number');
  });

  it('a uniform radius is untouched: 8 vs 8 still passes, 8 vs 4 still fails', () => {
    // The control the fix must not cost: the overwhelmingly common uniform case keeps its verdict.
    expect(row(diffPair(radiusSpec as any, flatDom({ borderRadius: 8 }) as any, { tolerancePx: 1 }), 'corner-radius').status).toBe('pass');
    expect(row(diffPair(radiusSpec as any, flatDom({ borderRadius: 4 }) as any, { tolerancePx: 1 }), 'corner-radius').status).toBe('fail');
  });

  it('flag AND number together: the flag wins, exactly one row, and it is not a pass', () => {
    // The pre-fix extractor emitted `borderRadius: 8` for `border-radius: 8px 0 0 0` -- the number is
    // a lie the flag corrects, so the branch order (uncomparable BEFORE numRow, no fallthrough) is
    // itself the invariant. Written as a lock, not as a shape that can occur in a live capture.
    const rows = diffPair(radiusSpec as any, flatDom({ borderRadius: 8, borderRadiusUncomparable: true }) as any, { tolerancePx: 1 });
    const all = rows.filter((r) => r.prop === 'corner-radius');
    expect(all, `corner-radius rows: ${JSON.stringify(all)}`).toHaveLength(1);
    expect(all[0].status, `the corner-radius row was ${JSON.stringify(all[0])}`).not.toBe('pass');
  });

  it('the unchecked row routes to resolve_skip -- raising max_depth fixes no border radius', () => {
    const rows = diffPair(radiusSpec as any, flatDom({ borderRadiusUncomparable: true }) as any, { tolerancePx: 1 });
    const v = buildVerification([{ node_id: '1:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) }],
      { depthLevels: 4 });
    expect(v.complete).toBe(false);
    // Addressed by DETAIL, not by kind alone: `resolve_skip` is a busy bucket, and a blocking item
    // that happens to be there for another reason would make this assertion true about nothing.
    const mine = v.blocking.filter((b: any) => String(b.detail).includes('not one comparable px number'));
    expect(mine, `blocking was ${JSON.stringify(v.blocking)}`).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'skip', action: 'resolve_skip', node_id: '1:1' });
    expect(v.blocking.map((b: any) => b.action)).not.toContain('raise_max_depth');
  });

  // The wrapper shape (g): once an uncomparable radius OMITS borderRadius, the transparency test at
  // diff.ts:1246 stops disqualifying a visibly rounded wrapper, styleAnchor descends past it, and the
  // flag -- read through the anchor -- never fires. The receipt then prints a style_anchor row
  // asserting "no styles" about a node with a visible rounded corner.
  it('the wrapper shape: an uncomparable radius disqualifies transparency, so no descent past the rounded wrapper', () => {
    const inner = { kind: 'element', tag: 'div', classList: ['inner'],
      rect: { x: 0, y: 0, w: 100, h: 40 }, styles: {}, children: [] };
    const rows = diffPair(radiusSpec as any,
      flatDom({ borderRadiusUncomparable: true }, { children: [inner] }) as any, { tolerancePx: 1 });
    expect(row(rows, 'style_anchor'), 'the anchor descended past a wrapper with a visible rounded corner').toBeUndefined();
    const r = row(rows, 'corner-radius');
    expect(r).toBeDefined();
    expect(r.status).toBe('unchecked');
    expect(r.dom).toBeNull();
  });

  // The OTHER direction of the same wrapper, and the one the test above cannot see: the carrier is
  // the CHILD, so the flag has to be read THROUGH the active anchor. Swapping the arms of
  // `sRadiusUncomparable = a ? a.styles?... : d.styles?...` survives the rest of the suite -- with the arms
  // swapped this fixture reads the flag off the empty wrapper root, falls through to sRadius (which
  // an active anchor defaults to 0) and reports a fail 8 vs 0 about a rounded child.
  it('read THROUGH the anchor: an uncomparable radius on the style carrier reaches the unchecked row', () => {
    const carrier = { kind: 'element', tag: 'div', classList: ['carrier'],
      rect: { x: 0, y: 0, w: 100, h: 40 },
      styles: { borderRadiusUncomparable: true }, children: [] };
    const rows = diffPair(radiusSpec as any,
      flatDom({}, { children: [carrier] }) as any, { tolerancePx: 1 });
    expect(row(rows, 'style_anchor')?.status, 'the wrapper is transparent, so the anchor must be active').toBe('pass');
    const r = row(rows, 'corner-radius');
    expect(r, `the corner-radius row was ${JSON.stringify(r)}`).toBeDefined();
    expect(r.status).toBe('unchecked');
    expect(r.dom).toBeNull();
  });
});

// ── п.7 live-run: typography is compared with the text CARRIER, never with a wrapper ──
// Measured: a Button pair read font-size 17/13.3 and weight 550/400 - both fake. 13.33px is the
// browser default of <button> itself; the real text sits deeper in a typography span computing
// exactly 17/550. Wrapper styles are the confidently-wrong class: inheritance does not guarantee
// the carrier's rendering, so no branch below ever falls back to comparing the wrapper.
describe('typography carrier descent (p.7)', () => {
  const typo = { fontFamily: 'Inter', fontWeight: 550, fontSize: 17, lineHeightPx: 24, lineHeightUnit: 'PIXELS' as const, letterSpacing: 0 };
  const btnChild = (over: Partial<import('../../src/domain/layout-spec/types.js').DomChild> = {}) => ({
    kind: 'element' as const, tag: 'button', classList: ['ds-button'],
    rect: { x: 0, y: 0, w: 200, h: 52 },
    styles: { fontSize: 13.333, fontWeight: 400, fontFamily: 'Inter', lineHeight: 'normal' as const },
    ...over,
  });
  const figBtn = (over = {}): import('../../src/domain/layout-spec/types.js').SpecChild => ({
    id: '12:341', name: 'Button', type: 'INSTANCE', rect: { x: 0, y: 0, w: 200, h: 52 },
    text: typo, textFromNested: true, ...over,
  } as never);
  const base = (kids: unknown[], figKids: unknown[] = [figBtn()]) => diffPair(
    spec({ children: figKids as never, axis: 'col' }),
    snap({ children: kids as never, rect: { x: 0, y: 0, w: 343, h: 52 }, clientHeight: 52, scrollHeight: 52 }),
    { tolerancePx: 1 });

  it('LIVE FORM: nested fig text vs a wrapper with ONE nested carrier → compared with the CARRIER, passes, note names the descent', () => {
    const rows = base([btnChild({ children: [
      { kind: 'element', tag: 'span', classList: ['ds-typography'], rect: { x: 20, y: 14, w: 160, h: 24 },
        styles: { fontSize: 17, fontWeight: 550, fontFamily: 'Inter', lineHeight: 24 },
        children: [{ kind: 'text', rect: { x: 20, y: 14, w: 160, h: 24 }, text: 'Save changes',
          styles: { fontSize: 17, fontWeight: 550, fontFamily: 'Inter', lineHeight: 24 } }] },
    ] })]);
    const fs = row(rows, 'font-size');
    const fw = row(rows, 'font-weight');
    expect(fs).toMatchObject({ figma: 17, dom: 17, status: 'pass' });
    expect(fw).toMatchObject({ figma: 550, dom: 550, status: 'pass' });
    expect(fs?.note ?? '').toContain('nested text carrier');
  });

  it('a REAL defect on the carrier still fails (the descent is not a softener)', () => {
    const rows = base([btnChild({ children: [
      { kind: 'element', tag: 'span', rect: { x: 20, y: 14, w: 160, h: 24 },
        children: [{ kind: 'text', rect: { x: 20, y: 14, w: 160, h: 24 }, text: 'Save',
          styles: { fontSize: 15, fontWeight: 400 } }] },
    ] })]);
    expect(row(rows, 'font-size')).toMatchObject({ figma: 17, dom: 15, status: 'fail' });
  });

  it('several carriers with no fig-side multi-text → honest warn, no wrapper compare, no fake fail', () => {
    const rows = base([btnChild({ children: [
      { kind: 'element', tag: 'span', rect: { x: 0, y: 0, w: 80, h: 24 },
        children: [{ kind: 'text', rect: { x: 0, y: 0, w: 80, h: 24 }, text: 'A', styles: { fontSize: 17 } }] },
      { kind: 'element', tag: 'span', rect: { x: 90, y: 0, w: 80, h: 24 },
        children: [{ kind: 'text', rect: { x: 90, y: 0, w: 80, h: 24 }, text: 'B', styles: { fontSize: 11 } }] },
    ] })]);
    expect(rows.some((r) => r.prop.startsWith('font-size') && r.status === 'fail')).toBe(false);
    const w = rows.find((r) => r.prop.startsWith('typography') && r.status === 'warn');
    expect(w?.note ?? '').toContain('several nested text carriers');
  });

  it('no carrier captured + truncation → unchecked (text may be beyond the slice), no wrapper compare', () => {
    const rows = base([btnChild({ children: [], childrenTruncated: true })]);
    expect(rows.some((r) => r.prop.startsWith('font-size'))).toBe(false);
    const u = rows.find((r) => r.prop.startsWith('typography') && r.status === 'unchecked');
    expect(u?.note ?? '').toMatch(/beyond|deeper|slice/);
  });

  it('no carrier in a FULLY captured subtree → warn "text missing", no wrapper compare', () => {
    const rows = base([btnChild({ children: [] })]);
    expect(rows.some((r) => r.prop.startsWith('font-size'))).toBe(false);
    const w = rows.find((r) => r.prop.startsWith('typography') && r.status === 'warn');
    expect(w?.note ?? '').toContain('carries none');
  });

  it('control: the DOM node OWNS its text → todays direct compare, byte-identical rows, no carrier note', () => {
    const rows = base([btnChild({
      styles: { fontSize: 17, fontWeight: 550, fontFamily: 'Inter', lineHeight: 24 },
      children: [{ kind: 'text', rect: { x: 20, y: 14, w: 160, h: 24 }, text: 'Save',
        styles: { fontSize: 17, fontWeight: 550, fontFamily: 'Inter', lineHeight: 24 } }],
    })]);
    const fs = row(rows, 'font-size');
    expect(fs).toMatchObject({ figma: 17, dom: 17, status: 'pass' });
    expect(fs?.note ?? '').not.toContain('carrier');
  });

  it('ROOT form: a fig TEXT root paired onto a wrapper with one nested carrier → carrier styles win', () => {
    const rows = diffPair(
      spec({ text: typo, textNode: true, children: [] }),
      snap({ children: [
        { kind: 'element', tag: 'span', rect: { x: 0, y: 0, w: 160, h: 24 },
          children: [{ kind: 'text', rect: { x: 0, y: 0, w: 160, h: 24 }, text: 'Save',
            styles: { fontSize: 17, fontWeight: 550, fontFamily: 'Inter', lineHeight: 24 } }] },
      ], styles: { fontSize: 13.333, fontWeight: 400 } }),
      { tolerancePx: 1 });
    expect(row(rows, 'font-size')).toMatchObject({ figma: 17, dom: 17, status: 'pass' });
  });
});
