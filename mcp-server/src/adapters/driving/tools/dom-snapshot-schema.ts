// Zod contract for DomSnapshot. The schema version MUST match the SCHEMA constant
// inside EXTRACTOR_JS (dom-extractor.ts) — they are co-versioned, and a test checks it.
// `schema` is validated as an int (not a literal): a version mismatch yields an actionable
// error in the compare_node_to_dom handler, rather than a bare Zod fail.
import { z } from 'zod';
import type { DomSnapshot, DomChild } from '../../../domain/layout-spec/types.js';

// v2: added authored-binding color state (colorToken/backgroundColorToken/
// borderColorsToken/shadow.colorToken) — value-anchored token|literal|unknown. Additive (all fields
// optional), but the version was bumped because the colorVerdict consumer must know the DOM side
// carries a token signal. Candidates for schema v3 (accumulating breaking changes, not bumping one at a time):
// - an 'invalid_selector' status (currently conflated with not_found)
// - the fate of the `state` field (declared, but neither emitted nor compared)
// - modern colors in toHex (oklch()/color() → currently undefined → a false background warn)
//   (the VERDICT half closed by v7: paintUnknown + the fill review row; toHex itself still reads only rgb())
export const DOM_SNAPSHOT_SCHEMA_VERSION = 7;   // v3: styles.gradient added
// v4 — SNIPPET_CAP 120: old extractors truncate text at 40 WITHOUT a flag; at the server's 120
// threshold their cuts are indistinguishable from full text → mis-anchor; the version rejects them at both matcher inputs.
// v5 (style-anchor): a style bundle on children — radius/opacity/gradient in styles, shadow/borders/borderColors/data on the node; compact "no field = no style" semantics
// v6 (comparable corner radius): styles.borderRadius now means "all four CSS corners are this ONE px
// number" — the only shape Figma's single px cornerRadius can be compared against. Anything else (corners
// that differ, a percentage, an elliptical h/v radius) omits it and sets styles.borderRadiusUncomparable
// instead. The bump is the SAME shape as v4's, and for the same reason: a pre-v6 extractor emits
// borderRadius: 8 for `border-radius: 8px 0 0 0` and borderRadius: 50 for `border-radius: 50%`, both
// WITHOUT a flag, so on the wire those snapshots are byte-indistinguishable from a genuinely uniform 8px
// and 50px — the server cannot tell them apart, and the corner-radius row passes over an unmeasured
// difference. The field is additive, the MEANING of an existing field is not: without the version, the
// false green this release removes from the code would survive on every stale capture, silently.
// v7 (paint honesty): closes the verdict half of the v3 candidate "modern colors in toHex" (the fill
// row turns REVIEW instead of asserting "no background" the server now knows to be false; toHex
// itself is unchanged). styles.paintUnknown marks a
// box with a DECLARED paint the snapshot cannot classify — a CSS Color 4 background (oklch()/lab()/
// color()/color-mix() serialize outside toHex's rgb() grammar), a visible outline, painted
// ::before/::after content, a filter/backdrop-filter. Same bump argument as v4/v6: on a pre-v7 wire an
// oklch-painted wrapper is byte-identical to a transparent one, and every "this box paints nothing"
// consumer (the cross-axis encoding demote, transparentChild's style-anchor descent) would read a
// painted box as inert — a stale capture would GAIN a green over a paint nobody measured. v7 also
// re-scopes outOfFlow to count only visible absolutes (zero-area sr-only/focus-ring boxes are plain
// skips), mirroring the projector's count — the cross-axis demote fail-closes on the counter, and the
// pre-v7 counting would blank it on wrappers whose dropped children paint nothing.

// v2: authored-binding state per captured color — value-anchored token / literal / honest
// unknown (cross-origin | inherited). Consumed by colorVerdict; never claims literal when a
// sheet was unreadable or the property is inherited.
const TokenState = z.union([
  z.object({ token: z.string() }),
  z.object({ literal: z.literal(true) }),
  z.object({ unknown: z.string() }),
]);
const StringEdgesToken = z.object({ top: TokenState.optional(), right: TokenState.optional(),
  bottom: TokenState.optional(), left: TokenState.optional() });

