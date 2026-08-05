// mcp-server/src/domain/layout-spec/diff.ts
// Diff engine: LayoutSpec (Figma) × DomSnapshot (browser) → report rows.
// The absolute coordinates of the two sides are incomparable (different origins) — all inter-element
// metrics are derivatives (differences), invariant to the origin.
import type {
  LayoutSpec, SpecRect, SpecChild, SpecTypography, DomSnapshot, DomSnapshotOk, DomChild, DiffRow, PairSummary,
  PairCoverage, PairResult, Edges, DiffStatus, ResolvedColorToken, PairAttribution, MatchProfile,
} from './types.js';
import { SNIPPET_CAP } from './types.js';
import { matchChildrenOneLevel, detectChildrenReorder } from './pair-matcher.js';
import { gradientVerdict } from './gradient-verdict.js';
import { widthNoiseTolerance } from './tolerance.js';

export const TYPO_TOLERANCE_PX = 0.5;

// Typography auto-descent: cap on the DFS collection of TEXT descendants on EACH side of the pair.
// Reaching the cap makes ordinal matching unprovable (the tail beyond the cap is not visible) —
// see matchTexts phase 2 and anyTruncated below.
// 15 (was 10): at capture depth 4 — a typical card (a list of several
// rows, each with 2+ TEXT on L4: label+value) easily yields >10 TEXT descendants even BEFORE a real
// depth/cap cut. Side effect (deliberate): a larger cap sets anyTruncated=true less often — and thus
// later — so phase 2 (ordinal matching of the remainders) gets a say more broadly than at 10. That is
// fine: truncation is still signaled honestly (childrenTruncated/MAX_TEXT_DESCENT by itself), the
// threshold just starts firing later — matching a deeper/wider capture rather than weakening the
// provability of the matching.
export const MAX_TEXT_DESCENT = 15;

// max_depth drill-down: auto-descend TEXT-DFS cap mirror — moves WITH maxDepth so a deep
// drill-down's typography scan isn't capped at the SHALLOW default's MAX_TEXT_DESCENT (15). maxDepth
// 1-4 → MAX_TEXT_DESCENT (15, unchanged byte-for-byte); 5-8 → 30. Sibling to budgetFor in projector.ts
// (same Math.ceil(d/4) shape); the 60 ceiling here is likewise unreachable at maxDepth<=8.
export function descentFor(maxDepth: number): number {
  return Math.min(60, MAX_TEXT_DESCENT * Math.max(1, Math.ceil(maxDepth / 4)));
}

// widthNoiseTolerance was moved to tolerance.ts: the upload route is a leaf, not
// part of the diff graph, and imports it directly from there (a bare re-export does NOT provide a local binding
// for :205/:250 below — they need a real import). The re-export is for backward compatibility of the existing
// importers of THIS module (find-breakpoint-variant-tool.ts, compare-node-to-dom-tool.ts).
export { widthNoiseTolerance };

export interface DiffOptions {
  tolerancePx: number;
  frameWidth?: number;
  expectedComponent?: string;
  // Fixed overlay (drawer/modal) whose DOM width does not obey the viewport: decouples
  // size.w/viewport from frameWidth, adds a separate overlay_width row based on d.innerWidth.
  expectedOverlayWidth?: number;
  // max_depth drill-down: capture depth the CALLER used for both sides (compare_node_to_dom's
  // max_depth) — drives descentFor(maxDepth) for the auto-descend TEXT-DFS cap (collectFigTexts/
  // collectDomTexts/domHugEndEvidence in crossAndPaddingRows), so a deep drill-down doesn't cap the
  // typography scan at the SHALLOW default's MAX_TEXT_DESCENT. Undefined ⇒ 4 (byte-for-byte default).
  maxDepth?: number;
  // source-hint side-output (read-only). The differ deposits the RAW attribution (tag/classList/
  // names/indices/paths) of the matched nodes at the same 4 points where the rows take their data (children post-
  // salvage/unwrap, anchor under aRes&&hasStyleAxis, text via the ancestor stack, unpaired structure_mismatch).
  // rows/summary/verdict do NOT depend on the presence of THIS field byte-for-byte (a pure collection, zero input mutations).
  attributionOut?: PairAttribution;
  // The scope profile. 'layout' → the post-filter applyLayoutProfileScope on the output of
  // diffPair (measured non-meta non-allowlist axis rows collapse per-dim into profileScoped skips).
  // undefined / 'strict' / 'token-aware' → rows stay byte-for-byte the same (the filter is not called).
  profile?: MatchProfile;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

const start = (r: SpecRect, axis: 'row' | 'col'): number => (axis === 'row' ? r.x : r.y);
const end = (r: SpecRect, axis: 'row' | 'col'): number => (axis === 'row' ? r.x + r.w : r.y + r.h);

// fix-plan: edit-source channels — set DIRECTLY in the row literal at the moment it is created
// by a fail of an editable axis (routing table of editable axes). UNCONDITIONAL (independent of
// attributionOut — the source-hint co-lock "rows are byte-identical with/without attr" holds by construction).
// Structural rows (children_reorder/layout_axis_mismatch/structure_mismatch) do NOT carry a channel:
// they are not a "property edit", their remediation is already in blocking. The demotion helpers STRIP the channel
// (a soft warn/demoted/info carrier does not carry an edit address).
const SRC_ROOT_LAYOUT: NonNullable<DiffRow['srcChannel']> = { kind: 'root', editKind: 'layout' };
const SRC_ANCHOR_PROP: NonNullable<DiffRow['srcChannel']> = { kind: 'anchor', editKind: 'property' };

function numRow(prop: string, figma: number, dom: number, tol: number, note?: string, src?: DiffRow['srcChannel']): DiffRow {
  const delta = round1(Math.abs(figma - dom));
  return { prop, figma: round1(figma), dom: round1(dom), ...(delta > 0 ? { delta } : {}),
    status: delta <= tol ? 'pass' : 'fail', ...(note ? { note } : {}),
    ...(delta > tol && src ? { srcChannel: src } : {}) };
}

function childLabel(c: { name?: string; tag?: string; kind?: string; type?: string }): string {
  return c.name ?? c.tag ?? (c.kind === 'text' ? 'text' : 'node');
}

// source-hint: cap on the number of unpaired DOM children in attributionOut.unpaired —
// budget protection (navigation-to-investigate, not an address-to-fix). The cap is applied AT the collection site.
const UNPAIRED_CAP = 10;
function collectUnpaired(opts: DiffOptions, unmatchedDom: DomChild[]): void {
  if (!opts.attributionOut) return;
  opts.attributionOut.unpaired = unmatchedDom.slice(0, UNPAIRED_CAP).map((c) => ({
    path: c.path ?? childLabel(c),
    ...(c.classList ? { classList: c.classList } : {}),
  }));
}

export function summarize(rows: DiffRow[]): PairSummary {
  const s: PairSummary = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 };
  for (const r of rows) s[r.status] += 1;
  return s;
}

// Structural coverage holes: the tool CANNOT measure them (unlike "not applicable to the pair").
// Surfaced in the report footer — "green does NOT include this, verify visually".
export const NOT_COVERED_BY_TOOL = ['icons'] as const;

// Meta rows (not coverage axes): service warnings / navigation / pair quality —
// not a visual/geometric dimension. Includes the ref fetch (snapshot_ref) and the structural warns
// (structure/axes/children truncation) — otherwise they leak into measured as false "axes". Verified
// against fact (grep `prop:` in diff.ts + compare-node-to-dom-tool.ts): snapshot/snapshot_schema/
// snapshot_ref/frame/node — service rows of the tool; unwrapped/structure_mismatch/
// children_truncated/layout_axis_mismatch/children — structural rows about the pair itself, not about
// a visual axis; extractor_outdated — a warning about the extractor version.
// children_reorder: a fail blocks green by itself (buildVerification anyFail) —
// it is added here ONLY so that deriveCoverage does not count the row as a visual coverage axis (otherwise
// "children_reorder" would leak into measured as a false axis). NOT added to COVERAGE_HOLING_WARN:
// the row's status is fail, not skip/warn — it would be dead there.
// style_anchor: a pass row pointing to the style carrier (which chain of
// transparent wrappers was traversed) — NOT a visual coverage axis. Without this, 'style_anchor' would leak into
// measured as a false "axis". NOT added to COVERAGE_HOLING_WARN: status pass, not skip/warn.
// passes_condensed: a meta row aggregating the collapsed bulk-pass rows (see
// condenseBulkPass) — a service row, NOT a visual axis. Without dimensionOf('passes_condensed') in the registry
// it would leak into measured as a false "axis" → deriveCoverage over the condensed rows would drift. NOT added to
// COVERAGE_HOLING_WARN: status pass. This registry is also the GUARANTOR of the collapse's idempotency:
// passes_condensed is itself excluded from the bulk predicate (see isBulk below) via COVERAGE_META.
const COVERAGE_META = new Set([
  'snapshot', 'snapshot_schema', 'snapshot_ref', 'extractor_outdated', 'frame', 'node', 'unwrapped',
  'structure_mismatch', 'children_truncated', 'layout_axis_mismatch', 'children', 'children_reorder',
  'style_anchor', 'passes_condensed',
]);

