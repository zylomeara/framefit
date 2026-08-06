// Flat, diff-ready projection of a single Figma node plus a snapshot of the DOM side.
// Geometric metrics (gaps/offsets/paddings) are computed by diff.ts from the rects —
// both sides are compared as a "result", not as a mechanism (margin vs gap vs spacer).

// SourceHint — a code address derived from a CSS-modules class. types.ts
// imports it for PairSource; class-source.ts is a leaf module (imports nothing), so there is no cycle.
import type { SourceHint } from './class-source.js';

export interface SpecRect { x: number; y: number; w: number; h: number }
export interface Edges { top: number; right: number; bottom: number; left: number }

// match-profiles: a named preset of strictness/scope for compare_node_to_dom.
// Lives in the domain (not in the tool): DiffOptions.profile (diff.ts) and buildVerification.opts.matchProfile
// (verification.ts) are the domain consumers; the tool re-exports the type for the schema/tests.
export type MatchProfile = 'strict' | 'layout' | 'token-aware';

export interface SpecTypography {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  lineHeightUnit?: string; // 'INTRINSIC_%' ≈ font-defined (browser 'normal')
  letterSpacing?: number;  // px (Figma REST returns px)
  colorHex?: string;       // text color (solid fill of a TEXT node)
  colorBoundVar?: string;  // alias variable id, if colorHex was taken from a bound solid-paint (library default-mode footgun)
  colorToken?: ResolvedColorToken; // mode-resolved text-color token; filled via ProjectorContext.resolveColorToken (bound var) OR a shared fill STYLE (NAME→'(style: …)', STATE→'(paint)' sentinel — unified)
}

// Mode-resolved value of a color variable: the projector does NOT resolve on its own — it is filled
// ONLY via ProjectorContext.resolveColorToken (the calling tool injects the real resolver, reusing
// resolveBoundVariableInMode). hex is the value UNDER the node's active mode (not the library default).
export interface ResolvedColorToken {
  token: string;                 // variable name, e.g. 'text icon/accent'
  hex: string;                   // value UNDER the node's mode, '#rrggbb'
  mode?: string;                 // the node's active mode (multi-mode only)
  mode_dependent?: boolean;
  mode_source?: 'node' | 'default';
  all_modes?: Record<string, string>;   // mode name → hex (multi-mode, for mode-mismatch)
  snapshot_default?: true;              // marker of a snapshot resolve (mode-blind default value) — gate B emits its own note, does not mis-attribute the pin
}

/** Slice of content identifiers for BOTH sides (projector textSnippet / dom-extractor text).
 * The SINGLE source of truth for the threshold: pair-matcher (contentUnknown/truncationSuspect/phase-0),
 * diff.sameContent (the "collected at the cap" marker), longtext note. dom-extractor is a synchronized
 * LITERAL (a browser script with no imports); drift is ruled out by the schema gate (v4).
 * 120: real DS headings (books, 51-60 chars) fit in full; ≥120 is an honest longtext mute. */
export const SNIPPET_CAP = 120;

export interface SpecChild {
  id: string;
  name: string;
  type: string;            // FRAME | TEXT | INSTANCE | ...
  rect: SpecRect;
  axis?: 'row' | 'col';    // from the child's layoutMode (absent = no auto-layout) — symmetric with LayoutSpec.axis; the partial-spacing gate in verification (the gap between children is meaningful ONLY under auto-layout, otherwise diff emits children-skip)
  text?: SpecTypography;   // TEXT nodes only
  textSnippet?: string;    // TEXT with non-empty text: the first SNIPPET_CAP chars after collapsing whitespace (content identification, symmetric with the DOM side up to collapse: DOM cuts without collapsing; the discrepancy is absorbed by the min-len prefix comparison when raw=SNIPPET_CAP)
  textFixedWidth?: true;   // TEXT with textAutoResize NONE|HEIGHT — width is set by the designer (not hug); gate for TEXT demotions
  paddings?: Edges;         // declared auto-layout paddings of the child (content-edge metrics)
  textFromNested?: boolean; // typography taken from the single nested TEXT (auto-descent)
  textAmbiguous?: boolean;  // >1 nested TEXT — auto-descent is ambiguous (diff emits a skip)
  textUncertain?: boolean;  // exactly one TEXT found, but the path hit a cut — uniqueness only within the cut
  textBeyondCut?: boolean;  // no TEXT found, but some may remain deeper than the cut — honest skip
  hugWidth?: true;          // the container's width hugs its content — layoutSizingHorizontal HUG
  imageFill?: true;         // the leaf has an IMAGE/VIDEO fill — this is CONTENT (avatar/preview/photo → DOM <img>), NOT decoration; gate for excluding decorative leaves in verification (otherwise an unpaired image = false green)
  children?: SpecChild[];      // symmetric with DomChild.children
  childrenTruncated?: boolean;
  truncationCause?: 'depth' | 'breadth' | 'budget'; // which cap cut children; only 'depth' is drill-fixable
}

