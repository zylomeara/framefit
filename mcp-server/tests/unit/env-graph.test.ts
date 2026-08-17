import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseTeamIds, createEnvGraph } from '../../src/infrastructure/env-graph.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } } as any;

// Raw /variables/local fixture with one single-mode and one multi-mode color collection, in the
// exact shape syncUser parses (variables keyed by published `key`, collections carry defaultModeId
// + modes). Both live in one file ('good'), so the accumulated graph has one Lib with two vars.
const RAW = {
  meta: {
    variables: {
      v1: { id: 'VariableID:1:1', key: 'a'.repeat(40), name: 'color/bg', valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }, variableCollectionId: 'C', resolvedType: 'COLOR' },
      v2: { id: 'VariableID:2:2', key: 'b'.repeat(40), name: 'color/surface', valuesByMode: { light: { r: 1, g: 1, b: 1, a: 1 }, dark: { r: 0, g: 0, b: 0, a: 1 } }, variableCollectionId: 'D', resolvedType: 'COLOR' },
    },
    variableCollections: {
      C: { id: 'C', name: 'ThemeSingle', key: '', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }] },
      D: { id: 'D', name: 'ThemeMulti', key: '', defaultModeId: 'light', modes: [{ modeId: 'light', name: 'Light' }, { modeId: 'dark', name: 'Dark' }] },
    },
  },
};
const SINGLE_KEY = 'a'.repeat(40);
const MULTI_KEY = 'b'.repeat(40);

function makeApi(getVars?: (fk: string) => Promise<unknown>): FigmaApi {
  return {
    getTeamProjects: async () => [{ id: 'p1', name: 'DS' }],
    getProjectFiles: async () => [{ key: 'good', name: 'DS Colors' }],
    getVariablesLocal: getVars ?? (async () => RAW),
  } as unknown as FigmaApi;
}

// Total transient outage: every team's discovery rejects, but syncUser SWALLOWS the per-team error
// (try/catch → continue) and returns CLEANLY with libs=[] — no throw. The env-graph must treat that
// empty result as unconfirmed (short retry), not a success memoized for the full ttlMs.
function outageApi(): FigmaApi {
  return { getTeamProjects: async () => { throw new Error('Figma 429 rate limited'); } } as unknown as FigmaApi;
}

describe('parseTeamIds', () => {
  it('splits a comma list, trimming each id', () => {
    expect(parseTeamIds('123, 456')).toEqual(['123', '456']);
  });
  it('unwraps a figma.com/team/<id> URL to the bare id', () => {
    expect(parseTeamIds('https://www.figma.com/files/abc/team/789012?foo=bar')).toEqual(['789012']);
  });
  it('drops empty elements from trailing commas / stray spaces', () => {
    expect(parseTeamIds('123, 456, ')).toEqual(['123', '456']);
    expect(parseTeamIds('  123  ,,  456 ')).toEqual(['123', '456']);
  });
  it('returns [] for an empty string or undefined', () => {
    expect(parseTeamIds('')).toEqual([]);
    expect(parseTeamIds(undefined)).toEqual([]);
  });
  it('throws naming every invalid (non-digit) element', () => {
    expect(() => parseTeamIds('123, abc')).toThrow(/abc/);
    expect(() => parseTeamIds('abc, 123, x-9')).toThrow(/abc.*x-9|x-9.*abc/);
  });
});

describe('createEnvGraph build via syncUser mechanism', () => {
  it('resolves undefined before ensureReady, then a fixture value after', async () => {
    const g = createEnvGraph({ teamIds: ['T1'], token: 'figd_x', buildApi: () => makeApi(), logger });
    expect(g.resolve(SINGLE_KEY)).toBeUndefined();
    await g.ensureReady();
    expect(g.resolve(SINGLE_KEY)).toEqual({ value: '#ffffff', name: 'color/bg', sourceLibrary: 'good' });
  });

  it('two parallel ensureReady() trigger exactly one build', async () => {
    const buildApi = vi.fn(() => makeApi());
    const g = createEnvGraph({ teamIds: ['T1'], token: 'figd_x', buildApi, logger });
    await Promise.all([g.ensureReady(), g.ensureReady()]);
    expect(buildApi).toHaveBeenCalledTimes(1);
    expect(g.resolve(SINGLE_KEY)?.value).toBe('#ffffff');
  });
});

describe('createEnvGraph wrapper completeness (mode-aware)', () => {
  it('resolveInMode / isMultiMode work on the multi-mode fixture', async () => {
    const g = createEnvGraph({ teamIds: ['T1'], token: 'figd_x', buildApi: () => makeApi(), logger });
    await g.ensureReady();

    expect(g.isMultiMode(MULTI_KEY)).toBe(true);
    expect(g.isMultiMode(SINGLE_KEY)).toBe(false);

    // The mutation-lock: a wrapper missing resolveInMode would throw here (RED). Spec HIGH.
    const r = g.resolveInMode(MULTI_KEY, new Map(), true, new Map());
    expect(r).toBeDefined();
    expect(r!.value).toBe('#ffffff');       // default mode 'light'
    expect(r!.effective_modes).toEqual({ ThemeMulti: { mode: 'Light', source: 'confirmed_default' } });
    expect(r!.effective_mode_source).toBe('confirmed_default');
    expect(r!.mode_dependent).toBe(true);

    // resolve() also surfaces both modes for a multi-mode key.
    expect(g.resolve(MULTI_KEY)?.modesByName).toEqual({ Light: '#ffffff', Dark: '#000000' });
  });
});

