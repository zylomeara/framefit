import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerGetDesignContextTool, discoverAncestorModes, discoverAncestorModesBatch } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { createLogger, type Logger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { buildGraph, resolveKeyInMode } from '../../src/domain/variable-graph.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';
import { tagBytes } from '../../src/infrastructure/response-size.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.useRealTimers());

// Tool-level ancestor-mode integration, with every API boundary replaced by an in-memory fake.
// Tree: DOC → PAGE → ANC(explicitVariableModes {C:m2}) → ROOT(request root) → LEAF(stroke→V:1).
// The ancestor mode sits above the request root, so subtree evidence alone cannot select it. The
// targeted projection must prove the complete documentary chain and resolve LEAF under m2.

const collectionC = { 'C': { id: 'C', name: 'Theme', defaultModeId: 'm1',
  modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dusk' }] } };
const variableV1 = { 'V:1': { id: 'V:1', name: 'text color/accent', resolvedType: 'COLOR', variableCollectionId: 'C',
  valuesByMode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } } } };

// What getNodesRaw returns for the REQUEST ROOT — note ROOT carries NO explicitVariableModes;
// the mode only exists on the ancestor ANC (fetched separately).
const rootSubtree = {
  id: 'ROOT', name: 'Header', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  children: [{ id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR',
    strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
    boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:1' }] } }],
};

// Documentary tree returned by the targeted projection. It carries the unique path and ancestor pin.
const fullDoc = {
  id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [
    { id: 'PAGE', name: 'Page 1', type: 'CANVAS', children: [
      { id: 'ANC', name: 'Themed', type: 'FRAME', explicitVariableModes: { C: 'm2' }, children: [
        { id: 'ROOT', name: 'Header', type: 'FRAME', children: [
          { id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR' },
        ] },
      ] },
    ] },
  ],
};

type Harness = { handler: (a: any) => Promise<any>; depthsSeen: number[]; stacksSeen: Map<string, string>[] };

function harness(opts: {
  leafBoundId?: string;                                  // override the stroke binding id (cross-lib)
  variables?: unknown;                                   // override getVariablesLocal payload
  variableGraph?: ToolDeps['variableGraph'];
  projection?: unknown;
} = {}): Harness {
  const { server, call } = makeFakeMcpServer();
  const depthsSeen: number[] = [];
  const stacksSeen: Map<string, string>[] = [];

  const rootDoc = opts.leafBoundId
    ? { ...rootSubtree, children: [{ ...rootSubtree.children[0],
        boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: opts.leafBoundId }] } }] }
    : rootSubtree;

  const deps: ToolDeps = {
    buildApi: () => ({
      getNodesRaw: async (_file: string, ids: string[], depth?: number) => {
        depthsSeen.push(depth ?? -1);
        if ((depth ?? 0) < 1) throw new Error('Figma 400: depth must be a positive integer');
        const nodes: Record<string, { document: unknown }> = {};
        for (const nid of ids) if (nid === 'ROOT') nodes[nid] = { document: rootDoc };
        return { version: 'v1', nodes };
      },
      getDocumentByIdsRaw: async (_file: string, _ids: string[], depth: number, version?: string) => {
        depthsSeen.push(depth);
        return { name: 'Synthetic', lastModified: '', version: version ?? 'v1', document: opts.projection ?? prune(fullDoc, depth) } as any;
      },
      getDocumentRaw: async () => { throw new Error('whole-file fetch must not be used'); },
      getVariablesLocal: async () => opts.variables ?? { meta: { variableCollections: collectionC, variables: variableV1 } },
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars: 40000,
    ...(opts.variableGraph ? { variableGraph: opts.variableGraph } : {}),
  };
  // Wrap resolveInMode to capture the stacks it receives, if a graph is provided.
  if (deps.variableGraph?.resolveInMode) {
    const inner = deps.variableGraph.resolveInMode.bind(deps.variableGraph);
    deps.variableGraph = { ...deps.variableGraph, resolveInMode: (key, stack, cc, evidence) => { stacksSeen.push(new Map(stack)); return inner(key, stack, cc, evidence); } };
  }
  registerGetDesignContextTool(server, deps);
  return { handler: (a: any): Promise<any> => call('get_design_context', a), depthsSeen, stacksSeen };
}

describe('get_design_context ancestor-mode glue (FR-2 / FR-3a)', () => {
  it('resolves a LEAF stroke with the above-root ancestor provenance', async () => {
    const h = harness();
    const res = await h.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef]).toMatchObject({
      token: 'text color/accent', default_value: '#a73afd', effective_rendered_value: '#8b6afb', value: '#8b6afb',
      mode_dependent: true, effective_mode_source: 'ancestor_chain',
      effective_modes: { Theme: { mode: 'Dusk', source: 'ancestor_chain', node_id: 'ANC' } },
    });
    expect(h.depthsSeen).toContain(4);
    expect(h.depthsSeen).not.toContain(0);
  });

  it('preserves the specific targeted ancestor failure in degraded stage detail', async () => {
    const h = harness({ projection: { id: 'BROKEN', name: 'Broken', type: 'FRAME', children: [] } });
    const body = JSON.parse((await h.handler({
      file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false,
    })).content[0].text);

    expect(body.degraded_stages).toContainEqual({
      stage: 'ancestor_discovery', reason: 'error', detail: 'invalid_projection',
    });
  });

  it('rejects a foreign compound core root before variables or ancestor discovery', async () => {
    const requested = 'I12:34;56:78';
    const returned = 'I90:12;56:78';
    const foreignRoot = { ...rootSubtree, id: returned };
    const getVariablesLocal = vi.fn(async () => ({ meta: { variableCollections: collectionC, variables: variableV1 } }));
    const getDocumentByIdsRaw = vi.fn(async () => ({ name: 'Synthetic', lastModified: '', version: 'v1', document: fullDoc }));
    const { server, call } = makeFakeMcpServer();
    registerGetDesignContextTool(server, {
      buildApi: () => ({
        getNodesRaw: async () => ({ version: 'v1', nodes: { [requested]: { document: foreignRoot } } }),
        getDocumentByIdsRaw, getVariablesLocal,
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
    });

    const result = await call('get_design_context', {
      file: 'abc', node_id: requested, depth: 2, include_component_docs: false,
    });
    const text = textOf(result.content?.[0]);

    expect(result.isError).toBe(true);
    expect(text).toContain(requested);
    expect(text).not.toContain(returned);
    expect(getVariablesLocal).not.toHaveBeenCalled();
    expect(getDocumentByIdsRaw).not.toHaveBeenCalled();
  });

  it('prunes a full-id root to the requested depth without mutating the cached response', async () => {
    const cachedRoot = {
      id: '12:34', name: 'Scoped target', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      children: [{ id: '2:1', name: 'child', type: 'FRAME', children: [
        { id: '2:2', name: 'grandchild', type: 'RECTANGLE' },
      ] }],
    };
    const before = structuredClone(cachedRoot);
    const { server, call } = makeFakeMcpServer();
    registerGetDesignContextTool(server, {
      buildApi: () => ({
        getNodesRaw: async () => ({ version: 'v1', nodes: { '12:34': { document: cachedRoot } } }),
        getVariablesLocal: async () => ({ meta: { variableCollections: {}, variables: {} } }),
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
        getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
    });

    const result = await call('get_design_context', {
      file: 'abc', node_id: '12:34', depth: 1, include_component_docs: false,
    });
    const body = JSON.parse(textOf(result.content?.[0]));

    expect(result.isError).toBeFalsy();
    expect(body.node.children[0].truncated).toBe(true);
    expect(body.node.children[0].childCount).toBe(1);
    expect(cachedRoot).toEqual(before);
  });

  it('accepts an exact terminal scoped root and normalizes only the root id without mutating the cached response', async () => {
    const requested = 'I12:34;56:78';
    const cachedRoot = {
      id: '56:78', name: 'Scoped target', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      children: [{ id: '2:1', name: 'child', type: 'FRAME', children: [
        { id: '2:2', name: 'grandchild', type: 'RECTANGLE' },
      ] }],
    };
    const before = structuredClone(cachedRoot);
    const { server, call } = makeFakeMcpServer();
    registerGetDesignContextTool(server, {
      buildApi: () => ({
        getNodesRaw: async () => ({ version: 'v1', nodes: { [requested]: { document: cachedRoot } } }),
        getVariablesLocal: async () => ({ meta: { variableCollections: {}, variables: {} } }),
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
        getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
    });

    const result = await call('get_design_context', {
      file: 'abc', node_id: requested, depth: 1, include_component_docs: false,
    });
    const body = JSON.parse(textOf(result.content?.[0]));

    expect(result.isError).toBeFalsy();
    expect(body.node.id).toBe(requested);
    expect(body.node.children[0].id).toBe('2:1');
    expect(cachedRoot).toEqual(before);
  });

  it('passes the ancestor-merged stack to a cross-library variableGraph.resolveInMode', async () => {
    const EXT = 'VariableID:' + 'a'.repeat(40) + '/9:9';
    const graph: ToolDeps['variableGraph'] = {
      // modesByName present → the cross-lib top collection is MULTI-mode, so needsAncestors()
      // triggers targeted discovery (a single-mode top would render inline and skip it).
      resolve: () => ({ value: '#8b6afb', name: 'lib/accent', modesByName: { Default: '#a73afd', Dusk: '#8b6afb' } }),
      resolveInMode: () => ({
        token: 'lib/accent', default_value: '#a73afd', effective_rendered_value: '#8b6afb', value: '#8b6afb',
        mode_dependent: true, effective_mode_source: 'ancestor_chain',
        effective_modes: { Theme: { mode: 'Dusk', source: 'ancestor_chain', node_id: 'PAGE' } },
        pinned_axis_used: false, unconfirmed_default_used: false,
      }),
    };
    // Local index does NOT know the external id → the cross-library path is taken.
    const h = harness({ leafBoundId: EXT,
      variables: { meta: { variableCollections: collectionC, variables: {} } }, variableGraph: graph });
    const res = await h.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef]).toMatchObject({ token: 'lib/accent', value: '#8b6afb', effective_mode_source: 'ancestor_chain' });
    // Prove the ancestor mode reached the graph resolver: some captured stack had C→m2.
    expect(h.stacksSeen.some((s) => s.get('C') === 'm2')).toBe(true);
  });
});

// --- Minor (perf): needsAncestors gates cross-lib discovery on a MULTI-mode top collection ---
// A single-mode cross-library binding renders inline (mode_dependent stays false) no matter what
// mode any ancestor sets, so targeted ancestor discovery for it is pure waste. needsAncestors()
// must SKIP discovery when the only cross-lib binding's top collection is single-mode (resolve()
// returns no modesByName), and RUN it when the top collection is multi-mode.
describe('get_design_context: cross-lib discovery gated on multi-mode top (perf)', () => {
  const EXT = 'VariableID:' + 'b'.repeat(40) + '/9:9';
  const rootWithExt = {
    id: 'ROOT', name: 'Header', type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
    children: [{ id: 'LEAF', name: 'menu', type: 'VECTOR',
      strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1,
      boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: EXT }] } }],
  };
  function build(resolveResult: { value: string; name?: string; modesByName?: Record<string, string> } | undefined, isMultiMode?: boolean) {
    const { server, call } = makeFakeMcpServer();
    let docFetches = 0;
    const deps: ToolDeps = {
      buildApi: () => ({
        getNodesRaw: async (_f: string, ids: string[], depth?: number) => {
          if ((depth ?? 0) < 1 && !ids.includes('ROOT')) throw new Error('Figma 400: depth must be positive');
          const nodes: Record<string, { document: unknown }> = {};
          for (const id of ids) if (id === 'ROOT') nodes[id] = { document: rootWithExt };
          return { version: 'v1', nodes };
        },
        getDocumentByIdsRaw: async (_file: string, _ids: string[], depth: number, version?: string) => {
          docFetches++;
          return { name: 'Synthetic', lastModified: '', version: version ?? 'v1', document: prune(fullDoc, depth) } as any;
        },
        getDocumentRaw: async () => { throw new Error('whole-file fetch must not be used'); },
        getVariablesLocal: async () => ({ meta: { variableCollections: collectionC, variables: {} } }),  // EXT not local → cross-lib path
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); }, getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      variableGraph: {
        resolve: () => resolveResult,
        resolveInMode: () => (resolveResult?.modesByName
          ? { token: resolveResult.name, default_value: resolveResult.value, effective_rendered_value: resolveResult.value, value: resolveResult.value, mode_dependent: true as const, effective_mode_source: 'confirmed_default' as const, effective_modes: { Theme: { mode: 'Dusk', source: 'confirmed_default' as const } }, pinned_axis_used: false, unconfirmed_default_used: false }
          : undefined),
        ...(isMultiMode !== undefined ? { isMultiMode: () => isMultiMode } : {}),
      },
    };
    registerGetDesignContextTool(server, deps);
    return { handler: (a: any): Promise<any> => call('get_design_context', a), docFetches: () => docFetches };
  }

  it('single-mode cross-lib binding skips targeted ancestor discovery', async () => {
    const b = build({ value: '#123456', name: 'lib/token' });   // no modesByName ⇒ single-mode top
    await b.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    expect(b.docFetches()).toBe(0);
  });

  it('multi-mode cross-lib binding runs targeted ancestor discovery', async () => {
    const b = build({ value: '#123456', name: 'lib/token', modesByName: { Default: '#123456', Dusk: '#000000' } });
    await b.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    expect(b.docFetches()).toBeGreaterThan(0);
  });

  // Hardening: a multi-mode top whose DEFAULT mode is unresolvable (partial sync) makes resolve()
  // return undefined, so the resolve().modesByName fallback would MISS it. isMultiMode counts modes
  // by existence → still triggers discovery, preserving the mode annotation. No output regression.
  it('multi-mode top with unresolvable default (resolve→undefined) but isMultiMode→true → discovery RUNS', async () => {
    const b = build(undefined, true);
    await b.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    expect(b.docFetches()).toBeGreaterThan(0);
  });
});

// --- Deep-node ancestor reach + coverageComplete (unit-level, no tool) ---
//
// A request root deeper than the initial fetch depth must still discover an ancestor mode set
// on a top-level page, via a BOUNDED, size-guarded deepening fetch. Discovery reports
// coverageComplete = true only when the node was located AND its chain reaches a top-level CANVAS.
// On oversize (would blow the byte budget) discovery STOPS, reports coverageComplete = false,
// and logs the drop — never pulling the whole file.

type FakeNode = { id: string; name: string; type: string; explicitVariableModes?: Record<string, string>; children?: FakeNode[] };

// Prune a tree to `depth` levels below the root (root = level 0) — mimics Figma's ?depth=N.
function prune(node: FakeNode, depth: number): FakeNode {
  const { children, ...rest } = node;
  if (depth <= 0 || !children) return { ...rest };
  return { ...rest, children: children.map((c) => prune(c, depth - 1)) };
}

const TARGET_COLLECTION = 'VariableCollectionId:synthetic/1:1';

function targetAtDepth(targetId: string, level: number): FakeNode {
  let branch: FakeNode = { id: targetId, name: targetId, type: 'FRAME' };
  for (let current = level - 1; current >= 2; current--) {
    branch = {
      id: `${targetId}-w${current}`, name: `wrapper ${current}`, type: 'FRAME',
      ...(current === level - 1 ? { explicitVariableModes: { [TARGET_COLLECTION]: 'near' } } : {}),
      children: [branch],
    };
  }
  return {
    id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [{
      id: 'PAGE', name: 'Page', type: 'CANVAS', explicitVariableModes: { [TARGET_COLLECTION]: 'far' }, children: [branch],
    }],
  };
}

function projectionApi(tree: FakeNode, calls: Array<{ ids: string[]; depth: number; version?: string }>, responseVersion = 'v-proof') {
  return {
    getDocumentByIdsRaw: async (_file: string, ids: string[], depth: number, version?: string) => {
      calls.push({ ids: [...ids], depth, version });
      return { name: 'Proof', lastModified: '', version: responseVersion, document: prune(tree, depth) } as any;
    },
  };
}

describe('discoverAncestorModes targeted batch ladder', () => {
  it('resolves shallow ids once, removes them, and recovers a depth-16 target with nearest-wins', async () => {
    const shallow: FakeNode = { id: 'SHALLOW', name: 'shallow', type: 'FRAME' };
    const deep = targetAtDepth('DEEP', 16);
    deep.children![0].children!.push(shallow);
    const calls: Array<{ ids: string[]; depth: number; version?: string }> = [];

    const found = await discoverAncestorModesBatch(projectionApi(deep, calls), 'file',
      ['DEEP', 'SHALLOW', 'DEEP'], 'v-proof', logger);

    expect(found.get('SHALLOW')).toMatchObject({ coverageComplete: true });
    expect(found.get('DEEP')).toMatchObject({ coverageComplete: true });
    expect(found.get('DEEP')!.stack.get(TARGET_COLLECTION)).toBe('near');
    expect(calls).toEqual([
      { ids: ['DEEP', 'SHALLOW'], depth: 4, version: 'v-proof' },
      { ids: ['DEEP'], depth: 8, version: 'v-proof' },
      { ids: ['DEEP'], depth: 16, version: 'v-proof' },
    ]);
  });

  it('keeps a depth-17 target unknown after exactly the 4 -> 8 -> 16 schedule', async () => {
    const calls: Array<{ ids: string[]; depth: number; version?: string }> = [];
    const result = await discoverAncestorModes(projectionApi(targetAtDepth('DEEPER', 17), calls),
      'file', 'DEEPER', 'v-proof', logger);

    expect(result).toMatchObject({ coverageComplete: false, reason: 'depth_cap' });
    expect(result.nodesRootToParent).toEqual([]);
    expect(result.stack.size).toBe(0);
    expect(calls.map((call) => call.depth)).toEqual([4, 8, 16]);
  });

  it('returns missing_version without issuing a projection', async () => {
    const getDocumentByIdsRaw = vi.fn();
    const result = await discoverAncestorModes({ getDocumentByIdsRaw } as never,
      'file', 'TARGET', undefined, logger);
    expect(result).toMatchObject({ coverageComplete: false, reason: 'missing_version' });
    expect(getDocumentByIdsRaw).not.toHaveBeenCalled();
  });

  it('rejects a projection response without a version with no ancestor evidence', async () => {
    const getDocumentByIdsRaw = vi.fn(async () => {
      const { version: _version, ...raw } = {
        name: 'Proof', lastModified: '', version: 'discarded', document: targetAtDepth('TARGET', 3),
      };
      return raw as any;
    });
    const result = await discoverAncestorModes({ getDocumentByIdsRaw },
      'file', 'TARGET', 'v-proof', logger);
    expect(result).toMatchObject({ coverageComplete: false, reason: 'missing_version' });
    expect(result.nodesRootToParent).toEqual([]);
    expect(result.stack.size).toBe(0);
    expect(getDocumentByIdsRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched response version with no ancestor evidence', async () => {
    const calls: Array<{ ids: string[]; depth: number; version?: string }> = [];
    const result = await discoverAncestorModes(projectionApi(targetAtDepth('TARGET', 3), calls, 'other'),
      'file', 'TARGET', 'v-proof', logger);
    expect(result).toMatchObject({ coverageComplete: false, reason: 'version_mismatch' });
    expect(result.nodesRootToParent).toEqual([]);
    expect(result.stack.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('applies the 24MiB-style budget after the response and accepts no evidence from an oversized payload', async () => {
    const calls: Array<{ ids: string[]; depth: number; version?: string }> = [];
    const result = await discoverAncestorModes(projectionApi(targetAtDepth('TARGET', 3), calls),
      'file', 'TARGET', 'v-proof', logger, { byteBudget: 10 });
    expect(result).toMatchObject({ coverageComplete: false, reason: 'byte_budget' });
    expect(result.nodesRootToParent).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('prefers the tagged wire size when enforcing the post-response byte budget', async () => {
    const raw = {
      name: 'Proof', lastModified: '', version: 'v-proof', document: targetAtDepth('TARGET', 3),
    } as any;
    tagBytes(raw, 10_000);
    const result = await discoverAncestorModes({ getDocumentByIdsRaw: async () => raw },
      'file', 'TARGET', 'v-proof', logger, { byteBudget: 5_000 });
    expect(result).toMatchObject({ coverageComplete: false, reason: 'byte_budget' });
    expect(result.nodesRootToParent).toEqual([]);
  });

  it('classifies transport too_large as byte_budget and propagates rate limits', async () => {
    const tooLarge = { getDocumentByIdsRaw: async () => {
      throw new FigmaApiError('too_large', 400, 'too large');
    } };
    const result = await discoverAncestorModes(tooLarge, 'file', 'TARGET', 'v-proof', logger);
    expect(result).toMatchObject({ coverageComplete: false, reason: 'byte_budget' });
    expect(result.nodesRootToParent).toEqual([]);

    const limited = { getDocumentByIdsRaw: async () => {
      throw new FigmaApiError('rate_limited', 429, 'slow down', 3);
    } };
    await expect(discoverAncestorModes(limited, 'file', 'TARGET', 'v-proof', logger))
      .rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
  });

  it('does not start a projection after the absolute deadline has passed', async () => {
    const getDocumentByIdsRaw = vi.fn();
    const result = await discoverAncestorModes({ getDocumentByIdsRaw } as never,
      'file', 'TARGET', 'v-proof', logger, { deadlineAt: Date.now() - 1 });
    expect(result).toMatchObject({ coverageComplete: false, reason: 'time_budget' });
    expect(result.nodesRootToParent).toEqual([]);
    expect(getDocumentByIdsRaw).not.toHaveBeenCalled();
  });

  it('clamps an oversized remaining deadline to the existing 90s request cap', async () => {
    const calls: Array<{ ids: string[]; depth: number; version?: string }> = [];
    const api = projectionApi(targetAtDepth('TARGET', 3), calls);
    const caps: number[] = [];
    const result = await discoverAncestorModes(api, 'file', 'TARGET', 'v-proof', logger, {
      deadlineAt: Date.now() + 10_000_000_000,
      makeCappedApi: (capMs) => { caps.push(capMs); return api; },
    });
    expect(result.coverageComplete).toBe(true);
    expect(caps).toEqual([90_000]);
  });

  it('uses the capped api under an absolute deadline and returns empty time_budget evidence on timeout', async () => {
    const base = { getDocumentByIdsRaw: vi.fn() };
    const capped = { getDocumentByIdsRaw: vi.fn(async () => {
      throw new FigmaApiError('network', 0, 'Figma request timed out after 1000ms');
    }) };
    const caps: number[] = [];
    const result = await discoverAncestorModes(base as never, 'file', 'TARGET', 'v-proof', logger, {
      deadlineAt: Date.now() + 20_000,
      makeCappedApi: (capMs) => { caps.push(capMs); return capped; },
    });
    expect(result).toMatchObject({ coverageComplete: false, reason: 'time_budget' });
    expect(result.nodesRootToParent).toEqual([]);
    expect(base.getDocumentByIdsRaw).not.toHaveBeenCalled();
    expect(capped.getDocumentByIdsRaw).toHaveBeenCalledTimes(1);
    expect(caps[0]).toBeGreaterThan(0);
    expect(caps[0]).toBeLessThanOrEqual(20_000);
  });
});

// --- Deep root BEYOND the ancestor-fetch depth cap -> honest 'default' -----------------------
//
// discoverAncestorModes tries the bounded 4 -> 8 -> 16 projection ladder, then stops. A request
// root ONE level past that cap is never located by any bounded projection the tool performs;
// this exercises the tool's real hard-coded bound, so coverageComplete=false and the
// ancestor stack stays empty. The LEAF's stroke is bound to V:1 in the 2-mode collection C (same
// fixture as the shallow-root glue test above) with NO explicit mode anywhere in the (unreachable)
// chain: it must resolve to collection C's DEFAULT mode (m1, #a73afd) and be labeled
// mode_source:'default' — never silently promoted to 'node' just because a default was used.
describe('get_design_context: deep root beyond the ancestor-fetch cap -> honest default', () => {
  it('coverageComplete=false: multi-mode token defaults to the collection default, mode_source stays "default"', async () => {
    // DOC(0) -> PAGE(1) -> W2..W16(2..16) -> ROOT(17) -> LEAF. ROOT sits one
    // level beyond the targeted projection ceiling, so no accepted chain can contain it.
    let deepNode: FakeNode = {
      id: 'ROOT', name: 'Header', type: 'FRAME',
      children: [{ id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR' }],
    };
    for (let i = 16; i >= 2; i--) {
      deepNode = { id: `W${i}`, name: `wrapper ${i}`, type: 'FRAME', children: [deepNode] };
    }
    const beyondCapTree: FakeNode = {
      id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [
        { id: 'PAGE', name: 'Page 1', type: 'CANVAS', children: [deepNode] },
      ],
    };
    const depthsSeen: number[] = [];
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getDocumentByIdsRaw: async (_file: string, _ids: string[], depth: number, version?: string) => {
          depthsSeen.push(depth);
          return { name: 'Synthetic', lastModified: '', version: version ?? 'v1', document: prune(beyondCapTree, depth) } as any;
        },
        getDocumentRaw: async () => { throw new Error('whole-file fetch must not be used'); },
        getNodesRaw: async (_file: string, ids: string[]) => {
          const nodes: Record<string, { document: unknown }> = {};
          for (const id of ids) if (id === 'ROOT') nodes[id] = { document: rootSubtree };
          return { version: 'v1', nodes };
        },
        getVariablesLocal: async () => ({ meta: { variableCollections: collectionC, variables: variableV1 } }),
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
        getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
    };
    registerGetDesignContextTool(server, deps);

    const res = await call('get_design_context', { file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    const body = JSON.parse(textOf(res.content[0]));
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef]).toMatchObject({
      token: 'text color/accent', default_value: '#a73afd', effective_rendered_value: null, value: null,
      mode_dependent: true, effective_mode_source: 'unverifiable',
    });
    // Discovery genuinely deepened to the cap (4 -> 8) and then stopped — it never located ROOT.
    expect(depthsSeen).toEqual([4, 8, 16]);
  });
});

// --- Cross-merge nearest-wins BY LIBRARY KEY (critical fix) -------------------------------
//
// The stack the GRAPH resolver sees must enforce NEAREST-wins BY LIBRARY KEY across the FULL
// chain (self/subtree-nearest → … → request root → ancestors-nearest → … → farthest): at most
// one entry per library key — the NEAREST node's — placed first in map order so the resolver's
// lib-key first-match picks it. Two failure surfaces both regress a real on-screen hex:
//   (1) the ancestor↔subtree MERGE (ancestorStack spread before the subtree stack), and
//   (2) WITHIN a subtree (collectSubtreeModes folds by EXACT id, so two suffixes of one lib key
//       both survive).
// Ground-truth cross-library chain: text color/accent (Theme, multi-mode) --alias--> brand/600 (sub-brand
// collection a1a1a1…, modes Lunar 12:0 → #a73afd (default) / Solar 34:0 → #8b6afb)
// --alias--> purple/600. A NEARER node saying Solar must beat a FARTHER node saying Lunar.

const K40 = (h: string) => h.padEnd(40, '0');
const ACCENT_KEY = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
const BRAND_KEY = K40('b6006000');
const PURPLE_MARKET_KEY = K40('9600aa00');
const PURPLE_ALT_KEY = K40('9600bb00');
const THEME_COLL = 'VariableCollectionId:c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3/78:90';
const SUBBRAND_COLL = 'VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/34:57';
const SUBBRAND_KEY = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
// Two DIFFERENT subscribed-instance suffixes of the SAME sub-brand library collection.
const SUBBRAND_FAR = `VariableCollectionId:${SUBBRAND_KEY}/34:56`;   // set on the FARTHER node → Lunar
const SUBBRAND_NEAR = `VariableCollectionId:${SUBBRAND_KEY}/8888:2`;    // set on the NEARER node → Solar
const ACCENT_BINDING = 'VariableID:' + ACCENT_KEY + '/1:1';            // LEAF's cross-lib stroke binding

function crossLibGraph() {
  return buildGraph([
    { fileKey: 'FTheme',
      colls: [{ collection_id: THEME_COLL, default_mode: 'ThemeLight',
        modes: [{ modeId: 'ThemeLight', name: 'Light' }, { modeId: 'ThemeDark', name: 'Dark' }] }],
      vars: [{ library_key: ACCENT_KEY, local_id: 'VariableID:1:1', collection_id: THEME_COLL,
        values_by_mode: {
          ThemeLight: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + BRAND_KEY + '/9:9' },
          ThemeDark: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + BRAND_KEY + '/9:9' },
        }, name: 'text color/accent', resolved_type: 'COLOR', code_syntax_web: '' }] },
    { fileKey: 'FSubBrand',
      colls: [{ collection_id: SUBBRAND_COLL, default_mode: '12:0',
        modes: [{ modeId: '12:0', name: 'Lunar' }, { modeId: '34:0', name: 'Solar' }] }],
      vars: [{ library_key: BRAND_KEY, local_id: 'VariableID:9:9', collection_id: SUBBRAND_COLL,
        values_by_mode: {
          '12:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:' + PURPLE_MARKET_KEY + '/1:1' },
          '34:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:' + PURPLE_ALT_KEY + '/1:1' },
        }, name: 'brand/600', resolved_type: 'COLOR', code_syntax_web: '' }] },
    { fileKey: 'FPurpleMarket',
      colls: [{ collection_id: 'C', default_mode: 'p', modes: [{ modeId: 'p', name: 'Default' }] }],
      vars: [{ library_key: PURPLE_MARKET_KEY, local_id: 'VariableID:1:1', collection_id: 'C',
        values_by_mode: { p: { r: 0.655, g: 0.227, b: 0.992, a: 1 } }, name: 'purple/600', resolved_type: 'COLOR', code_syntax_web: '' }] },
    { fileKey: 'FPurpleSolar',
      colls: [{ collection_id: 'C', default_mode: 'p', modes: [{ modeId: 'p', name: 'Default' }] }],
      vars: [{ library_key: PURPLE_ALT_KEY, local_id: 'VariableID:1:1', collection_id: 'C',
        values_by_mode: { p: { r: 0.545, g: 0.416, b: 0.984, a: 1 } }, name: 'purple/600', resolved_type: 'COLOR', code_syntax_web: '' }] },
  ]);
}

// A real graph resolver so the emitted hex is genuinely a function of the stack it is handed.
function collisionGraph(): { graph: ToolDeps['variableGraph']; stacksSeen: Map<string, string>[] } {
  const g = crossLibGraph();
  const stacksSeen: Map<string, string>[] = [];
  const graph: ToolDeps['variableGraph'] = {
    resolve: () => undefined,   // force the mode-dependent resolveInMode path (never the legacy snapshot form)
    isMultiMode: () => true,
    resolveInMode: (key, stack, cc, evidence) => { stacksSeen.push(new Map(stack)); return resolveKeyInMode(g, key, stack, cc, evidence); },
  };
  return { graph, stacksSeen };
}

type CNode = { id: string; name: string; type: string; explicitVariableModes?: Record<string, string>; children?: CNode[]; [k: string]: unknown };

const leafNode = (): CNode => ({ id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR',
  strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
  boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: ACCENT_BINDING }] } });

function collisionHarness(fullDoc: CNode, rootSubtree: CNode, rootId: string):
  { handler: (a: any) => Promise<any>; stacksSeen: Map<string, string>[] } {
  const { graph, stacksSeen } = collisionGraph();
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getNodesRaw: async (_f: string, ids: string[], depth?: number) => {
        if ((depth ?? 0) < 1) throw new Error('Figma 400: depth must be a positive integer');
        const nodes: Record<string, { document: unknown }> = {};
        for (const id of ids) if (id === rootId) nodes[id] = { document: rootSubtree };
        return { version: 'v1', nodes };
      },
      getDocumentByIdsRaw: async (_f: string, _ids: string[], depth: number, version?: string) => ({
        name: 'Synthetic', lastModified: '', version: version ?? 'v1', document: prune(fullDoc, depth),
      } as any),
      getDocumentRaw: async () => { throw new Error('whole-file fetch must not be used'); },
      getVariablesLocal: async () => ({ meta: { variableCollections: {}, variables: {} } }),
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars: 40000, variableGraph: graph,
  };
  registerGetDesignContextTool(server, deps);
  return { handler: (a: any): Promise<any> => call('get_design_context', a), stacksSeen };
}

// The single mode-dependent cross-lib token in globalVars (dedup-flat across the whole tree).
function resolvedAccent(body: any): { value: string | null; effective_rendered_value: string | null } {
  const hit = Object.values(body.globalVars).find(
    (v: any) => v && typeof v === 'object' && v.token === 'text color/accent');
  return hit as { value: string | null; effective_rendered_value: string | null };
}
function subBrandModes(stack: Map<string, string>): string[] {
  return [...stack].filter(([k]) => k.includes(SUBBRAND_KEY)).map(([, v]) => v);
}

describe('get_design_context nearest-wins BY LIBRARY KEY across the full chain', () => {
  it('ancestor↔subtree collision: request-root (nearer) Solar #8b6afb beats page (farther) Lunar #a73afd', async () => {
    // PAGE (ancestor, FARTHER) pins the sub-brand collection to Lunar under suffix /34:56;
    // ROOT (request root, NEARER) pins the SAME library collection to Solar under suffix /8888:2.
    const rootSubtree: CNode = {
      id: 'ROOT', name: 'Header', type: 'FRAME', explicitVariableModes: { [SUBBRAND_NEAR]: '34:0' },
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } as unknown as CNode['children'],
      children: [leafNode()],
    };
    const fullDoc: CNode = {
      id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [
        { id: 'PAGE', name: 'Page 1', type: 'CANVAS', explicitVariableModes: { [SUBBRAND_FAR]: '12:0' }, children: [
          { id: 'ROOT', name: 'Header', type: 'FRAME', children: [
            { id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR' },
          ] },
        ] },
      ],
    };
    const h = collisionHarness(fullDoc, rootSubtree, 'ROOT');
    const res = await h.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(resolvedAccent(body).effective_rendered_value).toBe('#8b6afb');   // NEAREST (ROOT/Solar), NOT ancestor Lunar #a73afd
    // The graph saw exactly ONE sub-brand entry — the nearest node's — no farther collision survived.
    const merged = h.stacksSeen.find((s) => subBrandModes(s).length > 0)!;
    expect(subBrandModes(merged)).toEqual(['34:0']);
  });

  it('within-subtree collision: deeper inner frame Solar #8b6afb beats shallower request-root Lunar #a73afd', async () => {
    // ROOT (request root) pins Lunar; a DEEPER inner FRAME (nearer to LEAF) pins Solar —
    // same library collection, different subscribed-instance suffixes. The DEEPER node must win.
    const rootSubtree: CNode = {
      id: 'ROOT', name: 'Header', type: 'FRAME', explicitVariableModes: { [SUBBRAND_FAR]: '12:0' },
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } as unknown as CNode['children'],
      children: [
        { id: 'INNER', name: 'Sub', type: 'FRAME', explicitVariableModes: { [SUBBRAND_NEAR]: '34:0' },
          children: [leafNode()] },
      ],
    };
    const fullDoc: CNode = {
      id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [
        { id: 'PAGE', name: 'Page 1', type: 'CANVAS', children: [
          { id: 'ROOT', name: 'Header', type: 'FRAME', children: [
            { id: 'INNER', name: 'Sub', type: 'FRAME', children: [
              { id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR' },
            ] },
          ] },
        ] },
      ],
    };
    const h = collisionHarness(fullDoc, rootSubtree, 'ROOT');
    const res = await h.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(resolvedAccent(body).effective_rendered_value).toBe('#8b6afb');   // DEEPER (INNER/Solar), NOT shallower Lunar #a73afd
    const merged = h.stacksSeen.find((s) => subBrandModes(s).length > 0)!;
    expect(subBrandModes(merged)).toEqual(['34:0']);
  });
});

// --- Critical honesty guard: a SKIPPED discovery must not rescue a downstream-alias fallback ----
//
// needsAncestors() only inspects each fill/stroke's DIRECTLY-bound variable's OWN collection; it
// never follows the variable's alias chain. So a binding whose direct collection is multi-mode AND
// already pinned by the subtree (needsAncestors sees it pinned → returns false → discovery is
// SKIPPED) can still alias DOWNSTREAM into a DIFFERENT multi-mode collection that NOTHING in the
// fetched subtree pins. That downstream collection falls back to its DEFAULT mode (track.fellBack).
// coverageComplete must be true ONLY when discovery actually ran and confirmed the chain: a SKIPPED
// discovery cannot claim complete coverage. If a skipped discovery left coverageComplete=true, the
// mode_source formula (!invalidExplicit && (!usedMultiModeDefault || coverageComplete)) would rescue
// that fallback to 'node' — a FALSE 'node' on a default-mode value that differs from on-screen (an
// ancestor above the request root could pin the downstream collection to its non-default mode).
//
// CT (multi-mode, PINNED on ROOT via explicitVariableModes) — accent aliases into
// CD (multi-mode, pinned NOWHERE in the subtree) — brand → resolves to CD's DEFAULT (#a73afd).
// Expect mode_source:'default'. Pre-fix (coverageComplete defaulted true) this asserted 'node'.
describe('get_design_context targeted ancestor projection', () => {
  it('recovers a depth-12 ancestor mode at projection depth 16 without a whole-file fetch', async () => {
    const rawColor = { r: 0.067, g: 0.133, b: 0.2, a: 1 };       // #112233
    const defaultColor = { r: 0.267, g: 0.333, b: 0.4, a: 1 };   // #445566
    const selectedColor = { r: 0.467, g: 0.533, b: 0.6, a: 1 };  // #778899
    const requestRoot = {
      id: '7:70', name: 'target', type: 'FRAME',
      fills: [{ type: 'SOLID', color: rawColor, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:proof' } } }],
      absoluteBoundingBox: { x: 0, y: 0, width: 80, height: 32 },
    };
    let branch: FakeNode = { id: '7:70', name: 'target', type: 'FRAME' };
    for (let level = 11; level >= 2; level--) {
      branch = { id: `7:${level}`, name: `level ${level}`, type: 'FRAME', children: [branch] };
    }
    const projected: FakeNode = {
      id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{
        id: '0:1', name: 'Page', type: 'CANVAS', explicitVariableModes: { C: 'selected' }, children: [branch],
      }],
    };
    const projectionDepths: number[] = [];
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getNodesRaw: async () => ({ version: 'v-proof', nodes: { '7:70': { document: requestRoot } } }),
        getDocumentByIdsRaw: async (_file: string, ids: string[], depth: number, version?: string) => {
          expect(ids).toEqual(['7:70']);
          expect(version).toBe('v-proof');
          projectionDepths.push(depth);
          return { name: 'Proof', lastModified: '', version: 'v-proof', document: prune(projected, depth) } as any;
        },
        getDocumentRaw: async () => { throw new Error('whole-file fetch must not be used'); },
        getVariablesLocal: async () => ({ meta: {
          variableCollections: { C: { id: 'C', name: 'Theme', defaultModeId: 'default', modes: [
            { modeId: 'default', name: 'Default' }, { modeId: 'selected', name: 'Selected' },
          ] } },
          variables: { 'V:proof': { id: 'V:proof', name: 'surface/proof', resolvedType: 'COLOR', variableCollectionId: 'C',
            valuesByMode: { default: defaultColor, selected: selectedColor } } },
        } }),
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
        getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
    };
    registerGetDesignContextTool(server, deps);

    const response = await call('get_design_context', { file: 'proof', node_id: '7:70', depth: 4, include_component_docs: false });
    const body = JSON.parse(textOf(response.content[0]));
    const fillRef = body.node.fill;
    expect(body.globalVars[fillRef]).toMatchObject({
      default_value: '#445566', effective_rendered_value: '#778899', value: '#778899',
      effective_mode_source: 'ancestor_chain',
    });
    expect(body.globalVars[fillRef].value).not.toBe('#112233');
    expect(projectionDepths).toEqual([4, 8, 16]);
  });
});

describe('get_design_context: skipped discovery + downstream-alias multi-mode default -> honest default (Critical)', () => {
  it('needsAncestors=false (direct collection pinned) but a downstream alias hop defaults -> mode_source:"default"', async () => {
    // CT = directly-bound collection (multi-mode), pinned by the subtree on ROOT.
    // CD = downstream collection (multi-mode), NOT pinned anywhere in the fetched subtree.
    const collections = {
      CT: { id: 'CT', name: 'Theme', defaultModeId: 'ct1',
        modes: [{ modeId: 'ct1', name: 'Light' }, { modeId: 'ct2', name: 'Dark' }] },
      CD: { id: 'CD', name: 'SubBrand', defaultModeId: 'cd1',
        modes: [{ modeId: 'cd1', name: 'Lunar' }, { modeId: 'cd2', name: 'Solar' }] },
    };
    const variables = {
      // accent lives in CT and, in BOTH its modes, aliases DOWNSTREAM to brand (in CD).
      'V:A': { id: 'V:A', name: 'text color/accent', resolvedType: 'COLOR', variableCollectionId: 'CT',
        valuesByMode: { ct1: { type: 'VARIABLE_ALIAS', id: 'V:B' }, ct2: { type: 'VARIABLE_ALIAS', id: 'V:B' } } },
      // brand lives in CD: default mode cd1 -> #a73afd, cd2 -> #8b6afb.
      'V:B': { id: 'V:B', name: 'brand/600', resolvedType: 'COLOR', variableCollectionId: 'CD',
        valuesByMode: { cd1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, cd2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } } },
    };
    // ROOT pins CT (→ct2) so needsAncestors sees CT as pinned and returns false → discovery SKIPPED.
    // Nothing pins CD, so the accent→brand alias hop falls back to CD's default mode cd1 (#a73afd).
    const rootSubtree = {
      id: 'ROOT', name: 'Header', type: 'FRAME', explicitVariableModes: { CT: 'ct2' },
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      children: [{ id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR',
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
        boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:A' }] } }],
    };

    const docFetches: number[] = [];
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getNodesRaw: async (_f: string, ids: string[], _depth?: number) => {
          const nodes: Record<string, { document: unknown }> = {};
          for (const nid of ids) if (nid === 'ROOT') nodes[nid] = { document: rootSubtree };
          return { version: 'v1', nodes };
        },
        // Called only by ancestor discovery — must never fire when needsAncestors() is false.
        getDocumentByIdsRaw: async (_f: string, _ids: string[], depth: number) => {
          docFetches.push(depth);
          return { name: 'Synthetic', lastModified: '', version: 'v1', document: { id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [] } } as any;
        },
        getVariablesLocal: async () => ({ meta: { variableCollections: collections, variables } }),
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
        getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
    };
    registerGetDesignContextTool(server, deps);

    const res = await call('get_design_context', { file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    const body = JSON.parse(textOf(res.content[0]));
    const strokeRef = body.node.children[0].stroke;
    // The downstream alias hop into the unpinned multi-mode collection CD fell back to CD's DEFAULT
    // mode (#a73afd). Because discovery was SKIPPED, coverage is NOT complete → mode_source MUST stay
    // honest 'default', never a false 'node'.
    expect(body.globalVars[strokeRef]).toMatchObject({
      token: 'text color/accent', default_value: '#a73afd', effective_rendered_value: null, value: null,
      mode_dependent: true, effective_mode_source: 'unverifiable',
    });
    // Prove this is the SKIPPED-discovery path (needsAncestors=false): getDocumentRaw never fired.
    expect(docFetches).toEqual([]);
  });
});
