// The ONE mode-aware color-token resolver, shared by compare_node_to_dom and get_layout_spec.
// Extracted as a FACTORY rather than a copied closure: the resolver is safe only together with
// its preconditions — `await deps.variableGraph?.ensureReady?.()` before the first graph read
// (get-comments-tool.ts ToolDeps contract), and a snapshot prefetch that keeps the
// snapHits ⊆ graph-misses invariant (prefetchSnapshotHits below) — so the pieces live in one
// module and a second consumer cannot get half of them right. The two tools feed it DIFFERENT
// mode stacks (compare discovers ancestors; get_layout_spec folds the fetched subtree only,
// coverageComplete=false) — same resolver, same NAME, but mode_source may honestly differ:
// that asymmetry is documented at both tools and pinned by a cross-tool fixture.
import type { RawSceneNode } from '../../../domain/figma-raw.js';
import { colorAliasId } from '../../../domain/figma-raw.js';
import type { ResolvedColorToken } from '../../../domain/layout-spec/types.js';
import { resolveBoundVariableInMode, resolveAllModes, type VariableIndex } from '../../../domain/variables.js';
import { collectExternalPaintKeys } from '../../../domain/mode-resolve.js';
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
      const r = resolveBoundVariableInMode(bv, key, env.variableIndex, env.stackFor(n), env.coverageComplete);
      // Honest degradation: need a resolved hex string AND a token name to compare against —
      // a nameless cross-lib snapshot value (ResolvedToken.token undefined) can't anchor a
      // token row, so surface no token (row → unknown) rather than an empty-named one.
      if (r && typeof r.value === 'string' && r.token !== undefined) {
        const v = env.variableIndex.byId.get(aliasId);
        const all = !env.omitAllModes && v ? resolveAllModes(v, env.variableIndex) : null;
        const all_modes = all
          ? Object.fromEntries(Object.entries(all.modes).filter(([, x]) => typeof x === 'string')) as Record<string, string>
          : undefined;
        return {
          token: r.token, hex: r.value,
          ...(r.mode ? { mode: r.mode } : {}),
          ...(r.mode_dependent ? { mode_dependent: true } : {}),
          ...(r.mode_source ? { mode_source: r.mode_source } : {}),
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
    const g = env.variableGraph?.resolveInMode?.(libKey, env.graphStackFor(n), env.coverageComplete);
    if (g && typeof g.value === 'string') {
      const all = !env.omitAllModes ? env.variableGraph?.resolve(libKey)?.modesByName : undefined; // all_modes symmetry with the local-index path
      return {
        token: g.token ?? libKey, hex: g.value,
        ...(g.mode ? { mode: g.mode } : {}),
        ...(g.mode_dependent ? { mode_dependent: true } : {}),
        mode_source: g.mode_source,
        ...(all ? { all_modes: all } : {}),
      };
    }
    const s = env.snapHits?.get(libKey);
    if (s && typeof s.value === 'string') {
      // snapshot_default: mode-BLIND (the plugin upload has no ancestor-mode context) — gate
      // B in diff.ts must attribute this to "resolved from a snapshot", never mis-attribute
      // it to "an unconfirmed ancestor pin".
      return { token: s.name ?? libKey, hex: s.value, mode_dependent: true, mode_source: 'default', snapshot_default: true };
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