describe('createEnvGraph retry + TTL (fake clock)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('degrades on a thrown build and only retries after retryIntervalMs', async () => {
    let attempt = 0;
    const buildApi = vi.fn(() => {
      attempt++;
      if (attempt === 1) throw new Error('Figma 429 rate limited'); // uncaught by syncUser → build throws
      return makeApi();
    });
    const g = createEnvGraph({ teamIds: ['T1'], token: 'figd_x', buildApi, logger, retryIntervalMs: 1000 });

    vi.setSystemTime(0);
    await g.ensureReady();                       // build throws → degraded (no reject)
    expect(g.resolve(SINGLE_KEY)).toBeUndefined();
    expect(buildApi).toHaveBeenCalledTimes(1);

    await g.ensureReady();                        // still within retry interval → not restarted
    expect(buildApi).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1001);
    await g.ensureReady();                        // past interval → rebuild, now succeeds
    expect(buildApi).toHaveBeenCalledTimes(2);
    expect(g.resolve(SINGLE_KEY)?.value).toBe('#ffffff');

    await g.ensureReady();                        // success is memoized → no rebuild
    expect(buildApi).toHaveBeenCalledTimes(2);
  });

  it('rebuilds only once the TTL has elapsed', async () => {
    const buildApi = vi.fn(() => makeApi());
    const g = createEnvGraph({ teamIds: ['T1'], token: 'figd_x', buildApi, logger, ttlMs: 5000 });

    vi.setSystemTime(0);
    await g.ensureReady();
    expect(buildApi).toHaveBeenCalledTimes(1);

    vi.setSystemTime(4999);
    await g.ensureReady();                        // within TTL → no rebuild
    expect(buildApi).toHaveBeenCalledTimes(1);

    vi.setSystemTime(5001);
    await g.ensureReady();                        // past TTL → rebuild
    expect(buildApi).toHaveBeenCalledTimes(2);
  });

  it('an empty (not thrown) all-teams outage retries every retryIntervalMs until a good build takes over the TTL branch', async () => {
    let attempt = 0;
    const buildApi = vi.fn(() => {
      attempt++;
      return attempt <= 2 ? outageApi() : makeApi();  // outage clears on the 3rd build
    });
    const g = createEnvGraph({ teamIds: ['T1'], token: 'figd_x', buildApi, logger, retryIntervalMs: 1000, ttlMs: 5000 });

    vi.setSystemTime(0);
    await g.ensureReady();                         // empty (libs=[], not thrown) → NOT a confirmed success
    expect(g.resolve(SINGLE_KEY)).toBeUndefined();
    expect(buildApi).toHaveBeenCalledTimes(1);

    await g.ensureReady();                         // within retryIntervalMs → not rebuilt (not frozen for ttlMs)
    expect(buildApi).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1001);
    await g.ensureReady();                         // past retryIntervalMs → rebuild (outage persists → still empty)
    expect(buildApi).toHaveBeenCalledTimes(2);
    expect(g.resolve(SINGLE_KEY)).toBeUndefined();

    vi.setSystemTime(2002);
    await g.ensureReady();                         // past retryIntervalMs again → rebuild, outage cleared → success
    expect(buildApi).toHaveBeenCalledTimes(3);
    expect(g.resolve(SINGLE_KEY)?.value).toBe('#ffffff');

    vi.setSystemTime(2002 + 4999);
    await g.ensureReady();                         // confirmed success now governs: within ttlMs → no rebuild
    expect(buildApi).toHaveBeenCalledTimes(3);

    vi.setSystemTime(2002 + 5001);
    await g.ensureReady();                         // past ttlMs → rebuild
    expect(buildApi).toHaveBeenCalledTimes(4);
  });

  it('keeps a previously-good graph when a post-TTL resync yields zero libraries (stale-good), re-attempting only after retryIntervalMs', async () => {
    let attempt = 0;
    const buildApi = vi.fn(() => {
      attempt++;
      return attempt === 2 ? outageApi() : makeApi();  // 1: good, 2: outage (empty), 3: good again
    });
    const g = createEnvGraph({ teamIds: ['T1'], token: 'figd_x', buildApi, logger, retryIntervalMs: 1000, ttlMs: 5000 });

    vi.setSystemTime(0);
    await g.ensureReady();                          // good build → confirmed success
    expect(buildApi).toHaveBeenCalledTimes(1);
    expect(g.resolve(SINGLE_KEY)?.value).toBe('#ffffff');

    vi.setSystemTime(5001);
    await g.ensureReady();                          // past ttlMs → resync hits the outage (empty, not thrown)
    expect(buildApi).toHaveBeenCalledTimes(2);
    expect(g.resolve(SINGLE_KEY)?.value).toBe('#ffffff');   // OLD graph KEPT — not wiped to undefined

    vi.setSystemTime(5001 + 999);
    await g.ensureReady();                          // within retryIntervalMs of the empty resync → no re-attempt
    expect(buildApi).toHaveBeenCalledTimes(2);
    expect(g.resolve(SINGLE_KEY)?.value).toBe('#ffffff');   // still serving stale-good

    vi.setSystemTime(5001 + 1001);
    await g.ensureReady();                          // past retryIntervalMs → re-attempt, outage cleared → fresh
    expect(buildApi).toHaveBeenCalledTimes(3);
    expect(g.resolve(SINGLE_KEY)?.value).toBe('#ffffff');
  });
});
