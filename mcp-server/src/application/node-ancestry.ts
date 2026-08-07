// Ancestry engine: resolve a target node's chain of containing ancestors (page → … → immediate
// parent) via bbox-guided descent. The Figma REST API never returns a node's parent, so this walks
// DOWN from the document root instead: each candidate's absoluteBoundingBox decides which subtree
// contains the target's center ("bbox leads"), and the guess is confirmed by id once its subtree is
// actually fetched ("id confirms"). Budgeted: every fetch counts against maxCalls (default
// MAX_ANCESTRY_CALLS) and is preceded by a deadline check. Once the descent is underway it
// terminates with an honest, non-throwing result — confirmed or not, with a note explaining why
// not; a mid-descent fetch failure (network flake, rate limit, a fetch that started a moment
// before deadlineAt and got aborted by the adapter) only kills that BRANCH, never the whole call.
// Deliberate throws remain: target not found / no bbox (call 1), any call-2 failure (no skeleton —
// nothing to descend into), and auth/forbidden anywhere (the token is dead for every next request).
import type { FigmaApi } from '../ports/figma-api.js';
import type { RawSceneNode } from '../domain/figma-raw.js';
import { FigmaApiError } from '../ports/errors.js';
import { normalizeCompoundNodeId } from '../domain/node-id.js';

// Global budget for one ancestry resolution. Raised 12 → 16 because an overlay's absolute
// coordinates collide with several unrelated pages' mega-sections, so probe-first legitimately
// spends ~7 calls fetching every containing tier-0 BEFORE any descent begins. 12 left too few
// calls for a target a few levels below its section; 16 = call-1 + skeleton + ~7 probe + ~7
// grandchild-stepped descent (~14 real levels). Cost on SUCCESS is unchanged — an early confirm
// returns immediately; only the worst-case budget on a genuine miss grows, modestly.
export const MAX_ANCESTRY_CALLS = 16;

// The document-skeleton fetch (call 2) requests this depth from the Figma REST /files endpoint
// (depth=1 -> pages only, depth=2 -> pages + tier-0 top-level containers). Kept at 2 DELIBERATELY:
// call 2 is NOT failure-tolerant — any error throws the whole ancestry (see the call-2 block) — and
// a deeper skeleton on a ~110 MB worst-case file (tens of MB of payload) is exactly the 400/timeout
// failure that forced find_nodes off whole-file fetches onto a depth-2 skeleton + per-container
// chunks (find-nodes-tool.ts). Deepening here would trade a payload risk for a HARD throw on the
// very files this engine must serve. The skeleton id-scan below therefore only ever sees tier-0 (its
// children are stripped at depth 2); everything below tier-0 is reached by probe-first + area
// ranking + budget caps, never by loading more of the tree up front.
const SKELETON_DEPTH = 2;

export interface AncestryNode { id: string; name: string; type: string; w?: number; h?: number }

export interface AncestryResult {
  target: AncestryNode;
  path: RawSceneNode[]; // page → … → immediate parent (raw nodes — the tool layer formats them)
  confirmed: boolean; // target id was found among the fetched subtrees
  callsUsed: number;
  note?: string; // honest explanation for an ambiguous/budget outcome, or a geometry caveat
}

interface Box { x: number; y: number; w: number; h: number }

function boxOf(n: RawSceneNode): Box | null {
  const b = n.absoluteBoundingBox;
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
}

// Inclusive on all edges by design: a center sitting exactly on a shared boundary between two
// siblings makes BOTH of them candidates (documented order then decides which is tried first).
function containsCenter(n: RawSceneNode, center: { x: number; y: number }): boolean {
  const b = boxOf(n);
  if (!b) return false;
  return center.x >= b.x && center.x <= b.x + b.w && center.y >= b.y && center.y <= b.y + b.h;
}

function pathHasRotated(path: RawSceneNode[]): boolean {
  return path.some((n) => !!n.rotation);
}

// bbox area — the ranking key that lets a specific true container (a small section) beat a giant
// false one (an unrelated page's mega-section) that also happens to contain the target's center.
// containsCenter already guarantees a box exists for every candidate this is called on.
function areaOf(n: RawSceneNode): number {
  const b = boxOf(n);
  return b ? b.w * b.h : Infinity;
}

