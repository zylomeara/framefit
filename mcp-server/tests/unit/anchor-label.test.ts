import { describe, it, expect } from 'vitest';
import { renderAnchorLabel } from '../../src/domain/anchor-label.js';

describe('renderAnchorLabel', () => {
  it('canvas_point', () => {
    expect(renderAnchorLabel({ kind: 'canvas_point', x: 100, y: 200 })).toBe(
      'pinned to canvas at (100, 200)',
    );
  });

  it('canvas_region', () => {
    expect(
      renderAnchorLabel({ kind: 'canvas_region', x: 10, y: 20, width: 320, height: 240 }),
    ).toBe('region on canvas at (10, 20) 320×240');
  });

  it('node — includes name, node id, and page', () => {
    const label = renderAnchorLabel({
      kind: 'node', node_id: '1:42', node_name: 'Button / Primary', page_name: 'Components', offset: { x: 0, y: 0 },
    });
    expect(label).toContain('on Button / Primary');
    expect(label).toContain('node: 1:42');
    expect(label).toContain('page: Components');
  });

  it('node — falls back to node id when name empty', () => {
    const label = renderAnchorLabel({
      kind: 'node', node_id: '1:999', node_name: '', page_name: '', offset: { x: 0, y: 0 },
    });
    expect(label).toContain('node 1:999');
    expect(label).not.toContain('page:');
  });

  it('node_region — includes name, node id, page', () => {
    const label = renderAnchorLabel({
      kind: 'node_region', node_id: '1:55', node_name: 'Header', page_name: 'Landing', offset: { x: 0, y: 0 }, width: 100, height: 50,
    });
    expect(label).toContain('region on Header');
    expect(label).toContain('node: 1:55');
    expect(label).toContain('page: Landing');
  });
});
