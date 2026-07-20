import { describe, it, expect } from 'vitest';
import { rgbaToHex, parseGradient } from '../../src/domain/design-context/color.js';
import { GlobalVarStore } from '../../src/domain/design-context/global-vars.js';

describe('rgbaToHex', () => {
  it('converts 0..1 channels to #rrggbb', () => {
    expect(rgbaToHex({ r: 1, g: 0, b: 0 })).toBe('#ff0000');
    expect(rgbaToHex({ r: 0, g: 0.5019607843, b: 0 })).toBe('#008000');
  });
  it('appends alpha when a<1', () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
  });
});

describe('GlobalVarStore', () => {
  it('dedups identical values to one ref; distinct values get new refs', () => {
    const s = new GlobalVarStore();
    const a = s.intern('fill', '#ff0000');
    const b = s.intern('fill', '#ff0000');
    const c = s.intern('fill', '#00ff00');
    expect(a).toBe(b);
    expect(a).toBe('fill_0');
    expect(c).toBe('fill_1');
    expect(s.dump()).toEqual({ fill_0: '#ff0000', fill_1: '#00ff00' });
  });
  it('namespaces by prefix', () => {
    const s = new GlobalVarStore();
    expect(s.intern('fill', '#000')).toBe('fill_0');
    expect(s.intern('text', { fontSize: 12 })).toBe('text_0');
  });
});

describe('parseGradient', () => {
  it('returns null for non-gradient paint', () => {
    expect(parseGradient({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } })).toBeNull();
  });

  it('returns null for gradient with no stops', () => {
    expect(parseGradient({ type: 'GRADIENT_LINEAR', gradientStops: [] })).toBeNull();
  });

  it('parses a 3-stop GRADIENT_LINEAR with handles into angle=90', () => {
    const paint = {
      type: 'GRADIENT_LINEAR',
      gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      gradientStops: [
        { position: 0,   color: { r: 1, g: 0, b: 0 } },
        { position: 0.5, color: { r: 0, g: 1, b: 0 } },
        { position: 1,   color: { r: 0, g: 0, b: 1 } },
      ],
    };
    expect(parseGradient(paint)).toEqual({
      type: 'linear',
      angle: 90,
      stops: [
        { position: 0,   color: '#ff0000' },
        { position: 0.5, color: '#00ff00' },
        { position: 1,   color: '#0000ff' },
      ],
    });
  });

  it('returns no angle when gradient handles are coincident (zero-length gradient)', () => {
    const paint = {
      type: 'GRADIENT_LINEAR',
      gradientHandlePositions: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }],
      gradientStops: [
        { position: 0, color: { r: 0, g: 0, b: 0 } },
        { position: 1, color: { r: 1, g: 1, b: 1 } },
      ],
    };
    const g = parseGradient(paint);
    expect(g).not.toBeNull();
    expect(g).not.toHaveProperty('angle');
  });

  it('parses GRADIENT_RADIAL without angle', () => {
    const paint = {
      type: 'GRADIENT_RADIAL',
      gradientStops: [
        { position: 0, color: { r: 0, g: 0, b: 0 } },
        { position: 1, color: { r: 1, g: 1, b: 1 } },
      ],
    };
    expect(parseGradient(paint)).toMatchObject({
      type: 'radial',
      stops: [{ position: 0, color: '#000000' }, { position: 1, color: '#ffffff' }],
    });
    expect(parseGradient(paint)).not.toHaveProperty('angle');
  });
});
