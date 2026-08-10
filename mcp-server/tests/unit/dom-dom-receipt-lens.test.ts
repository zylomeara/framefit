// Receipt-lens locks (the re-run verdict-receipt lens over the fixed branch): an axis the code
// itself says was NOT compared must hold the done-gate (the corner-radius precedent), coverage
// must not claim those axes as measured, and machine consumers of blocking must be able to tell
// WHICH axis a presence review is about without parsing prose.
import { describe, it, expect } from 'vitest';
import { diffDomPair } from '../../src/domain/layout-spec/dom-dom.js';
import { deriveCoverage } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import { summarize } from '../../src/domain/layout-spec/diff.js';
import type { DomSnapshotOk, DomChild, PairResult } from '../../src/domain/layout-spec/types.js';

const el = (x: number, y: number, w: number, h: number, extra: Partial<DomChild> = {}): DomChild =>
  ({ kind: 'element', tag: 'div', rect: { x, y, w, h }, ...extra });
const snap = (over: Partial<DomSnapshotOk> = {}, children: DomChild[] = []): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.x', innerWidth: 768,
  rect: { x: 0, y: 0, w: 400, h: 200 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 400, clientHeight: 200, scrollHeight: 200,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', borderRadius: 0, opacity: 1 },
  children, ...over,
});
const kids = (): DomChild[] => [el(0, 0, 400, 40), el(0, 60, 400, 40)];
const asPair = (rows: ReturnType<typeof diffDomPair>): PairResult =>
  ({ node_id: 'p', rows, summary: summarize(rows), coverage: deriveCoverage(rows) });
const verify = (rows: ReturnType<typeof diffDomPair>) =>
  buildVerification([asPair(rows)], { depthLevels: 4, tolerancePx: 1, mode: 'dom-dom' });

describe('uncompared axes hold the gate (lens finding 1)', () => {
  it('a border-bottom divider changing color -> complete:false with a visible unchecked, not a green info', () => {
    const divider = (color: string): DomSnapshotOk => snap({
      borders: { top: 0, right: 0, bottom: 1, left: 0 },
      borderColors: { bottom: color },
      clientHeight: 199,
    } as Partial<DomSnapshotOk>, kids());
    const rows = diffDomPair(divider('#ff0000'), divider('#0000ff'), { tolerancePx: 1 });
    const bc = rows.find((r) => r.prop === 'border-color');
    expect(bc?.status).toBe('unchecked');
    const v = verify(rows);
    expect(v.complete).toBe(false);
    expect(v.blocking.some((b: { action: string }) => b.action === 'resolve_skip')).toBe(true);
  });
  it('an oklch reference background vs a hex candidate -> complete:false', () => {
    const ref = snap({ styles: { display: 'flex', backgroundColor: 'oklch(0.5 0.1 200)', borderRadius: 0, opacity: 1 } }, kids());
    const cand = snap({ styles: { display: 'flex', backgroundColor: '#ffffff', borderRadius: 0, opacity: 1 } }, kids());
    const rows = diffDomPair(ref, cand, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'fill')?.status).toBe('unchecked');
    expect(verify(rows).complete).toBe(false);
  });
});

describe('coverage truth (lens finding 2)', () => {
  it('the skeleton typography info is SKIPPED coverage, not measured; reference_fonts is not an axis', () => {
    const textKid = el(0, 0, 400, 40, { styles: { fontSize: 13 },
      children: [{ kind: 'text', text: 'Product A', rect: { x: 4, y: 4, w: 80, h: 16 } }] });
    const rows = diffDomPair(
      snap({ fontsLoaded: false }, [textKid, el(0, 60, 400, 40)]),
      snap({}, kids()), { tolerancePx: 1 });
    const cov = deriveCoverage(rows);
    expect(cov.measured).not.toContain('typography');
    expect(cov.skipped.map((s) => s.dim)).toContain('typography');
    expect(cov.measured).not.toContain('reference_fonts');
  });
  it('child-size rows land in the size dimension, not two phantom axes', () => {
    const cov = deriveCoverage(diffDomPair(snap({}, kids()), snap({}, kids()), { tolerancePx: 1 }));
    expect(cov.measured).not.toContain('child-size.w');
    expect(cov.measured).toContain('size');
  });
});

describe('blocking distinguishability (lens finding 3)', () => {
  it('two presence reviews on one pair carry their prop structurally, not only in prose', () => {
    const cand = snap({
      styles: { display: 'flex', backgroundColor: '#808080', borderRadius: 0, opacity: 1 },
      borders: { top: 1, right: 1, bottom: 1, left: 1 },
      borderColors: { top: '#333333', right: '#333333', bottom: '#333333', left: '#333333' },
      clientWidth: 398, clientHeight: 198,
    } as Partial<DomSnapshotOk>, kids());
    const v = verify(diffDomPair(snap({}, kids()), cand, { tolerancePx: 1 }));
    const reviews = v.blocking.filter((b: { kind: string }) => b.kind === 'unconfirmed_token');
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    const props = reviews.flatMap((b: { places?: { prop: string }[] }) => (b.places ?? []).map((pl) => pl.prop));
    expect(props).toContain('fill');
    expect(props).toContain('border-color');
  });
});