// Ascending by area; ties keep the original (document) relative order — Array.prototype.sort is
// stable in every JS engine this runs on, so a plain sort on a pre-existing document-order array
// is itself the documented tie-break, with no extra bookkeeping needed.
function byAreaAscending<T>(items: T[], areaFn: (t: T) => number): T[] {
  return [...items].sort((a, b) => areaFn(a) - areaFn(b));
}

// The '<session>' of a Figma '<session>:<local>' node id, compound-normalized: an instance-internal
// id ("I12:361;56:7891") clusters with the plain "12:*" nodes of the same screen. Nodes
// authored in one editing session share this prefix, so a fallback path whose TAIL shares the
// target's session prefix sits on the target's actual screen — the robust separator geometry cannot
// provide when an overlay's coordinates collide with an unrelated page's similarly-sized node.
function sessionPrefixOf(id: string): string {
  const core = id.startsWith('I') ? id.slice(1) : id;
  const colon = core.indexOf(':');
  return colon === -1 ? core : core.slice(0, colon);
}

// English per the tool-ecosystem convention (compare-tool / report.ts / diff.ts) — the notes'
// consumer is the same AI that reads those reports.
const NOTE_BUDGET_CALLS = 'call budget exhausted (overlays/depth) — verify against the last ancestor\'s children';
const NOTE_BUDGET_TIME = 'time budget exhausted — verify against the last ancestor\'s children';
const NOTE_CHAIN_BROKE =
  'containment chain broke (overflow/invisible) — target not found by geometry';
const NOTE_NO_CANDIDATE =
  'the target center falls into no top-level container — non-standard layout or a stale bbox';
const NOTE_ROTATED_TARGET = 'target is rotated — bbox is axis-aligned, geometry is approximate';
const NOTE_ROTATED_PATH = 'a rotated container on the path — geometry is approximate';
const NOTE_BRANCHES_UNAVAILABLE = 'some branches unavailable (network/time) — the path may be incomplete';

type DescendOutcome =
  | { kind: 'confirmed'; path: RawSceneNode[] }
  | { kind: 'dead' }
  | { kind: 'stop'; note: string }
  // This branch hit its PER-BRANCH call cap (not the global budget, and not a geometric dead end —
  // its lead is still live). The caller parks it and gives another branch a turn; a later round
  // may revisit it with a fresh, larger cap.
  | { kind: 'parked' };

