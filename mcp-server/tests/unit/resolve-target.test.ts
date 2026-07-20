import { describe, it, expect } from 'vitest';
import { boxOf, verticalOverlap, differentColumn, pickReferenceFrame, hitPath, buildReferenceNode, resolveReferenceNode, computeConfidence } from '../../src/domain/resolve-target.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const frame = (id: string, x: number, y: number, w: number, h: number, type = 'FRAME'): RawSceneNode => ({
  id, name: id, type,
  absoluteBoundingBox: { x, y, width: w, height: h },
  children: [{ id: `${id}-c`, name: 'c', type: 'TEXT', absoluteBoundingBox: { x, y, width: 10, height: 10 } }],
} as unknown as RawSceneNode);

describe('resolve-target geometry', () => {
  it('verticalOverlap is the shared Y span, 0 when disjoint', () => {
    expect(verticalOverlap({ x: 0, y: 0, w: 10, h: 100 }, { x: 50, y: 40, w: 10, h: 100 })).toBe(60);
    expect(verticalOverlap({ x: 0, y: 0, w: 10, h: 100 }, { x: 0, y: 200, w: 10, h: 10 })).toBe(0);
  });

  it('differentColumn is true only when X-ranges do not overlap', () => {
    expect(differentColumn({ x: 0, y: 0, w: 100, h: 10 }, { x: 200, y: 0, w: 100, h: 10 })).toBe(true);
    expect(differentColumn({ x: 0, y: 0, w: 100, h: 10 }, { x: 50, y: 0, w: 100, h: 10 })).toBe(false);
  });

  it('differentColumn treats touching edges as different columns', () => {
    expect(differentColumn({ x: 0, y: 0, w: 100, h: 10 }, { x: 100, y: 0, w: 50, h: 10 })).toBe(true);
  });

  it('pickReferenceFrame: different column + max vertical overlap wins', () => {
    const prod = { x: 0, y: 0, w: 800, h: 1000 };
    const reference = frame('ref', 1000, 0, 760, 980);     // right column, ~980 overlap
    const sameColumn = frame('same', 100, 0, 700, 1000);   // overlaps prod X → excluded
    const tinyCursor = frame('cursor', 1000, 500, 24, 24); // right column but overlap 24 < 50% prod h
    expect(pickReferenceFrame(prod, [sameColumn, tinyCursor, reference])).toBe(reference);
  });

  it('pickReferenceFrame: returns null when the best overlap is under half the prod height', () => {
    const prod = { x: 0, y: 0, w: 800, h: 1000 };
    const tiny = frame('tiny', 1000, 0, 100, 100); // overlap 100 < 500
    expect(pickReferenceFrame(prod, [tiny])).toBeNull();
  });

  it('boxOf returns null when no absoluteBoundingBox', () => {
    expect(boxOf({ id: 'x', name: 'x', type: 'FRAME' } as unknown as RawSceneNode)).toBeNull();
  });
});

const node = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Partial<RawSceneNode> = {}, children: RawSceneNode[] = []): RawSceneNode => ({
  id, name: id, type, absoluteBoundingBox: { x, y, width: w, height: h }, children, ...extra,
} as unknown as RawSceneNode);

describe('hitPath', () => {
  it('returns null when the point is outside the reference frame', () => {
    const ref = node('ref', 'FRAME', 0, 0, 100, 100);
    expect(hitPath(ref, { x: 500, y: 500 })).toBeNull();
  });

  it('descends to the deepest containing node', () => {
    const leaf = node('leaf', 'TEXT', 10, 10, 20, 20);
    const mid = node('mid', 'FRAME', 0, 0, 50, 50, {}, [leaf]);
    const ref = node('ref', 'FRAME', 0, 0, 100, 100, {}, [mid]);
    const path = hitPath(ref, { x: 15, y: 15 });
    expect(path!.map((n) => n.id)).toEqual(['ref', 'mid', 'leaf']);
  });

  it('picks the topmost (last) sibling when two overlap', () => {
    const under = node('under', 'FRAME', 0, 0, 100, 100);
    const over = node('over', 'FRAME', 0, 0, 100, 100);
    const ref = node('ref', 'FRAME', 0, 0, 100, 100, {}, [under, over]); // over rendered last → on top
    expect(hitPath(ref, { x: 50, y: 50 })!.map((n) => n.id)).toEqual(['ref', 'over']);
  });

  it('skips hidden and fully transparent siblings', () => {
    const hidden = node('hidden', 'FRAME', 0, 0, 100, 100, { visible: false });
    const transparent = node('ghost', 'FRAME', 0, 0, 100, 100, { opacity: 0 });
    const real = node('real', 'FRAME', 0, 0, 100, 100);
    const ref = node('ref', 'FRAME', 0, 0, 100, 100, {}, [real, transparent, hidden]);
    expect(hitPath(ref, { x: 50, y: 50 })!.map((n) => n.id)).toEqual(['ref', 'real']);
  });

  it('stops at a frame with no child containing the point (coarse hit)', () => {
    const leaf = node('leaf', 'TEXT', 10, 10, 5, 5);
    const ref = node('ref', 'FRAME', 0, 0, 100, 100, {}, [leaf]);
    expect(hitPath(ref, { x: 90, y: 90 })!.map((n) => n.id)).toEqual(['ref']); // point in empty area
  });
});

