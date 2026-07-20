// mcp-server/tests/unit/layout-spec-types.test.ts
import { describe, it, expect } from 'vitest';
import { paintValue } from '../../src/domain/design-context/simplify.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { LayoutSpec, DiffRow, DomSnapshotOk } from '../../src/domain/layout-spec/types.js';

describe('layout-spec types + paintValue export', () => {
  it('paintValue is exported and resolves a solid paint to hex', () => {
    expect(paintValue([{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }])).toBe('#ff0000');
  });

  it('RawSceneNode accepts layoutPositioning/rotation, RawTextStyle accepts lineHeightUnit', () => {
    const n: RawSceneNode = {
      id: '1:1', name: 'x', type: 'FRAME', rotation: 0.5, layoutPositioning: 'ABSOLUTE',
      style: { fontSize: 16, lineHeightUnit: 'INTRINSIC_%' },
    } as RawSceneNode;
    expect(n.layoutPositioning).toBe('ABSOLUTE');
  });

  it('LayoutSpec/DiffRow/DomSnapshotOk shapes compile', () => {
    const spec: LayoutSpec = { node: { id: '1:1', name: 'x', type: 'FRAME' }, children: [] };
    const row: DiffRow = { prop: 'size.w', figma: 10, dom: 10, status: 'pass' };
    const snap: DomSnapshotOk = {
      schema: 1, innerWidth: 375, rect: { x: 0, y: 0, w: 10, h: 10 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 }, children: [],
    };
    expect(spec.node.id && row.prop && snap.schema).toBeTruthy();
  });
});
