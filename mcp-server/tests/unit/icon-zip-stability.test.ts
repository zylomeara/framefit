// Batch 2 item 3 (panel-locked, 27 findings): ONE node compared in three pairs of one call
// gave three different DOM icon-colors - the root pair's icon inventory hit the shared DFS
// item cap, and the EQUAL-COUNT clamped inventory zipped positionally as if aligned: a
// foreign svg earlier in DOM document order shifted the prefix and a foreign color was
// attributed to the labeled icon; the true value (a REAL defect) was dismissed as a pairing
// artifact. Panel corrections baked in here: the trigger is the CAP CLAMP (a new `capped`
// flag set exactly where the scan stops), NOT `truncated` (which any depth-cut wrapper
// raises - the majority of deep pairs; the existing zip+tail behavior for subtree cuts stays
// byte-for-byte); the order guard VERIFIES and never re-orders (consecutive fig deltas with
// evidence must agree in sign with the dom deltas - ties/no-evidence produce no claim);
// no similarity floor and no scorePair (geometry is blind exactly when a foreign icon takes
// a missing twin's slot - a closed decision, the residual is made VISIBLE by naming the
// dom carrier in the note instead). The root-is-icon site gains the missing
// !nested.truncated gate. Fixtures are invented; hexes are arbitrary.
import { describe, it, expect } from 'vitest';
import { diffPair, summarize, deriveCoverage } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import type { LayoutSpec, DomSnapshotOk, DomChild, SpecChild } from '../../src/domain/layout-spec/types.js';

const figIcon = (id: string, x: number, hex: string): SpecChild =>
  ({ id, name: `glyph${id.split(':')[1]}`, type: 'INSTANCE', rect: { x, y: 8, w: 16, h: 16 }, iconHex: hex });
const domIcon = (x: number, hex: string, over: Partial<DomChild> = {}): DomChild =>
  ({ kind: 'element', tag: 'svg', rect: { x, y: 8, w: 16, h: 16 }, styles: { iconColor: hex }, ...over });

const figWrap = (kids: SpecChild[], over: Partial<SpecChild> = {}): SpecChild =>
  ({ id: '4:2', name: 'cell', type: 'FRAME', rect: { x: 0, y: 0, w: 600, h: 32 }, children: kids, ...over });
const domWrap = (kids: DomChild[], over: Partial<DomChild> = {}): DomChild =>
  ({ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 600, h: 32 }, children: kids, ...over });

const spec = (kids: SpecChild[], over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  node: { id: '4:1', name: 'Row', type: 'FRAME' },
  rect: { x: 0, y: 0, w: 640, h: 32 }, axis: 'row',
  autoLayout: { gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  children: kids, ...over,
});
const snap = (kids: DomChild[], over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.row', innerWidth: 1280,
  rect: { x: 0, y: 0, w: 640, h: 32 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 640, clientHeight: 32, scrollHeight: 32,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex' },
  children: kids, ...over,
});
const iconRows = (rows: ReturnType<typeof diffPair>) => rows.filter((r) => r.prop.startsWith('icon-color'));
const values = (rows: ReturnType<typeof diffPair>) => iconRows(rows).filter((r) => r.status !== 'unchecked');
const HEX = (i: number) => `#1010${(16 + i).toString(16).padStart(2, '0')}`;
const figN = (n: number) => Array.from({ length: n }, (_, i) => figIcon(`5:${i + 10}`, 8 + i * 24, HEX(i)));
const domN = (n: number) => Array.from({ length: n }, (_, i) => domIcon(8 + i * 24, HEX(i)));
const verify = (rows: ReturnType<typeof diffPair>, depthLevels = 4) => buildVerification(
  [{ node_id: '4:1', rows, summary: summarize(rows), coverage: deriveCoverage(rows) }], { depthLevels, tolerancePx: 1 });

