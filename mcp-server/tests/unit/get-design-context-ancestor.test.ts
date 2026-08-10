import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerGetDesignContextTool, discoverAncestorModes } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { createLogger, type Logger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { buildGraph, resolveKeyInMode } from '../../src/domain/variable-graph.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.useRealTimers());

// FR-3(a) / FR-2 regression guard — end-to-end ancestor glue through the tool, no network.
//
// Tree: DOC → PAGE → ANC(explicitVariableModes {C:m2}) → ROOT(request root) → LEAF(stroke→V:1).
// The ancestor ANC sets the mode ABOVE the request root, so the request subtree alone cannot
// pin it down: the tool must (1) detect needsAncestors, (2) fetch getDocumentRaw, (3) fetch the
// ancestor chain via getNodesRaw at depth=1 (depth=0 400s — the FR-2 bug), (4) merge the
// ancestor stack, and (5) resolve LEAF in the ANCESTOR mode m2 (#8b6afb) with mode_source:'node'.
//
// The fake getNodesRaw THROWS on depth<1 (mimics Figma's 400 on depth=0), so reverting FR-2 to
// depth=0 makes the ancestor fetch throw → empty stack → LEAF degrades to the default-mode
// #a73afd/mode_source:'default' → this test fails. That makes it a genuine regression guard.

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

// Full document tree returned by getDocumentRaw (needs only id/name/type/children for the
// structure walk, plus explicitVariableModes for the ancestor mode fold).
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

// Ancestor nodes returned by getNodesRaw(chainIds, depth=1) — ANC carries the explicit mode.
const ancestorNodes: Record<string, { document: unknown }> = {
  DOC: { document: { id: 'DOC', name: 'Document', type: 'DOCUMENT' } },
  PAGE: { document: { id: 'PAGE', name: 'Page 1', type: 'CANVAS' } },
  ANC: { document: { id: 'ANC', name: 'Themed', type: 'FRAME', explicitVariableModes: { C: 'm2' } } },
};

type Harness = { handler: (a: any) => Promise<any>; depthsSeen: number[]; stacksSeen: Map<string, string>[] };

function harness(opts: {
  leafBoundId?: string;                                  // override the stroke binding id (cross-lib)
  variables?: unknown;                                   // override getVariablesLocal payload
  variableGraph?: ToolDeps['variableGraph'];
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
        for (const nid of ids) {
          if (nid === 'ROOT') nodes[nid] = { document: rootDoc };
          else if (ancestorNodes[nid]) nodes[nid] = ancestorNodes[nid];
        }
        return { nodes };
      },
      getDocumentRaw: async () => ({ document: fullDoc } as any),
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
    deps.variableGraph = { ...deps.variableGraph, resolveInMode: (key, stack) => { stacksSeen.push(new Map(stack)); return inner(key, stack); } };
  }
  registerGetDesignContextTool(server, deps);
  return { handler: (a: any): Promise<any> => call('get_design_context', a), depthsSeen, stacksSeen };
}

describe('get_design_context ancestor-mode glue (FR-2 / FR-3a)', () => {
  it('resolves a LEAF stroke in the ABOVE-root ancestor mode (#8b6afb, mode_source:node)', async () => {
    const h = harness();
    const res = await h.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef]).toMatchObject({
      token: 'text color/accent', value: '#8b6afb', mode: 'Dusk', mode_dependent: true, mode_source: 'node',
    });
    // The ancestor chain WAS fetched at depth=1 (never depth=0).
    expect(h.depthsSeen).toContain(1);
    expect(h.depthsSeen).not.toContain(0);
  });

  it('passes the ancestor-merged stack to a cross-library variableGraph.resolveInMode', async () => {
    const EXT = 'VariableID:' + 'a'.repeat(40) + '/9:9';
    const graph: ToolDeps['variableGraph'] = {
      // modesByName present → the cross-lib top collection is MULTI-mode, so needsAncestors()
      // triggers discovery (a single-mode top would render inline and skip the whole-file fetch).
      resolve: () => ({ value: '#8b6afb', name: 'lib/accent', modesByName: { Default: '#a73afd', Dusk: '#8b6afb' } }),
      resolveInMode: () => ({ token: 'lib/accent', value: '#8b6afb', mode: 'Dusk', mode_dependent: true, mode_source: 'node', pinned_axis_used: false, unconfirmed_default_used: false }),
    };
    // Local index does NOT know the external id → the cross-library path is taken.
    const h = harness({ leafBoundId: EXT,
      variables: { meta: { variableCollections: collectionC, variables: {} } }, variableGraph: graph });
    const res = await h.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef]).toMatchObject({ token: 'lib/accent', value: '#8b6afb', mode_source: 'node' });
    // Prove the ancestor mode reached the graph resolver: some captured stack had C→m2.
    expect(h.stacksSeen.some((s) => s.get('C') === 'm2')).toBe(true);
  });
});

