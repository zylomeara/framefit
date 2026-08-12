// A1 — machine-gated verification receipt. Assembles from the pair results (+ optional frame projection)
// a boolean `complete` and an actionable `blocking`, so honesty becomes a machine gate rather than prose
// the AI swallows. A separate module (not diff.ts) — the frame-coverage frontier reuses figWorthy from
// pair-matcher, and we keep diff.ts focused.
import type { PairResult, LayoutSpec, SpecChild, DiffRow, BlockingItem, FrameCoverage, VerificationReceipt, CaptureInfo, SpacingAuditEntry, MatchProfile } from './types.js';
import { coverageHoleRows, dimensionOf, gatingReviewRow } from './diff.js';
import { figWorthy } from './pair-matcher.js';
import { auditContainer } from './spacing-audit.js';
import { normalizeCompoundNodeId } from '../node-id.js';

const norm = (id: string): string => normalizeCompoundNodeId(id);
const BLOCKING_CAP = 40; // response-budget guard: truncate a LONG JSON list (complete stays false anyway)
// Final hardening ("measure the delivered serialization"): aggregated confirm_token records
// carried places WITHOUT a cap — a flood of 100+ places of one token bloated the verification JSON past the
// transport budget (BLOCKING_CAP caps the aggregate's items, but not the places WITHIN one item). places is
// capped mirroring capList (60) — the detailed tail lives in an honest "×N places" counter, not silently gone.
const PLACES_CAP = 60;

// SURVIVAL priority under the caps (residual of the two tail caps): both tail caps (BLOCKING_CAP=40
// here, CAP=15 in report.ts) inherit list order — sorting at the source fixes both mirrors at once. Lower =
// earlier. Rank invariant 2: a signal that invalidates the measuring apparatus (the extractor) outranks any
// NUMBER produced by that apparatus (spacing deltas — from rects of the same slice). Unknown future kinds
// get a mid default of 8 (don't silently sink them into the tail); every EXISTING kind is listed explicitly,
// the default is only for future ones.
export function rankOf(b: BlockingItem): number {
  switch (b.kind) {
    // a UNIQUE minimal rank (the tie with frame_missing=1 is resolved) — the
    // machine gate for profile honesty outranks ANY signal: under the caps / pretty-slice(15) the sentinel
    // "scope incomplete, run token-aware" is never cut.
    case 'scope_incomplete': return 0;
    case 'frame_missing': return 1;
    case 'extractor_outdated': return 2;
    case 'spacing_mismatch': return 3;
    case 'snapshot':
    case 'not_found': return 4;
    case 'structure_mismatch': return 5;
    case 'children_truncated': return 6;
    case 'unconfirmed_token': return b.places !== undefined ? 7 : 8;
    case 'uncovered_region': return b.count !== undefined ? 7 : 8;
    case 'unchecked_spacing': return 8;
    case 'viewport':
    case 'truncated_text': return 9; // deliberate residual: N≥2 carries a dominant_blocker; a lone N=1 is only dropped by the cap when >40 higher-priority items precede it
    case 'skip': return 10;
    default: return 8;
  }
}

// "Did the pair verify anything at all?" Pairs that are whole failures (node not found / snapshot fail) must
// NOT count as covering a region — they verified nothing (#8). structure_mismatch/skip are effective (the
// node's box was measured).
const INEFFECTIVE_PAIR = new Set(['node', 'snapshot', 'snapshot_schema', 'snapshot_ref']);
function pairIsEffective(p: PairResult): boolean {
  return p.rows.some((r) => !INEFFECTIVE_PAIR.has(dimensionOf(r.prop)));
}

