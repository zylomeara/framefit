import { describe, it, expect } from 'vitest';
import {
  buildFileStructure,
  findPageName,
  collectDescendants,
} from '../../src/domain/file-structure.js';
import fixture from '../fixtures/file-structure-sample.json';
import type { RawDocumentNode } from '../../src/domain/file-structure.js';

const doc = fixture.document as unknown as RawDocumentNode;

describe('file-structure', () => {
  it('maps node ids to their ancestor CANVAS page name', () => {
    const s = buildFileStructure(doc);
    expect(findPageName(s, '1:42')).toBe('Components');
    expect(findPageName(s, '1:55')).toBe('Landing');
  });

  it('resolves page name for a deeply nested node', () => {
    const s = buildFileStructure(doc);
    expect(findPageName(s, '1:56')).toBe('Landing');
  });

  it('returns empty string for unknown node', () => {
    const s = buildFileStructure(doc);
    expect(findPageName(s, '9:99')).toBe('');
  });

  it('records node type and name', () => {
    const s = buildFileStructure(doc);
    expect(s.nodeById.get('1:42')).toMatchObject({ name: 'Button / Primary', type: 'COMPONENT' });
  });

  it('collectDescendants returns the node and all descendants', () => {
    const s = buildFileStructure(doc);
    const set = collectDescendants(s, '1:55');
    expect([...set].sort()).toEqual(['1:55', '1:56']);
  });

  it('collectDescendants of a leaf returns just itself', () => {
    const s = buildFileStructure(doc);
    expect([...collectDescendants(s, '1:42')]).toEqual(['1:42']);
  });
});
