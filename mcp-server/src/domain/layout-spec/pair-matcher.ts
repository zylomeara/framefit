// Figma-node ↔ DOM-element matcher — a pure deterministic module (no I/O).
// Proposes pairs by text/size/order/role with confidence + honest-null
// (a node with no DOM pair above the threshold is unmatched, not a forced pair with a low score).

import type { SpecChild, DomChild } from './types.js';
import { SNIPPET_CAP } from './types.js';
import { normSnippet } from './diff.js';

export type Confidence = 'high' | 'medium' | 'low';
export interface ProposedPair { node_id: string; name: string; type: string; dom_path: string; confidence: Confidence; signals: string[];
  // The receipt: the numbers the ranking actually used, so a reader can tell a text-anchored proposal
  // from a geometry-only one WITHOUT reading the scorer, and reject a bad one without a browser round
  // trip. score = the value scoreToConfidence was fed (phase-1 text bijection commits at a flat 100 —
  // it is not ranked, its uniqueness IS the evidence); margin = lead over the runner-up on the level,
  // absent when there was no runner-up. text-exact is worth +100 of a ~145 scale, so a score under ~46
  // means "no text matched on either side", not "weak geometry" — see signals.
  score: number; margin?: number;
  // Identity of both sides, for eye-confirmation: unmatched_dom already carried a tag while the pair
  // rows did not, so the honest-null list was more informative than the proposal list.
  figma_rect: { w: number; h: number }; dom_rect: { w: number; h: number }; dom_tag: string;
  // Descent stopped here: this commit was a coin flip (margin < AMBIGUOUS_MARGIN) and children matched
  // under an unresolved parent inherit its error. Confirm/retarget this pair, then re-run on the
  // confirmed subtree.
  children_skipped?: true;
  // The runner-up rows carry the SAME identity as the pair row. Without it the reported case reads as
  // two nth-child paths and two scores rounded to the same integer - the live 0.19-margin contest
  // printed the design's Footer over the page <header> at "41" with the actual <footer> at "41" - and
  // the reader has no way to decide it short of opening a browser. With it the heights alone decide it.
  ambiguous?: boolean; candidates?: { dom_path: string; score: number; dom_tag: string; dom_rect: { w: number; h: number } }[];
  figma_text?: string; dom_text?: string } // matched content (not name — master layer ≠ override); absent if a side has no text
export interface MatchResult { pairs: ProposedPair[];
  unmatched_figma: { node_id: string; name: string; reason: string; rect: { w: number; h: number } }[];
  unmatched_dom: { dom_path: string; tag: string; rect: { w: number; h: number } }[];
  depth_truncated?: boolean } // honest marker: maxDepth cut off a non-empty subtree (not "empty matched")
export interface MatchOpts { maxDepth?: number;
  rootFig?: { w: number; h: number }; rootDom?: { w: number; h: number } // the root's real rect — more precise than the max-child proxy
  rootDomTruncated?: boolean } // the root doms list is incomplete (the extractor cut >30 direct children) — the top-level competitor set is unreliable

const MATCH_FLOOR = 25;       // below this — honest-null (not a forced pair)
const AMBIGUOUS_MARGIN = 12;  // best's lead over the runner-up below this — ambiguous
// SNIPPET_CAP (120) — the textSnippet/dom-text cut (projector/dom-extractor slice(0,SNIPPET_CAP)) —
// at this length text-exact rests on the prefix. Imported from types.ts (the single source of truth).

// Scan a competitor's text. CRITICAL: a miss → the guard fires (!competitors.some) → a FALSE anchor
// (unsafe). So do it FULLY + CONSERVATIVELY: flatten the ENTIRE .text of the subtree recursively, strip
// ALL whitespace on both sides, substring — over-approximates the string's presence (over-rejection is
// safe). Robust to splitting across nested elements (<span>Buy</span><span>Now</span>) and whitespace variants.
const flattenText = (node: DomChild): string => {
  let s = node.text !== undefined ? node.text + ' ' : '';
  for (const k of node.children ?? []) s += flattenText(k);
  return s;
};
const stripWs = (s: string): string => normSnippet(s).replace(/\s+/g, '');
// A competitor with childrenTruncated anywhere in its subtree = content-unknown: the truncated content
// could have carried the anchor string, the scan does NOT see it → conservatively assume "may contain" →
// don't anchor through such a competitor (over-rejection is safe; a miss → a false anchor, the module's
// invariant). The field comes from #4 (the extractor's honest truncation at the depth limit). Also closes
// the pre-existing #2 truncation hole.
const subtreeTruncated = (node: DomChild): boolean =>
  node.childrenTruncated === true || (node.children ?? []).some(subtreeTruncated);

