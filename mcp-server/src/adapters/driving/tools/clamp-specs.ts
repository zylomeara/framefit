import { serializeForDelivery } from './serialize.js';

// Aggregate honest-clamp for get_layout_spec's specs[] result. Per-spec node-budget
// (projector pruneToBudget, ≤180 nodes) already bounds a SINGLE spec (~180-360KB); this
// static backstop bounds the AGGREGATE when many node_ids are requested together, so the
// tool never emits a multi-MB blob over the MCP wire. Honest, not silent: the caller gets
// the prefix that fits + an explicit list of omitted node_ids to re-request.
//
// Measures the DELIVERED serialization via serializeForDelivery (the same function jsonResult
// emits), so the guard's byte count always matches what actually reaches the consumer — it can
// never drift from delivery again. Default delivery is compact, so this measures
// compact; if MCP_PRETTY_JSON=true, both delivery and this measurement become pretty in lockstep.
// Under compact delivery the aggregate stays small (~0.87MB for the 20×180-node input ceiling),
// so this 1MB budget is a rarely-firing backstop — compact delivery, not clamping, is the real
// context-pressure fix; the backstop still fires on a genuinely huge (>~4000-node) payload.
export const RESULT_BUDGET_BYTES = 1024 * 1024; // 1MB serialized aggregate (delivered bytes)

export interface SpecEntry {
  node_id: string;
  spec?: unknown;
  text_leaves?: unknown;
  text_leaves_truncated?: boolean;
  error?: string;
}

// Prefix-keep / suffix-omit by input order: keep whole specs while they fit; once one
// doesn't, omit it and every following node_id (contiguous suffix — a caller re-requesting
// the omitted tail gets a clean continuation). Never shallows a tree (no corruption) and
// always keeps ≥1 entry (a lone over-budget spec is emitted + flagged, never dropped to nothing).
export function clampSpecsToBudget(
  specs: SpecEntry[],
  budgetBytes: number,
): { kept: SpecEntry[]; omitted: string[] } {
  const kept: SpecEntry[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const entry of specs) {
    if (omitted.length > 0) {
      omitted.push(entry.node_id);
      continue;
    }
    const size = serializeForDelivery(entry).length;
    if (kept.length === 0 || used + size <= budgetBytes) {
      kept.push(entry);
      used += size;
    } else {
      omitted.push(entry.node_id);
    }
  }
  return { kept, omitted };
}
