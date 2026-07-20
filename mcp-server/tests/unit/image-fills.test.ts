import { describe, it, expect } from 'vitest';
import { collectImageRefs } from '../../src/domain/image-fills.js';

describe('collectImageRefs', () => {
  it('collects distinct IMAGE-fill imageRefs from a node subtree (fills only, deduped, nested)', () => {
    const node = {
      id: '1', name: 'N', type: 'FRAME',
      fills: [{ type: 'IMAGE', imageRef: 'a' }, { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, { type: 'IMAGE', imageRef: 'a' }],
      strokes: [{ type: 'IMAGE', imageRef: 's' }], // strokes are not source images → ignored (match download_assets)
      children: [{ id: '2', name: 'C', type: 'RECTANGLE', fills: [{ type: 'IMAGE', imageRef: 'b' }] }],
    } as any;
    expect(collectImageRefs(node).sort()).toEqual(['a', 'b']);
  });

  it('returns [] when there are no IMAGE fills', () => {
    expect(collectImageRefs({ id: '1', name: 'N', type: 'FRAME', fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] } as any)).toEqual([]);
  });

  it('ignores IMAGE fills with no imageRef', () => {
    expect(collectImageRefs({ id: '1', name: 'N', type: 'FRAME', fills: [{ type: 'IMAGE' }] } as any)).toEqual([]);
  });
});
