import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createEnvGraphFromConfig, multiTenantEnvGraphConflict, type EnvGraphConfig,
} from '../../src/infrastructure/env-graph.js';
import { registerGetVariablesTool } from '../../src/adapters/driving/tools/get-variables-tool.js';
import { registerGetDesignContextTool } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

// A single library file 'libfile' with ONE published single-mode COLOR variable whose 40-hex-
// lowercase published `.key` is LIB_KEY and whose default-mode value is a terminal color (#0000ff).
// This is the graph SOURCE the env graph syncs (via syncUser → getTeamProjects/getProjectFiles/
// getVariablesLocal). Its four conditions are kept mutually consistent with the CONSUMER fixture
// below (the consumer's alias_of embeds the SAME LIB_KEY).
const LIB_KEY = '0123456789abcdef0123456789abcdef01234567'; // exactly 40 hex chars, lower-case
const LIB_RAW = {
  meta: {
    variables: {
      'VariableID:10:1': {
        id: 'VariableID:10:1', key: LIB_KEY, name: 'palette/blue',
        valuesByMode: { lm1: { r: 0, g: 0, b: 1, a: 1 } }, variableCollectionId: 'LC', resolvedType: 'COLOR',
      },
    },
    variableCollections: {
      LC: { id: 'LC', name: 'Palette', key: '', defaultModeId: 'lm1', modes: [{ modeId: 'lm1', name: 'Default' }] },
    },
  },
};

/** A FigmaApi that drives the env-graph library sync: team → project → the single library file. */
function libraryApi(raw: unknown = LIB_RAW): FigmaApi {
  return {
    getTeamProjects: async () => [{ id: 'p1', name: 'DS' }],
    getProjectFiles: async () => [{ key: 'libfile', name: 'Palette' }],
    getVariablesLocal: async () => raw,
  } as unknown as FigmaApi;
}

// ── createEnvGraphFromConfig: the deps-injection decision ──────────────────────────────────────
describe('createEnvGraphFromConfig (variableGraph injection decision)', () => {
  const base: EnvGraphConfig = { DS_LIBRARY_TTL_SEC: 86400 };

  it('returns undefined when DS_TEAM_IDS is unset — byte-for-byte the prior no-graph behaviour', () => {
    expect(createEnvGraphFromConfig({ ...base, FIGMA_TOKEN: 'figd_x' }, logger, () => libraryApi())).toBeUndefined();
  });

  it('returns undefined for a blank / comma-only DS_TEAM_IDS (nothing to sync)', () => {
    expect(createEnvGraphFromConfig({ ...base, DS_TEAM_IDS: '   ', FIGMA_TOKEN: 'figd_x' }, logger, () => libraryApi())).toBeUndefined();
    expect(createEnvGraphFromConfig({ ...base, DS_TEAM_IDS: ',', FIGMA_TOKEN: 'figd_x' }, logger, () => libraryApi())).toBeUndefined();
  });

  it('throws (hard boot failure) on a garbage team id — never silently mis-syncs', () => {
    expect(() => createEnvGraphFromConfig({ ...base, DS_TEAM_IDS: '123, not-an-id', FIGMA_TOKEN: 'figd_x' }, logger, () => libraryApi()))
      .toThrow(/not-an-id/);
  });

  it('DS_TEAM_IDS set but NO token → undefined + a single warn (graph is impossible, degrade not crash)', () => {
    const warn = vi.fn();
    const spyLogger = { info() {}, warn, error() {}, debug() {}, child() { return spyLogger; } } as unknown as typeof logger;
    const g = createEnvGraphFromConfig({ ...base, DS_TEAM_IDS: '123' }, spyLogger, () => libraryApi());
    expect(g).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatch(/FIGMA_TOKEN/);
  });

  it('DS_TEAM_IDS + token → an EnvGraph exposing ensureReady/resolve', () => {
    const g = createEnvGraphFromConfig({ ...base, DS_TEAM_IDS: '123', FIGMA_TOKEN: 'figd_x' }, logger, () => libraryApi());
    expect(g).toBeDefined();
    expect(typeof g!.ensureReady).toBe('function');
    expect(typeof g!.resolve).toBe('function');
  });

  describe('ttlMs is wired from DS_LIBRARY_TTL_SEC (fake clock)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('rebuilds only once DS_LIBRARY_TTL_SEC*1000 ms have elapsed', async () => {
      const buildApi = vi.fn(() => libraryApi());
      const g = createEnvGraphFromConfig({ DS_LIBRARY_TTL_SEC: 5, DS_TEAM_IDS: '123', FIGMA_TOKEN: 'figd_x' }, logger, buildApi)!;

      vi.setSystemTime(0);
      await g.ensureReady();
      expect(buildApi).toHaveBeenCalledTimes(1);

      vi.setSystemTime(4999);           // within ttlMs (5*1000) → no rebuild
      await g.ensureReady();
      expect(buildApi).toHaveBeenCalledTimes(1);

      vi.setSystemTime(5001);           // past ttlMs → rebuild (locks ttlMs == DS_LIBRARY_TTL_SEC*1000)
      await g.ensureReady();
      expect(buildApi).toHaveBeenCalledTimes(2);
    });
  });
});

