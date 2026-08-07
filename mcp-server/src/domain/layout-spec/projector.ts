// mcp-server/src/domain/layout-spec/projector.ts
// Flat, diff-ready projection of ONE node + its visible in-flow children.
// Not recursive (children — one level), does not intern globalVars, does not pull
// token/mode-precedence from simplify (that lives in design-context and changes separately).
import type { RawSceneNode, RawPaint, RawEffect, ComponentRefMeta } from '../figma-raw.js';
import { paintValue } from '../design-context/simplify.js';
import { rgbaToHex } from '../design-context/color.js';
import type { DomColorToken, Edges, GradientModel, LayoutSpec, ResolvedColorToken, SpecChild, SpecRect, SpecShadow, SpecTypography, TextLeaf } from './types.js';
import { SNIPPET_CAP } from './types.js';

// VIEW_CAPS: per-view breadth/depth/budget registry. `branch` == the FROZEN consts (three-mirror
// anchor). Nav views (skeleton/coverage/typography/spacing) widen; sibling-summary keeps skeleton's
// node count bounded despite the wide breadth cap. Nav numbers are calibration-tunable;
// `branch` is frozen — it is the mirror-locked identity for get_layout_spec/compare_node_to_dom.
export interface ViewCaps {
  maxSpecChildren: number;    // top-level breadth cap
  maxNestedChildren: number;  // per-hop nested breadth cap
  maxTotalNodes: number;      // total-node budget base
  totalCeiling: number;       // the Math.min() ceiling on budgetFor
}

// branch.maxTotalNodes = 90 (was 60, measured empirically): a typical
// 15-row ds-list card (card-body→ds-list→ds-list-item×15→[icon,label,value]×15, 4 levels)
// yields 62 live nodes — fits WITHOUT truncation (60 would already truncate such a card from ~row 15
// at the L3→L4 seam, honestly flagged childrenTruncated, but truncated nonetheless). The three mirrors
// (branch.maxTotalNodes + the extractor.ts literal + the Zod gate in dom-snapshot-schema.ts) must stay in sync.
// budgetForCaps: max_depth drill-down total-node budget — moves WITH maxDepth so a deeper
// drill-down (re-fetching a childrenTruncated branch at max_depth:6/8) doesn't immediately re-truncate
// on the total-node cap that was calibrated for the SHALLOWER default. branch: maxDepth 1-4 → 90
// (unchanged byte-for-byte); 5-8 → 180. The 300 ceiling is the Zod-backstop value, NOT reachable
// at maxDepth<=8 (Math.ceil(8/4)=2 → 180) — the formula reads the same as its sibling (descentFor in
// diff.ts) and the eventual Zod cap it anticipates.
export const VIEW_CAPS = {
  branch:     { maxSpecChildren: 30,  maxNestedChildren: 15, maxTotalNodes: 90,  totalCeiling: 300 },
  skeleton:   { maxSpecChildren: 120, maxNestedChildren: 60, maxTotalNodes: 400, totalCeiling: 600 },
  coverage:   { maxSpecChildren: 80,  maxNestedChildren: 40, maxTotalNodes: 300, totalCeiling: 400 },
  typography: { maxSpecChildren: 80,  maxNestedChildren: 40, maxTotalNodes: 300, totalCeiling: 400 },
  spacing:    { maxSpecChildren: 80,  maxNestedChildren: 40, maxTotalNodes: 300, totalCeiling: 400 },
} as const satisfies Record<string, ViewCaps>;

// ENUM_CAPS: the INTERNAL profile for verification's coverage enumeration. NOT in VIEW_CAPS —
// this is neither a get_view view nor an output-bearing spec: the enumeration result is not serialized
// into the output (only the derived receipt lists are), so the output-motivated branch/view caps don't
// apply. The bounds are defence-in-depth against pathologies (hydrated:false raw); a real frame
// (~hundreds of nodes at depth-9, calibrated 2026-07-09) never touches them → a budget/breadth cut of
// the enumeration is a corner case.
// THE PAIR PROJECTION PATH STAYS ON branch (the compare tool passes no caps) — locked by view-caps.test.
export const ENUM_CAPS: ViewCaps = { maxSpecChildren: 200, maxNestedChildren: 200, maxTotalNodes: 2000, totalCeiling: 2000 };

// Whether truncation happened anywhere in the spec (root or descendants). Moved out of
// suggest-pairs-tool (compare-coverage stage 2 needs it too) — semantics 1:1.
export function anyTruncatedSpec(spec: { childrenTruncated?: boolean; children?: SpecChild[] }): boolean {
  if (spec.childrenTruncated === true) return true;
  return (spec.children ?? []).some((k) => anyTruncatedSpec(k));
}