export interface TextLeaf {
  id: string;
  name: string;
  path: string[];            // name/type[index] chain from the requested node down to the leaf
  text_snippet?: string;
  typography: SpecTypography;
}

export interface SpecShadow {
  inner: boolean;
  x: number; y: number; blur: number; spread: number;
  colorHex?: string;
  colorBoundVar?: string;    // id of the bound shadow-color variable (same footgun as fill/stroke)
  colorToken?: ResolvedColorToken; // DEFERRED: shadows bind via an effect, not a paint key ('fills'|'strokes') — resolveColorToken does not cover them; stays unset pending a separate resolve
  count: number;             // number of visible drop/inner effects
}

export interface LayoutSpec {
  node: { id: string; name: string; type: string };
  rect?: SpecRect;             // absent — absoluteBoundingBox was null
  rotated?: boolean;           // rotation != 0 → AABB is inflated, geometry is unreliable
  axis?: 'row' | 'col';        // from layoutMode; absent — no auto-layout
  autoLayout?: { gap?: number; padding: Edges }; // DECLARED values (informational; the diff measures rects)
  fillHex?: string;
  fillBoundVar?: string;       // alias variable id, if fillHex was taken from a bound solid-paint (library default-mode footgun)
  fillToken?: ResolvedColorToken;   // mode-resolved fill token; injected via resolveColorToken (bound var) OR a shared fill STYLE (NAME→'(style: …)', STATE→'(paint)' sentinel — unified)
  strokeHex?: string;
  strokeBoundVar?: string;       // alias variable id, if strokeHex came from a bound solid-stroke
  strokeToken?: ResolvedColorToken; // mode-resolved stroke token; injected via resolveColorToken (bound var) OR a shared stroke STYLE (NAME→'(style: …)', STATE→'(paint)' sentinel — unified)
  strokeWeight?: number;
  shadow?: SpecShadow;
  gradient?: GradientModel;
  cornerRadius?: number;
  opacity?: number;
  text?: SpecTypography;       // the node itself is TEXT
  textNode?: true;              // the pair root is a non-empty TEXT (same guard as SpecChild.textSnippet)
  textFixedWidth?: true;        // the root is a TEXT with textAutoResize NONE|HEIGHT (not hug)
  hugWidth?: true;              // the pair root is a container with layoutSizingHorizontal HUG (width hugs content); gate for the hug-vs-fill demotion (E)
  component?: { id: string; name?: string; setName?: string; setUnresolved?: true; props?: Record<string, unknown> };
  children: SpecChild[];       // visible, in-flow, sorted by the main-axis coordinate
  childrenTruncated?: boolean; // the MAX_SPEC_CHILDREN cap fired
  truncationCause?: 'depth' | 'breadth' | 'budget'; // which cap cut children; only 'depth' is drill-fixable
}

// ── DOM side (produced by the canonical extractor, validated by a Zod schema in adapters) ──

// Authored-binding state of one color (schema v2): value-anchored token / literal /
// honest unknown (cross-origin | inherited). Consumed by colorVerdict; NEVER claims
// literal if the stylesheet was unreadable or the property was inherited.
export type DomColorToken =
  | { token: string }
  | { literal: true }
  | { unknown: string };