// --- Minor (perf): needsAncestors gates cross-lib discovery on a MULTI-mode top collection ---
// A single-mode cross-library binding renders inline (mode_dependent stays false) no matter what
// mode any ancestor sets, so a depth-8 whole-file fetch for it is pure waste. needsAncestors()
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
          for (const id of ids) { if (id === 'ROOT') nodes[id] = { document: rootWithExt }; else if (ancestorNodes[id]) nodes[id] = ancestorNodes[id]; }
          return { nodes };
        },
        getDocumentRaw: async () => { docFetches++; return { document: fullDoc } as any; },
        getVariablesLocal: async () => ({ meta: { variableCollections: collectionC, variables: {} } }),  // EXT not local → cross-lib path
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); }, getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      variableGraph: {
        resolve: () => resolveResult,
        resolveInMode: () => (resolveResult?.modesByName
          ? { token: resolveResult.name, value: resolveResult.value, mode: 'Dusk', mode_dependent: true as const, mode_source: 'node' as const, pinned_axis_used: false, unconfirmed_default_used: false }
          : undefined),
        ...(isMultiMode !== undefined ? { isMultiMode: () => isMultiMode } : {}),
      },
    };
    registerGetDesignContextTool(server, deps);
    return { handler: (a: any): Promise<any> => call('get_design_context', a), docFetches: () => docFetches };
  }

  it('single-mode cross-lib binding → discovery SKIPPED (no whole-file getDocumentRaw)', async () => {
    const b = build({ value: '#123456', name: 'lib/token' });   // no modesByName ⇒ single-mode top
    await b.handler({ file: 'abc', node_id: 'ROOT', depth: 4, include_component_docs: false });
    expect(b.docFetches()).toBe(0);
  });

  it('multi-mode cross-lib binding → discovery RUNS (getDocumentRaw fetched)', async () => {
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

const SUBBRAND = 'VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/34:56';

// DOC → PAGE(CANVAS, sets sub-brand→Solar) → L2 → L3 → L4 → L5 → ROOT(depth 6) → LEAF
const deepTree: FakeNode = {
  id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [
    { id: 'PAGE', name: 'Page 1', type: 'CANVAS', explicitVariableModes: { [SUBBRAND]: '34:0' }, children: [
      { id: 'L2', name: 'l2', type: 'FRAME', children: [
        { id: 'L3', name: 'l3', type: 'FRAME', children: [
          { id: 'L4', name: 'l4', type: 'FRAME', children: [
            { id: 'L5', name: 'l5', type: 'FRAME', children: [
              { id: 'ROOT', name: 'Header', type: 'INSTANCE', children: [
                { id: 'LEAF', name: 'Union', type: 'VECTOR' },
              ] },
            ] },
          ] },
        ] },
      ] },
    ] },
  ],
};

// Every node's explicitVariableModes, served by getNodesRaw(chainIds, depth=1).
function nodeDocsById(tree: FakeNode): Record<string, { document: FakeNode }> {
  const out: Record<string, { document: FakeNode }> = {};
  const walk = (n: FakeNode) => {
    const { children, ...rest } = n;
    void children;
    out[n.id] = { document: rest };
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

function recordingLogger(): { logger: Logger; logs: { obj: unknown; msg: string }[] } {
  const logs: { obj: unknown; msg: string }[] = [];
  const rec = (obj: unknown, msg?: string) => { logs.push({ obj, msg: msg ?? '' }); };
  const logger = { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec, child: () => logger } as unknown as Logger;
  return { logger, logs };
}

function fakeApi(tree: FakeNode, depthsSeen: number[]): Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'> {
  const docs = nodeDocsById(tree);
  return {
    getDocumentRaw: async (_file: string, depth = 4) => { depthsSeen.push(depth); return { document: prune(tree, depth) } as any; },
    getNodesRaw: async (_file: string, ids: string[], _depth?: number) => {
      const nodes: Record<string, { document: unknown }> = {};
      for (const id of ids) if (docs[id]) nodes[id] = docs[id];
      return { nodes } as any;
    },
  };
}

describe('discoverAncestorModes (deep-node reach + coverageComplete)', () => {
  it('deepens the fetch to locate a depth-6 request root and reports coverageComplete=true', async () => {
    const depthsSeen: number[] = [];
    const api = fakeApi(deepTree, depthsSeen);
    const { logger } = recordingLogger();
    const disc = await discoverAncestorModes(api, 'file', 'ROOT', logger);
    // The page's sub-brand→Solar mode was discovered even though ROOT is deeper than depth 4.
    expect(disc.stack.get(SUBBRAND)).toBe('34:0');
    expect(disc.coverageComplete).toBe(true);
    // It tried depth 4 first (ROOT absent), then deepened to 8 (ROOT present).
    expect(depthsSeen).toEqual([4, 8]);
  });

  it('logs design_context.ancestor_discovery with depth_reached + at_max_depth (observability)', async () => {
    const depthsSeen: number[] = [];
    const api = fakeApi(deepTree, depthsSeen);
    const { logger, logs } = recordingLogger();
    await discoverAncestorModes(api, 'file', 'ROOT', logger);   // deepens 4 → 8 (the expensive path)
    const disc = logs.find((l) => l.msg === 'design_context.ancestor_discovery');
    expect(disc).toBeTruthy();
    expect(disc!.obj).toMatchObject({ depth_reached: 8, at_max_depth: true, located: true, coverage_complete: true, reaches_top_canvas: true });
  });

  it('ancestor_discovery reports at_max_depth=false for a shallow root found in the first fetch', async () => {
    const depthsSeen: number[] = [];
    const api = fakeApi(deepTree, depthsSeen);
    const { logger, logs } = recordingLogger();
    await discoverAncestorModes(api, 'file', 'L2', logger);   // L2 at depth 2 → located at the first (depth-4) fetch
    const disc = logs.find((l) => l.msg === 'design_context.ancestor_discovery');
    expect(disc!.obj).toMatchObject({ depth_reached: 4, at_max_depth: false, located: true });
  });

  it('does NOT locate the node when capped at depth 4 → coverageComplete=false', async () => {
    const depthsSeen: number[] = [];
    const api = fakeApi(deepTree, depthsSeen);
    const { logger, logs } = recordingLogger();
    const disc = await discoverAncestorModes(api, 'file', 'ROOT', logger, { maxDepth: 4 });
    expect(disc.coverageComplete).toBe(false);
    expect(disc.stack.size).toBe(0);          // ROOT absent → no chain → no ancestor modes
    expect(depthsSeen).toEqual([4]);          // never deepened past the cap
    expect(logs.some((l) => l.msg === 'design_context.ancestor_coverage_dropped')).toBe(true);
  });

  it('stops on oversize (would blow the byte budget) → coverageComplete=false, drop logged, one fetch only', async () => {
    const depthsSeen: number[] = [];
    const api = fakeApi(deepTree, depthsSeen);
    const { logger, logs } = recordingLogger();
    // Tiny budget: even the depth-4 document exceeds it → discovery must stop before deepening.
    const disc = await discoverAncestorModes(api, 'file', 'ROOT', logger, { byteBudget: 10 });
    expect(disc.coverageComplete).toBe(false);
    expect(depthsSeen).toEqual([4]);          // did NOT deepen / pull more
    const drop = logs.find((l) => l.msg === 'design_context.ancestor_coverage_dropped');
    expect(drop).toBeTruthy();
    expect((drop!.obj as { reason?: string }).reason).toBe('byte_budget');
  });

  it('reports coverageComplete=true for a shallow root already within the first fetch', async () => {
    const depthsSeen: number[] = [];
    const api = fakeApi(deepTree, depthsSeen);
    const { logger } = recordingLogger();
    const disc = await discoverAncestorModes(api, 'file', 'L2', logger);   // L2 is at depth 2
    expect(disc.coverageComplete).toBe(true);
    expect(disc.stack.get(SUBBRAND)).toBe('34:0');
    expect(depthsSeen).toEqual([4]);          // located on the first fetch, no deepening
  });

  it('deadline: discovery drops BEFORE the first whole-file fetch when the floor does not fit', async () => {
    let docCalls = 0;
    const api = { getDocumentRaw: async () => { docCalls++; return { document: { id: '0:0', type: 'DOCUMENT', children: [] } }; },
                  getNodesRaw: async () => ({ nodes: {} }) };
    const disc = await discoverAncestorModes(api as never, 'F', '1:1', logger, { deadlineAt: Date.now() + 1_000 });
    expect(docCalls).toBe(0);                                          // 15s floor > 1s remaining
    expect(disc.coverageComplete).toBe(false);
    expect(disc.droppedReason).toBe('time_budget');
  });

  // R3-F4: the floor gate only decides whether to START a fetch; the fetch ITSELF runs through a
  // fresh CAPPED api (cfg.makeCappedApi) so an overrun aborts as a REAL settled rejection. The
  // capped adapter surfaces an over-budget fetch as FigmaApiError('network', 0, '… timed out …'),
  // which discovery maps to a time_budget drop; a 429 arriving before the cap rethrows as genuine
  // rate_limited and must PROPAGATE (never swallowed into a quiet degraded success — the R2 race bug).
  it('deadline: a capped whole-file fetch that aborts (timeout FigmaApiError) → time_budget, loop stopped', async () => {
    let cappedDocCalls = 0;
    const cappedApi = {
      getDocumentRaw: async () => { cappedDocCalls++; throw new FigmaApiError('network', 0, 'Figma request timed out after 20000ms'); },
      getNodesRaw: async () => ({ nodes: {} }),
    } as unknown as Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'>;
    // Base api must NOT be used when a capped factory + deadline are present — make it throw loudly.
    const base = { getDocumentRaw: async () => { throw new Error('base api used — should be capped'); }, getNodesRaw: async () => ({ nodes: {} }) };
    const disc = await discoverAncestorModes(base as never, 'F', '1:1', logger,
      { deadlineAt: Date.now() + 20_000, makeCappedApi: () => cappedApi });
    expect(disc.droppedReason).toBe('time_budget');
    expect(disc.coverageComplete).toBe(false);
    expect(cappedDocCalls).toBe(1);                                   // stopped after the first capped fetch — never deepened to depth 8
  });

  it('deadline: a capped getDocumentRaw 429 REJECTS discovery (rate_limited propagates, never a quiet drop)', async () => {
    const cappedApi = {
      getDocumentRaw: async () => { throw new FigmaApiError('rate_limited', 429, 'slow down', 5); },
      getNodesRaw: async () => ({ nodes: {} }),
    } as unknown as Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'>;
    const base = { getDocumentRaw: async () => ({ document: { id: '0:0', type: 'DOCUMENT', children: [] } }), getNodesRaw: async () => ({ nodes: {} }) };
    await expect(discoverAncestorModes(base as never, 'F', '1:1', logger,
      { deadlineAt: Date.now() + 20_000, makeCappedApi: () => cappedApi }),
    ).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
  });

  it('deadline: a capped TRAILING getNodesRaw that aborts (timeout) → time_budget, empty ancestors', async () => {
    const depthsSeen: number[] = [];
    const base = fakeApi(deepTree, depthsSeen);                       // getDocumentRaw locates L2 in the first (depth-4) fetch
    // capped api: getDocumentRaw locates L2 (delegates to base), the trailing getNodesRaw aborts.
    const cappedApi = {
      getDocumentRaw: base.getDocumentRaw,
      getNodesRaw: async () => { throw new FigmaApiError('network', 0, 'Figma request timed out after 20000ms'); },
    } as unknown as Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'>;
    const disc = await discoverAncestorModes(base, 'file', 'L2', logger,
      { deadlineAt: Date.now() + 20_000, makeCappedApi: () => cappedApi });
    expect(disc.droppedReason).toBe('time_budget');
    expect(disc.coverageComplete).toBe(false);
    expect(disc.stack.size).toBe(0);                                  // trailing fetch dropped → no ancestor modes
    expect(disc.nodesRootToParent).toEqual([]);
  });

  // R6-F2: the trailing chain fetch's capMs floor (`max(1_000, deadlineAt - now)`) fires even when
  // the deadline has ALREADY passed by the time the (successful) locate loop finishes — issuing an
  // avoidable network call that also queues on the shared heavy-fetch semaphore. A direct
  // deadline-passed pre-gate (mirroring the loop's own floor check) must skip the fetch entirely.
  it('deadline: trailing chain fetch is SKIPPED (never called) when the deadline has already passed by locate time', async () => {
    const depthsSeen: number[] = [];
    let getNodesRawCalls = 0;
    vi.useFakeTimers();
    const start = Date.now();
    // > the loop's 15s floor (need = max(15_000, 2*lastLatencyMs)) so the first iteration proceeds
    // past the pre-fetch floor gate and actually calls getDocumentRaw.
    const deadlineAt = start + 16_000;
    const api = {
      getDocumentRaw: async (_file: string, depth = 4) => {
        depthsSeen.push(depth);
        // Simulate a successful but slow fetch that eats the whole remaining budget: by the time
        // it resolves and the node has been located, the deadline has already passed.
        vi.advanceTimersByTime(20_000);
        return { document: prune(deepTree, depth) } as any;             // depth=4 already contains L2
      },
      getNodesRaw: async (_file: string, ids: string[]) => {
        getNodesRawCalls++;
        const docs = nodeDocsById(deepTree);
        const nodes: Record<string, { document: unknown }> = {};
        for (const id of ids) if (docs[id]) nodes[id] = docs[id];
        return { nodes } as any;
      },
    } as unknown as Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'>;
    const { logger: recLogger, logs } = recordingLogger();
    const disc = await discoverAncestorModes(api, 'file', 'L2', recLogger, { deadlineAt });
    expect(getNodesRawCalls).toBe(0);                                   // trailing fetch never issued
    expect(disc.droppedReason).toBe('time_budget');
    expect(disc.coverageComplete).toBe(false);
    const drop = logs.find((l) => l.msg === 'design_context.ancestor_coverage_dropped'
      && (l.obj as { stage?: string }).stage === 'ancestor_chain');
    expect(drop).toBeTruthy();
    expect((drop!.obj as { reason?: string }).reason).toBe('time_budget');
  });

  // R7-F2: discovery's capMs computation (`max(1_000, deadlineAt - now)`) had no UPPER clamp — a
  // budget past ~2.1e9ms overflows Node's setTimeout (silently clamped to ~1ms internally), so every
  // capped fetch would abort at ~1ms and get mislabeled 'time_budget'. Both capMs sites (the loop
  // fetch and the trailing chain fetch) must clamp to <=90s, matching every sibling cap in this file
  // (coreCapMs, the variables/docs/CC/screenshot caps all clamp to 90_000).
  it('R7-F2: an oversized deadline still clamps capMs to <=90s at both the loop and trailing-chain sites', async () => {
    const depthsSeen: number[] = [];
    const base = fakeApi(deepTree, depthsSeen);   // L2 located on the FIRST (depth-4) fetch; has a 2-node ancestor chain (DOC, PAGE)
    const capsSeen: number[] = [];
    const disc = await discoverAncestorModes(base, 'file', 'L2', logger,
      { deadlineAt: Date.now() + 10_000_000_000, makeCappedApi: (capMs) => { capsSeen.push(capMs); return base; } });
    expect(disc.coverageComplete).toBe(true);
    expect(capsSeen.length).toBeGreaterThanOrEqual(2);   // one loop-fetch call + one trailing chain-fetch call
    for (const c of capsSeen) expect(c).toBeLessThanOrEqual(90_000);
  });

  // Giant-file latency: predictive byte gate (opt-in, cfg.predictiveByteGate — set ONLY by the compare
  // call-site). The pre-existing REACTIVE check (`bytes >= byteBudget`) only stops AFTER a fetch
  // already returned an over-budget document; on a giant real file the NEXT (doubled) depth can
  // itself be tens of MB, and — worse — a cached depth-4 response returns near-instantly, making
  // the reactive gate blind to how expensive the depth-8 fetch will actually be (the large-page
  // 88s stream-abort). The predictive gate multiplies the CURRENT fetch's bytes by 2 (deepening
  // AT MINIMUM doubles the serialized tree) and refuses to even START the next fetch. Doc has NO
  // target node — 'nope:1' is never located, so the ONLY way discovery stops after one fetch is
  // the byte gate itself (not a locate).
  it('predictiveByteGate — bytes*2 >= byteBudget drops BEFORE the next fetch (spy=1)', async () => {
    const depthsSeen: number[] = [];
    // depth-4 doc WITHOUT the target node; name-padded so JSON.stringify(document).length ≈ 600.
    const doc = { id: 'DOC', name: 'x'.repeat(546), type: 'DOCUMENT', children: [] };
    const bytes = JSON.stringify(doc).length;
    expect(bytes).toBeLessThan(1000);                              // sanity: reactive gate would NOT fire on its own
    const api = {
      getDocumentRaw: async (_f: string, depth = 4) => { depthsSeen.push(depth); return { document: doc } as any; },
      getNodesRaw: async () => ({ nodes: {} }) as any,
    };
    const { logger: recLogger, logs } = recordingLogger();
    const disc = await discoverAncestorModes(api as never, 'k', 'nope:1', recLogger,
      { startDepth: 4, byteBudget: 1000, predictiveByteGate: true });
    expect(depthsSeen).toEqual([4]);                               // exactly one fetch — predictive stop BEFORE depth 8
    expect(disc.droppedReason).toBe('byte_budget');
    const drop = logs.find((l) => l.msg === 'design_context.ancestor_coverage_dropped');
    expect(drop).toBeTruthy();
    expect((drop!.obj as { predicted_next_bytes?: number }).predicted_next_bytes).toBe(bytes * 2);
  });

  it('predictive byte-gate control: the same doc WITHOUT the flag → the reactive gate lets it through (600 < 1000), deepening continues', async () => {
    const depthsSeen: number[] = [];
    const doc = { id: 'DOC', name: 'x'.repeat(546), type: 'DOCUMENT', children: [] };
    const api = {
      getDocumentRaw: async (_f: string, depth = 4) => { depthsSeen.push(depth); return { document: doc } as any; },
      getNodesRaw: async () => ({ nodes: {} }) as any,
    };
    const disc = await discoverAncestorModes(api as never, 'k', 'nope:1', logger, { startDepth: 4, byteBudget: 1000 });
    expect(depthsSeen).toEqual([4, 8]);                            // no flag → reactive-only → deepens once, then depth_cap
    expect(disc.droppedReason).toBe('depth_cap');
  });

  it('predictive byte-gate control-2: under the flag, bytes*2 < byteBudget (byteBudget: 2000) → deepening continues', async () => {
    const depthsSeen: number[] = [];
    const doc = { id: 'DOC', name: 'x'.repeat(546), type: 'DOCUMENT', children: [] };
    const api = {
      getDocumentRaw: async (_f: string, depth = 4) => { depthsSeen.push(depth); return { document: doc } as any; },
      getNodesRaw: async () => ({ nodes: {} }) as any,
    };
    const disc = await discoverAncestorModes(api as never, 'k', 'nope:1', logger,
      { startDepth: 4, byteBudget: 2000, predictiveByteGate: true });
    expect(depthsSeen).toEqual([4, 8]);                            // predicted 1200 < 2000 → does NOT stop early
    expect(disc.droppedReason).toBe('depth_cap');
  });
});

// --- Deep root BEYOND the ancestor-fetch depth cap -> honest 'default' -----------------------
//
// discoverAncestorModes starts at depth 4 and doubles once to 8 (ANCESTOR_START_DEPTH /
// ANCESTOR_MAX_DEPTH in get-design-context-tool.ts), then stops. A request root ONE level past
// that cap is never located by ANY bounded fetch the tool actually performs (no maxDepth override
// here — this exercises the tool's real, hard-coded bound), so coverageComplete=false and the
// ancestor stack stays empty. The LEAF's stroke is bound to V:1 in the 2-mode collection C (same
// fixture as the shallow-root glue test above) with NO explicit mode anywhere in the (unreachable)
// chain: it must resolve to collection C's DEFAULT mode (m1, #a73afd) and be labeled
// mode_source:'default' — never silently promoted to 'node' just because a default was used.
describe('get_design_context: deep root beyond the ancestor-fetch cap -> honest default', () => {
  it('coverageComplete=false: multi-mode token defaults to the collection default, mode_source stays "default"', async () => {
    // DOC(0) -> PAGE(1) -> W2..W8(2..8) -> ROOT(9) -> LEAF(10). ROOT sits at level 9 — past the
    // depth-8 cap — so even the deepest bounded document fetch never contains it.
    let deepNode: FakeNode = {
      id: 'ROOT', name: 'Header', type: 'FRAME',
      children: [{ id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR' }],
    };
    for (let i = 8; i >= 2; i--) {
      deepNode = { id: `W${i}`, name: `wrapper ${i}`, type: 'FRAME', children: [deepNode] };
    }
    const beyondCapTree: FakeNode = {
      id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [
        { id: 'PAGE', name: 'Page 1', type: 'CANVAS', children: [deepNode] },
      ],
    };
    const docsById = nodeDocsById(beyondCapTree);

    const depthsSeen: number[] = [];
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getDocumentRaw: async (_file: string, depth = 4) => { depthsSeen.push(depth); return { document: prune(beyondCapTree, depth) } as any; },
        getNodesRaw: async (_file: string, ids: string[]) => {
          const nodes: Record<string, { document: unknown }> = {};
          for (const id of ids) {
            if (id === 'ROOT') nodes[id] = { document: rootSubtree };   // ROOT's own subtree (LEAF bound to V:1)
            else if (docsById[id]) nodes[id] = docsById[id];
          }
          return { nodes };
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
      token: 'text color/accent', value: '#a73afd', mode: 'Default', mode_dependent: true, mode_source: 'default',
    });
    // Discovery genuinely deepened to the cap (4 -> 8) and then stopped — it never located ROOT.
    expect(depthsSeen).toEqual([4, 8]);
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
    resolveInMode: (key, stack) => { stacksSeen.push(new Map(stack)); return resolveKeyInMode(g, key, stack); },
  };
  return { graph, stacksSeen };
}

type CNode = { id: string; name: string; type: string; explicitVariableModes?: Record<string, string>; children?: CNode[]; [k: string]: unknown };

// The full-document ancestor docs served by getNodesRaw(chainIds, depth=1): each node minus children.
function ancestorDocMap(fullDoc: CNode): Record<string, { document: CNode }> {
  const out: Record<string, { document: CNode }> = {};
  const walk = (n: CNode) => {
    const { children, ...rest } = n; void children;
    out[n.id] = { document: rest };
    for (const c of n.children ?? []) walk(c);
  };
  walk(fullDoc);
  return out;
}

const leafNode = (): CNode => ({ id: 'LEAF', name: '24/Stroke/menu', type: 'VECTOR',
  strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
  boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: ACCENT_BINDING }] } });

function collisionHarness(fullDoc: CNode, rootSubtree: CNode, rootId: string):
  { handler: (a: any) => Promise<any>; stacksSeen: Map<string, string>[] } {
  const { graph, stacksSeen } = collisionGraph();
  const ancDocs = ancestorDocMap(fullDoc);
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getNodesRaw: async (_f: string, ids: string[], depth?: number) => {
        if ((depth ?? 0) < 1) throw new Error('Figma 400: depth must be a positive integer');
        const nodes: Record<string, { document: unknown }> = {};
        for (const id of ids) {
          if (id === rootId) nodes[id] = { document: rootSubtree };
          else if (ancDocs[id]) nodes[id] = ancDocs[id];
        }
        return { nodes };
      },
      getDocumentRaw: async () => ({ document: fullDoc } as any),
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
function resolvedAccent(body: any): { value: string } {
  const hit = Object.values(body.globalVars).find(
    (v: any) => v && typeof v === 'object' && v.token === 'text color/accent');
  return hit as { value: string };
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
    expect(resolvedAccent(body).value).toBe('#8b6afb');   // NEAREST (ROOT/Solar), NOT ancestor Lunar #a73afd
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
    expect(resolvedAccent(body).value).toBe('#8b6afb');   // DEEPER (INNER/Solar), NOT shallower Lunar #a73afd
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
          return { nodes };
        },
        // Called ONLY by discoverAncestorModes — must never fire when needsAncestors()=false.
        getDocumentRaw: async (_f: string, depth = 4) => { docFetches.push(depth); return { document: { id: 'DOC', type: 'DOCUMENT' } } as any; },
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
      token: 'text color/accent', value: '#a73afd', mode: 'Dark', mode_dependent: true, mode_source: 'default',
    });
    // Prove this is the SKIPPED-discovery path (needsAncestors=false): getDocumentRaw never fired.
    expect(docFetches).toEqual([]);
  });
});