export async function resolveAncestry(
  api: Pick<FigmaApi, 'getNodesRaw' | 'getDocumentRaw'>,
  fileKey: string,
  targetId: string,
  opts?: { maxCalls?: number; deadlineAt?: number; now?: () => number },
): Promise<AncestryResult> {
  const maxCalls = opts?.maxCalls ?? MAX_ANCESTRY_CALLS;
  const now = opts?.now ?? Date.now;
  const deadlineAt = opts?.deadlineAt;
  let callsUsed = 0;

  // Returns the reason the NEXT fetch cannot be afforded, or null if it's fine to proceed.
  // Checked before every fetch from call 2 onward (call 1 always runs — without it there is no
  // target to report, and AncestryResult.target is mandatory).
  function stopReason(): 'calls' | 'time' | null {
    if (deadlineAt !== undefined && now() >= deadlineAt) return 'time';
    if (callsUsed >= maxCalls) return 'calls';
    return null;
  }

  // ---- call 1: identify the target, resolve its id (compound-safe), and read its bbox ----
  const normId = normalizeCompoundNodeId(targetId);
  callsUsed++;
  const res1 = await api.getNodesRaw(fileKey, [normId], 1);
  const targetDoc = res1.nodes[normId]?.document;
  if (!targetDoc) throw new Error(`node not found: ${targetId}`);
  const box = boxOf(targetDoc);
  if (!box) {
    throw new Error(
      `node ${targetId} has no absoluteBoundingBox — ancestry by geometry is impossible; use find_nodes with scope`,
    );
  }
  // ALWAYS plain "n:n", even for a compound input — every later comparison uses this, never the
  // raw targetId (a compound string structurally never matches a descendant's plain id).
  const resolvedId = targetDoc.id;
  const targetPrefix = sessionPrefixOf(resolvedId);
  const target: AncestryNode = { id: resolvedId, name: targetDoc.name, type: targetDoc.type, w: box.w, h: box.h };
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const rotatedTarget = !!targetDoc.rotation;

  // Nodes already fetched at depth 2, cached by id. Backtracking after a dead grandchild branch G
  // re-enters G's parent C (fetching C is genuinely new info — it reveals G's siblings' children);
  // from inside descend(C), the containing child G must NOT be re-fetched — but unlike a plain
  // "seen it, skip it" dedup, its ALREADY-KNOWN data is recursed into for free (descend again on the
  // cached node, zero calls). This is what makes a per-branch-cap "park" resumable: a branch that
  // parked mid-descent, revisited later with a bigger cap by simply restarting from its tier-0 root,
  // fast-forwards through its entire previously-fetched prefix for free and picks up exactly where it
  // left off — no separate resume-point bookkeeping needed. A plain Set (fetched-but-skip) would
  // instead fall through to the NEXT sibling candidate at the frontier, silently abandoning the
  // deeper lead already paid for; the cache is what keeps that lead alive across rounds.
  const fetchedNodes = new Map<string, RawSceneNode>();
  const failedIds = new Set<string>(); // fetch attempted and failed — never retried, and there is no data to recurse into
  let fetchFailed = false; // some branch was lost to a network/time failure (not to geometry)

  // One guarded depth-2 fetch of a candidate. auth/forbidden rethrow — the token is dead for the
  // whole call, no sibling can succeed either. Anything else (timeout/network/rate_limited/
  // not_found, incl. an adapter abort when the fetch straddled deadlineAt) means "branch
  // unavailable": the candidate counts as exhausted (kept in failedIds — never retried) and the DFS
  // continues with siblings — mirroring find_nodes' skipped+continue semantics instead of throwing
  // away the partial path already earned.
  async function fetchNode(id: string): Promise<RawSceneNode | undefined> {
    callsUsed++;
    try {
      const res = await api.getNodesRaw(fileKey, [id], 2);
      const node = res.nodes[id]?.document;
      if (node) fetchedNodes.set(id, node);
      else failedIds.add(id); // no data came back — treat like any other unavailable branch
      return node;
    } catch (err) {
      if (err instanceof FigmaApiError && (err.kind === 'auth' || err.kind === 'forbidden')) throw err;
      fetchFailed = true;
      failedIds.add(id);
      return undefined;
    }
  }

  let bestPath: RawSceneNode[] = [];
  // A partial (unconfirmed) path is "better" when its TAIL shares the target's session prefix — it is
  // on the target's real screen — and, among equally-affine paths, when it is longer (deeper toward
  // the target). A longer but session-unrelated path (an overlay bbox-collision into another page)
  // never displaces an affine one. When NEITHER is affine this is exactly the old longest-wins rule,
  // so no confirmed path is affected (confirmed results never read bestPath) and non-overlay cases
  // are unchanged.
  function tailIsAffine(path: RawSceneNode[]): boolean {
    const tail = path[path.length - 1];
    return !!tail && sessionPrefixOf(tail.id) === targetPrefix;
  }
  function recordPath(path: RawSceneNode[]): void {
    if (path.length === 0) return;
    const newAffine = tailIsAffine(path);
    const curAffine = tailIsAffine(bestPath);
    if (newAffine !== curAffine) {
      if (newAffine) bestPath = path; // affine always beats non-affine, regardless of length
      return;
    }
    if (path.length > bestPath.length) bestPath = path; // same affinity class → deeper wins (old rule)
  }

  function noteFor(base: string | undefined, path: RawSceneNode[]): string | undefined {
    const parts: string[] = [];
    if (base) parts.push(base);
    // Unconfirmed outcomes always carry a base note; a confirmed path is id-proven, so lost
    // branches cannot have made it wrong — the unavailability caveat attaches only alongside a base.
    if (base && fetchFailed) parts.push(NOTE_BRANCHES_UNAVAILABLE);
    if (rotatedTarget) parts.push(NOTE_ROTATED_TARGET);
    if (pathHasRotated(path)) parts.push(NOTE_ROTATED_PATH);
    return parts.length ? parts.join('; ') : undefined;
  }

  function stopResult(reason: 'calls' | 'time'): AncestryResult {
    const base = reason === 'time' ? NOTE_BUDGET_TIME : NOTE_BUDGET_CALLS;
    return { target, path: bestPath, confirmed: false, callsUsed, note: noteFor(base, bestPath) };
  }

  // ---- call 2: document skeleton — pages (CANVAS) + their direct children ----
  // NOT failure-tolerant on purpose: without the skeleton there are no candidates at all, so ANY
  // call-2 failure (not just auth) propagates as an honest throw — there is no partial result to save.
  {
    const reason = stopReason();
    if (reason) return stopResult(reason);
  }
  callsUsed++;
  const res2 = await api.getDocumentRaw(fileKey, SKELETON_DEPTH);
  const pages = res2.document.children ?? [];

  // Tier-0 candidates in document order: (page, child) pairs across ALL pages — pages can share
  // overlapping coordinate spaces, so candidates from every page compete equally (no page is
  // privileged just for being first; a false page is weeded out by the lack of id confirmation).
  const tier0: { node: RawSceneNode; page: RawSceneNode }[] = [];
  for (const page of pages) {
    for (const child of page.children ?? []) tier0.push({ node: child, page });
  }

  // Step 0 (before any further fetch): an id match already visible in the skeleton confirms
  // instantly — zero extra calls. At SKELETON_DEPTH=2 the skeleton reaches only tier-0 (its children
  // are stripped), so in practice this confirms a top-level-frame target — the same reach the
  // original tier-0-only comparison had. The child / grandchild loops below work strictly WITHIN the
  // depth-2 skeleton: at depth 2 tier-0.children is empty, so they are inert (harmless dead reach),
  // but they keep the scan correct-by-construction should the skeleton ever legitimately deepen.
  // Anything below tier-0 today is reached by probe / area-ranking / budget caps, not here. CANVAS
  // pages are never containment-tested — they have no bbox and are a pass-through grouping level;
  // only their children are candidates.
  for (const { node, page } of tier0) {
    if (node.id === resolvedId) {
      return { target, path: [page], confirmed: true, callsUsed, note: noteFor(undefined, [page]) };
    }
    for (const child of node.children ?? []) {
      if (child.id === resolvedId) {
        const path = [page, node];
        return { target, path, confirmed: true, callsUsed, note: noteFor(undefined, path) };
      }
      for (const gc of child.children ?? []) {
        if (gc.id === resolvedId) {
          const path = [page, node, child];
          return { target, path, confirmed: true, callsUsed, note: noteFor(undefined, path) };
        }
      }
    }
  }

  // Ranked by bbox area, ascending: a specific true container is always tried before a coincidental
  // giant that also contains the target's center (an unrelated page's mega-section, an overlay's
  // sibling section) — at EVERY level this decides candidate order, not just here at tier-0. Ties
  // (equal area) keep document order, same as before area-ranking existed.
  const containing0 = byAreaAscending(
    tier0.filter(({ node }) => containsCenter(node, center)),
    ({ node }) => areaOf(node),
  );
  if (containing0.length === 0) {
    return { target, path: [], confirmed: false, callsUsed, note: noteFor(NOTE_NO_CANDIDATE, []) };
  }

  // Recurse into an already-fetched node's subtree (its children AND their children — grandchildren
  // — are both known from one depth-2 fetch). `ancestors` is the confirmed path up to but NOT
  // including `fetched`.
  // `ceiling` is an ABSOLUTE callsUsed cap for this whole branch (not per-recursion-level) — the
  // per-branch budget cap from the top-level loop below, threaded unchanged through every nested
  // call so a park decision made deep in the recursion is measured against the same limit.
  async function descend(fetched: RawSceneNode, ancestors: RawSceneNode[], ceiling: number): Promise<DescendOutcome> {
    const ancestorsWithNode = [...ancestors, fetched];
    recordPath(ancestorsWithNode);

    const children = fetched.children ?? [];
    for (const child of children) {
      if (child.id === resolvedId) return { kind: 'confirmed', path: ancestorsWithNode };
    }
    for (const child of children) {
      for (const gc of child.children ?? []) {
        if (gc.id === resolvedId) return { kind: 'confirmed', path: [...ancestorsWithNode, child] };
      }
    }

    // Prefer the deepest already-known containing node: a containing grandchild doubles the
    // descent's reach per call (~21 levels instead of ~11 for the same budget) because the next
    // fetch is ON the grandchild — the intermediate child rides along for free, already known.
    const grandchildCandidates: { node: RawSceneNode; ancestorsForNext: RawSceneNode[] }[] = [];
    for (const child of children) {
      for (const gc of child.children ?? []) {
        if (containsCenter(gc, center)) {
          grandchildCandidates.push({ node: gc, ancestorsForNext: [...ancestorsWithNode, child] });
        }
      }
    }
    // The intermediate child (parent of a containing grandchild) is itself already known — its own
    // children (= these grandchildren) came from the SAME fetch — so it's a valid best-path tail
    // even if the budget runs out before we get to fetch the grandchild's own subtree.
    for (const gc of grandchildCandidates) recordPath(gc.ancestorsForNext);

    const childCandidates: { node: RawSceneNode; ancestorsForNext: RawSceneNode[] }[] = children
      .filter((c) => containsCenter(c, center))
      .map((c) => ({ node: c, ancestorsForNext: ancestorsWithNode }));

    // Grandchild-first (existing invariant — doubles reach per call), area-ascending WITHIN each
    // group (new — a specific small candidate beats a coincidental giant at every level, not just
    // tier-0).
    const candidates = [
      ...byAreaAscending(grandchildCandidates, (c) => areaOf(c.node)),
      ...byAreaAscending(childCandidates, (c) => areaOf(c.node)),
    ];
    if (candidates.length === 0) return { kind: 'dead' }; // containment chain breaks here

    for (const cand of candidates) {
      const cached = fetchedNodes.get(cand.node.id);
      if (cached) {
        // Already fetched (this call, an earlier branch, or an earlier round) — recurse into the
        // KNOWN data for free instead of skipping: a "parked" branch's cached prefix must still be
        // walked (not treated as a dead end) so the next round resumes exactly where it left off.
        const outcome = await descend(cached, cand.ancestorsForNext, ceiling);
        if (outcome.kind === 'dead') continue; // that subtree really is fully explored and dead
        return outcome; // confirmed, stop, or parked all bubble up immediately
      }
      if (failedIds.has(cand.node.id)) continue; // fetch already tried and failed — no data to recurse into, never retried
      const reason = stopReason();
      if (reason) return { kind: 'stop', note: reason === 'time' ? NOTE_BUDGET_TIME : NOTE_BUDGET_CALLS };
      if (callsUsed >= ceiling) return { kind: 'parked' }; // this branch's fair share is spent — let a sibling branch go next
      const sub = await fetchNode(cand.node.id);
      if (!sub) continue; // no data back / branch unavailable — treat this lead as dead, try the next candidate
      const outcome = await descend(sub, cand.ancestorsForNext, ceiling);
      if (outcome.kind === 'dead') continue; // backtrack, try the next candidate at this level
      return outcome; // confirmed, stop, or parked all bubble up immediately
    }
    return { kind: 'dead' };
  }

  // Probe-first: fetch EVERY containing tier-0 candidate at depth 2 before recursing into ANY of
  // them (one call each). This guarantees a shallow real match under a later candidate is found
  // within `containing0.length` calls regardless of how deep an earlier candidate's subtree looks —
  // a deep false branch under the first page can never eat the whole budget before a later page (or
  // sibling) is even glanced at.
  const probed: { page: RawSceneNode; doc?: RawSceneNode }[] = [];
  for (const { node, page } of containing0) {
    if (fetchedNodes.has(node.id) || failedIds.has(node.id)) continue; // same id already probed — no re-fetch
    const reason = stopReason();
    if (reason) return stopResult(reason);
    const doc = await fetchNode(node.id);
    probed.push({ page, doc });
    if (!doc) continue; // no data / branch unavailable — the sibling candidates still get probed
    recordPath([page, doc]);
    const kids = doc.children ?? [];
    for (const k of kids) {
      if (k.id === resolvedId) {
        return { target, path: [page, doc], confirmed: true, callsUsed, note: noteFor(undefined, [page, doc]) };
      }
    }
    for (const k of kids) {
      for (const gc of k.children ?? []) {
        if (gc.id === resolvedId) {
          const path = [page, doc, k];
          return { target, path, confirmed: true, callsUsed, note: noteFor(undefined, path) };
        }
      }
    }
  }

  // How tightly a probed tier-0 branch CONVERGES toward the target: the smallest bbox area among the
  // containing children/grandchildren its depth-2 probe revealed, falling back to the node's own area
  // if nothing tighter contains the center. The true branch shrinks toward the target (a narrow
  // content/points node) while a wide collision branch stays huge, so this ranks the converging
  // branch first — WITHOUT touching grandchild-stepping or the per-branch caps. Equal keys tie and
  // keep document order (stable sort), so equal-area fixtures are unaffected.
  function convergenceKey(node: RawSceneNode): number {
    let tightest = areaOf(node);
    for (const child of node.children ?? []) {
      if (containsCenter(child, center)) tightest = Math.min(tightest, areaOf(child));
      for (const gc of child.children ?? []) {
        if (containsCenter(gc, center)) tightest = Math.min(tightest, areaOf(gc));
      }
    }
    return tightest;
  }

  // Descend into each probed candidate (already fetched — no extra call to "enter" it), in CONVERGENCE
  // order (tightest-converging branch first, set below): two giant sections (an overlay's true section
  // and an unrelated page's) are indistinguishable by their OWN area, but their probed descendants are
  // not — the true branch's shrink toward the target. This is what makes a time-abort record the
  // converging branch instead of a wide collision branch. Per-branch budget cap: no single branch may
  // spend the ENTIRE remaining budget while sibling branches are still unexplored — that is exactly how
  // an overlay's false-giant branch used to eat all 12 calls before a tiny true section five levels
  // down ever got a look. Each branch's cap is recomputed from the CURRENT remaining budget and the
  // count of branches not yet given a turn THIS round, so a branch that dies (or confirms) early
  // automatically returns its unspent share to the pool for the next branch — no separate bookkeeping
  // needed. A branch that hits its cap is "parked" (its lead is still live, not dead) and revisited in
  // a later round with a fresh, larger cap; fetchedIds-dedupe makes re-walking its already-fetched
  // prefix free, so a plain restart from the branch root (not a precise resume point) is sufficient.
  const MIN_BRANCH_CAP = 2;
  let pending = byAreaAscending(
    probed.filter((p): p is { page: RawSceneNode; doc: RawSceneNode } => !!p.doc),
    (p) => convergenceKey(p.doc),
  );
  while (pending.length > 0) {
    const stillPending: typeof pending = [];
    let roundProgress = 0;
    for (let i = 0; i < pending.length; i++) {
      const { page, doc } = pending[i];
      const remaining = maxCalls - callsUsed;
      const branchesLeft = pending.length - i;
      const ceiling = callsUsed + Math.max(MIN_BRANCH_CAP, Math.floor(remaining / branchesLeft));
      const callsBefore = callsUsed;
      const outcome = await descend(doc, [page], ceiling);
      roundProgress += callsUsed - callsBefore;
      if (outcome.kind === 'confirmed') {
        return { target, path: outcome.path, confirmed: true, callsUsed, note: noteFor(undefined, outcome.path) };
      }
      if (outcome.kind === 'stop') {
        return { target, path: bestPath, confirmed: false, callsUsed, note: noteFor(outcome.note, bestPath) };
      }
      if (outcome.kind === 'parked') stillPending.push({ page, doc });
      // 'dead' -> this branch is fully explored and contains no lead; drop it
    }
    if (stillPending.length === 0) break; // every branch resolved (all dead — handled below)
    if (roundProgress === 0) {
      // Defensive: some branches remain parked yet nothing was spent trying them this round — an
      // honest budget note, not a false claim that containment broke.
      return { target, path: bestPath, confirmed: false, callsUsed, note: noteFor(NOTE_BUDGET_CALLS, bestPath) };
    }
    pending = stillPending;
  }

  // Every branch exhausted while the budget was still alive: the containment chain genuinely broke.
  return { target, path: bestPath, confirmed: false, callsUsed, note: noteFor(NOTE_CHAIN_BROKE, bestPath) };
}