export interface GradientStopModel { position: number; hex?: string; token: DomColorToken }
export interface GradientModel {
  kind: 'linear' | 'radial' | 'conic' | 'unknown';
  angleDeg?: number;
  stops: GradientStopModel[];
  whole: DomColorToken;
  multiLayer?: boolean;
}

export interface DomTypography {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeight?: number | 'normal';
  letterSpacing?: number | 'normal';
  color?: string;           // hex — the extractor normalizes rgb() itself
  backgroundColor?: string; // hex; transparent → undefined
  colorToken?: DomColorToken;           // authored-binding of the text color (schema v2)
  backgroundColorToken?: DomColorToken; // authored-binding of the background (schema v2)
}

export interface DomChild {
  kind: 'element' | 'text';
  tag?: string;
  classList?: string[];
  rect: SpecRect;
  text?: string;            // the first SNIPPET_CAP chars (identification)
  path?: string;            // `:nth-child` chain from the captured root — the CSS selector for compare; for a text node = the parent element's path
  // v5: the child's styles are extended with a style bundle (compactly: a field is present ONLY when the
  // value is meaningful; absence at schema>=5 = there is no style — the capture guarantee for styleAnchor)
  styles?: DomTypography & { borderRadius?: number; borderRadiusUncomparable?: true; opacity?: number; gradient?: GradientModel; bgImage?: true }; // for kind:'text' — the parent's computed styles (typography is inherited); borderRadiusUncomparable = the DOM radius is not one comparable px number (corners differ, or a %/elliptical radius), so borderRadius is absent (v6); bgImage = a raster url background (invisible to the gradient detector)
  shadow?: DomShadow;          // v5
  borders?: Edges;             // v5 (non-zero only)
  borderColors?: { top?: string; right?: string; bottom?: string; left?: string };      // v5
  borderColorsToken?: { top?: DomColorToken; right?: DomColorToken; bottom?: DomColorToken; left?: DomColorToken }; // v5
  data?: Record<string, string>; // v5: dataset (componentHints anchors)
  paddings?: Edges;         // own CSS paddings (content-edge metrics)
  children?: DomChild[];       // nested in-flow children (4 levels below the pair root; the field is present on L1/L2/L3, absent on L4 = beyond the cut); [] = leaf WITHIN the capture
  childrenTruncated?: boolean; // this level was cut by a cap
  outOfFlow?: number;          // children skipped as position:absolute/fixed - out of THIS box layout,
                               // and unreachable by a deeper capture; absent when none were skipped
}

export interface DomShadow {
  inset: boolean;
  x: number; y: number; blur: number; spread: number;
  colorHex?: string;         // hex of the foreground color (via toHex)
  colorToken?: DomColorToken; // authored-binding of the shadow color (schema v2)
  count: number;             // number of top-level shadows (single-first gate)
}

export interface DomSnapshotOk {
  schema: number;
  status?: 'ok';
  selector?: string;
  innerWidth: number;
  layoutViewportWidth?: number; // documentElement.clientWidth — the width CSS laid the page out in; innerWidth minus it = the PAINTED page scrollbar
  reservedGutter?: number;  // scrollbar-gutter space reserved but NOT painted (clientWidth is blind to it) — the other half of the gutter; absent unless the page declares a gutter
  reservedGutterLeft?: number; // ...of which this much is on the leading edge (both-edges reserves half there); same gate
  rect: SpecRect;           // getBoundingClientRect (border-box)
  borders: Edges;           // computed border widths — diff subtracts them when computing paddings
  borderColors?: { top?: string; right?: string; bottom?: string; left?: string };
  borderColorsToken?: { top?: DomColorToken; right?: DomColorToken; bottom?: DomColorToken; left?: DomColorToken }; // authored-binding of the border colors (schema v2)
  shadow?: DomShadow;
  paddings?: Edges;         // the root's own CSS paddings
  clientWidth?: number;     // without borders and the vertical scrollbar
  clientHeight?: number;    // without borders and the horizontal scrollbar
  scrollHeight?: number;    // height of the scrollable content
  scroll: { top: number; left: number };
  transformed?: boolean;    // computed transform !== 'none'
  fontsLoaded?: boolean;    // document.fonts.status === 'loaded'
  styles?: DomTypography & { display?: string; borderRadius?: number; borderRadiusUncomparable?: true; opacity?: number; justifyContent?: string; gradient?: GradientModel };
  state?: Record<string, string | boolean>; // checked/disabled/…
  componentHints?: { tag: string; classList: string[]; data: Record<string, string> };
  children: DomChild[];     // visible in-flow (including bare text nodes), in DOM order
  childrenTruncated?: boolean;
  outOfFlow?: number;       // see DomChild.outOfFlow - the same count for the captured root
}

