import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  collectionLibKey,
  graphAliasWalk,
  graphAuthoredName,
  graphCssEvidenceView,
  graphIdsByCssName,
  keyIsMultiMode,
  resolveKeyInMode,
  resolveKeyModes,
} from '../../src/domain/variable-graph.js';
import type { Lib } from '../../src/domain/variable-graph.js';
import type { ModeEvidenceStack } from '../../src/domain/mode-resolve.js';

const K = (h: string) => h.padEnd(40, '0');
const libs = [
  { fileKey: 'L1', colls: [{ collection_id: 'C', default_mode: 'm1',
    modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dusk' }] }],
    vars: [{ library_key: K('aaa'), local_id: 'VariableID:1:1', collection_id: 'C',
      values_by_mode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } },
      name: 'text color/accent', resolved_type: 'COLOR', code_syntax_web: '' }] },
];

const crossLibs = () => [
  { fileKey: 'L1', colls: [{ collection_id: 'CT', default_mode: 't1', name: 'Theme',
    modes: [{ modeId: 't1', name: 'Light' }, { modeId: 't2', name: 'Dark' }] }],
    vars: [{ library_key: K('acc'), local_id: 'VariableID:1:1', collection_id: 'CT',
      values_by_mode: {
        t1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('cab') + '/9:9' },
        t2: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('cab') + '/9:9' },
      }, name: 'text color/accent', resolved_type: 'COLOR', code_syntax_web: '' }] },
  { fileKey: 'L2', colls: [{ collection_id: 'CS', default_mode: 's1', name: 'sub-brand',
    modes: [{ modeId: 's1', name: 'default' }, { modeId: 's2', name: 'Solar' }] }],
    vars: [{ library_key: K('cab'), local_id: 'VariableID:9:9', collection_id: 'CS',
      values_by_mode: { s1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, s2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } },
      name: 'brand/accent', resolved_type: 'COLOR', code_syntax_web: '' }] },
];

const evidence = (entries: [string, string, 'explicit_node' | 'ancestor_chain', string][]): ModeEvidenceStack =>
  new Map(entries.map(([collection, modeId, source, nodeId]) => [collection, { modeId, source, nodeId }]));

describe('variable graph mode metadata', () => {
  it('detects multi-mode collections and resolves every named mode', () => {
    const graph = buildGraph(libs);
    expect(keyIsMultiMode(graph, K('aaa'))).toBe(true);
    expect(keyIsMultiMode(graph, K('missing'))).toBe(false);
    expect(resolveKeyModes(graph, K('aaa'))).toMatchObject({
      modesByName: { Default: '#a73afd', Dusk: '#8b6afb' },
      modesById: { m1: '#a73afd', m2: '#8b6afb' },
      collectionId: 'C',
    });
  });

  it('keeps a direct single-mode graph token byte-for-byte compatible', () => {
    const graph = buildGraph([{ fileKey: 'L', colls: [{ collection_id: 'S', default_mode: 'only',
      modes: [{ modeId: 'only', name: 'Only' }] }], vars: [{ library_key: K('single'), local_id: 'V:1',
        collection_id: 'S', values_by_mode: { only: 12 }, name: 'space/md', resolved_type: 'FLOAT', code_syntax_web: '' }] }]);
    expect(resolveKeyInMode(graph, K('single'), new Map(), true, new Map())).toEqual({
      token: 'space/md',
      value: '12',
      pinned_axis_used: false,
      unconfirmed_default_used: false,
    });
  });
});

