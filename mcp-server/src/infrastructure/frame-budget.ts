// Pure resident-byte accounting for the frame-hydration store. The store holds PARSED objects
// (V8 retains ~3-10× wire bytes) but only cheap WIRE bytes are measurable (tagBytes/sizeOf). We
// account each held frame as wire × multiplier so the global cap bounds real RSS, not a 3-10×
// understatement — the same "measure the resident reality, not an internal proxy" lesson as the
// clamp pretty-calibration fix.

/** Resident (parsed) byte estimate for a frame whose wire size is `wireBytes`. */
export function residentBytes(wireBytes: number, multiplier: number): number {
  return Math.ceil(wireBytes * multiplier);
}

/**
 * Parse-gate: a frame is HOLDABLE only if its wire size is within the parse cap. Over the cap it is
 * delivered once but never held (hydrated:false), so a heavy frame degrades honestly rather than
 * pinning RAM. NOT a dead 0-byte guard: it fires on any wireBytes > parseCapBytes.
 */
export function withinParseCap(wireBytes: number, parseCapBytes: number): boolean {
  return wireBytes <= parseCapBytes;
}