export interface DomSnapshotFailed {
  status: 'not_found' | 'multiple' | 'hidden';
  selector?: string;
  matches?: number;
}

export type DomSnapshot = DomSnapshotOk | DomSnapshotFailed;

// ── Diff result ──

export type DiffStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'info' | 'demoted' | 'unchecked' | 'review';

export interface DiffRow {
  prop: string;                        // 'size.w' | 'gap[0] title↔list' | 'font-size[title]' | 'component' | …
  figma?: string | number | null;
  dom?: string | number | null;
  delta?: number;                      // rounded to 0.1 in the report
  status: DiffStatus;
  note?: string;
  // confirm_token aggregation: structural name of the review row's Figma token (for grouping in
  // blocking; we do NOT parse notes) + an open reason code (dt.unknown / branch-id). review only.
  token?: string;
  tokenReason?: string;
  // fix-plan: source channel + edit class; set at the CREATION of a fail row for an
  // editable axis (structural axes — children_reorder/layout_axis_mismatch — do not carry it).
  // UNCONDITIONAL (independent of attributionOut); set right in the row literal — zero index coupling
  // (rows is assembled from three arrays via spreads + the tool's unshift). editKind: property = a literal edit
  // "set it to 550"; layout = "fix the layout rule (gap/flex/width logic), do not hardcode px".
  srcChannel?: { kind: 'root' | 'child' | 'anchor' | 'text'; i?: number; label?: string; editKind: 'property' | 'layout' };
  // fix-plan: a one-sentence warning that must travel WITH the edit, not only in the rendered row —
  // buildFixPlan copies it verbatim onto the FixPlanEdit. Set where the differ knows the delta may not
  // be a defect at all (today: a row a page scrollbar gutter can reach — notePageGutter, diff.ts).
  // Without it fix_plan — the machine-facing surface — says "edit the layout rule, not px" over pixels
  // the row beside it has already explained away.
  caveat?: string;
  // A profile-scope skip (an axis outside the layout profile) — a SEPARATE representation from
  // an environmental skip: coverageHoleRows/holeToBlocking EXCLUDE it
  // (a deliberate narrowing — not an environmental hole, blocking is not flooded with resolve_skips), deriveCoverage
  // carries the marker in coverage.skipped. Set ONLY by applyLayoutProfileScope (diff.ts).
  profileScoped?: true;
}

export interface PairSummary { pass: number; fail: number; warn: number; skip: number; info: number; demoted: number; unchecked: number; review: number }

// Coverage manifest of a pair ("honest green"): what was ACTUALLY measured (auto-derived from
// the emitted rows, see deriveCoverage in diff.ts) vs what was skipped (with a reason). Defined here
// (not in diff.ts) so that types.ts stays free of incoming imports from diff.ts — diff.ts imports
// PairCoverage from here.
// skipped.profileScoped: the axis was skipped by the PROFILE (a deliberate scope narrowing),
// not by the environment — without the marker a profile scope is indistinguishable from an environmental skip.
export interface PairCoverage { measured: string[]; skipped: { dim: string; reason: string; profileScoped?: true }[] }

export interface PairResult {
  node_id: string;
  label?: string;
  selector?: string;
  rows: DiffRow[];
  summary: PairSummary;
  coverage?: PairCoverage;
  source?: PairSource; // source-hint: code addresses of the discrepancies, assembled by the tool from attributionOut
  // fix-plan: fail rows of editable axes, grouped by candidate file
  // (target = the SourceHint resolve of the channel's source). A pure DERIVATIVE of rows (gate fail && srcChannel)
  // → in the tool's budget cascade it is dropped at a tier BETWEEN condense and omitted_pairs (fix_plan_stripped:true
  // in the response). Assembled by buildFixPlan in the tool; no channel mutates rows — a pure side-output.
  fix_plan?: FixPlanGroup[];
  fix_plan_capped?: number; // how many edits were cut by the caps (10 groups × 10 edits) — the cut is honest
}

