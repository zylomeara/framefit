import { describe, it, expect } from 'vitest';
import { NODE_ID_RE, normalizeNodeId, COMPOUND_NODE_ID_RE, normalizeCompoundNodeId } from '../../src/domain/node-id.js';

describe('node-id', () => {
  it('NODE_ID_RE matches colon and dash forms', () => {
    expect(NODE_ID_RE.test('1:42')).toBe(true);
    expect(NODE_ID_RE.test('1-42')).toBe(true);
    expect(NODE_ID_RE.test('1234:567')).toBe(true);
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
});