describe('buildReferenceNode', () => {
  it('leaf fields = deepest node; suggested = deepest container; TEXT leaf carries text', () => {
    const chain = [
      node('tablet', 'FRAME', 0, 0, 768, 1350),
      node('bottom', 'FRAME', 0, 1156, 768, 194),
      node('scroll card', 'FRAME', 0, 1156, 768, 100),
      { id: 'leaf', name: 'price', type: 'TEXT', characters: 'Цены без учёта', absoluteBoundingBox: { x: 0, y: 1156, width: 80, height: 20 } } as unknown as RawSceneNode,
    ];
    const ref = buildReferenceNode(chain, {});
    expect(ref.nodeId).toBe('leaf');
    expect(ref.type).toBe('TEXT');
    expect(ref.text).toBe('Цены без учёта');
    expect(ref.suggested).toEqual({ nodeId: 'scroll card', name: 'scroll card', type: 'FRAME' });
    expect(ref.path.find((p) => p.id === 'scroll card')!.suggested).toBe(true);
    expect(ref.path.map((p) => p.id)).toEqual(['tablet', 'bottom', 'scroll card', 'leaf']);
  });

  it('includeBounds adds w/h to path nodes', () => {
    const chain = [node('f', 'FRAME', 0, 0, 768, 100)];
    const ref = buildReferenceNode(chain, { includeBounds: true });
    expect(ref.path[0].w).toBe(768);
    expect(ref.path[0].h).toBe(100);
  });

  it('collapses GROUP/VECTOR intermediates but keeps root, leaf and suggested', () => {
    const chain = [
      node('root', 'FRAME', 0, 0, 100, 100),
      node('grp', 'GROUP', 0, 0, 100, 100),
      node('card', 'FRAME', 0, 0, 100, 100),
      node('vec', 'VECTOR', 0, 0, 10, 10),
    ];
    const ref = buildReferenceNode(chain, {});
    // grp collapsed; vec is the leaf so it stays; card is suggested.
    expect(ref.path.map((p) => p.id)).toEqual(['root', 'card', 'vec']);
    expect(ref.suggested.nodeId).toBe('card');
  });

  it('caps path length and flags pathTruncated', () => {
    const chain = Array.from({ length: 12 }, (_, i) => node(`n${i}`, 'FRAME', 0, 0, 100, 100));
    const ref = buildReferenceNode(chain, {});
    expect(ref.path.length).toBe(8);
    expect(ref.path[0].id).toBe('n0');           // root kept
    expect(ref.path[ref.path.length - 1].id).toBe('n11'); // leaf kept
    expect(ref.pathTruncated).toBe(true);
  });

  it('retains suggested node in path even when it falls outside the last-7 window', () => {
    // root FRAME → suggested FRAME (deepest container, index 1) → 8 RECTANGLEs → TEXT leaf
    // RECTANGLEs are not in CONTAINER_TYPES or COLLAPSE_TYPES, so all 11 nodes survive collapse.
    // Without the fix the last-7 window [rect2..rect7, leaf] excludes the suggested FRAME at index 1
    // AND the buggy fallback branch drops the leaf entirely (kept rect7 instead).
    const rects = Array.from({ length: 8 }, (_, i) =>
      node(`rect${i}`, 'RECTANGLE', 0, 0, 10, 10));
    const leaf = node('leaf', 'TEXT', 0, 0, 10, 10);
    const suggested = node('suggested', 'FRAME', 0, 0, 100, 100);
    const root = node('root', 'FRAME', 0, 0, 200, 200);
    const chain: RawSceneNode[] = [root, suggested, ...rects, leaf];
    // chain length = 11 → truncation fires; suggestedNode = the FRAME at index 1
    const ref = buildReferenceNode(chain, {});
    expect(ref.path.length).toBe(8);
    expect(ref.pathTruncated).toBe(true);
    expect(ref.path[0].id).toBe('root');                              // root always first
    expect(ref.path[ref.path.length - 1].id).toBe('leaf');           // leaf always last ← was missing
    const suggestedInPath = ref.path.filter((p) => p.suggested === true);
    expect(suggestedInPath).toHaveLength(1);
    expect(suggestedInPath[0].id).toBe(ref.suggested.nodeId);
    expect(suggestedInPath[0].id).toBe('suggested');                 // must be the deepest-container id
  });
});

