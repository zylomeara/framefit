import { z } from 'zod';
import type { DomSnapshotStore } from '../../../infrastructure/dom-snapshot-store.js';

// Inner reference shape shared by compare_node_to_dom (per-pair) and suggest_pairs
// (top-level). Each tool applies `.optional().describe(<tool-specific text>)` on top;
// the object + selector|index XOR live here so the wire contract stays identical across
// the two-step flow (suggest_pairs → compare). Typed object, NOT z.unknown().
export const DomRefSchema = z.object({
  ref: z.string().min(1),
  selector: z.string().min(1).optional(),
  index: z.number().int().min(0).optional().describe(
    'Positional index into the uploaded batch (order of the selectors array returned by the extractor POST) ' +
    'instead of matching by selector string. Safe on duplicate selectors (e.g. repeated list-item classes), ' +
    'where selector-matching would silently resolve to the FIRST matching snapshot. Pass exactly one of ' +
    'selector | index.',
  ),
}).superRefine((d, ctx) => {
  if ((d.selector === undefined) === (d.index === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'dom_ref: pass exactly one of selector | index' });
  }
});

// Resolve a live dom_ref to its stored snapshot. `store` MUST be defined — the caller
// keeps its own store-undefined guard, because that error text names the caller's inline
// field (compare: "dom", suggest_pairs: "dom_snapshot"). Note strings here are copied
// verbatim from the pre-refactor compare handler so compare's output stays byte-identical.
export function resolveDomRef(
  domRef: { ref: string; selector?: string; index?: number },
  store: DomSnapshotStore,
  owner: string,
): { ok: true; snapshot: unknown } | { ok: false; note: string } {
  const resolved = domRef.index !== undefined
    ? store.resolveByIndex(domRef.ref, domRef.index, owner)
    : store.resolve(domRef.ref, domRef.selector!, owner);
  if (resolved.ok) return { ok: true, snapshot: resolved.snapshot };
  if (resolved.reason === 'unknown_selector') {
    return {
      ok: false,
      note: domRef.index !== undefined
        ? `index ${domRef.index} out of range — available 0..${resolved.selectors.length - 1} (selectors: [${resolved.selectors.join(', ')}])`
        : 'selector not found in snapshot_ref — the key must match byte-for-byte the ' +
          `string passed to the extractor; in ref: [${resolved.selectors.join(', ')}]`,
    };
  }
  // 'unknown_ref' | 'expired' | 'owner_mismatch' — owner_mismatch masked under the same
  // honest text as unknown_ref (we don't leak the existence of another owner's ref).
  return {
    ok: false,
    note: 'snapshot ref expired/unknown — re-run the extractor; if upload_url is also stale (404) — get_layout_spec {include_extractor:true} again',
  };
}