// ── multiTenantEnvGraphConflict: the boot-error guard ───────────────────────────────────────────
describe('multiTenantEnvGraphConflict (MULTI_TENANT + DS_TEAM_IDS boot error)', () => {
  it('returns an explanatory message when BOTH are set', () => {
    const msg = multiTenantEnvGraphConflict({ MULTI_TENANT: 'true', DS_TEAM_IDS: '123' });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/per-user/i);              // MT takes its graph from the DB per user
    expect(msg).toMatch(/database|DB/i);
    expect(msg).toMatch(/Remove DS_TEAM_IDS/i);    // the actionable fix
  });

  it('null when MULTI_TENANT is set but DS_TEAM_IDS is not', () => {
    expect(multiTenantEnvGraphConflict({ MULTI_TENANT: 'true' })).toBeNull();
    expect(multiTenantEnvGraphConflict({ MULTI_TENANT: 'true', DS_TEAM_IDS: '  ' })).toBeNull();
  });

  it('null for the single-tenant env graph (DS_TEAM_IDS without MULTI_TENANT is legitimate)', () => {
    expect(multiTenantEnvGraphConflict({ DS_TEAM_IDS: '123' })).toBeNull();
    expect(multiTenantEnvGraphConflict({ MULTI_TENANT: 'false', DS_TEAM_IDS: '123' })).toBeNull();
  });
});

