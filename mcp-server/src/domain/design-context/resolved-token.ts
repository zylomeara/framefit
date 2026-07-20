// mcp-server/src/domain/design-context/resolved-token.ts
export interface ResolvedToken {
  token?: string;                        // variable name; absent for cross-lib snapshot without a name
  value: string | number | boolean;      // actual value in the node's effective mode (COLOR -> hex)
  mode?: string;                          // effective mode NAME (only for multi-mode collections)
  mode_dependent?: boolean;               // true when the collection has >1 mode
  mode_source?: 'node' | 'default';       // 'node' = confirmed node mode; 'default' = fallback
  /** {collection name -> "<mode name> (node|default)"} — every multi-mode axis actually APPLIED
   * while computing `value` (top collection + each cross-collection hop). Present ONLY when >=2
   * DISTINCT multi-mode collections participated. Explains the computation; makes NO on-screen
   * claim (that is mode_source's job). Names are verbatim Figma names. */
  modes_applied?: Record<string, string>;
  cssVar?: string;                        // optional "var(--name, value)"
  hint?: string;                          // presentation-only pointer (e.g. see get_variables on 'default')
}

/** One mode pick actually APPLIED while resolving a value. `key` identifies the collection for
 * de-dup (graph: fileKey|libKey; local: collectionId); `source` reuses mode_source vocabulary
 * per axis: 'node' = stack-confirmed (pinned via explicitVariableModes on self/an ancestor),
 * 'default' = the collection's default mode was used (incl. invalid-explicit fallback). */
export interface AppliedMode { key: string; collection: string; mode: string; source: 'node' | 'default' }

/** Record a pick unless its collection key was already recorded — resolution walks from the
 * token outward, so first-seen = nearest the token, and it wins. No-op without a sink. */
export function recordApplied(applied: AppliedMode[] | undefined, entry: AppliedMode): void {
  if (!applied) return;
  if (applied.some((a) => a.key === entry.key)) return;
  applied.push(entry);
}

/** Fold applied picks into the emitted modes_applied map, enforcing the contract: (a) >=2
 * distinct multi-mode axes, else undefined; (b) any axis with an unknown (empty) collection or
 * mode name -> undefined, the WHOLE field is omitted (explainability-only, absence is safe —
 * pre-resync graph rows have no names); (c) two DIFFERENT collections sharing a display name:
 * first-seen wins, and the >=2 gate is re-checked on the folded keys. */
export function formatModesApplied(applied: AppliedMode[] | undefined): Record<string, string> | undefined {
  if (!applied || applied.length < 2) return undefined;
  if (applied.some((a) => !a.collection || !a.mode)) return undefined;
  const out: Record<string, string> = {};
  for (const a of applied) if (!(a.collection in out)) out[a.collection] = `${a.mode} (${a.source})`;
  return Object.keys(out).length >= 2 ? out : undefined;
}
