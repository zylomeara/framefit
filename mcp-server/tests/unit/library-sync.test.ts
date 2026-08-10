import { describe, it, expect } from 'vitest';
import { syncUser } from '../../src/multi-tenant/library-sync.js';

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } } as any;

const LIB_META = { meta: {
  variables: { v1: { id: 'VariableID:1:1', key: 'k'.repeat(40), name: 'bg', valuesByMode: { m: '#fff' }, variableCollectionId: 'C', resolvedType: 'COLOR', codeSyntax: { WEB: 'var(--ds-bg)' } }, vNoKey: { id: 'VariableID:2:2', name: 'x', valuesByMode: { m: 1 }, variableCollectionId: 'C', resolvedType: 'FLOAT' } },
  variableCollections: { C: { id: 'C', name: 'ThemeColl', key: 'c011ec110bab1e'.padEnd(40, '0'), defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
} };

function makeDeps(over: any = {}) {
  const replaced: any[] = [];
  const setLibs: any[] = [];
  const setTeamIds: string[] = [];
  const setPreserves: (string[] | 'all' | undefined)[] = [];
  const fetchCounts: Record<string, number> = {};
  const deps = {
    buildApi: () => ({
      getTeamProjects: async () => [{ id: 'p1', name: 'DS libraries' }],
      getProjectFiles: async () => [{ key: 'good', name: 'DS Colors' }, { key: 'bad', name: 'Huge' }, { key: 'empty', name: 'Consumer' }],
      getVariablesLocal: async (fk: string) => {
        fetchCounts[fk] = (fetchCounts[fk] ?? 0) + 1;
        if (fk === 'bad') throw new Error('timeout');
        if (fk === 'empty') return { meta: { variables: {}, variableCollections: {} } };
        return LIB_META;
      },
    }),
    getPat: async () => 'figd_x',
    listTeams: async () => ['T1'],
    setLibraries: async (_u: string, t: string, libs: any[], preserve?: string[] | 'all') => { setLibs.push(libs); setTeamIds.push(t); setPreserves.push(preserve); },
    replaceLibrary: async (_u: string, fk: string, vars: any[], colls: any[]) => { replaced.push({ fk, vars, colls }); },
    logger,
    ...over,
  };
  return { deps, replaced, setLibs, setTeamIds, setPreserves, fetchCounts };
}

describe('syncUser', () => {
  it('enumerates, parses raw, replaces; skips a file that throws; skips no-key vars and empty files', async () => {
    const { deps, replaced, setLibs } = makeDeps();
    const res = await syncUser('u1', deps);
    expect(res.skipped).toBe(1);             // 'bad' threw
    expect(replaced).toHaveLength(1);         // only 'good' stored ('empty' has no keyed vars)
    expect(replaced[0].fk).toBe('good');
    expect(replaced[0].vars).toHaveLength(1); // vNoKey (no published key) dropped
    expect(replaced[0].vars[0].library_key).toBe('k'.repeat(40));
    // The 7th field is asserted EXPLICITLY: the sync literal is type-unchecked (SyncDeps takes
    // unknown[]), so forgetting it compiles green everywhere - only this line goes red.
    expect(replaced[0].vars[0].code_syntax_web).toBe('var(--ds-bg)');
    expect(replaced[0].colls[0]).toEqual({ collection_id: 'C', default_mode: 'm', modes: [{ modeId: 'm', name: 'L' }], name: 'ThemeColl', key: 'c011ec110bab1e'.padEnd(40, '0') });
    expect(res.libraries).toBe(1);
    expect(res.variables).toBe(1);
    expect(setLibs[0]).toEqual([{ file_key: 'good', name: 'DS Colors', vars: 1 }]); // registry gets only real libraries
  });
  it('fetches /variables/local exactly once per file (no double-fetch)', async () => {
    const { deps, fetchCounts } = makeDeps();
    await syncUser('u1', deps);
    expect(fetchCounts).toEqual({ good: 1, bad: 1, empty: 1 });
  });
  it('skips a project whose getProjectFiles is forbidden, without failing the sync', async () => {
    const { deps, replaced } = makeDeps({
      buildApi: () => ({
        getTeamProjects: async () => [{ id: 'pForbidden', name: 'No access' }, { id: 'pOk', name: 'DS' }],
        getProjectFiles: async (pid: string) => {
          if (pid === 'pForbidden') throw new Error('Figma denied access to this file. Token may not have access.');
          return [{ key: 'good', name: 'DS Colors' }];
        },
        getVariablesLocal: async () => LIB_META,
      }),
    });
    const res = await syncUser('u1', deps);
    expect(replaced.map((r) => r.fk)).toEqual(['good']); // pForbidden skipped, pOk kept
    expect(res.libraries).toBe(1);
  });
  it('returns zeros when no PAT', async () => {
    const { deps } = makeDeps({ getPat: async () => null });
    expect(await syncUser('u1', deps)).toEqual({ libraries: 0, variables: 0, skipped: 0 });
  });

  it('with opts.teamId, iterates only that one registered team', async () => {
    const { deps, setLibs, setTeamIds } = makeDeps({ listTeams: async () => ['T1', 'T2'] });
    await syncUser('u1', deps, { teamId: 'T2' });
    // setLibraries is called once per iterated team — exactly one team (T2) iterated.
    expect(setLibs).toHaveLength(1);
    expect(setTeamIds).toEqual(['T2']);
  });

  it('with opts.teamId not in the registered list, iterates nothing → zeros', async () => {
    const { deps, replaced, setLibs } = makeDeps({ listTeams: async () => ['T1', 'T2'] });
    const res = await syncUser('u1', deps, { teamId: 'T999' });
    expect(setLibs).toHaveLength(0);
    expect(replaced).toHaveLength(0);
    expect(res).toEqual({ libraries: 0, variables: 0, skipped: 0 });
  });

  it('a file whose fetch failed is passed as preserve (registry row shielded from eviction)', async () => {
    const { deps, setPreserves, setLibs } = makeDeps();
    await syncUser('u1', deps);
    expect(setPreserves).toEqual([['bad']]);                    // 'bad' threw -> shielded, not evicted
    expect(setLibs[0].map((l: any) => l.file_key)).toEqual(['good']);  // successes still rewrite
  });

  it("a failed project enumeration disables eviction for the whole team (preserve 'all')", async () => {
    const { deps, setPreserves } = makeDeps({
      buildApi: () => ({
        getTeamProjects: async () => [{ id: 'pForbidden', name: 'No access' }, { id: 'pOk', name: 'DS' }],
        getProjectFiles: async (pid: string) => {
          if (pid === 'pForbidden') throw new Error('403');
          return [{ key: 'good', name: 'DS Colors' }];
        },
        getVariablesLocal: async () => LIB_META,
      }),
    });
    await syncUser('u1', deps);
    expect(setPreserves).toEqual(['all']);
  });

  it('a clean sync passes no preserve (legitimate eviction still works)', async () => {
    const { deps, setPreserves } = makeDeps({
      buildApi: () => ({
        getTeamProjects: async () => [{ id: 'p1', name: 'DS' }],
        getProjectFiles: async () => [{ key: 'good', name: 'DS Colors' }, { key: 'empty', name: 'Consumer' }],
        getVariablesLocal: async (fk: string) => (fk === 'empty' ? { meta: { variables: {}, variableCollections: {} } } : LIB_META),
      }),
    });
    await syncUser('u1', deps);
    expect(setPreserves).toEqual([undefined]);                  // 'empty' (no published vars) is NOT preserved
  });
});
