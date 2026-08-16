import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, textResult } from './shared-error-handler.js';
import { serializeForDelivery } from './serialize.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { buildLayoutSpec, ENUM_CAPS, anyTruncatedSpec } from '../../../domain/layout-spec/projector.js';
import { diffPair, summarize, widthNoiseTolerance, deriveCoverage, condenseBulkPass, dimensionOf, NOT_COVERED_BY_TOOL } from '../../../domain/layout-spec/diff.js';
import { renderReport } from '../../../domain/layout-spec/report.js';
import { DomSnapshotSchema, DOM_SNAPSHOT_SCHEMA_VERSION } from './dom-snapshot-schema.js';
import { buildSetNames } from './component-set-names.js';
import { clampToBudget, responseBudgetFallback } from './response-budget.js';
import { DomRefSchema, resolveDomRef } from './dom-ref.js';
import { buildVerification, budgetDropNote } from '../../../domain/layout-spec/verification.js';
import { buildHydrationReceipt, type HydrationReceipt } from '../../../domain/layout-spec/frame-receipt.js';
import type { PairResult, PairSummary, DomSnapshot, DomSnapshotOk, LayoutSpec, VerificationReceipt, CaptureInfo, PairAttribution, PairSource, DiffRow, FixPlanGroup, FixPlanEdit, MatchProfile } from '../../../domain/layout-spec/types.js';
import { hintForNode, type SourceHint } from '../../../domain/layout-spec/class-source.js';
import { buildVariableIndex, type VariableIndex } from '../../../domain/variables.js';
import { collectSubtreeModes, collectSubtreeChains, hasBoundPaintColor, hasExternalBoundPaintColor, collectExternalPaintKeys, ancestorChainFromSubtree, buildModeByCollection, pickDescentCandidates, sceneIdEquals } from '../../../domain/mode-resolve.js';
import { discoverAncestorModes } from './get-design-context-tool.js';
import { makeColorTokenResolver, prefetchSnapshotHits, buildMergedCssEvidence, VARIABLES_FETCH_CAP_MS } from './color-token-resolver.js';
import { FigmaApiError, isTimeoutMessage, TOO_LARGE_REASON_RE } from '../../../ports/errors.js';
import type { RawSceneNode } from '../../../domain/figma-raw.js';

// Latency: a targeted probe-descent in canvasChainFor (:204-215) — bounded so a pathological
// canvas (wide fan-out / deep section nesting) degrades honestly to (d) instead of stalling.
const DESCENT_MAX_ROUNDS = 3;
const DESCENT_MAX_CANDIDATES = 64;

// Latency: the /variables/local cap lives with the shared resolver factory (one constant → the
// negative-cache entries both tools write are keyed by the same capMs and serve each other).
// Here it is MT-only (see graphOrSnapshotAvailable gate below) — single-tenant compare has no
// fallback, so a false-cut there would lose ALL token rows with nothing to recover them.

/**
 * An enrichment stage that did not arrive, and what it cost. `stage`/`reason` keep
 * get_design_context's vocabulary (domain/design-context/types.ts) so one reader can branch on both
 * tools the same way; `ms` and `detail` are what this tool adds, because the missing fact here is
 * not THAT the stage degraded - the rows already say that - but that the caller spent most of the
 * call waiting for it.
 */
interface DegradedStage { stage: 'variables'; reason: 'error'; ms: number; detail: string }

// match-profiles: the type lives in domain (types.ts) — it has domain consumers (DiffOptions.profile
// in diff.ts + buildVerification.opts.matchProfile); the re-export preserves existing test imports.
export type { MatchProfile };

// The effective px-tolerance from (profile, raw tolerance_px). The schema carries NO zod
// default for tolerance_px (.optional()) — so omitted vs explicit is distinguishable here: strict
// forbids an explicit >0 (the contradiction "strict, but with a tolerance"), omitted under strict → 0; token-aware/
// layout → raw ?? 1. Called INSIDE the runTool callback (next to parseFileKey below) so the
// strict-throw maps into the tool's {isError:true} contract instead of escaping to the SDK past isError
// (there is no ToolError class — a plain Error is enough, runTool catches any throw).
export function resolveTolerance(profile: MatchProfile, raw: number | undefined): number {
  if (profile === 'strict') {
    if (raw !== undefined && raw > 0) {
      throw new Error(`strict with a tolerance of ${raw}px — contradiction; remove tolerance_px or choose token-aware`);
    }
    return 0;
  }
  return raw ?? 1;
}

// source-hint: the PairSource note string — set EXACTLY when classList is non-empty but NO
// channel parsed. The signal "there are classes, but not CSS-modules" (minified/utility/BEM) —
// the address isn't derived, but we can't stay silent either (otherwise indistinguishable from "there were no classes").
export const SOURCE_NOTE_NO_PARSE =
  'the DOM nodes have classes, but none was recognized as a CSS module (minified / utility-CSS / BEM) — no code address derived; named classes are one bundler setting away, see docs/named-classes.md';

// source-hint: the differ deposits the RAW material (attributionOut), the tool parses it and assembles
// PairSource. The parser (parseCssModuleClass) lives ONLY here — it doesn't leak into diff.ts. rootClassList
// = the DOM root's componentHints.classList (the pair root doesn't pass through the attributionOut channels).
export function buildPairSource(attr: PairAttribution, rootClassList: string[] | undefined): PairSource | undefined {
  const rootHint = hintForNode(rootClassList) ?? undefined;

  // children are positional: the hint comes from the MATCHED domKids2[i] (diff collected classList there). Dedup
  // child-hint === root-hint (module+local) — a child of the same module as the root adds no address.
  const children = (attr.children ?? [])
    .map((c) => ({ i: c.i, name: c.name, hint: hintForNode(c.classList) }))
    .filter((c): c is { i: number; name: string; hint: SourceHint } =>
      c.hint !== null && !(rootHint !== undefined && c.hint.module === rootHint.module && c.hint.local === rootHint.local));

  const anchorHint = hintForNode(attr.anchorClassList) ?? undefined;

  // text: the nearest PARSEABLE ancestor in the chain (immediate parent first). A class-less wrapper
  // between the carrier and the text → null on its own link, and the tool descends further down the chain.
  const firstParsableInChain = (chain: string[][]): SourceHint | null => {
    for (const cl of chain) { const h = hintForNode(cl); if (h) return h; }
    return null;
  };
  const text = (attr.text ?? [])
    .map((t) => ({ label: t.label, hint: firstParsableInChain(t.classListChain) }))
    .filter((t): t is { label: string; hint: SourceHint } => t.hint !== null);

  const unpaired = (attr.unpaired ?? [])
    .map((u) => ({ path: u.path, hint: hintForNode(u.classList) }))
    .filter((u): u is { path: string; hint: SourceHint } => u.hint !== null);

  const src: PairSource = {};
  if (rootHint) src.root = rootHint;
  if (anchorHint) src.anchor = anchorHint;
  if (children.length) src.children = children;
  if (text.length) src.text = text;
  if (unpaired.length) src.unpaired = unpaired;

  const anyParse = rootHint !== undefined || anchorHint !== undefined
    || children.length > 0 || text.length > 0 || unpaired.length > 0;
  if (anyParse) return src;

  // 0 parses: note ONLY if there was at least one non-empty classList (otherwise there were no classes — undefined).
  const anyClassList = (rootClassList?.length ?? 0) > 0
    || (attr.anchorClassList?.length ?? 0) > 0
    || (attr.children ?? []).some((c) => (c.classList?.length ?? 0) > 0)
    || (attr.text ?? []).some((t) => t.classListChain.some((cl) => cl.length > 0))
    || (attr.unpaired ?? []).some((u) => (u.classList?.length ?? 0) > 0);
  return anyClassList ? { note: SOURCE_NOTE_NO_PARSE } : undefined;
}

