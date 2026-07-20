// mcp-server/src/domain/variable-snapshot.ts
// Snapshot entries uploaded by the plugin: a library variable's published key (the
// 40-hex `key` that matches library↔consumer) → its resolved default value. The
// consumer's alias_of carries this key, so it is the join key. Pure normalization.
export interface SnapshotEntry {
  key: string;            // the variable's 40-hex published key (the join key)
  value: string;          // resolved: "#rrggbb(aa)" | number-as-string | string
  resolved_type: string;  // COLOR | FLOAT | STRING | BOOLEAN
  name: string;
}

/** The 40-hex published key embedded in a cross-library alias id ("VariableID:<key>/<exportId>"), or null.
 * Figma published keys are exactly 40 lowercase hex chars; enforce that so a malformed
 * id fails closed (→ null) instead of silently yielding a wrong key. */
export function extractLibraryKey(aliasId: string): string | null {
  // Figma published keys are 40 hex chars. A consumer alias id may surface upper- or
  // lower-case; the snapshot/graph join key is always lower-case, so normalise here.
  // Previously an uppercase id failed [0-9a-f] → null → the alias silently dropped out
  // of cross-library resolution and the token came back value:null (looked "missing").
  const m = /^VariableID:([0-9a-fA-F]{40})\//.exec(aliasId);
  return m ? m[1].toLowerCase() : null;
}

export function normalizeEntries(raw: unknown[]): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const e = r as Record<string, unknown>;
    if (typeof e.key !== 'string' || !e.key) continue;
    if (e.value === undefined || e.value === null) continue;
    out.push({
      key: (e.key as string).toLowerCase(),
      value: String(e.value),
      resolved_type: typeof e.resolved_type === 'string' ? e.resolved_type : '',
      name: typeof e.name === 'string' ? e.name : '',
    });
  }
  return out;
}