// ── fix-plan: a group of edits for a single candidate file ────────────────────────────────────────
// ONE candidate file = ONE edit group. target — a SourceHint candidate (classList parse), NOT the truth:
// module+local is NOT a unique address (N places may be N files) — the consumer must confirm it
// by resolving. A null target = the address was not derived (a single group channel:'unknown', last).
export interface FixPlanEdit {
  prop: string;                       // 'gap[0] a↔b' | 'font-weight[title]' | 'fill' | 'size.w' …
  kind: 'property' | 'layout';        // property — a literal edit "set it to 550"; layout — fix the RULE (gap/flex/width), not px
  expected: string | number | null;   // row.figma AS IS (no tolerance recomputation)
  actual: string | number | null;     // row.dom AS IS
  delta?: number;                     // row.delta (if the row carried it)
  caveat?: string;                    // row.caveat AS IS — a reason this delta may not be a defect (e.g. a page scrollbar gutter reaches this row)
}
export interface FixPlanGroup {
  target: SourceHint | null;          // the channel's source resolve; null = the address was not determined
  channel: 'root' | 'child' | 'anchor' | 'text' | 'unknown'; // channel of the group's first edit; a null group is always 'unknown'
  edits: FixPlanEdit[];
}

// ── source-hint: addressing discrepancies back to the source code ────────────────────────
// The differ is silent about CSS classes (it compares the result, not the mechanism) — but the CSS-modules class
// of the matched DOM node carries a deterministic file/local address (parseCssModuleClass). PairSource aggregates
// these addresses BY discrepancy CHANNEL so that the consumer (the markdown renderer) can navigate to the edits without
// raster guessing. The differ does NOT parse classes — it deposits the RAW data (PairAttribution below), the tool
// parses and assembles it (hintForNode). No channel mutates rows — a pure side-output.
export interface PairSource {
  root?: SourceHint;   // address of the pair root itself (componentHints.classList of the DOM side)
  anchor?: SourceHint; // carrier of style_anchor — the LAST link of the transparent wrappers; the address for style edits (fill/border/radius/…)
  // POSITIONALLY = gap[i]/offset-cross[i]: children[k].i — the child's index in POST-salvage/unwrap
  // space (as in the metric rows). An array (not a Record) — same-named children ('card'×2) do not
  // collapse. The hint is taken from domKids2[i] (the matched node), not by the raw index of d.children.
  children?: Array<{ i: number; name: string; hint: SourceHint }>;
  // label = the suffix of the typography row ('[tabs→"Popular"]') - as in color[...] props; the hint is chosen
  // from the ANCESTOR CHAIN of the DOM text (the nearest parseable one), not from the immediate parent.
  text?: Array<{ label: string; hint: SourceHint }>;
  // unmatched DOM children of a structure_mismatch (cap 10): navigation-to-INVESTIGATE (add pairs),
  // NOT an address-to-fix. path = the :nth-child selector of the DOM node.
  unpaired?: Array<{ path: string; hint: SourceHint }>;
  note?: string; // EXACTLY when classList is non-empty but NOT ONE channel parsed (minified/utility/BEM)
}

// The raw attribution data that diff.ts deposits into DiffOptions.attributionOut (a read-only collection at the same
// points where the rows take their data). The tool parses it into PairSource — the parser (parseCssModuleClass)
// is NOT imported into diff.ts (the differ carries only tag/classList/names/indices/paths).
export interface PairAttribution {
  children?: Array<{ i: number; name: string; classList?: string[] }>;
  anchorClassList?: string[];
  // the classList chain of the text carrier's ANCESTORS, bottom-up (cap 4) — the nearest PARSEABLE one
  // is chosen by the tool; a class-less <span> wrapper between the carrier and the text does not lose the channel.
  text?: Array<{ label: string; classListChain: string[][] }>;
  unpaired?: Array<{ path: string; classList?: string[] }>;
}

