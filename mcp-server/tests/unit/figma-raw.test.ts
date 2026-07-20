import { describe, it, expect } from 'vitest';
import type { RawSceneNode, RawNodesResponse } from '../../src/domain/figma-raw.js';

describe('raw paint-style linkage', () => {
  it('RawSceneNode carries a styles slot→styleId map', () => {
    const n: RawSceneNode = { id: '1:2', name: 'x', type: 'FRAME', styles: { fill: 'S:abc' } } as RawSceneNode;
    expect(n.styles?.fill).toBe('S:abc');
  });
  it('RawNodesResponse entry carries a styleId→meta map', () => {
    const r = { nodes: { '1:2': { document: { id: '1:2', name: 'x', type: 'FRAME' }, styles: { 'S:abc': { name: 'Brand/Primary', styleType: 'FILL' } } } } } as unknown as RawNodesResponse;
    expect(r.nodes['1:2']!.styles?.['S:abc'].name).toBe('Brand/Primary');
  });
});