describe('resolveKeyInMode evidence contract', () => {
  it('emits symmetric explicit and ancestor provenance, joining subscribed evidence by library key', () => {
    const subscribed = `VariableCollectionId:${K('5eed')}/4:4`;
    const graphWithKey = crossLibs();
    graphWithKey[1].colls[0].collection_id = 'VariableCollectionId:21:43';
    (graphWithKey[1].colls[0] as { key?: string }).key = K('5eed');
    graphWithKey[1].vars[0].collection_id = 'VariableCollectionId:21:43';
    const r = resolveKeyInMode(
      buildGraph(graphWithKey), K('acc'), new Map([['CT', 't2'], [subscribed, 's2']]), true,
      evidence([
        ['CT', 't2', 'explicit_node', 'LEAF'],
        [subscribed, 's2', 'ancestor_chain', 'FRAME'],
      ]),
    )!;
    expect(r).toMatchObject({
      token: 'text color/accent',
      default_value: '#a73afd',
      effective_rendered_value: '#8b6afb',
      value: '#8b6afb',
      mode_dependent: true,
      effective_mode_source: 'ancestor_chain',
      effective_modes: {
        Theme: { mode: 'Dark', source: 'explicit_node', node_id: 'LEAF' },
        'sub-brand': { mode: 'Solar', source: 'ancestor_chain', node_id: 'FRAME' },
      },
    });
    expect(r.pinned_axis_used).toBe(true);
  });

  it('keeps the diagnostic default but nulls the rendered value when a graph axis is unverifiable', () => {
    const r = resolveKeyInMode(
      buildGraph(crossLibs()), K('acc'), new Map([['CT', 't2']]), false,
      evidence([['CT', 't2', 'explicit_node', 'LEAF']]),
    )!;
    expect(r).toMatchObject({
      default_value: '#a73afd',
      effective_rendered_value: null,
      value: null,
      effective_mode_source: 'unverifiable',
      effective_modes: {
        Theme: { mode: 'Dark', source: 'explicit_node', node_id: 'LEAF' },
        'sub-brand': { mode: 'default', source: 'unverifiable' },
      },
    });
    expect(r.unconfirmed_default_used).toBe(true);
  });

  it('confirms every absent graph axis as its default under complete coverage', () => {
    const r = resolveKeyInMode(buildGraph(crossLibs()), K('acc'), new Map(), true, new Map())!;
    expect(r.default_value).toBe('#a73afd');
    expect(r.effective_rendered_value).toBe(r.default_value);
    expect(r.value).toBe(r.default_value);
    expect(r.effective_mode_source).toBe('confirmed_default');
    expect(r.effective_modes).toEqual({
      Theme: { mode: 'Light', source: 'confirmed_default' },
      'sub-brand': { mode: 'default', source: 'confirmed_default' },
    });
  });

  it('makes a present-but-invalid graph pin unverifiable even with complete coverage', () => {
    const r = resolveKeyInMode(
      buildGraph(crossLibs()), K('acc'), new Map([['CT', 't2'], ['CS', 'bogus']]), true,
      evidence([
        ['CT', 't2', 'explicit_node', 'LEAF'],
        ['CS', 'bogus', 'ancestor_chain', 'FRAME'],
      ]),
    )!;
    expect(r.value).toBeNull();
    expect(r.effective_rendered_value).toBeNull();
    expect(r.effective_mode_source).toBe('unverifiable');
    expect(r.effective_modes?.['sub-brand']).toEqual({ mode: 'default', source: 'unverifiable' });
  });

  it('matches a subscribed collection against a stored published origin key', () => {
    const origin = crossLibs();
    origin[1].colls[0].collection_id = 'VariableCollectionId:21:43';
    (origin[1].colls[0] as { key?: string }).key = K('5eed');
    origin[1].vars[0].collection_id = 'VariableCollectionId:21:43';
    const pin = `VariableCollectionId:${K('5eed')}/34:56`;
    const r = resolveKeyInMode(
      buildGraph(origin), K('acc'), new Map([[pin, 's2']]), true,
      evidence([[pin, 's2', 'ancestor_chain', 'PAGE']]),
    )!;
    expect(r.value).toBe('#8b6afb');
    expect(r.effective_modes?.['sub-brand']).toEqual({ mode: 'Solar', source: 'ancestor_chain', node_id: 'PAGE' });
  });
});

describe('collectionLibKey', () => {
  it('extracts a subscribed collection library key and leaves plain ids intact', () => {
    expect(collectionLibKey(`VariableCollectionId:${K('a1')}/34:56`)).toBe(K('a1'));
    expect(collectionLibKey('VariableCollectionId:abc123')).toBe('abc123');
  });
});