// giant-phase-0 (salvage-nested): raw text units of the subtree. The Fig walk is ONLY over the
// SpecChild tree (visible:false is filtered by the projector via inFlowChildren BEFORE the descent —
// hidden text physically never reaches here; an invariant, don't weaken it).
export function collectFigSnippets(c: SpecChild): string[] {
  const out: string[] = [];
  const walk = (n: SpecChild): void => {
    if (n.textSnippet !== undefined) out.push(n.textSnippet);
    for (const k of n.children ?? []) walk(k);
  };
  walk(c);
  return out;
}
export function collectDomTextUnits(d: DomChild): string[] {
  const out: string[] = [];
  const walk = (n: DomChild): void => {
    if (n.text !== undefined) out.push(n.text);
    for (const k of n.children ?? []) walk(k);
  };
  walk(d);
  return out;
}
// content-unknown for phase-0: childrenTruncated (a cap on the NUMBER of children) does NOT
// cover per-node text truncation at SNIPPET_CAP (120) WITHOUT a flag (dom-extractor/projector
// .slice(0,SNIPPET_CAP)) — the distinguishing suffix could have gone past the cut, the uniqueness scan
// is blind. Any text ≥ SNIPPET_CAP in the subtree = content is not complete → the same total caution as
// childrenTruncated. The return is a REASON, not just a boolean: diff.ts promises
// "raise max_depth" ONLY when a drill-down would actually help (truncation — a capture cut), not when the
// text is COMPLETE but ≥SNIPPET_CAP chars (longtext — the snippet is cut at SNIPPET_CAP structurally, a drill-down can't reach it).
// Priority truncation > longtext WITHIN one subtree: if both are found — the answer is 'truncation'
// (a drill-down is still needed AND sufficient to remove the main cause of the content being unknown).
export function figContentUnknown(c: SpecChild): 'truncation' | 'longtext' | undefined {
  let truncation = false;
  let longtext = false;
  const walk = (n: SpecChild): void => {
    if (n.childrenTruncated === true) truncation = true;
    if (n.textSnippet !== undefined && n.textSnippet.length >= SNIPPET_CAP) longtext = true;
    for (const k of n.children ?? []) walk(k);
  };
  walk(c);
  return truncation ? 'truncation' : longtext ? 'longtext' : undefined;
}
export function domContentUnknown(d: DomChild): 'truncation' | 'longtext' | undefined {
  let truncation = false;
  let longtext = false;
  const walk = (n: DomChild): void => {
    if (n.childrenTruncated === true) truncation = true;
    if (n.text !== undefined && n.text.length >= SNIPPET_CAP) longtext = true;
    for (const k of n.children ?? []) walk(k);
  };
  walk(d);
  return truncation ? 'truncation' : longtext ? 'longtext' : undefined;
}

// The content identifier of a Figma node — ONLY its own textSnippet (set only on TEXT nodes; the
// auto-descent places .text typography, NOT textSnippet — containers match by size/order).
export function figText(c: SpecChild): string | undefined { return c.textSnippet; }
// DOM: the own .text OR the text of the single direct kind:'text' child (asymmetry with Figma).
export function domText(c: DomChild): string | undefined {
  if (c.text !== undefined) return c.text;
  const texts = (c.children ?? []).filter((k) => k.kind === 'text' && k.text !== undefined);
  return texts.length === 1 ? texts[0].text : undefined;
}

// A single-child box is a PASS-THROUGH wrapper only when it actually passes its geometry through -
// when its own box is its child's box. One that centres, pads or otherwise sizes its child carries
// layout of its own, and unwrapping through it throws that layout away along with the address a
// reader would retarget from. Measured on a live page: a <main> 1909x973 whose only child was a
// 1280x877 container scored 36.19 against the design node that spans that region, and the unwrap
// replaced it with the container, which scored 25.93 - a worse match AND a worse address, from a
// box the design never meant.
// 1px, not a tolerance knob: the question is "same box or not", and a wrapper that differs by a
// fraction of a pixel is the rounding of a capture, not a layout decision.
const SAME_BOX_PX = 1;
const passesThrough = (own: { w: number; h: number }, kid: { w: number; h: number }): boolean =>
  Math.abs(own.w - kid.w) <= SAME_BOX_PX && Math.abs(own.h - kid.h) <= SAME_BOX_PX;

export function figWorthy(c: SpecChild): boolean {
  if (figText(c) !== undefined || c.type === 'INSTANCE') return true;
  const kids = c.children ?? [];
  if (kids.length !== 1) return true;
  return !passesThrough(c.rect, kids[0].rect); // a single-child wrapper — worthy only if it adds geometry
}
export function domWorthy(c: DomChild): boolean {
  if (c.kind === 'text') return false; // text is diffed on the parent element
  if (domText(c) !== undefined) return true;
  const elemKids = (c.children ?? []).filter((k) => k.kind === 'element');
  if (elemKids.length !== 1) return true;
  return !passesThrough(c.rect, elemKids[0].rect);
}

