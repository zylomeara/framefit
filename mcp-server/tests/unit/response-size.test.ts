import { describe, it, expect } from 'vitest';
import { tagBytes, sizeOf } from '../../src/infrastructure/response-size.js';

describe('response-size WeakMap side-channel', () => {
  it('tag → sizeOf roundtrip on an object', () => {
    const o = { a: 1 };
    tagBytes(o, 12345);
    expect(sizeOf(o)).toBe(12345);
  });
  it('untagged object → 0', () => {
    expect(sizeOf({ b: 2 })).toBe(0);
  });
  it('primitive / null → 0 (no throw)', () => {
    expect(sizeOf(42)).toBe(0);
    expect(sizeOf(null)).toBe(0);
    expect(sizeOf(undefined)).toBe(0);
    tagBytes(7 as unknown, 100); // no-op, must not throw
    tagBytes(null, 100);
  });
});
