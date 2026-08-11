// Feedback batch 2 item 2 (panel-locked, 30 findings + a live-probe correction): the justify
// demote was ONE-SIDED - it read only the DOM's justify-content, and a DOM that hard-centers
// content while the design anchors it got its padding fail demoted with "not a padding
// defect", hiding the run's main layout defect. The design's own intent is now captured:
// autoLayout.primaryAlign ('MIN'|'CENTER'|'MAX'|'SPACE_BETWEEN'), projected ONLY when the
// primary axis is FIXED (on a hugging axis alignment is inert - the REST default AUTO and
// unknown/absent values leave the field out, which IS the compat road: missing field =
// today's one-sided behavior byte-for-byte, covering dom-dom and every legacy fixture).
// The demote stays only when the design edge's number is SLACK (figSlackEdges by keyword AND
// measured slack > structTol); a DOM that distributes onto an INTENT edge keeps its FAIL
// with an alignment-mismatch note AND caveat (the caveat is what fix_plan copies - without
// it the machine surface prescribes "set padding-left", exactly the wrong edit). Zero slack
// under FIXED means content pins BOTH edges - the declared keyword is inert and the mismatch
// road fires with the inert-note branch (the live-probe correction: the flagship shape is
// FIXED-width, zero slack, declared-but-inert CENTER - the panel's slack belt would have
// hidden the incident again). Stronger demotes (hug/fill, encoding) keep their veto: the
// attribution attaches outermost, note-only, and never lands on a demoted row.
import { describe, it, expect } from 'vitest';
import { diffPair } from '../../src/domain/layout-spec/diff.js';
import { buildLayoutSpec } from '../../src/domain/layout-spec/projector.js';
import { domToSpecShape } from '../../src/domain/layout-spec/dom-dom.js';
import type { LayoutSpec, DomSnapshotOk, SpecChild, DomChild } from '../../src/domain/layout-spec/types.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const fk = (x: number, w: number, id = '2:2'): SpecChild => ({ id, name: 'block', type: 'FRAME', rect: R(x, 0, w, 40) });
const dk = (x: number, w: number): DomChild => ({ kind: 'element', tag: 'div', rect: R(x, 0, w, 40) });

const spec = (children: SpecChild[], primaryAlign?: string, over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '2:1', name: 'row', type: 'FRAME' }, rect: R(0, 0, 300, 40), axis: 'row',
  autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 },
    ...(primaryAlign ? { primaryAlign } : {}) } as never,
  children, ...over,
});
const snap = (children: DomChild[], jc?: string, over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 1, status: 'ok', selector: '.row', innerWidth: 375,
  rect: R(0, 0, 300, 40), borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 300, clientHeight: 40, scrollHeight: 40,
  scroll: { top: 0, left: 0 }, transformed: false,
  ...(jc ? { styles: { display: 'flex', justifyContent: jc } } : {}),
  children, ...over,
});
const row = (rows: ReturnType<typeof diffPair>, prop: string) => rows.find((r) => r.prop === prop);
const opts = { tolerancePx: 1 } as const;

describe('the mismatch road: DOM distributes onto a design INTENT edge', () => {
  it('the incident: fig MIN (slack at the end) + DOM center -> padding-left FAILS with note+caveat+channel; padding-right demotes truthfully', () => {
    // fig packs at start (child 0..200, slack 100 at the end); DOM centers (child 50..250)
    const rows = diffPair(spec([fk(0, 200)], 'MIN'), snap([dk(50, 200)], 'center'), opts);
    const pl = row(rows, 'padding-left');
    expect(pl).toMatchObject({ figma: 0, dom: 50, status: 'fail' });
    expect(pl!.note).toMatch(/alignment mismatch/);
    expect(pl!.caveat).toBeDefined();                      // rides into fix_plan - the machine surface
    expect(pl!.srcChannel).toBeDefined();
    const pr = row(rows, 'padding-right');
    expect(pr!.status).toBe('demoted');                    // MIN leaves the slack THERE - the demote is TRUE
    expect(pr!.note).toMatch(/justify-content/);
    expect(pr!.note).not.toMatch(/alignment mismatch/);
  });

  it('zero slack under FIXED: the declared CENTER is inert, content pins the edges - the mismatch road fires with the inert wording', () => {
    // the live flagship shape: children fill the axis exactly (300), DOM centers narrower content
    const rows = diffPair(spec([fk(0, 300)], 'CENTER'), snap([dk(30, 240)], 'center'), opts);
    const pl = row(rows, 'padding-left');
    expect(pl!.status).toBe('fail');
    expect(pl!.note).toMatch(/no free space|inert/);
    expect(pl!.caveat).toBeDefined();
  });

  it('the no-op-centering green sibling: full-bleed child, numbers agree -> pass, NO note', () => {
    const rows = diffPair(spec([fk(0, 300)], 'MIN'), snap([dk(0, 300)], 'center'), opts);
    expect(row(rows, 'padding-left')).toMatchObject({ status: 'pass' });
    expect(row(rows, 'padding-left')!.note).toBeUndefined();
    expect(row(rows, 'padding-right')!.note).toBeUndefined();
  });

  it('the green criterion half: fig MIN + DOM flex-start, agreeing geometry -> both pass, no notes', () => {
    const rows = diffPair(spec([fk(0, 240)], 'MIN'), snap([dk(0, 240)], 'flex-start'), opts);
    expect(row(rows, 'padding-left')).toMatchObject({ status: 'pass' });
    expect(row(rows, 'padding-right')).toMatchObject({ status: 'pass' });
    expect(row(rows, 'padding-right')!.note).toBeUndefined();
  });
});

