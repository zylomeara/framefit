import { describe, it, expect, vi } from 'vitest';
import { registerGetDesignContextTool } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

const frame: RawSceneNode = {
  id: '1:5', name: 'Hero', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 80 },
  fills: [{ type: 'SOLID', color: { r: 0.482, g: 0.380, b: 0.965 } }],
  boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } },
};

function harness(over: Partial<FigmaApi> = {}, maxResultChars = 40000, parseSchema = false) {
  const { server, call, callParsed } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
      getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getNodesRaw: async () => ({ nodes: { '1:5': { document: frame } } }),
      getVariablesLocal: async () => ({ meta: {
        variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: { 'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 0.482, g: 0.380, b: 0.965 } } } },
      } }),
      ...over,
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars,
  };
  registerGetDesignContextTool(server, deps);
  return (a: any): Promise<any> => (parseSchema ? callParsed : call)('get_design_context', a);
}

describe('get_design_context tool', () => {
  const componentDefinition = (extra: Record<string, unknown> = {}) => ({
    id: '1:5', name: 'Card', type: 'COMPONENT', ...extra,
  });
  const instanceSkeleton = (containers: { id: string; name: string }[] = []) => ({
    name: 'F', lastModified: 'X', version: '1',
    document: { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: [
      { id: '0:1', name: 'Board', type: 'CANVAS', children: containers.map((c) => ({ ...c, type: 'FRAME' })) },
    ] },
  });

  it('adds an executable find_nodes continuation for an empty root component', async () => {
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) =>
      ({ nodes: { [ids[0]]: ids[0] === '1:5' ? { document: componentDefinition() } : null } }));
    const run = harness({ getNodesRaw, getDocumentRaw: async () => instanceSkeleton() as any });

    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.resolution_hints).toEqual({
      reason: 'definition_has_no_rendered_children',
      next_call: { tool: 'find_nodes', arguments: { file: 'abc', query: 'Card', type: 'INSTANCE', depth: 8, limit: 20 } },
    });
  });

  it('uses the one concrete rendered instance as the only continuation', async () => {
    const container = { id: '2:1', name: 'Checkout', type: 'FRAME', children: [
      { id: '2:2', name: 'Card instance', type: 'INSTANCE', componentId: '1:5' },
    ] };
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({
      nodes: { [ids[0]]: ids[0] === '1:5' ? { document: componentDefinition() } : ids[0] === '2:1' ? { document: container } : null },
    }));
    const run = harness({ getNodesRaw, getDocumentRaw: async () => instanceSkeleton([{ id: '2:1', name: 'Checkout' }]) as any });

    const body = JSON.parse((await run({ file: 'abc', node_id: '1-5', depth: 4 })).content[0].text as string);
    expect(body.concrete_instances).toEqual([{ node_id: '2:2', name: 'Card instance', path: ['Board', 'Checkout'] }]);
    expect(body.resolution_hints.next_call).toEqual({
      tool: 'get_design_context', arguments: { file: 'abc', node_id: '2:2', depth: 4 },
    });
  });

  it('does not hint for a root component whose rendered children were truncated', async () => {
    const run = harness({ getNodesRaw: async () => ({ nodes: { '1:5': { document: componentDefinition({ truncated: true }) } } }) });

    const body = JSON.parse((await run({ file: 'abc', node_id: '1-5', depth: 4 })).content[0].text as string);
    expect(body.resolution_hints).toBeUndefined();
  });

  it('does not hint for an ordinary empty frame or an already rendered instance root', async () => {
    const frameRun = harness({ getNodesRaw: async () => ({ nodes: { '1:5': { document: { id: '1:5', name: 'Empty', type: 'FRAME' } } } }) });
    const instanceRun = harness({ getNodesRaw: async () => ({ nodes: { '1:5': { document: { id: '1:5', name: 'Card', type: 'INSTANCE', componentId: '1:4' } } } }) });

    expect(JSON.parse((await frameRun({ file: 'abc', node_id: '1-5', depth: 4 })).content[0].text as string).resolution_hints).toBeUndefined();
    expect(JSON.parse((await instanceRun({ file: 'abc', node_id: '1-5', depth: 4 })).content[0].text as string).resolution_hints).toBeUndefined();
  });

  it('returns simplified node with fill resolved to the token name', async () => {
    const run = harness();
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('"name":"Hero"');
    expect(text).toContain('color/brand/primary'); // token name, not hex
    expect(text).toContain('"size"');
  });

  it('uses the production depth default when the fake invokes the registered schema', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:5': { document: frame } } }));
    const run = harness({ getNodesRaw }, 40000, true);

    const res = await run({ file: 'abc', node_id: '1-5', include_component_docs: false });

    expect(res.isError).toBeFalsy();
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:5'], 5);
  });

  it('falls back to raw hex when variables are forbidden (non-Enterprise)', async () => {
    const run = harness({ getVariablesLocal: async () => { throw new FigmaApiError('forbidden', 403, 'no'); } });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('#7b61f6');           // raw hex fallback
    expect(text).not.toContain('color/brand/primary');
  });

  it('errors when node not found', async () => {
    const run = harness({ getNodesRaw: async () => ({ nodes: { '1:5': null } }) });
    const res = await run({ file: 'abc', node_id: '1-5' });
    expect(res.isError).toBe(true);
  });

  it('swallows a non-forbidden variables error (upstream 500) and falls back to hex', async () => {
    const run = harness({ getVariablesLocal: async () => { throw new FigmaApiError('upstream', 500, 'boom'); } });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('#7b61f6');
  });

  it('propagates a rate_limited variables error (respect quota)', async () => {
    const run = harness({ getVariablesLocal: async () => { throw new FigmaApiError('rate_limited', 429, 'slow down', 30); } });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/rate_limited|rate limit/i);
  });

  it('truncated overflow response itself stays within the budget', async () => {
    const run = harness({}, 50); // absurdly small budget → even the truncated fallback must be trimmed
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    expect(res.content[0].text.length).toBeLessThanOrEqual(50 + 400); // small slack for JSON structure/warning
    expect(() => JSON.parse(res.content[0].text)).not.toThrow();
  });

  it('escapes ) and , in variable name inside var(--name, #fallback)', async () => {
    const EXT_KEY = 'b'.repeat(40);
    const EXT_ALIAS_ID = `VariableID:${EXT_KEY}/9:2`;
    const extFrame2 = {
      id: '3:1', name: 'ExtFrame2', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
      fills: [{ type: 'SOLID', color: { r: 0.141, g: 0.141, b: 0.161 } }],
      boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: EXT_ALIAS_ID } },
    };
    const { server: srv2, call: call2 } = makeFakeMcpServer();
    const deps2: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getNodesRaw: async () => ({ nodes: { '3:1': { document: extFrame2 } } }),
        getVariablesLocal: async () => ({ meta: { variableCollections: {}, variables: {} } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
      variableGraph: {
        resolve: (key: string) => key === EXT_KEY ? { value: '#242429', name: 'button(default)' } : undefined,
      },
    };
    registerGetDesignContextTool(srv2, deps2);
    const run2 = (a: any): Promise<any> => call2('get_design_context', a);
    const res2 = await run2({ file: 'abc', node_id: '3-1', depth: 4 });
    const text2 = res2.content[0].text as string;
    // name contains ) — must be escaped in the CSS var() name segment.
    // text2 is a JSON string, so the backslash is itself JSON-escaped to \\.
    expect(text2).toContain('var(--button\\\\(default\\\\), #242429)');
    expect(text2).not.toContain('var(--button(default),');
  });

  it('auto-degrades depth when tree exceeds budget', async () => {
    // Recalibrated for the compact measurement (final F1: measure == delivery): the old numbers "full ~1414 /
    // depth-1 ~828, budget 900" were PRETTY measurements — the compact-full of that fixture (678) fit in
    // 900 without degrading. The grandchildren are packed (5 children × 3 grandchildren with long names) so the trim saving
    // (~555) outweighs the hint cost (~385). Live compact measurements: full 1478 (pretty 2837),
    // depth-1 delivery with hint = 923; the graceful-degrade window 978..1378 → budget 1100.
    const children = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`, name: `child${i}`, type: 'FRAME',
      children: Array.from({ length: 3 }, (_, j) => ({
        id: `gc${i}-${j}`, name: `grandchild-rectangle-${i}-${j}`, type: 'RECTANGLE',
      })),
    }));
    const bigFrame = {
      id: '1:5', name: 'BigFrame', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 80 },
      children,
    };
    const BUDGET = 1100;
    const run = harness({
      getNodesRaw: async () => ({ nodes: { '1:5': { document: bigFrame } } }),
      getVariablesLocal: async () => ({ meta: { variableCollections: {}, variables: {} } }),
    }, BUDGET);
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.degraded).toBe(true);
    expect(body.depth).toBeLessThan(4);
    expect(body.hint).toMatch(/truncated/);                 // degrade honestly flagged
    expect(body.globalVars).toBeDefined();                  // graceful path, not ultra-shed
    expect(body.note).toBeUndefined();
    expect(res.content[0].text.length).toBeLessThanOrEqual(BUDGET); // measure == delivery: no slack needed
  });

  it('renders cross-library bound var as var(--name, #fallback) when graph provides a name', async () => {
    const EXT_KEY = 'a'.repeat(40); // valid 40-hex key
    const EXT_ALIAS_ID = `VariableID:${EXT_KEY}/9:1`;
    const extFrame = {
      id: '2:1', name: 'ExtFrame', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
      fills: [{ type: 'SOLID', color: { r: 0.141, g: 0.141, b: 0.161 } }],
      boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: EXT_ALIAS_ID } },
    };
    const { server: srv, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
        getDocumentRaw: async () => ({}) as any, getImages: async () => ({ images: {} }),
        getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
        getNodesRaw: async () => ({ nodes: { '2:1': { document: extFrame } } }),
        getVariablesLocal: async () => ({ meta: { variableCollections: {}, variables: {} } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
      variableGraph: {
        resolve: (key: string) => key === EXT_KEY ? { value: '#242429', name: 'neutral/fg/primary' } : undefined,
      },
    };
    registerGetDesignContextTool(srv, deps);
    const run = (a: any): Promise<any> => call('get_design_context', a);
    const res = await run({ file: 'abc', node_id: '2-1', depth: 4 });
    const text = res.content[0].text as string;
    expect(text).toContain('var(--neutral/fg/primary, #242429)');
  });

  it('include_screenshot:true attaches a signed url (not inline base64)', async () => {
    const getImages = vi.fn(async () => ({ images: { '1:5': 'https://s3/i.png' } }));
    const run = harness({ getImages });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_screenshot: true });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.screenshot).toBe('https://s3/i.png');
    expect(getImages).toHaveBeenCalledWith('abc', ['1:5'], { format: 'png', scale: 2 });
  });

  it('omits screenshot and does not call getImages by default', async () => {
    const getImages = vi.fn(async () => ({ images: { '1:5': 'https://s3/i.png' } }));
    const run = harness({ getImages });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4 });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.screenshot).toBeUndefined();
    expect(getImages).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the screenshot render fails (non-rate)', async () => {
    const run = harness({ getImages: async () => { throw new FigmaApiError('upstream', 500, 'boom'); } });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_screenshot: true });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text as string).screenshot).toBeUndefined();
  });

  it('omits screenshot when Figma returns a null render url', async () => {
    const run = harness({ getImages: async () => ({ images: { '1:5': null } }) });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_screenshot: true });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text as string).screenshot).toBeUndefined();
  });

  it('propagates rate_limited from the screenshot render', async () => {
    const run = harness({ getImages: async () => { throw new FigmaApiError('rate_limited', 429, 'slow', 30); } });
    const res = await run({ file: 'abc', node_id: '1-5', depth: 4, include_screenshot: true });
    expect(res.isError).toBe(true);
  });

  describe('depth-boundary truncation signal (fetch depth+1, simplify stops at args.depth)', () => {
    // Mode-dependent variable so the honesty regression test has something meaningful to compare.
    // ROOT pins the collection's mode explicitly (Dark/m2) so the LEAF resolves mode_source:'node'
    // WITHOUT needing above-root ancestor discovery (keeps the harness's trivial getDocumentRaw fine).
    const modeCollections = { 'VC:M': { id: 'VC:M', name: 'Theme', defaultModeId: 'm1',
      modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] } };
    const modeVariables = { 'V:M': { id: 'V:M', name: 'brand/accent', resolvedType: 'COLOR' as const, variableCollectionId: 'VC:M',
      valuesByMode: {
        m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 },  // Light (default) -> #a73afd
        m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 },  // Dark -> #8b6afb
      } } };
    const variablesDeps = { getVariablesLocal: async () => ({ meta: { variableCollections: modeCollections, variables: modeVariables } }) };

    // LEAF (depth 1, within args.depth=1) has a mode-dependent fill. When withDeeperLevel is true,
    // LEAF also carries a real (visible) child at depth 2 — present ONLY because the tool now fetches
    // depth+1 — simulating the boundary container whose children Figma would otherwise hide.
    function leafTree(withDeeperLevel: boolean): RawSceneNode {
      return {
        id: '1:5', name: 'Root', type: 'FRAME', explicitVariableModes: { 'VC:M': 'm2' },
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        children: [
          {
            id: 'leaf', name: 'Leaf', type: 'VECTOR',
            fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
            boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'V:M' } },
            ...(withDeeperLevel ? { children: [{ id: 'deeper', name: 'Deeper', type: 'RECTANGLE',
              fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }] } : {}),
          },
        ],
      } as RawSceneNode;
    }

    it('getNodesRaw is called with args.depth + 1', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:5': { document: leafTree(false) } } }));
      const run = harness({ getNodesRaw, ...variablesDeps });
      await run({ file: 'abc', node_id: '1-5', depth: 1 });
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:5'], 2);
    });

    it('a boundary container with real children at depth+1 is marked truncated+childCount, with a top-level hint', async () => {
      const run = harness({
        getNodesRaw: async () => ({ nodes: { '1:5': { document: leafTree(true) } } }),
        ...variablesDeps,
      });
      const res = await run({ file: 'abc', node_id: '1-5', depth: 1 });
      const body = JSON.parse(res.content[0].text as string);
      const leaf = body.node.children[0];
      expect(leaf.truncated).toBe(true);
      expect(leaf.childCount).toBe(1);
      expect(leaf.children).toBeUndefined();
      expect(body.hint).toMatch(/truncated/i);
    });

    it('a genuinely-empty boundary container is NOT truncated and no hint is added', async () => {
      const run = harness({
        getNodesRaw: async () => ({ nodes: { '1:5': { document: leafTree(false) } } }),
        ...variablesDeps,
      });
      const res = await run({ file: 'abc', node_id: '1-5', depth: 1 });
      const body = JSON.parse(res.content[0].text as string);
      const leaf = body.node.children[0];
      expect(leaf.truncated).toBeUndefined();
      expect(leaf.childCount).toBeUndefined();
      expect(body.hint).toBeUndefined();
    });

    it('a hidden-only depth+1 child is NOT truncated (childCount counts visible children only)', async () => {
      const hiddenOnlyLeafTree: RawSceneNode = {
        id: '1:5', name: 'Root', type: 'FRAME', explicitVariableModes: { 'VC:M': 'm2' },
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        children: [
          {
            id: 'leaf', name: 'Leaf', type: 'VECTOR',
            fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
            boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'V:M' } },
            children: [{ id: 'hidden-deeper', name: 'HiddenDeeper', type: 'RECTANGLE', visible: false,
              fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }],
          },
        ],
      } as RawSceneNode;
      const run = harness({
        getNodesRaw: async () => ({ nodes: { '1:5': { document: hiddenOnlyLeafTree } } }),
        ...variablesDeps,
      });
      const res = await run({ file: 'abc', node_id: '1-5', depth: 1 });
      const body = JSON.parse(res.content[0].text as string);
      const leaf = body.node.children[0];
      expect(leaf.truncated).toBeUndefined();
      expect(leaf.childCount).toBeUndefined();
      expect(body.hint).toBeUndefined();
    });

    // HONESTY REGRESSION (required): the whole safety argument for fetching depth+1 is that mode
    // resolution for nodes AT OR ABOVE args.depth never changes because of the extra fetched level.
    // Prove it directly: same LEAF, same mode-dependent fill, resolved with vs without the depth+1
    // level present in the fetch tree — the resolved {value, mode, mode_source} must be identical.
    it('HONESTY REGRESSION: a mode-dependent fill at depth <= N resolves identically whether the fetch tree includes the depth+1 boundary level or not', async () => {
      const runWithout = harness({
        getNodesRaw: async () => ({ nodes: { '1:5': { document: leafTree(false) } } }),
        ...variablesDeps,
      });
      const runWith = harness({
        getNodesRaw: async () => ({ nodes: { '1:5': { document: leafTree(true) } } }),
        ...variablesDeps,
      });
      const resWithout = await runWithout({ file: 'abc', node_id: '1-5', depth: 1 });
      const resWith = await runWith({ file: 'abc', node_id: '1-5', depth: 1 });
      const bodyWithout = JSON.parse(resWithout.content[0].text as string);
      const bodyWith = JSON.parse(resWith.content[0].text as string);
      const leafWithout = bodyWithout.node.children[0];
      const leafWith = bodyWith.node.children[0];
      const tokenWithout = bodyWithout.globalVars[leafWithout.fill];
      const tokenWith = bodyWith.globalVars[leafWith.fill];
      expect(tokenWith).toMatchObject({
        value: tokenWithout.value,
        effective_rendered_value: tokenWithout.effective_rendered_value,
        effective_modes: tokenWithout.effective_modes,
        effective_mode_source: tokenWithout.effective_mode_source,
      });
      // Sanity: the mode really did resolve node-confirmed Dark (#8b6afb), not silently defaulted.
      expect(tokenWithout).toMatchObject({
        value: '#8b6afb',
        effective_rendered_value: '#8b6afb',
        effective_mode_source: 'ancestor_chain',
        effective_modes: { Theme: { mode: 'Dark', source: 'ancestor_chain', node_id: '1:5' } },
      });
    });

    // REGRESSION (Finding 2): the HONESTY REGRESSION test above uses an inert depth+1 node (a plain
    // solid fill, no boundVariables) — it cannot perturb resolution BY CONSTRUCTION, so it would
    // stay green even if the depth+1 level leaked into needsAncestors()/collectSubtree*() and
    // triggered a real (expensive, possibly request-failing) ancestor-discovery fetch for a node
    // that is never rendered. This test's depth+1 node instead carries a bound variable whose
    // library key IS multi-mode per variableGraph.isMultiMode — the exact shape needsAncestors()
    // treats as "ancestor discovery required" — while still being cut by args.depth and thus never
    // rendered. It must NOT trigger discovery (spy on getDocumentRaw) and must NOT perturb LEAF's
    // resolution. This test FAILS against the pre-fix implementation (which fed the whole depth+1
    // doc into needsAncestors()) and PASSES once the tool prunes to args.depth before any resolver
    // sees the doc.
    it('REGRESSION (Finding 2): a multi-mode cross-library alias that exists ONLY on a never-rendered depth+1 node must not trigger ancestor-discovery or perturb an in-budget resolution', async () => {
      const EXT_KEY = 'c'.repeat(40);
      const EXT_ALIAS_ID = `VariableID:${EXT_KEY}/9:9`;

      // Same LEAF (depth 1, local mode-dependent fill, resolved via root's explicit mode — see
      // leafTree above). When withDeeperAlias is true, a depth-2 (beyond args.depth=1) child carries
      // a bound variable bound to a cross-library alias that variableGraph reports as multi-mode.
      function treeWithDeeperAlias(withDeeperAlias: boolean): RawSceneNode {
        return {
          id: '1:5', name: 'Root', type: 'FRAME', explicitVariableModes: { 'VC:M': 'm2' },
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          children: [
            {
              id: 'leaf', name: 'Leaf', type: 'VECTOR',
              fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
              boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'V:M' } },
              ...(withDeeperAlias ? { children: [{
                id: 'deeper', name: 'Deeper', type: 'RECTANGLE',
                fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
                boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: EXT_ALIAS_ID } },
              }] } : {}),
            },
          ],
        } as RawSceneNode;
      }

      const runScenario = (withDeeperAlias: boolean, getDocumentRaw: ReturnType<typeof vi.fn>) => {
        const { server: srv, call } = makeFakeMcpServer();
        const deps: ToolDeps = {
          buildApi: () => ({
            getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
            getDocumentRaw,
            getImages: async () => ({ images: {} }),
            getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
            getNodesRaw: async () => ({ nodes: { '1:5': { document: treeWithDeeperAlias(withDeeperAlias) } } }),
            ...variablesDeps,
          } as unknown as FigmaApi),
          defaultToken: 'figd_x', logger,
          variableGraph: { isMultiMode: (k: string) => k === EXT_KEY, resolve: () => undefined },
        };
        registerGetDesignContextTool(srv, deps);
        return (a: any): Promise<any> => call('get_design_context', a);
      };

      const getDocumentRawWithout = vi.fn(async () => ({ document: { id: 'page', name: 'Page', type: 'CANVAS', children: [] } }));
      const getDocumentRawWith = vi.fn(async () => ({ document: { id: 'page', name: 'Page', type: 'CANVAS', children: [] } }));

      const resWithout = await runScenario(false, getDocumentRawWithout)({ file: 'abc', node_id: '1-5', depth: 1 });
      const resWith = await runScenario(true, getDocumentRawWith)({ file: 'abc', node_id: '1-5', depth: 1 });

      const bodyWithout = JSON.parse(resWithout.content[0].text as string);
      const bodyWith = JSON.parse(resWith.content[0].text as string);
      const leafWithout = bodyWithout.node.children[0];
      const leafWith = bodyWith.node.children[0];
      const tokenWithout = bodyWithout.globalVars[leafWithout.fill];
      const tokenWith = bodyWith.globalVars[leafWith.fill];

      // (a) LEAF's resolution is untouched by the never-rendered depth+1 alias.
      expect(tokenWith).toMatchObject({
        value: tokenWithout.value,
        effective_rendered_value: tokenWithout.effective_rendered_value,
        effective_modes: tokenWithout.effective_modes,
        effective_mode_source: tokenWithout.effective_mode_source,
      });
      expect(tokenWithout).toMatchObject({
        value: '#8b6afb',
        effective_rendered_value: '#8b6afb',
        effective_mode_source: 'ancestor_chain',
      });

      // (b) the critical guard: a bound variable that exists ONLY on a depth+1 (never-rendered) node
      // must not trigger ancestor-discovery. Pre-fix, needsAncestors() walks the whole (unpruned)
      // depth+1 doc, finds `deeper`'s multi-mode alias, and calls discoverAncestorModes ->
      // getDocumentRaw. Post-fix, the doc is pruned to args.depth before needsAncestors() runs, so
      // `deeper` was never there to see.
      expect(getDocumentRawWithout).not.toHaveBeenCalled();
      expect(getDocumentRawWith).not.toHaveBeenCalled();
    });
  });
});
