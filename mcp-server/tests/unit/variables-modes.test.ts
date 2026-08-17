import { describe, expect, it } from 'vitest';
import {
  buildVariableIndex,
  listTokens,
  resolveAllModes,
  resolveBoundVariableInMode,
} from '../../src/domain/variables.js';
import type { RawVariablesResponse } from '../../src/domain/figma-raw.js';
import type { ModeEvidenceStack, ModeStack } from '../../src/domain/mode-resolve.js';

const resp: RawVariablesResponse = { meta: {
  variableCollections: {
    'VC:1': { id: 'VC:1', name: 'Theme', defaultModeId: 'm1',
      modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dusk' }] },
    'VC:2': { id: 'VC:2', name: 'Prim', defaultModeId: 'p', modes: [{ modeId: 'p', name: 'Only' }] },
  },
  variables: {
    'V:1': { id: 'V:1', name: 'text color/accent', resolvedType: 'COLOR', variableCollectionId: 'VC:1',
      valuesByMode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } } },
    'V:2': { id: 'V:2', name: 'space/md', resolvedType: 'FLOAT', variableCollectionId: 'VC:2',
      valuesByMode: { p: 16 } },
  },
} };

const crossResp: RawVariablesResponse = { meta: {
  variableCollections: {
    'VC:A': { id: 'VC:A', name: 'Theme', defaultModeId: 'a1',
      modes: [{ modeId: 'a1', name: 'Default' }, { modeId: 'a2', name: 'Dark' }] },
    'VC:B': { id: 'VC:B', name: 'Palette', defaultModeId: 'b1',
      modes: [{ modeId: 'b1', name: 'Light' }, { modeId: 'b2', name: 'Night' }] },
  },
  variables: {
    'V:src': { id: 'V:src', name: 'src/accent', resolvedType: 'COLOR', variableCollectionId: 'VC:A',
      valuesByMode: { a1: { type: 'VARIABLE_ALIAS', id: 'V:tgt' }, a2: { type: 'VARIABLE_ALIAS', id: 'V:tgt' } } },
    'V:tgt': { id: 'V:tgt', name: 'tgt/base', resolvedType: 'COLOR', variableCollectionId: 'VC:B',
      valuesByMode: { b1: { r: 1, g: 1, b: 1, a: 1 }, b2: { r: 0, g: 0, b: 0, a: 1 } } },
  },
} };

const singleTopResp: RawVariablesResponse = { meta: {
  variableCollections: {
    'VC:S': { id: 'VC:S', name: 'Semantic', defaultModeId: 's1', modes: [{ modeId: 's1', name: 'Only' }] },
    'VC:B': { id: 'VC:B', name: 'Palette', defaultModeId: 'b1',
      modes: [{ modeId: 'b1', name: 'Light' }, { modeId: 'b2', name: 'Night' }] },
  },
  variables: {
    'V:sem': { id: 'V:sem', name: 'semantic/base', resolvedType: 'COLOR', variableCollectionId: 'VC:S',
      valuesByMode: { s1: { type: 'VARIABLE_ALIAS', id: 'V:pal' } } },
    'V:pal': { id: 'V:pal', name: 'palette/base', resolvedType: 'COLOR', variableCollectionId: 'VC:B',
      valuesByMode: { b1: { r: 1, g: 1, b: 1, a: 1 }, b2: { r: 0, g: 0, b: 0, a: 1 } } },
  },
} };

const bind = { fills: { type: 'VARIABLE_ALIAS' as const, id: 'V:src' } };
const evidence = (entries: [string, string, 'explicit_node' | 'ancestor_chain', string][]): ModeEvidenceStack =>
  new Map(entries.map(([collection, modeId, source, nodeId]) => [collection, { modeId, source, nodeId }]));

describe('resolveAllModes and listTokens', () => {
  it('returns named values only for multi-mode collections', () => {
    const idx = buildVariableIndex(resp);
    expect(resolveAllModes(resp.meta!.variables['V:1'], idx)).toEqual({
      mode_dependent: true,
      modes: { Default: '#a73afd', Dusk: '#8b6afb' },
    });
    expect(resolveAllModes(resp.meta!.variables['V:2'], idx)).toBeNull();
  });

  it('attaches the same multi-mode metadata to token listings', () => {
    const tokens = listTokens(resp);
    expect(tokens.find((t) => t.name === 'text color/accent')).toMatchObject({
      mode_dependent: true,
      modes: { Default: '#a73afd', Dusk: '#8b6afb' },
    });
    expect(tokens.find((t) => t.name === 'space/md')?.modes).toBeUndefined();
  });
});

