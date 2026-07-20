// Single source of truth for how tool output is serialized onto the MCP wire.
// jsonResult (shared-error-handler.ts) emits this, and clampSpecsToBudget (clamp-specs.ts)
// MEASURES through this — so the delivered serialization and every size-guard's byte count
// can never drift (the anti-desync invariant; experience taught "measure the DELIVERED
// serialization" — delivery + measurement share ONE function so the invariant is structural,
// not a calibrated number).
//
// Default is COMPACT: indentation is pure context overhead for the AI consumer (~3.75x the
// bytes on a dense payload). Set MCP_PRETTY_JSON=true for human-readable (2-space) output when
// eyeballing raw tool results. Read here at the serialization boundary rather than threaded
// through the zod config, because jsonResult is a standalone formatter with no config access.
export function serializeForDelivery(value: unknown): string {
  return process.env.MCP_PRETTY_JSON === 'true'
    ? JSON.stringify(value, null, 2)
    : JSON.stringify(value);
}
