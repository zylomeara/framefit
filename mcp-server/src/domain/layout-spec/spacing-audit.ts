// Audit of a partial container's between-children gaps — a container whose CHILDREN
// are paired but which is itself unpaired (verification.ts frameCoverageDetailed → partialDetails). The
// between-pair gap is measured DIRECTLY from the rects of the already-paired children (Figma pairedNode +
// DOM CaptureInfo), WITHOUT a pair on the container. A pure geometry module — no wiring into verification/tool
// (that part lives in the tool).
//
// Validity rests on the POSITIVE evidence of a single capture: equality of dom_ref.ref means one POST batch
// of the extractor = one layout state. The snapshot's innerWidth/scroll fields do NOT prove this — they
// match for ANY two snapshots of the same viewport configuration, even taken from different requests;
// only ref is tied to a concrete batch.
import type { SpecChild, SpecRect, CaptureInfo, SpacingAuditEntry, SpacingAuditGap } from './types.js';
import { normalizeCompoundNodeId } from '../node-id.js';

const norm = (id: string): string => normalizeCompoundNodeId(id);

// A direct in-flow child of the container (full list, INCLUDING decor and unpaired) + optional id/node of
// the chain link, if the child is paired. The SHAPE MUST match the structural type of partialDetails.kids
// in frameCoverageDetailed (verification.ts) — the caller passes them here WITHOUT mapping. `child`
// does not participate in the audit geometry (needed only for the shape / future consumers) — auditContainer
// reads exclusively pairedId/pairedNode.
export interface AuditKid { child: SpecChild; pairedId?: string; pairedNode?: SpecChild }

const start = (r: SpecRect, axis: 'row' | 'col'): number => (axis === 'row' ? r.x : r.y);
const end = (r: SpecRect, axis: 'row' | 'col'): number => (axis === 'row' ? r.x + r.w : r.y + r.h);
// The cross axis is orthogonal to the main one (row: main=x/cross=y; col: main=y/cross=x, mirrored).
const crossStart = (r: SpecRect, axis: 'row' | 'col'): number => (axis === 'row' ? r.y : r.x);
const crossEnd = (r: SpecRect, axis: 'row' | 'col'): number => (axis === 'row' ? r.y + r.h : r.x + r.w);

// wrap/2D guard: B comes STRICTLY after A along the main axis (main-axis progression, with tolerancePx
// slack) AND both lie in the same visual row/column (cross-axis intersection non-empty). Checked separately
// on the Figma rects and on the DOM rects — the caller invokes this function twice, and the gate fails on ANY failure.
function inFlowNeighbors(a: SpecRect, b: SpecRect, axis: 'row' | 'col', tolerancePx: number): boolean {
  const progressionOk = start(b, axis) >= end(a, axis) - tolerancePx;
  const crossOk = crossStart(a, axis) < crossEnd(b, axis) && crossStart(b, axis) < crossEnd(a, axis);
  return progressionOk && crossOk;
}