export function budgetForCaps(caps: ViewCaps, maxDepth: number): number {
  return Math.min(caps.totalCeiling, caps.maxTotalNodes * Math.max(1, Math.ceil(maxDepth / 4)));
}

// Back-compat exports (== branch): external importers (get-layout-spec-tool budgetFor) unchanged.
export const MAX_SPEC_CHILDREN = VIEW_CAPS.branch.maxSpecChildren;
export const MAX_NESTED_CHILDREN = VIEW_CAPS.branch.maxNestedChildren;
export const MAX_TOTAL_NODES = VIEW_CAPS.branch.maxTotalNodes;
export function budgetFor(maxDepth: number): number { return budgetForCaps(VIEW_CAPS.branch, maxDepth); }
// REST fetch (?depth=N) — the third mirror of capture depth. Without raising
// THIS constant in sync, deeper capture (flowChildren/projectChildren) is a no-op on the Figma side:
// raw L4 nodes simply don't arrive from REST, and the descent into projectChildren decrements depthLeft
// for nothing. FETCH = projection+1 (peek headroom for the honest flag at the boundary; the extra raw
// level is NOT projected and NOT auto-descended).
export const FETCH_DEPTH = 5;

const AXIS: Record<string, 'row' | 'col'> = { HORIZONTAL: 'row', VERTICAL: 'col' };

export interface ProjectorContext {
  components?: Record<string, ComponentRefMeta>; // entry.components from the /nodes response
  setNames?: Map<string, string>;                // componentSetId → set name (prepared by the tool)
  // mode-resolved color token, INJECTED by the caller — the projector stays pure
  // (no IO/variable fetches). The real resolver (reuse resolveBoundVariableInMode) is wired in by the calling tool;
  // here it's only the call site + the type. undefined = not resolved (no bound variable / no resolver given).
  resolveColorToken?: (node: RawSceneNode, key: 'fills' | 'strokes') => ResolvedColorToken | undefined;
  // Best-effort style-name resolver, INJECTED by callers (like resolveColorToken). styleId (e.g.
  // "S:brand") → human name (e.g. "Brand/Primary"). undefined = not resolvable (no map / not provided).
  styleNames?: (styleId: string) => string | undefined;
}

// Fill-STYLE id of a node (the shared paint-style bound to the fill slot), if any. Gated STRICTLY on
// the fill/fills slot — a text/effect/grid style slot must NEVER be read as a fill tokenization
// (over-correction guard G1). Absent styles → undefined (no-op guard G2).
function fillStyleId(raw: RawSceneNode): string | undefined {
  return raw.styles?.fill ?? raw.styles?.fills;
}

// Stroke-STYLE id of a node (the shared paint-style bound to the stroke slot), if any. Symmetric to
// fillStyleId: gated STRICTLY on the stroke/strokes slot — a fill/text/effect style slot must NEVER be
// read as a stroke tokenization (over-correction guard G1). Absent styles → undefined (no-op guard G2).
function strokeStyleId(raw: RawSceneNode): string | undefined {
  return raw.styles?.stroke ?? raw.styles?.strokes;
}

function rectOf(n: RawSceneNode): SpecRect | undefined {
  const b = n.absoluteBoundingBox;
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : undefined;
}

function padsOf(n: RawSceneNode): Edges | undefined {
  if (n.paddingTop === undefined && n.paddingRight === undefined
    && n.paddingBottom === undefined && n.paddingLeft === undefined) return undefined;
  return { top: n.paddingTop ?? 0, right: n.paddingRight ?? 0, bottom: n.paddingBottom ?? 0, left: n.paddingLeft ?? 0 };
}

function solidHex(paints: RawPaint[] | undefined): string | undefined {
  const v = paintValue(paints);
  return typeof v === 'string' && v.startsWith('#') ? v : undefined;
}

// A visible IMAGE/VIDEO fill → the node carries CONTENT (avatar/preview/photo), not decoration — even
// if its type is RECTANGLE/ELLIPSE. Gate for excluding decorative leaves in verification (an unpaired
// image must not silently pass as "not a region").
function hasImageFill(paints: RawPaint[] | undefined): boolean {
  return (paints ?? []).some((p) => (p.type === 'IMAGE' || p.type === 'VIDEO') && p.visible !== false);
}

// The same paint paintValue takes the hex from (the first VISIBLE solid): if its color is
// bound to a variable (paint-level RawPaint.boundVariables.color — figma-raw.ts:22,
// NOT RawColorStop:13), the hex is a snapshot of the library default-mode and may legitimately
// differ in the app (a different mode). The diff downgrades such a divergence ❌→⚠️.
function boundColor(paints: RawPaint[] | undefined): string | undefined {
  const solid = paints?.find((x) => x.visible !== false && x.type === 'SOLID' && x.color);
  return solid?.boundVariables?.color?.id;
}