describe('resolveBoundVariableInMode evidence contract', () => {
  it('emits explicit and ancestor provenance for a fully confirmed cross-collection value', () => {
    const idx = buildVariableIndex(crossResp);
    const stack: ModeStack = new Map([['VC:A', 'a2'], ['VC:B', 'b2']]);
    const r = resolveBoundVariableInMode(bind, 'fills', idx, stack, true, evidence([
      ['VC:A', 'a2', 'explicit_node', 'LEAF'],
      ['VC:B', 'b2', 'ancestor_chain', 'FRAME'],
    ]))!;
    expect(r).toMatchObject({
      token: 'src/accent',
      default_value: '#ffffff',
      effective_rendered_value: '#000000',
      value: '#000000',
      mode_dependent: true,
      effective_mode_source: 'ancestor_chain',
      effective_modes: {
        Theme: { mode: 'Dark', source: 'explicit_node', node_id: 'LEAF' },
        Palette: { mode: 'Night', source: 'ancestor_chain', node_id: 'FRAME' },
      },
    });
  });

  it('keeps the diagnostic default but nulls the rendered value when a required axis is unconfirmed', () => {
    const idx = buildVariableIndex(crossResp);
    const r = resolveBoundVariableInMode(bind, 'fills', idx, new Map([['VC:A', 'a2']]), false, evidence([
      ['VC:A', 'a2', 'explicit_node', 'LEAF'],
    ]))!;
    expect(r).toMatchObject({
      default_value: '#ffffff',
      effective_rendered_value: null,
      value: null,
      effective_mode_source: 'unverifiable',
      effective_modes: {
        Theme: { mode: 'Dark', source: 'explicit_node', node_id: 'LEAF' },
        Palette: { mode: 'Light', source: 'unverifiable' },
      },
    });
  });

  it('confirms every absent axis as its default when ancestor coverage is complete', () => {
    const idx = buildVariableIndex(crossResp);
    const r = resolveBoundVariableInMode(bind, 'fills', idx, new Map(), true, new Map())!;
    expect(r.default_value).toBe('#ffffff');
    expect(r.effective_rendered_value).toBe(r.default_value);
    expect(r.value).toBe(r.default_value);
    expect(r.effective_mode_source).toBe('confirmed_default');
    expect(r.effective_modes).toEqual({
      Theme: { mode: 'Default', source: 'confirmed_default' },
      Palette: { mode: 'Light', source: 'confirmed_default' },
    });
  });

  it('treats an invalid explicit mode as unverifiable despite complete ancestor coverage', () => {
    const idx = buildVariableIndex(crossResp);
    const r = resolveBoundVariableInMode(bind, 'fills', idx,
      new Map([['VC:A', 'a2'], ['VC:B', 'bogus']]), true, evidence([
        ['VC:A', 'a2', 'explicit_node', 'LEAF'],
        ['VC:B', 'bogus', 'ancestor_chain', 'FRAME'],
      ]))!;
    expect(r).toMatchObject({
      default_value: '#ffffff',
      effective_rendered_value: null,
      value: null,
      effective_mode_source: 'unverifiable',
      effective_modes: {
        Theme: { mode: 'Dark', source: 'explicit_node', node_id: 'LEAF' },
        Palette: { mode: 'Light', source: 'unverifiable' },
      },
    });
  });

  it('keeps a direct single-mode token byte-for-byte compatible', () => {
    const idx = buildVariableIndex(resp);
    expect(resolveBoundVariableInMode(
      { fills: { type: 'VARIABLE_ALIAS', id: 'V:2' } }, 'fills', idx, new Map(), true, new Map(),
    )).toEqual({ token: 'space/md', value: 16 });
  });

  it('records a downstream multi-mode axis beneath a single-mode semantic token', () => {
    const idx = buildVariableIndex(singleTopResp);
    const r = resolveBoundVariableInMode(
      { fills: { type: 'VARIABLE_ALIAS', id: 'V:sem' } },
      'fills', idx, new Map(), false, new Map(),
    )!;
    expect(r).toMatchObject({
      token: 'semantic/base',
      default_value: '#ffffff',
      effective_rendered_value: null,
      value: null,
      mode_dependent: true,
      effective_mode_source: 'unverifiable',
      effective_modes: { Palette: { mode: 'Light', source: 'unverifiable' } },
    });
  });
});

describe('resolveBoundVariableInMode stats stay out of band', () => {
  it('reports consumed top and downstream pins without serializing them into the token', () => {
    const idx = buildVariableIndex(singleTopResp);
    const stats = { pinnedAxisUsed: false, unconfirmedDefaultUsed: false };
    const r = resolveBoundVariableInMode(
      { fills: { type: 'VARIABLE_ALIAS', id: 'V:sem' } },
      'fills', idx, new Map([['VC:B', 'b2']]), true,
      evidence([['VC:B', 'b2', 'ancestor_chain', 'FRAME']]), stats,
    )!;
    expect(r.value).toBe('#000000');
    expect(stats.pinnedAxisUsed).toBe(true);
    expect('pinned_axis_used' in r).toBe(false);
  });
});