describe('the agreement roads: the design edge is slack - the demote stays, now evidence-based', () => {
  it('fig CENTER + DOM center -> demoted with the spacer note', () => {
    // fig centers (child 50..250, slack both sides); DOM centers differently (30..270)
    const rows = diffPair(spec([fk(50, 200)], 'CENTER'), snap([dk(30, 240)], 'center'), opts);
    expect(row(rows, 'padding-left')!.status).toBe('demoted');
    expect(row(rows, 'padding-left')!.note).toMatch(/justify-content/);
  });
  it('fig SPACE_BETWEEN + DOM space-between -> padding-end demoted (the carried conservatism)', () => {
    const rows = diffPair(spec([fk(0, 240)], 'SPACE_BETWEEN'), snap([dk(0, 300)], 'space-between'), opts);
    expect(row(rows, 'padding-right')!.status).toBe('demoted');
  });
  it('fig MAX + DOM flex-end -> padding-start demoted (slack at the start)', () => {
    const rows = diffPair(spec([fk(60, 240)], 'MAX'), snap([dk(0, 300)], 'flex-end'), opts);
    expect(row(rows, 'padding-left')!.status).toBe('demoted');
  });
  it('fig MIN + DOM space-between -> padding-end demoted (both sides say the end is slack)', () => {
    const rows = diffPair(spec([fk(0, 240)], 'MIN'), snap([dk(0, 300)], 'space-between'), opts);
    expect(row(rows, 'padding-right')!.status).toBe('demoted');
  });
});

describe('precedence: stronger demotes keep their veto - the attribution never lands on a demoted row', () => {
  it('hug/fill wins: the row demotes with the hug note, no alignment note', () => {
    const rows = diffPair(
      spec([fk(0, 200)], 'MIN', { hugWidth: true }),
      snap([dk(50, 200)], 'center', { rect: R(0, 0, 400, 40), clientWidth: 400 }), opts);
    const pl = row(rows, 'padding-left');
    expect(pl!.status).toBe('demoted');
    expect(pl!.note).toMatch(/hug/);
    expect(pl!.note ?? '').not.toMatch(/alignment mismatch/);
  });
  it('the encoding demote wins: reconciled row keeps only the encoding note', () => {
    // design declares 0 padding, children inset (structural encoding); DOM declares padding 50.
    // primaryAlign MIN makes the start edge INTENT (the justify demote is disallowed), so the
    // row reaches dualDemote and the encoding reconciliation demotes it - and the outermost
    // attribution must then keep its hands off the demoted row (wave: the original fixture
    // omitted primaryAlign, fired the JUSTIFY demote instead, and hid the assert behind an
    // if-guard - vacuous three times over).
    const rows = diffPair(
      spec([fk(50, 200, '2:2'), fk(260, 30, '2:3')], 'MIN'),
      snap([dk(50, 200), dk(260, 30)], 'center', { paddings: { top: 0, right: 0, bottom: 0, left: 50 } }), opts);
    const pl = row(rows, 'padding-left');
    expect(pl!.status).toBe('demoted');
    expect(pl!.note).toMatch(/encoding artifact/);
    expect(pl!.note ?? '').not.toMatch(/alignment mismatch/);
  });
});