function projectShadow(effects: RawEffect[] | undefined): SpecShadow | undefined {
  const shadows = (effects ?? []).filter((e) => e.visible !== false
    && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'));
  const first = shadows[0];
  if (!first) return undefined;
  const s: SpecShadow = { inner: first.type === 'INNER_SHADOW', x: first.offset?.x ?? 0,
    y: first.offset?.y ?? 0, blur: first.radius ?? 0, spread: first.spread ?? 0, count: shadows.length };
  if (first.color) s.colorHex = rgbaToHex(first.color);
  const boundColorVar = first.boundVariables?.color;
  const bound = Array.isArray(boundColorVar) ? boundColorVar[0] : boundColorVar;
  if (bound?.id) s.colorBoundVar = bound.id;
  return s;
}

const FIG_GRADIENT_KIND: Record<string, GradientModel['kind']> = {
  GRADIENT_LINEAR: 'linear',
  GRADIENT_RADIAL: 'radial',
  GRADIENT_ANGULAR: 'conic',
  // GRADIENT_DIAMOND (and any unknown) → 'unknown' via the ?? below.
};

// Aspect-corrected angle of a linear gradient for FAIL-precise verification (unlike color.ts
// handleAngle, which measures the angle in NORMALIZED 0..1 space without correction — that one is for
// get_design_context, where precision doesn't gate the verdict, and is deliberately NOT reused here).
// Handle coordinates are normalized to the bbox → we multiply the components by the real w/h to get the
// angle in pixels, as the browser sees it. atan2(vx, -vy): 0°=up, increasing clockwise (the CSS
// convention). A degenerate rect (w or h == 0) OR a zero vector → undefined → downstream honestly emits
// info (angle not measurable).
function aspectAngle(handles: { x: number; y: number }[] | undefined, rect: SpecRect | undefined): number | undefined {
  if (!handles || handles.length < 2 || !rect || rect.w === 0 || rect.h === 0) return undefined;
  const vx = (handles[1].x - handles[0].x) * rect.w;
  const vy = (handles[1].y - handles[0].y) * rect.h;
  if (vx === 0 && vy === 0) return undefined;
  const deg = Math.round((Math.atan2(vx, -vy) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

// RawPaint (GRADIENT_*) → GradientModel: kind + stops (hex via rgbaToHex) + aspect-corrected angle
// (linear only) + provenance. The per-stop token RESOLVER (the stop's variable name) is DEFERRED — like
// shadow.colorToken: a bound stop sets {unknown:'bound-unresolved'} (the signal "tokenized, name not
// resolved") until a separate pass wires in a per-stop resolver (the current
// ProjectorContext.resolveColorToken resolves paint-level color, NOT per-stop). On the Figma side, with
// any bound stop, whole = {token:'(paint)'} — this is the provenance STATE "tokenized", the name is NOT
// verified, consistent with the per-stop deferral.
// whole-tokenization is detected via TWO paths (together they close the old "fill-style invisible" hole):
// (1) any bound stop (boundVariables) → anyBound → {token:'(paint)'} — LOCAL logic below,
// (2) the node's shared fill-STYLE (raw.styles.fill, now present in the raw model) → the caller
// (buildLayoutSpec) RAISES whole: it resolves styleId→name and passes wholeToken = {token:'(style: <Name>)'}
// here when the name resolved, else the {token:'(paint)'} sentinel (STATE "tokenized, name not verified").
// Here wholeToken is applied ONLY when the stops are not bound (anyBound takes priority — a single signal).
// A legacy paint-style gradient WITHOUT bound stops no longer silently yields whole={literal}: it arrives
// as {token:...} via wholeToken, symmetric to the solid/text/stroke fill-STYLE. The per-stop stop name
// stays deferred (see above) — the one remaining incompleteness, honestly flagged.
// visibleGradientCount — how many VISIBLE image-like paints (GRADIENT_*/IMAGE/VIDEO)
// the node has (we project the first as the gradient, as the DOM takes the first background-image layer).
// >1 → model.multiLayer, mirrors dom-extractor.ts:577 (layers.length>1) — that counts ALL image layers
// (gradients AND url() images, only the solid base is excluded from the count), so the counter here is
// likewise not limited to gradients alone: without it a coexisting IMAGE/VIDEO layer is silently dropped
// and a single↔single match on the first paint = false-green. SOLID never reaches here (see the calling
// code: the allow-list is explicit, not `!== 'SOLID'`). The downstream verdict emits a symmetric info
// "several layers — verify visually".
function figmaGradient(paint: RawPaint, rect: SpecRect | undefined, visibleGradientCount = 1, wholeToken?: DomColorToken): GradientModel {
  const kind = FIG_GRADIENT_KIND[paint.type] ?? 'unknown';
  const rawStops = paint.gradientStops ?? [];
  const paintOpacity = paint.opacity ?? 1; // paint-level opacity is multiplied into EVERY stop's alpha —
  // mirrors the solid-path paintValue (a:(color.a??1)*(opacity??1)); at opacity===1 the result is
  // identical to before (rgbaToHex drops the alpha octet when a>=1). Without it a stop hex with no
  // multiplier → a false alpha fail against the DOM computed rgba.
  let anyBound = false;
  const stops = rawStops.map((s) => {
    let token: DomColorToken = { literal: true };
    if (s.boundVariables?.color?.id) {
      anyBound = true;
      token = { unknown: 'bound-unresolved' }; // per-stop name resolver deferred (see comment above)
    }
    const effColor = { ...s.color, a: (s.color.a ?? 1) * paintOpacity };
    return { position: s.position, hex: rgbaToHex(effColor), token };
  });
  const model: GradientModel = {
    kind,
    stops,
    whole: anyBound ? { token: '(paint)' } : (wholeToken ?? { literal: true }),
  };
  if (visibleGradientCount > 1) model.multiLayer = true;
  if (kind === 'linear') {
    const a = aspectAngle(paint.gradientHandlePositions, rect);
    if (a !== undefined) model.angleDeg = a;
  }
  return model;
}

function typographyOf(n: RawSceneNode, ctx: ProjectorContext = {}): SpecTypography | undefined {
  if (typeof n.characters !== 'string' || !n.style) return undefined;
  const s = n.style;
  const t: SpecTypography = {};
  if (s.fontFamily !== undefined) t.fontFamily = s.fontFamily;
  if (s.fontWeight !== undefined) t.fontWeight = s.fontWeight;
  if (s.fontSize !== undefined) t.fontSize = s.fontSize;
  if (s.lineHeightPx !== undefined) t.lineHeightPx = s.lineHeightPx;
  if (s.lineHeightUnit !== undefined) t.lineHeightUnit = s.lineHeightUnit;
  if (s.letterSpacing !== undefined) t.letterSpacing = s.letterSpacing;
  const hex = solidHex(n.fills);
  if (hex) {
    t.colorHex = hex;
    const bound = boundColor(n.fills);
    if (bound) t.colorBoundVar = bound;
    const tt = ctx.resolveColorToken?.(n, 'fills');
    if (tt) t.colorToken = tt;
    // Text COLOR lives on the FILL slot (solidHex(n.fills)) → a shared fill-STYLE tokenizes the color.
    // fillStyleId reads ONLY fill/fills: the text-slot style is TYPOGRAPHY (font) and MUST NOT tokenize
    // color (guard G1). Unified STATE/NAME: name best-effort, else '(paint)' sentinel → colorToken always set →
    // colorVerdict branches C/D, no A2 softening. Bound var / token win.
    if (!bound && !t.colorToken) {
      const sid = fillStyleId(n);
      if (sid) {
        const nm = ctx.styleNames?.(sid);
        t.colorToken = { token: nm ? `(style: ${nm})` : '(paint)', hex };
      }
    }
  }
  return t;
}

// TEXT with non-empty text: a snapshot for content identification + a fixed-width flag.
// Collapse BEFORE the slice (not after!) — symmetry with the DOM side (normSnippet): otherwise
// multi-line Figma texts (\n, repeated spaces) yield a different effective SNIPPET_CAP tail than the
// already-normalized DOM textContent, and the content match silently misses.
function textDataOf(n: RawSceneNode): { snippet?: string; fixedWidth?: true } {
  if (n.type !== 'TEXT' || typeof n.characters !== 'string' || n.characters.trim() === '') return {};
  const snippet = n.characters.trim().replace(/\s+/g, ' ').slice(0, SNIPPET_CAP);
  const fixedWidth = n.textAutoResize === 'NONE' || n.textAutoResize === 'HEIGHT' ? true : undefined;
  return { snippet, ...(fixedWidth ? { fixedWidth } : {}) };
}

// Symmetric to the extractor's DOM predicate: hidden, absolute, and zero-area — out of flow.
function inFlowChildren(raw: RawSceneNode): RawSceneNode[] {
  return (raw.children ?? []).filter((c) =>
    c.visible !== false &&
    c.layoutPositioning !== 'ABSOLUTE' &&
    !!c.absoluteBoundingBox &&
    c.absoluteBoundingBox.width > 0 &&
    c.absoluteBoundingBox.height > 0,
  );
}

// Re-export the in-flow predicate for reuse by the skeleton view (views.ts). Internal callers keep
// the short `inFlowChildren` name; consumers get the disambiguated `inFlowSceneChildren`.
export { inFlowChildren as inFlowSceneChildren };

// Mirror of the extractor's DomChild.outOfFlow: children that ARE rendered but do not participate
// in this box's flow — visible, non-zero-area, layoutPositioning ABSOLUTE. A live run lost a
// frame's overlay and three modals to the silent filter above, and the truncation note ("cut by
// DEPTH") then pointed the reader at a knob that cannot reveal them: they were DIRECT children.
// Count them so the reader is told to pair such a node directly (the DOM side already says this).
// Invisible and zero-area children stay silent on both sides — they render nothing to pair.
function outOfFlowCount(raw: RawSceneNode): number {
  return (raw.children ?? []).filter((c) =>
    c.visible !== false &&
    c.layoutPositioning === 'ABSOLUTE' &&
    !!c.absoluteBoundingBox &&
    c.absoluteBoundingBox.width > 0 &&
    c.absoluteBoundingBox.height > 0,
  ).length;
}

function sortByAxis(kids: RawSceneNode[], axis: 'row' | 'col' | undefined): RawSceneNode[] {
  return [...kids].sort((a, b) => (axis === 'row'
    ? a.absoluteBoundingBox!.x - b.absoluteBoundingBox!.x
    : a.absoluteBoundingBox!.y - b.absoluteBoundingBox!.y)); // undefined → like col (by y), current semantics
}

// The unique non-empty TEXT in a child's subtree, no deeper than hopsLeft hops.
// cut = truth was left beyond inspection somewhere along the path: a per-hop cap truncation
// OR a node at the last hop has in-flow children (can't look deeper).
function collectTexts(n: RawSceneNode, hopsLeft: number, caps: ViewCaps): { found: RawSceneNode[]; cut: boolean } {
  // Footgun guard: auto-descend is bounded by the PROJECTION depth (hopsLeft passed in as
  // min(2, depthLeft) by the caller), not by however deep the raw tree happens to go. At the
  // depth boundary (hopsLeft<=0) a raw child one level deeper may already be present (the
  // FETCH=projection+1 peek) — without this guard the loop below would still match it directly (the "found" check
  // isn't itself gated by hopsLeft), silently promoting a peeked grandchild's typography onto
  // this node. Mirror dom-extractor.ts hasFlowContent: report honestly that content exists
  // beyond the cut instead of guessing at it.
  if (hopsLeft <= 0) return { found: [], cut: inFlowChildren(n).length > 0 };
  const kids = inFlowChildren(n);
  let cut = kids.length > caps.maxNestedChildren; // per-hop inspection cap
  const found: RawSceneNode[] = [];
  for (const k of kids.slice(0, caps.maxNestedChildren)) {
    if (typeof k.characters === 'string' && k.characters.trim() !== '' && k.style) {
      found.push(k);
    } else if (hopsLeft > 1) {
      const sub = collectTexts(k, hopsLeft - 1, caps);
      found.push(...sub.found);
      cut = cut || sub.cut;
    } else if (inFlowChildren(k).length > 0) {
      cut = true;
    }
  }
  return { found, cut };
}

function projectChildren(kids: RawSceneNode[], axisOf: (n: RawSceneNode) => 'row' | 'col' | undefined,
  depthLeft: number, cap: number, caps: ViewCaps, ctx: ProjectorContext = {}): { list: SpecChild[]; truncated: boolean } {
  const sorted = [...kids]; // kids already filtered by inFlowChildren and sorted by the calling level
  const truncated = sorted.length > cap;
  const list = sorted.slice(0, cap).map((c): SpecChild => {
    let t = typographyOf(c, ctx);
    let nested = false; let ambiguous = false; let uncertain = false; let beyondCut = false;
    if (!t) {
      // A conscious decision: hopsLeft is LEFT at 2, NOT bumped to 3 to follow the
      // capture depth of 4. This is a different detector — "c as a whole is a simple TEXT wrapper"
      // (the CHILD's typography auto-descends ONTO c, while domKids[i] in diff.ts is taken as the whole
      // c-level DOM node, not descending to its own descendants). Bumping to 3 would make it auto-describe
      // typography for a TEXT sitting 3 hops below c (exactly the L4 case) — but then
      // diff.ts would compare the Figma typography of an L4 leaf against the computed styles of the
      // DOM NODE c (L1), not against the real DOM leaf: computed styles are INHERITED (getComputedStyle
      // on a wrapper returns the inherited, not the own, font-size of a specific nested element) — the
      // comparison would become plausible but WRONG (a false pass/fail on someone else's numbers). Deep/
      // multiple TEXT stays with collectFigTexts/collectDomTexts in diff.ts (an unbounded DFS over the
      // ACTUALLY captured spec/dom tree, leaf compared with leaf). The hopsLeft=2 cut and the L1-L4
      // capture are orthogonal: as long as diff.ts doesn't block collectFigTexts on
      // textBeyondCut/textAmbiguous (see crossAndPaddingRows — fixed in the same place), a "cut without
      // found" on the 2-hop cut doesn't silently lose the signal — it merely yields to the more precise deep DFS matching.
      // hopsLeft bounded by the remaining PROJECTION depth, not the fetch/peek depth — see
      // collectTexts' own B4 guard above for why this matters at the depth boundary.
      const { found, cut } = collectTexts(c, Math.min(2, depthLeft), caps);
      if (found.length === 1) { t = typographyOf(found[0], ctx); nested = true; uncertain = cut; }
      else if (found.length > 1) ambiguous = true;
      else if (cut) beyondCut = true;
    }
    const pads = padsOf(c);
    const td = textDataOf(c);
    const childAxis = axisOf(c);
    const child: SpecChild = { id: c.id, name: c.name, type: c.type, rect: rectOf(c)!,
      ...(childAxis ? { axis: childAxis } : {}),
      ...(hasImageFill(c.fills) ? { imageFill: true as const } : {}),
      ...(t ? { text: t } : {}), ...(nested ? { textFromNested: true } : {}),
      ...(ambiguous ? { textAmbiguous: true } : {}),
      ...(uncertain ? { textUncertain: true } : {}),
      ...(beyondCut ? { textBeyondCut: true } : {}),
      ...(td.snippet !== undefined ? { textSnippet: td.snippet } : {}),
      ...(td.fixedWidth ? { textFixedWidth: true } : {}),
      ...(pads ? { paddings: pads } : {}),
      ...(c.layoutSizingHorizontal === 'HUG' ? { hugWidth: true as const } : {}) };
    // Counted at EVERY projected level, the depth-terminal one included (raw is one level deeper
    // than the projection by FETCH=projection+1, so the count is real there) — at the boundary a
    // node whose children are ALL out of flow fires neither branch below and used to lose them
    // with zero signal on either channel.
    const oof = outOfFlowCount(c);
    if (oof > 0) child.outOfFlow = oof;
    if (depthLeft > 0) {
      const grand = sortByAxis(inFlowChildren(c), axisOf(c));
      const sub = projectChildren(grand, axisOf, depthLeft - 1, caps.maxNestedChildren, caps, ctx);
      child.children = sub.list;
      if (sub.truncated) { child.childrenTruncated = true; child.truncationCause = 'breadth'; }
    } else if (inFlowChildren(c).length > 0) {
      // the depth budget is exhausted, but there IS real in-flow content under the node — honest, not a
      // fake list. Mirrors dom-extractor.ts hasFlowContent. Requires raw one level deeper than the
      // projection (FETCH=projection+1) — otherwise inFlowChildren(c) is empty at the boundary and the branch is a no-op.
      child.childrenTruncated = true;
      child.truncationCause = 'depth';
    }
    return child;
  });
  return { list, truncated };
}

// Post-pruning of the total budget (budget mirrors the server's countNodes and the extractor; the
// value comes from budgetFor(maxDepth), default MAX_TOTAL_NODES=90 at maxDepth=4): a level is accepted
// whole only if it fits in the remainder; otherwise its children are removed (childrenTruncated=true)
// and the node itself stays. The reservation for the whole level is made BEFORE the decision on a
// specific node — otherwise "flat" siblings past the budget threshold still make it into the output
// (each array node is unremovable) and the total can exceed the limit.
function pruneToBudget(kids: SpecChild[], state: { n: number }, budget: number): void {
  state.n += kids.length;
  for (const k of kids) {
    if (!k.children) continue;
    // budget prune runs AFTER projection: it can overwrite a breadth cut (node still had children) to
    // 'budget' — both are honest hedges, so precedence is fine. A DEPTH cut has no children → the
    // `!k.children` guard above skips it → 'depth' is never overwritten (the load-bearing invariant).
    if (state.n + k.children.length > budget) { k.childrenTruncated = true; k.truncationCause = 'budget'; delete k.children; continue; }
    pruneToBudget(k.children, state, budget);
  }
}

export function buildLayoutSpec(raw: RawSceneNode, ctx: ProjectorContext = {},
  opts: { maxDepth?: number; caps?: ViewCaps } = {}): LayoutSpec {
  // Capture depth becomes a parameter — clamped [1,8], default 4 (byte-for-byte the earlier
  // fixed depth). Drives BOTH mirrors below (projectChildren depthLeft, pruneToBudget budget).
  const maxDepth = Math.min(8, Math.max(1, opts.maxDepth ?? 4));
  // Per-view caps foundation. Default == VIEW_CAPS.branch (the frozen mirror) so
  // get_layout_spec/compare_node_to_dom stay byte-identical; nav views pass wider caps.
  const caps = opts.caps ?? VIEW_CAPS.branch;
  const spec: LayoutSpec = { node: { id: raw.id, name: raw.name, type: raw.type }, children: [] };

  const rect = rectOf(raw);
  if (rect) spec.rect = rect;
  if (raw.rotation) spec.rotated = true;

  const axis = raw.layoutMode ? AXIS[raw.layoutMode] : undefined;
  if (axis) {
    spec.axis = axis;
    spec.autoLayout = {
      ...(raw.itemSpacing !== undefined ? { gap: raw.itemSpacing } : {}),
      padding: {
        top: raw.paddingTop ?? 0, right: raw.paddingRight ?? 0,
        bottom: raw.paddingBottom ?? 0, left: raw.paddingLeft ?? 0,
      },
    };
  }
  // E (hug-vs-fill): a root container with HUG width hugs its content — the diff demotes size.w/
  // padding/gap on the main axis if the DOM stretches wider (fill). Mirrors projectChildren:195 for children.
  if (raw.layoutSizingHorizontal === 'HUG') spec.hugWidth = true;

  // Thread D: the first VISIBLE non-image/non-video paint. If it's GRADIENT_* → we project a gradient
  // model and do NOT set fillHex (mutually exclusive for this paint — fillHex measures solid, the
  // gradient is measured separately). solidHex/paintValue would itself return undefined on a gradient,
  // but an explicit gate makes the contract readable and guards against future changes to paintValue.
  const fills = raw.fills ?? [];
  const firstVisiblePaint = fills.find((p) => p.visible !== false && p.type !== 'IMAGE' && p.type !== 'VIDEO');
  if (firstVisiblePaint && firstVisiblePaint.type.startsWith('GRADIENT_')) {
    // Explicit image-like allow-list (GRADIENT_*/IMAGE/VIDEO), NOT `!== 'SOLID'` —
    // an allow-list can't be silently inflated by a future unknown paint type. SOLID deliberately
    // excluded (see comment above figmaGradient).
    const visibleImageLike = fills.filter((p) => p.visible !== false
      && (p.type.startsWith('GRADIENT_') || p.type === 'IMAGE' || p.type === 'VIDEO')).length;
    const styleId = fillStyleId(raw);
    const styleName = styleId ? ctx.styleNames?.(styleId) : undefined;
    // fill-STYLE (no bound stops) → whole tokenized-STATE; name best-effort, else (paint) sentinel.
    const wholeOverride: DomColorToken | undefined = styleId ? { token: styleName ? `(style: ${styleName})` : '(paint)' } : undefined;
    spec.gradient = figmaGradient(firstVisiblePaint, spec.rect, visibleImageLike, wholeOverride);
  }

  const fill = solidHex(raw.fills);
  if (fill && !spec.gradient) {
    spec.fillHex = fill;
    const bound = boundColor(raw.fills);
    if (bound) spec.fillBoundVar = bound;
    const rt = ctx.resolveColorToken?.(raw, 'fills');
    if (rt) spec.fillToken = rt;
    // paint-STYLE (no bound var): a shared fill-style tokenizes the fill; name best-effort, else the '(paint)'
    // sentinel (mirrors the gradient whole). A paint-style hex is mode-independent & reliable, so STATE and NAME
    // are UNIFIED — both set fillToken and route through colorVerdict branches C (hex diverge → fail) / D (hex
    // match → provenance); NO A2 softening. Gate on !bound && !fillToken so a bound var always wins (single signal).
    if (!bound && !spec.fillToken) {
      const sid = fillStyleId(raw);
      if (sid) {
        const nm = ctx.styleNames?.(sid);
        spec.fillToken = { token: nm ? `(style: ${nm})` : '(paint)', hex: fill };
      }
    }
  }
  const stroke = solidHex(raw.strokes);
  if (stroke) {
    spec.strokeHex = stroke;
    const strokeBound = boundColor(raw.strokes);
    if (strokeBound) spec.strokeBoundVar = strokeBound;
    const st = ctx.resolveColorToken?.(raw, 'strokes');
    if (st) spec.strokeToken = st;
    // Symmetric to fill (unified STATE/NAME): a shared stroke-STYLE tokenizes the stroke when no bound var /
    // token is present; name best-effort, else '(paint)' sentinel → colorVerdict branches C/D, no A2 softening.
    if (!strokeBound && !spec.strokeToken) {
      const sid = strokeStyleId(raw);
      if (sid) {
        const nm = ctx.styleNames?.(sid);
        spec.strokeToken = { token: nm ? `(style: ${nm})` : '(paint)', hex: stroke };
      }
    }
  }
  if (raw.strokeWeight !== undefined) spec.strokeWeight = raw.strokeWeight;

  // Shadow token stays UNSET this task (deferred-and-honest): resolveColorToken's key union is
  // 'fills'|'strokes' only — shadows bind via the effect, not a paint key. SpecShadow.colorToken
  // is reserved for a future task; inventing shadow resolution here would be a false-precision hack.
  const shadow = projectShadow(raw.effects);
  if (shadow) spec.shadow = shadow;

  if (raw.cornerRadius !== undefined) spec.cornerRadius = raw.cornerRadius;
  if (raw.opacity !== undefined && raw.opacity < 1) spec.opacity = raw.opacity;

  const text = typographyOf(raw, ctx);
  if (text) spec.text = text;

  const rootTd = textDataOf(raw);
  if (rootTd.snippet !== undefined) spec.textNode = true;
  if (rootTd.fixedWidth) spec.textFixedWidth = true;

  if (raw.componentId) {
    const ref = ctx.components?.[raw.componentId];
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.componentProperties ?? {})) {
      props[k.replace(/#[0-9:]*/g, '')] = (v as { value: unknown }).value;
    }
    const setName = ref?.componentSetId ? ctx.setNames?.get(ref.componentSetId) : undefined;
    spec.component = {
      id: raw.componentId,
      ...(ref?.name ? { name: ref.name } : {}),
      ...(setName ? { setName } : {}),
      // p.3a: the set EXISTS but the name came from neither the meta nor the fallback — the diff needs a
      // precise reason for the info "did not resolve" (≠ "no set" — different mis-attributions)
      ...(ref?.componentSetId && !setName ? { setUnresolved: true as const } : {}),
      ...(Object.keys(props).length ? { props } : {}),
    };
  }

  const sorted = sortByAxis(inFlowChildren(raw), axis);
  // depthLeft = maxDepth-1 (was fixed 3 earlier, default maxDepth=4 gives the same 3): the second
  // mirror of capture depth — L1..L(maxDepth-1) get .children, L(maxDepth) is terminal (symmetric to
  // dom-extractor.ts flowChildren depthLeft). In sync with the fetch's FETCH_DEPTH equivalent
  // (maxDepth+1, without which there simply are no raw nodes at the boundary) and with dom-extractor.ts (the DOM side).
  const { list, truncated } = projectChildren(
    sorted, (n) => (n.layoutMode ? AXIS[n.layoutMode] : undefined), maxDepth - 1, caps.maxSpecChildren, caps, ctx,
  );
  spec.children = list;
  if (truncated) { spec.childrenTruncated = true; spec.truncationCause = 'breadth'; }
  const rootOof = outOfFlowCount(raw);
  if (rootOof > 0) spec.outOfFlow = rootOof;
  pruneToBudget(spec.children, { n: 0 }, budgetForCaps(caps, maxDepth));

  return spec;
}

// 🅰️-2: a flat list of leaf TEXT under the projected tree (get_layout_spec text_leaves).
// A leaf = a genuine TEXT node (type==='TEXT' with .text typography); wrappers are passed through.
// truncated=true if childrenTruncated was encountered along the way — there may be more TEXT beyond
// the max_depth cut (honest, we don't stay silent; ties into the diff.ts note "raise max_depth").
export function collectLeafTexts(spec: LayoutSpec): { leaves: TextLeaf[]; truncated: boolean } {
  const leaves: TextLeaf[] = [];
  let truncated = spec.childrenTruncated === true;
  if (spec.node.type === 'TEXT' && spec.text) {
    // root TEXT (node_id directly on the text): typography is present, text_snippet is NOT — LayoutSpec
    // doesn't persist it (persisting would break the byte-for-byte default for a TEXT root). A conscious minor.
    leaves.push({ id: spec.node.id, name: spec.node.name, path: [], typography: spec.text });
  }
  const walk = (children: SpecChild[] | undefined, path: string[]): void => {
    if (!children) return;
    // Segment disambiguation: we index ONLY on a name collision among siblings (or an empty name).
    // Otherwise repeated list-items yield the SAME path (e.g. both → item[2]) — and that's exactly the
    // main use case (lists = same-named rows). Unique names stay clean.
    const nameCount = new Map<string, number>();
    for (const c of children) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
    children.forEach((c, i) => {
      const seg = !c.name ? `${c.type}[${i}]` : ((nameCount.get(c.name) ?? 0) > 1 ? `${c.name}[${i}]` : c.name);
      const here = [...path, seg];
      if (c.type === 'TEXT' && c.text) {
        leaves.push({ id: c.id, name: c.name, path: here,
          ...(c.textSnippet !== undefined ? { text_snippet: c.textSnippet } : {}),
          typography: c.text });
      }
      if (c.childrenTruncated) truncated = true;
      walk(c.children, here);
    });
  };
  walk(spec.children, []);
  return { leaves, truncated };
}