// fix-plan: fail rows of fixable axes → a grouped edit plan with
// candidate addresses. Assembled from PRE-condense rows (srcChannel is already set by the differ at the moment
// a fail row is created) + PairSource (addresses parsed from classList above). The gate is the
// FINAL status==='fail' && srcChannel (a demote strips the channel in diff.ts → double protection: even
// if it survived, the status gate would cut it). srcChannel objects are the differ's shared constants: read STRICTLY
// read-only (ch.editKind/kind/i/label), create edits/groups FRESH. Structural fails
// (children_reorder/layout_axis_mismatch) carry no channel by construction → they don't enter the plan.
const MAX_FIX_GROUPS = 10;
const MAX_FIX_EDITS = 10;

export function buildFixPlan(
  rows: DiffRow[],
  source: PairSource | undefined,
): { fix_plan: FixPlanGroup[]; fix_plan_capped?: number } | undefined {
  // Resolve channel → address via source. anchor ?? root mirrors the style code (a ? a : d, diff.ts): on
  // a direct non-wrapped pair there is no anchorClassList, styles are read from the root → the address falls to root, not to null.
  const resolve = (ch: NonNullable<DiffRow['srcChannel']>): SourceHint | null => {
    switch (ch.kind) {
      case 'root': return source?.root ?? null;
      case 'anchor': return source?.anchor ?? source?.root ?? null;
      case 'child': return source?.children?.find((c) => c.i === ch.i)?.hint ?? null;
      case 'text': return source?.text?.find((t) => t.label === ch.label)?.hint ?? null;
      default: return null;
    }
  };
  // Group key = module+local (the file address). Two channels of the same address (e.g. root + anchor??root)
  // merge into ONE group. The NUL separator rules out the 'a'+'bc' vs 'ab'+'c' collision.
  const keyOf = (h: SourceHint): string => `${h.module ?? ''}\x00${h.local}`;

  const addressed = new Map<string, FixPlanGroup>(); // preserves the order of an address's first appearance
  const nullEdits: FixPlanEdit[] = [];               // ALL address-less edits go into ONE group (the channel doesn't split them)

  for (const r of rows) {
    if (r.status !== 'fail' || !r.srcChannel) continue;
    const ch = r.srcChannel;
    const edit: FixPlanEdit = {
      prop: r.prop, kind: ch.editKind,
      expected: r.figma ?? null, actual: r.dom ?? null,
      ...(r.delta !== undefined ? { delta: r.delta } : {}),
      // fix-plan: the row's caveat travels INTO the edit. A plan entry is read without the row beside
      // it, so "edit the layout rule, not px" over pixels the differ has already half-explained is the
      // original defect surviving in the machine channel. Copied verbatim, never re-derived from the note.
      ...(r.caveat !== undefined ? { caveat: r.caveat } : {}),
    };
    const target = resolve(ch);
    if (target === null) { nullEdits.push(edit); continue; }
    const key = keyOf(target);
    const g = addressed.get(key);
    if (g) g.edits.push(edit);
    else addressed.set(key, { target, channel: ch.kind, edits: [edit] });
  }

  const groups: FixPlanGroup[] = [...addressed.values()];
  if (nullEdits.length) groups.push({ target: null, channel: 'unknown', edits: nullEdits }); // the null group is last
  if (groups.length === 0) return undefined;

  // Caps: 10 groups × 10 edits. fix_plan_capped = an HONEST count of trimmed edits (from both caps),
  // consistent with blocking_capped/places_capped (a count of trimmed elements, not groups).
  let capped = 0;
  for (const g of groups.slice(MAX_FIX_GROUPS)) capped += g.edits.length;
  const kept = groups.slice(0, MAX_FIX_GROUPS);
  for (const g of kept) {
    if (g.edits.length > MAX_FIX_EDITS) {
      capped += g.edits.length - MAX_FIX_EDITS;
      g.edits = g.edits.slice(0, MAX_FIX_EDITS);
    }
  }
  return { fix_plan: kept, ...(capped > 0 ? { fix_plan_capped: capped } : {}) };
}

