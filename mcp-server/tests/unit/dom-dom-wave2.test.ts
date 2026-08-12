// Wave-2 locks: the adversarial wave over the v1 diff returned 18 CONFIRMED findings
// (0 refuted). Each block here is red-first against one root cause. The headline class is the
// same as the panel's: axes the projection silently dropped (opacity at 1, borders, root text,
// reference scrollbar, paddings without an axis) made byte-identical states red on some rows
// and total silence on real differences on others.
import { describe, it, expect } from 'vitest';
import { diffDomPair } from '../../src/domain/layout-spec/dom-dom.js';
import type { DomSnapshotOk, DomChild, Edges } from '../../src/domain/layout-spec/types.js';

const ZERO: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
const el = (x: number, y: number, w: number, h: number, extra: Partial<DomChild> = {}): DomChild =>
  ({ kind: 'element', tag: 'div', rect: { x, y, w, h }, ...extra });
const snap = (over: Partial<DomSnapshotOk> = {}, children: DomChild[] = []): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.x', innerWidth: 768,
  rect: { x: 0, y: 0, w: 400, h: 200 },
  borders: ZERO, paddings: ZERO,
  clientWidth: 400, clientHeight: 200, scrollHeight: 200,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', borderRadius: 0, opacity: 1 },
  children, ...over,
});
const kids = (): DomChild[] => [el(0, 0, 400, 40), el(0, 60, 400, 40)];

describe('opacity (wave finding 0)', () => {
  it('reference at 1 vs candidate at 0.3 -> FAIL, not silence', () => {
    const cand = snap({ styles: { display: 'flex', borderRadius: 0, opacity: 0.3 } }, kids());
    const rows = diffDomPair(snap({}, kids()), cand, { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'opacity');
    expect(r?.status).toBe('fail');
  });
});

describe('borders (wave findings 1, 11, 17)', () => {
  const bordered = (color: string): DomSnapshotOk => snap({
    borders: { top: 1, right: 1, bottom: 1, left: 1 },
    borderColors: { top: color, right: color, bottom: color, left: color },
    clientWidth: 398, clientHeight: 198,
  } as Partial<DomSnapshotOk>, kids());
  it('byte-identical bordered states -> border-color/width PASS, no warn of any kind', () => {
    const rows = diffDomPair(bordered('#ff0000'), bordered('#ff0000'), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('pass');
    expect(rows.filter((r) => r.status === 'warn' || r.status === 'fail')).toEqual([]);
  });
  it('a red -> blue border change is a FAIL, not silence', () => {
    const rows = diffDomPair(bordered('#ff0000'), bordered('#0000ff'), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'border-color')?.status).toBe('fail');
  });
  it('candidate-only border -> REVIEW naming the sides (gates the receipt)', () => {
    const rows = diffDomPair(snap({}, kids()), bordered('#ff0000'), { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'border-color');
    expect(r?.status).toBe('review');
    expect(r?.note).toMatch(/CANDIDATE/);
  });
});

describe('per-child size (wave finding 3)', () => {
  it('skeleton placeholders 280px narrower than the reference rows -> per-child FAIL rows', () => {
    const cand = snap({}, [el(0, 0, 120, 40), el(0, 60, 120, 40)]);
    const rows = diffDomPair(snap({}, kids()), cand, { tolerancePx: 1 });
    const sizes = rows.filter((r) => r.prop.startsWith('child-size.w'));
    expect(sizes.length).toBe(2);
    expect(sizes.every((r) => r.status === 'fail')).toBe(true);
  });
  it('matching children -> per-child size rows pass (the axis exists, not only on failure)', () => {
    const rows = diffDomPair(snap({}, kids()), snap({}, kids()), { tolerancePx: 1 });
    expect(rows.some((r) => r.prop.startsWith('child-size.w') && r.status === 'pass')).toBe(true);
  });
});

describe('axis-undefined roots keep their paddings (wave findings 6, 7)', () => {
  const grid = (): DomChild[] => [el(17, 25, 40, 40), el(77, 25, 40, 40), el(17, 85, 40, 40), el(77, 85, 40, 40)];
  const padded = (w: number): DomSnapshotOk => snap({
    rect: { x: 0, y: 0, w, h: 200 },
    borders: { top: 1, right: 1, bottom: 1, left: 1 },
    paddings: { top: 24, right: 16, bottom: 24, left: 16 },
    clientWidth: w - 2, clientHeight: 198,
  }, grid());
  it('byte-identical padded GRID states (no inferable axis) -> zero fails', () => {
    const rows = diffDomPair(padded(400), padded(400), { tolerancePx: 1 });
    expect(rows.filter((r) => r.status === 'fail')).toEqual([]);
  });
  it('a real 40px width difference on a grid root -> size.w FAIL with true content numbers', () => {
    const rows = diffDomPair(padded(400), padded(360), { tolerancePx: 1 });
    const w = rows.find((r) => r.prop === 'size.w');
    expect(w?.status).toBe('fail');
    expect(Math.abs((w?.figma as number) - (w?.dom as number))).toBe(40);
  });
});

describe('reference scrollbar (wave finding 8)', () => {
  const scrolly = (clientW: number): DomSnapshotOk => snap({
    rect: { x: 0, y: 0, w: 768, h: 200 },
    borders: { top: 1, right: 1, bottom: 1, left: 1 },
    paddings: { top: 0, right: 16, bottom: 0, left: 16 },
    clientWidth: clientW, clientHeight: 198,
  }, kids());
  it('two identical scrolling states (15px scrollbar both) -> size.w passes', () => {
    const rows = diffDomPair(scrolly(751), scrolly(751), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'size.w')?.status).toBe('pass');
  });
  it('reference scrolls, candidate does not -> the 15px usable-width difference is a FAIL', () => {
    const rows = diffDomPair(scrolly(751), scrolly(766), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'size.w')?.status).toBe('fail');
  });
});