const Rect = z.object({ x: z.number(), y: z.number(), w: z.number().min(0), h: z.number().min(0) });
const EdgesSchema = z.object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() });
const StringEdges = z.object({ top: z.string().optional(), right: z.string().optional(),
  bottom: z.string().optional(), left: z.string().optional() });
const ShadowSchema = z.object({ inset: z.boolean(), x: z.number(), y: z.number(), blur: z.number(),
  spread: z.number(), colorHex: z.string().optional(), colorToken: TokenState.optional(), count: z.number().int().min(1) });

const GradientStopSchema = z.object({ position: z.number(), hex: z.string().optional(), token: TokenState });
const GradientSchema = z.object({
  kind: z.enum(['linear', 'radial', 'conic', 'unknown']),
  angleDeg: z.number().optional(),
  stops: z.array(GradientStopSchema),
  whole: TokenState,
  multiLayer: z.boolean().optional(),
});

const Typo = z.object({
  fontFamily: z.string().optional(),
  fontWeight: z.number().optional(),
  fontSize: z.number().optional(),
  lineHeight: z.union([z.number(), z.literal('normal')]).optional(),
  letterSpacing: z.union([z.number(), z.literal('normal')]).optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  colorToken: TokenState.optional(),
  backgroundColorToken: TokenState.optional(),
  // v6-additive (icon-color axis, phase 1): a surveyed svg's painted color. Additive and optional
  // deliberately - see the layoutViewportWidth note for the direction argument. A pre-this-release
  // capture omits ALL FOUR on a tag:'svg' child; a NEW extractor always writes one of them for a
  // detected icon, which is what makes absent-field = stale-capture decidable downstream.
  iconColor: z.string().optional(),           // shared 6/8-digit hex across every painted part
  iconColorToken: TokenState.optional(),      // authored-binding state of that color's carrier
  iconColorMulti: z.literal(true).optional(), // parts differ - a real multi-color glyph, no single hex
  iconColorUnknown: z.string().optional(),    // a part's paint was unreadable (url()/gradient) - why
});

// v5 (style-anchor): a child's styles are extended with a style bundle (radius/opacity/gradient) — compact
const ChildTypo = Typo.extend({
  borderRadius: z.number().optional(),
  borderRadiusUncomparable: z.literal(true).optional(), // v6: the DOM radius is not one comparable px number (corners differ, or a %/elliptical radius) — borderRadius is then ABSENT
  opacity: z.number().optional(),
  gradient: GradientSchema.optional(),
  bgImage: z.literal(true).optional(),   // raster url background (invisible to the gradient detector) — a transparentChild disqualifier
  paintUnknown: z.literal(true).optional(), // v7: a declared paint the snapshot cannot classify — "absence = no style" does not hold for this box
});
const DomChildSchema: z.ZodType<DomChild> = z.lazy(() => z.object({
  kind: z.enum(['element', 'text']),
  tag: z.string().optional(),
  classList: z.array(z.string()).optional(),
  rect: Rect,
  text: z.string().optional(),
  path: z.string().optional(), // `:nth-child` chain from the captured root (suggest_pairs) — additive, we do NOT bump the schema
  styles: ChildTypo.optional(),
  shadow: ShadowSchema.optional(),                // v5
  borders: EdgesSchema.optional(),                // v5 (only non-zero)
  borderColors: StringEdges.optional(),           // v5
  borderColorsToken: StringEdgesToken.optional(), // v5
  data: z.record(z.string(), z.string()).optional(), // v5: dataset
  paddings: EdgesSchema.optional(),
  children: z.array(DomChildSchema).max(15).optional(),
  childrenTruncated: z.boolean().optional(),
  outOfFlow: z.number().int().nonnegative().optional(),
})) as z.ZodType<DomChild>;