// C1: fall through single-child non-worthy wrappers to the first worthy descendant (otherwise the whole
// subtree is silently lost — the wrapper is not worthy AND is not recursed into). Terminates (the tree is finite).
export function figUnwrap(c: SpecChild): SpecChild {
  let cur = c;
  while (!figWorthy(cur) && (cur.children?.length ?? 0) === 1) cur = cur.children![0];
  return cur;
}
export function domUnwrap(c: DomChild): DomChild {
  let cur = c;
  while (!domWorthy(cur)) {
    const elemKids = (cur.children ?? []).filter((k) => k.kind === 'element');
    // NOT dead code: !domWorthy(cur) doesn't imply elemKids.length===1 — it's also true when
    // cur.kind==='text' (domWorthy returns false IMMEDIATELY on kind, regardless of elemKids), which is
    // genuinely reachable: a bare top-level text child in the DOM snapshot (DomSnapshotOk.children
    // documents "including bare text nodes"). There elemKids.length is usually 0 → without this break
    // `cur = elemKids[0]` would become undefined and the next iteration would crash on .kind of undefined.
    if (elemKids.length !== 1) break;
    cur = elemKids[0];
  }
  return cur;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const round2 = (x: number): number => Math.round(x * 100) / 100; // receipt numbers, not a comparison key
export function scorePair(fig: SpecChild, dom: DomChild, figIdx: number, domIdx: number,
  figParent: { w: number; h: number }, domParent: { w: number; h: number }): number {
  let s = 0;
  const ft = figText(fig); const dt = domText(dom);
  if (ft !== undefined && dt !== undefined && normSnippet(ft) === normSnippet(dt)) s += 100;
  const dRelW = Math.abs(fig.rect.w / (figParent.w || 1) - dom.rect.w / (domParent.w || 1));
  const dRelH = Math.abs(fig.rect.h / (figParent.h || 1) - dom.rect.h / (domParent.h || 1));
  s += 25 * clamp01(1 - (dRelW + dRelH));
  s += 15 * clamp01(1 - Math.abs(figIdx - domIdx) / 4);
  if (fig.type === 'INSTANCE') s += 5; // role: the TEXT signal is already in text-exact; INSTANCE — a DS instance
  return s;
}
function scoreToConfidence(best: number, runnerUp?: number): Confidence {
  const margin = best - (runnerUp ?? 0);
  if (best >= 90 && margin >= AMBIGUOUS_MARGIN) return 'high';
  if (best >= 55) return 'medium';
  return 'low';
}
// The runner-up rows, built once for both callers below: an ambiguity and a withheld subtree show the
// same thing, and the top-3 cut is a display decision, not a soundness one.
const candidateRows = (cs: { x: { d: DomChild }; s: number }[]): { dom_path: string; score: number; dom_tag: string; dom_rect: { w: number; h: number } }[] =>
  cs.slice(0, 3).map((c) => ({ dom_path: c.x.d.path ?? '', score: Math.round(c.s),
    dom_tag: c.x.d.tag ?? '?', dom_rect: { w: c.x.d.rect.w, h: c.x.d.rect.h } }));
function signalsOf(f: SpecChild, d: DomChild): string[] {
  const out: string[] = [];
  const ft = figText(f); const dt = domText(d);
  if (ft !== undefined && dt !== undefined && normSnippet(ft) === normSnippet(dt)) out.push('text-exact');
  out.push('size', 'order');
  if (f.type === 'INSTANCE') out.push('role');
  return out;
}

// A single-level match for structure_mismatch salvage (A2): fig children ↔ dom children DIRECTLY (no
// recursion, no unwrap — the children's original rects are needed for gaps/offsets). Globally greedy by
// descending score (no fig-order bias), confidence per-fig (best vs its runner-up). The consumer
// (diff.ts) diffs ONLY high (a text anchor / strong size+order) — medium/low → unmatched: zero
// confident-wrong on a wrong match (a bar stronger than "count+monotonic").
// A shared helper for phase-0 and the reorder detector: includeOwnText controls
// the own-textSnippet filter — false = phase-0 semantics, true = the detector's input.
// Phase-0 (salvage-nested): a nested bijection for fig children WITHOUT their own
// textSnippet — DS instances have their text deep, text-exact +100 is unreachable, high is impossible.
// TWO DIRECTIONS — DIFFERENT OPERATIONS: blocking = substring over the stripWs concatenation
// (over-rejection is safe), confirm = ONLY exact-per-node (substring would give high on the superstring
// 'Save'⊆'Saved to wishlist'; the concatenation 'Bu'+'y' fabricates S). Any content-unknown sibling
// (childrenTruncated OR text ≥SNIPPET_CAP — per-node truncation without a flag) → phase-0 is
// turned off entirely (uniqueness is unprovable) + muted for diff.ts diagnostics.
// The reason is gathered across ALL siblings on both sides: if even one has
// 'truncation' → the result is 'truncation' (a drill-down would actually help somewhere on the level),
// otherwise — if there is at least one 'longtext' and no 'truncation' — the result is 'longtext' (a drill-down won't help anywhere).
export function buildNestedAnchorMap(figs: SpecChild[], doms: DomChild[], opts: { includeOwnText: boolean }):
  { anchor: Map<number, { domIdx: number; text: string }>; muted?: 'truncation' | 'longtext' } {
  const anchor = new Map<number, { domIdx: number; text: string }>();
  const figReasons = figs.map(figContentUnknown);
  const domReasons = doms.map(domContentUnknown);
  const anyTruncation = figReasons.some((r) => r === 'truncation') || domReasons.some((r) => r === 'truncation');
  const anyLongtext = figReasons.some((r) => r === 'longtext') || domReasons.some((r) => r === 'longtext');
  if (anyTruncation) return { anchor, muted: 'truncation' };
  if (anyLongtext) return { anchor, muted: 'longtext' };
  // Precompute once: siblings' snippets, flat texts, and discrete text-sets.
  const figSnips = figs.map(collectFigSnippets);                  // one walk per sibling (not twice)
  const figFlats = figSnips.map((sn) => stripWs(sn.join(' ')));
  const domFlats = doms.map((d) => stripWs(flattenText(d)));
  const domTextSets = doms.map((d) => new Set(collectDomTextUnits(d).map((t) => normSnippet(t))));
  const anchorOf = new Map<number, { domIdx: number; text: string }>();
  const anchoredBy = new Map<number, number[]>();      // di → fi[] (collisions)
  for (let fi = 0; fi < figs.length; fi += 1) {
    if (!opts.includeOwnText && figText(figs[fi]) !== undefined) continue;   // own-text children — the old byte-for-byte path
    let target: number | -1 | undefined;               // undefined=no S; -1=contradiction/blocked
    let anchorText = '';
    for (const S of figSnips[fi]) {
      // Belt-and-suspenders: with the content-unknown guard active (anyUnknown above, the same
      // SNIPPET_CAP threshold) this branch is unreachable (the projector cuts the snippet
      // slice(0,SNIPPET_CAP)) — it hedges a future weakening of the guard to per-sibling. NOT tested
      // separately (mutation test 5c checks anyUnknown).
      if (S.length >= SNIPPET_CAP) continue;
      const sw = stripWs(S); if (sw === '') continue;  // whitespace-only snippet — not an anchor (locked by the snippet-anchor test)
      if (figFlats.some((fl, i) => i !== fi && fl.includes(sw))) continue;   // fig-blocking
      const nS = normSnippet(S);
      const hits = domTextSets.flatMap((set, di) => (set.has(nS) ? [di] : []));   // confirm exact-per-node
      if (hits.length !== 1) continue;                                            // not exactly one
      if (domFlats.some((fl, di) => di !== hits[0] && fl.includes(sw))) continue; // dom-blocking (competitor concatenation)
      if (target === undefined) { target = hits[0]; anchorText = S; }
      else if (target !== hits[0]) { target = -1; break; }                        // contradiction
    }
    if (target !== undefined && target !== -1) {
      anchorOf.set(fi, { domIdx: target, text: anchorText });
      anchoredBy.set(target, [...(anchoredBy.get(target) ?? []), fi]);
    }
  }
  for (const [fi, entry] of anchorOf) {
    if ((anchoredBy.get(entry.domIdx) ?? []).length !== 1) continue;              // collision — both miss
    anchor.set(fi, entry);
  }
  return { anchor };
}

export function matchChildrenOneLevel(
  figs: SpecChild[], doms: DomChild[], figPar: { w: number; h: number }, domPar: { w: number; h: number },
): { matched: { figIdx: number; domIdx: number; confidence: Confidence }[]; unmatchedFig: number[]; unmatchedDom: number[]; nestedAnchorMuted?: 'truncation' | 'longtext' } {
  const usedF = new Set<number>(); const usedD = new Set<number>();
  const matched: { figIdx: number; domIdx: number; confidence: Confidence }[] = [];
  const nested = buildNestedAnchorMap(figs, doms, { includeOwnText: false });
  const nestedAnchorMuted = nested.muted;
  for (const [fi, { domIdx }] of nested.anchor) {
    matched.push({ figIdx: fi, domIdx, confidence: 'high' });
    usedF.add(fi); usedD.add(domIdx);
  }
  const scores: { fi: number; di: number; s: number }[] = [];
  const bestByFig = new Map<number, { best: number; runner: number }>();
  for (let fi = 0; fi < figs.length; fi += 1) {
    for (let di = 0; di < doms.length; di += 1) {
      const s = scorePair(figs[fi], doms[di], fi, di, figPar, domPar);
      scores.push({ fi, di, s });
      const b = bestByFig.get(fi) ?? { best: -1, runner: -1 };
      if (s > b.best) { b.runner = b.best; b.best = s; } else if (s > b.runner) { b.runner = s; }
      bestByFig.set(fi, b);
    }
  }
  // Text counts for disambiguation: high is reachable ONLY via text-exact (+100; size+order max ~45 <90),
  // so a repeated text on EITHER side makes the margin depend on size+order (blind to cross-position) —
  // a confident match of the wrong duplicate becomes possible ('Save'/'Edit'/'×' are common). Duplicate text → cap medium (we don't diff it).
  const countText = <T>(items: T[], getText: (t: T) => string | undefined): Map<string, number> => {
    const m = new Map<string, number>();
    for (const it of items) { const t = getText(it); if (t !== undefined) m.set(normSnippet(t), (m.get(normSnippet(t)) ?? 0) + 1); }
    return m;
  };
  const figTextN = countText(figs, figText);
  const domTextN = countText(doms, domText);
  for (const c of [...scores].sort((a, b) => b.s - a.s)) {
    if (usedF.has(c.fi) || usedD.has(c.di)) continue;
    const b = bestByFig.get(c.fi)!;
    let conf = scoreToConfidence(c.s, b.runner);
    if (conf === 'high') {
      const ft = figText(figs[c.fi]); const dt = domText(doms[c.di]);
      if (ft !== undefined && dt !== undefined && normSnippet(ft) === normSnippet(dt)) {
        const k = normSnippet(ft);
        // Duplicate text = an indistinguishable anchor. + truncation-suspect: the snippets are collected
        // at the SNIPPET_CAP-char cut (projector/dom-extractor slice(0,SNIPPET_CAP)), so the equality
        // rests on the PREFIX and doesn't prove the full text — two DIFFERENT long texts sharing the first
        // SNIPPET_CAP chars would give +100 on a mis-pair (a cross-collision the duplicate counter doesn't
        // catch: each is unique up to the cut). Both → cap medium.
        const truncationSuspect = ft.length >= SNIPPET_CAP || dt.length >= SNIPPET_CAP;
        if ((figTextN.get(k) ?? 0) > 1 || (domTextN.get(k) ?? 0) > 1 || truncationSuspect) conf = 'medium';
      }
    }
    matched.push({ figIdx: c.fi, domIdx: c.di, confidence: conf });
    usedF.add(c.fi); usedD.add(c.di);
  }
  matched.sort((a, b) => a.figIdx - b.figIdx);
  const unmatchedFig = figs.map((_, i) => i).filter((i) => !usedF.has(i));
  const unmatchedDom = doms.map((_, i) => i).filter((i) => !usedD.has(i));
  return { matched, unmatchedFig, unmatchedDom, ...(nestedAnchorMuted ? { nestedAnchorMuted } : {}) };
}

// children-reorder: a content-reorder detector for equal-count children.
// The "rank ↔ index" comparison is valid ONLY on main-axis-sorted inputs — we sort BOTH sides ourselves
// (idempotent for the already-sorted diff.ts calls — the hidden cross-module dependency
// is removed). The tol-tie gate: with equal/close (≤tol) main-start neighbours the order
// is geometrically undefined — stable sorts tie-break fig by layer order, dom by document order → j!==i
// on CORRECT layout; such indices don't prove a reorder → silence. Never "confirms the order":
// undefined = unprovable OR correct — deliberately not distinguished.
export function detectChildrenReorder(figs: SpecChild[], doms: DomChild[], tol: number, axis: 'row' | 'col'):
  { moved: { figIdx: number; domIdx: number; text: string }[] } | { muted: 'truncation' | 'longtext' } | undefined {
  const mainStart = (r: { x: number; y: number }): number => (axis === 'row' ? r.x : r.y);
  const fs = [...figs].sort((a, b) => mainStart(a.rect) - mainStart(b.rect));
  const ds = [...doms].sort((a, b) => mainStart(a.rect) - mainStart(b.rect));
  const res = buildNestedAnchorMap(fs, ds, { includeOwnText: true });
  if (res.muted) return { muted: res.muted };
  // Math.abs: a no-op in prod (inputs are sorted, diffs ≥0), but it unmasks the "sort removed"
  // mutation — a signed diff on an unsorted input would yield negative values ≤ tol and silently mute the
  // defensive-sort lock in the tests.
  const tieAt = (arr: { rect: { x: number; y: number } }[], k: number): boolean =>
    (k > 0 && Math.abs(mainStart(arr[k].rect) - mainStart(arr[k - 1].rect)) <= tol)
    || (k < arr.length - 1 && Math.abs(mainStart(arr[k + 1].rect) - mainStart(arr[k].rect)) <= tol);
  const moved: { figIdx: number; domIdx: number; text: string }[] = [];
  for (const [fi, { domIdx, text }] of res.anchor) {
    if (domIdx === fi) continue;
    if (tieAt(fs, fi) || tieAt(fs, domIdx) || tieAt(ds, fi) || tieAt(ds, domIdx)) continue; // tol-tie
    moved.push({ figIdx: fi, domIdx, text });
  }
  moved.sort((a, b) => a.figIdx - b.figIdx);
  return moved.length > 0 ? { moved } : undefined;
}

export function matchPairs(figs: SpecChild[], doms: DomChild[], opts: MatchOpts = {}): MatchResult {
  const result: MatchResult = { pairs: [], unmatched_figma: [], unmatched_dom: [] };
  const pairCompetitors = new Map<ProposedPair, DomChild[]>();
  // Pairs whose sibling level (ds at the moment of their phase-2 commit) was cut by the
  // extractor's cap on the number of children (not by the content of a single competitor, like
  // subtreeTruncated, but by the NUMBER of competitors in the list) — the true competitor could have been
  // dropped ENTIRELY, the scan set is unreliable → don't anchor regardless of the scan result.
  const truncatedLevelPairs = new Set<ProposedPair>();
  const walk = (fs: SpecChild[], ds: DomChild[], figPar: { w: number; h: number }, domPar: { w: number; h: number }, depth: number, levelTruncated: boolean): void => {
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) {
      // Silently cutting the honest marker would leave no trace — the consumer couldn't tell
      // "matched empty" from "cut by depth". We mark only if there was actually something to lose here.
      if (fs.length > 0 || ds.length > 0) result.depth_truncated = true;
      return;
    }
    const wf = fs.map((f, i) => ({ f: figUnwrap(f), i })).filter((x) => figWorthy(x.f)); // C1: unwrap before the filter
    const wd = ds.map((d, j) => ({ d: domUnwrap(d), j })).filter((x) => domWorthy(x.d));
    const usedFig = new Set<number>(); const usedDom = new Set<number>();
    const commit = (fx: { f: SpecChild; i: number }, dx: { d: DomChild; j: number }, best: number, runner?: number): ProposedPair => {
      usedFig.add(fx.i); usedDom.add(dx.j);
      const ft = figText(fx.f); const dt = domText(dx.d);
      // The SAME margin scoreToConfidence bands on (runner absent → the lead is over nothing) — one
      // quantity, printed and acted on, so the receipt explains the descent instead of narrating it.
      const margin = best - (runner ?? 0);
      const pair: ProposedPair = { node_id: fx.f.id, name: fx.f.name, type: fx.f.type, dom_path: dx.d.path ?? '',
        confidence: scoreToConfidence(best, runner), signals: signalsOf(fx.f, dx.d),
        score: round2(best), ...(runner !== undefined ? { margin: round2(margin) } : {}),
        figma_rect: { w: fx.f.rect.w, h: fx.f.rect.h }, dom_rect: { w: dx.d.rect.w, h: dx.d.rect.h }, dom_tag: dx.d.tag ?? '?',
        ...(ft !== undefined ? { figma_text: ft } : {}), ...(dt !== undefined ? { dom_text: dt } : {}) };
      result.pairs.push(pair);
      // The descent gate. A commit whose lead over the runner-up is inside AMBIGUOUS_MARGIN is not a
      // resolved identity, and children matched below it inherit that coin flip: on the live case one
      // such level-0 commit (margin 2.67) manufactured four further wrong proposals by recursing the
      // design's Footer into the page's book cards. We still descend when the descent can bring the
      // evidence that RESOLVES the parent — the descendant-anchor post-pass below upgrades an unresolved
      // parent through a high (text-exact) descendant, so text on BOTH sides under the pair is exactly
      // "a descent may pay for itself". Text on neither side (the live frame: one TEXT node in the
      // design, none in the capture at that depth) — no descent can ever resolve it, and everything it
      // would emit is geometry compounded on a coin flip. Stop there, and SAY so (children_skipped);
      // silence would read as "the subtree matched empty". Phase-1 (unique text on both sides) commits
      // at 100 with no runner-up — margin 100, unaffected.
      const fk = fx.f.children ?? []; const dk = dx.d.children ?? [];
      if (fk.length && dk.length) {
        // margin first: on a resolved commit the two subtree scans below are computed and thrown away.
        if (margin < AMBIGUOUS_MARGIN
          && !(fk.some((k) => collectFigSnippets(k).length > 0) && dk.some((k) => collectDomTextUnits(k).length > 0)))
          pair.children_skipped = true;
        // We inherit levelTruncated DOWNWARD — if the CURRENT level (the one dx.d is committed
        // on) was already cut by an ancestor list, dx.d's committed position is unreliable (the true dom
        // dx.d.i could have been dropped by truncation) → ALL descendants committed under dx.d also
        // over-reject, regardless of whether dx.d's OWN children list is cut (dx.d.childrenTruncated===true
        // — whether dx.d's nested children list is cut on the NEXT level). Without the OR the descendants
        // would falsely trust their single local flag and anchor under an unreliable ancestor.
        else walk(fk, dk, { w: fx.f.rect.w, h: fx.f.rect.h }, { w: dx.d.rect.w, h: dx.d.rect.h }, depth + 1, levelTruncated || dx.d.childrenTruncated === true);
      }
      return pair;
    };
    // Phase 1 (I2): a content bijection by text BEFORE structure — unique text on both sides.
    for (const fx of wf) {
      if (usedFig.has(fx.i)) continue;
      const ft = figText(fx.f); if (ft === undefined) continue;
      const nf = normSnippet(ft);
      const dHits = wd.filter((x) => !usedDom.has(x.j) && domText(x.d) !== undefined && normSnippet(domText(x.d)!) === nf);
      const fHits = wf.filter((x) => !usedFig.has(x.i) && figText(x.f) !== undefined && normSnippet(figText(x.f)!) === nf);
      if (dHits.length === 1 && fHits.length === 1) commit(fx, dHits[0], 100 /*text-exact*/, undefined);
    }
    // Phase 2: greedy by score for the remainder.
    for (const fx of wf) {
      if (usedFig.has(fx.i)) continue;
      const scored = wd.filter((x) => !usedDom.has(x.j))
        .map((x) => ({ x, s: scorePair(fx.f, x.d, fx.i, x.j, figPar, domPar) }))
        .sort((a, b) => b.s - a.s || a.x.j - b.x.j); // determinism
      const best = scored[0];
      if (!best || best.s < MATCH_FLOOR) { // honest-null
        result.unmatched_figma.push({ node_id: fx.f.id, name: fx.f.name, reason: best ? 'weak match' : 'no DOM candidate',
          rect: { w: fx.f.rect.w, h: fx.f.rect.h } }); // the honest-null rows carry size on BOTH sides — that is how a reader re-pairs them by eye
        continue;
      }
      const pair = commit(fx, best.x, best.s, scored[1]?.s);
      // The competitor set P for the anchor SCAN — ALL worthy siblings of the level (raw wd minus the
      // chosen one), REGARDLESS of score and usedDom. Not ≥FLOOR: the soundness question is "is the
      // high-descendant's text unique among ALL sibling subtrees", and a <FLOOR sibling (mis-sized by a
      // layout bug = the very subject of QA) with the same string proves the text does NOT distinguish. We
      // do it for ANY phase-2 pair — a terminal sibling isn't flagged ambiguous (scored[1] is empty), but
      // its alt-doms are the same. Raw ds[x.j] (before unwrap) — full coverage.
      pairCompetitors.set(pair, wd
        .filter((x) => x.j !== best.x.j)
        .map((x) => ds[x.j]));
      // this phase-2 commit happened on a level whose sibling list (ds) is cut by the extractor's
      // cap (levelTruncated) — the competitor set above may not have included the true competitor (dropped
      // entirely, not merely cut inside) → we mark the pair for the post-pass block, regardless of the scan result.
      if (levelTruncated) truncatedLevelPairs.add(pair);
      // greed (phase-2) may tie-break between close candidates — flag it honestly rather than
      // silently pick the "best". The bijection (phase-1) doesn't reach here (always unique text) — the
      // guard scored[1] >= MATCH_FLOOR: a weak second candidate is not a real alternative, it's one honest
      // pair, not an ambiguity.
      const runnerUp = scored[1];
      if (runnerUp && runnerUp.s >= MATCH_FLOOR && best.s - runnerUp.s < AMBIGUOUS_MARGIN) {
        pair.ambiguous = true;
        // The display top-3 "what to show" — the ≥FLOOR filter STAYS here (not an anchor-soundness question).
        pair.candidates = candidateRows(scored.filter((c) => c.s >= MATCH_FLOOR));
      }
      // A withheld subtree and an ambiguity are gated on the SAME number by two different rules:
      // children_skipped needs only margin < AMBIGUOUS_MARGIN, while ambiguous ALSO demands a runner-up
      // >= MATCH_FLOOR ("a weak second candidate is not a real alternative"). A runner-up in between -
      // strong enough to stop a descent, too weak to be called an alternative - left the row saying "I
      // withheld the children" with nothing on it to say what stopped them. If a candidate was decisive
      // enough to withdraw a whole subtree it is decisive enough to name, so the list is emitted without
      // the >= FLOOR filter and WITHOUT pair.ambiguous, which would be a different and false claim.
      if (pair.children_skipped && pair.candidates === undefined) pair.candidates = candidateRows(scored);
    }
    // honest-null on the DOM side (I1): worthy doms of this level, taken by no one.
    for (const x of wd) if (!usedDom.has(x.j)) result.unmatched_dom.push({ dom_path: x.d.path ?? '', tag: x.d.tag ?? '?', rect: { w: x.d.rect.w, h: x.d.rect.h } });
  };
  // The real rect of the root frame / DOM container is more precise than the "widest child" — both sides
  // are normalized to their true container, not to a proxy. The fallback (opts.root* not given) preserves
  // the old behavior — the matcher's unit tests without rootFig/rootDom don't change.
  const figPar = opts.rootFig ?? { w: Math.max(1, ...figs.map((f) => f.rect.w)), h: Math.max(1, ...figs.map((f) => f.rect.h)) };
  const domPar = opts.rootDom ?? { w: Math.max(1, ...doms.map((d) => d.rect.w)), h: Math.max(1, ...doms.map((d) => d.rect.h)) };
  walk(figs, doms, figPar, domPar, 0, opts.rootDomTruncated === true);
  // #2 bottom-up disambiguation (competitor-subtree-scoped): an ambiguous OR low pair is
  // confirmed by a distinguishing high descendant — a terminal sibling (low-non-ambiguous, scored[1]
  // empty — no competitor below) is covered too, not just ambiguous. P is confirmed if it has a
  // descendant C (confidence:high, text-exact) whose text DISTINGUISHES the competitors — appears
  // nowhere in the RAW DOM subtree of any of P's FULL competitor set (ALL worthy siblings of the level
  // except the chosen one, WITHOUT the ≥FLOOR filter — captured in pairCompetitors for each phase-2
  // pair). The raw subtree (not the committed pairs) also sees unmatched text → closes both
  // candidate-truncation (the full set, not the display top-3 candidates) and the case of a shared string
  // as an unmatched leaf under a competitor. A shared string (a Buy button under a different tile) → found
  // in a competitor → doesn't anchor (scenario: shared text under a competitor → candidate truncation).
  // Recall (revised): ALL worthy siblings of P's LEVEL are scanned, including <FLOOR (a card mis-sized by
  // a layout bug — itself the subject of QA) — THIS WIDENS the old boundary: a nav decoy (a top-level
  // SIBLING of P with matching text, previously <FLOOR and thus invisible to the scan) is NOW a competitor
  // too and correctly blocks (the same class of hole as the previous case — test (d) updated). The only
  // LEGIT recall — a decoy NOT on P's level (a different parent/depth → a different wd, structurally
  // outside pairCompetitors).
  // Descendancy — by dom_path prefix (segments via ' ', boundary ')').
  const isDescendant = (childPath: string, parentPath: string): boolean =>
    parentPath !== '' && childPath.startsWith(parentPath + ' ');
  for (const p of result.pairs) {
    // eligible = ambiguous OR low (non-ambiguous low — a terminal sibling). We do NOT touch high and "clean
    // medium" (non-ambiguous, ≥55) — high is self-evident by its text, clean medium is already unflagged;
    // hanging descendant-anchored on them is noise, not an upgrade.
    if (!p.ambiguous && p.confidence !== 'low') continue;
    // P's sibling list on its level was cut by the extractor's cap (parent/root
    // childrenTruncated) → the true competitor could have been dropped ENTIRELY (not merely trimmed
    // inside, that's already covered by subtreeTruncated) → the scan set is unreliable, don't anchor.
    if (truncatedLevelPairs.has(p)) continue;
    const competitors = pairCompetitors.get(p) ?? [];
    if (competitors.length === 0) continue; // a lone pair with no competitors on the level — we don't upgrade (out of scope 🟡)
    const anchored = result.pairs.some((c) => {
      if (c === p || c.confidence !== 'high' || c.dom_text === undefined) return false;
      if (!isDescendant(c.dom_path, p.dom_path)) return false;
      const t = stripWs(c.dom_text);
      if (t === '') return false;
      return !competitors.some((comp) => subtreeTruncated(comp) || stripWs(flattenText(comp)).includes(t));
    });
    if (!anchored) continue;
    delete p.ambiguous;
    delete p.candidates;
    if (!p.signals.includes('descendant-anchored')) p.signals.push('descendant-anchored');
    if (p.confidence === 'low') p.confidence = 'medium';
  }
  return result;
}