// prop → coverage axis. prop formats: 'size.w' | 'gap[0] a↔b' | 'padding-left' |
// 'offset-cross[0] …' | 'font-size[title]' | 'corner-radius' | 'typography_descent[…]' | 'component'.
export function dimensionOf(prop: string): string {
  const base = prop.split(/[[\s]/)[0]; // strip [label] and " a↔b"
  if (base.startsWith('size')) return 'size';
  if (base.startsWith('padding')) return 'padding';
  if (base.startsWith('gap')) return 'gap';
  if (base.startsWith('offset-cross')) return 'offset-cross';
  if (base === 'corner-radius' || base === 'border-radius') return 'border-radius';
  if (base.startsWith('typography')) return 'typography';
  return base; // font-size, font-weight, font-family, line-height, letter-spacing, color, fill, opacity, component, viewport, overlay_width, geometry
}

// ── Registry of the layout-profile axes ──
// 1) Visual-layout allowlist — measured under layout.
export const LAYOUT_VISUAL_DIMS = new Set(['size', 'gap', 'padding', 'offset-cross', 'viewport', 'overlay_width']);
// 2) Pass-through UNCONDITIONALLY, by CATEGORY (not by filter position): COVERAGE_META ∪ {'geometry'}.
// geometry — the environmental-honesty channel (viewport/scroll/rotated, unchecked :328) is NOT in COVERAGE_META;
// a bare rule "non-meta → collapse" would swallow it, killing fix_viewport/dominant_blocker.
// An explicit union — belt-and-suspenders to the STATUS gate below.
export const PROFILE_PASS_THROUGH = new Set([...COVERAGE_META, 'geometry']);
// 3) STATUS gate: ONLY measured statuses collapse; skip/unchecked rows — environmental trust channels —
// NEVER (protects future axes by construction). demoted is DELIBERATELY not in the list (the status set
// lists exactly pass/fail/warn/info/review); today demoted lives only on allowlist axes
// (size/padding/gap demotions) — a conservative choice that preserves the signal, does not hide it.
const PROFILE_MEASURED = new Set<DiffStatus>(['pass', 'fail', 'warn', 'info', 'review']);
export const PROFILE_SKIP_NOTE = 'axis outside the layout profile — verify with the token-aware/strict profile';

// Canonical dim of a profile skip: families collapse into ONE skip per family (anti-flood, the same motive
// as PLACES_CAP): typography family → 'typography';
// gradient-* (incl. the indexed gradient-stop-N-*) → 'gradient'; shadow-* → 'box-shadow';
// border-color/width → 'border' (border-radius is a SEPARATE axis; corner-radius is treated separately).
function profileSkipDim(dim: string): string {
  if (dim === 'typography' || dim.startsWith('font-') || dim === 'line-height' || dim === 'letter-spacing') return 'typography';
  if (dim.startsWith('gradient')) return 'gradient';
  if (dim === 'box-shadow' || dim.startsWith('shadow-')) return 'box-shadow';
  if (dim === 'border-color' || dim === 'border-width') return 'border';
  return dim; // color, fill, border-radius, opacity, component, future axes — each is its own dim
}

// The layout-profile post-filter: measured rows of non-meta non-allowlist axes → one profileScoped skip
// row per canonical dim (a SEPARATE representation — we do not reuse the environmental skip).
// The skip is inserted at the position of the FIRST collapsed row of its dim (report locality). skip/unchecked
// rows of any axis and the whole pass-through category pass through UNTOUCHED (keep their status).
// Exported — for the direct category lock (the union {'geometry'} is observable only via a synthetic
// measured-geometry row: the differ today emits geometry exclusively as unchecked, and the status gate
// duplicates the protection; a mutation "geometry outside the union" without the direct lock would be invisible by construction).
export function applyLayoutProfileScope(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  const emitted = new Set<string>();
  for (const r of rows) {
    const dim = dimensionOf(r.prop);
    if (!LAYOUT_VISUAL_DIMS.has(dim) && !PROFILE_PASS_THROUGH.has(dim) && PROFILE_MEASURED.has(r.status)) {
      const sdim = profileSkipDim(dim);
      if (!emitted.has(sdim)) {
        emitted.add(sdim);
        out.push({ prop: sdim, status: 'skip', profileScoped: true, note: PROFILE_SKIP_NOTE });
      }
      continue;
    }
    out.push(r);
  }
  return out;
}

// What was ACTUALLY checked for the pair — derived from the emitted rows (not hardcoded → does not drift
// when the diff grows new axes). A non-skip row => the axis was measured; skip => the axis was skipped (with a reason).
export function deriveCoverage(rows: DiffRow[]): PairCoverage {
  const measured = new Set<string>();
  const skipped: PairCoverage['skipped'] = [];
  const seenSkip = new Set<string>();
  for (const r of rows) {
    const dim = dimensionOf(r.prop);
    if (COVERAGE_META.has(dim)) continue;
    // The profile-scope branch BEFORE the generic skip — the profileScoped marker must reach
    // coverage.skipped (otherwise a deliberate profile narrowing is indistinguishable from an environmental skip).
    if (r.profileScoped === true) {
      if (!seenSkip.has(dim)) { skipped.push({ dim, reason: r.note ?? '', profileScoped: true }); seenSkip.add(dim); }
    } else if (r.status === 'skip' || r.status === 'unchecked') {
      if (!seenSkip.has(dim)) { skipped.push({ dim, reason: r.note ?? '' }); seenSkip.add(dim); }
    } else if (r.status === 'info' && dim === 'component') {
      // p.1-p.3: identity was NOT measured — the info pool does not "greenwash" coverage (fixed reason — the note is long)
      if (!seenSkip.has(dim)) { skipped.push({ dim, reason: 'component identity: signal absent' }); seenSkip.add(dim); }
    } else {
      measured.add(dim);
    }
  }
  return { measured: [...measured].sort(), skipped };
}

// Response-budget cascade (between "full" and "omitted_pairs"): a pair's bulk-pass rows collapse
// into ONE meta row passes_condensed. Bulk = pass WITHOUT a note and outside COVERAGE_META — style_anchor/
// unwrapped (navigation) and note-carrying pass rows ("not a defect" interpretations) survive ALWAYS;
// signal rows are never compressed. summary/coverage are CARRIED OVER (computed during the diff).
export function condenseBulkPass(pairs: PairResult[]): PairResult[] {
  return pairs.map((p) => {
    const isBulk = (r: DiffRow): boolean => r.status === 'pass' && !r.note && !COVERAGE_META.has(dimensionOf(r.prop));
    const bulk = p.rows.filter(isBulk);
    if (bulk.length === 0) return p;
    const dims = [...new Set(bulk.map((r) => dimensionOf(r.prop)))].join(', ');
    return { ...p, rows: [...p.rows.filter((r) => !isBulk(r)),
      { prop: 'passes_condensed', status: 'pass' as const, figma: bulk.length,
        note: `${bulk.length} pass rows condensed for the response budget (axes: ${dims}); fail/warn/info/review/unchecked/demoted — full; count in summary.pass` }] };
  });
}

// Coverage holes for the VERDICT: rows where content exists but was NOT measured / the pair could not be compared.
// status skip = the axis was not measured (scroll-height, no-auto-layout, environment); the warn set = structural
// holes and a comparison refusal. Does NOT include informational warns (component/fill/frame): there the metrics
// WERE measured, that is a caveat, not a hole — otherwise the verdict cries "wolf". Feeds the verdict's honest
// incompleteness: the terminal "no discrepancies" is not emitted while a hole exists (otherwise a structure_mismatch
// that skipped all children with one warn silently collapses into green — a live false-green).
const COVERAGE_HOLING_WARN = new Set([
  'structure_mismatch', 'children_truncated', 'snapshot', 'snapshot_schema', 'snapshot_ref', 'extractor_outdated', 'node',
]);
export function coverageHoleRows(rows: DiffRow[]): DiffRow[] {
  // A profileScoped skip is EXCLUDED — a deliberate profile narrowing is not an environmental hole;
  // holeToBlocking is not called for it → blocking is NOT flooded with resolve_skips "fix what you excluded
  // yourself" (resolve_skip is reserved for the environment).
  return rows.filter((r) =>
    (r.status === 'skip' && r.profileScoped !== true)
    || (r.status === 'warn' && COVERAGE_HOLING_WARN.has(dimensionOf(r.prop))));
}
export function countCoverageHoles(rows: DiffRow[]): number {
  return coverageHoleRows(rows).length;
}

// size.w — the only row where a "fail" may be an artifact of the fixed overlay (the DOM width
// does not obey the viewport): with expectedOverlayWidth the fail is downgraded to info with an explicit
// reference to overlay_width — regardless of which of the three branches (unwrapBase /
// contentMode / plain) built the row.
// fix-plan: the demotion strips srcChannel — a non-fail row (warn/demoted/info) does not carry a channel
// (a soft carrier does not carry an edit address).
function stripSrc(row: DiffRow): DiffRow {
  const out = { ...row };
  delete out.srcChannel;
  return out;
}

function applyOverlayWidthOverride(row: DiffRow, expectedOverlayWidth: number | undefined): DiffRow {
  if (expectedOverlayWidth === undefined || row.status !== 'fail') return row;
  return { ...stripSrc(row), status: 'demoted', note: 'fixed overlay: the width is informative (see overlay_width)' };
}

// size.w / padding-end (of a fig-last-TEXT) — rows where a "fail" may be an artifact of
// TEXT hug-width: the width/offset is controlled by the auto-layout engine from the natural width of the
// text, not by the designer — the discrepancy is not a defect, defects are caught by typography (font-size etc.).
// A fixed-width TEXT (textAutoResize NONE|HEIGHT, textFixedWidth true) is NOT passed to demote by the
// caller — its width/offset was set by the designer, the discrepancy stays an honest fail.
// The note is JOINED (join), not overwritten — otherwise a previously attached note (e.g. E)
// would be silently lost.
function applyTextWidthOverride(row: DiffRow, demote: boolean): DiffRow {
  if (!demote || row.status !== 'fail') return row;
  return { ...stripSrc(row), status: 'demoted',
    note: [row.note, 'hug-width text: layout width = the natural width of the text — defects are caught by typography, not by width']
      .filter(Boolean).join('; ') };
}

// PAGE SCROLLBAR GUTTER. A classic (non-overlay) page scrollbar takes its width off the LAYOUT
// VIEWPORT: window.innerWidth stays 1920 while CSS lays the page out in documentElement.clientWidth
// = 1909, so a full-bleed element measures 1909 against a Figma frame that says 1920. The two
// existing scrollbar terms (size.w/size.h below) subtract the PAIRED ELEMENT's OWN bar --
// `rect.w - borders - clientWidth`, which on that same full-bleed element is 0, because its rect and
// its clientWidth are BOTH the reduced 1909. They look one level too low, and the page gutter never
// entered any formula. The two are independent and opposite in sign (own bar SUBTRACTS from the DOM
// side, the page gutter is a shortfall to EXPLAIN), so this never double-counts against them.
//
// THE GATE IS A MEASUREMENT, NOT AN ARITHMETIC COINCIDENCE. "the shortfall equals the gutter" was
// the obvious rule and it is a false-green machine: a `max-width:1200` container never paid an 8px
// page gutter, so a real 8px stray padding on it -- 1200 vs 1192 -- matches that predicate exactly
// and ships clean. What is actually being claimed is "this element's width IS the layout viewport",
// and that is directly measurable: rect.w == documentElement.clientWidth. A 1200 container, a 400px
// sidebar and a `width:100vw` header (1920 against a 1912 layout viewport -- the case every "is it
// the frame root" gate waves through) all fail it and keep their fails.
//
// WIDTH IS HALF THE CLAIM -- POSITION IS THE OTHER HALF. A box that merely HAPPENS to be exactly as
// wide as the layout viewport is not the layout viewport: an equal width with a non-zero x is a
// coincidence of magnitude, and the gutter argument needs the box to be ANCHORED where the gutter
// was taken from. Two anchorings are real, and both are RE-measured in Chrome (1920 window, one page
// scrolling `main` at width:100%, at an 11px `::-webkit-scrollbar` and again at the 15px native bar):
//
//     scrollbar-gutter      innerWidth  clientWidth  innerWidth-clientWidth  main x   main w
//     auto / stable              1920         1909                      11       0     1909
//     stable both-edges          1920         1909                      11      11     1898
//     auto / stable (15px)       1920         1905                      15       0     1905
//     stable both-edges (15px)   1920         1905                      15      15     1890
//
// `documentElement.clientWidth` is the VIEWPORT width: it excludes the bar that is actually painted
// and knows nothing about the gutter reserved on the opposite edge. So under both-edges it does NOT
// double -- it stays the one-bar number, and the reserved pair shows up in the ELEMENT instead: the
// root is inset by a full bar on each edge (x == bar, w == clientWidth - bar). An earlier reading of
// this branch recorded clientWidth 1898 / gutter 22 / x 11 and gated the second anchoring on
// `x == gutter/2`; the numbers above are what Chrome produces, and they say that predicate is
// unreachable for the shape it was written for (a real both-edges root fails the span test outright,
// 1898 != 1909) while staying wide open for an ORDINARY 11px page -- any box at x ~ 5.5 that happens
// to be layout-viewport wide, i.e. one overflowing the layout viewport to the right, was demoted.
// The gate now tests the two shapes as they measure:
//     spanning  x == 0    && w == clientWidth          -> the root lost the one painted bar
//     inset     x == bar  && w == clientWidth - bar    -> the root lost a reserved bar on EACH edge
// The width the root lost is `bar` in the first shape and `2*bar` in the second, and that -- not
// `innerWidth - clientWidth` -- is the quantity every consumer below spends. Anything else (a centred
// `max-width` container, a sidebar, a nested box, the x ~ bar/2 band) is rejected and keeps its fails.
//
// AND IT IS A DEMOTE, NOT A PASS. `width: calc(100vw - 15px)` -- the hack people write BECAUSE of
// the scrollbar -- spans the layout viewport too, and its capture is byte-identical to a correct
// page's: nothing in the snapshot separates them. Correcting the comparison basis (compare against
// frameWidth - gutter) would resolve BOTH to pass, i.e. a green over a difference this capture
// cannot see. 🟰 keeps verification.complete false, mints no blocking action, prints both measured
// widths, and carries no srcChannel -- so fix_plan emits no edit for it, which is the half of this
// defect that was actually expensive: telling the reader to change a working CSS rule.
//
// ponytail: WIDTH ONLY. A horizontally scrolling page has the same gutter on the bottom edge and
// size.h lies the same way; carrying documentElement.clientHeight would fix it. Not carried, because
// a horizontal page scrollbar is itself a defect worth surfacing, not explaining away. Add the height
// twin when a real report needs it.
function pageGutterOf(d: DomSnapshotOk, structTol: number): { px: number; note: string } | undefined {
  if (d.layoutViewportWidth === undefined) return undefined;
  const lvw = d.layoutViewportWidth;
  const bar = round1(d.innerWidth - lvw);
  if (bar <= structTol) return undefined;
  // structTol, not `===`, on every geometry test below: rect.w/rect.x are fractional
  // getBoundingClientRect values while clientWidth is an integer, and at fractional device-scale
  // factors (Windows 125/150/175%) they differ by up to 0.5px on an element that genuinely spans.
  // An exact test never fires there. getBoundingClientRect is viewport-relative and a pair root with
  // a non-zero page scroll is stopped upstream by the `scroll≠0` geometry reason, so the raw x is the
  // whole position test. The two shapes are measured, see ANCHORING above.
  const spanning = Math.abs(d.rect.w - lvw) <= structTol && Math.abs(d.rect.x) <= structTol;
  const inset = Math.abs(d.rect.x - bar) <= structTol && Math.abs(d.rect.w - (lvw - bar)) <= structTol;
  if (!spanning && !inset) return undefined;
  // px = the width the ROOT lost, which is what every consumer spends: one painted bar when the root
  // spans, a reserved bar on each edge when it is inset. `bar` alone would under-explain both-edges by
  // half and the demote would refuse the row it exists for.
  const px = spanning ? bar : round1(bar * 2);
  const where = spanning
    ? 'the pair root spans the layout viewport'
    : `the pair root is inset by ${bar}px on each edge (\`scrollbar-gutter: stable both-edges\`: the painted bar is excluded from the layout viewport, the reserved one is not)`;
  return { px,
    note: `page scrollbar gutter ${px}px (window ${round1(d.innerWidth)}, CSS layout viewport ${round1(lvw)}) — `
      + `${where}, so this row is short by at most the gutter, not by a layout rule; `
      + 'a layout defect of the same size is not separable from it in this capture — verify visually' };
}

// THE GUTTER IS AN EXACT QUANTITY, SO THE ALLOWANCE IS NOT A TOLERANCE. On the one row this fires
// on, size.w of a spanning root, the identity is arithmetic and total: the layout viewport is
// `innerWidth - gutter` BECAUSE the bar took the gutter, so a shortfall of gutter+1 is the gutter
// plus 1px of something else -- and the something else is exactly what the reader needs told. An
// allowance of `gutter + tolerancePx` (default 1) made the window 12px wide where the gutter is 11
// and demoted that case, which is the one this whole detector's red arm was written to keep failing.
//
// The only slack kept is sub-pixel, and it is a measured artifact of the capture, not of the layout:
// `documentElement.clientWidth` is an INTEGER while `getBoundingClientRect().width` is fractional, so
// on a fractional layout viewport (real browser zoom) a genuinely spanning box reports a width that
// differs from the gutter arithmetic by the rounding alone. Measured through the real extractor:
// exactly 0 at an integral layout viewport (Chrome, window 1920, 11px bar, deviceScaleFactor 1 /
// 1.25 / 2 -- span residual 0.000 in all three), and 0.400 / 0.333 / 0.143 under fractional zoom,
// every one of them below half a pixel, which is the bound a single integer rounding can produce.
// So: strictly less than half a CSS pixel of residual is capture noise; 0.5px and up is layout, and
// layout is a fail. The test is TWO-SIDED (|short - gutter| < 0.5), not "short - gutter < 0.5": the
// span gate accepts rect.w within structTol of the layout viewport, and at a tolerancePx of 4 that
// slack made a root of 1913 against a 1909 layout viewport and a 1920 frame -- short by 7, explained
// by an "11px gutter" -- read `demoted`, which is not the arithmetic identity this file claims. A
// shortfall SMALLER than the gutter is as unexplained as a larger one. Two-sided also subsumes the
// old `short <= 0` guard (a gutter is > structTol >= 1, so any non-positive shortfall is more than
// half a pixel away from it) -- one predicate, not two. That is two orders of magnitude below the 1px
// this tool calls a defect by default, so no real regression -- not even a 1px one -- can hide under
// it. The residual is taken
// from the row's own figma/dom, which numRow has already rounded to 0.1 -- deliberately: it is
// measured on the numbers the reader is shown, and the rounding pushes a borderline case AWAY from
// the demote (a true 0.46 reads 0.5 and fails) rather than into it.
const GUTTER_RESIDUAL_MAX = 0.5;

// SCOPE: size.w OF THE ROOT, PLUS THE ONE DERIVED ROW THIS CAPTURE CAN PROVE. The gutter also MOVES
// the trailing padding, a distributed gap and a centred cross offset -- measured at a 1920 frame with
// an 11px gutter: the trailing padding by the full 11 (fig 1280 / dom 1269), a space-between gap by
// the full 11 (fig 1320 / dom 1309), a centred child's cross offset by HALF of it (fig 360 / dom
// 354.5). Three amounts through three mechanisms, and WHICH one applies is a property of the CSS, not
// of the gutter -- but the three conditions are NOT equally unknown to the capture, and treating them
// as one was the previous version's mistake:
//
//   - trailing padding: moves only while the slack absorbs the loss. NOT measured -- the capture has
//     no free-space budget, and a full-bleed container with a real regression looks identical.
//   - distributed gap: moves only while the main axis distributes free space. NOT measured -- the
//     justify-content keyword says a distribution is REQUESTED, not that this gap received the loss.
//   - centred cross offset: moves by half, and only while the content is centred. THIS ONE IS
//     MEASURED. DomSnapshotOk carries the root rect and every DomChild carries rect{x,w}, so
//     "leading gap == trailing gap" is a fact of the capture on both sides, and the loss it implies
//     is arithmetic: both centres sit at the middle of their own content box, so the offset drops by
//     exactly half of what the box lost. Measured on one page (window 1920), three children of the
//     same width at fig offsets 0 / 360 / 720, leading-anchored / centred / trailing-anchored:
//         auto, 11px bar        root x 0  w 1909   offsets 0 / 354.5 / 709   losses 0 / 5.5 / 11
//         both-edges, 11px bar  root x 11 w 1898   offsets 0 / 349   / 698   losses 0 / 11  / 22
//     i.e. exactly half of what the root lost, under both anchorings -- and NOT `bar/2`, which is why
//     the demote spends the root's loss (pageGutterOf's px) and not `innerWidth - clientWidth`.
//
// So the centred cross offset gets an exact allowance derived from the capture (crossGutterShare in
// crossAndPaddingRows), and everything not proved keeps its fail, its delta and its edit address with
// a pointer to the row where the quantity IS exact (notePageGutter below). A flat `gutter` allowance
// on all three -- what shipped before -- was a lie in the opposite direction: an 11px regression on a
// full-bleed container produced zero fails and an empty fix_plan.
// ponytail: only the centred case is derived. A child flush to the trailing edge provably loses the
// WHOLE gutter (measured above: 709 / 698) and is the next one to derive; not derived here because
// nothing in the live reports asks for it yet.
//
// WHAT THIS COSTS, stated rather than hidden: a genuine defect SMALLER than the gutter, on a pair
// root that spans the layout viewport, lands in 🟰 instead of ❌. It buys no green -- 🟰 keeps
// verification.complete false and prints both numbers -- but it is coverage, and it is the price of
// not inventing a separation the capture cannot support.
// WHEN IT DOES NOT DEMOTE, IT STILL KNOWS SOMETHING. A shortfall that is not the gutter keeps its
// fail, its delta and its edit address -- but part of that delta IS the gutter, and this is the one
// row where the differ has computed exactly how much. It said so in the rendered note while the
// fix_plan entry built from the same row prescribed a bare "edit the layout rule, not px" over pixels
// it had just accounted for. fix_plan is the machine-facing surface; the caveat travels on the row so
// buildFixPlan copies it verbatim, the same way the sibling rows carry theirs. Guarded (`?? `) rather
// than overwritten: crossGutterShare comes through here too and notePageGutter may have spoken first.
function applyPageGutterDemote(row: DiffRow, gutter: { px: number; note: string } | undefined): DiffRow {
  if (gutter === undefined || row.status !== 'fail') return row;
  if (typeof row.figma !== 'number' || typeof row.dom !== 'number') return row;
  const short = row.figma - row.dom;               // the gutter only ever makes the DOM side SHORT
  if (Math.abs(short - gutter.px) >= GUTTER_RESIDUAL_MAX) {
    return short <= 0 ? row : { ...row,
      caveat: row.caveat ?? `${round1(short - gutter.px)}px of this delta is layout; the other ${gutter.px}px is a page scrollbar gutter`,
      note: [row.note, `of which ${gutter.px}px is the page scrollbar gutter — the remaining `
        + `${round1(short - gutter.px)}px is not explained by it`].filter(Boolean).join('; ') };
  }
  return { ...stripSrc(row), status: 'demoted', note: [row.note, gutter.note].filter(Boolean).join('; ') };
}

// The rows the gutter can also move (see SCOPE above) — they stay ❌ with their channel, and say so.
// Only on a fail: a passing row needs no explanation, and annotating one would move it out of the
// bulk-pass fold (isBulk tests `!r.note`) for nothing.
//
// `caveat` is the same fact sized for the MACHINE surface. The rendered row carried this warning while
// the fix_plan entry built from the very same row carried a bare "edit the layout rule, not px" — and
// fix_plan, not the markdown, is what this product is read by. It travels on the row (buildFixPlan
// copies it verbatim into the edit) rather than being re-derived there: the tool would have to parse
// a note to find it, and parsing notes is how the caveat gets lost again.
function notePageGutter(row: DiffRow, gutter: { px: number; note: string } | undefined): DiffRow {
  if (gutter === undefined || row.status !== 'fail') return row;
  return { ...withNote(row, `the pair root also lost ${gutter.px}px to a page scrollbar gutter (see size.w) — `
    + 'how much of that reaches THIS row depends on the distribution/alignment this capture does not measure, '
    + 'so the delta above is the whole measured one and is not reduced by the gutter'),
  caveat: `the pair root lost ${gutter.px}px to a page scrollbar gutter (see size.w): confirm this delta is not that before editing` };
}

// E (hug-vs-fill): the Figma root hugs its content by width (hugWidth), while the DOM container stretches wider
// to the parent (fill) — the container's size/paddings on this axis are incomparable (the content is pinned, the "extra"
// width = fill slack, not a defect). We demote the fail → 🟰. Gate on hugWidth: fixed-width + wider DOM =
// a REAL defect, not passed here. The note is JOINED (does not overwrite the previous one).
function applyContainerHugFillDemote(row: DiffRow, demote: boolean): DiffRow {
  if (!demote || row.status !== 'fail') return row;
  return { ...stripSrc(row), status: 'demoted',
    note: [row.note, 'container hug (Figma) / fill (DOM): the width is stretched to the parent, the content is pinned — size/padding on this axis are uninformative; verify visually']
      .filter(Boolean).join('; ') };
}

// 🅱️: a main-axis justify-content distributes the free space → the leading/trailing gap is produced by
// the DISTRIBUTION, not a padding defect (space-between + a display:none sibling gives an "extra" trailing).
// We demote the corresponding padding-fail to info (like hug-width). Empty/flex-start → no demotion
// (a real defect stays ❌). start/end = the beginning/end of the MAIN axis (= startName/endName).
// getComputedStyle().justifyContent returns the specified keyword REGARDLESS of display (block/inline/
// table keep it as an inert ghost value) — but only a flex/grid formatting context actually
// distributes free space along the main axis. Demoting on the jc value alone (without display) would hide
// a REAL padding defect behind a false note "free space distributed" on a block container with
// a leaked utility class, or at a breakpoint where display:flex→block but justify-content was not reset.
const FLEX_GRID_DISPLAY = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

function justifyDistribution(jc: string | undefined): { start: boolean; end: boolean } {
  switch (jc) {
    case 'space-between': return { start: false, end: true };
    case 'space-around': case 'space-evenly': case 'center': return { start: true, end: true };
    case 'flex-end': case 'end': return { start: true, end: false };
    default: return { start: false, end: false };
  }
}

function applyJustifyDemote(row: DiffRow, demote: boolean, jc: string | undefined, edge: string): DiffRow {
  if (!demote || row.status !== 'fail') return row;
  return { ...stripSrc(row), status: 'demoted',
    note: [row.note, `justify-content spacer: ${jc} — ${edge} is informative (free space distributed), not a padding defect`]
      .filter(Boolean).join('; ') };
}

function overlayWidthRow(expected: number, domInnerWidth: number): DiffRow {
  const delta = round1(Math.abs(expected - domInnerWidth));
  const tol = widthNoiseTolerance(expected);
  const inTolerance = delta <= tol;
  return {
    prop: 'overlay_width', figma: round1(expected), dom: round1(domInnerWidth),
    ...(delta > 0 ? { delta } : {}),
    status: inTolerance ? 'info' : 'warn',
    note: inTolerance
      ? 'fixed overlay: the window width is close to the expected overlay width'
      : 'fixed overlay: the window width is far from the expected overlay width — check the breakpoint variant (find_breakpoint_variant)',
  };
}

// The children_truncated row used to check only the ROOT level of the pair
// (spec.childrenTruncated || d.childrenTruncated) — truncation on a nested node DEEPER than the direct
// figKids/domKids2 was silent. The recursive scan is symmetric with anyTruncated in suggest-pairs-tool.ts
// and with the already-readable collectFigTexts/collectDomTexts below — just applied to the warning row itself,
// not only to the typography auto-descent geometry. A structural type (not any) — SpecChild and DomChild
// are both compatible with it (childrenTruncated?:boolean + children?: its own type[]).
interface TruncNode { childrenTruncated?: boolean; children?: readonly TruncNode[] }
const anyTruncDeep = (kids: readonly TruncNode[] | undefined): boolean =>
  (kids ?? []).some((k) => k.childrenTruncated === true || anyTruncDeep(k.children));

// The single exported entry point — the profile filter is applied to ANY output of
// diffPairRows (including the early snapshot/structural returns: there all rows are pass-through category —
// the filter is identity, but the guarantee is by CATEGORY, not by position).
export function diffPair(spec: LayoutSpec, dom: DomSnapshot, opts: DiffOptions): DiffRow[] {
  const rows = diffPairRows(spec, dom, opts);
  return opts.profile === 'layout' ? applyLayoutProfileScope(rows) : rows;
}

function diffPairRows(spec: LayoutSpec, dom: DomSnapshot, opts: DiffOptions): DiffRow[] {
  if (dom.status && dom.status !== 'ok') {
    return [{ prop: 'snapshot', figma: null, dom: dom.status, status: 'warn',
      note: `selector ${dom.selector ?? '?'}: ${dom.status} — check the mapping/UI state` }];
  }
  const d = dom as DomSnapshotOk;
  const rows: DiffRow[] = [];

  const contentMode = d.paddings !== undefined;
  if (!contentMode) {
    rows.push({ prop: 'extractor_outdated', status: 'warn',
      note: 'snapshot without paddings — metrics in border-box mode; re-call get_layout_spec {include_extractor:true} and update the script' });
  }

  // ── Geometry gate ──
  const reasons: string[] = [];
  if (spec.rotated) reasons.push('rotated node — AABB unreliable');
  if (!spec.rect) reasons.push('no bbox (Figma)');
  if (spec.rect && (spec.rect.w < 1 || spec.rect.h < 1)) reasons.push('rect≈0 (Figma) — likely hidden/collapsed');
  if (d.rect.w < 1 || d.rect.h < 1) reasons.push('rect≈0 (DOM) — likely hidden/closed state');
  if (d.transformed) reasons.push('transform≠none — wait for the animation to finish');
  if (d.scroll.top !== 0 || d.scroll.left !== 0) reasons.push('scroll≠0 — reset the container scroll');
  const viewportOff = opts.frameWidth !== undefined &&
    Math.abs(d.innerWidth - opts.frameWidth) > widthNoiseTolerance(opts.frameWidth);
  // A fixed overlay decouples the window and the frame — "viewport ≠ frame" stops being a signal
  // (overlay_width below takes over this role). Without expectedOverlayWidth the reason stays,
  // the text is augmented with a hint — P2 without a duplicate row.
  if (viewportOff && opts.expectedOverlayWidth === undefined) {
    reasons.push(`viewport ${d.innerWidth} vs frame ${opts.frameWidth} — adjust the window width OR pass ` +
      'expected_overlay_width (fixed overlay) / check the breakpoint variant (find_breakpoint_variant)');
  }

  if (reasons.length) {
    // (b) viewport ergonomics: for a viewport reason the row carries STRUCTURAL
    // numbers, so nothing has to read the prose to get THEM. The note is not prose-free, though, and
    // the blanket claim that used to sit here was wrong: verification.ts:248 tests
    // `(r.note ?? '').includes('viewport')` to route this row to fix_viewport rather than
    // resolve_skip, so that ONE word is load-bearing — drop it from the reason text and the blocking
    // item silently changes kind. Other geometry reasons carry no fields (nothing to carry).
    rows.push({ prop: 'geometry', status: 'unchecked', note: reasons.join('; '),
      ...(viewportOff && opts.expectedOverlayWidth === undefined
        ? { figma: opts.frameWidth, dom: d.innerWidth } : {}) });
  } else {
    // With expectedOverlayWidth the viewport row is not emitted at all: the suppressed viewport reason
    // makes this branch reachable with off-tolerance numbers, and a hardcoded 'pass' on them is a second,
    // contradicting signal next to the preflight warn. overlay_width fully takes over the viewport role.
    if (opts.frameWidth !== undefined && opts.expectedOverlayWidth === undefined) {
      // The row measures the WINDOW and that stays true, but on a page with a classic scrollbar the
      // CSS canvas is narrower than the window, and a bare "viewport ✅ 1920 vs 1920" next to an
      // 11px width shortfall reads as "the window is exactly right, so your CSS is wrong". Naming
      // the layout viewport here is what makes the demote below legible as a capture artifact
      // instead of a special case. Status stays pass: the window IS the requested width.
      const lv = d.layoutViewportWidth;
      const gut = lv !== undefined ? round1(d.innerWidth - lv) : 0;
      rows.push({ prop: 'viewport', figma: opts.frameWidth, dom: d.innerWidth, status: 'pass',
        ...(gut > 0 ? { note: `CSS layout viewport ${round1(lv!)} — a ${gut}px page scrollbar gutter is inside the window width, and every full-bleed box is laid out in the narrower number` } : {}) });
    }
    rows.push(...geometryRows(spec, d, opts));
  }

  if (opts.expectedOverlayWidth !== undefined) {
    rows.push(overlayWidthRow(opts.expectedOverlayWidth, d.innerWidth));
  }

  rows.push(...descriptiveRows(spec, d, opts));
  return rows;
}

function geometryRows(spec: LayoutSpec, d: DomSnapshotOk, opts: DiffOptions): DiffRow[] {
  const rows: DiffRow[] = [];
  const rect = spec.rect!;
  const tol = opts.tolerancePx;
  // structTol — the tolerance of STRUCTURAL detectors (robustness to sub-pixel
  // fractions), clamped from below at 1px. strict (tol=0) tightens the MEASUREMENTS (numRow — raw tol), but NOT
  // the internal robustness of the detectors: otherwise tol=0 tears the layout apart on getBoundingClientRect
  // fractions (a false-alarm class). structTol==tol for any tol>=1 (default/token-aware) → byte-for-byte.
  const structTol = Math.max(opts.tolerancePx, 1);
  const contentMode = d.paddings !== undefined;
  const eff = (p: Edges | undefined): Edges | undefined => (contentMode ? p : undefined);

  // E (hug-vs-fill): the Figma root hugs the width (hugWidth), while the DOM is physically wider (fill to the parent).
  // Detection by the outer rects (robust to the paddings/scrollbar refinements of size.w). Gate on hugWidth:
  // fixed-width + wider DOM = a real defect (not demoted). Affects size.w (any axis) and, for row
  // (width = main axis), the main-axis padding + gap (see hugFillMainAxis below).
  // structTol (not raw tol): the hug-fill DETECTION threshold — under strict tol=0 a sub-pixel overshoot must
  // not be classified as a fill demotion (otherwise it is SOFTER, false-green risk); a real fill is >1px.
  const containerHugFill = spec.hugWidth === true && d.rect.w > rect.w + structTol;

  // page scrollbar gutter — see pageGutterOf. Undefined unless the pair root IS the layout viewport
  // (width AND anchoring), so a nested/max-width/sidebar pair keeps every fail it has today.
  const pageGutter = pageGutterOf(d, structTol);

  // (1) Cardinality-repair unwrap — BEFORE the size rows: unwrapBase (5.4) switches size to border-box.
  let figKids: SpecChild[] = spec.children;
  let domKids2: DomChild[] = d.children;
  let unwrapInfo: { side: 'figma' | 'dom'; chain: string[]; figWrapper?: SpecChild; domWrapper?: DomChild } | undefined;
  let rejectedNote: string | undefined;

  if (spec.axis) {
    const axis = spec.axis;
    domKids2 = [...d.children].sort((a, b) => start(a.rect, axis) - start(b.rect, axis));
    if (figKids.length !== domKids2.length) {
      const res = tryUnwrap(figKids, domKids2, axis, structTol); // structural: overlap gate for the substitutes
      if (res.ok) { figKids = res.fig; domKids2 = res.dom; unwrapInfo = res.info; }
      else rejectedNote = res.rejected;
    }
  }
  const unwrapBase = unwrapInfo !== undefined;

  // D-size: the pair root is a hug-width TEXT (not textFixedWidth) → the size.w fail is demoted to
  // info (see applyTextWidthOverride). A fixed-width TEXT does NOT pass the gate — stays a fail.
  const textWidthDemote = spec.textNode === true && spec.textFixedWidth !== true;

  // (2) size rows
  if (unwrapBase) {
    const scrollbarW = (d.clientWidth !== undefined)
      ? Math.max(0, d.rect.w - d.borders.left - d.borders.right - d.clientWidth) : 0;
    rows.push(applyOverlayWidthOverride(
      applyContainerHugFillDemote(applyTextWidthOverride(applyPageGutterDemote(numRow('size.w', rect.w, d.rect.w - scrollbarW, tol, undefined, SRC_ROOT_LAYOUT), pageGutter), textWidthDemote), containerHugFill),
      opts.expectedOverlayWidth,
    ));
  } else if (d.paddings !== undefined && d.clientWidth !== undefined) {
    const scrollbarW = Math.max(0, d.rect.w - d.borders.left - d.borders.right - d.clientWidth);
    const domW = d.rect.w - scrollbarW - d.paddings.left - d.paddings.right;
    rows.push(applyOverlayWidthOverride(
      applyContainerHugFillDemote(
        applyTextWidthOverride(
          applyPageGutterDemote(
            numRow('size.w', rect.w - (spec.autoLayout ? spec.autoLayout.padding.left + spec.autoLayout.padding.right : 0), domW, tol, undefined, SRC_ROOT_LAYOUT),
            pageGutter,
          ),
          textWidthDemote,
        ),
        containerHugFill,
      ),
      opts.expectedOverlayWidth,
    ));
  } else {
    rows.push(applyOverlayWidthOverride(
      applyContainerHugFillDemote(applyTextWidthOverride(applyPageGutterDemote(numRow('size.w', rect.w, d.rect.w, tol, undefined, SRC_ROOT_LAYOUT), pageGutter), textWidthDemote), containerHugFill),
      opts.expectedOverlayWidth,
    ));
  }
  const scrollable = d.scrollHeight !== undefined && d.clientHeight !== undefined && d.scrollHeight > d.clientHeight + 2;
  if (scrollable) {
    rows.push({ prop: 'size.h', status: 'skip', note: `scroll container: content height ${d.scrollHeight}px — comparing the frame height is uninformative` });
  } else if (unwrapBase) {
    const scrollbarH = (d.clientHeight !== undefined)
      ? Math.max(0, d.rect.h - d.borders.top - d.borders.bottom - d.clientHeight) : 0;
    rows.push(numRow('size.h', rect.h, d.rect.h - scrollbarH, tol, undefined, SRC_ROOT_LAYOUT));
  } else if (d.paddings !== undefined && d.clientHeight !== undefined) {
    const scrollbarH = Math.max(0, d.rect.h - d.borders.top - d.borders.bottom - d.clientHeight);
    const domH = d.rect.h - scrollbarH - d.paddings.top - d.paddings.bottom;
    rows.push(numRow('size.h', rect.h - (spec.autoLayout ? spec.autoLayout.padding.top + spec.autoLayout.padding.bottom : 0), domH, tol, undefined, SRC_ROOT_LAYOUT));
  } else {
    rows.push(numRow('size.h', rect.h, d.rect.h, tol, undefined, SRC_ROOT_LAYOUT));
  }

  // (3) no auto-layout — inter-element metrics are not computed (unwrap was not applied either)
  if (!spec.axis) {
    rows.push({ prop: 'children', status: 'skip', note: 'node without auto-layout — inter-element metrics are not computed' });
    return rows;
  }
  const axis = spec.axis;

  // (4) structure_mismatch — over figKids/domKids2 (after the unwrap attempt). A2 SALVAGE: instead of totally
  // skipping ALL child metrics — match the children by content (matchChildrenOneLevel) and diff ONLY the
  // high-conf subset (text anchor / strong size+order). medium/low → unmatched (zero confident-wrong
  // on a wrong match). Gaps — only between matches ADJACENT-in-both (otherwise a gap through an unmatched one);
  // padding-start/end are skipped under salvage (the full set of children is needed — see crossAndPaddingRows).
  let salvaged = false;
  let salvageAdj: boolean[] = [];
  if (figKids.length !== domKids2.length) {
    const domDescOf = (ks: DomChild[]): string => ks.map((c) => (c.tag ? `${c.tag}${c.classList?.length ? '.' + c.classList[0] : ''}` : `text:"${c.text ?? ''}"`)).join(', ');
    const sal = matchChildrenOneLevel(figKids, domKids2, { w: rect.w, h: rect.h }, { w: d.rect.w, h: d.rect.h });
    const high = sal.matched.filter((m) => m.confidence === 'high');
    if (high.length === 0) {
      const figDesc = figKids.map((c) => `${c.name}(${c.type})`).join(', ');
      // Phase-0 was muted by a content-unknown sibling — a no-op must not be mute:
      // the actionable tail says WHAT to do. When the phase is NOT muted (there simply
      // are no unique S) there is no tail — honest. Final analysis: the mute comes from
      // TWO causes, and the promise "raise max_depth" is true for ONLY one of them — a single note
      // would mis-attribute the cause (a soft false navigation, the same class as false leaf-typography):
      // - 'truncation' (childrenTruncated — CAPTURE truncation by depth/budget) → a drill REALLY
      //   helps, the promise is honest;
      // - 'longtext' (text ≥SNIPPET_CAP chars — a FULL long text, the snippet is structurally cut at
      //   SNIPPET_CAP) → the cut is insurmountable by a drill (fetching deeper gives the same SNIPPET_CAP cut), the promise would be false.
      const drillHint = sal.nestedAnchorMuted === 'truncation'
        ? '; children truncated by depth/budget — raise max_depth (the Figma side is from cache) and re-extract deeper: the nested-text recovery will fire on the full capture'
        : sal.nestedAnchorMuted === 'longtext'
        ? `; a sibling has text ≥${SNIPPET_CAP} chars — the nested-text anchor is unresolvable (snippets are cut at ${SNIPPET_CAP}), a drill will not help; verify this container visually or add pairs on the nested nodes`
        : '';
      rows.push({ prop: 'structure_mismatch', status: 'warn',
        figma: `${figKids.length} children: ${figDesc}`, dom: `${domKids2.length} children: ${domDescOf(domKids2)}`,
        note: `the count of visible children does not match — pairwise metrics skipped; refine the pair or add pairs on the nested nodes${drillHint}${rejectedNote ? `; ${rejectedNote}` : ''}` });
      // source-hint: unpaired — the MAIN "add pairs" flow (0 high-conf: nothing
      // matched). All DOM children are unpaired; cap 10 AT the collection site. navigation-to-investigate.
      collectUnpaired(opts, domKids2);
      return rows;
    }
    const matchedFig = new Set(high.map((m) => m.figIdx));
    const matchedDom = new Set(high.map((m) => m.domIdx));
    const unFig = figKids.filter((_, i) => !matchedFig.has(i)).map((c) => c.name).join(', ') || '—';
    const unDom = domKids2.filter((_, i) => !matchedDom.has(i)).map((c) => childLabel(c)).join(', ') || '—';
    // source-hint: unpaired — the unmatched DOM children (those in unDom above). We collect them
    // BEFORE reassigning domKids2:=domSub (:below), cap 10 at the collection site. The read-only .filter gives a new array.
    collectUnpaired(opts, domKids2.filter((_, i) => !matchedDom.has(i)));
    rows.push({ prop: 'structure_mismatch', status: 'warn',
      figma: `${figKids.length} children`, dom: `${domKids2.length} children`,
      note: `the child count does not match — ${high.length} high-conf matched by content (their metrics below), gaps through unmatched ones skipped; unpaired: figma [${unFig}] / dom [${unDom}] — add pairs for them${rejectedNote ? `; ${rejectedNote}` : ''}` });
    const figSub = high.map((m) => figKids[m.figIdx]);
    const domSub = high.map((m) => domKids2[m.domIdx]);
    salvageAdj = high.map((m, k) => k > 0 && m.figIdx === high[k - 1].figIdx + 1 && m.domIdx === high[k - 1].domIdx + 1);
    figKids = figSub; domKids2 = domSub; salvaged = true;
  }
  if (unwrapInfo) {
    rows.push({ prop: 'unwrapped', figma: unwrapInfo.side, dom: unwrapInfo.chain.join(' → '), status: 'pass',
      note: 'single wrappers unwrapped (cardinality-repair) — their paddings entered the metrics; the pair root paddings are NOT subtracted in the MAIN-axis padding rows (cross-offset — content-edge as usual)' });
  }

  // (5) empty-check, truncation, monotonicity, gap loop, crossAndPaddingRows
  if (figKids.length === 0) return rows;

  // Recursively over BOTH sides (figKids/d.children) — not only the pair's root level.
  if (spec.childrenTruncated || d.childrenTruncated || anyTruncDeep(figKids) || anyTruncDeep(d.children)) {
    rows.push({ prop: 'children_truncated', status: 'warn',
      note: 'the tail of children beyond the cap/depth was not checked (childrenTruncated at the pair level or deeper)' });
  }

  // Monotonicity of the DOM children along the Figma axis (in DOM document order, BEFORE sorting).
  // Under a dom-side unwrap the document order of the substitutes is unavailable, and overlaps are already
  // covered by the post-check in expand(); under a figma-side unwrap (and without unwrap) the dom side is
  // NOT checked by the post-check — the guard must stay.
  // Under salvage — SKIP: the guard iterates the RAW d.children (not the matched subset), would catch a non-monotonicity
  // on the UNmatched children and do an early-return, wiping the already-promised salvage rows (a self-contradiction:
  // the structure_mismatch warn said "metrics below", but they are gone). The skip does NOT introduce false-green: gaps under
  // salvage are limited to salvageAdj (fig- AND dom-adjacent on the sorted domKids2) AND are skipped on a
  // main-axis overlap (wrap/reflow, below), while a residual 2D drift falls into offset-cross → the verdict is
  // non-green. (Sorting by main-start does NOT prove single-row — hence the extra wrap-skip in the loop.)
  if (!salvaged && unwrapInfo?.side !== 'dom') {
    for (let i = 1; i < d.children.length; i += 1) {
      // structural guard (structTol, not raw tol): under strict tol=0 a sub-pixel non-monotonicity of the
      // document order must not fabricate a layout_axis_mismatch (a false-alarm class).
      if (start(d.children[i].rect, axis) < start(d.children[i - 1].rect, axis) - structTol) {
        rows.push({ prop: 'layout_axis_mismatch', status: 'fail',
          note: 'DOM children are not laid out along the Figma-layout axis (wrap or a different direction?) — gaps are not computed' });
        return rows;
      }
    }
  }

  // children-reorder: a content detector of a reorder of equal-count children —
  // STRICTLY after the monotonicity guard (wrap/multi-row prefilter: interleaving the sort would give
  // a massive false reorder on a correct grid) and only on the non-salvage path
  // (salvage is bijective by construction). movedIdx gates gaps (on both sides) and offset-cross/
  // typography (via the crossAndPaddingRows parameter). Paddings and container size are non-indexed,
  // not touched. muted/undefined → status quo (silence is not an assertion of order).
  // Alignment note: movedIdx indexes the detector's sorted space; alignment
  // with figKids relies on the projector's pre-sort (the same invariant as the existing
  // offset-cross zip figKids[i]↔domKids2[i] below) — the detector's defensive sort is idempotent
  // for this call, does not diverge from the figKids order.
  let movedIdx: Set<number> | undefined;
  if (!salvaged) {
    // structural (structTol): the detector's tol-tie cushion is clamped at 1px — under strict tol=0 close
    // (sub-pixel) main-start neighbors would otherwise stop counting as a "tie", and the stable-sort
    // tie-break would give a false children_reorder on a correct layout (mutation "cushion=tol" → RED).
    const reorder = detectChildrenReorder(figKids, domKids2, structTol, axis);
    if (reorder !== undefined && 'moved' in reorder) {
      // BLOCKER: skip by the UNION of the sides — on a PARTIAL bijection (fig[0]→dom[2], while fig[2]
      // has no anchor due to duplicates) dom position 2 carries shifted content and is cross-used by the zip;
      // skipping by figIdx only would leak mis-attributed metrics (the "skipped" note would be lying).
      // Over-skip is impossible: every domIdx of a moved pair is by definition a slot with shifted content.
      movedIdx = new Set(reorder.moved.flatMap((m) => [m.figIdx, m.domIdx]));
      const shown = reorder.moved.slice(0, 5)
        .map((m) => `fig[${m.figIdx}]«${m.text}» found at position dom[${m.domIdx}] (expected dom[${m.figIdx}])`).join('; ');
      const more = reorder.moved.length > 5 ? `; and ${reorder.moved.length - 5} more` : '';
      rows.push({ prop: 'children_reorder', status: 'fail', figma: 'child order', dom: 'reordered',
        note: `${shown}${more} — the child order diverges from the layout; fix the order and re-run the check; pairwise metrics of the affected ones are skipped` });
    }
  }

  // E (hug-vs-fill): width = the MAIN axis only for row → then the main-axis gap/padding are affected by
  // the stretch. For col the width = the cross axis (the main vertical gap/padding is not affected by the horizontal fill).
  const hugFillMainAxis = containerHugFill && axis === 'row';

  // source-hint: children attribution STRICTLY here — AFTER the early-returns
  // (figKids.length===0, layout_axis_mismatch), reorder and the stabilization of figKids/domKids2 (post-unwrap/
  // salvage). The index space = the same one carried by the gap[i-1]/offset-cross[i] rows below (a pair
  // without per-child rows does NOT carry children hints). classList is taken from the MATCHED domKids2[i] (under
  // salvage that is domSub[i] — the matched node, not the raw d.children[i] by index). read-only: domKids2
  // is already a copy ([...d.children].sort / high.map), figKids is spec.children or figSub (.map).
  if (opts.attributionOut) {
    opts.attributionOut.children = figKids.map((c, i) => ({
      i, name: childLabel(c),
      ...(domKids2[i]?.classList ? { classList: domKids2[i].classList } : {}),
    // children_reorder: a moved slot has NO per-child rows (gap :543 / offset-cross / typography
    // skip movedIdx) and the zip figKids[i]↔domKids2[i] there is GEOMETRIC, not content-based —
    // a hint would lead to a real but WRONG file (false-navigation): we exclude the slot.
    })).filter((entry) => !(movedIdx?.has(entry.i)));
  }

  for (let i = 1; i < figKids.length; i += 1) {
    if (movedIdx !== undefined && (movedIdx.has(i) || movedIdx.has(i - 1))) continue; // children-reorder: gap through a reordered one is not computed (both sides)
    if (salvaged && !salvageAdj[i]) continue; // salvage: gap through an unmatched child — not computed (would span it)
    // Wrap/reflow under salvage: the matched dom children OVERLAP on the MAIN axis (after sorting by
    // main-start they became neighbors, but they occupy one main range in different cross bands) → the main gap would span
    // a row boundary = a meaningless number with a mis-attributed cause. Skip; the real 2D drift goes into offset-cross.
    if (salvaged && start(domKids2[i].rect, axis) < end(domKids2[i - 1].rect, axis) - structTol) { // structural: main-axis overlap (wrap/reflow) — robust to fractions, not a measurement
      rows.push({ prop: `gap[${i - 1}] ${childLabel(figKids[i - 1])}↔${childLabel(figKids[i])}`, status: 'skip',
        note: 'DOM children overlap on the main axis (wrap/reflow) — the gap across the row boundary is not computed (see offset-cross)' });
      continue;
    }
    let figGap: number; let domGap: number; let gapNote: string | undefined;
    if (hugFillMainAxis) {
      // The content is pinned in a stretched container — content-edge would include the child's OWN padding
      // (a DS component's is internal, Figma's lies deeper → a false ❌ 8 vs 8+pad+pad). The mutual positions
      // of the children are known → we measure the gap by the BORDER-BOX of both sides.
      figGap = start(figKids[i].rect, axis) - end(figKids[i - 1].rect, axis);
      domGap = start(domKids2[i].rect, axis) - end(domKids2[i - 1].rect, axis);
      gapNote = 'border-box (the container is stretched hug/fill — the children\'s own padding is not subtracted)';
    } else {
      figGap = (start(figKids[i].rect, axis) + padStart(eff(figKids[i].paddings), axis))
        - (end(figKids[i - 1].rect, axis) - padEnd(eff(figKids[i - 1].paddings), axis));
      domGap = (start(domKids2[i].rect, axis) + padStart(eff(domKids2[i].paddings), axis))
        - (end(domKids2[i - 1].rect, axis) - padEnd(eff(domKids2[i - 1].paddings), axis));
    }
    const label = `gap[${i - 1}] ${childLabel(figKids[i - 1])}↔${childLabel(figKids[i])}`;
    // page gutter: only a HORIZONTAL main axis spends the width the gutter took (measured, space-between
    // at 1920: fig 1320 / dom 1309). On axis='col' the gap is vertical and the gutter cannot touch it.
    // A pointer, never an allowance — the gap moves only while the main axis DISTRIBUTES free space,
    // which this capture does not measure, so an 11px gap regression stays an 11px fail (see SCOPE).
    rows.push(notePageGutter(withNote(numRow(label, figGap, domGap, tol, undefined, SRC_ROOT_LAYOUT), gapNote),
      axis === 'row' ? pageGutter : undefined));
  }

  rows.push(...crossAndPaddingRows(spec, d, opts, figKids, domKids2, unwrapBase, hugFillMainAxis, unwrapInfo?.figWrapper, unwrapInfo?.domWrapper, salvaged, movedIdx));
  return rows;
}

const MAX_UNWRAP_RESULT = 10;

type Unwrappable<T> = { children?: T[]; childrenTruncated?: boolean; kind?: string };

// Cardinality-repair: unwraps ONE single wrapper (fig OR dom, not both) into its
// visible children, if that yields a matching child count on the other side. A strict
// post-check (kind/cut/emptiness/overlaps/cap) — full rollback on any refusal.
function tryUnwrap(fig: SpecChild[], dom: DomChild[], axis: 'row' | 'col', tol: number):
  { ok: true; fig: SpecChild[]; dom: DomChild[]; info: { side: 'figma' | 'dom'; chain: string[]; figWrapper?: SpecChild; domWrapper?: DomChild } }
  | { ok: false; rejected?: string } {
  let f = fig; let dm = dom;
  let usedFig = false; let usedDom = false;
  const chain: string[] = [];
  let side: 'figma' | 'dom' | undefined;
  let figWrapper: SpecChild | undefined;
  let domWrapper: DomChild | undefined;

  const expand = <T extends Unwrappable<T> & { rect: SpecRect }>(wrapper: T, label: string):
    { ok: true; kids: T[] } | { ok: false; rejected: string } => {
    if (wrapper.kind === 'text') return { ok: false, rejected: `unwrap attempted: ${label} → rejected: text node` };
    if (wrapper.children === undefined) return { ok: false, rejected: `unwrap attempted: ${label} → rejected: children beyond the capture cut` };
    if (wrapper.childrenTruncated) return { ok: false, rejected: `unwrap attempted: ${label} → rejected: level truncated by a cap` };
    if (wrapper.children.length === 0) return { ok: false, rejected: `unwrap attempted: ${label} → rejected: wrapper is empty` };
    const kids = [...wrapper.children].sort((a, b) => start(a.rect, axis) - start(b.rect, axis));
    for (let i = 1; i < kids.length; i += 1) {
      if (start(kids[i].rect, axis) < end(kids[i - 1].rect, axis) - tol) {
        return { ok: false, rejected: `unwrap attempted: ${label} → rejected: substitutes overlap along the axis (grid/different axis?)` };
      }
    }
    return { ok: true, kids };
  };

  for (let iter = 0; iter < 2 && f.length !== dm.length; iter += 1) {
    if (f.length === 1 && dm.length > 1 && !usedFig) {
      const r = expand(f[0], f[0].name);
      if (!r.ok) return { ok: false, rejected: r.rejected };
      figWrapper = f[0];
      chain.push(f[0].name); f = r.kids; usedFig = true; side = side ?? 'figma';
    } else if (dm.length === 1 && f.length > 1 && !usedDom) {
      const label = dm[0].tag ?? 'text';
      const r = expand(dm[0], label);
      if (!r.ok) return { ok: false, rejected: r.rejected };
      domWrapper = dm[0];
      chain.push(label); dm = r.kids; usedDom = true; side = side ?? 'dom';
    } else break;
  }
  if (f.length !== dm.length || !side) return { ok: false, ...(chain.length ? { rejected: `unwrap attempted: ${chain.join(' → ')} → rejected: cardinalities did not match` } : {}) };
  if (f.length > MAX_UNWRAP_RESULT) return { ok: false, rejected: `unwrap attempted: ${chain.join(' → ')} → rejected: result > ${MAX_UNWRAP_RESULT} children` };
  // A double unwrap is unreachable: the second iteration requires length===1 on the UNTOUCHED side,
  // and it did not change and was >1 — usedFig/usedDom only work as branching guards.
  return { ok: true, fig: f, dom: dm, info: { side, chain, ...(figWrapper ? { figWrapper } : {}), ...(domWrapper ? { domWrapper } : {}) } };
}

const crossStart = (r: SpecRect, axis: 'row' | 'col'): number => (axis === 'row' ? r.y : r.x);

const padStart = (p: Edges | undefined, axis: 'row' | 'col'): number => (p ? (axis === 'row' ? p.left : p.top) : 0);
const padEnd = (p: Edges | undefined, axis: 'row' | 'col'): number => (p ? (axis === 'row' ? p.right : p.bottom) : 0);
const padCross = (p: Edges | undefined, axis: 'row' | 'col'): number => (p ? (axis === 'row' ? p.top : p.left) : 0);

// E: a join-note, does not overwrite the existing note (the order with applyTextWidthOverride matters:
// this note is set FIRST, the D-demotion is SECOND, joined on top if it fires).
function withNote(row: DiffRow, note: string | undefined): DiffRow {
  if (!note) return row;
  return { ...row, note: [row.note, note].filter(Boolean).join('; ') };
}

// The magnitude is the fig side (what the designer intended): a non-zero padding of a participating
// fig child explains why the padding row is not equal to the "bare" gap to the container edge.
// Only if the fig side is 0 — the DOM child's (participating) padding is the sole source of the
// discrepancy, a separate wording (without childLabel — the fig child's label is irrelevant here).
function paddingProvenanceNote(figPad: number, domPad: number, label: string): string | undefined {
  if (figPad !== 0) return `includes the child's padding ${round1(figPad)}px (${label})`;
  if (domPad !== 0) return `includes the DOM child's padding ${round1(domPad)}px`;
  return undefined;
}

function firstFamily(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
}

const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

// Segments of a variant name: split by ',', trim, empties dropped BEFORE classification
// (a trailing comma 'Type=Active,' would otherwise be mis-attributed as "short/numeric").
const segs = (name: string | undefined): string[] =>
  (name ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
// A segment is a prop if '=' is surrounded by non-empty sides: closes charset hole F4
// ('State=On/Off','Size=1.5x','Opacity=50%'), without counting degenerate '=x'/'foo=' as a prop.
const isPropSeg = (s: string): boolean => /\S=\S/.test(s);
const isPropOnlyName = (name: string | undefined): boolean => {
  const ss = segs(name);
  return ss.length > 0 && ss.every(isPropSeg);
};
// The non-prop segments of the name are the only identity part of the name (props NEVER match).
const identityParts = (name: string | undefined): string =>
  segs(name).filter((s) => !isPropSeg(s)).join(' ');
// Casing-aware tokens in TWO categories: base — solid (highly specific, match one-by-one,
// the prior semantics); derived — camelCase-split parts ('listItem'→'list','item'), generics —
// go green only on co-occurrence ≥2 (a single hit = false-green 'listItem'×<ul class="list">).
// Latin-only deliberately: the Cyrillic set stays on the honest-info branch.
const tokensCased = (s: string): { base: string[]; derived: string[] } => {
  const base = tokens(s);
  const split = tokens(s.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
  return { base, derived: split.filter((t) => !base.includes(t)) };
};

// ── Typography auto-descent ──
// Both sides ALREADY carry TEXT descendants (SpecChild.textSnippet / DomChild kind:'text'
// + text) — instead of manual +N TEXT pairs per card we match them by content (collection below) right
// in the existing parent pair.
export const normSnippet = (s: string): string => s.trim().replace(/\s+/g, ' ');

interface FigText { snippet: string; typo: SpecTypography; label: string }
// classListChain (source-hint): the classLists of the text node's ANCESTORS bottom-up (immediate
// parent first), cap 4 — the tool picks the nearest PARSEABLE one (the parser does NOT leak into diff).
interface DomText { snippet: string; node: DomChild; classListChain: string[][] }
interface Collected<T> { items: T[]; truncated: boolean }

// source-hint: the depth cap of the DOM-text ancestor chain for the source hint.
const CLASS_CHAIN_CAP = 4;

// DFS over c.children (tree order); truncated=true as soon as the collected nodes reach
// MAX_TEXT_DESCENT (the tail of the tree beyond the cap is not inspected — ordinal matching is
// unprovable), OR if childrenTruncated is set on any visited level (the projection
// actually cut a level — the same unprovability signal, even if the cap itself is not reached).
function collectFigTexts(c: SpecChild, maxDescent: number): Collected<FigText> {
  const items: FigText[] = [];
  let truncated = false;
  let stopped = false;
  const visit = (node: SpecChild): void => {
    if (stopped) return;
    if (node.childrenTruncated) truncated = true;
    for (const kid of node.children ?? []) {
      if (stopped) return;
      if (kid.textSnippet !== undefined && kid.text) {
        items.push({ snippet: kid.textSnippet, typo: kid.text, label: kid.textSnippet.slice(0, 20) });
        if (items.length >= maxDescent) { truncated = true; stopped = true; return; }
      }
      visit(kid);
    }
  };
  visit(c);
  return { items, truncated };
}

// A symmetric DFS over the DOM side: kind === 'text' nodes with text (the extractor puts the parent's
// styles on them — the typography by the immediate parent is already correct for nested text nodes).
function collectDomTexts(c: DomChild, maxDescent: number): Collected<DomText> {
  const items: DomText[] = [];
  let truncated = false;
  let stopped = false;
  // ancestors — the classLists of node's ancestors bottom-up (node's parent first), already capped.
  // source-hint: zero new traversal — the ancestor stack is threaded onto the existing DFS.
  const visit = (node: DomChild, ancestors: string[][]): void => {
    if (stopped) return;
    if (node.childrenTruncated) truncated = true;
    // chain for node's text children: the immediate parent (node) first, then the ancestors, cap 4.
    const chainForChildren = [node.classList ?? [], ...ancestors].slice(0, CLASS_CHAIN_CAP);
    for (const kid of node.children ?? []) {
      if (stopped) return;
      if (kid.kind === 'text' && kid.text !== undefined) {
        items.push({ snippet: kid.text, node: kid, classListChain: chainForChildren });
        if (items.length >= maxDescent) { truncated = true; stopped = true; return; }
      }
      visit(kid, chainForChildren);
    }
  };
  visit(c, []);
  return { items, truncated };
}

// Hug-evidence (confirmed by live probing): proof of hug ON the DOM SIDE for
// fig columns without hugWidth (FILL — width from the parent, not from the content). The right edge
// of the dom container coincides (within tolerance tol) with the outermost text descendant ⇒ the trailing is produced
// by the natural width of the text, not a structural defect. A DOM column WIDER than its texts ⇒
// there is no proof — stays a fail (we do not hide a real padding defect).
function domHugEndEvidence(lastDom: DomChild, axis: 'row' | 'col', tol: number, maxDescent: number): boolean {
  const domTexts = collectDomTexts(lastDom, maxDescent);
  if (domTexts.items.length === 0) return false;
  const maxTextEnd = Math.max(...domTexts.items.map((t) => end(t.node.rect, axis)));
  return Math.abs(end(lastDom.rect, axis) - maxTextEnd) <= tol;
}

// "Equality" of content for phase 1: usually — an exact normSnippet equality. But if the raw snippet is
// EXACTLY SNIPPET_CAP chars on either side (collected at the cap of a SNIPPET_CAP-char projection
// slice), we compare startsWith of the minimum-length prefix — otherwise legitimate long
// paragraphs (the common case) silently miss the exact equality on the slightest tail-length asymmetry.
function sameContent(rawFig: string, rawDom: string): boolean {
  const nf = normSnippet(rawFig);
  const nd = normSnippet(rawDom);
  if (rawFig.length === SNIPPET_CAP || rawDom.length === SNIPPET_CAP) {
    const minLen = Math.min(nf.length, nd.length);
    // Degenerate-prefix guard: an empty/ultra-short text (possible only via inline-dom,
    // the canonical extractor does not emit such) would vacuously match ANY SNIPPET_CAP-char paragraph.
    if (minLen < 3) return false;
    return nf.slice(0, minLen) === nd.slice(0, minLen);
  }
  return nf === nd;
}

// The "wrong node" gate for the order path (phase 2). The order zip matches residual TEXT BY INDEX without
// a content check — if the snippets CLEARLY diverge (an input value vs a label), confident
// font-size/color are taken from the wrong node and are false (and symmetrically: an accidental size+color match
// gives a silent pass masking an unchecked node). Divergence = BOTH sides have meaningful
// tokens AND the sets are fully disjoint. Conservatively (never-false-green cuts both ways):
// a substring (reflow/SNIPPET_CAP-char slice = the same node) or a side without tokens (numbers/symbols —
// nothing to judge by) → they do NOT diverge, the metrics stay confident, a real same-content defect is not masked.
// Unicode-aware tokens (Cyrillic/Latin/digits, ≥3 chars): the existing tokens() is Latin-only
// (split by [^a-z0-9]) and gives [] on Cyrillic — useless for the content gate.
const contentTokens = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

function contentDiverged(figSnippet: string, domSnippet: string): boolean {
  const nf = normSnippet(figSnippet).toLowerCase();
  const nd = normSnippet(domSnippet).toLowerCase();
  if (nf === nd || (nd.length > 0 && nf.includes(nd)) || (nf.length > 0 && nd.includes(nf))) return false;
  const ft = new Set(contentTokens(figSnippet));
  const dt = new Set(contentTokens(domSnippet));
  if (ft.size === 0 || dt.size === 0) return false;
  for (const t of ft) if (dt.has(t)) return false; // a shared token exists → not disjoint
  return true;
}

// Phase 1: content bijection — fig[i] matches dom[j] ONLY if it is a mutually unique pair
// (the snippet occurs exactly once on each side). Duplicates (see «8 ₽»×2) are deliberately not
// matched here — they stay for phase 2 (by order) or in the remainder.
// Phase 2: the unbound remainders — only if !anyTruncated (order is unprovable when either
// side is truncated) and the remainders are equal in length and non-empty → by order.
function matchTexts(figs: FigText[], doms: DomText[], anyTruncated: boolean):
  { matched: Array<{ fig: FigText; dom: DomText; by: 'content' | 'order' }>; figRest: FigText[]; domRest: DomText[] } {
  const matched: Array<{ fig: FigText; dom: DomText; by: 'content' | 'order' }> = [];
  const usedFig = new Set<number>();
  const usedDom = new Set<number>();

  figs.forEach((f, i) => {
    const domCandidates = doms
      .map((dom, j) => ({ dom, j }))
      .filter(({ dom }) => sameContent(f.snippet, dom.snippet));
    if (domCandidates.length !== 1) return;
    const { dom, j } = domCandidates[0];
    const figCandidates = figs.filter((f2) => sameContent(f2.snippet, dom.snippet));
    if (figCandidates.length !== 1) return;
    matched.push({ fig: f, dom, by: 'content' });
    usedFig.add(i); usedDom.add(j);
  });

  const figRest = figs.filter((_, i) => !usedFig.has(i));
  const domRest = doms.filter((_, j) => !usedDom.has(j));

  if (!anyTruncated && figRest.length === domRest.length && figRest.length > 0) {
    for (let k = 0; k < figRest.length; k += 1) matched.push({ fig: figRest[k], dom: domRest[k], by: 'order' });
    return { matched, figRest: [], domRest: [] };
  }
  return { matched, figRest, domRest };
}

function crossAndPaddingRows(
  spec: LayoutSpec, d: DomSnapshotOk, opts: DiffOptions, figKids: SpecChild[], domKids: DomChild[], unwrapBase: boolean,
  hugFillMainAxis: boolean, figWrapper?: SpecChild, domWrapper?: DomChild, salvaged = false, movedIdx?: Set<number>,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const axis = spec.axis!;
  const rect = spec.rect!;
  const tol = opts.tolerancePx;
  // structTol (clamp 1px) for the DETECTOR evidence gates (domHugEndEvidence);
  // padding/offset-cross numRow are measurements, raw tol. structTol==tol at tol>=1 (byte-for-byte).
  const structTol = Math.max(opts.tolerancePx, 1);
  // descentFor(maxDepth) — see collectFigTexts/collectDomTexts/domHugEndEvidence below.
  const maxDescent = descentFor(opts.maxDepth ?? 4);
  // page scrollbar gutter (see pageGutterOf) — recomputed rather than threaded through a 12th
  // parameter. NOTE ONLY here: no row in this function has an exact gutter share (see SCOPE at
  // applyPageGutterDemote), so the rows the gutter can plausibly reach get a pointer to size.w and
  // keep their fail. Which those are is decided by which of them measure the WIDTH: on a row axis the
  // trailing padding (measured, left-anchored children at 1920: fig 1280 / dom 1269), on a col axis
  // the cross offset (measured, centred content: half the gutter, 5.5). The LEADING edge never moves
  // on either axis — domCStart is built from the left edge — so padding-start gets no note either.
  const pageGutter = pageGutterOf(d, structTol);
  const [startName, endName] = axis === 'col' ? ['padding-top', 'padding-bottom'] : ['padding-left', 'padding-right'];
  const borderStart = axis === 'col' ? d.borders.top : d.borders.left;
  const borderEnd = axis === 'col' ? d.borders.bottom : d.borders.right;
  const borderCross = axis === 'col' ? d.borders.left : d.borders.top;
  const contentMode = d.paddings !== undefined;
  const eff = (p: Edges | undefined): Edges | undefined => (contentMode ? p : undefined);

  const jc = d.styles?.justifyContent;
  // unwrapBase: GRANDCHILDREN are compared through the wrapper (cardinality-repair) — their distribution is set by
  // the WRAPPER's justify-content, while d.styles carries only the ROOT's (per-child styles = Typo, without
  // justifyContent). We do not know the wrapper's → we do NOT demote (conservatively: the fail stays, we never
  // hide — the safe side of never-false-green).
  const display = d.styles?.display;
  const isDistributingContext = display !== undefined && FLEX_GRID_DISPLAY.has(display);
  const jd = (unwrapBase || !isDistributingContext) ? { start: false, end: false } : justifyDistribution(jc);

  const figFirst = figKids[0];
  const figLast = figKids[figKids.length - 1];

  const figCStart = start(rect, axis) + (unwrapBase ? 0 : padStart(eff(spec.autoLayout?.padding), axis));
  const figCEnd = end(rect, axis) - (unwrapBase ? 0 : padEnd(eff(spec.autoLayout?.padding), axis));
  const domCStart = start(d.rect, axis) + borderStart + (unwrapBase ? 0 : padStart(eff(d.paddings), axis));
  const domCEnd = end(d.rect, axis) - borderEnd - (unwrapBase ? 0 : padEnd(eff(d.paddings), axis));

  // E: the provenance of a participating child's padding — the magnitude is taken from the fig side (what the designer
  // INTENDED), not from dom (what RESULTED) — otherwise the note would point at the symptom, not the
  // cause. Only the note (join), the padding row's numbers do not change.
  const figPadStart = padStart(eff(figFirst.paddings), axis);
  const domPadStart = padStart(eff(domKids[0].paddings), axis);
  const startNote = paddingProvenanceNote(figPadStart, domPadStart, childLabel(figFirst));
  // salvage: figFirst/figLast are not the real first/last (a subset was matched) → padding from the container
  // edge would be a false ❌. We skip padding-start/end; offset-cross/typography per-child — we keep.
  if (!salvaged) {
    rows.push(applyContainerHugFillDemote(applyJustifyDemote(withNote(
      numRow(startName, (start(figFirst.rect, axis) + figPadStart) - figCStart,
        (start(domKids[0].rect, axis) + domPadStart) - domCStart, tol, undefined, SRC_ROOT_LAYOUT),
      startNote,
    ), jd.start, jc, startName), hugFillMainAxis));
  }

  const lastDom = domKids[domKids.length - 1];
  if (!salvaged && lastDom.kind !== 'text') {
    const figPadEnd = padEnd(eff(figLast.paddings), axis);
    const domPadEnd = padEnd(eff(lastDom.paddings), axis);
    const endNote = paddingProvenanceNote(figPadEnd, domPadEnd, childLabel(figLast));
    // D-padding-end: a fig-last-TEXT hug (not textFixedWidth) → the fail is demoted to info — the same
    // artifact as D-size (the natural width of the text moves its edge, not a design defect).
    // Transitive case: a hug CONTAINER with text content — the DOM column
    // shrinks to the text, the trailing is not a defect. Both conditions are required: hug WITHOUT texts
    // (width from images/fixed children) may hide a real defect — we do NOT demote.
    // Third branch (confirmed by live probing): a FILL fig column (hugWidth is ABSENT), but
    // the DOM side PROVES hug — the right edge of the dom column coincides with the edge of its texts (within
    // tolerance) ⇒ the trailing is produced by the natural width of the text. A DOM column WIDER than its texts ⇒
    // a structural trailing (a real padding defect is possible) ⇒ stays a fail. Lazy: the short-circuit
    // || does not compute domHugEndEvidence if the first two branches already fired.
    const figTextsForEnd = collectFigTexts(figLast, maxDescent);
    const endDemote = (figLast.type === 'TEXT' && figLast.textFixedWidth !== true)
      || (figLast.hugWidth === true && figTextsForEnd.items.length > 0)
      // structTol (not raw tol): the evidence gate "dom-column edge == its text edge" — robustness
      // of the demotion detector to sub-pixel fractions under strict tol=0 (otherwise a legit text-hug → false red).
      || (figTextsForEnd.items.length > 0 && domHugEndEvidence(lastDom, axis, structTol, maxDescent));
    rows.push(applyContainerHugFillDemote(applyJustifyDemote(applyTextWidthOverride(
      notePageGutter(withNote(
        numRow(endName, figCEnd - (end(figLast.rect, axis) - figPadEnd), domCEnd - (end(lastDom.rect, axis) - domPadEnd), tol, undefined, SRC_ROOT_LAYOUT),
        endNote,
      ), axis === 'row' ? pageGutter : undefined),
      endDemote,
    ), jd.end, jc, endName), hugFillMainAxis));
  }

  // wrapper base: nested DomChild have no captured borders — we assume border≈0 for wrappers (an approximation)
  const figCrossStart = figWrapper
    ? crossStart(figWrapper.rect, axis) + padCross(eff(figWrapper.paddings), axis)
    : crossStart(rect, axis) + padCross(eff(spec.autoLayout?.padding), axis);
  const domCrossStart = domWrapper
    ? crossStart(domWrapper.rect, axis) + padCross(eff(domWrapper.paddings), axis)
    : crossStart(d.rect, axis) + borderCross + padCross(eff(d.paddings), axis);
  // The one gutter share this capture PROVES (see SCOPE at applyPageGutterDemote). A child centred in
  // the root's cross content box sits at the middle of that box on both sides, so a root that lost
  // `gutter.px` of width moves it by exactly half — and centring is a fact of the capture, not an
  // assumption: the root rect and the child rect are both here, on the Figma side and the DOM side.
  // Both sides must prove it: a child centred in the DOM but pinned in the design moved for a reason
  // that is not the gutter. Anchored to the pair ROOT only (no wrapper) — the gutter gate measured the
  // root, and a wrapper's cross box is a different, unmeasured container. Cross axis of `col` is x,
  // which is the axis the gutter is taken from; on a `row` axis the cross is y and nothing is derived.
  const cross = axis === 'col' ? 'row' : 'col';
  const centredIn = (r: SpecRect, cStart: number, cEnd: number): boolean =>
    Math.abs((start(r, cross) - cStart) - (cEnd - end(r, cross))) <= structTol;
  const figCrossEnd = end(rect, cross) - padEnd(eff(spec.autoLayout?.padding), cross);
  const domCrossEnd = end(d.rect, cross) - (axis === 'col' ? d.borders.right : d.borders.bottom) - padEnd(eff(d.paddings), cross);
  const crossGutterShare = (c: SpecChild, dk: DomChild): { px: number; note: string } | undefined => {
    if (pageGutter === undefined || axis !== 'col' || figWrapper !== undefined || domWrapper !== undefined) return undefined;
    if (!centredIn(c.rect, figCrossStart, figCrossEnd) || !centredIn(dk.rect, domCrossStart, domCrossEnd)) return undefined;
    const half = round1(pageGutter.px / 2);
    return { px: half,
      note: `centred in the pair root on both sides (leading gap == trailing gap, measured) — a page scrollbar gutter of ${pageGutter.px}px `
        + `moves a centred offset by exactly half of itself, ${half}px, and that is the whole of what is explained here (see size.w)` };
  };
  figKids.forEach((c, i) => {
    if (movedIdx?.has(i)) return; // children-reorder: a reordered slot — the offset is mis-attributed
    if (domKids[i].kind === 'text') return; // intrinsic line — the offset is not a defect
    // box-edge: the child's own padCross on BOTH sides is not subtracted (5.1) —
    // the child is compared by the fact of its position, not "content-edge within itself".
    const figOff = crossStart(c.rect, axis) - figCrossStart;
    const domOff = crossStart(domKids[i].rect, axis) - domCrossStart;
    // fix-plan: a cross offset is also fixed in the child (align-self/margin) → child(i)/layout
    // (consistent with typography[i]; a container align-items is seen by the consumer via the root's neighbors).
    const row = numRow(`offset-cross[${i}] ${childLabel(c)}`, figOff, domOff, tol, undefined, { kind: 'child', i, editKind: 'layout' });
    // The derived share goes through the SAME residual test as size.w: a centred child short by more
    // than half the gutter is short by something else, and that something else keeps its fail.
    const share = crossGutterShare(c, domKids[i]);
    const out = share !== undefined ? applyPageGutterDemote(row, share) : row;
    rows.push(out.status === 'fail' ? notePageGutter(out, axis === 'col' ? pageGutter : undefined) : out);
  });

  figKids.forEach((c, i) => {
    if (movedIdx?.has(i)) return; // children-reorder: a reordered slot — the typography is mis-attributed
    if (c.text) rows.push(...typographyRows(c.text, domKids[i], `[${childLabel(c)}]`, d.fontsLoaded, c.textFromNested, c.textUncertain,
      { kind: 'child', i, editKind: 'property' })); // fix-plan: a per-child text pair without a descent-label → child(i)
    else {
      const figs = collectFigTexts(c, maxDescent);
      const doms = collectDomTexts(domKids[i], maxDescent);
      // Depth 4: textBeyondCut used to block the descent BEFORE collectFigTexts —
      // correct while the spec tree caught at most 2 hops from c (collectTexts, in contrast, looks at the raw tree
      // without such a limit and saw "there is something deeper" exactly where the spec tree stopped). At
      // capture depth 4 the path to a TEXT (e.g. mo-typography in mo-list-item, 3 hops from c) now ACTUALLY
      // lands in spec.children — but collectTexts(c,2) (see projector.ts, below) still does not see it
      // directly (a 2-hop limit) and keeps honestly setting textBeyondCut = "not sure if there is anything
      // deeper". Previously that was equivalent to "there is no data deeper" — now it is NOT equivalent: the data
      // MAY be in c.children. So textBeyondCut (like textAmbiguous) is a signal "try
      // a full DFS descent, not a final verdict": we give collectFigTexts a chance first, skip — only
      // if BOTH (the descent and the DOM descent) came back empty, i.e. there really is no data ANYWHERE.
      if ((c.textAmbiguous || c.textBeyondCut) && (figs.items.length === 0 || doms.items.length === 0)) {
        // Fallback: the descent has nothing to work with (children absent/cut) — the prior honest skip,
        // NOT silence. The prod path is real: textAmbiguous/textBeyondCut are set from
        // the raw children, while spec-tree children may be cut by pruneToBudget/capture depth.
        rows.push({ prop: `typography[${childLabel(c)}]`, status: 'unchecked',
          note: c.textAmbiguous
            ? 'several nested TEXT, the descent did not find them in the projection slice — raise max_depth (up to 8) and re-run, or add a separate pair on the TEXT node'
            : 'no TEXT found within the depth slice — it may be deeper: raise max_depth (up to 8) and re-run, or add a pair on the nested TEXT node' });
      } else if (figs.items.length > 0) {
        const anyTruncated = figs.truncated || doms.truncated;
        const m = matchTexts(figs.items, doms.items, anyTruncated);
        for (const link of m.matched) {
          // The wrong-node gate: the order zip is by index, but the content clearly diverges → confident
          // font-size/color would be from the wrong node (or a silent pass would mask the unchecked one).
          // We do NOT show the metrics, we emit one honest warn. The wording avoids the substrings
          // 'by content'/'by order' (a consumer's naive filtering must not confuse a warn with a link).
          if (link.by === 'order' && contentDiverged(link.fig.snippet, link.dom.snippet)) {
            rows.push({ prop: `typography_descent[${childLabel(c)}→"${link.fig.label}"]`, status: 'warn',
              figma: `"${link.fig.label}" ${link.fig.typo.fontSize}px`,
              dom: `"${normSnippet(link.dom.snippet).slice(0, 20)}" ${link.dom.node.styles?.fontSize ?? '—'}px`,
              note: 'possibly a wrong node: the content of the matched TEXT diverges from the layout (e.g. an input value vs a label) — metrics not shown; add a pair on the TEXT node or raise max_depth (up to 8)' });
            continue;
          }
          // fix-plan: ONE const for the label — the rows' suffix, srcChannel.label and attributionOut.text.label
          // cannot diverge byte-for-byte by construction (the label-space co-lock in the fix-plan suite).
          const tLabel = `[${childLabel(c)}→"${link.fig.label}"]`;
          rows.push(...typographyRows(link.fig.typo, link.dom.node, tLabel, d.fontsLoaded, undefined, undefined,
            { kind: 'text', label: tLabel, editKind: 'property' })
            .map((r) => ({ ...r, note: [r.note, link.by === 'content' ? 'auto-descent: by content' : 'auto-descent: by order'].filter(Boolean).join('; ') })));
          // source-hint: the text channel — ONLY when typography rows are actually emitted
          // (a matched descent-link), label = the suffix of those rows. The ancestor chain (not the immediate parent)
          // was collected by collectDomTexts; the tool picks the nearest parseable one.
          if (opts.attributionOut) {
            (opts.attributionOut.text ??= []).push({
              label: tLabel,
              classListChain: link.dom.classListChain,
            });
          }
        }
        if (m.figRest.length) {
          rows.push({ prop: `typography_descent[${childLabel(c)}]`, status: 'warn',
            figma: `unmatched: [${m.figRest.map((f) => `"${f.label}"`).join(', ')}]`,
            dom: `[${m.domRest.map((x) => `"${normSnippet(x.snippet).slice(0, 20)}"`).join(', ')}]`,
            // The wordings deliberately do NOT contain the substrings 'by content'/'by order' —
            // a consumer's naive substring filtering must not confuse a warn with a link.
            note: anyTruncated
              ? 'the descent was truncated by the projection slice — ordinal matching is impossible; add pairs on the TEXT nodes'
              : 'TEXT descendants remained unpaired (content bijection and ordinal matching did not work) — add pairs on the TEXT nodes' });
        } else if (anyTruncated) {
          // Silent hole: ALL visible TEXT matched (figRest empty), but the capture was
          // truncated by the MAX_TEXT_DESCENT cap or childrenTruncated on a visited level — beyond the
          // ceiling there may be unchecked TEXT nodes. Previously NOTHING was emitted here
          // (m.figRest.length===0 skipped the branch above) — the absence of a check was silent. Now —
          // an explicit skip: truncation is always signaled, even when the visible part of the descent is clean.
          rows.push({ prop: `typography_descent[${childLabel(c)}]`, status: 'unchecked',
            note: 'visible TEXT matched, but the capture was truncated by the depth slice/cap — there may be unchecked TEXT deeper: raise max_depth (up to 8), or add a pair on the nested TEXT node' });
        }
      }
      // figs empty (and not the ambiguous fallback) → nothing: the Figma side has no text, a random
      // DOM text (badge/aria-label) is not a design-check signal, a warn would be filterable noise.
    }
  });
  return rows;
}

function typographyRows(
  fig: NonNullable<LayoutSpec['text']>,
  domChild: { styles?: DomChild['styles']; rect: SpecRect } | undefined,
  suffix: string,
  fontsLoaded: boolean | undefined,
  nested?: boolean,
  uncertain?: boolean,
  // fix-plan: the channel of the calling site — descent text(label), per-child child(i), root pair root.
  src?: DiffRow['srcChannel'],
): DiffRow[] {
  const st = domChild?.styles;
  if (!st) return [{ prop: `typography${suffix}`, status: 'unchecked', note: 'DOM side without computed styles' }];
  const rows: DiffRow[] = [];
  const extraNotes = [
    ...(nested ? ['typography from a nested TEXT'] : []),
    ...(uncertain ? ['exactly one TEXT found, but the path was truncated by a cap — uniqueness only within the slice'] : []),
    ...(fontsLoaded === false ? ['fonts not loaded — computed may not match the render'] : []),
  ];
  const withNote = (r: DiffRow): DiffRow => (extraNotes.length
    ? { ...r, note: [r.note, ...extraNotes].filter(Boolean).join('; ') } : r);

  if (fig.fontSize !== undefined && st.fontSize !== undefined) {
    rows.push(withNote(numRow(`font-size${suffix}`, fig.fontSize, st.fontSize, TYPO_TOLERANCE_PX, undefined, src)));
  }
  if (fig.fontWeight !== undefined && st.fontWeight !== undefined) {
    rows.push(withNote({ prop: `font-weight${suffix}`, figma: fig.fontWeight, dom: st.fontWeight,
      status: fig.fontWeight === st.fontWeight ? 'pass' : 'fail',
      ...(fig.fontWeight !== st.fontWeight && src ? { srcChannel: src } : {}) }));
  }
  const figFam = firstFamily(fig.fontFamily);
  const domFam = firstFamily(st.fontFamily);
  if (figFam && domFam) {
    rows.push(withNote({ prop: `font-family${suffix}`, figma: figFam, dom: domFam,
      status: figFam === domFam ? 'pass' : 'fail',
      ...(figFam !== domFam && src ? { srcChannel: src } : {}) }));
  }
  // line-height: both sides font-defined → pass; figma-px vs normal → warn best-effort; numbers → tolerance
  const figAuto = fig.lineHeightUnit === 'INTRINSIC_%' || fig.lineHeightPx === undefined;
  if (st.lineHeight === 'normal') {
    rows.push(withNote(figAuto
      ? { prop: `line-height${suffix}`, figma: 'auto', dom: 'normal', status: 'pass', note: 'both sides font-defined' }
      : { prop: `line-height${suffix}`, figma: fig.lineHeightPx!, dom: 'normal', status: 'warn',
          note: `line-height:normal — best-effort rect.h=${domChild!.rect.h}` }));
  } else if (st.lineHeight !== undefined) {
    if (!figAuto) {
      rows.push(withNote(numRow(`line-height${suffix}`, fig.lineHeightPx!, st.lineHeight, TYPO_TOLERANCE_PX, undefined, src)));
    } else if (fig.lineHeightPx !== undefined) {
      const r = numRow(`line-height${suffix}`, fig.lineHeightPx, st.lineHeight, TYPO_TOLERANCE_PX,
        `Figma auto (resolved ${fig.lineHeightPx}px)`, src);
      if (r.status === 'fail') { r.status = 'warn'; delete r.srcChannel; } // auto may resolve differently — not a fail; a soft carrier does not carry a channel
      rows.push(withNote(r));
    }
  }
  const figLs = fig.letterSpacing ?? 0;
  const domLs = st.letterSpacing === 'normal' ? 0 : st.letterSpacing;
  if (domLs !== undefined) rows.push(withNote(numRow(`letter-spacing${suffix}`, figLs, domLs, TYPO_TOLERANCE_PX, undefined, src)));
  if (fig.colorHex || st.color) {
    // Verdict machine (colorVerdict): the hex axis is orthogonal to the token/mode axis. domToken is the REAL
    // DOM classification from the snapshot: literal → fail "tokenize it", token → review "both from a
    // token", unknown → review (a hex match of a bound token is not a silent pass); a hex discrepancy is not masked.
    const v = colorVerdict(fig.colorToken?.hex ?? fig.colorHex, fig.colorToken, st.color, st.colorToken, fig.colorBoundVar !== undefined && fig.colorToken === undefined);
    rows.push(withNote({ prop: `color${suffix}`, figma: fig.colorToken?.hex ?? fig.colorHex ?? null, dom: st.color ?? null,
      status: v.status, ...(v.note ? { note: v.note } : {}), ...(v.token ? { token: v.token } : {}), ...(v.tokenReason ? { tokenReason: v.tokenReason } : {}),
      ...(v.status === 'fail' && src ? { srcChannel: src } : {}) }));
  }
  return rows;
}

// Verdict machine — a single total function for all four color rows (text/fill/border/shadow).
// The precedence order is load-bearing (makes the hex axis orthogonal to the token/mode axis): a real
// hex discrepancy is NEVER masked by the token/mode state, a legitimate case is NEVER a false-fail.
// The signature is total: the real domToken (DOM classification from the snapshot) comes as the fourth argument.
type DomTokenState = { token: string } | { literal: true } | { unknown: string };
function colorVerdict(
  figHex: string | undefined, figToken: ResolvedColorToken | undefined,
  domHex: string | undefined, domToken: DomTokenState | undefined,
  figBoundUnresolved = false,
): { status: DiffStatus; note?: string; token?: string; tokenReason?: string } {
  // A1: DOM color unparseable (oklch/color()/transparent) — never fail (evaluated FIRST, do not change the order of the branches).
  if (domHex === undefined) return { status: 'info', note: 'DOM color not recognized (oklch/color()/transparent) — verify visually' };
  if (figHex === undefined) return { status: 'review', note: 'Figma color not resolved — the token cannot be checked', tokenReason: 'fig-unresolved' };
  // A2: the color is bound to a variable, but the token is not resolved (variables unavailable / the shadow
  // token is deferred). Do NOT conflate with a raw literal (conflation = false-green). The gate is BEFORE the hex
  // comparison → review both ways (matched and diverged): not a green pass, not a red fail.
  if (figBoundUnresolved) return { status: 'review', note: 'the Figma color is bound to a variable, but the token is not resolved (variables unavailable / the shadow token is deferred) — nothing to check against; confirm the token under the mode', tokenReason: 'bound-unresolved' };
  const eq = figHex.toLowerCase() === domHex.toLowerCase();
  // B0: a snapshot-resolved mode-blind default is NOT the same as a "pin on an
  // unloaded ancestor" (gate B below). A snapshot fundamentally does not know the node's modes — the honest
  // note must name ITS OWN mechanism, not mis-attribute a pin. Checked STRICTLY BEFORE
  // gate B, otherwise the old pin note would intercept the snapshot token (it too carries mode_dependent+default).
  if (figToken?.snapshot_default) {
    return { status: 'review', note: `resolved via the default-mode snapshot — the modes are unknown to the snapshot; confirm the token visually`, token: figToken.token, tokenReason: 'snapshot-default' };
  }
  // B: mode unconfirmed on a mode-dependent token — never fail/green (the pin is probably on an unloaded ancestor).
  if (figToken?.mode_dependent && figToken.mode_source !== 'node') {
    return { status: 'review', note: `the node's mode is not confirmed (the pin is probably on an unloaded ancestor) — check under the mode; token ${figToken.token}`, token: figToken.token, tokenReason: 'mode-unconfirmed' };
  }
  // C: hex diverges — mode-mismatch (matched a DIFFERENT mode) otherwise diverged.
  if (!eq) {
    const other = figToken?.all_modes && Object.entries(figToken.all_modes).find(([, h]) => h.toLowerCase() === domHex.toLowerCase());
    if (other) return { status: 'fail', note: `looks like mode ${other[0]} was applied, not ${figToken!.mode ?? 'the expected one'} — token ${figToken!.token}` };
    return { status: 'fail', note: figToken ? `color diverged — Figma token ${figToken.token}` : undefined };
  }
  // D: hex matches — token provenance (domToken state). domToken undefined → unknown.
  const dt: DomTokenState = domToken ?? { unknown: 'not-captured' };
  if (figToken && 'literal' in dt) return { status: 'fail', note: `Figma pulls from token ${figToken.token}; DOM hardcoded the literal ${domHex} — tokenize it` };
  if ('unknown' in dt) return figToken ? { status: 'review', note: `hex matched under the mode; the DOM token was not read (${dt.unknown}) — confirm token ${figToken.token}`, token: figToken.token, tokenReason: dt.unknown } : { status: 'pass' };
  if (figToken && 'token' in dt) return { status: 'review', note: `both from a token (Figma ${figToken.token} ↔ DOM ${dt.token}) — confirm the semantics`, token: figToken.token, tokenReason: 'semantic-confirm' };
  if (!figToken && 'token' in dt) return { status: 'pass', note: 'Figma is a raw literal; DOM tokenizes the same hex — not a defect' };
  return { status: 'pass' };
}

// style-anchor (v5): the pair's style axes are read from the real style carrier through a chain of
// TRANSPARENT wrappers (1 element child + same-size + no meaningful styles + not truncated).
// A transparent wrapper has nothing to diverge on → the descent does not mask defects; a wrapper with a background/
// padding honestly stays the root. The schema >= 5 gate: the compact "no field = no style" semantics is
// guaranteed only by the v5 extractor (belt-and-suspenders to the handler's reject at :338).
const MAX_STYLE_DESCENT = 3;
type AnchorNode = Pick<DomChild, 'tag' | 'classList' | 'styles' | 'shadow' | 'borders' | 'borderColors' | 'borderColorsToken' | 'data' | 'children' | 'childrenTruncated' | 'rect'>;
function transparentChild(node: AnchorNode, tol: number): DomChild | undefined {
  const kids = node.children;
  if (node.childrenTruncated === true || !kids || kids.length !== 1) return undefined;
  const c = kids[0];
  if (c.kind !== 'element') return undefined;
  if (Math.abs(c.rect.w - node.rect.w) > tol || Math.abs(c.rect.h - node.rect.h) > tol) return undefined;
  const s = node.styles;
  if (s?.backgroundColor !== undefined || s?.gradient !== undefined || (s?.borderRadius ?? 0) > 0) return undefined;
  // an uncomparable radius (v6 — corners that differ, a percentage, an ellipse) OMITS borderRadius, so the
  // `> 0` test above stops seeing a visibly rounded wrapper: it would read as transparent, the descent would
  // move every style axis to the child, sRadiusUncomparable (read THROUGH the anchor) would never fire, and
  // the receipt would print a style_anchor row asserting "no styles" about a node with a visible rounded
  // corner. Same disqualification as bgImage below, for the same reason — a real visible paint the
  // transparency test cannot see as a number. `border-radius: 50%` is the commonest wrapper this catches.
  if (s?.borderRadiusUncomparable === true) return undefined;
  // a raster url background (F2): invisible to the gradient detector, but it is a REAL visible background — the wrapper is opaque.
  if (s?.bgImage === true) return undefined;
  if ((s?.opacity ?? 1) < 1) return undefined; // a semi-transparent wrapper actually darkens the render — a carrier
  if (node.shadow !== undefined || node.borders !== undefined) return undefined;
  return c;
}
function styleAnchor(d: DomSnapshotOk, tol: number): { anchor: DomChild; chain: string[] } | undefined {
  // F4: `d.schema < 5` let schema===undefined through (undefined<5 === false) → a descent on a non-v5 snapshot,
  // where the compact "no field = no style" semantics is NOT guaranteed. The positive gate catches undefined too.
  if (!(d.schema >= 5)) return undefined;
  // is the root itself stylistically empty? (otherwise the root is the carrier, no descent needed). The root's borders —
  // Edges (always present, fields 0 when absent), so it is checked HERE explicitly and
  // zeroed in rootView (otherwise transparentChild's `borders !== undefined` would disqualify
  // any root with an always-present Edges object).
  if (d.borders.top || d.borders.right || d.borders.bottom || d.borders.left) return undefined;
  const rootView: AnchorNode = { ...d, styles: d.styles, borders: undefined, shadow: d.shadow } as AnchorNode;
  let cur: AnchorNode = rootView;
  const chain: string[] = [];
  for (let i = 0; i < MAX_STYLE_DESCENT; i++) {
    const next = transparentChild(cur, tol);
    if (!next) break;
    chain.push([next.tag, ...(next.classList ?? [])].filter(Boolean).join('.'));
    cur = next as AnchorNode;
  }
  if (chain.length === 0) return undefined;
  // cap-out honesty: having exhausted MAX_STYLE_DESCENT, cur may STILL be a transparent wrapper
  // (the style carrier is deeper than the chain). Anchoring on it = a false-red of its absent axes + a lying
  // note "read from the carrier". The prior behavior (no anchor) is more honest than a false red.
  if (transparentChild(cur, tol) !== undefined) return undefined;
  return { anchor: cur as DomChild, chain };
}

function descriptiveRows(spec: LayoutSpec, d: DomSnapshotOk, opts: DiffOptions): DiffRow[] {
  const rows: DiffRow[] = [];
  // A surgical per-axis view: per-axis absence defaults under an ACTIVE anchor (v5 semantics
  // "no field = no style"); direct pairs (a === undefined) — the prior d-reads byte-for-byte.
  // F1: same-size is a HONESTY GATE, NOT a metric. Clamped to [1,1] = exactly 1px on both sides:
  // the user's tolerancePx (up to 10) does not weaken it (Math.min ≤1), and strict tol=0 does not tighten it
  // below 1 (structTol ≥1) — a child inset sub-pixel under strict would otherwise stop being
  // "transparent" and the style would be read from the wrapper root (a false red on the carrier). See match-profiles.
  const structTol = Math.max(opts.tolerancePx, 1);
  const aRes = styleAnchor(d, Math.min(structTol, 1));
  const a = aRes?.anchor;
  const sBg        = a ? a.styles?.backgroundColor            : d.styles?.backgroundColor;
  const sBgToken   = a ? a.styles?.backgroundColorToken       : d.styles?.backgroundColorToken;
  const sGradient  = a ? a.styles?.gradient                   : d.styles?.gradient;
  const sRadius    = a ? (a.styles?.borderRadius ?? 0)        : d.styles?.borderRadius;
  const sRadiusUncomparable = a ? a.styles?.borderRadiusUncomparable    : d.styles?.borderRadiusUncomparable;
  const sOpacity   = a ? (a.styles?.opacity ?? 1)             : d.styles?.opacity;   // default 1, NOT 0
  const sShadow    = a ? a.shadow                             : d.shadow;
  const sBorders   = a ? (a.borders ?? { top: 0, right: 0, bottom: 0, left: 0 }) : d.borders;
  const sBorderCol = a ? a.borderColors                       : d.borderColors;
  const sBorderTok = a ? a.borderColorsToken                  : d.borderColorsToken;
  const sHints     = a ? { tag: a.tag ?? '', classList: a.classList ?? [], data: a.data ?? {} }
                       : d.componentHints;
  // F6: the pointer row is emitted ONLY when there is ≥1 Figma style axis to check — otherwise the note
  // "axes read" without a single comparison (we do not gate the descent itself, only the informational row).
  const hasStyleAxis = spec.fillHex !== undefined || spec.gradient !== undefined
    || spec.strokeWeight !== undefined || spec.shadow !== undefined
    || spec.cornerRadius !== undefined || spec.opacity !== undefined || spec.component !== undefined;
  if (aRes && hasStyleAxis) rows.push({ prop: 'style_anchor', figma: '-', dom: aRes.chain.join(' → '), status: 'pass',
    note: 'the style axes (fill/gradient/border/shadow/radius/opacity/component) were read from the nested style carrier — the wrappers are transparent (1 child, same-size, no styles)' });
  // source-hint: anchor — the address of style edits = the carrier's classList (aRes.anchor,
  // the LAST link of the wrappers). The gate MIRRORS the emission of the style_anchor row (aRes && hasStyleAxis) —
  // an anchor without style axes to check is not attributed. A direct pair (aRes undefined) carries no channel.
  if (opts.attributionOut && aRes && hasStyleAxis && a?.classList?.length) {
    opts.attributionOut.anchorClassList = a.classList;
  }

  // fix-plan: a DIRECT text pair (suffix='') — there is no label, attributionOut.text is empty → the channel is
  // ROOT/property, NOT text('') (the edit lives in the pair's root class).
  if (spec.text) rows.push(...typographyRows(spec.text, { styles: d.styles, rect: d.rect }, '', d.fontsLoaded, undefined, undefined,
    { kind: 'root', editKind: 'property' }));

  if (spec.fillHex) {
    const bg = sBg;
    // Non-color branch (preserved): no background at all → "background on another element" warn.
    // Separate from colorVerdict: an undefined bg here means "the background may be on a different element"
    // (a structural signal), NOT "DOM color not recognized" (A1) — a different cause, a different note.
    if (bg === undefined) {
      rows.push({ prop: 'fill', figma: spec.fillHex, dom: null, status: 'warn', note: 'the DOM element has no background — the background may be on a different element' });
    } else {
      const v = colorVerdict(spec.fillToken?.hex ?? spec.fillHex, spec.fillToken, bg, sBgToken, spec.fillBoundVar !== undefined && spec.fillToken === undefined);
      rows.push({ prop: 'fill', figma: spec.fillToken?.hex ?? spec.fillHex, dom: bg, status: v.status, ...(v.note ? { note: v.note } : {}), ...(v.token ? { token: v.token } : {}), ...(v.tokenReason ? { tokenReason: v.tokenReason } : {}),
        ...(v.status === 'fail' ? { srcChannel: SRC_ANCHOR_PROP } : {}) });
    }
  }

  if (spec.gradient || sGradient) {
    // fix-plan: fail-only map — gradient fails live in a SEPARATE file (gradient-verdict.ts),
    // the channel is set here IN the row object before push (not an index coupling); info/warn/review/unchecked —
    // without a channel (soft carriers).
    rows.push(...gradientVerdict(spec.gradient, sGradient, sBg)
      .map((r) => (r.status === 'fail' ? { ...r, srcChannel: SRC_ANCHOR_PROP } : r)));
    // The multiLayer info MUST surface BOTH sides: gradientVerdict checks only the FIRST layer of each side,
    // so ">1 layer" on EITHER side means "the other layers were not checked". Ignoring the Figma side = a silent
    // false-green (the projector was taught to emit spec.gradient.multiLayer; here we surface it — otherwise a 2nd
    // Figma gradient is silently dropped, green on a real difference). info (not fail): it could be intentional.
    const figML = spec.gradient?.multiLayer, domML = sGradient?.multiLayer;
    if (figML || domML) rows.push({ prop: 'gradient-layers', figma: figML ? 'several layers' : null, dom: domML ? 'several layers' : null, status: 'info', note: 'several background layers — only the first was checked, verify the rest visually' });
  }

  // border (color + width) — root-only, a clone of the fill path. Presence by width>0; we consider
  // ONLY sides with a non-zero width (getComputedStyle returns a color even for width:0 sides).
  const bw = sBorders;
  const activeSides = bw ? (['top', 'right', 'bottom', 'left'] as const).filter((s) => bw[s] > 0) : [];
  const domHasBorder = activeSides.length > 0;
  const figHasStroke = spec.strokeHex !== undefined;
  if (domHasBorder || figHasStroke) {
    if (domHasBorder !== figHasStroke) {
      rows.push({ prop: 'border-color', figma: spec.strokeHex ?? null, dom: domHasBorder ? 'present' : null,
        status: 'warn', note: figHasStroke ? 'border only in the layout — not in the DOM' : 'border only in the DOM — not in the layout' });
    } else {
      const bc = sBorderCol ?? {};
      const activeColors = activeSides.map((s) => bc[s]);
      const someUndefined = activeColors.some((c) => c === undefined);
      const uniform = !someUndefined && activeColors.every((c) => c!.toLowerCase() === activeColors[0]!.toLowerCase());
      if (activeSides.length < 4) {
        // A Figma SOLID stroke paints the WHOLE perimeter; in the DOM the border is only on some sides — this is a
        // PRESENCE discrepancy that a match on the active side would otherwise mask into a pass (never-false-green;
        // border-color used to live in NOT_COVERED — we don't regress into false-green).
        rows.push({ prop: 'border-color', figma: spec.strokeHex!,
          dom: activeSides.map((s) => `${s[0].toUpperCase()}:${bc[s] ?? '?'}`).join(' '),
          status: 'warn', note: `Figma stroke — the whole perimeter, in the DOM the border is only on ${activeSides.length} side(s) (${activeSides.join('/')}) — verify visually` });
      } else if (someUndefined) {
        rows.push({ prop: 'border-color', figma: spec.strokeHex!, dom: null, status: 'warn',
          note: 'border color not recognized (oklch()/color()/transparent) — verify visually' });
      } else if (!uniform) {
        rows.push({ prop: 'border-color', figma: spec.strokeHex!,
          dom: activeSides.map((s) => `${s[0].toUpperCase()}:${bc[s]}`).join(' '),
          status: 'warn', note: 'the sides differ — Figma stroke is uniform, verify visually' });
      } else {
        // The terminal color-equality logic (the only replacement: the verdict machine).
        // All non-color branches above (presence-mismatch/partial-sides/someUndefined/non-uniform) — as-is.
        const domColor = activeColors[0]!;
        const v = colorVerdict(spec.strokeToken?.hex ?? spec.strokeHex, spec.strokeToken, domColor, sBorderTok?.[activeSides[0]], spec.strokeBoundVar !== undefined && spec.strokeToken === undefined);
        rows.push({ prop: 'border-color', figma: spec.strokeToken?.hex ?? spec.strokeHex!, dom: domColor, status: v.status, ...(v.note ? { note: v.note } : {}), ...(v.token ? { token: v.token } : {}), ...(v.tokenReason ? { tokenReason: v.tokenReason } : {}),
          ...(v.status === 'fail' ? { srcChannel: SRC_ANCHOR_PROP } : {}) });
      }
      // width — only for a full perimeter (with a partial border presence is already in question,
      // a separate width row would be misleading; everything is said in the border-color warn above).
      if (spec.strokeWeight !== undefined && bw && activeSides.length === 4) {
        const activeWidths = activeSides.map((s) => bw[s]);
        const uniformW = activeWidths.every((w) => w === activeWidths[0]);
        rows.push(uniformW
          ? numRow('border-width', spec.strokeWeight, activeWidths[0], opts.tolerancePx, undefined, SRC_ANCHOR_PROP)
          : { prop: 'border-width', figma: spec.strokeWeight,
              dom: activeSides.map((s) => `${s[0].toUpperCase()}:${bw[s]}`).join(' '),
              status: 'warn', note: 'the sides differ — verify visually' });
      }
    }
  }
  // box-shadow — root-only, single-shadow-first. spread is checked like x/y/blur (Figma REST RETURNS it — OpenAPI BaseShadowEffect.spread, omitted when 0).
  const fs = spec.shadow, ds = sShadow;
  if (fs || ds) {
    if (!fs || !ds) {
      rows.push({ prop: 'box-shadow', figma: fs ? 'present' : null, dom: ds ? 'present' : null, status: 'warn',
        note: fs ? 'shadow only in the layout — not in the DOM' : 'shadow only in the DOM — not in the layout' });
    } else if (fs.count > 1 || ds.count > 1) {
      rows.push({ prop: 'box-shadow', figma: `${fs.count} shadows`, dom: `${ds.count} shadows`, status: 'warn',
        note: 'the shadow list was not matched (single-shadow-first) — verify visually' });
    } else {
      if (fs.inner !== ds.inset) {
        rows.push({ prop: 'box-shadow', figma: fs.inner ? 'inset' : 'drop', dom: ds.inset ? 'inset' : 'drop',
          status: 'fail', note: 'shadow type differs', srcChannel: SRC_ANCHOR_PROP });
      }
      rows.push(numRow('shadow-x', fs.x, ds.x, opts.tolerancePx, undefined, SRC_ANCHOR_PROP));
      rows.push(numRow('shadow-y', fs.y, ds.y, opts.tolerancePx, undefined, SRC_ANCHOR_PROP));
      rows.push(numRow('shadow-blur', fs.blur, ds.blur, opts.tolerancePx, undefined, SRC_ANCHOR_PROP));
      rows.push(numRow('shadow-spread', fs.spread, ds.spread, opts.tolerancePx, undefined, SRC_ANCHOR_PROP));
      if (fs.colorHex && ds.colorHex) {
        // Verdict machine. fs.colorToken is DEFERRED (shadows bind via an effect, not a paint key) → always
        // undefined. If the shadow is bound (colorBoundVar present) → A2 gates it into review (bound-but-unresolved,
        // do not conflate with a literal). Without a binding — a literal: matched → pass, diverged → fail.
        const v = colorVerdict(fs.colorToken?.hex ?? fs.colorHex, fs.colorToken, ds.colorHex, ds.colorToken, fs.colorBoundVar !== undefined && fs.colorToken === undefined);
        rows.push({ prop: 'shadow-color', figma: fs.colorToken?.hex ?? fs.colorHex, dom: ds.colorHex, status: v.status, ...(v.note ? { note: v.note } : {}), ...(v.token ? { token: v.token } : {}), ...(v.tokenReason ? { tokenReason: v.tokenReason } : {}),
          ...(v.status === 'fail' ? { srcChannel: SRC_ANCHOR_PROP } : {}) });
      } else if (fs.colorHex || ds.colorHex) {
        // never-false-green: exactly one side produced a color (DOM oklch()/color()/transparent → toHex undefined,
        // Figma rgbaToHex is always defined; or vice versa) — we do NOT drop the axis silently, an honest warn (mirror of border someUndefined).
        rows.push({ prop: 'shadow-color', figma: fs.colorHex ?? null, dom: ds.colorHex ?? null, status: 'warn',
          note: 'the shadow color was not recognized on one side (oklch()/color()/transparent) — verify visually' });
      }
    }
  }

  // The uncomparable branch comes FIRST and there is no fallthrough: with an active anchor sRadius
  // defaults to 0, so an uncomparable carrier would otherwise emit a fail — an alarm about a difference
  // nobody measured, since Figma carries ONE px number and there is nothing on its side to compare a
  // per-corner, percentage or elliptical radius against. Nor is the row dropped: an omitted row makes the
  // pair clean with no trace, and a reader cannot tell "measured and fine" from "not present". unchecked
  // is the honest third answer, and verification.ts routes it to resolve_skip (a human must look).
  // The note has to be true of EVERY input that reaches it. The set of such inputs has widened twice
  // already (the ellipse and the percentage, then the browser-unresolved clamp()/min()/max()), so the
  // note leads with the branch condition itself and offers the shapes as examples — a closed
  // enumeration would go stale the next time a fourth thing turns out to reach this row.
  if (spec.cornerRadius !== undefined && sRadiusUncomparable === true) {
    rows.push({ prop: 'corner-radius', figma: spec.cornerRadius, dom: null, status: 'unchecked',
      note: 'the DOM radius is not one comparable px number - e.g. the corners differ, or it is a percentage, an ellipse, or a value the browser left unresolved such as clamp()/min()/max(); Figma carries a single px cornerRadius, so there is no axis to judge it on - verify by eye' });
  } else if (spec.cornerRadius !== undefined && sRadius !== undefined) {
    rows.push(numRow('corner-radius', spec.cornerRadius, sRadius, opts.tolerancePx, undefined, SRC_ANCHOR_PROP));
  }
  if (spec.opacity !== undefined && sOpacity !== undefined) {
    const delta = round1(Math.abs(spec.opacity - sOpacity));
    rows.push({ prop: 'opacity', figma: spec.opacity, dom: sOpacity, ...(delta > 0 ? { delta } : {}),
      status: delta <= 0.01 ? 'pass' : 'fail',
      ...(delta > 0.01 ? { srcChannel: SRC_ANCHOR_PROP } : {}) });
  }

  if (spec.component) {
    const figLabel = [spec.component.setName, spec.component.name].filter(Boolean).join('/') || spec.component.id;
    const hints = sHints;
    const domLabel = hints ? [hints.tag, ...hints.classList].join('.') : 'no data';
    // per-source: a derived pair must co-occur WITHIN a single class/tag — a flat pool
    // would sum 'list' from shopping-list and 'item' from product-item → false-PASS.
    // data values are DELIBERATELY outside the co-occurrence sources: dataset is free text (test-ids,
    // analytics labels), the phrase data-testid="add shopping list item" trivially contains 2 generic
    // stems as WORDS → co-occurrence would be satisfied without a structural name meaning (false-PASS).
    // Structural names = only tag + classList. data stays in the flat
    // domTokens below — the base hit on data-component="Banner" is alive, the p.2 gate and the warn note unchanged.
    const domSources = hints
      ? [hints.tag, ...hints.classList]
          .map((s) => { const t = tokensCased(s); return [...t.base, ...t.derived]; })
      : [];
    const domTokens = hints
      ? [hints.tag, ...hints.classList, ...Object.values(hints.data)]
          .flatMap((s) => { const t = tokensCased(s); return [...t.base, ...t.derived]; })
      : [];
    const expected = opts.expectedComponent?.toLowerCase();
    if (expected) {
      // the expected_component override path — byte-for-byte as it was (an explicit name from the user beats the heuristics)
      const matchedBy = domLabel.toLowerCase().includes(expected) ? `substring "${expected}"` : undefined;
      rows.push({ prop: 'component', figma: figLabel, dom: domLabel,
        status: matchedBy ? 'pass' : 'warn',
        note: matchedBy ? `matched by ${matchedBy}`
          : `the layout has the DS component «${figLabel}»${spec.component.props ? ` props=${JSON.stringify(spec.component.props)}` : ''} — substring "${expected}" not found in "${domLabel}" (heuristic, not a fail)` });
    } else if (hints === undefined) {
      // p.1: the DOM side has no componentHints at all (inline snapshot/legacy) — there is no signal by construction
      rows.push({ prop: 'component', figma: figLabel, dom: domLabel, status: 'info',
        note: 'DOM side without componentHints (inline snapshot/old format) — identity not verifiable; verify visually or pass expected_component' });
    } else if (spec.component.setUnresolved) {
      // p.3a (ABOVE p.2: with double signal-lessness the Figma-side cause is more precise and actionable):
      // the set exists, the name did not resolve — an honest cause, not "no set" (otherwise mis-attribution)
      rows.push({ prop: 'component', figma: figLabel, dom: domLabel, status: 'info',
        note: 'the component-set name did not resolve (unpublished component / library-lookup failure) — identity not checked; retry the call or pass expected_component' });
    } else if (domTokens.length === 0) {
      // p.2: classes exist, but they yield no tokens ≥3 chars — either a CSS-modules strip, or the component is not there
      rows.push({ prop: 'component', figma: figLabel, dom: domLabel, status: 'info',
        note: 'the DOM classes/data carry no tokens ≥3 chars — either the names are stripped (CSS-modules) or the DS component is not used here at all — verify visually or pass expected_component' });
    } else {
      // prop segments (prop=value) NEVER match — even with a live
      // setName (removes the false-PASS "matched by active"). The match is two-category:
      // a base hit is self-sufficient; derived (camelCase-split) go green only as a pair — the co-occurrence gate
      // against false-green generic stems ('listItem' × <ul class="list">).
      const propOnly = isPropOnlyName(spec.component.name);
      const hadPropSegs = segs(spec.component.name).some(isPropSeg);
      const idSet = tokensCased(spec.component.setName ?? '');
      const idName = tokensCased(identityParts(spec.component.name));
      const identityBase = [...new Set([...idSet.base, ...idName.base])];
      const identityDerived = [...new Set([...idSet.derived, ...idName.derived])].filter((t) => !identityBase.includes(t));
      if (identityBase.length + identityDerived.length === 0) {
        if (spec.component.setName) {
          // the set is RESOLVED, but the name yields no Latin tokens (Cyrillic/short) — NOT p.3b:
          // a "no component-set" note would be a lie (the set exists — the resolve succeeded, there are no tokens)
          rows.push({ prop: 'component', figma: figLabel, dom: domLabel, status: 'info',
            note: `the set name «${spec.component.setName}» resolved, but yields no tokens ≥3 chars (Cyrillic/short) — the token heuristic does not apply; verify visually or pass expected_component` });
        } else {
          // p.3b: there is no set at all — separate causes (prop-only ≠ a short/numeric name)
          rows.push({ prop: 'component', figma: figLabel, dom: domLabel, status: 'info',
            note: propOnly
              ? `the layout has variant props «${figLabel}» without a component set — identity not verifiable by tokens; verify visually or pass expected_component`
              : 'the component name yields no tokens ≥3 chars (short/numeric) — identity not verifiable; verify visually or pass expected_component' });
        }
      } else {
        const baseHit = identityBase.find((t) => domTokens.includes(t));
        // derived go green only as a pair FROM ONE source (per-source co-occurrence)
        const derivedSource = domSources.find((src) => identityDerived.filter((t) => src.includes(t)).length >= 2);
        const derivedShared = derivedSource ? identityDerived.filter((t) => derivedSource.includes(t)) : [];
        const matched = baseHit ? `token "${baseHit}"`
          : derivedShared.length >= 2 ? `tokens "${derivedShared.join('"+"')}"` : undefined;
        // Transparency: the tail is ONLY in the no-hit note — on a pass the outcome is honest,
        // the asymmetry is DELIBERATE (no noise needed in the pass note).
        const propNote = hadPropSegs ? ' (variant props excluded from the match)' : '';
        rows.push({ prop: 'component', figma: figLabel, dom: domLabel,
          status: matched ? 'pass' : 'warn',
          note: matched ? `matched by ${matched}`
            : `the layout has the DS component «${figLabel}»${spec.component.props ? ` props=${JSON.stringify(spec.component.props)}` : ''} — no shared tokens ≥3 chars: [${[...identityBase, ...identityDerived].join(', ')}] × [${domTokens.slice(0, 5).join(', ')}]${propNote} (heuristic, not a fail)` });
      }
    }
  }
  return rows;
}