export const OkSchema = z.object({
  schema: z.number().int().min(1),
  status: z.literal('ok').optional(),
  selector: z.string().optional(),
  innerWidth: z.number().positive(),
  // NOT a schema bump, deliberately: this repo bumps for a change in MEANING (see v4 and v6 above --
  // both made a stale capture indistinguishable on the wire from a fresh one), and this field is
  // additive and optional. A pre-this-release extractor omits it, the page-gutter demote in diff.ts
  // never fires, and such a capture behaves exactly as it does today: the gutter shortfall stays a
  // FAIL. The DIRECTION is what settles it -- an old snapshot loses an explanation, it never gains a
  // green over a difference nobody measured, so nothing has to be rejected to stay honest.
  layoutViewportWidth: z.number().positive().optional(),
  // The other half of the gutter, and additive/optional for exactly the same reason. `stable` on a
  // page that does not scroll reserves the bar without painting one, and `layoutViewportWidth` above
  // is blind to it (it is the VIEWPORT width). Present only when the page DECLARES a gutter, and 0 is
  // a real value (declared, but this state paints it instead of reserving it) — hence min(0), not
  // positive(). A pre-this-release capture omits it and the demote sees exactly what it sees today.
  reservedGutter: z.number().min(0).optional(),
  // ...and its share on the LEADING edge (`stable both-edges` puts half the reserve there), which is
  // what tells an inset page root apart from a box overflowing to the right. Same gate, same
  // optionality: absent unless the page declares a gutter.
  reservedGutterLeft: z.number().min(0).optional(),
  rect: Rect,
  borders: EdgesSchema,
  borderColors: StringEdges.optional(),
  borderColorsToken: StringEdgesToken.optional(),
  shadow: ShadowSchema.optional(),
  paddings: EdgesSchema.optional(),
  clientWidth: z.number().min(0).optional(),
  clientHeight: z.number().min(0).optional(),
  scrollHeight: z.number().min(0).optional(),
  scroll: z.object({ top: z.number(), left: z.number() }),
  transformed: z.boolean().optional(),
  fontsLoaded: z.boolean().optional(),
  styles: Typo.extend({ display: z.string().optional(), borderRadius: z.number().optional(), borderRadiusUncomparable: z.literal(true).optional(), opacity: z.number().optional(), justifyContent: z.string().optional(), gradient: GradientSchema.optional(), paintUnknown: z.literal(true).optional() }).optional(),
  state: z.record(z.union([z.string(), z.boolean()])).optional(),
  componentHints: z.object({ tag: z.string(), classList: z.array(z.string()), data: z.record(z.string()) }).optional(),
  children: z.array(DomChildSchema).max(30),
  childrenTruncated: z.boolean().optional(),
  outOfFlow: z.number().int().nonnegative().optional(),
});

const FailedSchema = z.object({
  status: z.enum(['not_found', 'multiple', 'hidden']),
  // feedback 14: the extractor's CSS-module probe - names the mangled class it found on the
  // page and the [class*] recipe. Additive and optional; older captures simply omit it.
  hint: z.string().optional(),
  selector: z.string().optional(),
  matches: z.number().int().optional(),
});

const countNodes = (kids: readonly DomChild[] | undefined): number =>
  (kids ?? []).reduce((n, k) => n + 1 + countNodes(k.children), 0);

// 300 — a static upper backstop (max_depth drill-down), NOT budgetFor(8):
// budgetFor(maxDepth) (projector.ts) itself scales MAX_TOTAL_NODES (90) with depth, but
// its real maximum at max_depth<=8 is 180 (Math.ceil(8/4)=2 → 90*2=180). 300 is headroom above that
// (Math.min(300, ...) in budgetFor already accounts for it), not the same number as budgetFor(8).
// The concrete per-request budget is enforced by the extractor's pruneToBudget (dom-extractor.ts/projector.ts);
// this Zod gate is only a sanity cap in case the extractor doesn't honor it.
const OkSchemaWithCap = OkSchema.superRefine((snap, ctx) => {
  if (countNodes(snap.children) > 300) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'snapshot exceeds 300 nodes total (children tree)' });
  }
});

export const DomSnapshotSchema: z.ZodType<DomSnapshot> = z.union([OkSchemaWithCap, FailedSchema]) as z.ZodType<DomSnapshot>;