describe('root text (wave finding 10) and the skeleton direction (finding 12)', () => {
  const withText = (): DomSnapshotOk => snap({}, [
    { kind: 'text', text: 'Shelf title', rect: { x: 0, y: 0, w: 100, h: 20 } },
    ...kids().map((k) => ({ ...k, rect: { ...k.rect, y: k.rect.y + 30 } })),
  ]);
  it('both roots own the same text -> NO presence warn (the old warn was a tautology)', () => {
    const rows = diffDomPair(withText(), withText(), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'typography' && /CANDIDATE root carries text/.test(r.note ?? ''))).toBeUndefined();
  });
  it('reference child has text, candidate (skeleton) does not -> INFO naming the shape, not an uncloseable unchecked', () => {
    // The realistic extractor shape: a text-bearing element carries its typo bundle in styles
    // AND a nested kind:'text' child (this is what routes through the carrier resolver).
    const textKid = el(0, 0, 400, 40, { styles: { fontSize: 13, fontWeight: 400 },
      children: [{ kind: 'text', text: 'Product A', rect: { x: 4, y: 4, w: 80, h: 16 } }] });
    const rows = diffDomPair(snap({}, [textKid, el(0, 60, 400, 40)]), snap({}, kids()), { tolerancePx: 1 });
    const t = rows.find((r) => r.prop.startsWith('typography['));
    expect(t?.status).toBe('info');
    expect(t?.note ?? '').toMatch(/skeleton|no text where the REFERENCE/i);
    expect(t?.note ?? '').not.toMatch(/Figma/);
  });
});

describe('presence asymmetries gate the receipt (wave finding 5)', () => {
  it('candidate paints a background the reference does not -> REVIEW (gating), with the oklch caveat', () => {
    const cand = snap({ styles: { display: 'flex', backgroundColor: '#808080', borderRadius: 0, opacity: 1 } }, kids());
    const rows = diffDomPair(snap({}, kids()), cand, { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'fill');
    expect(r?.status).toBe('review');
    expect(r?.note).toMatch(/cannot read|oklch/);
  });
});

describe('preflight refusal (wave finding 14)', () => {
  it('a transformed reference is REFUSED: no numeric rows, and the row maps to re-capture blocking', () => {
    const rows = diffDomPair(snap({ transformed: true }, kids()), snap({}, kids()), { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'size.w')).toBe(false);
    const gate = rows.find((r) => r.prop === 'snapshot');
    expect(gate?.status).toBe('warn');
    expect(gate?.note).toMatch(/^reference: /);
  });
  it('a scrolled reference is refused the same way', () => {
    const rows = diffDomPair(snap({ scroll: { top: 120, left: 0 } }, kids()), snap({}, kids()), { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'size.w')).toBe(false);
    expect(rows.find((r) => r.prop === 'snapshot')?.note).toMatch(/^reference: .*scrolled/);
  });
});

describe('uncomparable reference radius (wave finding 4)', () => {
  it('emits a visible unchecked row instead of dropping the axis', () => {
    const ref = snap({ styles: { display: 'flex', borderRadius: 0, borderRadiusUncomparable: true, opacity: 1 } }, kids());
    const rows = diffDomPair(ref, snap({}, kids()), { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'corner-radius');
    expect(r?.status).toBe('unchecked');
    expect(r?.note).toMatch(/REFERENCE/);
  });
});
