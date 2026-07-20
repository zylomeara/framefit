// mcp-server/tests/unit/resolved-token.test.ts
import { describe, it, expect } from 'vitest';
import { buildVariableIndex, resolveBoundVariableInMode } from '../../src/domain/variables.js';
import type { RawVariablesResponse } from '../../src/domain/figma-raw.js';

const resp: RawVariablesResponse = { meta: {
  variableCollections: { 'C': { id: 'C', name: 'Theme', defaultModeId: 'm1',
    modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'MonogramDark' }] } },
  variables: { 'V:1': { id: 'V:1', name: 'text icon/accent', resolvedType: 'COLOR', variableCollectionId: 'C',
    valuesByMode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } } } },
} };

describe('resolveBoundVariableInMode (local)', () => {
  it('resolves to the node-mode hex when the stack sets the collection mode', () => {
    const idx = buildVariableIndex(resp);
    const stack = new Map([['C', 'm2']]);
    const r = resolveBoundVariableInMode({ strokes: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'strokes', idx, stack)!;
    expect(r).toEqual({ token: 'text icon/accent', value: '#8b6afb', mode: 'MonogramDark', mode_dependent: true, mode_source: 'node' });
  });

  it('falls back to default mode with mode_source=default when the stack is empty', () => {
    const idx = buildVariableIndex(resp);
    const r = resolveBoundVariableInMode({ strokes: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'strokes', idx, new Map())!;
    expect(r.value).toBe('#a73afd');
    expect(r.mode).toBe('Default');
    expect(r.mode_source).toBe('default');
  });

  it('returns null for a binding not in the local index', () => {
    const idx = buildVariableIndex(resp);
    const r = resolveBoundVariableInMode({ strokes: { type: 'VARIABLE_ALIAS', id: 'VariableID:abc/9:9' } }, 'strokes', idx, new Map());
    expect(r).toBeNull();
  });
});
