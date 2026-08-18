import { describe, it, expect } from 'vitest';
import { recordApplied, formatEffectiveModes, compositeModeSource, type AppliedMode } from '../../src/domain/design-context/resolved-token.js';

const theme: AppliedMode = { key: 'L1|c1', collection: 'Theme', mode: 'Light', source: 'confirmed_default' };
const brand: AppliedMode = { key: 'L2|c2', collection: 'sub-brand', mode: 'Solar', source: 'ancestor_chain', nodeId: 'FRAME' };

describe('recordApplied', () => {
  it('appends entries in resolution order (nearest-to-token first)', () => {
    const sink: AppliedMode[] = [];
    recordApplied(sink, theme);
    recordApplied(sink, brand);
    expect(sink).toEqual([theme, brand]);
  });
  it('first-seen wins: a later pick for an already-recorded collection key is ignored', () => {
    const sink: AppliedMode[] = [theme];
    recordApplied(sink, { ...theme, mode: 'Dark', source: 'explicit_node' });
    expect(sink).toEqual([theme]);
  });
  it('is a no-op without a sink (legacy best-effort callers)', () => {
    expect(() => recordApplied(undefined, theme)).not.toThrow();
  });
});

describe('formatEffectiveModes', () => {
  it('emits structured provenance for every recorded axis', () => {
    expect(formatEffectiveModes([theme, brand])).toEqual({
      Theme: { mode: 'Light', source: 'confirmed_default' },
      'sub-brand': { mode: 'Solar', source: 'ancestor_chain', node_id: 'FRAME' },
    });
  });
  it('keeps a single multi-mode axis', () => {
    expect(formatEffectiveModes([theme])).toEqual({ Theme: { mode: 'Light', source: 'confirmed_default' } });
  });
  it('uses the prescribed composite precedence', () => {
    expect(compositeModeSource([theme, brand])).toBe('ancestor_chain');
    expect(compositeModeSource([
      { ...theme, source: 'unverifiable' },
      { ...brand, source: 'explicit_node' },
    ])).toBe('unverifiable');
    expect(compositeModeSource({
      Theme: { mode: 'Light', source: 'unverifiable' },
      Brand: { mode: 'Solar', source: 'explicit_node' },
    })).toBe('unverifiable');
  });
  it('preserves duplicate, empty, and prototype-key display labels without hiding unsafe axes', () => {
    const applied: AppliedMode[] = [
      { key: 'C1', collection: 'Theme', mode: 'Dark', source: 'explicit_node', nodeId: 'LEAF' },
      { key: 'C2', collection: 'Theme', mode: 'Light', source: 'unverifiable' },
      { key: 'C3', collection: 'constructor', mode: 'Safe', source: 'confirmed_default' },
      { key: 'C4', collection: 'toString', mode: 'Inherited', source: 'ancestor_chain', nodeId: 'FRAME' },
      { key: 'C5', collection: '', mode: '', source: 'confirmed_default' },
    ];
    const formatted = formatEffectiveModes(applied)!;
    expect(Object.getPrototypeOf(formatted)).toBeNull();
    expect(formatted).toEqual({
      Theme: { mode: 'Dark', source: 'explicit_node', node_id: 'LEAF' },
      'Theme [2]': { mode: 'Light', source: 'unverifiable' },
      constructor: { mode: 'Safe', source: 'confirmed_default' },
      toString: { mode: 'Inherited', source: 'ancestor_chain', node_id: 'FRAME' },
      '[unnamed]': { mode: '', source: 'confirmed_default' },
    });
    expect(compositeModeSource(applied)).toBe('unverifiable');
  });
  it('returns undefined for undefined/empty input', () => {
    expect(formatEffectiveModes(undefined)).toBeUndefined();
    expect(formatEffectiveModes([])).toBeUndefined();
  });
});