// ── Integration: get_variables resolves resolved_via:"graph" on the FIRST call ──────────────────
// The CRITICAL lock: the tool must `await deps.variableGraph.ensureReady()` before its resolve loop,
// so the lazy env-graph library sync has run and a cross-library alias resolves via the graph on the
// VERY FIRST call — not "undefined until a later warm-up call". Mutation evidence: removing that
// await turns this RED (graph empty on first read → the token stays alias:true / value:null).
describe('get_variables + env graph: resolved_via:"graph" on the first call', () => {
  function harness(variableGraph: ToolDeps['variableGraph']) {
    const { server, call } = makeFakeMcpServer();
    // The CONSUMER file: one variable aliasing the library variable by the SAME LIB_KEY (four
    // conditions consistent: consumer alias_of = VariableID:<LIB_KEY>/<id>).
    const deps: ToolDeps = {
      buildApi: () => ({ getVariablesLocal: async () => ({ meta: {
        variableCollections: { VC: { id: 'VC', name: 'Theme', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: { V: { id: 'V', name: 'bg/accent', resolvedType: 'COLOR', variableCollectionId: 'VC',
          valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: `VariableID:${LIB_KEY}/9:9` } } } },
      } }) } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, variableGraph,
    };
    registerGetVariablesTool(server, deps);
    return (a: any): Promise<any> => call('get_variables', a);
  }

  it('the real env graph builds via ensureReady and resolves the alias on the first tool call', async () => {
    // A FRESH env graph — nothing is built until the tool awaits ensureReady().
    const envGraph = createEnvGraphFromConfig(
      { DS_LIBRARY_TTL_SEC: 86400, DS_TEAM_IDS: '123', FIGMA_TOKEN: 'figd_x' }, logger, () => libraryApi());
    expect(envGraph).toBeDefined();
    // Pre-condition: BEFORE any ensureReady, the graph resolves nothing (proves the tool's await, not
    // an eager build, is what makes the first call succeed).
    expect(envGraph!.resolve(LIB_KEY)).toBeUndefined();

    const run = harness(envGraph);
    const res = await run({ file: 'abc' });
    const body = JSON.parse(res.content[0].text);
    const t = body.tokens.find((x: any) => x.name === 'bg/accent');
    expect(t.resolved_via).toBe('graph');      // ← the lock: RED if the ensureReady await is removed
    expect(t.value).toBe('#0000ff');
    expect(t.source_library).toBe('libfile');
  });
});

// ── Late-path domination: the ensureReady await dominates the mode-context scan ─────────────────
// A cross-library binding reachable ONLY through get_design_context's LATE mode-context scan
// (a node-scalar binding — NOT collected by the up-front collectExternalAliasIds, which sees only
// node-level fills/strokes). If the await were placed inside the first (up-front) block it would
// never run for this fixture (no up-front alias ids) and the graph would be empty when the scan
// reads it → the binding reads as untracked → mode_context suppressed. With the await placed ABOVE
// the first guard it dominates the late read too, so the single-mode library value is tracked and the
// marker is emitted.
describe('get_design_context: ensureReady await dominates the late mode-context scan path', () => {
  const SCALAR_KEY = 'fedcba9876543210fedcba9876543210fedcba98'; // 40 hex, lower-case
  const SCALAR_RAW = {
    meta: {
      variables: {
        'VariableID:20:1': { id: 'VariableID:20:1', key: SCALAR_KEY, name: 'radius/base',
          valuesByMode: { sm1: 8 }, variableCollectionId: 'SC', resolvedType: 'FLOAT' },
      },
      variableCollections: {
        SC: { id: 'SC', name: 'Radii', key: '', defaultModeId: 'sm1', modes: [{ modeId: 'sm1', name: 'Default' }] },
      },
    },
  };

  // Frame with a single child binding topLeftRadius (a NODE-SCALAR — invisible to the up-front
  // collectExternalAliasIds) to the cross-library scalar key. No fills/strokes bindings anywhere → the
  // ONLY variableGraph read is the late mode-context scan (bindingIsUntracked).
  const xId = `VariableID:${SCALAR_KEY}/7:7`;
  const doc = {
    id: 'F', name: 'Header', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
    children: [{ id: 'R', name: 'pill', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      boundVariables: { topLeftRadius: { type: 'VARIABLE_ALIAS', id: xId } } }],
  };
  // Consumer variables: a single unrelated single-mode scalar so the local index loads (idx_ok) but
  // does NOT contain the cross-library key.
  const consumerVars = { meta: {
    variableCollections: { 'VC:R': { id: 'VC:R', name: 'Radius const', defaultModeId: 'r1', modes: [{ modeId: 'r1', name: 'Mode 1' }] } },
    variables: { 'V:rad': { id: 'V:rad', name: 'radius/m', resolvedType: 'FLOAT', variableCollectionId: 'VC:R', valuesByMode: { r1: 8 } } },
  } };

  function handler(variableGraph: ToolDeps['variableGraph']) {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getNodesRaw: async () => ({ nodes: { F: { document: doc } } }),
        getVariablesLocal: async () => consumerVars,
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
        getFileComponentSets: async () => [],
        getDocumentRaw: async () => ({ document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '99:1', type: 'CANVAS', children: [doc] }] } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      libraryFiles: { has: async () => true },   // registered library file → the marker can be library_default_modes
      variableGraph,
    };
    registerGetDesignContextTool(server, deps);
    return (a: any): Promise<any> => call('get_design_context', a);
  }

  it('a real env graph, built by the await before the scan, tracks the late node-scalar binding', async () => {
    const envGraph = createEnvGraphFromConfig(
      { DS_LIBRARY_TTL_SEC: 86400, DS_TEAM_IDS: '123', FIGMA_TOKEN: 'figd_x' }, logger, () => libraryApi(SCALAR_RAW));
    // Fresh: nothing built until the tool's ensureReady await runs above the mode-context scan.
    expect(envGraph!.resolve(SCALAR_KEY)).toBeUndefined();

    const res = await handler(envGraph)({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    // Tracked via the graph (single-mode) → the positive-evidence marker is emitted. RED if the await
    // did NOT dominate the late scan (empty graph → untracked → marker suppressed).
    expect(body.mode_context).toBe('library_default_modes');
  });

  it('control: WITHOUT an env graph the same late binding is untracked → marker suppressed', async () => {
    const res = await handler(undefined)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });
});