// A region = a worthy node + the chain of ids from the frame's original child DOWN to it (through
// single-child wrappers). A pair on ANY id of the chain covers the region (else a pair on the wrapper is
// lost — #5/#6/#7). Guard: do NOT unwrap through a childrenTruncated wrapper (there could have been more
// children beyond the slice → the wrapper is no longer "single-child", unwrapping would hide the incompleteness).
// origChild — the original child BEFORE unwrapping (needed by the partial-container audit: it wants to
// see the container's "raw" child, not the terminal worthy node, if unwrapping took several steps).
// chainNodes — the chain's nodes PARALLEL to chainIds: auditContainer must measure the geometry of
// the node AT THE chain level where the pair actually sits, not always the terminal worthy node (the pair
// may be on an intermediate wrapper) — cheap, the chain is already iterated for chainIds.
interface Region { node: SpecChild; chainIds: string[]; chainNodes: SpecChild[]; origChild: SpecChild }
function unwrapChain(child: SpecChild): Region {
  const origChild = child;
  let cur = child;
  const chain = [norm(cur.id)];
  const chainNodes = [cur];
  while (!figWorthy(cur) && (cur.children?.length ?? 0) === 1 && cur.childrenTruncated !== true) {
    cur = cur.children![0];
    chain.push(norm(cur.id));
    chainNodes.push(cur);
  }
  return { node: cur, chainIds: chain, chainNodes, origChild };
}
// A pure decoration (0 children): background/divider/glyph-icon. The AI does not map them to separate DOM
// nodes (they become CSS background/border/svg) — flagging them "uncovered/add_pair" = crying wolf + flooding
// blocking. TEXT/INSTANCE/FRAME/GROUP/... stay regions. Their geometry is covered by their CONTAINER's pair.
const DECORATIVE_LEAF = new Set(['RECTANGLE', 'VECTOR', 'LINE', 'ELLIPSE', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION', 'SLICE']);
function isRegion(node: SpecChild): boolean {
  // imageFill exception: a RECTANGLE/ELLIPSE with an IMAGE/VIDEO fill = CONTENT (avatar/preview → DOM <img>),
  // not decoration — stays a region (else an unpaired image is silently not-uncovered = a false green).
  if (DECORATIVE_LEAF.has(node.type) && (node.children?.length ?? 0) === 0 && !node.imageFill) return false;
  return figWorthy(node) || node.childrenTruncated === true;
}
function worthyRegions(children: SpecChild[] | undefined): Region[] {
  // We keep worthy nodes AND truncated wrappers: unwrapChain stops at a childrenTruncated wrapper (not
  // worthy, 1 child within the slice) — don't drop it, else we lose its incompleteness (children beyond the slice).
  return (children ?? []).map(unwrapChain).filter((r) => isRegion(r.node));
}

// uncovered/partial accumulate IN PARALLEL a flat list of ids (backward-compat FrameCoverage.uncovered/
// partial — flat, as before) AND "meta" — needed by the anti-flood dedup of uncovered siblings
// (buildVerification collapses same-kind regions of ONE parent into one blocking item) and by the
// partial-container audit (the audit reads kids/pairedId to compute the spacing BETWEEN already-paired
// children without a pair on the container).
interface UncoveredMeta { id: string; parentId: string; sig: string }
interface PartialContainerMeta { containerId: string; axis: 'row' | 'col'; kids: Region[] }
interface Acc {
  uncovered: string[]; partial: string[]; truncated: boolean;
  causes: Set<'depth' | 'breadth' | 'budget'>;
  uncoveredMeta: UncoveredMeta[];
  partialContainers: PartialContainerMeta[];
}
interface WalkResult { touched: boolean; truncated: boolean }

// exclude_regions context (spec p.4 + panel). GOVERNING RULE: an exclusion removes a coverage
// DEMAND, never a MEASUREMENT — so touched-ness is computed for excluded branches exactly as for
// live ones (a pair inside an excluded subtree keeps covering its parent and keeps arming the
// partial gates; the panel's CRITICAL was a naive exclusion dropping touchedTop below 2 and
// disarming the spacing audit with both rects on the table). Only the demand accumulators (Acc)
// are discarded for excluded branches. collect=false inside an already-excluded subtree: nested
// matches register as "found" but do not add redundant excluded[] entries under their ancestor.
interface ExCtx { ids: Set<string>; matched: Set<string>; excluded: string[]; collect: boolean }
const throwawayAcc = (): Acc => ({ uncovered: [], partial: [], truncated: false,
  causes: new Set(), uncoveredMeta: [], partialContainers: [] });

// Recursive walk of a region's worthy subtree. touched = some pair landed inside the subtree.
// Side effects: partial (≥2 worthy children verified, but the container is NOT paired → the gaps BETWEEN
// them aren't verified, at ANY depth — #1) + uncovered (a sibling without a single pair, under full
// enumeration) + truncated (enumeration truncated → a pair could be beyond the slice; we don't cry uncovered
// — #4/#9). cause: the cause is added EXACTLY here (selfTrunc — the point where childrenTruncated is read on
// a SPECIFIC node) and in frameCoverageDetailed on the frame root. NOT at the propagation points below
// (x.r.truncated) — there the node itself may not be truncated, and `?? 'depth'` would inject a false depth
// → a false raise_max_depth in the advice matrix (locked by a mutation test).
function walk(region: Region, pairIds: Set<string>, acc: Acc, ex?: ExCtx): WalkResult {
  if (region.chainIds.some((id) => pairIds.has(id))) return { touched: true, truncated: false }; // region/wrapper paired — fully covered
  const selfTrunc = region.node.childrenTruncated === true;
  // the node is NOT paired itself (judged by the enumeration of its children), and enumeration is truncated →
  // uncovered children could remain beyond the slice → coverage is unprovable (even if the shown children are
  // covered). Honestly — not green.
  if (selfTrunc) { acc.truncated = true; acc.causes.add(region.node.truncationCause ?? 'depth'); }
  const kids = worthyRegions(region.node.children);
  if (kids.length === 0) return { touched: false, truncated: selfTrunc }; // unpaired leaf (possibly more children beyond the slice)
  const kidRes = kids.map((k) => {
    const hit = ex ? k.chainIds.some((id) => ex.ids.has(id)) : false;
    if (!hit) return { k, r: walk(k, pairIds, acc, ex), excluded: false };
    // excluded branch: demands discarded (throwaway Acc), touched-ness kept — see ExCtx. The
    // `excluded` flag guards the parent's uncovered push below: an untouched excluded child is
    // NOT a demand, while a touched one still counts toward the partial gate and parent coverage.
    for (const id of k.chainIds) if (ex!.ids.has(id)) ex!.matched.add(id);
    if (ex!.collect) ex!.excluded.push(norm(k.node.id));
    const thr = walk(k, pairIds, throwawayAcc(), { ...ex!, collect: false });
    // excluded truncation is not a coverage concern: the caller removed this scope from the demand.
    return { k, r: { touched: thr.touched, truncated: false }, excluded: true };
  });
  const subtreeTrunc = selfTrunc || kidRes.some((x) => x.r.truncated);
  const touchedKids = kidRes.filter((x) => x.r.touched);
  if (touchedKids.length === 0) return { touched: false, truncated: subtreeTrunc };
  // the spacing between children isn't verified — BUT it's only meaningful when the container is auto-layout
  // (without it the diff gives a children-skip: nothing to measure → a pair on the container is useless, the
  // flag = crying wolf, #3).
  if (touchedKids.length >= 2 && region.node.axis) {
    const cid = norm(region.node.id);
    acc.partial.push(cid);
    // auditContainer consumer: kids here — the FULL in-flow list of the container's DIRECT children
    // (including decor leaves / unpaired), NOT the worthyRegions-filtered `kids` above — auditContainer must
    // see a decorative neighbor between two paired children so it can honestly NOT measure the gap through it
    // (see spacing-audit.ts case 8), rather than silently "jump over" it.
    const allKids = (region.node.children ?? []).map(unwrapChain);
    acc.partialContainers.push({ containerId: cid, axis: region.node.axis, kids: allKids });
  }
  for (const x of kidRes) if (!x.r.touched && !x.excluded) {
    if (x.r.truncated) acc.truncated = true; // a pair could be beyond the slice → not a false uncovered
    else {
      const id = norm(x.k.node.id);
      acc.uncovered.push(id);
      acc.uncoveredMeta.push({ id, parentId: norm(region.node.id), sig: `${x.k.node.type}|${x.k.node.name}` });
    }
  }
  return { touched: true, truncated: subtreeTrunc };
}

// N > cap elements in a JSON list — response-budget guard (same motive as BLOCKING_CAP below).
const capList = (xs: string[], cap = 60): { list: string[]; capped?: number } =>
  xs.length > cap ? { list: xs.slice(0, cap), capped: xs.length - cap } : { list: xs };

// A rich version of frameCoverage: the same coverage geometry + detail channels for buildVerification
// (anti-flood dedup of uncovered, the partial-container audit). FrameCoverage BY ITSELF
// cannot carry uncoveredMeta/partialDetails (not JSON-flat, not needed by the receipt consumer).
// Only .coverage goes into the receipt (buildVerification).
export function frameCoverageDetailed(frame: LayoutSpec, pairIds: Set<string>, enumMeta: { depth: number; source: 'deep' | 'pair_fetch' }, ex?: ExCtx): {
  coverage: FrameCoverage;
  uncoveredMeta: Array<{ id: string; parentId: string; sig: string }>;
  partialDetails: Array<{ containerId: string; axis: 'row' | 'col'; kids: Array<{ child: SpecChild; pairedId?: string; pairedNode?: SpecChild }> }>;
} {
  const regions = worthyRegions(frame.children);
  const causes = new Set<'depth' | 'breadth' | 'budget'>();
  // the frame root — the second (and last) point where childrenTruncated is read on a SPECIFIC node.
  if (frame.childrenTruncated === true) causes.add(frame.truncationCause ?? 'depth');
  const acc: Acc = { uncovered: [], partial: [], truncated: frame.childrenTruncated === true, causes, uncoveredMeta: [], partialContainers: [] };
  let covered = 0;
  let touchedTop = 0;
  let excludedTop = 0;
  const frameId = norm(frame.node.id);
  for (const r of regions) {
    const hit = ex ? r.chainIds.some((id) => ex.ids.has(id)) : false;
    if (hit) {
      // Excluded top region: out of the worthy/covered ledger, no demands — but its touched-ness
      // still feeds the frame partial gate below (a pair inside it is a measurement fact; the
      // panel's CRITICAL was exactly this gate silently disarming).
      for (const id of r.chainIds) if (ex!.ids.has(id)) ex!.matched.add(id);
      ex!.excluded.push(norm(r.node.id));
      excludedTop += 1;
      const thr = walk(r, pairIds, throwawayAcc(), { ...ex!, collect: false });
      if (thr.touched) touchedTop += 1;
      continue;
    }
    const res = walk(r, pairIds, acc, ex);
    if (res.touched) { covered += 1; touchedTop += 1; }
    else if (res.truncated) acc.truncated = true; // the region is wholly unpaired, but a pair could be beyond the slice
    else {
      const id = norm(r.node.id);
      acc.uncovered.push(id);
      acc.uncoveredMeta.push({ id, parentId: frameId, sig: `${r.node.type}|${r.node.name}` });
    }
  }
  // #1: the frame node ITSELF is also a container. The top loop counts regions, but the inter-REGION gap
  // (the frame's auto-layout) is measured by NOBODY if the AI paired ≥2 regions but not the frame as a whole.
  // The same live false green that motivated thread A. Gated on frame.axis (without auto-layout there's no
  // inter-region gap).
  if (touchedTop >= 2 && frame.axis && !pairIds.has(frameId)) {
    acc.partial.push(frameId);
    // see the comment in walk() above — the FULL in-flow list of the frame's direct children, not the worthy-filtered `regions`.
    const allTopKids = (frame.children ?? []).map(unwrapChain);
    acc.partialContainers.push({ containerId: frameId, axis: frame.axis, kids: allTopKids });
  }

  const uncoveredCap = capList(acc.uncovered);
  const partialCap = capList(acc.partial);
  const coverage: FrameCoverage = {
    // worthy counts DEMANDED regions only — an excluded one leaves the denominator honestly,
    // instead of standing in it forever-uncovered. No cap on excluded[]: the input's 50-per-call
    // limit bounds it (a server cap here would be a threshold the population cannot reach).
    worthy: regions.length - excludedTop, covered, uncovered: uncoveredCap.list, partial: partialCap.list,
    ...(ex && ex.excluded.length ? { excluded: ex.excluded } : {}),
    enumeration_truncated: acc.truncated,
    ...(uncoveredCap.capped !== undefined ? { uncovered_capped: uncoveredCap.capped } : {}),
    ...(partialCap.capped !== undefined ? { partial_capped: partialCap.capped } : {}),
    enumeration_depth: enumMeta.depth, enumeration_source: enumMeta.source,
    ...(acc.causes.size > 0 ? { enumeration_causes: [...acc.causes] } : {}),
  };
  const partialDetails = acc.partialContainers.map((pc) => ({
    containerId: pc.containerId, axis: pc.axis,
    kids: pc.kids.map((k) => {
      // pairedNode = the CHAIN node at the position where the match was found (not always the terminal
      // worthy node k.node — the pair may sit on an intermediate wrapper, chainNodes parallels chainIds).
      const idx = k.chainIds.findIndex((id) => pairIds.has(id));
      return { child: k.origChild, ...(idx !== -1 ? { pairedId: k.chainIds[idx], pairedNode: k.chainNodes[idx] } : {}) };
    }),
  }));
  return { coverage, uncoveredMeta: acc.uncoveredMeta, partialDetails };
}

// Frame coverage: the frame's worthy regions vs the submitted (effective) pairs. Recursive — it catches
// holes at any depth. enumeration_truncated is honestly raised when the projection is truncated (else the
// checklist itself is a false green, and a deep-cut pair would give a false uncovered). A thin wrapper over
// frameCoverageDetailed — the ~19 existing direct callers in tests read only the coverage geometry, without
// the detail channels.
export function frameCoverage(frame: LayoutSpec, pairIds: Set<string>, enumMeta: { depth: number; source: 'deep' | 'pair_fetch' }): FrameCoverage {
  return frameCoverageDetailed(frame, pairIds, enumMeta).coverage;
}

function holeToBlocking(r: DiffRow, p: PairResult, depthLevels: number): BlockingItem {
  const base = { node_id: p.node_id, ...(p.selector ? { selector: p.selector } : {}), detail: r.note ?? r.prop };
  switch (dimensionOf(r.prop)) {
    case 'structure_mismatch': return { ...base, kind: 'structure_mismatch', action: 'add_pairs_on_children' };
    // The last unguarded "raise max_depth" in this file. max_depth is capped at 8 by every schema that
    // takes it, so at 8 that action cannot be carried out and the blocker can never clear - the
    // done-gate stays false forever on any frame deep enough to hit it. Its two siblings were already
    // fixed this way: uncheckedToBlocking swaps to add_text_pair at 8, and the enumeration branch
    // stops emitting a blocker at all and says so in a caveat. What IS executable here is pairing the
    // deep node directly, which starts its own depth budget - the action already in the vocabulary.
    case 'children_truncated': return depthLevels < 8
      ? { ...base, kind: 'children_truncated', action: 'raise_max_depth' }
      : { ...base, kind: 'children_truncated', action: 'add_pairs_on_children',
          detail: `${base.detail} - already at the maximum capture depth (8), so a deeper capture is not available: pair the nested node directly` };
    case 'snapshot':
      // feedback 14: a not_found carrying the CSS-module hint means the SELECTOR is wrong -
      // re-running the extractor with the same selector reproduces the same not_found
      // forever; the executable action is fixing the pair, and the hint in detail names how.
      if ((r.note ?? '').includes('if your build mangles')) return { ...base, kind: 'snapshot', action: 'fix_pair' };
      return { ...base, kind: 'snapshot', action: 're_extract_dom' };
    case 'snapshot_schema':
    case 'snapshot_ref': return { ...base, kind: 'snapshot', action: 're_extract_dom' };
    case 'extractor_outdated': return { ...base, kind: 'extractor_outdated', action: 'update_extractor' };
    case 'node': return { ...base, kind: 'not_found', action: 'fix_pair' };
    default: return { ...base, kind: 'skip', action: 'resolve_skip' }; // status skip (env/no-auto-layout/scroll)
  }
}
// (b) viewport ergonomics: geometry-unchecked went down the UNCONDITIONAL
// truncated_text/raise_max_depth branch — "raise max_depth" on a WINDOW-WIDTH problem (and on scroll/
// rotated) = actively false navigation (max_depth fixes nothing here). Branching: viewport →
// actionable fix_viewport (numbers are already in detail via r.note/figma/dom from diff.ts); other env
// (scroll/transform/rotated/rect≈0) → resolve_skip; genuine typography rows — as before.
function uncheckedToBlocking(r: DiffRow, p: PairResult, depthLevels: number): BlockingItem {
  const base = { node_id: p.node_id, ...(p.selector ? { selector: p.selector } : {}), detail: r.note ?? r.prop };
  if (r.prop === 'geometry') {
    return (r.note ?? '').includes('viewport')
      ? { ...base, kind: 'viewport', action: 'fix_viewport' }
      : { ...base, kind: 'skip', action: 'resolve_skip' };
  }
  // corner-radius unchecked = the DOM radius is not one comparable px number (corners that differ, a
  // percentage, an ellipse) against Figma's single px radius. Left to fall through,
  // the change that exists to stop a false pass would tell the reader to raise max_depth in order to fix a
  // border radius — the same false navigation the note above says was removed for the viewport case.
  // resolve_skip is the existing "a human must look" bucket; no fourteenth action is invented for this.
  // border-color/fill join corner-radius (receipt-lens finding 1): dom-dom's 'axis was not
  // compared' rows - a human must look; the existing bucket, no fourteenth action.
  if (r.prop === 'corner-radius' || r.prop === 'border-color' || r.prop === 'fill') return { ...base, kind: 'skip', action: 'resolve_skip' };
  // icon-color note-guards (the p.7 precedent): each unchecked routes to ITS executable action.
  // Stale capture / dom-side truncation -> re-extract (the current extractor always writes icon
  // fields for a detected svg); a cut fig subtree -> a deeper fetch genuinely reveals the vectors.
  if (r.prop.startsWith('icon-color')) {
    if ((r.note ?? '').includes('older extractor') || (r.note ?? '').includes('re-extract')) {
      return { ...base, kind: 'snapshot', action: 're_extract_dom' };
    }
    // The cap-clamp refusal (batch 2 item 3): raising max_depth grows the scan cap only
    // across the 4 -> 5 boundary (15 -> 30); at 5-7 the cap stays 30 and the promise would
    // be unclearable - the executable action there is a direct pair. Checked AFTER the
    // re-extract branch (the dom-side cap wording routes to re_extract_dom above).
    if ((r.note ?? '').includes('scan cap')) {
      return depthLevels <= 4
        ? { ...base, kind: 'children_truncated', action: 'raise_max_depth' }
        : { ...base, kind: 'children_truncated', action: 'add_pairs_on_children',
            detail: `${base.detail} - raising max_depth does not grow the scan cap at this depth: pair the icon nodes directly` };
    }
    if ((r.note ?? '').includes('raise max_depth')) {
      return depthLevels < 8
        ? { ...base, kind: 'children_truncated', action: 'raise_max_depth' }
        : { ...base, kind: 'children_truncated', action: 'add_pairs_on_children',
            detail: `${base.detail} - already at the maximum capture depth (8): pair the icon node directly` };
    }
    return { ...base, kind: 'skip', action: 'resolve_skip' };
  }
  // p.7 carrier notes (note-guards, viewport precedent). AMBIGUOUS carriers: both texts are ALREADY
  // captured — a deeper capture resolves nothing, the only executable action is a pair on the text
  // node, at any depth. NO text in a fully captured subtree: neither depth nor a text pair exists to
  // add — a human fixes the pair or looks; resolve_skip is that bucket. The default below keeps
  // serving the beyond-cut carrier note, where raise_max_depth is genuinely the fix.
  if ((r.note ?? '').includes('several nested text carriers')) return { ...base, kind: 'skip', action: 'add_text_pair' };
  if ((r.note ?? '').includes('carries none')) return { ...base, kind: 'skip', action: 'resolve_skip' };
  return { ...base, kind: 'truncated_text', action: depthLevels < 8 ? 'raise_max_depth' : 'add_text_pair' };
}

export function buildVerification(pairs: PairResult[], opts: {
  frame?: LayoutSpec; frameRequested?: boolean; depthLevels: number;
  /** batch-2 item 4: the REQUESTED capture depth. depthLevels is the CLAMPED effective depth
   *  (a too_large backoff can lower it below a requested 8), so the ceiling test must see
   *  both. Optional; legacy callers are byte-identical (defaults to depthLevels). */
  requestedDepth?: number;
  // At what depth / by what method the FRAME was PROJECTED (not the pairs) — the source of honest
  // provenance and of the advice matrix below. TYPE-optional: calls without a frame (or legacy tests) don't
  // set it — the honest default ("enumeration by pair depth", see enumMeta below) preserves their old behavior.
  enumeration?: { depth: number; source: 'deep' | 'pair_fetch' };
  // the DOM slice of the pairs (the tool collects it in the pair loop), needed
  // by auditContainer for the between-children spacing audit of partial containers. Without it (legacy
  // calls/unit tests) spacing_audit is not computed at all — the old behavior (unchecked_spacing on EVERY
  // partial container) does not regress.
  captures?: Map<string, CaptureInfo>;
  tolerancePx?: number; // default 1 — mirrors the schema default of the tool's tolerance_px
  // the call's profile (from the tool's parsed arg, single source). 'layout' → sentinel
  // scope_incomplete in blocking + complete=false BY CONSTRUCTION (the machine honesty gate).
  // Presence → receipt.match_profile (all three modes); legacy calls without it — the prior behavior.
  matchProfile?: MatchProfile;
  // exclude_regions (normalized by the tool; normalized again here for direct callers): frame regions
  // whose COVERAGE DEMAND the caller removes. See ExCtx for the governing rule.
  excludeRegions?: string[];
  // compare_dom_to_dom: presence/drift reviews have no token key, and two of them on one pair
  // are structurally identical records (receipt-lens finding 3) - in this mode the generic
  // review blocking carries places:[{node_id, prop}] so a machine consumer can tell WHICH axis
  // to confirm. Absent -> figma-dom byte-for-byte.
  mode?: 'dom-dom';
}): VerificationReceipt {
  const scope: 'pairs' | 'frame' = opts.frame || opts.frameRequested ? 'frame' : 'pairs';
  const notes: string[] = [];
  let clean = 0;
  let anyFail = false, anyDemoted = false, anyUnchecked = false, anyHole = false, anyReview = false;
  const blocking: BlockingItem[] = [];
  const ceilingTailPairs: string[] = [];
  // confirm_token aggregation (two-axis, cross-pair — a Map OUTSIDE the pair loop): axis-1 by token name
  // (the "(paint)" sentinel and the empty name are NOT names: merging by them would glue DIFFERENT paints
  // together), axis-2 by reason for token-less rows (the vars-unavailable flood is the main live offender).
  // Rows with neither label — the prior direct push (legacy branches lose nothing).
  const tokenGroups = new Map<string, { places: { node_id: string; selector?: string; prop: string }[]; reasons: Map<string, number>; firstNote: string; domTokens: Set<string> }>();
  for (const p of pairs) {
    const holes = coverageHoleRows(p.rows);
    // Matched-value review rows are advisory (gatingReviewRow = rowValuesMatched + the ONE
    // exemption, semantic-diverged): they neither hold complete=false nor enter blocking below,
    // and they do not cost a pair its `clean` — a receipt saying complete:true over
    // checked:1/clean:0 would contradict itself. The summary.review count and the 📝 rows stay visible.
    const gatingReview = p.rows.some(gatingReviewRow);
    if (p.summary.fail === 0 && p.summary.demoted === 0 && p.summary.unchecked === 0 && !gatingReview && holes.length === 0) clean += 1;
    if (p.summary.fail > 0) anyFail = true;
    if (p.summary.demoted > 0) anyDemoted = true;
    if (p.summary.unchecked > 0) anyUnchecked = true;
    if (holes.length > 0) anyHole = true;
    if (gatingReview) anyReview = true;
    for (const h of holes) {
      // batch-2 item 4: the fully-evidenced depth-ceiling tail (structural row flag, derived
      // in diff.ts where both trees are in hand) mints NO blocking item at the capture
      // ceiling - the follow-up is a NEW verification cycle (re-root the cut node), not a
      // fix for this receipt. The row, the warn and complete=false all stay; a call-site
      // guard keeps holeToBlocking a pure mapper and the action census untouched.
      if (h.prop === 'children_truncated' && h.depthCeilingTail === true
        && (opts.depthLevels >= 8 || (opts.requestedDepth ?? opts.depthLevels) >= 8)) {
        // ids are `label ?? node_id` - the budgetDropNote convention: node_ids legally
        // repeat within one call, and in dom-dom the label IS the id.
        ceilingTailPairs.push(p.label ?? p.node_id);
        continue;
      }
      blocking.push(holeToBlocking(h, p, opts.depthLevels));
    }
    for (const r of p.rows) if (r.status === 'unchecked') blocking.push(uncheckedToBlocking(r, p, opts.depthLevels));
    for (const r of p.rows) if (r.status === 'review') {
      if (!gatingReviewRow(r)) continue; // advisory — see anyReview above
      const key = (r.token && r.token !== '(paint)') ? `tok:${r.token}` : r.tokenReason ? `rsn:${r.tokenReason}` : undefined;
      if (!key) { blocking.push({ kind: 'unconfirmed_token', node_id: p.node_id, ...(p.selector ? { selector: p.selector } : {}), action: 'confirm_token', detail: r.note ?? r.prop,
        ...(opts.mode === 'dom-dom' ? { places: [{ node_id: p.node_id, prop: r.prop }] } : {}) }); continue; }
      const g = tokenGroups.get(key) ?? { places: [], reasons: new Map<string, number>(), firstNote: r.note ?? r.prop, domTokens: new Set<string>() };
      g.places.push({ node_id: p.node_id, ...(p.selector ? { selector: p.selector } : {}), prop: r.prop });
      const reason = r.tokenReason ?? 'unspecified';
      g.reasons.set(reason, (g.reasons.get(reason) ?? 0) + 1);
      if (r.domToken) g.domTokens.add(r.domToken); // structural (types.ts contract: notes are never parsed)
      tokenGroups.set(key, g);
    }
  }
  // Flush the aggregates after the pair loop — this is the INSERTION POINT (an aggregate is only visible
  // after all pairs); the final POSITION in the list is set by the rankOf sort before the cap,
  // not by the push site. A group of 1 place — a single record of the prior format (detail =
  // note, WITHOUT places): byte-for-byte the same format as the old direct push.
  for (const [key, g] of tokenGroups) {
    const first = g.places[0];
    if (g.places.length === 1) {
      blocking.push({ kind: 'unconfirmed_token', node_id: first.node_id, ...(first.selector ? { selector: first.selector } : {}), action: 'confirm_token', detail: g.firstNote });
      continue;
    }
    const reasons = [...g.reasons.entries()].map(([r, n]) => `${r} ×${n}`).join(', ');
    const shown = g.places.slice(0, 3).map((pl) => `${pl.node_id}/${pl.prop}`).join(', ');
    const more = g.places.length > 3 ? ` and ${g.places.length - 3} more` : '';
    const head = key.startsWith('tok:') ? `confirm token "${key.slice(4)}"` : `confirm colors (token not named): ${key.slice(4)}`;
    // semantic-diverged rows carry the DOM var structurally; an aggregate that dropped them would
    // fail the criterion "detail names BOTH" for every N>=2 case (panel-measured). Cap mirrors
    // the places cap-3; distinct names only.
    const domVars = [...g.domTokens].slice(0, 3);
    const domClause = domVars.length ? `; DOM vars: ${domVars.join(', ')}${g.domTokens.size > 3 ? ` and ${g.domTokens.size - 3} more` : ''}` : '';
    blocking.push({ kind: 'unconfirmed_token', node_id: first.node_id, ...(first.selector ? { selector: first.selector } : {}), action: 'confirm_token',
      places: g.places.slice(0, PLACES_CAP).map(({ node_id, prop }) => ({ node_id, prop })),
      ...(g.places.length > PLACES_CAP ? { places_capped: g.places.length - PLACES_CAP } : {}),
      detail: `${head} — ×${g.places.length} places (${reasons}); places: ${shown}${more}${domClause}` });
  }

  let frame_coverage: FrameCoverage | undefined;
  let frameComplete = true;
  let spacingAuditEntries: SpacingAuditEntry[] | undefined;
  if (opts.frame) {
    // honest default: without an explicit enumeration we assume the frame was enumerated the same way as the
    // pairs (pair_fetch at depthLevels) — byte-for-byte the old behavior of legacy calls (NOT deep@8: deep is
    // a separate whole-frame fetch the caller must declare explicitly). NO `!`.
    const enumMeta = opts.enumeration ?? { depth: opts.depthLevels, source: 'pair_fetch' as const };
    // only effective pairs cover (#8) — whole failures already produced their blocking above
    const set = new Set(pairs.filter(pairIsEffective).map((p) => norm(p.node_id)));
    // exclude_regions plumbing. The frame root is not a legal exclusion: honoring it would kill the
    // frame-as-container partial gate (the thread-A live false green) — route it to not_found with
    // its own note instead, and keep the gate armed.
    const rawEx = [...new Set((opts.excludeRegions ?? []).map(norm))];
    const frameRootId = norm(opts.frame.node.id);
    const rootHit = rawEx.includes(frameRootId);
    const exIds = new Set(rawEx.filter((id) => id !== frameRootId));
    const ex: ExCtx | undefined = rawEx.length
      ? { ids: exIds, matched: new Set<string>(), excluded: [], collect: true }
      : undefined;
    const detailed = frameCoverageDetailed(opts.frame, set, enumMeta, ex);
    frame_coverage = detailed.coverage;
    if (ex) {
      if (rootHit) notes.push('the frame root cannot be excluded; exclude its regions instead');
      const notFound = rawEx.filter((id) => (id === frameRootId ? true : !ex.matched.has(id)));
      if (notFound.length) frame_coverage.excluded_not_found = notFound;
      if (ex.excluded.length && frame_coverage.worthy === 0) {
        notes.push("the whole frame's coverage was excluded — complete now speaks for the submitted pairs only");
      }
    }

    // Anti-flood: N uncovered siblings of ONE parent with the same type|name signature (e.g. 19 list cards
    // without pairs) collapse into ONE blocking item — else the same advice ("add a pair") floods blocking
    // with N identical lines. We group by the UNTRUNCATED uncoveredMeta (capList above cuts
    // only the JSON representation of .coverage.uncovered; the grouping must see all holes to count N correctly).
    const groups = new Map<string, { ids: string[]; name: string }>();
    for (const u of detailed.uncoveredMeta) {
      const key = `${u.parentId}|${u.sig}`;
      const name = u.sig.slice(u.sig.indexOf('|') + 1);
      const g = groups.get(key);
      if (g) g.ids.push(u.id); else groups.set(key, { ids: [u.id], name });
    }
    for (const { ids, name } of groups.values()) {
      if (ids.length === 1) {
        blocking.push({ kind: 'uncovered_region', node_id: ids[0], action: 'add_pair', detail: "frame region unpaired — the region's layout is not verified" });
      } else {
        const shown = ids.slice(0, 3).join(', ');
        // N>3 — we show not "…" but an honest "first 3 of N" (how much reach is actually hidden behind the ellipsis).
        const idsPart = ids.length > 3 ? `${shown} — first 3 of ${ids.length}` : shown;
        blocking.push({
          kind: 'uncovered_region', node_id: ids[0], action: 'add_pair', count: ids.length,
          detail: `${ids.length} similar "${name}" regions unpaired (id: ${idsPart}) — layout not verified`,
        });
      }
    }

    // the between-children spacing audit of partial containers — auditContainer
    // measures the gaps BETWEEN already-paired children directly from rects (without a pair on the container).
    // Requires opts.captures (the DOM slice of the pairs, collected by the tool); without it the old behavior
    // stays (unchecked_spacing on EVERY partial container, spacing_audit not computed at all — details below).
    if (opts.captures && detailed.partialDetails.length > 0) {
      const computed = detailed.partialDetails
        .map((d) => auditContainer(d.containerId, d.axis, d.kids, opts.captures!, opts.tolerancePx ?? 1))
        .filter((e): e is SpacingAuditEntry => e !== undefined);
      if (computed.length > 0) spacingAuditEntries = computed;
    }
    const auditByContainer = new Map((spacingAuditEntries ?? []).map((e) => [e.container_id, e]));

    // We iterate the FULL (uncapped) detailed.partialDetails, not the capped frame_coverage.partial — the
    // caps protect ONLY the size of the JSON .coverage, not the correctness of blocking (same principle as
    // complete/frameComplete below: capList cuts ONLY the representation, not the source of truth).
    for (const d of detailed.partialDetails) {
      const entry = auditByContainer.get(d.containerId);
      // "Adjacency completeness": the numbered PAIREDNESS of the container's direct children — pairedCount-1
      // is the expected number of between-pair gaps IF all paired children were literally adjacent to one
      // another. auditContainer emits a gap ONLY for literally-adjacent both-paired pairs (spacing-audit.ts
      // case 8 / A,B,C-partial) — decor OR an unpaired worthy neighbor between two paired children breaks that
      // adjacency → entry.gaps.length < expectedGaps honestly signals "part of the spacing wasn't measured"
      // (never-false-green: suppressing unchecked_spacing is allowed ONLY when EVERY expected gap was actually
      // emitted and passed).
      const pairedCount = d.kids.filter((k) => k.pairedId !== undefined).length;
      const expectedGaps = Math.max(0, pairedCount - 1);
      const failGaps = entry?.gaps.filter((g) => g.status === 'fail') ?? [];
      const hasUnchecked = entry?.gaps.some((g) => g.status === 'unchecked') ?? false;
      const fullyClean = entry !== undefined && failGaps.length === 0 && !hasUnchecked && entry.gaps.length === expectedGaps;

      // Final hardening: mark the entry so report.ts can stop counting this
      // container under "unpaired (spacing between children)" — that gap-set IS verified (fully clean);
      // only insets_unverified remains, which deserves its own honest line, not the between-children one.
      if (fullyClean) { entry!.fully_clean = true; continue; } // spacing_audit explains itself — unchecked_spacing is useless here

      if (failGaps.length > 0) {
        // Dedup (plan point 4): ONE item per container even with several fail gaps.
        const maxDelta = Math.max(...failGaps.map((g) => g.delta ?? 0));
        blocking.push({
          kind: 'spacing_mismatch', node_id: d.containerId, action: 'add_container_pair',
          detail: `${failGaps.length}/${entry!.gaps.length} gaps differ (max Δ${maxDelta}px) — confirm with a container pair`,
        });
        continue;
      }

      blocking.push({ kind: 'unchecked_spacing', node_id: d.containerId, action: 'add_container_pair', detail: 'children paired, container not — spacing BETWEEN children is not verified; add a pair on the container' });
    }
    // Advice on enumeration_truncated — cause/source-aware (raise_max_depth is valid
    // ONLY when enumeration went by pair-fetch below the cap AND the cause is depth — then raising max_depth
    // really deepens the enumeration. The deep path is fixed at 8 → raise lies; budget/breadth don't depend on
    // depth → raise is not executable. Non-curable cases = a caveat WITHOUT blocking (rule A1).
    if (frame_coverage.enumeration_truncated) {
      const causes = frame_coverage.enumeration_causes ?? [];
      const notes: string[] = [];
      if (enumMeta.source === 'pair_fetch' && enumMeta.depth < 8 && causes.includes('depth')) {
        blocking.push({ kind: 'children_truncated', node_id: norm(opts.frame.node.id), action: 'raise_max_depth', detail: 'frame children enumeration truncated — coverage incomplete, raise max_depth' });
      } else if (causes.includes('depth')) {
        notes.push(enumMeta.depth >= 8
          ? 'frame deeper than 9 levels — enumeration is complete to 9; verify deep regions with targeted pairs or get_view'
          : `frame too heavy for full enumeration — enumerated to ${enumMeta.depth} levels`);
      }
      if (causes.includes('budget') || causes.includes('breadth')) {
        notes.push('frame wider than the enumeration budget — coverage partial');
      }
      if (notes.length) frame_coverage.enumeration_note = notes.join('; ');
    }
    // The caps (uncovered/partial truncated in .coverage to 60) do NOT affect complete — we compute it from
    // the UNTRUNCATED channels (uncoveredMeta/partialDetails parallel acc.* BEFORE capList).
    frameComplete = detailed.uncoveredMeta.length === 0 && detailed.partialDetails.length === 0 && !frame_coverage.enumeration_truncated;
  } else if (opts.frameRequested) {
    // frame_node_id is given, but the frame wasn't found in the file (#10): do NOT silently downgrade to pairs + green
    blocking.push({ kind: 'frame_missing', action: 'fix_frame_id', detail: 'frame_node_id given, but the frame node was not found in the file — frame coverage not checked; check the id' });
    frameComplete = false;
    // exclusions are neither applied nor reported here — frame_missing is the only signal
    // (50 spurious not_found warns on top of a missing frame would bury it).
  } else if (opts.excludeRegions?.length) {
    // exclusions given without a frame at all: loud, never a silent ignore.
    notes.push('exclude_regions apply to frame coverage; no frame was given — exclusions were not applied');
  }

  // the MACHINE honesty gate: under layout, complete is
  // NEVER true and blocking is non-empty BY CONSTRUCTION (the existing SKILL gate "complete!==true → don't say
  // done" keeps working by machine, without prose bridges). The sentinel is pushed LAST (after ALL channels) —
  // its final position (FIRST) is set by rankOf=0 in the sort below, not by the push site.
  const scopeIncomplete = opts.matchProfile === 'layout';
  if (scopeIncomplete) {
    blocking.push({ kind: 'scope_incomplete', action: 'run_token_aware',
      detail: 'layout profile: typography/colors/styles are out of scope — before "verified against the design" run token-aware or strict' });
  }

  const complete = !anyFail && !anyDemoted && !anyUnchecked && !anyHole && !anyReview && frameComplete && !scopeIncomplete;

  // Stable sort (ES2019): equal rank preserves appearance order (per-pair adjacency within a rank). BEFORE
  // the cap — so the least valuable tail is cut, and pretty-slice(15) in report.ts inherits the same priority
  // without its own logic.
  blocking.sort((a, b) => rankOf(a) - rankOf(b));
  const capped = Math.max(0, blocking.length - BLOCKING_CAP);

  // (c) batch dominant: ≥2 checked pairs silenced by ONE
  // viewport cause → one loud aggregate instead of N quiet lines. Numbers — ONLY from the structural
  // fields of the geometry row; other geometry causes carry no fields → they don't count.
  const vpRows = pairs.flatMap((p) => p.rows.filter((r) =>
    r.prop === 'geometry' && r.status === 'unchecked'
    && typeof r.figma === 'number' && typeof r.dom === 'number'));
  const dominant_blocker = vpRows.length >= 2
    ? { kind: 'viewport' as const, pairs: vpRows.length, window: vpRows[0].dom as number, frame: vpRows[0].figma as number }
    : undefined;

  // batch-2 item 4: ONE aggregated deduped note for the ceiling tails, pushed to the OUTER
  // notes array AFTER the pair loop (never inside the enumeration block - its inner `notes`
  // shadows this one). notes[] renders as a warn line in BOTH report branches and survives
  // the response-budget clamp.
  if (ceilingTailPairs.length > 0) {
    const ids = [...new Set(ceilingTailPairs)];
    const shown = ids.slice(0, 5).join(', ')
      + (ids.length > 5 ? ` and ${ids.length - 5} more` : '');
    notes.push(`${ceilingTailPairs.length} pair(s) reached the capture ceiling (max_depth 8 requested) with a depth-only cut: `
      + 'the design has visible content below the ceiling that was not captured - an unrendered slot or missing content; '
      + `verify the deep interior visually, or pair the cut node(s) named in the children_truncated row directly (re-rooting restarts the depth budget): ${shown}`);
  }
  return {
    complete, scope, pairs: { checked: pairs.length, clean },
    // an additive field (verification byte-locks are re-baselined ONLY by it).
    ...(opts.matchProfile !== undefined ? { match_profile: opts.matchProfile } : {}),
    ...(frame_coverage ? { frame_coverage } : {}),
    ...(spacingAuditEntries && spacingAuditEntries.length > 0 ? { spacing_audit: spacingAuditEntries } : {}),
    blocking: capped > 0 ? blocking.slice(0, BLOCKING_CAP) : blocking,
    ...(capped > 0 ? { blocking_capped: capped } : {}),
    ...(dominant_blocker ? { dominant_blocker } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

// The budget drop trace (clamped fail-pair debt): when the response-budget clamp drops whole
// pairs, the receipt says so in ONE notes[] line - notes render as warn lines in BOTH report
// branches and are not parseable by contract, so the machine key is the omitted_pair_ids
// sibling field the line points at. NOT a blocking item: the action vocabulary has no
// executable member for "the budget dropped this pair", and an item added after
// buildVerification's rankOf sort + BLOCKING_CAP slice would land unranked past the report's
// 15-item slice with a stale blocking_capped. Shared by BOTH comparators (the one place the
// wording lives). ids are `label ?? node_id` - node_ids legally repeat within one call, and
// in dom-dom the label IS the id.
export function budgetDropNote(ids: string[], failCount: number): string {
  const head = ids.slice(0, 5).join(', ');
  const more = ids.length > 5 ? ` and ${ids.length - 5} more` : '';
  const fails = failCount > 0 ? `; ${failCount} of them carry FAILing rows` : '';
  return `${ids.length} pair(s) did not fit the response budget and are absent from pairs[]: `
    + `${head}${more}${fails} - re-run them in a separate compare call (fewer pairs at a time); full list in omitted_pair_ids`;
}
