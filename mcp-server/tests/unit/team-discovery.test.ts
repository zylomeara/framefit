import { describe, it, expect } from 'vitest';
import { discoverLibraries } from '../../src/multi-tenant/team-discovery.js';

function fakeApi(map: Record<string, number>) {
  return {
    getTeamProjects: async () => [{ id: 'p1', name: 'DS libraries' }],
    getProjectFiles: async () => [{ key: 'libA', name: 'DS Colors' }, { key: 'cons', name: 'Consumer' }],
    getVariablesLocal: async (fk: string) => ({ meta: { variables: Object.fromEntries(Array.from({ length: map[fk] ?? 0 }, (_, i) => [String(i), { id: String(i) }])), variableCollections: {} } }),
  } as any;
}
describe('discoverLibraries', () => {
  it('returns files that expose variables, skips empty ones', async () => {
    const libs = await discoverLibraries(fakeApi({ libA: 5, cons: 0 }), 'TEAM');
    expect(libs).toEqual([{ file_key: 'libA', name: 'DS Colors', vars: 5 }]);
  });
  it('tolerates a file whose getVariablesLocal throws (skips it)', async () => {
    const api = fakeApi({ libA: 5 });
    api.getVariablesLocal = async (fk: string) => { if (fk === 'cons') throw new Error('boom'); return { meta: { variables: { '0': { id: '0' } } } }; };
    const libs = await discoverLibraries(api, 'TEAM');
    expect(libs.map((l: any) => l.file_key)).toEqual(['libA']); // cons threw → skipped
  });
  it('tolerates a project whose getProjectFiles throws (skips that project, keeps others)', async () => {
    const api = {
      getTeamProjects: async () => [{ id: 'p1', name: 'DS' }, { id: 'p2', name: 'Forbidden' }],
      getProjectFiles: async (pid: string) => {
        if (pid === 'p2') throw new Error('Figma denied access to this file. Token may not have access.');
        return [{ key: 'libA', name: 'DS Colors' }];
      },
      getVariablesLocal: async () => ({ meta: { variables: { '0': { id: '0' }, '1': { id: '1' } } } }),
    } as any;
    const libs = await discoverLibraries(api, 'TEAM');
    expect(libs.map((l: any) => l.file_key)).toEqual(['libA']); // p2 forbidden → skipped, p1 kept
  });
});
