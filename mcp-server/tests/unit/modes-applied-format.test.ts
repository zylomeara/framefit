import { describe, it, expect } from 'vitest';
import { recordApplied, formatModesApplied, type AppliedMode } from '../../src/domain/design-context/resolved-token.js';

const theme: AppliedMode = { key: 'L1|c1', collection: 'Theme', mode: 'Light', source: 'default' };
const brand: AppliedMode = { key: 'L2|c2', collection: 'sub-brand', mode: 'Solar', source: 'node' };

describe('recordApplied', () => {
  it('appends entries in resolution order (nearest-to-token first)', () => {
    const sink: AppliedMode[] = [];
    recordApplied(sink, theme);
    recordApplied(sink, brand);
    expect(sink).toEqual([theme, brand]);
  });
  it('first-seen wins: a later pick for an already-recorded collection key is ignored', () => {
    const sink: AppliedMode[] = [theme];
    recordApplied(sink, { ...theme, mode: 'Dark', source: 'node' });
    expect(sink).toEqual([theme]);
  });
  it('is a no-op without a sink (legacy best-effort callers)', () => {
    expect(() => recordApplied(undefined, theme)).not.toThrow();
  });
});

describe('formatModesApplied', () => {
  it('emits {collection: "mode (source)"} for >=2 distinct multi-mode axes', () => {
    expect(formatModesApplied([theme, brand]))
      .toEqual({ Theme: 'Light (default)', 'sub-brand': 'Solar (node)' });
  });
  it('returns undefined for a single axis (gate)', () => {
    expect(formatModesApplied([theme])).toBeUndefined();
  });
  it('returns undefined when any axis has an empty collection name (pre-resync graph rows)', () => {
    expect(formatModesApplied([theme, { ...brand, collection: '' }])).toBeUndefined();
  });
  it('returns undefined when any axis has an empty mode name', () => {
    expect(formatModesApplied([theme, { ...brand, mode: '' }])).toBeUndefined();
  });
  it('name collision between two DIFFERENT collections: first-seen wins, and the gate re-checks', () => {
    expect(formatModesApplied([theme, { ...brand, collection: 'Theme' }])).toBeUndefined(); // collapses to 1 key
    expect(formatModesApplied([theme, { ...brand, collection: 'Theme' }, brand]))
      .toEqual({ Theme: 'Light (default)', 'sub-brand': 'Solar (node)' });                  // 3 entries -> 2 keys, ok
  });
  it('returns undefined for undefined/empty input', () => {
    expect(formatModesApplied(undefined)).toBeUndefined();
    expect(formatModesApplied([])).toBeUndefined();
  });
});