// Between-children gaps of container containerId (partial: children paired, container not). kids — the full
// in-flow order (spec.children is already in-flow-only by construction of the projector); captures — the DOM
// slice keyed by the pairedId of the paired children. Returns undefined if no gap was emitted (nothing to audit).
export function auditContainer(
  containerId: string,
  axis: 'row' | 'col',
  kids: AuditKid[],
  captures: Map<string, CaptureInfo>,
  tolerancePx: number,
): SpacingAuditEntry | undefined {
  const gaps: SpacingAuditGap[] = [];
  // Gate 3 (inFlowNeighbors) is a STRUCTURAL detector (wrap/2D), not a measurement: the tolerance is clamped
  // up to a floor of 1px (same principle as structTol in diff.ts) — under strict tol=0 a subpixel overlap would
  // otherwise drop the gate into unchecked on a correct layout (false-alarm class). The gap measurement (effTol
  // below) stays on the RAW tolerancePx — strict tightens measurements.
  const structTol = Math.max(tolerancePx, 1);

  for (let i = 1; i < kids.length; i += 1) {
    const A = kids[i - 1];
    const B = kids[i];
    // Any neighbor without pairedId (including a decor divider) → the gap through it is NOT emitted at all —
    // measurement is impossible, and "jumping over" the decor to compare A directly with the next paired
    // child would be a false gap (the real visual interval includes the unpaired element between them).
    if (A.pairedId === undefined || B.pairedId === undefined) continue;
    // verification.ts contract: pairedNode always travels with pairedId (see frameCoverageDetailed).
    // Defensive shape check — we don't measure if that discrepancy somehow happened.
    const figA = A.pairedNode;
    const figB = B.pairedNode;
    if (!figA || !figB) continue;

    const between: [string, string] = [A.pairedId, B.pairedId];
    const figma = start(figB.rect, axis) - end(figA.rect, axis);
    // A single shortcut for the unchecked branches: dom/delta are OMITTED entirely — fabricating dom=figma/
    // delta=0 under unchecked would be visually indistinguishable from pass in the numeric channel for a consumer
    // reading numbers without status (never-false-alarm: we don't report a "match" computed from rects not proven
    // comparable). status+note stay the only source of truth.
    const unchecked = (note: string): SpacingAuditGap => ({ between, figma, status: 'unchecked', note });

    const capA = captures.get(norm(A.pairedId));
    const capB = captures.get(norm(B.pairedId));

    // Gate 1 — same-capture: both pairs must come from ONE POST batch of the extractor (positive evidence —
    // equality of dom_ref.ref), else the rects could have come from different layout states (different
    // scroll/resize/re-render between requests) — the comparison is meaningless.
    if (capA?.ref === undefined || capB?.ref === undefined || capA.ref !== capB.ref || capA.rect === undefined || capB.rect === undefined) {
      gaps.push(unchecked('gap not verified: pairs from different captures — pass a single-batch dom_ref or add a container pair'));
      continue;
    }
    // Gate 2 — env: if either pair's geometry is marked unchecked (rotated/scroll/transform etc., see
    // diff.ts) → its rect can't be trusted for measuring the gap.
    if (capA.geometryUnchecked || capB.geometryUnchecked) {
      gaps.push(unchecked('pair geometry not verifiable (env) — gap not audited'));
      continue;
    }
    // Gate 3 — wrap/2D on BOTH sides independently: the Figma geometry (pairedNode) can stay single-row
    // while the DOM has already wrapped (or vice versa) — the gate fails on ANY failure.
    const figOk = inFlowNeighbors(figA.rect, figB.rect, axis, structTol);
    const domOk = inFlowNeighbors(capA.rect, capB.rect, axis, structTol);
    if (!figOk || !domOk) {
      gaps.push(unchecked('wrap/2D desync — a single-axis gap is meaningless'));
      continue;
    }

    // Measurement: main axis, border-box of both sides (the children's positions are already fixed —
    // content-edge isn't needed here, unlike diff.ts gap[], since we have no parent pair with its own padding).
    const dom = start(capB.rect, axis) - end(capA.rect, axis);
    const delta = Math.abs(figma - dom);
    // Facing borders: the DOM measures border-box, Figma measures the bbox without stroke; that systematic
    // difference is NOT converted into a fail — we widen the effective tolerance by the thickness of the
    // FACING borders (right edge of A + left edge of B along the main axis; missing borders = 0).
    const facingBorders = axis === 'row'
      ? (capA.borders?.right ?? 0) + (capB.borders?.left ?? 0)
      : (capA.borders?.bottom ?? 0) + (capB.borders?.top ?? 0);
    const effTol = tolerancePx + facingBorders;
    if (delta <= effTol) {
      gaps.push({ between, figma, dom, delta, status: 'pass' });
    } else {
      gaps.push({ between, figma, dom, delta, status: 'fail', note: `Δ${delta}px (tolerance ${effTol}px incl. borders)` });
    }
  }

  // insets_unverified: the audit measures ONLY the gap between children — the container's own padding
  // (insets) doesn't participate in this geometry and stays unverified — an explicit field, not silence.
  return gaps.length > 0 ? { container_id: containerId, axis, gaps, insets_unverified: true } : undefined;
}
