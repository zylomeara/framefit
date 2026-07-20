import { describe, it, expect } from 'vitest';
import { residentBytes, withinParseCap } from '../../src/infrastructure/frame-budget.js';

describe('frame-budget resident accounting', () => {
  it('residentBytes scales wire by the multiplier (rounds up)', () => {
    expect(residentBytes(1000, 5)).toBe(5000);
    expect(residentBytes(1001, 5)).toBe(5005);
    expect(residentBytes(3, 2.5)).toBe(8); // ceil(7.5)
  });
});

describe('frame-budget parse-gate is a LIVE guard (not a dead 0-byte check)', () => {
  it('holds a frame at/under cap', () => {
    expect(withinParseCap(3 * 1024 * 1024, 3 * 1024 * 1024)).toBe(true);
    expect(withinParseCap(1, 3 * 1024 * 1024)).toBe(true);
  });
  it('rejects a frame over cap — fires on a real oversized wire size', () => {
    expect(withinParseCap(3 * 1024 * 1024 + 1, 3 * 1024 * 1024)).toBe(false);
    expect(withinParseCap(64 * 1024 * 1024, 3 * 1024 * 1024)).toBe(false);
  });
});
