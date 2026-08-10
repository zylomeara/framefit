// Phase 2 of the icon-color axis (feedback item 6): the projector learns to read an icon's
// painted color on the Figma side. Panel-locked rules: paint inventory walks the RAW subtree,
// not inFlowChildren (zero-area LINEs and absolute glyphs vanish from a layout filter);
// GROUP/FRAME/INSTANCE are transparent containers, leaves must be vector-class, TEXT or an
// image fill anywhere -> not an icon; fill -> none => stroke (Figma paints outline icons with
// STROKE); alpha folds paint alpha x the node opacity chain into the 8-digit-hex convention;
// a FILLED node whose bbox ~= the candidate's bbox is the plate, kept out of the glyph set;
// a cut subtree emits NOTHING (the diff derives unknown-because-cut from childrenTruncated).
import { describe, it, expect } from 'vitest';
import { buildLayoutSpec } from '../../src/domain/layout-spec/projector.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

let nextId = 0;
function node(type: string, over: Partial<RawSceneNode> = {}): RawSceneNode {
  return {
    id: `1:${nextId++}`, name: type.toLowerCase(), type,
    absoluteBoundingBox: { x: 0, y: 0, width: 16, height: 16 },
    ...over,
  } as RawSceneNode;
}
const solid = (hex: string, a = 1, opacity?: number) => ({
  type: 'SOLID',
  color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a },
  ...(opacity !== undefined ? { opacity } : {}),
});
const vec = (hex: string, over: Partial<RawSceneNode> = {}) =>
  node('VECTOR', { fills: [solid(hex)], ...over });
// A frame root the icon candidate sits in: children get projected, the candidate is child[0].
const frameWith = (kids: RawSceneNode[]) =>
  node('FRAME', { absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 }, children: kids });
const icon = (kids: RawSceneNode[], over: Partial<RawSceneNode> = {}) =>
  node('INSTANCE', { children: kids, ...over });

