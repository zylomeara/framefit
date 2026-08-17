// The ONE mode-aware color-token resolver, shared by compare_node_to_dom and get_layout_spec.
// Extracted as a FACTORY rather than a copied closure: the resolver is safe only together with
// its preconditions — `await deps.variableGraph?.ensureReady?.()` before the first graph read
// (get-comments-tool.ts ToolDeps contract), and a snapshot prefetch that keeps the
// snapHits ⊆ graph-misses invariant (prefetchSnapshotHits below) — so the pieces live in one
// module and a second consumer cannot get half of them right. The two tools feed it DIFFERENT
// mode stacks (compare discovers ancestors; get_layout_spec folds the fetched subtree only,
// coverageComplete=false) — same resolver, same name, but effective evidence may honestly differ:
// that asymmetry is documented at both tools and pinned by a cross-tool fixture.
import type { RawSceneNode } from '../../../domain/figma-raw.js';
import { colorAliasId } from '../../../domain/figma-raw.js';
import type { ResolvedColorToken } from '../../../domain/layout-spec/types.js';
import { resolveBoundVariableInMode, resolveAllModes, type VariableIndex } from '../../../domain/variables.js';
import { collectExternalPaintKeys, type ModeEvidenceStack } from '../../../domain/mode-resolve.js';
import { extractLibraryKey } from '../../../domain/variable-snapshot.js';
import type { ToolDeps } from './get-comments-tool.js';

// Latency: /variables/local on a giant file can HANG (measured ~90s) — a short cap bounds the
// wait. compare applies it MT-only (single-tenant compare has no fallback, a false-cut there
// would lose ALL token rows); get_layout_spec applies it ALWAYS (navigation hot path — a bounded
// miss with a degraded_stages receipt beats a 90s stall). One constant so the negative-cache
// entries the two tools write are keyed by the SAME capMs and serve each other, never poison.
export const VARIABLES_FETCH_CAP_MS = 20_000;

export interface ColorResolverEnv {
  variableIndex?: VariableIndex;
  snapHits?: Map<string, { value: unknown; name?: string }>;
  variableGraph?: ToolDeps['variableGraph'];
  /** exact-id mode stack for the local-index resolver (subtree ∪ discovered ancestors). */
  stackFor(n: RawSceneNode): Map<string, string>;
  /** library-key-folded stack for the graph resolver (buildModeByCollection semantics). */
  graphStackFor(n: RawSceneNode): Map<string, string>;
  exactEvidenceFor(n: RawSceneNode): ModeEvidenceStack;
  graphEvidenceFor(n: RawSceneNode): ModeEvidenceStack;
  coverageComplete: boolean;
  /** get_layout_spec: drop all_modes from the emitted token — it is compare's confirm/mode-mismatch
   * payload, and the navigation response runs ~13% under its 1MB budget without it. */
  omitAllModes?: boolean;
}