describe('the cap clamp: equal counts under the cap are a coincidence, never an alignment', () => {
  it('the incident: both sides clamp to 15 with a FOREIGN svg first - no value rows, one honest refusal', () => {
    // fig: 16 icons; dom: a foreign svg then the 16 twins - both scans stop at 15, counts
    // equal, and TODAY the zip attributes the foreign color to the first labeled icon.
    const foreign = domIcon(2, '#c1c2d3');
    const rows = diffPair(spec([figWrap(figN(16))]), snap([domWrap([foreign, ...domN(16).map((d) => ({ ...d, rect: { ...d.rect, x: d.rect.x + 6 } }))])]), { tolerancePx: 1 });
    expect(values(rows)).toEqual([]);                      // the misattribution road is gone
    const un = iconRows(rows).filter((r) => r.status === 'unchecked');
    expect(un).toHaveLength(1);
    expect(un[0].note).toMatch(/cap|clamp/i);
    expect(verify(rows).complete).toBe(false);
  });

  it('boundary: 14 per side zips byte-identically; 15 sets the cap flag and refuses', () => {
    const ok = diffPair(spec([figWrap(figN(14))]), snap([domWrap(domN(14))]), { tolerancePx: 1 });
    expect(values(ok)).toHaveLength(14);
    expect(iconRows(ok).filter((r) => r.status === 'unchecked')).toEqual([]);
    const capped = diffPair(spec([figWrap(figN(15))]), snap([domWrap(domN(15))]), { tolerancePx: 1 });
    expect(values(capped)).toEqual([]);                    // the conservative flag - accepted cost
    expect(iconRows(capped).filter((r) => r.status === 'unchecked')).toHaveLength(1);
  });

  it('per-child scope: a capped sibling does not kill the other child\'s values', () => {
    const rows = diffPair(
      spec([figWrap(figN(15)), figWrap([figIcon('6:1', 8, '#101010')], { id: '4:3', name: 'cell2', rect: { x: 600, y: 0, w: 40, h: 32 } })]),
      snap([domWrap(domN(15)), domWrap([domIcon(8, '#202020')], { rect: { x: 600, y: 0, w: 40, h: 32 } })]), { tolerancePx: 1 });
    expect(values(rows)).toHaveLength(1);                  // cell2's 1v1 still measured
    expect(values(rows)[0].status).toBe('fail');           // 101010 vs 202020 - a real row
  });

  it('a subtree cut WITHOUT the cap keeps today\'s zip + tail row (the anti-flood coverage lock)', () => {
    const rows = diffPair(
      spec([figWrap([figIcon('6:1', 8, '#101010')], { childrenTruncated: true })]),
      snap([domWrap([domIcon(8, '#101010')])]), { tolerancePx: 1 });
    expect(values(rows).some((r) => r.status === 'pass')).toBe(true);
    expect(iconRows(rows).some((r) => r.status === 'unchecked' && /beyond the cut/.test(r.note ?? ''))).toBe(true);
  });

  it('zero icons on both sides + a nested cut -> NO icon-color row at all (the flood fix)', () => {
    const rows = diffPair(
      spec([figWrap([], { childrenTruncated: true })]),
      snap([domWrap([])]), { tolerancePx: 1 });
    expect(iconRows(rows)).toEqual([]);
    // the gate does NOT leak away with the row: the pair-level truncation warn still holds it
    expect(rows.some((r) => r.prop === 'children_truncated')).toBe(true);
    expect(verify(rows).complete).toBe(false);
  });

  it('blocking routes by cause and depth: raise at <=4, pairs at >=5, re-extract for the dom side', () => {
    const figCap = diffPair(spec([figWrap(figN(15))]), snap([domWrap(domN(15))]), { tolerancePx: 1 });
    expect(verify(figCap, 4).blocking.some((b) => b.action === 'raise_max_depth')).toBe(true);
    const figCapDeep = diffPair(spec([figWrap(figN(31))]), snap([domWrap(domN(31))]), { tolerancePx: 1, maxDepth: 6 });
    const v6 = verify(figCapDeep, 6);
    expect(v6.blocking.some((b) => b.action === 'add_pairs_on_children')).toBe(true);
    expect(v6.blocking.some((b) => b.action === 'raise_max_depth')).toBe(false);
  });
});

