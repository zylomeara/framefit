import { describe, it, expect } from 'vitest';
import { isoWeek } from '../../src/domain/iso-week.js';

describe('isoWeek', () => {
  it('formats a mid-year date', () => {
    expect(isoWeek(new Date('2026-05-15T00:00:00Z'))).toBe('2026-W20');
  });

  it('handles first week of the year', () => {
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  });

  it('zero-pads single-digit weeks', () => {
    expect(isoWeek(new Date('2026-01-05T00:00:00Z'))).toMatch(/^2026-W0\d$/);
  });
});
