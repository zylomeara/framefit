// mcp-server/src/domain/design-context/resolved-token.ts
export type EffectiveModeSource =
  | 'explicit_node'
  | 'ancestor_chain'
  | 'confirmed_default'
  | 'unverifiable';

export interface EffectiveModeAxis {
  mode: string;
  source: EffectiveModeSource;
  node_id?: string;
}

export interface ResolvedToken {
  token?: string;
  value: string | number | boolean | null;
  default_value?: string | number | boolean;
  effective_rendered_value?: string | number | boolean | null;
  effective_modes?: Record<string, EffectiveModeAxis>;
  effective_mode_source?: EffectiveModeSource;
  mode_dependent?: boolean;
  cssVar?: string;
  hint?: string;
}

/** One multi-mode axis used while resolving a value. `key` identifies the collection for
 * de-dup (graph: fileKey|libKey; local: collectionId); source records whether the selected mode
 * came from the target node, its ancestor chain, a proven default, or incomplete evidence. */
export interface AppliedMode {
  key: string;
  collection: string;
  mode: string;
  source: EffectiveModeSource;
  nodeId?: string;
}

/** Record a pick unless its collection key was already recorded — resolution walks from the
 * token outward, so first-seen = nearest the token, and it wins. No-op without a sink. */
export function recordApplied(applied: AppliedMode[] | undefined, entry: AppliedMode): void {
  if (!applied) return;
  if (applied.some((a) => a.key === entry.key)) return;
  applied.push(entry);
}

/** Fold applied picks into the emitted evidence map. Empty names are skipped; if two different
 * collections share a display name, the first axis encountered wins. */
export function formatEffectiveModes(
  applied: AppliedMode[] | undefined,
): Record<string, EffectiveModeAxis> | undefined {
  if (!applied || applied.length === 0) return undefined;
  const out: Record<string, EffectiveModeAxis> = {};
  for (const a of applied) {
    if (!a.collection || !a.mode || a.collection in out) continue;
    out[a.collection] = {
      mode: a.mode,
      source: a.source,
      ...(a.nodeId !== undefined ? { node_id: a.nodeId } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function compositeModeSource(
  axes: Record<string, EffectiveModeAxis>,
): EffectiveModeSource {
  const sources = Object.values(axes).map((axis) => axis.source);
  if (sources.includes('unverifiable')) return 'unverifiable';
  if (sources.includes('ancestor_chain')) return 'ancestor_chain';
  if (sources.includes('explicit_node')) return 'explicit_node';
  return 'confirmed_default';
}
