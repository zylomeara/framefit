// Reopened batch-2 item 2 (consumer acceptance of 0.27.0; panel: 3 lenses, 4 blockers,
// 7 majors). The #57 x #58 interplay: the alignment gate's figFreeSpace read only the
// DECLARED padding while the spacer fold moved inset extents (and their itemSpacing) out
// of the children sum - a folded inset read as slack, CENTER marked the edge slack, and
// the justify demote reopened on a zero-slack container: the exact incident #58 exists to
// catch, surviving on the flagship DS form (spacer-encoded insets + Align=Center). The
// corrected math restores the folded extents AND the folded gap count; a folded GROW
// spacer (layoutGrow>0 - its extent IS distributed free space) is excluded from the inset
// terms; SPACE_BETWEEN's end allowance is gated to the degenerate single-child unfolded
// case (interior space is not edge evidence, a folded edge is pinned proof); the
// attribution carries fold provenance into the caveat fix_plan copies.
import { describe, it, expect } from 'vitest';
import { diffPair } from '../../src/domain/layout-spec/diff.js';
import type { LayoutSpec, DomSnapshotOk, SpecChild, DomChild } from '../../src/domain/layout-spec/types.js';

const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const spacer = (id: string, x: number, w: number, over: Partial<SpecChild> = {}): SpecChild =>
  ({ id, name: 'Padding horizontal', type: 'RECTANGLE', rect: R(x, 0, w, 120), ...over } as SpecChild);
const kid = (id: string, x: number, w: number): SpecChild =>
  ({ id, name: 'Body', type: 'FRAME', rect: R(x, 20, w, 80), axis: 'row' } as SpecChild);
const spec = (w: number, kids: SpecChild[], align: string | undefined, gap = 0): LayoutSpec => ({
  node: { id: '9:0', name: 'tile', type: 'INSTANCE' },
  rect: R(0, 0, w, 120), axis: 'row',
  autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 },
    ...(gap ? { gap } : {}), ...(align ? { primaryAlign: align } : {}) } as never,
  children: kids,
});
const centeringDom = (w: number, childX: number, childW: number, jc = 'center'): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.tile', innerWidth: 1920,
  rect: R(0, 0, w, 120), borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: w, clientHeight: 120, scrollHeight: 120,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', justifyContent: jc },
  children: [{ kind: 'element', tag: 'span', rect: R(childX, 20, childW, 80) } as DomChild],
}) as never;

const padRow = (rows: ReturnType<typeof diffPair>, prop: string) => rows.find((r) => r.prop === prop);

describe('the incident: a folded inset never reads as slack', () => {
  it('the incident shape (360 = 12 fold + 348 child, CENTER, DOM centers) -> BOTH padding edges FAIL with the zero-slack attribution + fold provenance, NOT demoted', () => {
    const rows = diffPair(spec(360, [spacer('9:1', 0, 12), kid('9:2', 12, 348)], 'CENTER'),
      centeringDom(360, 72, 216), { tolerancePx: 1 });
    const left = padRow(rows, 'padding-left')!;
    expect(left.status).toBe('fail');
    expect(left.note).toMatch(/no free space - the declared CENTER is inert/);
    expect(left.note).toMatch(/edge spacer layer folded into this row/);
    expect((left as { caveat?: string }).caveat).toMatch(/spacer_inset/);
    const right = padRow(rows, 'padding-right')!;
    expect(right.status).toBe('fail');                       // both edges flip (panel minor)
  });

  it('gap-carrying incident (368 = 12 fold + 8 gap + 348 child, gap 8, CENTER) -> FAIL not demoted (the folded gap term is load-bearing)', () => {
    const rows = diffPair(spec(368, [spacer('9:1', 0, 12), kid('9:2', 20, 348)], 'CENTER', 8),
      centeringDom(368, 76, 216), { tolerancePx: 1 });
    const left = padRow(rows, 'padding-left')!;
    expect(left.status).toBe('fail');
    expect(left.note).toMatch(/declared CENTER is inert/);
  });

  it('END-edge fold + CENTER -> padding-right flips demoted -> fail', () => {
    const rows = diffPair(spec(360, [kid('9:2', 0, 348), spacer('9:1', 348, 12)], 'CENTER'),
      centeringDom(360, 72, 216), { tolerancePx: 1 });
    expect(padRow(rows, 'padding-right')!.status).toBe('fail');
  });

  it('MIN + space-between DOM + END fold -> the end edge is not slack (fail with attribution)', () => {
    const rows = diffPair(spec(360, [kid('9:2', 0, 348), spacer('9:1', 348, 12)], 'MIN'),
      centeringDom(360, 0, 280, 'space-between'), { tolerancePx: 1 });
    const right = padRow(rows, 'padding-right')!;
    expect(right.status).toBe('fail');
    expect(right.note).toMatch(/CSS distributes surplus space|alignment mismatch/);
  });
});

