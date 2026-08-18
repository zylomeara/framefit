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

/** Fold applied picks into the emitted evidence map without losing an axis. Ordinary unique
 * collection names remain byte-compatible. Duplicate names use the deterministic ASCII suffix
 * " [2]", " [3]", ...; an empty display name uses "[unnamed]". Generated labels never take a
 * label that another collection actually owns. A null-prototype record keeps prototype-key names
 * such as "constructor" and "toString" ordinary own keys. */
export function formatEffectiveModes(
  applied: readonly AppliedMode[] | undefined,
): Record<string, EffectiveModeAxis> | undefined {
  if (!applied || applied.length === 0) return undefined;
  const out = Object.create(null) as Record<string, EffectiveModeAxis>;
  const used = new Set<string>();
  const reserved = new Set(applied.map((axis) => axis.collection).filter((name) => name.length > 0));
  for (const a of applied) {
    const base = a.collection || '[unnamed]';
    let label = base;
    if (used.has(label) || (a.collection.length === 0 && reserved.has(label))) {
      let suffix = 2;
      do label = `${base} [${suffix++}]`;
      while (used.has(label) || reserved.has(label));
    }
    used.add(label);
    out[label] = {
      mode: a.mode,
      source: a.source,
      ...(a.nodeId !== undefined ? { node_id: a.nodeId } : {}),
    };
  }
  return out;
}

export function compositeModeSource(applied: readonly AppliedMode[]): EffectiveModeSource;
export function compositeModeSource(axes: Record<string, EffectiveModeAxis>): EffectiveModeSource;
export function compositeModeSource(
  input: readonly AppliedMode[] | Record<string, EffectiveModeAxis>,
): EffectiveModeSource {
  // Resolvers pass AppliedMode[] so their safety decision precedes presentation. The record form
  // remains supported for callers of the previously exported formatter-level helper.
  const sources = Array.isArray(input)
    ? (input as readonly AppliedMode[]).map((axis) => axis.source)
    : Object.values(input as Record<string, EffectiveModeAxis>).map((axis) => axis.source);
  if (sources.includes('unverifiable')) return 'unverifiable';
  if (sources.includes('ancestor_chain')) return 'ancestor_chain';
  if (sources.includes('explicit_node')) return 'explicit_node';
  return 'confirmed_default';
}