describe('resolveReferenceNode', () => {
  it('transplants atPercent into the reference frame and resolves the node', () => {
    // Real-page geometry: reference "tablet" at (34330,-9979,768,1350) with a "bottom"
    // child band. atPercent.y=0.857 maps to y≈-8822, inside "bottom".
    const bottom = node('bottom', 'FRAME', 34330, -8823, 768, 194);
    const tablet = node('tablet', 'FRAME', 34330, -9979, 768, 1350, {}, [bottom]);
    const r = resolveReferenceNode(tablet, { x: 0.524, y: 0.857 }, { x: 0, y: 0, w: 768, h: 1350 }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.suggested.nodeId).toBe('bottom');
      expect(r.node.path.map((p) => p.id)).toEqual(['tablet', 'bottom']);
    }
  });

  it('returns reason when the mapped point falls outside (atPercent out of range)', () => {
    const ref = node('ref', 'FRAME', 0, 0, 100, 100);
    const r = resolveReferenceNode(ref, { x: 2, y: 2 }, { x: 0, y: 0, w: 100, h: 100 }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('point_outside_reference');
  });

  it('marks a frame-only hit (point in empty frame space) as coarse', () => {
    const ref = node('ref', 'FRAME', 0, 0, 100, 100); // no children
    const r = resolveReferenceNode(ref, { x: 0.5, y: 0.5 }, { x: 0, y: 0, w: 100, h: 100 }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.coarse).toBe(true);
      expect(r.node.path.length).toBe(1);
      expect(r.node.nodeId).toBe('ref');
    }
  });

  it('does not mark a precise (deeper) hit as coarse', () => {
    const leaf = node('leaf', 'TEXT', 10, 10, 20, 20);
    const ref = node('ref', 'FRAME', 0, 0, 100, 100, {}, [leaf]);
    const r = resolveReferenceNode(ref, { x: 0.15, y: 0.15 }, { x: 0, y: 0, w: 100, h: 100 }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.coarse).toBeUndefined();
  });

  it('attaches confidence to a resolved node', () => {
    const leaf = node('leaf', 'TEXT', 10, 10, 20, 20);
    const ref = node('ref', 'FRAME', 0, 0, 100, 100, {}, [leaf]);
    const r = resolveReferenceNode(ref, { x: 0.15, y: 0.15 }, { x: 0, y: 0, w: 100, h: 100 }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.confidence).toBeDefined();
      expect(['high', 'medium', 'low']).toContain(r.node.confidence!.level);
      expect(typeof r.node.confidence!.scaleDiscrepancyPx).toBe('number');
      expect(typeof r.node.confidence!.boundaryMarginPx).toBe('number');
    }
  });

  it('forces low confidence on a coarse (frame-only) hit', () => {
    const ref = node('ref', 'FRAME', 0, 0, 100, 100); // no children → coarse
    const r = resolveReferenceNode(ref, { x: 0.5, y: 0.5 }, { x: 0, y: 0, w: 100, h: 100 }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.coarse).toBe(true);
      expect(r.node.confidence!.level).toBe('low');
    }
  });
});