describe('the END-edge half of the gate (wave lock: deleting the end allowance left the suite green)', () => {
  it('fig MAX (end pinned, slack at the start) + DOM space-between -> padding-end FAILS with the attribution', () => {
    // MAX packs children to the END: child 60..300, the slack 60 lives at the START. The end
    // edge is INTENT - a DOM that distributes free space onto it keeps a hard fail.
    const rows = diffPair(spec([fk(60, 240)], 'MAX'), snap([dk(0, 240)], 'space-between'), opts);
    const pr = row(rows, 'padding-right');
    expect(pr).toMatchObject({ figma: 0, dom: 60, status: 'fail' });
    expect(pr!.note).toMatch(/alignment mismatch/);
    expect(pr!.caveat).toBeDefined();
  });
});

describe('the domDistributes guard: no attribution without DOM distribution evidence', () => {
  it('a real padding defect under flex-start carries NO alignment note (jd false is not anchoring proof)', () => {
    // fig MIN with slack, DOM flex-start but inset 30 - a genuine padding defect; the
    // attribution must not appear (a note naming a justify-content value that distributes
    // nothing would be a false attribution).
    const rows = diffPair(spec([fk(0, 200)], 'MIN'), snap([dk(30, 200)], 'flex-start'), opts);
    const pl = row(rows, 'padding-left');
    expect(pl!.status).toBe('fail');
    expect(pl!.note ?? '').not.toMatch(/alignment mismatch/);
    expect(pl!.caveat).toBeUndefined();
  });
});

describe('the gap note under fig SPACE_BETWEEN', () => {
  it('the gap row carries the distribution note (note-only, no status change)', () => {
    const rows = diffPair(
      spec([fk(0, 100, '2:2'), fk(200, 100, '2:3')], 'SPACE_BETWEEN', { autoLayout: { padding: { top: 0, right: 0, bottom: 0, left: 0 }, gap: 20, primaryAlign: 'SPACE_BETWEEN' } as never }),
      snap([dk(0, 100), dk(200, 100)], 'space-between'), opts);
    const g = rows.find((r) => r.prop.startsWith('gap['));
    expect(g).toBeDefined();
    expect(g!.note ?? '').toMatch(/distribut/);
  });
});

describe('projection: primaryAlign lands only where it means something', () => {
  const raw = (over: Partial<RawSceneNode> = {}): RawSceneNode => ({
    id: '3:1', name: 'row', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 },
    layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'FIXED',
    children: [{ id: '3:2', name: 'a', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } }],
    ...over,
  } as RawSceneNode);
  const align = (r: RawSceneNode) => (buildLayoutSpec(r).autoLayout as { primaryAlign?: string } | undefined)?.primaryAlign;

  it('absent raw value under FIXED -> MIN materialized (REST omits the default - live-probed)', () => {
    expect(align(raw())).toBe('MIN');
  });
  it('present value under FIXED -> verbatim', () => {
    expect(align(raw({ primaryAxisAlignItems: 'CENTER' } as never))).toBe('CENTER');
  });
  it('an unknown value -> field ABSENT (fail-open to the compat road)', () => {
    expect(align(raw({ primaryAxisAlignItems: 'SPACE_EVENLY' } as never))).toBeUndefined();
  });
  it('AUTO sizing (the hug default) -> field ABSENT - alignment is inert without free space', () => {
    expect(align(raw({ primaryAxisSizingMode: 'AUTO' } as never))).toBeUndefined();
    expect(align(raw({ primaryAxisSizingMode: undefined } as never))).toBeUndefined();
  });
});

describe('dom-dom stays structurally one-sided', () => {
  it('the fabricated autoLayout never carries primaryAlign (key-presence lock)', () => {
    const ref = {
      schema: 1, status: 'ok', selector: '.row', innerWidth: 375,
      rect: R(0, 0, 300, 40), borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 4, right: 4, bottom: 4, left: 4 },
      scroll: { top: 0, left: 0 }, transformed: false,
      children: [dk(0, 100)],
    } as DomSnapshotOk;
    const shaped = domToSpecShape(ref);
    expect(shaped.autoLayout).toBeDefined();
    expect('primaryAlign' in (shaped.autoLayout as object)).toBe(false);
  });
});