// ── the placeholder-frame signal (feedback item 17) ──
// A consumer once compared a rendered page against a SKELETON design frame and reported two
// size deltas as defects - both false: a placeholder frame's sizes are conditional, and the
// hazard is FRAME-WIDE (an ordinary DS button inside a skeleton frame is just as conditional
// as the placeholder instances). Detection is ONE walk over the RAW node tree - never the
// projection, which is pruned by branch caps and drops out-of-flow children. Two signals per
// node: a name carrying the (dictionary-generic) word skeleton, and a componentProperties key
// carrying it whose value is POSITIVELY on - the live counter-example value "no" is a
// non-empty (JS-truthy) string and must never fire. Invisible layers do not render and do not
// count. The detector is SHARED with find_breakpoint_variant (fbv phase 2 of the same
// feedback item); the fig-only boundary is structural because compare_dom_to_dom imports
// NEITHER tool file - never a sentence.
export function scanPlaceholders(root: RawSceneNode): { count: number; visited: number } {
  let count = 0; let visited = 0;
  // Figma encodes variant property VALUES in the node name ('Skeleton=False, Breakpoint=
  // Desktop') - a bare substring test fired on the NEGATIVE assignment, which is exactly the
  // loaded sibling of the incident's shape. The rule is NEGATIVE SUPPRESSION, not positive
  // listing (the wave measured the positive-list variant blinding the detector to the
  // idiomatic value-side assignment 'State=Skeleton' and to any free-text name containing
  // '='): a token-bearing segment counts UNLESS it is a skeleton-KEYED assignment whose value
  // is an explicit negative. 'Skeleton=False' -> 0; 'State=Skeleton' -> 1; 'Skeleton=Card'
  // -> 1; 'skeleton (w=320)' -> 1; 'State=Loaded' -> 0.
  const NEGATIVE_VALUE = /^(no|false|off|0)$/i;
  const nameSignal = (name: string): boolean => {
    for (const seg of name.split(',')) {
      if (!/skeleton/i.test(seg)) continue;
      const m = /^\s*([^=]+)=(.+?)\s*$/.exec(seg);
      if (m && /skeleton/i.test(m[1]) && NEGATIVE_VALUE.test(m[2].trim())) continue;
      return true;
    }
    return false;
  };
  const walk = (n: RawSceneNode): void => {
    if (n.visible === false) return;
    visited += 1;
    let hit = nameSignal(n.name ?? '');
    if (!hit) {
      for (const [k, v] of Object.entries(n.componentProperties ?? {})) {
        const val = (v as { value?: unknown }).value;
        const key = k.replace(/#[0-9:]*/g, '');
        if (/skeleton/i.test(key)) {
          // skeleton-keyed: anything but an explicit negative counts (mirror of nameSignal)
          if (val !== false && !(typeof val === 'string' && NEGATIVE_VALUE.test(val.trim()))) { hit = true; break; }
        } else if ((v as { type?: string }).type === 'VARIANT'
          && typeof val === 'string' && /skeleton/i.test(val) && !NEGATIVE_VALUE.test(val.trim())) {
          // value-side assignment (State: 'Skeleton') - the idiomatic VARIANT shape. Gated on
          // the declared property TYPE: a TEXT prop whose copy happens to read 'Skeleton' (a
          // nav label) is content, not a state - counting it inverted #51 (a genuine delta
          // excused as skeleton-conditional).
          hit = true; break;
        }
      }
    }
    if (hit) count += 1;
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return { count, visited };
}

// The verdict protection is deliberately NOT a gate (the panel's resolution of a malformed
// advisory-vs-gating question): the verdict is already held by the fails such a compare
// produces - the incident's cost was those fails being TRUSTED and edit-prescribed. Three
// carriers instead: the advisory row, a caveat on every extent FAIL (it travels into
// fix_plan's edits via buildFixPlan), and a verification.notes[] line that renders in BOTH
// complete branches and survives the response-budget clamp. All-pass + detection stays
// complete:true WITH the visible note - a skeleton RENDER against a skeleton frame is a
// legitimate, productive flow and must not be blocked.
const PLACEHOLDER_EXTENT_DIMS = new Set(['size', 'gap', 'padding', 'offset-cross']);
const PLACEHOLDER_CAVEAT = 'the design side is a placeholder (skeleton) frame — this delta may be placeholder-conditional; verify against the loaded-state frame before editing';
export function placeholderNote(count: number, frameRequested: boolean): string {
  // The count is a LOWER BOUND and the sentence says so: the frame walk and the pair walk see
  // different slices of the same design, their hit sets can be disjoint, and the overlap is
  // unknowable - attributing one number to one named tree produced a measured false claim
  // ("the design frame carries N" with N entirely pair-derived and the frame slice empty).
  // "at least N on the design side" is true of every measured shape: max(frame, pair) is a
  // true lower bound of the union. The pair-scoped tail must not advise what the caller
  // already did: frame_node_id can be GIVEN while the frame node is missing from the file -
  // the frame-not-found warn row covers that shape.
  const tail = frameRequested ? '' : ' — checked only the paired subtrees, pass frame_node_id to check the whole frame';
  return `the design side carries at least ${count} placeholder (skeleton) component(s) within the fetched slice${tail}`
    + ` — sizes in a placeholder frame may not match the loaded state; if a loaded-state frame of this breakpoint exists, it is the geometry reference; to verify a skeleton RENDER, capture both DOM states and use compare_dom_to_dom`;
}
export function applyPlaceholderSignal(rows: DiffRow[], count: number, frameRequested: boolean): void {
  if (count <= 0) return;
  rows.push({ prop: 'placeholder_frame', figma: `at least ${count} placeholder component(s)`, dom: null,
    status: 'warn', note: placeholderNote(count, frameRequested) });
  for (const r of rows) {
    if (r.status === 'fail' && PLACEHOLDER_EXTENT_DIMS.has(dimensionOf(r.prop))) r.caveat ??= PLACEHOLDER_CAVEAT;
  }
}

// fix-plan: budget tier — fix_plan/fix_plan_capped are BOTH dropped together (fix_plan
// without the capped flag is as honest as it gets; a dangling capped is forbidden). A fresh object (delete on a copy) —
// the input is not mutated.
function stripFixPlan(p: PairResult): PairResult {
  if (p.fix_plan === undefined && p.fix_plan_capped === undefined) return p;
  const out = { ...p };
  delete out.fix_plan;
  delete out.fix_plan_capped;
  return out;
}

export const PairSchema = z.object({
  node_id: z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42" or nested "I…;…"'),
  dom: DomSnapshotSchema.optional().describe('DomSnapshot from the canonical extractor (get_layout_spec include_extractor:true). Pass exactly one of dom | dom_ref.'),
  dom_ref: DomRefSchema.optional().describe(
    'Reference to a browser-uploaded snapshot batch (get_layout_spec upload_url flow) instead of inlining raw ' +
    'DOM JSON. Only the HTTP servers construct the snapshot store this resolves against; on stdio pass dom ' +
    'inline. ref = the snapshot_ref returned by the extractor POST; selector must match byte-for-byte the ' +
    'selector string passed to the extractor, OR index addresses the snapshot by its position in that batch ' +
    '(duplicate-selector-safe). Resolvable while the underlying ref is live: sliding 30-min TTL ' +
    "from the last touch, hard-capped at 2h from the ref's OWN createdAt - NOT from when upload_url was minted. " +
    'A ref is only created on the extractor POST, which can itself happen up to ~2h after mint under regular ' +
    'touches of the capToken - so data can stay resolvable up to ~4h after the original upload_url mint. ' +
    'Pass exactly one of dom | dom_ref.',
  ),
  label: z.string().max(80).optional().describe('Human label for the report (e.g. "drawer-body")'),
  expected_component: z.string().max(120).optional().describe('Expected DOM component marker (class/tag/data token) - overrides heuristic match'),
}).superRefine((p, ctx) => {
  if ((p.dom === undefined) === (p.dom_ref === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass exactly one of dom | dom_ref' });
  }
});

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  pairs: z.array(PairSchema).min(1).max(20).describe('node_id <-> DOM snapshot pairs - up to 20 per call, all fetched in ONE REST call'),
  frame_node_id: z.string().regex(COMPOUND_NODE_ID_RE).optional()
    .describe('The breakpoint frame you resized the viewport to - enables the viewport guard'),
  exclude_regions: z.array(z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42", or a nested-instance id like "I12:340;56:7890"')).max(50).optional()
    .describe('Frame regions to EXCLUDE from the coverage demand (chrome outside your task: page footer, global tabs). '
      + 'An excluded region stops being demanded as uncovered, the receipt/report name every exclusion, and any '
      + 'measurement inside it still counts - exclusion can never hide a measured fail. Meaningful only together '
      + 'with frame_node_id. Exclude ONLY what is outside YOUR task: excluding a region you were asked to verify '
      + 'makes the verdict lie for you, not for the tool.'),
  expected_overlay_width: z.number().positive().optional()
    .describe(
      'The actual rendered width of a fixed-width overlay (drawer/modal) whose DOM box does not scale with the ' +
      'viewport. Decouples size.w and the viewport guard from frame_node_id (fail -> info on both), adds a ' +
      'dedicated overlay_width row (expected width vs actual window width), and - when frame_node_id is ALSO ' +
      'given - a preflight check that the chosen breakpoint frame actually matches this width ' +
      '(catches picking the wrong breakpoint variant before the per-pair diff).',
    ),
  tolerance_px: z.number().min(0).max(10).optional()
    .describe('A delta below this is a pass (px metrics); omitted -> 1 (token-aware/layout) or 0 (strict); an explicit >0 is rejected under strict'),
  match_profile: z.enum(['strict', 'layout', 'token-aware']).optional()
    .describe('Named strictness/scope preset (omitted -> token-aware). strict = tolerance 0 (exact ' +
      'equality after 0.05px rounding); explicit tolerance_px>0 is rejected. token-aware = current ' +
      'behaviour, tolerance_px default 1. layout = only visual-geometry axes are measured ' +
      '(typography/colors/styles/component out of scope), tolerance_px as usual.'),
  max_depth: z.number().int().min(1).max(8).optional()
    .describe('Capture depth for BOTH sides (Figma projection + expected DOM snapshot depth); default 4. ' +
      'Drill into a childrenTruncated branch by re-fetching/re-extracting it deeper (e.g. max_depth:6) - pass ' +
      'the SAME max_depth used for the get_layout_spec extractor call that produced these dom snapshots, or ' +
      'the Figma side stays shallow while the DOM side is deep (or vice versa).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerCompareNodeToDomTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'compare_node_to_dom',
    {
      description: 'Deterministic metric diff between Figma nodes and DOM computed snapshots: sizes, inter-child gaps ' +
      '(derived from geometry - insensitive to margin/padding/gap implementation), effective paddings, cross-axis ' +
      'offsets, typography, colors, component identity (warn-only). Returns machine-readable rows ' +
      '{prop, figma, dom, delta, status} per pair + a ready "Verified against Figma" markdown block. ' +
      'Snapshots come from the canonical extractor (get_layout_spec include_extractor:true). ' +
      'The variables index is fetched only when a pair binds a colour to a variable - a call with no bound ' +
      'colour never waits on it. When it IS needed and does not arrive, degraded_stages says so with the ms ' +
      'it cost: the token rows then read unresolved rather than verified, the verdict stays incomplete, and a ' +
      'failure is remembered per file for a few minutes - so a later call does not re-pay the wait and does ' +
      'not retry it either. get_variables with a larger timeout_ms is what gets past that. ' +
      'Token rows with status `review` carry `figma`/`dom` token names - judge them: return **same token** ' +
      '(-> resolved) only if the names denote the same concept; **wrong token** (-> report) ONLY when they denote ' +
      'clearly-DIFFERENT concepts (e.g. error vs success); when the names cannot be bridged either way (a possible ' +
      'rename), answer **unsure** and escalate - never call it wrong. `review` rows keep the verdict non-green until ' +
      'resolved; a name that merely differs textually is not a defect. Exception: a `semantic-diverged` row was measured against the authored codeSyntax mappings (the file\'s own variables and its synced libraries\') - the DOM var is the authored name of a DIFFERENT variable - and blocks even when the hexes match; align the code with the authored var (or fix the mapping in Figma).',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('compare_node_to_dom', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const t0 = Date.now();
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        // Resolve the tolerance BEFORE the first read — every site below (diffPair/
        // buildVerification/buildOutput ×2) reads the RESOLVED tolerancePx, never the raw
        // args.tolerance_px. strict + explicit >0 throws here (inside the callback) → {isError:true}.
        const profile: MatchProfile = args.match_profile ?? 'token-aware';
        const tolerancePx = resolveTolerance(profile, args.tolerance_px);
        const api = deps.buildApi(token);

        const pairIds = args.pairs.map((p) => normalizeCompoundNodeId(p.node_id));
        const frameId = args.frame_node_id ? normalizeCompoundNodeId(args.frame_node_id) : undefined;
        const ids = [...new Set(frameId ? [...pairIds, frameId] : pairIds)];
        const maxDepth = args.max_depth;
        const reqDepth = maxDepth ?? 4;
        // Figma-side frame hydration (DOM side is the browser extractor — UNCHANGED; the receipt is
        // Figma-side only and must NOT imply the DOM got deeper). effDepth == reqDepth unless clamped.
        const frameRes = await api.getFrameRaw(parsed.value, ids, reqDepth);
        const res = frameRes.raw;
        const effDepth = frameRes.effectiveMaxDepth;
        const hydration: Array<HydrationReceipt | undefined> = Array(args.pairs.length);
        // The DOM slice of each pair, collected IN PARALLEL with the diff — needed by
        // auditContainer (buildVerification below) for the between-children spacing audit of partial containers,
        // WITHOUT a pair on the container itself. Duplicate Figma ids are ambiguous for this
        // id-keyed audit when they carry distinct captures; exact repeats of one dom_ref are the same
        // capture and remain usable. Distinct duplicates delete the capture rather than letting Promise
        // completion order pick a winner.
        const captures = new Map<string, CaptureInfo>();
        const duplicateCaptureIds = new Set<string>();
        // Canonical identity is the stored snapshot object, not the caller's selector/index spelling:
        // both addressing forms can resolve to the same batch entry. Keep identities per ref so an
        // artificial store returning one object under two batches cannot merge their evidence.
        const snapshotKeysByRef = new Map<string, WeakMap<object, string>>();
        let snapshotKeySequence = 0;

        // Enrichment that did not arrive, and how long it cost before it did not arrive. Emitted as
        // `degraded_stages` only when non-empty (see the variables fetch below).
        const degradedStages: DegradedStage[] = [];
        let variablesEscalatable = false;

        // whether a graph/snapshot fallback is even reachable this call — computed ONCE
        // (not per-pair) so gate `needsModes` below stays a pure read. Multi-tenant only (`deps.
        // variableGraph`/`deps.variableSnapshot`); single-tenant/stdio has neither → always false.
        // Hoisted above the variables-fetch (latency cap): the capped-vs-uncapped choice for
        // getVariablesLocal below is a pure deps-read too, so it belongs next to its only consumer.
        const graphOrSnapshotAvailable = deps.variableGraph !== undefined || deps.variableSnapshot !== undefined;

        // Mode-aware color-token resolution (reuses get_design_context's machinery). The
        // variable index is best-effort enrichment fetched ONCE for the whole batch; on ANY failure
        // EXCEPT rate_limited (which must rethrow so the agent backs off) we degrade to NO token —
        // the color diff rows then read `unknown` (honest), never a thrown error that breaks the tool.
        // Latency (MT only): /variables/local on giant files can HANG (measured ~90s) —
        // a short 20s cap; the graph/snapshot fallback compensates for the degradation. Single-tenant
        // WITHOUT a fallback stays on the full budget: there a false-cut would lose ALL token rows.
        // The capped timeout is cached with capMs=20000 → warm calls skip it.
        const variablesApi = graphOrSnapshotAvailable ? deps.buildApi(token, VARIABLES_FETCH_CAP_MS) : api;
        let variableIndex: VariableIndex | undefined;
        // The degradation was honest and INVISIBLE: the token rows read `unknown` and a confirm_token
        // blocker appears, but nothing in the response said where the wait went. Measured on stdio:
        // 90 of a 124-second call spent in this one endpoint, with the reason on stderr only, which
        // an MCP caller does not read - so the caller cannot tell waiting from hanging. Same shape as
        // get_design_context's degraded_stages, plus the ms, because the ms IS the missing fact.
        // Demand gate. The index has exactly two readers, and both refuse to touch it unless a paint
        // is bound to a variable: resolveColorToken returns on a missing boundVariables.color BEFORE
        // reading it, and needsModes is already gated on hasBoundPaintColor. So a call whose pairs
        // bind no colour reads the index never — and fetching it anyway costs the caller the whole
        // variables budget, up to 90s on stdio where no fallback exists, for an enrichment nothing
        // consumes. Deliberately NO degraded_stages entry on the skip path: nothing degraded, and the
        // payload is byte-identical to a successful fetch, which is the honest report of "not needed".
        // ponytail: the predicate mirrors today's two consumers. A future consumer that reads
        // variableIndex WITHOUT a bound paint would make it under-trigger in silence — the upgrade
        // path then is a lazily memoised index, not a wider predicate.
        const anyPairBindsColor = pairIds.some((pid) => {
          const doc = res.nodes[pid]?.document;
          return doc !== undefined && hasBoundPaintColor(doc);
        });
        const variablesStartedAt = Date.now();
        if (anyPairBindsColor) {
          try {
            variableIndex = buildVariableIndex(await variablesApi.getVariablesLocal(parsed.value));
          } catch (err) {
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            deps.logger.info({ err: (err as Error).message }, 'compare.variables_unavailable');
            degradedStages.push({
              stage: 'variables', reason: 'error', ms: Date.now() - variablesStartedAt,
              detail: (err as Error).message,
            });
            // The escalation advice (a larger-budget get_variables) is true ONLY for the
            // classes the negative cache actually caches cap-aware: the capped timeout and
            // the too-large 400. A 403/not_found/network drop has no marker to bypass and a
            // bigger budget cannot fix it - those keep the plain wording (wave finding).
            const queuedBailout = err instanceof FigmaApiError && err.queuedBailout === true;
            if (!queuedBailout
              && (isTimeoutMessage((err as Error).message ?? '')
                || (err instanceof FigmaApiError && err.kind === 'unknown_4xx' && TOO_LARGE_REASON_RE.test(err.upstreamReason ?? '')))) {
              variablesEscalatable = true;
            }
          }
        }

        // Build the single-tenant env library graph before ANY variableGraph read below — the
        // snapshot-prefetch filter (keys the graph misses) AND the per-pair color resolver. This one
        // await dominates ALL graph read sites, not just the first. Idempotent/fail-soft; a no-op for
        // the MT wrappers and when no env graph is configured.
        await deps.variableGraph?.ensureReady?.();

        // codeSyntax evidence for the D-branch: the MERGED facade (local index + a graph view
        // SCOPED to the libraries this call's subtrees actually reference, excluding the
        // compared file itself - its truth lives in the fresher local index). Index REQUIRED:
        // uniqueness over a partial population is not uniqueness, so a failed local fetch means
        // no evidence at all - every both-token row stays legacy, byte-for-byte 0.22.0. Ordered
        // after ensureReady above (the graph view is a read).
        const referencedLibKeys = variableIndex
          ? [...new Set(pairIds.flatMap((pid) => {
              const doc = res.nodes[pid]?.document;
              return doc ? [...collectExternalPaintKeys(doc)] : [];
            }))]
          : [];
        const graphView = variableIndex
          ? deps.variableGraph?.cssEvidence?.(referencedLibKeys, parsed.value)
          : undefined;
        const cssEvidence = variableIndex ? buildMergedCssEvidence(variableIndex, graphView) : undefined;

        const frameWidth = frameId ? res.nodes[frameId]?.document?.absoluteBoundingBox?.width : undefined;

        // Preflight: the reference (frameWidth) is known BEFORE the per-pair loop — compared directly with
        // expected_overlay_width, no plumbing of the DOM innerWidth out of Promise.all. Emitted ONLY
        // when BOTH frame_node_id AND expected_overlay_width are given — without the second, the signal stays
        // with the viewport gate (enriched text); there is no duplicate by construction.
        let preflight: string | undefined;
        if (frameWidth !== undefined && args.expected_overlay_width !== undefined
          && Math.abs(frameWidth - args.expected_overlay_width) > widthNoiseTolerance(frameWidth)) {
          preflight = `frame w${frameWidth}, overlay ${args.expected_overlay_width} — check the breakpoint variant (find_breakpoint_variant)`;
        }

        // The deepest available raw of the frame — the source of the pairs' document ancestor chain.
        // covRes (tier 3, held_depth up to 9) ?? the main fetch (effDepth+1, the floor —
        // always present). Falling back to whole-file discovery is ONLY triggered by a pair not being locatable
        // in bestFrameRaw, NOT by a tier-3 failure (a transient cov-fetch failure
        // must not drop a heavy file back into the 60-90s whole-file path).
        let bestFrameRaw: RawSceneNode | undefined;
        // placeholder-frame signal state: the frame walk is memoized (one scan per call), the
        // max detected count feeds ONE receipt-level notes[] line after buildVerification.
        let framePlaceholderScan: { count: number; visited: number } | undefined;
        let placeholdersDetected = 0;
        let placeholdersFrameRequested = false;

        // Coverage enumeration. 3 tiers (the store keys are disjoint by id-set,
        // "sharing with the main fetch" is impossible — we gate the second fetch): (1) effDepth=8 (final
        // #1: GATE ON THE EFFECTIVE, not the requested depth — a too_large backoff clamps the main fetch BELOW
        // reqDepth even at reqDepth=8, and the old reqDepth gate then skipped the tier entirely, leaving
        // a clamped pair_fetch@<8, for which the advice matrix emits an unexecutable raise_max_depth) → the main
        // fetch is already depth-9, reuse it; (2) main-spec untruncated → enumeration is already complete, deep isn't needed (a small frame =
        // zero extra cost); (3) deep best-effort getFrameRaw([frameId], 8) — the key frame:[frameId] is shared with
        // the canonical get_layout_spec flow; +1 REST on a cold key, TTL-held. rate_limited MUST
        // rethrow (mirror of variableIndex :106). Other failures → fall back to main-spec (prior behavior).
        // ALL coverage projections use ENUM_CAPS (internal, not serialized into the output); the pair path (:209) uses branch.
        let frameSpec: LayoutSpec | undefined;
        let enumMeta: { depth: number; source: 'deep' | 'pair_fetch' } | undefined;
        if (frameId) {
          const fe = res.nodes[frameId];
          if (fe?.document) {
            bestFrameRaw = fe.document;
            const mainSpec = buildLayoutSpec(fe.document, { components: fe.components ?? {}, setNames: new Map() }, { maxDepth: effDepth, caps: ENUM_CAPS });
            frameSpec = mainSpec; enumMeta = { depth: effDepth, source: 'pair_fetch' };
            // Final hardening: gate reads effDepth, NOT reqDepth. reqDepth
            // is what the CALLER asked for; effDepth is what the main fetch actually got (frameRes.
            // effectiveMaxDepth) — the two diverge under a too_large backoff-clamp. With the old
            // `reqDepth < 8` gate, a caller already at max_depth:8 whose main fetch got clamped down
            // (effDepth<8) NEVER entered this block: frameSpec stayed the clamped, truncated mainSpec,
            // enumMeta stayed pair_fetch@effDepth<8 — and verification.ts's advice matrix turns
            // pair_fetch@<8+depth-cause into a `raise_max_depth` blocking item, which is unfixable
            // (max_depth is already at the schema ceiling) → dead-end fix→verify loop for the caller.
            // Gating on effDepth<8 instead retries with a SMALLER [frameId]-only request at a fresh
            // depth-8 ask: it either succeeds fully (source becomes 'deep', enumeration honest and
            // complete) or clamps again (source stays 'deep' → verification.ts's matrix takes the
            // caveat-note branch for 'deep', never raise_max_depth — an honest ceiling, not a lie).
            // Semantics for UNclamped calls are unchanged: effDepth === reqDepth whenever the main
            // fetch wasn't backoff-clamped, so this gate agrees with the old one byte-for-byte there.
            if (effDepth < 8 && anyTruncatedSpec(mainSpec)) {
              try {
                const covRes = await api.getFrameRaw(parsed.value, [frameId], 8);
                const cd = covRes.raw.nodes[frameId]?.document; // guard: optional chain
                if (cd) {
                  bestFrameRaw = cd;
                  frameSpec = buildLayoutSpec(cd, { components: covRes.raw.nodes[frameId]?.components ?? {}, setNames: new Map() }, { maxDepth: covRes.effectiveMaxDepth, caps: ENUM_CAPS });
                  enumMeta = { depth: covRes.effectiveMaxDepth, source: 'deep' };
                }
              } catch (err) {
                if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err; // don't swallow the 429 backoff
                deps.logger.info({ err: (err as Error).message }, 'compare.coverage_fetch_unavailable');
              }
            }
          }
        }

        // Latency: deadline on the discovery fallbacks — one per call. This is a discovery-only
        // cap (the main/cov getFrameRaw calls above go through the un-capped api, bounded by
        // FIGMA_TIMEOUT_MS — pre-existing): honestly a discovery budget, NOT "a ceiling on
        // the whole call".
        const deadlineAt = Date.now() + (deps.toolTimeBudgetMs ?? 90_000);
        // Latency: opt-in predictive byte gate — compare is the ONLY caller that sets this
        // (get_design_context keeps the reactive-only gate, see discoverAncestorModes' cfg doc).
        // Both discoverAncestorModes call-sites below share this one cappedCfg literal.
        const cappedCfg = {
          deadlineAt,
          predictiveByteGate: true as const,
          makeCappedApi: (capMs: number) => deps.buildApi(token, capMs, deadlineAt),
        };

        // The canvas part of the document ancestor chain (DOCUMENT..parent(frame)) — ONE
        // lazy depth-2 raw fetch for the whole call, shared by all pairs (`??=` is synchronous → a single
        // initialization even under the parallel Promise.all below). The walk goes over the RAW doc.document:
        // RawSceneNode preserves explicitVariableModes — buildFileStructure is FORBIDDEN here (it strips
        // the modes = confidently-wrong color under coverageComplete=true).
        // undefined = the skeleton isn't fetched / the frame isn't top-level in the depth-2 slice AND the probe-descent (below) didn't
        // recover the chain → the caller falls into fallback branch (d).
        // The closure captures the fid of the FIRST call — invariant: exactly one frame_node_id per tool
        // call; on a multi-frame refactor, key the memo by fid.
        let canvasChainMemo: Promise<RawSceneNode[] | undefined> | undefined;
        const canvasChainFor = (fid: string): Promise<RawSceneNode[] | undefined> =>
          (canvasChainMemo ??= (async () => {
            try {
              const doc = await api.getDocumentRaw(parsed.value, 2);
              const root = doc.document as unknown as RawSceneNode;
              const direct = ancestorChainFromSubtree(root, fid);
              if (direct !== undefined) return direct;
              // Latency: the frame isn't in the depth-2 slice (section-nested) → a targeted probe-descent INSTEAD of (d).
              // bbox is ONLY a pre-filter for whom to probe; membership is documentary, via the children-id of the probe
              // RESPONSE ROOTS (only the ids requested in a given round
              // enter the chain; sibling branches are excluded by parent-linkage through chain). Any failure/cap/
              // deadline → undefined → the existing honest branch (d).
              const frameBox = res.nodes[fid]?.document?.absoluteBoundingBox;
              if (frameBox == null) return undefined;
              type Frontier = { id: string; chain: RawSceneNode[] };
              let frontier: Frontier[] = [];
              for (const canvas of root.children ?? []) {
                if (canvas.type !== 'CANVAS') continue;
                for (const cand of pickDescentCandidates(canvas.children ?? [], frameBox))
                  frontier.push({ id: cand.id, chain: [root, canvas] });
              }
              for (let round = 0; round < DESCENT_MAX_ROUNDS && frontier.length > 0; round++) {
                if (frontier.length > DESCENT_MAX_CANDIDATES) return undefined;     // cap AFTER the pre-filter
                const remaining = deadlineAt - Date.now();
                if (remaining <= 0) return undefined;                               // deadline → (d)
                const probeApi = cappedCfg.makeCappedApi(Math.min(Math.max(1_000, remaining), 90_000));
                const probe = await probeApi.getNodesRaw(parsed.value, frontier.map((f) => f.id), 1);
                const next: Frontier[] = [];
                for (const f of frontier) {
                  const full = probe.nodes[f.id]?.document;                         // probe RESPONSE ROOT
                  if (!full) continue;
                  if ((full.children ?? []).some((c) => sceneIdEquals(c.id, fid))) return [...f.chain, full];
                  for (const cand of pickDescentCandidates(full.children ?? [], frameBox))
                    next.push({ id: cand.id, chain: [...f.chain, full] });          // parent-linkage: response roots only
                }
                frontier = next;
              }
              return undefined;                                                     // rounds exhausted → (d)
            } catch (err) {
              if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
              deps.logger.info({ err: (err as Error).message }, 'compare.canvas_chain_unavailable');
              return undefined;
            }
          })());

        // Latency follow-up: the variable-snapshot lookup is async while
        // resolveColorToken (called from the sync projector) is not — so external published keys are
        // prefetched in ONE union batch across ALL pairs, BEFORE the pair Promise.all (every pair's
        // document is already in res.nodes from the single batched fetch above — a per-pair prefetch
        // would serialize N DB round-trips for zero extra information). Mirrors get-design-context-
        // tool.ts's alias-resolution prefetch (:400-431). Gated to index-less files: when
        // variableIndex IS present, the local resolver covers everything the index knows and the
        // graph (sync) handles the byId-miss/cross-lib residual — the async snapshot half only pays
        // for itself when there is NO local index to lean on at all. rate_limited rethrows (whole
        // tool isError, agent backs off); anything else degrades to no snapHits (rows → honest
        // unknown), never a thrown error.
        let snapHits: Map<string, { value: unknown; name?: string }> | undefined;
        try {
          // The gate (index-less only) and the snapHits ⊆ graph-misses invariant live INSIDE
          // prefetchSnapshotHits — shared with get_layout_spec by construction.
          snapHits = await prefetchSnapshotHits(deps, variableIndex, pairIds.map((pid) => res.nodes[pid]?.document));
        } catch (err) {
          if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
          deps.logger.info({ err: (err as Error).message }, 'compare.snapshot_prefetch_unavailable');
        }

        const results: PairResult[] = await Promise.all(args.pairs.map(async (p, i): Promise<PairResult> => {
          const id = pairIds[i];

          // Resolve dom_ref (if given) BEFORE anything else touches the snapshot — every downstream
          // reference to the dom side goes through the single `domSnap` local computed right below,
          // never `p.dom` directly (with `dom` now optional, any leftover `p.dom` access would
          // TypeError on a dom_ref pair and take down the whole Promise.all, not just that pair).
          let resolveErrorNote: string | undefined;
          let resolvedSnapshot: unknown;
          if (p.dom_ref) {
            if (!deps.snapshotStore) {
              resolveErrorNote = 'snapshot store unavailable on this server — pass dom inline';
            } else {
              const r = resolveDomRef(p.dom_ref, deps.snapshotStore, deps.tenantId ?? 'local');
              if (r.ok) resolvedSnapshot = r.snapshot;
              else resolveErrorNote = r.note;
            }
          }

          const domSnap: DomSnapshot | undefined = (p.dom as DomSnapshot | undefined) ?? (resolvedSnapshot as DomSnapshot | undefined);
          const selector = p.dom_ref?.selector ?? (domSnap as { selector?: string } | undefined)?.selector;
          const base = { node_id: id, ...(p.label ? { label: p.label } : {}), ...(selector ? { selector } : {}) };

          if (resolveErrorNote) {
            const rows = [{ prop: 'snapshot_ref', status: 'warn' as const, note: resolveErrorNote }];
            return { ...base, rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
          }
          const entry = res.nodes[id];
          if (!entry?.document) {
            const rows = [{ prop: 'node', status: 'warn' as const, note: `node ${id} not found in file` }];
            return { ...base, rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
          }
          const okSnap = domSnap as DomSnapshotOk;
          if (okSnap.schema !== undefined && okSnap.schema !== DOM_SNAPSHOT_SCHEMA_VERSION) {
            const rows = [{ prop: 'snapshot_schema', status: 'warn' as const, figma: DOM_SNAPSHOT_SCHEMA_VERSION,
              dom: okSnap.schema,
              note: 'snapshot version does not match the server — re-capture with a FRESH script: get_layout_spec {include_extractor:true, extractor_mode:"inline"} (on the loader path an open page keeps serving its cached old extractor), or reload the page first' }];
            return { ...base, rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
          }
          const setNames = await buildSetNames(api, entry, deps.logger);

          // Discover this node's ancestor variable modes (best-effort) and fold them with
          // the subtree chain into a per-node ModeStack, so resolveColorToken resolves each bound
          // fill/stroke to the hex UNDER the node's effective mode (not the library default). Any
          // failure EXCEPT rate_limited degrades to an EMPTY ancestor stack + coverageComplete=false
          // — the resolver then either resolves from subtree modes alone or stays honestly 'default';
          // it never throws. Mirrors get_design_context's stackFor/resolveTokenMode wiring.
          let ancestorStack = new Map<string, string>();
          let coverageComplete = false;
          // Raw ancestor nodes (root→parent), threaded ALONGSIDE ancestorStack in every
          // branch below — the graph resolver (graphStackFor, near stackFor) needs the RAW node
          // chain (not the folded exact-id map) to lib-key-fold it together with the subtree chain,
          // mirroring get-design-context-tool.ts's ancestorNodesRootToParent (:448-530).
          let ancestorNodes: RawSceneNode[] = [];
          // Without variableIndex, resolveColorToken is always undefined; without
          // bound-SOLID colors in the subtree, aliasId won't be found on any node → ancestorStack/
          // coverageComplete are unobservable in the output (their only consumer is resolveColorToken) →
          // skip discovery byte-for-byte (the first disjunct). BUT discovery (ancestor modes) is also needed by
          // the graph/snapshot fallback — it resolves EXTERNAL bound colors even when the local
          // variableIndex is unavailable. The second disjunct gates EXACTLY this path: variableIndex
          // is absent, but at least one of the graph/snapshot deps is wired (multi-tenant), AND the subtree
          // has an external bound color the graph/snapshot can actually resolve (local-only
          // ids are inaccessible to them without an index — hasExternalBoundPaintColor, not hasBoundPaintColor). If
          // NEITHER an index NOR graph/snapshot deps exist (single-tenant/stdio, or multi-tenant without
          // both deps) — skip: discovery would be pure latency with no consumer.
          const needsModes = (variableIndex !== undefined && hasBoundPaintColor(entry.document))
            || (variableIndex === undefined && graphOrSnapshotAvailable && hasExternalBoundPaintColor(entry.document));
          if (needsModes) {
            try {
              // Prefer the CHEAP documented chain built from bestFrameRaw (already
              // in memory from the frame-hydration fetch above) + the shared depth-2 canvas skeleton
              // over the EXPENSIVE deadline-capped whole-file discovery. Fallback matrix
              // (a)-(d): (a) no frame_node_id / (b) pair located outside bestFrameRaw (frameChain
              // undefined) / (c) no bestFrameRaw at all → straight to deadline-capped discovery below; (d)
              // pair located INSIDE bestFrameRaw but the frame itself isn't reachable in the depth-2
              // canvas skeleton → try deadline-capped discovery FIRST (it may still recover the mode via a
              // deeper whole-file fetch), and only fall back to a partial intra-frame-only chain when
              // discovery itself got cut short (droppedReason set) — an honest coverageComplete=false,
              // never a silent "frame-only" chain that could miss a page/section-level mode pin.
              let done = false;
              if (frameId !== undefined && bestFrameRaw !== undefined) {
                const frameChain = ancestorChainFromSubtree(bestFrameRaw, id);
                if (frameChain !== undefined) {                      // located ⟹ intra-frame chain is complete
                  const canvasChain = await canvasChainFor(frameId); // [DOCUMENT..parent(frame)] | undefined
                  if (canvasChain !== undefined && canvasChain.some((n) => n.type === 'CANVAS')) {
                    // Full documented chain: canvas-part strictly ABOVE the frame; frameChain[0] ===
                    // bestFrameRaw (chain root is the frame itself), and for pair===frame frameChain
                    // === [] — the frame is correctly EXCLUDED from the ancestor stack (its own modes
                    // arrive via collectSubtreeModes/stackFor instead). ONLY spread-concat form here
                    // — a slice-variant would double-count the frame when pair === frame.
                    ancestorStack = buildModeByCollection([...canvasChain, ...frameChain]);
                    ancestorNodes = [...canvasChain, ...frameChain];
                    coverageComplete = true;
                    done = true;
                  } else {
                    const disc = await discoverAncestorModes(api, parsed.value, id, deps.logger, cappedCfg);
                    if (disc.droppedReason === undefined) {
                      ancestorStack = disc.stack; coverageComplete = disc.coverageComplete;
                      ancestorNodes = disc.nodesRootToParent;
                    } else {
                      ancestorStack = buildModeByCollection(frameChain); // partial intra-frame chain (frameChain[0]===bestFrameRaw)
                      ancestorNodes = frameChain;
                      coverageComplete = false;
                    }
                    done = true;
                  }
                }
                // frameChain === undefined → pair sits outside bestFrameRaw (b) → fallback below.
              }
              if (!done) {                                           // (a)(b)(c) → deadline-capped whole-file discovery
                const disc = await discoverAncestorModes(api, parsed.value, id, deps.logger, cappedCfg);
                ancestorStack = disc.stack; coverageComplete = disc.coverageComplete;
                ancestorNodes = disc.nodesRootToParent;
              }
            } catch (err) {
              if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
              deps.logger.info({ err: (err as Error).message }, 'compare.ancestor_modes_unavailable');
            }
          }
          const subtreeModes = collectSubtreeModes(entry.document);
          const stackFor = (n: RawSceneNode): Map<string, string> =>
            new Map<string, string>([...ancestorStack, ...(subtreeModes.get(n.id) ?? new Map<string, string>())]);

          // The GRAPH resolver's stack, matched by LIBRARY KEY (not exact collection
          // id) — a plain stackFor merge would let two subscribed-instance suffixes of the SAME
          // library collection both survive (one from ancestorNodes, one from the subtree chain),
          // with the FARTHER one sitting first in map order and winning the resolver's first-match
          // scan → an uverenno-neverno (confidently wrong) hex. buildModeByCollection walks its
          // argument nearest→farthest, so the chain is passed root→node order (mirrors
          // get-design-context-tool.ts's graphStackFor, :519-530).
          const subtreeChains = collectSubtreeChains(entry.document);
          const graphStackFor = (n: RawSceneNode): Map<string, string> =>
            buildModeByCollection([...ancestorNodes, ...(subtreeChains.get(n.id) ?? [n])]);

          // The shared factory (color-token-resolver.ts): index → graph → snapshot → honest
          // unknown, both binding forms via colorAliasId. compare feeds it ancestor-discovered
          // stacks; get_layout_spec feeds subtree-only ones — same resolver by construction.
          const resolveColorToken = makeColorTokenResolver({
            variableIndex, snapHits, variableGraph: deps.variableGraph,
            stackFor, graphStackFor, coverageComplete,
          });

          // Symmetric depth fix: maxDepth MUST reach the Figma-side projection too, not just the
          // fetch peek above — otherwise buildLayoutSpec silently stays at its default depth 4 even
          // when the DOM snapshot was captured deeper, and collectFigTexts stops BEFORE
          // collectDomTexts (a childrenTruncated branch never actually gets "sverified deeper").
          const spec = buildLayoutSpec(entry.document, { components: entry.components, setNames, resolveColorToken, styleNames: (sid: string) => entry.styles?.[sid]?.name }, { maxDepth: effDepth });
          hydration[i] = { ...buildHydrationReceipt(id, spec, frameRes), pair_index: i };
          // source-hint: a FRESH PairAttribution for EACH pair — cross-pair leakage
          // is impossible (one object across all pairs would give pair-N's source from pair-1's classes).
          const attributionOut: PairAttribution = {};
          const rows = diffPair(spec, domSnap as DomSnapshot, {
            ...(cssEvidence ? { cssEvidence } : {}),
            // The producer of DiffOptions.profile — the layout scope is applied IN THE DIFFER
            // (profileScoped skips); the tool filters nothing itself.
            tolerancePx, frameWidth, maxDepth: effDepth, attributionOut, profile,
            ...(p.expected_component ? { expectedComponent: p.expected_component } : {}),
            ...(args.expected_overlay_width !== undefined ? { expectedOverlayWidth: args.expected_overlay_width } : {}),
          });
          if (frameId !== undefined && frameWidth === undefined) {
            rows.unshift({ prop: 'frame', figma: frameId, dom: null, status: 'warn' as const,
              note: `frame ${frameId} not found in file — viewport guard disabled` });
          }
          // placeholder-frame signal: the frame walk and the pair walk UNION - one REST call
          // fetches every id at the SAME depth, so the frame's slice is SHALLOWER at the pair
          // than the pair's own document slice; replacing the pair walk with the frame walk
          // made frame_node_id strictly WEAKEN detection (measured by the wave: a placeholder
          // below the frame's cut but inside the pair's slice vanished silently). Both trees
          // are already in memory - the union is free. The frame walk is memoized (one scan
          // per call); the max of the two slice-honest lower bounds is the count. Applied
          // BEFORE buildFixPlan so the caveat travels into the edits.
          const pairScan = scanPlaceholders(entry.document);
          const frScan = bestFrameRaw !== undefined
            ? (framePlaceholderScan ??= scanPlaceholders(bestFrameRaw))
            : undefined;
          const phCount = Math.max(frScan?.count ?? 0, pairScan.count);
          if (phCount > 0) {
            applyPlaceholderSignal(rows, phCount, frameId !== undefined);
            placeholdersDetected = Math.max(placeholdersDetected, phCount);
            placeholdersFrameRequested = frameId !== undefined;
          }
          // captures AFTER diffPair (rows are ready for geometryUnchecked), BEFORE return — only
          // the OK path reaches here (the early returns above don't write captures). rect/borders ONLY if
          // domSnap is really ok (a status:'ok' snapshot; a failed union member has no .rect — okSnap.rect is then
          // undefined at runtime despite the DomSnapshotOk type, and the gate below cuts this branch honestly).
          let snapshotKey: string | undefined;
          if (p.dom_ref) {
            let keys = snapshotKeysByRef.get(p.dom_ref.ref);
            if (!keys) {
              keys = new WeakMap<object, string>();
              snapshotKeysByRef.set(p.dom_ref.ref, keys);
            }
            snapshotKey = keys.get(okSnap);
            if (snapshotKey === undefined) {
              snapshotKey = JSON.stringify([p.dom_ref.ref, snapshotKeySequence++]);
              keys.set(okSnap, snapshotKey);
            }
          }
          const capture: CaptureInfo = {
            ...(p.dom_ref ? { ref: p.dom_ref.ref, snapshotKey } : {}),
            ...(okSnap.rect !== undefined ? { rect: okSnap.rect, borders: okSnap.borders } : {}),
            geometryUnchecked: rows.some((r) => r.prop === 'geometry' && r.status === 'unchecked'),
          };
          const priorCapture = captures.get(id);
          if (duplicateCaptureIds.has(id)) {
            // already proved ambiguous by an earlier distinct capture
          } else if (priorCapture?.snapshotKey !== undefined
            && priorCapture.snapshotKey === capture.snapshotKey) {
            // Exact repeats of one uploaded snapshot are one capture, not competing evidence.
          } else if (priorCapture) {
            captures.delete(id);
            duplicateCaptureIds.add(id);
          } else {
            captures.set(id, capture);
          }
          // source-hint: assemble code addresses from the raw material + root from componentHints.
          const source = buildPairSource(attributionOut, okSnap.componentHints?.classList);
          // fix-plan: the edit plan from PRE-condense rows (fail refs intact; condense touches
          // ONLY bulk-pass) + source. The same point as buildPairSource — before condenseBulkPass.
          const fixPlan = buildFixPlan(rows, source);
          return { ...base, rows, summary: summarize(rows), coverage: deriveCoverage(rows), ...(source ? { source } : {}),
            ...(fixPlan ? { fix_plan: fixPlan.fix_plan, ...(fixPlan.fix_plan_capped !== undefined ? { fix_plan_capped: fixPlan.fix_plan_capped } : {}) } : {}) };
        }));

        const budget = deps.maxResultChars ?? 40000;
        const frame = frameId ? { node_id: frameId, ...(frameWidth !== undefined ? { width: frameWidth } : {}) } : undefined;
        const depthLevels = effDepth;

        const verification = buildVerification(results, {
          ...(frameSpec ? { frame: frameSpec } : {}), frameRequested: frameId !== undefined, depthLevels,
          // batch-2 item 4: the ceiling test needs the REQUESTED depth too - a too_large
          // backoff clamps effDepth below 8, and 'raise max_depth' would then be advice the
          // caller already followed.
          requestedDepth: reqDepth,
          // batch-2 item 5 remainder: wording-only - the dead-resolve confirm_token
          // aggregates name the get_variables escalation road when the batch fetch degraded
          // in an escalatable class (capped timeout / too-large - see the catch above).
          ...(variablesEscalatable ? { variablesDegraded: true as const } : {}),
          ...(enumMeta ? { enumeration: enumMeta } : {}),
          // The profile from the parsed arg as the SINGLE source (the same `profile` that went
          // into diffPair) → receipt.match_profile in all three modes + a sentinel gate under layout.
          captures, tolerancePx, matchProfile: profile,
          ...(args.exclude_regions?.length ? { excludeRegions: args.exclude_regions.map(normalizeCompoundNodeId) } : {}),
        });
        // placeholder-frame signal, the receipt carrier: notes[] renders as a ⚠ line in BOTH
        // the complete and incomplete report branches and survives the response-budget clamp -
        // the per-pair rows alone can be trimmed by the cascade, so the receipt line carries
        // the SAME pinned note as the row (count, slice honesty, remediation) rather than a
        // content-free pointer at a row the clamp may have dropped.
        if (placeholdersDetected > 0) {
          (verification.notes ??= []).push(
            placeholderNote(placeholdersDetected, placeholdersFrameRequested));
        }

        // (c) dominant_blocker REPLACES the generic preflight (the slot :34-36 in report.ts
        // is single; the overlay case doesn't intersect — overlay suppresses the viewport reason in diff).
        const effPreflight = verification.dominant_blocker
          ? `WINDOW WIDTH: ${verification.dominant_blocker.pairs} of ${args.pairs.length} pairs are unverified for one reason — window ${verification.dominant_blocker.window}px ≠ frame ${verification.dominant_blocker.frame}px; resize to ${verification.dominant_blocker.frame}, re-capture with the extractor and re-run compare`
          : preflight;

        // CRITICAL (the size-guard-bug class): the measurement goes THROUGH
        // serializeForDelivery — the same function jsonResult delivers with. It measures EXACTLY the delivered
        // text field; the jsonResult wrapper {"content":[{"type":"text","text":…}]} (~40 chars) is outside the measurement
        // DELIBERATELY. effPreflight is in BOTH buildOutput calls (the prior invariant is preserved).
        // fix-plan: fixPlanStripped is read by the serialize CLOSURE (declared BEFORE it)
        // — the clamp measurement in the strip tier accounts for both the removed fix_plan and the added response flag.
        let fixPlanStripped = false;
        const serialize = (kept: PairResult[]): string => serializeForDelivery(buildOutput(parsed.value, tolerancePx, kept, frame, results, effPreflight, depthLevels, verification, hydration, degradedStages, fixPlanStripped));
        // Budget cascade: full → bulk-pass compression → [fix-plan strip tier] → omitted_pairs.
        // A shared floor distinguishes a too-large first pair from an envelope that cannot fit at all.
        let delivered = serialize(results);
        if (delivered.length > budget) {
          const condensed = condenseBulkPass(results);
          if (serialize(condensed).length <= budget) {
            delivered = serialize(condensed);
          } else {
            const candidates = condensed.some((p) => p.fix_plan !== undefined)
              ? (fixPlanStripped = true, condensed.map(stripFixPlan))
              : condensed;
            const fitted = clampToBudget(candidates, budget, serialize);
            delivered = fitted.kind === 'fit' || fitted.kind === 'truncated'
              ? fitted.serialized
              : serializeForDelivery(responseBudgetFallback(results, verification, fitted.kind));
          }
        }
        // Latency: one log line for the whole call — to measure wall-clock
        // without reconstructing it from fetch logs. Only on the successful main return.
        deps.logger.info({ total_ms: Date.now() - t0, pairs: args.pairs.length }, 'compare.done');
        return textResult(delivered);
      }, deps.noTokenHint),
  );
}

function buildOutput(file: string, tolerancePx: number, pairs: PairResult[],
  frame: { node_id: string; width?: number } | undefined, allResults: PairResult[], preflight: string | undefined,
  depthLevels: number, verification: VerificationReceipt, hydration: Array<HydrationReceipt | undefined>,
  degradedStages: DegradedStage[] = [], fixPlanStripped = false): Record<string, unknown> {
  const summary: PairSummary = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 };
  for (const p of pairs) (Object.keys(summary) as (keyof PairSummary)[]).forEach((k) => { summary[k] += p.summary[k]; });
  const keptHydration = hydration.slice(0, pairs.length).filter((h): h is HydrationReceipt => h !== undefined);
  // budget drop trace: the trace depends on the clamp result, so it is computed HERE - inside
  // the serialize closure's measurement AND the final call - as a pure function of
  // (allResults, pairs). clampToBudget keeps a PREFIX and condense/strip are per-pair
  // order-preserving transforms, so index identity holds: dropped = allResults.slice(pairs.length).
  // The receipt is a per-call COPY when pairs were dropped (mutating the shared object would
  // accumulate one note per binary-search probe and falsify the measurement); with zero dropped
  // the SAME reference flows through - byte-for-byte with the pre-trace behavior. The note+ids
  // re-add strictly less than any dropped pair's own serialization (a pair's JSON carries its
  // own label plus rows), so the clamp's prefix search stays safe.
  // ponytail: the clamp itself stays signal-blind (prefix drop) - keep-priority ordering was
  // panel-cut (post-condense greens are nearly free; the sort would drop spacing-audit
  // evidence pairs by design). The trace + one re-run round-trip is the honest cost.
  const omitted = allResults.length - pairs.length;
  const dropped = allResults.slice(pairs.length);
  const droppedFail = dropped.filter((p) => p.summary.fail > 0).length;
  const droppedIds = dropped.map((p) => p.label ?? p.node_id);
  const droppedIndices = Array.from({ length: omitted }, (_, i) => pairs.length + i);
  const receipt = omitted > 0
    ? { ...verification, notes: [...(verification.notes ?? []), budgetDropNote(droppedIds, droppedFail)] }
    : verification;
  return {
    file, tolerance_px: tolerancePx, ...(frame ? { frame } : {}), ...(preflight ? { preflight } : {}), pairs, summary,
    verification: receipt,
    ...(keptHydration.length ? { hydration: keptHydration } : {}),
    not_covered_by_tool: NOT_COVERED_BY_TOOL,
    ...(degradedStages.length ? { degraded_stages: degradedStages } : {}),
    report_markdown: renderReport({
      file, tolerancePx, pairs, ...(frame ? { frame } : {}),
      ...(omitted ? { omittedPairs: omitted, omittedFailPairs: droppedFail } : {}),
      ...(preflight ? { preflight } : {}), depthLevels, verification: receipt,
      ...(degradedStages.length ? { degradedStages } : {}),
    }),
    ...(omitted ? { omitted_pairs: omitted, omitted_pair_ids: droppedIds, omitted_pair_indices: droppedIndices } : {}),
    // fix-plan: an honest flag — fix_plan was stripped from ALL pairs by the budget tier (BEFORE dropping
    // whole pairs). Can coexist with omitted_pairs (we stripped the plan AND still trimmed pairs).
    ...(fixPlanStripped ? { fix_plan_stripped: true } : {}),
  };
}
