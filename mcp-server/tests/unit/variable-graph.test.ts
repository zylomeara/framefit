import { describe, it, expect } from 'vitest';
import { buildGraph, resolveKey } from '../../src/domain/variable-graph.js';

const K = (h: string) => h.padEnd(40, '0'); // 40-hex helper
const colls = [{ collection_id: 'C', default_mode: 'm', modes: [{ modeId: 'm', name: 'L' }] }];
const libs = [
  { fileKey: 'L1', vars: [{ library_key: K('aaa'), local_id: 'VariableID:1:1', collection_id: 'C', values_by_mode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('bbb') + '/9:9' } }, name: 'bg/accent', resolved_type: 'COLOR' }], colls },
  { fileKey: 'L2', vars: [{ library_key: K('bbb'), local_id: 'VariableID:9:9', collection_id: 'C', values_by_mode: { m: { r: 0.65, g: 0.23, b: 0.99, a: 1 } }, name: 'purple', resolved_type: 'COLOR' }], colls },
];
describe('variable-graph', () => {
  it('resolves a cross-library alias chain to hex (default mode)', () => {
    const g = buildGraph(libs);
    expect(resolveKey(g, K('aaa')).value).toBe('#a63bfc');
  });
  it('resolves a within-library alias hop (same fileKey, local id)', () => {
    const within = [{ fileKey: 'L1', vars: [
      { library_key: K('ccc'), local_id: 'VariableID:1:1', collection_id: 'C', values_by_mode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:2:2' } }, name: 'semantic', resolved_type: 'COLOR' },
      { library_key: '', local_id: 'VariableID:2:2', collection_id: 'C', values_by_mode: { m: { r: 0, g: 0, b: 0, a: 1 } }, name: 'primitive', resolved_type: 'COLOR' },
    ], colls }];
    const g = buildGraph(within);
    expect(resolveKey(g, K('ccc')).value).toBe('#000000');
  });
  it('reports missingKey when target not in graph', () => {
    const g = buildGraph([libs[0]]);
    const r = resolveKey(g, K('aaa'));
    expect(r.value).toBeUndefined();
    expect(r.missingKey).toBe(K('bbb'));
  });
  it('resolves a literal number to string', () => {
    const g = buildGraph([{ fileKey: 'L', vars: [{ library_key: K('ddd'), local_id: 'VariableID:1:1', collection_id: 'C', values_by_mode: { m: 16 }, name: 'sp', resolved_type: 'FLOAT' }], colls }]);
    expect(resolveKey(g, K('ddd')).value).toBe('16');
  });
  it('uses per-file default mode when two libraries share a collection_id', () => {
    const collsL1 = [{ collection_id: 'C', default_mode: 'mLight', modes: [{ modeId: 'mLight', name: 'Light' }] }];
    const collsL2 = [{ collection_id: 'C', default_mode: 'mDark', modes: [{ modeId: 'mDark', name: 'Dark' }] }];
    const g = buildGraph([
      { fileKey: 'L1', vars: [{ library_key: K('e1e'), local_id: 'VariableID:1:1', collection_id: 'C',
        values_by_mode: { mLight: { r: 1, g: 1, b: 1, a: 1 }, mDark: { r: 0, g: 0, b: 0, a: 1 } }, name: 'bg', resolved_type: 'COLOR' }], colls: collsL1 },
      { fileKey: 'L2', vars: [{ library_key: K('e2e'), local_id: 'VariableID:1:1', collection_id: 'C',
        values_by_mode: { mLight: { r: 1, g: 1, b: 1, a: 1 }, mDark: { r: 0, g: 0, b: 0, a: 1 } }, name: 'bg', resolved_type: 'COLOR' }], colls: collsL2 },
    ]);
    expect(resolveKey(g, K('e1e')).value).toBe('#ffffff'); // L1 default = Light
    expect(resolveKey(g, K('e2e')).value).toBe('#000000'); // L2 default = Dark
  });

  it('returns name for a COLOR var', () => {
    const g = buildGraph([{ fileKey: 'L', vars: [{ library_key: K('eee'), local_id: 'VariableID:1:1', collection_id: 'C', values_by_mode: { m: { r: 0.141, g: 0.141, b: 0.161, a: 1 } }, name: 'neutral/fg/primary', resolved_type: 'COLOR' }], colls }]);
    const r = resolveKey(g, K('eee'));
    expect(r.value).toBe('#242429');
    expect(r.name).toBe('neutral/fg/primary');
  });

  it('carries the LEAF name through a cross-library alias hop', () => {
    const aliasLibs = [
      { fileKey: 'L1', vars: [{ library_key: K('f11'), local_id: 'VariableID:1:1', collection_id: 'C', values_by_mode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('c33') + '/9:9' } }, name: 'semantic/white', resolved_type: 'COLOR' }], colls },
      { fileKey: 'L2', vars: [{ library_key: K('c33'), local_id: 'VariableID:9:9', collection_id: 'C', values_by_mode: { m: { r: 1, g: 1, b: 1, a: 1 } }, name: 'primitive/white', resolved_type: 'COLOR' }], colls },
    ];
    const g = buildGraph(aliasLibs);
    const r = resolveKey(g, K('f11'));
    expect(r.value).toBe('#ffffff');
    expect(r.name).toBe('primitive/white');
  });
});
