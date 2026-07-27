// tests/unit/status-fixtures.ts   (not *.test.ts, so vitest does not collect it as a suite)
import { vi } from 'vitest';
import type { StatusCtx } from '../../src/infrastructure/status.js';
import type { CliDeps } from '../../src/infrastructure/cli.js';
import { syncUser } from '../../src/multi-tenant/library-sync.js';
import { createEnvGraph } from '../../src/infrastructure/env-graph.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';

export const baseCtx = (over: Partial<StatusCtx> = {}): StatusCtx => ({
  env: {}, now: () => 1_700_000_000_000, multiTenant: false, transport: undefined, probe: false,
  signBridgeToken: async () => 'tok',
  verifyBridgeToken: async () => 'status-selftest',
  validatePat: async () => ({ ok: true, handle: 'h' }),
  hostname: 'box', pid: 7, secrets: new Set<string>(), ...over,
});

export const cliLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return cliLogger; } } as never;

// A library-variable fixture in the exact /variables/local shape syncUser parses: one file
// 'good' with two published COLOR variables (one single-mode, one multi-mode).
export const SINGLE_KEY = 'a'.repeat(40);
export const MULTI_KEY = 'b'.repeat(40);
const RAW = {
  meta: {
    variables: {
      v1: { id: 'VariableID:1:1', key: SINGLE_KEY, name: 'color/bg', valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }, variableCollectionId: 'C', resolvedType: 'COLOR' },
      v2: { id: 'VariableID:2:2', key: MULTI_KEY, name: 'color/surface', valuesByMode: { light: { r: 1, g: 1, b: 1, a: 1 }, dark: { r: 0, g: 0, b: 0, a: 1 } }, variableCollectionId: 'D', resolvedType: 'COLOR' },
    },
    variableCollections: {
      C: { id: 'C', name: 'ThemeSingle', key: '', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }] },
      D: { id: 'D', name: 'ThemeMulti', key: '', defaultModeId: 'light', modes: [{ modeId: 'light', name: 'Light' }, { modeId: 'dark', name: 'Dark' }] },
    },
  },
};

export function libraryApi(raw: unknown = RAW): FigmaApi {
  return {
    getTeamProjects: async () => [{ id: 'p1', name: 'DS' }],
    getProjectFiles: async () => [{ key: 'good', name: 'DS Colors' }],
    getVariablesLocal: async () => raw,
  } as unknown as FigmaApi;
}

// A team with no library files → syncUser returns zero libraries.
export function emptyApi(): FigmaApi {
  return {
    getTeamProjects: async () => [{ id: 'p1', name: 'DS' }],
    getProjectFiles: async () => [],
    getVariablesLocal: async () => ({ meta: {} }),
  } as unknown as FigmaApi;
}

export interface Bufs { deps: CliDeps; out: () => string; err: () => string }

/**
 * The injected-deps surface for a CLI invocation, every side effect a spy. Shared by cli.test.ts and
 * the status gates, so a new REQUIRED field on CliDeps is added here once. The stats fixtures are
 * checked against the real TokenStats/GraphStats through the `CliDeps` annotation below: a field
 * added to either interface fails to compile here rather than being silently absent.
 */
export function makeDeps(over: Partial<CliDeps> & { env?: NodeJS.ProcessEnv } = {}): Bufs {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  const base: CliDeps = {
    env: {},
    out: (s) => { outBuf.push(s); },
    err: (s) => { errBuf.push(s); },
    logger: cliLogger,
    buildApi: () => libraryApi(),
    syncUser,
    createEnvGraph,
    initDb: vi.fn(),
    closeDb: vi.fn(async () => {}),
    ensureSchema: vi.fn(async () => {}),
    ensureLibraryRegistrySchema: vi.fn(async () => {}),
    ensureLibraryGraphSchema: vi.fn(async () => {}),
    addTeam: vi.fn(async () => {}),
    listTeams: vi.fn(async () => []),
    removeTeam: vi.fn(async () => {}),
    listUsers: vi.fn(async () => []),
    getDefaultPat: vi.fn(async () => null),
    setLibraries: vi.fn(async () => {}),
    replaceLibrary: vi.fn(async () => {}),
    signBridgeToken: vi.fn(async (u: string, _k: string, ttl: number) => `signed.${u}.${ttl}`),
    tokenStats: vi.fn(async () => ({ stored: 0, invalid_non_default: 0, users_without_default: [],
      users_without_any_token: [], bad_defaults: [], soonest_default_expiry: null,
      validation_age_sec: null, stale_or_unvalidated_total: 0,
      future_validation_detected: false })),
    graphStats: vi.fn(async () => ({ libraries: 0, variables: 0, teams: 0,
      users_with_teams_and_no_libraries: [], users_with_partial_team_gaps: [],
      oldest_synced_at: null, oldest_age_sec: null })),
    validatePat: vi.fn(async () => ({ ok: true as const, handle: 'h' })),
    verifyBridgeToken: vi.fn(async () => 'status-selftest'),
    now: () => 1_700_000_000_000,
    hostname: () => 'test-host',
    pid: () => 4242,
  };
  const deps = { ...base, ...over } as CliDeps;
  // Always route io to our buffers regardless of overrides.
  deps.out = (s) => { outBuf.push(s); };
  deps.err = (s) => { errBuf.push(s); };
  return { deps, out: () => outBuf.join(''), err: () => errBuf.join('') };
}