describe('fig icon paint projection (phase 2)', () => {
  it('an INSTANCE of same-fill vectors -> iconHex on the projected child', () => {
    const spec = buildLayoutSpec(frameWith([icon([vec('#242429'), vec('#242429')])]));
    expect(spec.children[0].iconHex).toBe('#242429');
    expect(spec.children[0].iconMulti).toBeUndefined();
  });
  it('differing vector fills -> iconMulti, never a confident hex', () => {
    const spec = buildLayoutSpec(frameWith([icon([vec('#242429'), vec('#6c5dd3')])]));
    expect(spec.children[0].iconHex).toBeUndefined();
    expect(spec.children[0].iconMulti).toBe(true);
  });
  it('outline icons: no fill -> the STROKE carries the color', () => {
    const outline = node('VECTOR', { strokes: [solid('#242429')] });
    const spec = buildLayoutSpec(frameWith([icon([outline])]));
    expect(spec.children[0].iconHex).toBe('#242429');
  });
  it('zero-area LINE with a stroke is counted (the raw walk, not a layout filter)', () => {
    const line = node('LINE', { strokes: [solid('#242429')], absoluteBoundingBox: { x: 0, y: 8, width: 16, height: 0 } });
    const spec = buildLayoutSpec(frameWith([icon([line])]));
    expect(spec.children[0].iconHex).toBe('#242429');
  });
  it('alpha folds: color.a x paint opacity x node opacity chain -> 8-digit hex', () => {
    // 0.5 (color.a) * 0.6 (paint opacity) * 0.8 (vector opacity) = 0.24 -> 0x3d
    const faded = node('VECTOR', { fills: [solid('#111111', 0.5, 0.6)], opacity: 0.8 });
    const spec = buildLayoutSpec(frameWith([icon([faded])]));
    expect(spec.children[0].iconHex).toBe('#1111113d');
  });
  it('a gradient-painted part -> an explicit iconUnknown, never silence', () => {
    const grad = node('VECTOR', { fills: [{ type: 'GRADIENT_LINEAR' } as never] });
    const spec = buildLayoutSpec(frameWith([icon([grad])]));
    expect(spec.children[0].iconHex).toBeUndefined();
    expect(typeof spec.children[0].iconUnknown).toBe('string');
  });
  it('TEXT anywhere in the subtree -> not an icon, no fields', () => {
    const spec = buildLayoutSpec(frameWith([icon([vec('#242429'), node('TEXT')])]));
    expect(spec.children[0].iconHex).toBeUndefined();
    expect(spec.children[0].iconUnknown).toBeUndefined();
  });
  it('an image fill anywhere -> not an icon (content, not decoration)', () => {
    const img = node('RECTANGLE', { fills: [{ type: 'IMAGE' } as never] });
    const spec = buildLayoutSpec(frameWith([icon([vec('#242429'), img])]));
    expect(spec.children[0].iconHex).toBeUndefined();
  });
  it('the plate is kept OUT of the glyph set (a badge: full-bbox circle + glyph)', () => {
    const plate = node('ELLIPSE', { fills: [solid('#e02020')], absoluteBoundingBox: { x: 0, y: 0, width: 16, height: 16 } });
    const glyph = node('VECTOR', { fills: [solid('#ffffff')], absoluteBoundingBox: { x: 4, y: 4, width: 8, height: 8 } });
    const spec = buildLayoutSpec(frameWith([icon([plate, glyph])]));
    expect(spec.children[0].iconHex).toBe('#ffffff');
    expect(spec.children[0].iconMulti).toBeUndefined();
  });
  it('a plate-only icon (a status dot) falls back to the plate color', () => {
    const dot = node('ELLIPSE', { fills: [solid('#2ecc71')] });
    const spec = buildLayoutSpec(frameWith([icon([dot])]));
    expect(spec.children[0].iconHex).toBe('#2ecc71');
  });
  it('vectors nested in a transparent GROUP are surveyed', () => {
    const spec = buildLayoutSpec(frameWith([icon([node('GROUP', { children: [vec('#242429')] })])]));
    expect(spec.children[0].iconHex).toBe('#242429');
  });
  it('a container cut by the fetch depth emits NOTHING (unknown lives on childrenTruncated)', () => {
    const cut = node('FRAME', { children: undefined });
    const spec = buildLayoutSpec(frameWith([icon([cut])]));
    expect(spec.children[0].iconHex).toBeUndefined();
    expect(spec.children[0].iconUnknown).toBeUndefined();
    expect(spec.children[0].iconMulti).toBeUndefined();
  });
  it('paint-less vector leaves -> an honest iconUnknown, not silence and not a color', () => {
    const bare = node('VECTOR');
    const spec = buildLayoutSpec(frameWith([icon([bare])]));
    expect(spec.children[0].iconUnknown).toMatch(/no painted parts/);
  });
  it('a bound carrier resolves through the injected resolver -> iconToken', () => {
    const bound = vec('#242429');
    const spec = buildLayoutSpec(frameWith([icon([bound])]), {
      resolveColorToken: (n, key) => (n.id === bound.id && key === 'fills' ? { token: '--icon-neutral', hex: '#242429' } : undefined),
    });
    expect(spec.children[0].iconHex).toBe('#242429');
    expect(spec.children[0].iconToken).toEqual({ token: '--icon-neutral', hex: '#242429' });
  });
  it('the pair ROOT itself an icon -> the same fields on the spec root', () => {
    const spec = buildLayoutSpec(icon([vec('#242429')]));
    expect(spec.iconHex).toBe('#242429');
  });
  it('a BARE rect/ellipse/line child is a style box, never an icon (dividers shifted the zip)', () => {
    for (const t of ['RECTANGLE', 'ELLIPSE', 'LINE']) {
      const divider = node(t, { fills: [solid('#e0e0e0')] });
      const spec = buildLayoutSpec(frameWith([divider]));
      expect(spec.children[0].iconHex, t).toBeUndefined();
      expect(spec.children[0].iconUnknown, t).toBeUndefined();
    }
  });
  it('the candidate\'s OWN fill is the plate: a tinted icon-button reads the glyph, not multi', () => {
    const glyph = node('VECTOR', { fills: [solid('#ffffff')], absoluteBoundingBox: { x: 4, y: 4, width: 8, height: 8 } });
    const tinted = icon([glyph], { fills: [solid('#6c5dd3')] });
    const spec = buildLayoutSpec(frameWith([tinted]));
    expect(spec.children[0].iconHex).toBe('#ffffff');
    expect(spec.children[0].iconMulti).toBeUndefined();
  });
  it('a full-bleed DRAWN glyph is never demoted to plate (its color wins, not an accent dot)', () => {
    const check = node('VECTOR', { fills: [solid('#242429')], absoluteBoundingBox: { x: 0, y: 0, width: 16, height: 16 } });
    const dot = node('ELLIPSE', { fills: [solid('#e02020')], absoluteBoundingBox: { x: 12, y: 0, width: 4, height: 4 } });
    const spec = buildLayoutSpec(frameWith([icon([check, dot])]));
    // both are glyph-set members with differing hexes -> honest multi, NOT the dot's color
    expect(spec.children[0].iconHex).toBeUndefined();
    expect(spec.children[0].iconMulti).toBe(true);
  });
  it('a PARTIALLY cut subtree claims nothing (the cut guard is load-bearing)', () => {
    const seen = vec('#242429');
    const deeper = node('FRAME', { children: undefined });
    const spec = buildLayoutSpec(frameWith([icon([seen, deeper])]));
    expect(spec.children[0].iconHex).toBeUndefined();
    expect(spec.children[0].iconMulti).toBeUndefined();
    expect(spec.children[0].iconUnknown).toBeUndefined();
  });
  it('one readable part + one gradient part -> unknown, the hex is never claimed', () => {
    const grad = node('VECTOR', { fills: [{ type: 'GRADIENT_LINEAR' } as never] });
    const spec = buildLayoutSpec(frameWith([icon([vec('#242429'), grad])]));
    expect(spec.children[0].iconHex).toBeUndefined();
    expect(spec.children[0].iconUnknown).toMatch(/unreadable/);
  });
  it('invisible layers and invisible paints contribute nothing', () => {
    const hiddenLayer = node('VECTOR', { fills: [solid('#ff0000')], visible: false });
    const hiddenPaint = node('VECTOR', { fills: [{ ...solid('#ff0000'), visible: false } as never] });
    const spec = buildLayoutSpec(frameWith([icon([hiddenLayer, hiddenPaint, vec('#242429')])]));
    expect(spec.children[0].iconHex).toBe('#242429');
    expect(spec.children[0].iconMulti).toBeUndefined();
  });
  it('the token hex folds the SAME alpha as iconHex (paint opacity x node chain)', () => {
    const bound = node('VECTOR', { fills: [{ ...solid('#242429'), opacity: 0.5 } as never], opacity: 0.8 });
    const spec = buildLayoutSpec(frameWith([icon([bound])]), {
      resolveColorToken: (n, key) => (n.id === bound.id && key === 'fills' ? { token: '--icon-neutral', hex: '#242429' } : undefined),
    });
    // 0.5 * 0.8 = 0.4 -> 0x66 on BOTH the raw hex and the token hex
    expect(spec.children[0].iconHex).toBe('#24242966');
    expect(spec.children[0].iconToken?.hex).toBe('#24242966');
  });
  it('an ordinary text-bearing card carries NO icon fields (absence stays meaningful)', () => {
    const card = node('FRAME', { children: [node('TEXT'), node('RECTANGLE', { fills: [solid('#ffffff')] })] });
    const spec = buildLayoutSpec(frameWith([card]));
    expect(spec.children[0].iconHex).toBeUndefined();
    expect(spec.iconHex).toBeUndefined();
  });
});