describe('computeConfidence', () => {
  const band = (top: number, h: number): { x: number; y: number; w: number; h: number } =>
    ({ x: 0, y: top, w: 768, h });
  // Equal-width prod/ref ⇒ scaleDiscrepancyPx === |prodH − refH|; pointY within band sets the margin.
  const ref = { x: 0, y: 0, w: 768, h: 1000 };

  it('high: marginRatio ≥ 1 (margin covers worst-case drift) → provably safe', () => {
    // prod 768×1050 vs ref 768×1000 → discrepancy 50; point at band centre → margin 100 → ratio 2.0.
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1050 }, ref, 300, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(50);
    expect(c.boundaryMarginPx).toBe(100);
    expect(c.level).toBe('high');
  });

  it('medium: 0.35 ≤ marginRatio < 1', () => {
    // discrepancy 120; margin 60 → ratio 0.5.
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1120 }, ref, 260, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(120);
    expect(c.boundaryMarginPx).toBe(60);
    expect(c.level).toBe('medium');
  });

  it('low: marginRatio < 0.35 (margin ≪ drift)', () => {
    // discrepancy 100; margin 10 → ratio 0.1.
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1100 }, ref, 210, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(100);
    expect(c.boundaryMarginPx).toBe(10);
    expect(c.level).toBe('low');
  });

  it('boundary: marginRatio exactly 1.0 → high', () => {
    // discrepancy 100; margin 100 → ratio 1.0.
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1100 }, ref, 300, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(100);
    expect(c.boundaryMarginPx).toBe(100);
    expect(c.level).toBe('high');
  });

  it('boundary: marginRatio exactly 0.35 → medium', () => {
    // discrepancy 100; margin 35 → ratio 0.35.
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1100 }, ref, 235, band(200, 400), false);
    expect(c.boundaryMarginPx).toBe(35);
    expect(c.level).toBe('medium');
  });

  it('perfect alignment (discrepancy 0): any interior hit → high via max(.,1)', () => {
    // prod === ref → discrepancy 0; margin 1 → ratio 1/max(0,1) = 1 → high.
    const c = computeConfidence(ref, ref, 201, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(0);
    expect(c.boundaryMarginPx).toBe(1);
    expect(c.level).toBe('high');
  });

  it('coarse hit is forced to low even with otherwise-high inputs', () => {
    const c = computeConfidence(ref, ref, 300, band(200, 400), true);
    expect(c.level).toBe('low');
  });

  it('degenerate reference (zero width) → low, no NaN', () => {
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1350 }, { x: 0, y: 0, w: 0, h: 0 }, 100, band(0, 200), false);
    expect(c.level).toBe('low');
    expect(Number.isFinite(c.scaleDiscrepancyPx)).toBe(true);
    expect(Number.isFinite(c.boundaryMarginPx)).toBe(true);
  });

  it('NaN reference dimensions → low, no NaN (guard rejects NaN)', () => {
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1350 }, { x: 0, y: 0, w: NaN, h: NaN }, 100, band(0, 200), false);
    expect(c.level).toBe('low');
    expect(c.scaleDiscrepancyPx).toBe(0);
    expect(c.boundaryMarginPx).toBe(0);
  });

  // Real board 2334:41996 calibration (see spec). Equal-width prod/ref so discrepancy === |prodH − 1000|.
  it('real lane-1 #1 (margin 65, discrepancy 34 → 1.9) → high (the board\'s high anchor)', () => {
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1034 }, ref, 265, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(34);
    expect(c.boundaryMarginPx).toBe(65);
    expect(c.level).toBe('high');
  });

  it('real lane-2 #2 unavailable (margin 144, discrepancy 263 → 0.55) → medium (deep, reliable)', () => {
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1263 }, ref, 344, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(263);
    expect(c.boundaryMarginPx).toBe(144);
    expect(c.level).toBe('medium');
  });

  it('real-case DRIFT (margin 11, discrepancy 99 → 0.11) → low (correctly flagged)', () => {
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1099 }, ref, 211, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(99);
    expect(c.boundaryMarginPx).toBe(11);
    expect(c.level).toBe('low');
  });

  it('real-case scroll card correct-but-edge (margin 1, discrepancy 99 → 0.01) → low (honest)', () => {
    const c = computeConfidence({ x: 0, y: 0, w: 768, h: 1099 }, ref, 201, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(99);
    expect(c.boundaryMarginPx).toBe(1);
    expect(c.level).toBe('low');
  });

  it('prodW < refW: unit-corrected drift prevents a false high (margin 80, ref-drift ≈ 152) → medium', () => {
    // scaleDiscrepancyPx (prod px) = |600 − 1000×(400/768)| = 79; true ref-drift = 79×(768/400) ≈ 152.
    // Without the refW/prodW correction this is 80/79 ≈ 1.01 → false 'high'; corrected → 80/152 ≈ 0.53 → medium.
    const c = computeConfidence({ x: 0, y: 0, w: 400, h: 600 }, { x: 0, y: 0, w: 768, h: 1000 }, 280, band(200, 400), false);
    expect(c.scaleDiscrepancyPx).toBe(79);
    expect(c.boundaryMarginPx).toBe(80);
    expect(c.level).toBe('medium');
  });

  it('degenerate prod (zero width) → low, no NaN (prodBox.w is a divisor)', () => {
    const c = computeConfidence({ x: 0, y: 0, w: 0, h: 600 }, { x: 0, y: 0, w: 768, h: 1000 }, 280, band(200, 400), false);
    expect(c.level).toBe('low');
    expect(c.scaleDiscrepancyPx).toBe(0);
    expect(c.boundaryMarginPx).toBe(0);
  });
});