const KK = (c: string) => c.repeat(40);
const evLib = (over: Partial<Lib> = {}): Lib => ({
  fileKey: 'LIBFILE',
  vars: [
    { library_key: KK('a'), local_id: 'V:1', collection_id: 'C1', name: 'brand/primary', resolved_type: 'COLOR',
      values_by_mode: { m1: { r: 1, g: 0, b: 0 } }, code_syntax_web: 'var(--ds-primary)' },
    { library_key: KK('b'), local_id: 'V:2', collection_id: 'C1', name: 'brand/secondary', resolved_type: 'COLOR',
      values_by_mode: { m1: { r: 0, g: 1, b: 0 } }, code_syntax_web: '--ds-Secondary' },
    { library_key: KK('c'), local_id: 'V:3', collection_id: 'C2', name: 'button/bg', resolved_type: 'COLOR',
      values_by_mode: { m1: { r: 0, g: 0, b: 1 }, m2: { type: 'VARIABLE_ALIAS', id: `VariableID:${KK('a')}/1:1` } }, code_syntax_web: '' },
  ],
  colls: [
    { collection_id: 'C1', default_mode: 'm1', modes: [{ modeId: 'm1', name: 'Only' }] },
    { collection_id: 'C2', default_mode: 'm1', modes: [{ modeId: 'm1', name: 'L' }, { modeId: 'm2', name: 'D' }] },
  ],
  ...over,
});

describe('graph codeSyntax evidence primitives', () => {
  it('indexes authored names while preserving CSS custom-property case', () => {
    const graph = buildGraph([evLib(), evLib()]);
    expect(graphAuthoredName(graph, KK('a').toUpperCase())).toBe('--ds-primary');
    expect(graphAuthoredName(graph, KK('c'))).toBeUndefined();
    expect(graphIdsByCssName(graph, '--ds-Secondary')).toEqual([KK('b')]);
    expect(graphIdsByCssName(graph, '--ds-secondary')).toEqual([]);
  });

  it('walks aliases across all modes and preserves unknown graph holes', () => {
    const graph = buildGraph([evLib()]);
    expect(graphAliasWalk(graph, { kind: 'key', key: KK('c') }, { kind: 'key', key: KK('a') })).toBe('related');
    expect(graphAliasWalk(graph, { kind: 'key', key: KK('b') }, { kind: 'key', key: KK('a') })).toBe('unrelated');
    const hole = evLib();
    hole.vars[2].values_by_mode = { m1: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' } };
    expect(graphAliasWalk(buildGraph([hole]), { kind: 'key', key: KK('c') }, { kind: 'key', key: KK('a') })).toBe('unknown');
  });
});

describe('graphCssEvidenceView transitive scope', () => {
  it('admits a minter reached through an alias chain but not an unrelated file', () => {
    const graph = buildGraph([
      { fileKey: 'F1', vars: [
        { library_key: KK('a'), local_id: 'V:1', collection_id: 'C1', name: 'sem/x', resolved_type: 'COLOR',
          values_by_mode: { m: { type: 'VARIABLE_ALIAS', id: `VariableID:${KK('b')}/2:2` } }, code_syntax_web: '' }],
        colls: [{ collection_id: 'C1', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
      { fileKey: 'F2', vars: [
        { library_key: KK('b'), local_id: 'V:2', collection_id: 'C2', name: 'prim/x', resolved_type: 'COLOR',
          values_by_mode: { m: { r: 1, g: 1, b: 1 } }, code_syntax_web: '' },
        { library_key: KK('c'), local_id: 'V:3', collection_id: 'C2', name: 'other/y', resolved_type: 'COLOR',
          values_by_mode: { m: { r: 0, g: 0, b: 0 } }, code_syntax_web: '--ds-y' }],
        colls: [{ collection_id: 'C2', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
      { fileKey: 'F3', vars: [
        { library_key: KK('d'), local_id: 'V:4', collection_id: 'C3', name: 'far/z', resolved_type: 'COLOR',
          values_by_mode: { m: { r: 0, g: 0, b: 0 } }, code_syntax_web: '--ds-z' }],
        colls: [{ collection_id: 'C3', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
    ]);
    const view = graphCssEvidenceView(graph, [KK('a')]);
    expect(view.idsByCssName('--ds-y')).toEqual([KK('c')]);
    expect(view.idsByCssName('--ds-z')).toEqual([]);
  });
});