// A1 machine-gated verification receipt: turns honesty from a prose verdict (which an AI
// swallows) into a machine structure + a boolean `complete` that the figma-dom-diff skill gates
// before "done", and into an actionable checklist `blocking` (exactly what is left to do).
export interface BlockingItem {
  kind: string;        // structure_mismatch | children_truncated | snapshot | not_found | extractor_outdated | skip | truncated_text | uncovered_region | unchecked_spacing | viewport | frame_missing | unconfirmed_token | scope_incomplete
  node_id?: string;
  selector?: string;
  // machine token of the next step. THIRTEEN values, spelled out for a reader and explicitly NOT a
  // source of truth: this comment used to list 12 and omit fix_frame_id, and both documentation
  // pages that restated it inherited that omission. docs-complete-lists.test.ts derives the set from
  // the `action` property assignments in verification.ts instead (including the ternary at the
  // truncated_text site, which is the only place add_text_pair is emitted) and forbids this line as
  // a source.
  action: string;      // add_pairs_on_children | raise_max_depth | re_extract_dom | fix_pair | update_extractor | resolve_skip | add_text_pair | add_pair | add_container_pair | fix_viewport | fix_frame_id | confirm_token | run_token_aware
  detail: string;      // human-readable (R3 hybrid)
  // aggregated confirm_token records: a list of places, truncated by the PLACES_CAP cap (the detailed ×N is in detail)
  places?: { node_id: string; prop: string }[];
  places_capped?: number; // how many places were cut by the PLACES_CAP cap from places (the full ×N is in detail)
  // uncovered_region GROUP: the number of same-kind regions collapsed into this item (ONLY on a group;
  // for a token aggregate, multiplicity is carried by places.length). A structural signal of aggregateness for
  // the rankOf sort — parsing detail is forbidden.
  count?: number;
}
// FRAME coverage (thread A): worthy regions of the frame vs the submitted pairs. Honest about truncation —
// if enumeration was truncated, complete CANNOT be true.
export interface FrameCoverage {
  worthy: number;                 // worthy regions of the frame (figWorthy after figUnwrap)
  covered: number;                // the region itself is paired OR something in its subtree is paired
  uncovered: string[];            // regions where NOTHING is paired — the layout is not verified (truncated by cap 60, see uncovered_capped)
  partial: string[];              // ≥2 direct worthy children are paired but the container is not: the paddings BETWEEN the children are not verified (inter-pair spacing; truncated by cap 60, see partial_capped)
  enumeration_truncated: boolean; // the frame projection was truncated by a cap → coverage is incomplete
  uncovered_capped?: number;      // how many ids were cut from uncovered by a cap (JSON budget protection)
  partial_capped?: number;        // how many ids were cut from partial by a cap (JSON budget protection)
  // enumeration_depth = the projector's DEPTH ALLOWANCE, NOT a coverage guarantee — always read together with
  // enumeration_causes: a narrow but deep frame at depth=8 may be complete, while a
  // wide one at the same depth is cut by budget/breadth. depth by itself proves nothing.
  enumeration_depth: number;      // the depth at which enumeration was performed (opts.enumeration.depth)
  enumeration_source: 'deep' | 'pair_fetch'; // deep — a separate whole-frame fetch (cap 8); pair_fetch — enumeration by pair depth (may be <8)
  enumeration_causes?: Array<'depth' | 'breadth' | 'budget'>; // the union of cut causes across ALL truncated regions (walk selfTrunc + the frame root) — the source of the advice matrix
  enumeration_note?: string;      // human-readable cause + advice (raise_max_depth is not always valid — see buildVerification)
}
export interface VerificationReceipt {
  complete: boolean;              // strict gold standard: NOTHING is left unverified (fail=demoted=unchecked=holes=0 AND, at scope frame, coverage is full+not truncated)
  scope: 'pairs' | 'frame';       // frame — if frame_node_id is given; pairs — "only the submitted pairs were checked, NOT the whole screen"
  pairs: { checked: number; clean: number };
  frame_coverage?: FrameCoverage; // at scope frame and when the frame was found
  blocking: BlockingItem[];       // ONLY actionable steps; inherent caveats (demoted hug/fill) do NOT go here (anti-cry-wolf) — they surface via the clean<checked counter
  blocking_capped?: number;       // how many actionable items were cut from JSON (response budget protection) — completeness is not lost: complete is false anyway
  // Inter-children spacing audit of partial containers (auditContainer) —
  // ONLY when the tool passed captures AND there is at least one auditable container (otherwise the field is omitted,
  // not []). Does NOT clear complete=false (the container's insets are still not proven by the audit — see insets_unverified).
  spacing_audit?: SpacingAuditEntry[];
  // (c) batch dominance: ≥2 checked pairs
  // muted by ONE viewport cause → one loud aggregate instead of N quiet unchecked rows.
  // The numbers come ONLY from the structural fields of the geometry row; other geometry causes (scroll/
  // rotated/transform/rect≈0) carry no fields → are not counted. window/frame are representative of the FIRST
  // such pair (a shared cause — not an average/maximum). Omitted (not false/[]) when pairs <2.
  dominant_blocker?: { kind: 'viewport'; pairs: number; window: number; frame: number };
  // The call's profile (single source — the tool's parsed arg) across all three modes —
  // the after-the-fact audit "the final was non-layout" is checked against this field, not against prose. Omitted only
  // in legacy buildVerification calls without matchProfile (unit tests).
  match_profile?: MatchProfile;
}

