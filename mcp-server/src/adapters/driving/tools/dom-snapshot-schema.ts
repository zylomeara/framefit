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
export const DOM_SNAPSHOT_SCHEMA_VERSION = 5;   // v3: styles.gradient added
// v4 — SNIPPET_CAP 120: old extractors truncate text at 40 WITHOUT a flag; at the server's 120
// threshold their cuts are indistinguishable from full text → mis-anchor; the version rejects them at both matcher inputs.
// v5 (style-anchor): a style bundle on children — radius/opacity/gradient in styles, shadow/borders/borderColors/data on the node; compact "no field = no style" semantics

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
});

// v5 (style-anchor): a child's styles are extended with a style bundle (radius/opacity/gradient) — compact
const ChildTypo = Typo.extend({
  borderRadius: z.number().optional(),
  opacity: z.number().optional(),
  gradient: GradientSchema.optional(),
  bgImage: z.literal(true).optional(),   // raster url background (invisible to the gradient detector) — a transparentChild disqualifier
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
})) as z.ZodType<DomChild>;

export const OkSchema = z.object({
  schema: z.number().int().min(1),
  status: z.literal('ok').optional(),
  selector: z.string().optional(),
  innerWidth: z.number().positive(),
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
  styles: Typo.extend({ display: z.string().optional(), borderRadius: z.number().optional(), opacity: z.number().optional(), justifyContent: z.string().optional(), gradient: GradientSchema.optional() }).optional(),
  state: z.record(z.union([z.string(), z.boolean()])).optional(),
  componentHints: z.object({ tag: z.string(), classList: z.array(z.string()), data: z.record(z.string()) }).optional(),
  children: z.array(DomChildSchema).max(30),
  childrenTruncated: z.boolean().optional(),
});

const FailedSchema = z.object({
  status: z.enum(['not_found', 'multiple', 'hidden']),
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
