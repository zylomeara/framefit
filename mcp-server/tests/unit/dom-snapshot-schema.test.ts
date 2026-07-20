import { describe, it, expect } from 'vitest';
import { DomSnapshotSchema, DOM_SNAPSHOT_SCHEMA_VERSION, OkSchema } from '../../src/adapters/driving/tools/dom-snapshot-schema.js';

const okSnapshot = {
  schema: 5, status: 'ok', selector: '.reason', innerWidth: 375,
  rect: { x: 16, y: 100, w: 343, h: 120 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', backgroundColor: '#ffffff', borderRadius: 16, fontFamily: 'ABC Favorit', fontWeight: 700, fontSize: 18, lineHeight: 24, letterSpacing: 0, color: '#000000' },
  componentHints: { tag: 'div', classList: ['custom-radio'], data: {} },
  children: [
    { kind: 'element', tag: 'h2', classList: ['title'], rect: { x: 16, y: 112, w: 200, h: 24 }, styles: { fontSize: 18, fontWeight: 700, lineHeight: 24 } },
    { kind: 'text', rect: { x: 36, y: 150, w: 100, h: 20 }, text: 'Причина', styles: { fontSize: 16 } },
  ],
};

describe('DomSnapshotSchema', () => {
  it('accepts a full ok-snapshot and a failed snapshot', () => {
    expect(DomSnapshotSchema.safeParse(okSnapshot).success).toBe(true);
    expect(DomSnapshotSchema.safeParse({ status: 'not_found', selector: '.gone' }).success).toBe(true);
    expect(DomSnapshotSchema.safeParse({ status: 'multiple', selector: '.x', matches: 3 }).success).toBe(true);
  });

  it('accepts lineHeight/letterSpacing as "normal"', () => {
    const s = { ...okSnapshot, styles: { ...okSnapshot.styles, lineHeight: 'normal', letterSpacing: 'normal' } };
    expect(DomSnapshotSchema.safeParse(s).success).toBe(true);
  });

  it('rejects garbage: missing rect, unknown status', () => {
    expect(DomSnapshotSchema.safeParse({ schema: 1, innerWidth: 375, children: [] }).success).toBe(false);
    expect(DomSnapshotSchema.safeParse({ status: 'exploded' }).success).toBe(false);
  });

  it('schema version is a positive int and matches the sample', () => {
    expect(DOM_SNAPSHOT_SCHEMA_VERSION).toBe(5);
    expect(okSnapshot.schema).toBe(DOM_SNAPSHOT_SCHEMA_VERSION);
  });

  it('accepts additive calibration fields (paddings/client sizes) — at current schema version', () => {
    const s = {
      ...okSnapshot,
      paddings: { top: 16, right: 16, bottom: 146, left: 16 },
      clientWidth: 398, clientHeight: 900, scrollHeight: 1600,
      children: [
        { kind: 'element', tag: 'h2', rect: { x: 16, y: 112, w: 200, h: 24 },
          paddings: { top: 0, right: 0, bottom: 28, left: 0 } },
      ],
    };
    const parsed = DomSnapshotSchema.safeParse(s);
    expect(parsed.success).toBe(true);
    expect((parsed as { data: { paddings?: unknown } }).data.paddings).toBeDefined();
    expect(DOM_SNAPSHOT_SCHEMA_VERSION).toBe(5);
  });

  it('v2: accepts authored-binding token state on styles / borderColorsToken / shadow.colorToken / text child', () => {
    const s = {
      ...okSnapshot,
      styles: { ...okSnapshot.styles, colorToken: { token: '--accent' }, backgroundColorToken: { literal: true } },
      borderColorsToken: { top: { unknown: 'cross-origin' }, left: { token: '--border' } },
      shadow: { inset: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#0000001a', colorToken: { unknown: 'inherited' }, count: 1 },
      children: [
        { kind: 'text', rect: { x: 0, y: 0, w: 10, h: 10 }, text: 'x', styles: { fontSize: 14, colorToken: { token: '--fg' } } },
      ],
    };
    expect(DomSnapshotSchema.safeParse(s).success).toBe(true);
  });

  it('v2: rejects a malformed token state (unknown reason must be a string)', () => {
    const s = { ...okSnapshot, styles: { ...okSnapshot.styles, colorToken: { unknown: 123 } } };
    expect(DomSnapshotSchema.safeParse(s).success).toBe(false);
  });

  it('micro: hidden variant, children > 50, non-integer schema are handled', () => {
    expect(DomSnapshotSchema.safeParse({ status: 'hidden', selector: '.x' }).success).toBe(true);
    const many = { ...okSnapshot, children: Array.from({ length: 51 }, () => okSnapshot.children[0]) };
    expect(DomSnapshotSchema.safeParse(many).success).toBe(false); // .max(30) (unified with MAX_SPEC_CHILDREN)
    expect(DomSnapshotSchema.safeParse({ ...okSnapshot, schema: 1.5 }).success).toBe(false); // .int()
  });

  it('accepts recursive nested children; enforces per-level 15, root 30 caps', () => {
    const leaf = { kind: 'element' as const, tag: 'i', rect: { x: 0, y: 0, w: 5, h: 5 }, children: [] };
    const nested = { ...okSnapshot, children: [
      { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 50 }, children: [leaf, { ...leaf, tag: 'b' }] },
    ] };
    const parsed = DomSnapshotSchema.safeParse(nested);
    expect(parsed.success).toBe(true);
    expect((parsed as { data: { children: { children?: unknown[] }[] } }).data.children[0].children).toHaveLength(2);

    const over15 = { ...okSnapshot, children: [
      { kind: 'element', tag: 'div', rect: leaf.rect, children: Array.from({ length: 16 }, () => leaf) },
    ] };
    expect(DomSnapshotSchema.safeParse(over15).success).toBe(false);

    const over30root = { ...okSnapshot, children: Array.from({ length: 31 }, () => leaf) };
    expect(DomSnapshotSchema.safeParse(over30root).success).toBe(false);
  });

  it('total-node cap is 300 (budget-scale — deep max_depth drill-down): 120 (within budgetFor(6)=180) accepted, >300 rejected', () => {
    const leaf = { kind: 'element' as const, tag: 'i', rect: { x: 0, y: 0, w: 5, h: 5 }, children: [] };

    // 8 root × (1 + 14 nested leaves) = 8*15 = 120 total — a deep drill-down snapshot that
    // fits within budgetFor(6)=180 (projector.ts), well over the OLD 90 cap, under the new 300.
    const deepDrilldown120 = { ...okSnapshot, children: Array.from({ length: 8 }, () => (
      { kind: 'element', tag: 'div', rect: leaf.rect, children: Array.from({ length: 14 }, () => leaf) }
    )) };
    expect(DomSnapshotSchema.safeParse(deepDrilldown120).success).toBe(true);

    // 30 root × (1 + 15 nested leaves) = 30*16 = 480 total — both per-level caps (30, 15) are
    // respected individually, but the sum blows past the 300 static backstop.
    const over300total = { ...okSnapshot, children: Array.from({ length: 30 }, () => (
      { kind: 'element', tag: 'div', rect: leaf.rect, children: Array.from({ length: 15 }, () => leaf) }
    )) };
    const result = DomSnapshotSchema.safeParse(over300total);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('snapshot exceeds 300 nodes total'))).toBe(true);
    }
  });

  // Exact off-by-one at the static backstop itself — the 120/480 test
  // above proves the cap is somewhere between "clearly within" and "clearly over", this proves
  // it's precisely 300, not 299 or 301. Both fixtures respect the per-level caps individually
  // (root <=30, nested <=15) — only the SUM crosses the boundary.
  it('styles.justifyContent is accepted (additive); an old snapshot without it stays valid', () => {
    const base = { schema: 1, status: 'ok', innerWidth: 375, rect: { x: 0, y: 0, w: 100, h: 20 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, children: [] };
    const parsed = DomSnapshotSchema.parse({ ...base, styles: { display: 'flex', justifyContent: 'space-between' } });
    expect((parsed as any).styles.justifyContent).toBe('space-between');
    expect(DomSnapshotSchema.safeParse(base).success).toBe(true); // without justifyContent — still ok
  });

  it('total-node cap boundary: exactly 300 accepted, 301 rejected (off-by-one lock)', () => {
    const leaf = { kind: 'element' as const, tag: 'i', rect: { x: 0, y: 0, w: 5, h: 5 }, children: [] };

    // 20 roots × (1 + 14 nested leaves) = 20*15 = 300 exactly.
    const exactly300 = { ...okSnapshot, children: Array.from({ length: 20 }, () => (
      { kind: 'element', tag: 'div', rect: leaf.rect, children: Array.from({ length: 14 }, () => leaf) }
    )) };
    expect(DomSnapshotSchema.safeParse(exactly300).success).toBe(true);

    // Same shape, but the LAST root carries one extra nested leaf (15, still within the
    // per-level cap) — total 19*15 + 16 = 301, one over the backstop.
    const exactly301 = { ...okSnapshot, children: Array.from({ length: 20 }, (_, i) => (
      { kind: 'element', tag: 'div', rect: leaf.rect, children: Array.from({ length: i === 19 ? 15 : 14 }, () => leaf) }
    )) };
    const result = DomSnapshotSchema.safeParse(exactly301);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('snapshot exceeds 300 nodes total'))).toBe(true);
    }
  });

  it('v5: DomChild accepts the style bundle (radius/gradient/shadow/borders/data)', () => {
    const snap = { schema: 5, innerWidth: 100, rect: { x: 0, y: 0, w: 10, h: 10 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 },
      children: [{ kind: 'element', rect: { x: 0, y: 0, w: 10, h: 10 },
        styles: { borderRadius: 24, opacity: 0.5, gradient: { kind: 'conic', stops: [], whole: { literal: true } } },
        shadow: { inset: false, x: 0, y: 1, blur: 2, spread: 0, count: 1 },
        borders: { top: 1, right: 1, bottom: 1, left: 1 },
        data: { component: 'Banner' } }] };
    expect(DomSnapshotSchema.safeParse(snap).success).toBe(true);
  });
});

describe('gradient schema', () => {
  it('version bumped to 5', () => { expect(DOM_SNAPSHOT_SCHEMA_VERSION).toBe(5); });
  it('accepts a valid gradient in styles', () => {
    const snap = { schema: 5, status: 'ok', innerWidth: 1200, rect: { x:0,y:0,w:10,h:10 },
      borders: { top:0,right:0,bottom:0,left:0 }, scroll: { top:0,left:0 }, children: [],
      styles: { gradient: { kind: 'linear', angleDeg: 270,
        stops: [{ position: 0, hex: '#20a1b0', token: { literal: true } },
                { position: 1, hex: '#5785d5', token: { token: '--stop2' } }],
        whole: { token: '--brand-gradient' } } } };
    expect(OkSchema.safeParse(snap).success).toBe(true);
  });
  it('rejects gradient without kind', () => {
    const bad = { schema: 5, status: 'ok', innerWidth: 1, rect:{x:0,y:0,w:1,h:1}, borders:{top:0,right:0,bottom:0,left:0}, scroll:{top:0,left:0}, children:[],
      styles: { gradient: { stops: [], whole: { literal: true } } } };
    expect(OkSchema.safeParse(bad).success).toBe(false);
  });
});
