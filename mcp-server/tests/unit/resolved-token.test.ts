// mcp-server/tests/unit/resolved-token.test.ts
import { describe, it, expect } from 'vitest';
import { buildVariableIndex, resolveBoundVariableInMode } from '../../src/domain/variables.js';
import type { RawVariablesResponse } from '../../src/domain/figma-raw.js';

const resp: RawVariablesResponse = { meta: {
  variableCollections: {
    'C': { id: 'C', name: 'Theme', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dusk' }] },
    'S': { id: 'S', name: 'Static', defaultModeId: 's1', modes: [{ modeId: 's1', name: 'Only' }] },
  },
  variables: {
    'V:1': { id: 'V:1', name: 'text color/accent', resolvedType: 'COLOR', variableCollectionId: 'C', valuesByMode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } } },
    'V:2': { id: 'V:2', name: 'space/md', resolvedType: 'FLOAT', variableCollectionId: 'S', valuesByMode: { s1: 16 } },
  },
} };

describe('resolveBoundVariableInMode (local)', () => {
  it('keeps the single-mode response byte-for-byte compatible', () => {
    const idx = buildVariableIndex(resp);
    expect(resolveBoundVariableInMode({ opacity: { type: 'VARIABLE_ALIAS', id: 'V:2' } }, 'opacity', idx, new Map()))
      .toEqual({ token: 'space/md', value: 16 });
  });

  it('resolves to the node-mode hex when the stack sets the collection mode', () => {
    const idx = buildVariableIndex(resp);
    const stack = new Map([['C', 'm2']]);
    const evidence = new Map([['C', { modeId: 'm2', source: 'explicit_node' as const, nodeId: 'NODE' }]]);
    const r = resolveBoundVariableInMode({ strokes: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'strokes', idx, stack, true, evidence)!;
    expect(r).toEqual({
      token: 'text color/accent',
      default_value: '#a73afd',
      effective_rendered_value: '#8b6afb',
      value: '#8b6afb',
      effective_modes: { Theme: { mode: 'Dusk', source: 'explicit_node', node_id: 'NODE' } },
      effective_mode_source: 'explicit_node',
      mode_dependent: true,
    });
  });

  it('does not expose the diagnostic default as rendered under incomplete evidence', () => {
    const idx = buildVariableIndex(resp);
    const r = resolveBoundVariableInMode({ strokes: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'strokes', idx, new Map(), false, new Map())!;
    expect(r).toMatchObject({
      default_value: '#a73afd', effective_rendered_value: null, value: null,
      effective_mode_source: 'unverifiable',
    });
  });

  it('returns null for a binding not in the local index', () => {
    const idx = buildVariableIndex(resp);
    const r = resolveBoundVariableInMode({ strokes: { type: 'VARIABLE_ALIAS', id: 'VariableID:abc/9:9' } }, 'strokes', idx, new Map());
    expect(r).toBeNull();
  });
});