export function makeColorTokenResolver(env: ColorResolverEnv) {
  return (n: RawSceneNode, key: 'fills' | 'strokes'): ResolvedColorToken | undefined => {
    // BOTH binding forms via the shared lookup (paint-level of the measured paint, else
    // node-level boundVariables[key]) — a paint-only read here is how a node-level-bound fill
    // once reached the verdict as a raw literal and FAILED over correct code (feedback 15.1).
    const aliasId = colorAliasId(n, key);
    if (!aliasId) return undefined;
    if (env.variableIndex) {
      const bv = { [key]: { type: 'VARIABLE_ALIAS' as const, id: aliasId } };
      const r = resolveBoundVariableInMode(
        bv, key, env.variableIndex, env.stackFor(n), env.coverageComplete, env.exactEvidenceFor(n),
      );
      // Honest degradation: need a resolved hex string AND a token name to compare against —
      // a nameless cross-lib snapshot value (ResolvedToken.token undefined) can't anchor a
      // token row, so surface no token (row → unknown) rather than an empty-named one.
      if (r && r.token !== undefined && (typeof r.value === 'string' || r.value === null)) {
        const v = env.variableIndex.byId.get(aliasId);
        const all = !env.omitAllModes && v ? resolveAllModes(v, env.variableIndex) : null;
        const all_modes = all
          ? Object.fromEntries(Object.entries(all.modes).filter(([, x]) => typeof x === 'string')) as Record<string, string>
          : undefined;
        return {
          token: r.token,
          ...(typeof r.default_value === 'string' ? { defaultHex: r.default_value } : {}),
          effectiveHex: typeof r.effective_rendered_value === 'string'
            ? r.effective_rendered_value
            : r.effective_rendered_value === null ? null : r.value,
          ...(r.effective_modes ? { effectiveModes: r.effective_modes } : {}),
          ...(r.effective_mode_source ? { effectiveModeSource: r.effective_mode_source } : {}),
          ...(all_modes ? { all_modes } : {}),
        };
      }
      // local miss (byId miss / unresolved value / nameless token) — fall through to the
      // shared graph/snapshot tail below rather than returning here (an
      // index-present file can STILL hold a cross-library binding the local index can't name).
    }
    // Shared fallback tail (no index at all, OR a local byId miss above): graph (sync) →
    // snapshot (prefetched) → honest unknown. A local (non-published) id has no
    // library key at all — extractLibraryKey rejects it — so it can never rescue a byId miss
    // (A2: stays an honest unknown, never silently retried against the wrong resolver).
    const libKey = extractLibraryKey(aliasId);
    if (libKey === null) return undefined;
    const g = env.variableGraph?.resolveInMode?.(
      libKey, env.graphStackFor(n), env.coverageComplete, env.graphEvidenceFor(n),
    );
    if (g && (typeof g.value === 'string' || g.value === null)) {
      const all = !env.omitAllModes ? env.variableGraph?.resolve(libKey)?.modesByName : undefined; // all_modes symmetry with the local-index path
      return {
        // `||`, not `??`: the graph/snapshot name columns are NOT NULL DEFAULT '' — an empty
        // string is the real "unnamed" shape, and an empty-named token degrades confirm_token
        // grouping (verification keys on truthy r.token).
        token: g.token || libKey,
        ...(typeof g.default_value === 'string' ? { defaultHex: g.default_value } : {}),
        effectiveHex: typeof g.effective_rendered_value === 'string'
          ? g.effective_rendered_value
          : g.effective_rendered_value === null ? null : g.value,
        ...(g.effective_modes ? { effectiveModes: g.effective_modes } : {}),
        ...(g.effective_mode_source ? { effectiveModeSource: g.effective_mode_source } : {}),
        ...(all ? { all_modes: all } : {}),
      };
    }
    const s = env.snapHits?.get(libKey);
    if (s && typeof s.value === 'string') {
      // snapshot_default: mode-BLIND (the plugin upload has no ancestor-mode context) — gate
      // B in diff.ts must attribute this to "resolved from a snapshot", never mis-attribute
      // it to "an unconfirmed ancestor pin".
      return {
        token: s.name || libKey,
        defaultHex: s.value,
        effectiveHex: null,
        effectiveModeSource: 'unverifiable',
        snapshot_default: true,
      }; // `||`: name is '' when unnamed, never null
    }
    return undefined; // honest unknown — neither index, graph, nor snapshot could resolve this alias
  };
}

/**
 * Snapshot prefetch with its invariants built in, not commented on:
 * (1) gated to index-less resolution — when variableIndex IS present the local resolver covers
 *     everything the index knows and the sync graph handles the cross-lib residual, so the async
 *     snapshot half only pays for itself when there is NO index at all;
 * (2) snapHits ⊆ graph-misses — the graph-before-snapshot order in the resolver tail is neutral
 *     ONLY while this filter stands; prefetch every key and the mode-blind snapshot would shadow
 *     the mode-aware graph.
 * The caller wraps this in its own try/catch (rate_limited rethrows; anything else degrades to
 * undefined snapHits — rows read honest unknown).
 */
export async function prefetchSnapshotHits(
  deps: Pick<ToolDeps, 'variableGraph' | 'variableSnapshot'>,
  variableIndex: VariableIndex | undefined,
  documents: (RawSceneNode | undefined)[],
): Promise<Map<string, { value: unknown; name?: string }> | undefined> {
  if (variableIndex !== undefined) return undefined;
  if (deps.variableGraph === undefined && deps.variableSnapshot === undefined) return undefined;
  const keys = [...new Set(documents.flatMap((doc) => (doc ? [...collectExternalPaintKeys(doc)] : [])))];
  const missed = keys.filter((k) => deps.variableGraph?.resolve(k) === undefined);
  if (missed.length && deps.variableSnapshot) return deps.variableSnapshot.lookup(missed);
  return undefined;
}

// ── Merged codeSyntax evidence: local index + scoped graph view (graph-css-evidence line) ────
// The gate rule (diff.ts D-branch) is frozen; this facade only widens WHAT the evidence can
// answer. Panel-locked invariants, each load-bearing:
//  - canon() at EVERY edge: the gate hands us RAW ids (spec.fillBoundVar verbatim from the
//    projector); a cross-library binding is the slash-form published id whose canonical form is
//    'key:<40hex lower>'. Local ids stay RAW (they cannot collide with the key: form, and the
//    0.22.0 local-only path stays byte-identical at the frozen !==). Canonical ids only LEAVE
//    the facade (via idsByName).
//  - NO graph-only evidence: the facade requires the local index. Uniqueness over a partial
//    population is not uniqueness, and the failed-fetch state is where we know least.
//  - TRI-STATE relatedness: aliasRelated answers false ("safe to gate") only when EVERY walk
//    direction terminated over a fully-visible chain. A hole (published-only projection drops
//    keyless variables; a graph half that exists but was not wired) or an exhausted budget is
//    "cannot exclude" -> true. The positive-collision gate never fires on an unwalked chain.
//  - One direction bridges: a LOCAL variable can alias INTO a library (published id); a library
//    variable cannot alias into the consumer's file - the graph->local direction contributes
//    'unrelated' without unknown-ness by construction.
import { extractLibraryKey as extractLibKeyForCanon } from '../../../domain/variable-snapshot.js';
import type { GraphCssView } from '../../../domain/variable-graph.js';
import { buildCssEvidence, type CssTokenEvidence } from '../../../domain/variables.js';

