import { describe, it, expect } from 'vitest';
import { NODE_ID_RE, normalizeNodeId, COMPOUND_NODE_ID_RE, normalizeCompoundNodeId, normalizeScopedResponseRoot } from '../../src/domain/node-id.js';

describe('node-id', () => {
  it('NODE_ID_RE matches colon and dash forms', () => {
    expect(NODE_ID_RE.test('1:42')).toBe(true);
    expect(NODE_ID_RE.test('1-42')).toBe(true);
    expect(NODE_ID_RE.test('12:340')).toBe(true);
  });

  it('NODE_ID_RE rejects malformed', () => {
    expect(NODE_ID_RE.test('abc')).toBe(false);
    expect(NODE_ID_RE.test('1')).toBe(false);
    expect(NODE_ID_RE.test('')).toBe(false);
  });

  it('normalizeNodeId converts dash to colon', () => {
    expect(normalizeNodeId('1-42')).toBe('1:42');
  });

  it('normalizeNodeId leaves colon form unchanged', () => {
    expect(normalizeNodeId('1:42')).toBe('1:42');
  });
});

describe('compound node id', () => {
  it('accepts plain and nested-instance ids', () => {
    expect(COMPOUND_NODE_ID_RE.test('1:42')).toBe(true);
    expect(COMPOUND_NODE_ID_RE.test('1-42')).toBe(true);
    expect(COMPOUND_NODE_ID_RE.test('I12:340;56:7890')).toBe(true);
    expect(COMPOUND_NODE_ID_RE.test('I12-340;56-7890')).toBe(true);
  });

  it('rejects malformed compound ids', () => {
    expect(COMPOUND_NODE_ID_RE.test('abc')).toBe(false);
    expect(COMPOUND_NODE_ID_RE.test('I')).toBe(false);
    expect(COMPOUND_NODE_ID_RE.test('1:2;')).toBe(false);
    expect(COMPOUND_NODE_ID_RE.test(';1:2')).toBe(false);
  });

  it('normalizeCompoundNodeId converts dashes per segment, keeps leading I', () => {
    expect(normalizeCompoundNodeId('1-42')).toBe('1:42');
    expect(normalizeCompoundNodeId('I12:340;56:7890')).toBe('I12:340;56:7890');
    expect(normalizeCompoundNodeId('I12-340;56-7890')).toBe('I12:340;56:7890');
  });

  it.each([
    { name: 'plain exact', requested: '1-42', returned: '1:42', expected: '1:42' },
    { name: 'full compound I to no-I', requested: 'I12-340;56-7890', returned: '12:340;56:7890', expected: 'I12:340;56:7890' },
    { name: 'full compound no-I to I', requested: '12:340;56:7890', returned: 'I12:340;56:7890', expected: '12:340;56:7890' },
    { name: 'exact terminal scoped alias', requested: 'I12:340;56:7890', returned: '56:7890', expected: 'I12:340;56:7890' },
  ])('normalizes a valid scoped response root: $name', ({ requested, returned, expected }) => {
    const original = { id: returned, children: [{ id: '7:7' }] };
    const result = normalizeScopedResponseRoot(original, requested);
    expect(result).toEqual({ id: expected, children: [{ id: '7:7' }] });
    expect(result).not.toBe(original);
    // Shallow on purpose: only the root id changes, so large subtrees are shared, not copied.
    expect(result!.children).toBe(original.children);
    expect(original).toEqual({ id: returned, children: [{ id: '7:7' }] });
  });

  it.each([
    { name: 'plain mismatch', requested: '1:42', returned: '1:43' },
    { name: 'wrong terminal', requested: 'I12:340;56:7890', returned: '56:7891' },
    { name: 'foreign compound with same terminal', requested: 'I12:340;56:7890', returned: 'I99:1;56:7890' },
    { name: 'qualified terminal', requested: 'I12:340;56:7890', returned: 'I56:7890' },
    { name: 'malformed string id', requested: '1:42', returned: 'not-an-id' },
  ])('rejects an invalid scoped response root: $name', ({ requested, returned }) => {
    expect(normalizeScopedResponseRoot({ id: returned }, requested)).toBeUndefined();
  });

  it('rejects a missing or non-string scoped root id', () => {
    expect(normalizeScopedResponseRoot({}, '1:42')).toBeUndefined();
    expect(normalizeScopedResponseRoot({ id: 42 }, '1:42')).toBeUndefined();
  });
});