describe('the order-agreement guard: verify, never re-order', () => {
  it('a descent-level reversed pair refuses instead of swapping the colors', () => {
    // fig: two icons left-to-right; dom: the SAME two icons in reversed document order.
    // Today the zip swaps the hexes (false attribution both ways); the guard sees the fig
    // x-delta (+24) disagree in sign with the dom x-delta (-24) and refuses.
    const rows = diffPair(
      spec([figWrap([figIcon('6:1', 8, '#101010'), figIcon('6:2', 32, '#202020')])]),
      snap([domWrap([domIcon(32, '#202020'), domIcon(8, '#101010')])]), { tolerancePx: 1 });
    expect(values(rows)).toEqual([]);
    const un = iconRows(rows).filter((r) => r.status === 'unchecked');
    expect(un).toHaveLength(1);
    expect(un[0].note).toMatch(/order/);
  });

  it('agreeing order zips with the right hexes (and reds under a guard-removal mutant only via the reversed twin)', () => {
    const rows = diffPair(
      spec([figWrap([figIcon('6:1', 8, '#101010'), figIcon('6:2', 32, '#202020')])]),
      snap([domWrap([domIcon(8, '#101010'), domIcon(32, '#202020')])]), { tolerancePx: 1 });
    expect(values(rows)).toHaveLength(2);
    expect(values(rows).every((r) => r.status === 'pass')).toBe(true);
  });

  it('no geometric evidence (stacked icons) -> no claim, the zip proceeds as today', () => {
    const rows = diffPair(
      spec([figWrap([figIcon('6:1', 8, '#101010'), { ...figIcon('6:2', 8, '#202020'), rect: { x: 8, y: 8, w: 16, h: 16 } }])]),
      snap([domWrap([domIcon(8, '#101010'), domIcon(8, '#202020')])]), { tolerancePx: 1 });
    expect(values(rows)).toHaveLength(2);                  // ties carry no refusal
  });
});

describe('the criterion: one node, several pairs, ONE value (or an honest refusal)', () => {
  it('a wide pair with agreeing order and a narrow pair yield the SAME dom hex for the labeled icon', () => {
    const sharedDom = [domIcon(8, '#101010'), domIcon(32, '#202020')];
    const wide = diffPair(
      spec([figWrap([figIcon('6:1', 8, '#101010'), figIcon('6:2', 32, '#909090')])]),
      snap([domWrap(sharedDom)]), { tolerancePx: 1 });
    const narrow = diffPair(
      spec([{ ...figIcon('6:2', 32, '#909090'), rect: { x: 32, y: 8, w: 16, h: 16 } }], { rect: { x: 24, y: 0, w: 32, h: 32 } }),
      snap([sharedDom[1]], { rect: { x: 24, y: 0, w: 32, h: 32 } }), { tolerancePx: 1 });
    const wideRow = values(wide).find((r) => r.prop.includes('glyph2'));
    const narrowRow = values(narrow)[0];
    expect(wideRow?.dom).toBe('#202020');
    expect(narrowRow?.dom).toBe('#202020');               // no third value anywhere
  });
});

describe('carrier visibility (the incident cost was not seeing WHERE a hex came from)', () => {
  it('a descent-found dom carrier is named in the row note', () => {
    const carrier = domWrap([domIcon(8, '#101010', { classList: ['icon-slot'] })], { rect: { x: 0, y: 0, w: 32, h: 32 } });
    const rows = diffPair(
      spec([figWrap([figIcon('6:1', 8, '#909090')], { rect: { x: 0, y: 0, w: 32, h: 32 } })]),
      snap([carrier]), { tolerancePx: 1 });
    const r = values(rows)[0];
    expect(r?.status).toBe('fail');
    expect(r?.note ?? '').toMatch(/icon-slot/);            // the carrier CLASS is named, not just the tag
  });
});

describe('the root-is-icon site respects truncation', () => {
  it('a fig root icon over a CUT dom wrapper with one captured svg refuses instead of comparing', () => {
    const rows = diffPair(
      spec([], { iconHex: '#909090', rect: { x: 0, y: 0, w: 32, h: 32 } }),
      snap([domWrap([domIcon(8, '#c1c2d3')], { children: [domIcon(8, '#c1c2d3')], childrenTruncated: true, rect: { x: 0, y: 0, w: 32, h: 32 } })],
        { rect: { x: 0, y: 0, w: 32, h: 32 } }), { tolerancePx: 1 });
    const r = rows.find((x) => x.prop === 'icon-color');
    expect(r?.status).toBe('unchecked');
    expect(r?.note ?? '').toMatch(/beyond the cut|twin/);
  });
});