const canonEvidenceId = (id: string): string => {
  const k = extractLibKeyForCanon(id);
  return k !== null ? 'key:' + k : id;
};
const MERGED_WALK_CAP = 24;

export function buildMergedCssEvidence(idx: VariableIndex, graphView?: GraphCssView): CssTokenEvidence {
  const local = buildCssEvidence(idx);

  type Tri = 'related' | 'unrelated' | 'unknown';
  const walkOne = (fromC: string, toC: string): Tri => {
    if (fromC === toC) return 'related';
    const toKey = toC.startsWith('key:') ? toC.slice(4) : undefined;
    if (fromC.startsWith('key:')) {
      if (toKey === undefined) return 'unrelated';           // graph->local is inexpressible
      if (!graphView) return 'unknown';                      // a cross-boundary edge with no graph half
      return graphView.aliasWalk(fromC.slice(4), toKey, MERGED_WALK_CAP);
    }
    // Local BFS across ALL modes; published alias ids hop toward the graph half. ONE budget
    // spans both halves (v2 addendum #1): the graph continuations receive the REMAINDER of the
    // local walk's levels, never a fresh cap - an 8+14-style reset at the boundary would make
    // the effective bound a lie.
    let sawHole = false;
    const seen = new Set<string>();
    const graphStarts = new Set<string>();
    let frontier = [fromC];
    let levelsUsed = 0;
    for (; levelsUsed < MERGED_WALK_CAP && frontier.length; levelsUsed++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const v = idx.byId.get(id);
        if (!v) { sawHole = true; continue; }
        for (const val of Object.values(v.valuesByMode)) {
          const alias = val as { type?: string; id?: string };
          if (alias?.type !== 'VARIABLE_ALIAS' || typeof alias.id !== 'string') continue;
          const c = canonEvidenceId(alias.id);
          if (c === toC) return 'related';
          if (c.startsWith('key:')) { if (toKey !== undefined) graphStarts.add(c.slice(4)); }
          else next.push(c);
        }
      }
      frontier = next;
    }
    if (frontier.length) sawHole = true;
    // ONE budget across BOTH halves AND across all continuations: the remainder is DIVIDED
    // among the graph entry points (the house pattern - node-ancestry's remaining/branchesLeft),
    // so total graph work is bounded by the remainder, not multiplied by the crossing count.
    // A zero share is an exhausted budget -> unknown, never a silent skip.
    const remaining = MERGED_WALK_CAP - levelsUsed;
    const share = graphStarts.size ? Math.floor(remaining / graphStarts.size) : 0;
    for (const start of graphStarts) {
      if (!graphView) { sawHole = true; break; }
      if (share <= 0) { sawHole = true; break; }
      const r = graphView.aliasWalk(start, toKey!, share);
      if (r === 'related') return 'related';
      if (r === 'unknown') sawHole = true;
    }
    return sawHole ? 'unknown' : 'unrelated';
  };

  // Bidirectional tri-state: related if EITHER direction proves it; unknown if neither proves
  // it and either direction hit a hole; unrelated only when BOTH directions walked clean.
  // Memoized per facade instance: the minter collapse is O(n^2) pairwise checks and the
  // D-branch re-asks the same pairs - one map turns the repeated walks into lookups.
  const biMemo = new Map<string, Tri>();
  const biWalk = (ca: string, cb: string): Tri => {
    const memoKey = ca < cb ? ca + '\u0000' + cb : cb + '\u0000' + ca;
    const hit = biMemo.get(memoKey);
    if (hit !== undefined) return hit;
    let out: Tri;
    const fwd = walkOne(ca, cb);
    if (fwd === 'related') out = 'related';
    else {
      const back = walkOne(cb, ca);
      out = back === 'related' ? 'related' : (fwd === 'unknown' || back === 'unknown' ? 'unknown' : 'unrelated');
    }
    biMemo.set(memoKey, out);
    return out;
  };


  return {
    nameOf: (id) => {
      const c = canonEvidenceId(id);
      return c.startsWith('key:') ? graphView?.authoredNameOf(c.slice(4)) : local.nameOf(id);
    },
    idsByName: (cssName) => {
      // RAW deduped minters, canonical ids - NO collapse, NO representative: the delta wave
      // proved any collapse-and-pick makes the verdict order-dependent (pairwise relatedness is
      // not transitive). The D-branch quantifies over ALL minters relative to the bound side.
      const merged = [...local.idsByName(cssName), ...(graphView?.idsByCssName(cssName) ?? []).map((k) => 'key:' + k.toLowerCase())];
      return [...new Set(merged)];
    },
    aliasRelation: (a, b) => biWalk(canonEvidenceId(a), canonEvidenceId(b)),
  };
}
