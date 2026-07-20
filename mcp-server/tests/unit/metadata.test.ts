import { describe, it, expect } from 'vitest';
import { toSparseTree } from '../../src/domain/metadata.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const node: RawSceneNode = {
  id: '1:0', name: 'Page', type: 'CANVAS',
  children: [{
    id: '1:1', name: 'Card', type: 'FRAME',
    absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 100 },
    children: [{ id: '1:2', name: 'Title', type: 'TEXT', absoluteBoundingBox: { x: 12, y: 22, width: 100, height: 24 } }],
  }],
};

describe('toSparseTree', () => {
  it('keeps id/name/type/x/y/w/h and nests children', () => {
    const t = toSparseTree(node, 5);
    expect(t).toEqual({
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '1:1', name: 'Card', type: 'FRAME', x: 10, y: 20, w: 200, h: 100,
        children: [{ id: '1:2', name: 'Title', type: 'TEXT', x: 12, y: 22, w: 100, h: 24 }],
      }],
    });
  });

  it('clamps depth: depth=1 drops grandchildren but flags truncation', () => {
    const t = toSparseTree(node, 1);
    expect(t.children?.[0].children).toBeUndefined();
    expect(t.children?.[0].truncated).toBe(true);
  });

  it('adds hidden:true for visible=false nodes; visible nodes have no hidden flag', () => {
    const n: RawSceneNode = {
      id: 'p', name: 'Page', type: 'CANVAS',
      children: [
        { id: 'h', name: 'HiddenRect', type: 'RECTANGLE', visible: false },
        { id: 'v', name: 'VisibleRect', type: 'RECTANGLE' },
      ],
    };
    const t = toSparseTree(n, 3);
    expect(t.children![0]).toMatchObject({ id: 'h', hidden: true });
    expect(t.children![1].hidden).toBeUndefined();
  });
});