describe('the demote survives where the evidence is real', () => {
  it('genuine slack beyond the fold (400 = 12 fold + 348 + 40 real) -> demote survives', () => {
    const rows = diffPair(spec(400, [spacer('9:1', 0, 12), kid('9:2', 12, 348)], 'CENTER'),
      centeringDom(400, 92, 216), { tolerancePx: 1 });
    expect(padRow(rows, 'padding-left')!.status).toBe('demoted');
  });

  it('MAGNITUDE boundary: genuine slack (6) SMALLER than the folded extent (12) -> still demoted (kills over-subtraction)', () => {
    const rows = diffPair(spec(366, [spacer('9:1', 0, 12), kid('9:2', 12, 348)], 'CENTER'),
      centeringDom(366, 75, 216), { tolerancePx: 1 });
    expect(padRow(rows, 'padding-left')!.status).toBe('demoted');
  });

  it('a folded GROW spacer keeps the demote road - its extent IS the free space (panel blocker)', () => {
    const growSpacer = spacer('9:1', 100, 260, { name: 'Spacer', grow: true as const });
    const rows = diffPair(spec(360, [kid('9:2', 0, 100), growSpacer], 'MIN'),
      centeringDom(360, 0, 120, 'space-between'), { tolerancePx: 1 });
    const right = padRow(rows, 'padding-right')!;
    expect(right.status).toBe('demoted');
    expect(right.note).toMatch(/justify-content spacer/);
  });
});

describe('wave locks: every correction term is load-bearing', () => {
  it('TRAILING fold + gap: the trailCount half of the folded-gap term is load-bearing', () => {
    // 368 = 348 child + 8 itemSpacing + 12 trailing fold - zero real slack
    const rows = diffPair(spec(368, [kid('9:2', 0, 348), spacer('9:1', 356, 12)], 'CENTER', 8),
      centeringDom(368, 76, 216), { tolerancePx: 1 });
    const right = padRow(rows, 'padding-right')!;
    expect(right.status).toBe('fail');
    expect(right.note).toMatch(/declared CENTER is inert/);
  });

  it('LEADING grow spacer keeps the demote road - growStartPx is load-bearing', () => {
    const growSpacer = spacer('9:1', 0, 260, { name: 'Spacer', grow: true as const });
    const rows = diffPair(spec(360, [growSpacer, kid('9:2', 260, 100)], 'MAX'),
      centeringDom(360, 200, 100, 'flex-end'), { tolerancePx: 1 });
    const left = padRow(rows, 'padding-left')!;
    expect(left.status).toBe('demoted');
    expect(left.note).toMatch(/justify-content spacer/);
  });

  it('a GROW-only folded edge routed to the attribution still names the fold provenance (the row reads the spacer extent)', () => {
    const growSpacer = spacer('9:1', 0, 260, { name: 'Spacer', grow: true as const });
    const rows = diffPair(spec(360, [growSpacer, kid('9:2', 260, 100)], 'MIN'),
      centeringDom(360, 200, 100, 'flex-end'), { tolerancePx: 1 });
    const left = padRow(rows, 'padding-left')!;
    expect(left.status).toBe('fail');                        // MIN start is never slack
    expect(left.note).toMatch(/edge spacer layer folded into this row/);
  });
});

describe('SPACE_BETWEEN: interior space is not edge evidence', () => {
  it('single post-fold child + FOLDED end + genuine slack -> the fold conjunct denies the allowance (fail, not demoted)', () => {
    // 400 = 300 child + 12 trailing fold + 88 genuine slack - the folded edge is pinned proof
    const rows = diffPair(spec(400, [kid('9:2', 0, 300), spacer('9:1', 388, 12)], 'SPACE_BETWEEN'),
      centeringDom(400, 0, 340, 'space-between'), { tolerancePx: 1 });
    const right = padRow(rows, 'padding-right')!;
    expect(right.status).toBe('fail');
    expect(right.note).toMatch(/alignment mismatch|distributes surplus space/);
  });

  it('>=2 kids + folded end -> the end edge is NOT slack (fail)', () => {
    const rows = diffPair(
      spec(352, [kid('9:2', 0, 100), { ...kid('9:3', 236, 100) }, spacer('9:1', 336, 16)], 'SPACE_BETWEEN'),
      {
        ...centeringDom(352, 0, 100, 'space-between'),
        children: [
          { kind: 'element', tag: 'span', rect: R(0, 20, 100, 80) } as DomChild,
          { kind: 'element', tag: 'span', rect: R(212, 20, 100, 80) } as DomChild,
        ],
      } as never,
      { tolerancePx: 1 });
    const right = padRow(rows, 'padding-right');
    expect(right?.status).toBe('fail');
  });

  it('the degenerate: single child, NO fold -> the end allowance survives (demote as today)', () => {
    // fig pad-end 12 (child 0..348) vs dom pad-right 80 (child 0..280 under space-between)
    const rows = diffPair(spec(360, [kid('9:2', 0, 348)], 'SPACE_BETWEEN'),
      centeringDom(360, 0, 280, 'space-between'), { tolerancePx: 1 });
    expect(padRow(rows, 'padding-right')!.status).toBe('demoted');
  });
});

describe('inert roads stay inert', () => {
  it('unwrapBase: the gate is dead (jd zeroed) - fold or not, the row is a plain fail without attribution', () => {
    const wrapper: SpecChild = { id: '9:5', name: 'wrap', type: 'FRAME', rect: R(0, 0, 360, 120), axis: 'row',
      children: [spacer('9:1', 0, 12), kid('9:2', 12, 200), { ...kid('9:3', 216, 136), id: '9:3' }] } as SpecChild;
    const rows = diffPair(spec(360, [wrapper], 'CENTER'),
      {
        ...centeringDom(360, 20, 170),
        children: [
          { kind: 'element', tag: 'span', rect: R(20, 20, 170, 80) } as DomChild,
          { kind: 'element', tag: 'span', rect: R(216, 20, 130, 80) } as DomChild,
        ],
      } as never,
      { tolerancePx: 1 });
    expect(rows.some((r) => r.prop === 'unwrapped')).toBe(true);
    const left = padRow(rows, 'padding-left');
    expect(left?.note ?? '').not.toMatch(/alignment mismatch|declared CENTER is inert/);
  });
});
