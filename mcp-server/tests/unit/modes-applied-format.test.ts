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
    expect(compositeModeSource(formatEffectiveModes([theme, brand])!)).toBe('ancestor_chain');
    expect(compositeModeSource({ Theme: { mode: 'Light', source: 'unverifiable' }, Brand: { mode: 'Solar', source: 'explicit_node' } }))
      .toBe('unverifiable');
  });
  it('returns undefined for undefined/empty input', () => {
    expect(formatEffectiveModes(undefined)).toBeUndefined();
    expect(formatEffectiveModes([])).toBeUndefined();
  });
});
