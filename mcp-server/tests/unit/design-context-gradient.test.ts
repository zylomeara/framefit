import { describe, it, expect } from 'vitest';
import { simplify } from '../../src/domain/design-context/simplify.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

describe('simplify gradient fills', () => {
  it('interns a GRADIENT_LINEAR paint as a Gradient object into globalVars', () => {
    const node: RawSceneNode = {
      id: '1:1', name: 'Box', type: 'RECTANGLE',
      fills: [{
        type: 'GRADIENT_LINEAR',
        gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
        gradientStops: [
          { position: 0,   color: { r: 1, g: 0, b: 0 } },
          { position: 0.5, color: { r: 0, g: 1, b: 0 } },
          { position: 1,   color: { r: 0, g: 0, b: 1 } },
        ],
      }],
    };
    const { node: out, globalVars } = simplify(node);
    expect(out.fill).toBe('fill_0');
    expect(globalVars['fill_0']).toEqual({
      type: 'linear',
      angle: 90,
      stops: [
        { position: 0,   color: '#ff0000' },
        { position: 0.5, color: '#00ff00' },
        { position: 1,   color: '#0000ff' },
      ],
    });
  });

  it('labels IMAGE paint as the string "IMAGE"', () => {
    const node: RawSceneNode = {
      id: '1:2', name: 'Img', type: 'RECTANGLE',
      fills: [{ type: 'IMAGE' }],
    };
    const { node: out, globalVars } = simplify(node);
    expect(out.fill).toBe('fill_0');
    expect(globalVars['fill_0']).toBe('IMAGE');
  });
});
