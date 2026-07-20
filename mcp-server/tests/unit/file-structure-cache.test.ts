import { describe, it, expect } from 'vitest';
import { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import type { FileStructure } from '../../src/domain/file-structure.js';

function emptyStructure(): FileStructure {
  return { nodeById: new Map(), pageNameByNodeId: new Map(), childrenByNodeId: new Map() };
}

describe('FileStructureCache', () => {
  it('returns null before set', () => {
    const cache = new FileStructureCache(1000, () => 0);
    expect(cache.get('k')).toBeNull();
  });

  it('returns value before TTL', () => {
    let now = 0;
    const cache = new FileStructureCache(1000, () => now);
    const s = emptyStructure();
    cache.set('k', s);
    now = 999;
    expect(cache.get('k')).toBe(s);
  });

  it('expires after TTL and deletes entry', () => {
    let now = 0;
    const cache = new FileStructureCache(1000, () => now);
    cache.set('k', emptyStructure());
    now = 1001;
    expect(cache.get('k')).toBeNull();
    expect(cache.get('k')).toBeNull();
  });
});