// ── Audit of the spacing between already-paired children of a partial container ──
// The container itself is WITHOUT a pair (verification.ts partialContainers), but ≥2 of its direct children are paired —
// the gap BETWEEN them can be measured directly from the rects of the paired children, without a pair on the container.
// spacing-audit.ts (auditContainer) consumes these types; verification.ts does not know them — a clean
// separation of coverage (what is covered) vs audit (what was measured without an explicit pair).

// per-pair slice of the DOM capture needed by the audit (internal — does not go into the pair output).
export interface CaptureInfo {
  ref?: string;                // the pair's dom_ref.ref; undefined = inline dom (the capture is unprovable — cannot compare)
  rect?: SpecRect;             // rect of the snapshot root (getBoundingClientRect, border-box)
  borders?: Edges;             // computed border widths of the root — they widen tolerance on the facing side
  geometryUnchecked: boolean;  // the pair has a geometry:unchecked row (env gate: rotated/scroll/transform)
}

export interface SpacingAuditGap {
  between: [string, string];   // ids of the paired chain nodes (Figma) on both sides of the gap
  figma: number;                // always computed honestly from Figma geometry — the unchecked gates do not touch it
  // dom/delta are OMITTED under unchecked (precedent DiffRow.figma?/dom?/delta? above): fabricating
  // dom=figma/delta=0 under unchecked would be an independently-readable "green" numeric channel — a consumer
  // reading numbers without status would see a "match" where no comparison was performed at all. status+note
  // remain the only source of truth for unchecked rows; dom/delta are filled ONLY on pass/fail.
  dom?: number; delta?: number;
  status: 'pass' | 'fail' | 'unchecked';
  note?: string;
}

// Inter-children gaps of a partial container — auditContainer measures them DIRECTLY from the rects of the
// already-paired children, WITHOUT a pair on the container.
export interface SpacingAuditEntry {
  container_id: string; axis: 'row' | 'col';
  gaps: SpacingAuditGap[];
  insets_unverified: true;     // the audit does NOT measure the container's insets — an explicit field, not silence
  // Final hardening: marker set by verification.ts (NOT auditContainer —
  // it lacks the pairedCount/expectedGaps context) when EVERY expected between-children gap for this
  // container was emitted AND passed (the same condition that already suppresses unchecked_spacing
  // blocking). Between-children spacing IS verified for a fully_clean container — only the container's
  // OWN insets remain unmeasured. report.ts reads this to stop mis-attributing that remainder as
  // "(spacing between children) not verified", which understated what was actually checked.
  fully_clean?: true;
}
