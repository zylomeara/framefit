// mcp-server/src/domain/layout-spec/tolerance.ts
// Width-noise tolerance — extracted out of diff.ts so a leaf consumer
// outside the diff graph (dom-snapshot-routes.ts's POST upload handler, see (a') viewport preflight
// warning) can import the formula directly without pulling in diff.ts's full dependency surface.
// diff.ts re-exports this (`export { widthNoiseTolerance }`) for backward compatibility with its
// existing importers (find-breakpoint-variant-tool.ts, compare-node-to-dom-tool.ts) — this file is
// the single source of truth for the formula.

// Unified width policy: minimum 24px, otherwise 5% of the reference (keeps small frames/overlays
// from tripping the viewport gate on 1-2px noise, but doesn't blow up to absurd values at large widths).
export const widthNoiseTolerance = (ref: number): number => Math.max(24, ref * 0.05);
