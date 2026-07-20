// mcp-server/src/domain/variables-summary.ts
// Summary statistics and filtering helpers for the get_variables tool.
export type { Token } from './variables.js';
import type { Token } from './variables.js';

export interface VariablesSummary {
  total: number;
  resolved_via: { local: number; graph: number; snapshot: number };
  unresolved: number;
  by_type: Record<string, number>;
}

export function summarizeTokens(tokens: Token[]): VariablesSummary {
  const summary: VariablesSummary = {
    total: tokens.length,
    resolved_via: { local: 0, graph: 0, snapshot: 0 },
    unresolved: 0,
    by_type: {},
  };
  for (const t of tokens) {
    // unresolved: alias flag set and value is null
    if (t.alias && t.value === null) {
      summary.unresolved++;
    } else if (t.resolved_via === 'graph') {
      summary.resolved_via.graph++;
    } else if (t.resolved_via === 'snapshot') {
      summary.resolved_via.snapshot++;
    } else {
      summary.resolved_via.local++;
    }
    const typ = t.type as string;
    summary.by_type[typ] = (summary.by_type[typ] ?? 0) + 1;
  }
  return summary;
}

/** Collapse rows identical in (name, collection, value, type, modes) — cross-library publishing
 * produces duplicate rows; keep the first occurrence, preserving order. `modes` is part of the key
 * so tokens differing only by their per-mode values are NOT collapsed. */
export function dedupeTokens(tokens: Token[]): Token[] {
  const seen = new Set<string>();
  const out: Token[] = [];
  for (const t of tokens) {
    const key = `${t.name.toLowerCase()} ${t.collection.toLowerCase()} ${JSON.stringify(t.value)} ${t.type} ${JSON.stringify(t.modes ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Collapse case-variant collection names (e.g. "Theme" vs "theme") to one canonical display
 * spelling — the first seen — so the output never shows both for the same collection. */
export function canonicalizeCollections(tokens: Token[]): Token[] {
  const canonical = new Map<string, string>();
  for (const t of tokens) {
    const lc = t.collection.toLowerCase();
    if (!canonical.has(lc)) canonical.set(lc, t.collection);
  }
  return tokens.map((t) => {
    const disp = canonical.get(t.collection.toLowerCase());
    return disp && disp !== t.collection ? { ...t, collection: disp } : t;
  });
}

export interface TokenFilter {
  collection?: string;
  name?: string;
  type?: string;
  unresolved_only?: boolean;
}

export function filterTokens(tokens: Token[], filter: TokenFilter): Token[] {
  return tokens.filter((t) => {
    if (filter.collection !== undefined && !t.collection.toLowerCase().includes(filter.collection.toLowerCase())) return false;
    if (filter.name !== undefined && !t.name.toLowerCase().includes(filter.name.toLowerCase())) return false;
    if (filter.type !== undefined && t.type.toLowerCase() !== filter.type.toLowerCase()) return false;
    if (filter.unresolved_only && !(t.alias && t.value === null)) return false;
    return true;
  });
}
