import { describe, it, expect } from 'vitest';
import { toSparseTree, countTruncated, type SparseNode } from '../../src/domain/metadata.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const raw: RawSceneNode = {
  id: '0:0', name: 'root', type: 'FRAME', children: [
    { id: '1:0', name: 'a', type: 'FRAME', children: [
      { id: '1:1', name: 'a1', type: 'TEXT' },
      { id: '1:2', name: 'a2', type: 'TEXT' },
      { id: '1:3', name: 'a3', type: 'TEXT' },
    ] },
    { id: '2:0', name: 'b', type: 'FRAME', children: [
      { id: '2:1', name: 'b1', type: 'TEXT' },
    ] },
  ],
};

describe('metadata truncation annotations', () => {
  it('records childCount on nodes truncated by depth', () => {
    const t = toSparseTree(raw, 1); // root's children kept, grandchildren cut
    const a = t.children!.find((c) => c.id === '1:0')!;
    expect(a.truncated).toBe(true);
    expect(a.childCount).toBe(3);
    const b = t.children!.find((c) => c.id === '2:0')!;
    expect(b.childCount).toBe(1);
  });

  it('counts truncated branches across the tree', () => {
    const t = toSparseTree(raw, 1);
    expect(countTruncated(t)).toBe(2);
  });

  it('does not set childCount on fully-expanded nodes', () => {
    const t = toSparseTree(raw, 5);
    const a = t.children!.find((c) => c.id === '1:0')! as SparseNode;
    expect(a.truncated).toBeUndefined();
    expect(a.childCount).toBeUndefined();
  });
});
