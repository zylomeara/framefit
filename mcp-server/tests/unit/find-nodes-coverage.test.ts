// Batch 2 item 6, sub-items A + D (panel-locked, 46 findings, 14 blockers).
// A: the scoped branch shipped NO coverage at all - a negative claim ("this state does
// not exist in the design") from a depth-limited fetch was unsupported, and the documented
// machine gate (absence trustworthy only when searched === total) evaluated vacuously true
// on a shape that carried neither key. The scoped block now ships the LEDGER SHAPE (fbv
// anchored-path precedent) plus depth_cut/hidden_cut/limit honesty, counted BY
// CONSTRUCTION from the walk depth (never by inspecting the wire shape of a cut node);
// hidden (visible:false) subtrees are pruned by findNodes and must therefore be ledgered,
// or the absence licence lies.
// D: the live feedback's "total 0" was reproduced EXACTLY by type:"PAGE" - Figma pages are
// CANVAS and `type` is free-form, so an unknown value silently filters everything. The
// guard is a note, never aliasing: matching behavior is unchanged.
import { describe, it, expect, vi } from 'vitest';
import { registerFindNodesTool } from '../../src/adapters/driving/tools/find-nodes-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function harness(api: Partial<FigmaApi>, extraDeps: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getNodesRaw: async () => ({ nodes: {} }),
      getDocumentRaw: async () => ({ name: 'F', lastModified: 'X', version: '1', document: { id: '0:0', name: 'Doc', type: 'DOCUMENT' } }),
      ...api,
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars: 40000,
    ...extraDeps,
  };
  registerFindNodesTool(server, deps);
  return async (a: any): Promise<any> => JSON.parse((await call('find_nodes', a)).content[0].text as string);
}

type N = { id: string; name: string; type: string; visible?: boolean; characters?: string; children?: N[] };
// A depth-honoring fake: the wire response contains ONLY the requested depth, exactly like
// the REST API - the tool must count cuts from the walk depth, not from any wire marker.
const sliceDepth = (n: N, d: number): N =>
  d <= 0 ? { ...n, children: undefined } : { ...n, children: n.children?.map((c) => sliceDepth(c, d - 1)) };
const depthApi = (root: N) => ({
  getNodesRaw: vi.fn(async (_f: string, ids: string[], depth: number) =>
    ({ nodes: { [ids[0]]: { document: sliceDepth(root, depth) } } })),
});

const deepTree: N = { id: '9:0', name: 'root', type: 'FRAME', children: [
  { id: '9:1', name: 'wrap', type: 'FRAME', children: [
    { id: '9:2', name: 'card', type: 'FRAME', children: [
      { id: '9:3', name: 'deep label', type: 'TEXT', characters: 'needle' },
    ] },
  ] },
] };

describe('A: scoped coverage - the depth_cut flip (one fixture, one query, two depths)', () => {
  it('below the cut: total 0 + depth_cut + named cut node + note; above: found, no cut', async () => {
    const run = harness(depthApi(deepTree));
    const shallow = await run({ file: 'abc', node_id: '9:0', query: 'needle', depth: 2 });
    expect(shallow.total).toBe(0);
    expect(shallow.coverage.depth_cut).toBeGreaterThanOrEqual(1);
    expect(shallow.coverage.depth_cut_nodes).toEqual([{ node_id: '9:2', name: 'card' }]);
    expect(shallow.coverage.note).toMatch(/NOT proof of absence/);
    expect(shallow.coverage.note).toMatch(/raise depth/);          // depth 2 < 10: the remedy is executable
    const deep = await run({ file: 'abc', node_id: '9:0', query: 'needle', depth: 4 });
    expect(deep.total).toBe(1);
    expect(deep.coverage.depth_cut).toBeUndefined();
  });

  it('at the schema-max depth the note does NOT advise raising depth', async () => {
    const tall: N = { id: '9:0', name: 'root', type: 'FRAME', children: [deepTree] };
    let t: N = tall;
    for (let i = 0; i < 9; i++) t = { id: `8:${i}`, name: `w${i}`, type: 'FRAME', children: [t] };
    const run = harness(depthApi(t));
    const out = await run({ file: 'abc', node_id: '8:8', query: 'needle', depth: 10 });
    expect(out.coverage.depth_cut).toBeGreaterThanOrEqual(1);
    expect(out.coverage.note).not.toMatch(/raise depth/);
    expect(out.coverage.note).toMatch(/re-root/);
  });

  it('fully within depth -> the LEDGER SHAPE positively (searched===total keeps meaning), childless FRAME above the boundary not counted', async () => {
    const within: N = { id: '9:0', name: 'root', type: 'FRAME', children: [
      { id: '9:5', name: 'empty slot', type: 'FRAME' },            // childless container ABOVE the boundary
      { id: '9:6', name: 'label', type: 'TEXT', characters: 'needle' },
    ] };
    const run = harness(depthApi(within));
    const out = await run({ file: 'abc', node_id: '9:0', query: 'needle', depth: 6 });
    expect(out.coverage).toEqual({ scope: '9:0', depth: 6, searched: 1, total: 1, skipped: [], skippedTotal: 0 });
  });

  it('boundary predicate: BOOLEAN_OPERATION counts as cut, TEXT/RECTANGLE do not', async () => {
    const t: N = { id: '9:0', name: 'root', type: 'FRAME', children: [
      { id: '9:7', name: 'bool', type: 'BOOLEAN_OPERATION', children: [{ id: '9:8', name: 'v', type: 'VECTOR' }] },
      { id: '9:9', name: 'txt', type: 'TEXT', characters: 'x' },
      { id: '9:10', name: 'rect', type: 'RECTANGLE' },
    ] };
    const run = harness(depthApi(t));
    const out = await run({ file: 'abc', node_id: '9:0', query: 'needle', depth: 1 });
    expect(out.coverage.depth_cut).toBe(1);                        // only the boolean, not txt/rect
    expect(out.coverage.depth_cut_nodes).toEqual([{ node_id: '9:7', name: 'bool' }]);
  });

  it('a HIDDEN ROOT is ledgered too - findNodes prunes at the root, so zero nodes were searched (wave blocker)', async () => {
    const t: N = { id: '9:0', name: 'archive', type: 'FRAME', visible: false, children: [
      { id: '9:1', name: 'label', type: 'TEXT', characters: 'needle' },
    ] };
    const run = harness(depthApi(t));
    const out = await run({ file: 'abc', node_id: '9:0', query: 'needle', depth: 6 });
    expect(out.total).toBe(0);
    expect(out.coverage.hidden_cut).toBe(1);
    expect(out.coverage.note).toMatch(/NOT proof of absence/);
  });

  it('hidden subtrees are ledgered, not silently unsearched (the false-absence blocker)', async () => {
    const t: N = { id: '9:0', name: 'root', type: 'FRAME', children: [
      { id: '9:11', name: 'error state', type: 'FRAME', visible: false, children: [
        { id: '9:12', name: 'msg', type: 'TEXT', characters: 'needle' },
      ] },
    ] };
    const run = harness(depthApi(t));
    const out = await run({ file: 'abc', node_id: '9:0', query: 'needle', depth: 6 });
    expect(out.total).toBe(0);                                     // findNodes prunes hidden - the node exists
    expect(out.coverage.depth_cut).toBeUndefined();                // the walk does not descend into hidden
    expect(out.coverage.hidden_cut).toBe(1);
    expect(out.coverage.note).toMatch(/hidden subtree/);
    expect(out.coverage.note).toMatch(/NOT proof of absence/);
  });

  it('limit honesty: exactly-limit rows -> limit_reached, one fewer -> absent', async () => {
    const many = (n: number): N => ({ id: '9:0', name: 'root', type: 'FRAME',
      children: Array.from({ length: n }, (_, i) => ({ id: `9:${20 + i}`, name: `card ${i}`, type: 'FRAME' })) });
    const run3 = harness(depthApi(many(3)));
    const capped = await run3({ file: 'abc', node_id: '9:0', query: 'card', depth: 2, limit: 2 });
    expect(capped.coverage.limit_reached).toBe(true);
    const run1 = harness(depthApi(many(1)));
    const free = await run1({ file: 'abc', node_id: '9:0', query: 'card', depth: 2, limit: 2 });
    expect(free.coverage.limit_reached).toBeUndefined();
  });

  it('measure == delivery: the coverage block is inside the clamp measurement', async () => {
    const wide: N = { id: '9:0', name: 'root', type: 'FRAME', children: [
      { id: '9:2', name: 'card holder', type: 'FRAME', children: [
        { id: '9:3', name: 'x', type: 'TEXT', characters: 'y' },
      ] },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `9:${40 + i}`, name: `card item number ${i}`, type: 'FRAME' as const })),
    ] };
    // Discriminating budget: the coverage block (capped cut-node list) costs ~900 chars.
    // If it were NOT inside the clamp measurement, the clamp would keep enough match rows
    // to overshoot 1600; measured correctly, rows are dropped and delivery fits.
    const budget = 1600;
    const { server, call } = makeFakeMcpServer();
    registerFindNodesTool(server, {
      buildApi: () => depthApi(wide) as unknown as FigmaApi,
      defaultToken: 'figd_x', logger, maxResultChars: budget,
    } as ToolDeps);
    const res = await call('find_nodes', { file: 'abc', node_id: '9:0', query: 'card', depth: 1, limit: 50 });
    const text = res.content[0].text as string;
    expect(text.length).toBeLessThanOrEqual(budget);
    const out = JSON.parse(text);
    expect(out.coverage.depth_cut).toBeGreaterThanOrEqual(1);      // the block survived the clamp AND was measured
  });
});

describe('A: file-level accumulation (the weaker receipt must not read as the stronger one)', () => {
  const pageOf = (containers: N[]): N => ({ id: '0:1', name: 'Page 1', type: 'CANVAS', children: containers });
  const docOf = (pages: N[]) => ({ name: 'F', lastModified: 'X', version: '1',
    document: { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: pages } as N });

  it('a container cut below args.depth surfaces as accumulated depth_cut in the existing ledger', async () => {
    const container: N = { id: '1:1', name: 'Home', type: 'FRAME', children: [deepTree] };
    const run = harness({
      getDocumentRaw: vi.fn(async () => docOf([pageOf([sliceDepth(container, 1)])]) as never),
      getNodesRaw: vi.fn(async (_f: string, ids: string[], depth: number) =>
        ({ nodes: { [ids[0]]: { document: sliceDepth(container, depth) } } })),
    });
    const out = await run({ file: 'abc', query: 'needle', depth: 2 });
    expect(out.coverage.searched).toBe(1);
    expect(out.coverage.total).toBe(1);
    expect(out.coverage.depth_cut).toBeGreaterThanOrEqual(1);
    expect(out.coverage.note).toMatch(/NOT proof of absence/);
  });

  it('a HIDDEN top-level container is ledgered at file level (its whole subtree went unsearched)', async () => {
    const container: N = { id: '1:1', name: 'Home', type: 'FRAME', visible: false, children: [
      { id: '1:2', name: 'label', type: 'TEXT', characters: 'needle' },
    ] };
    const run = harness({
      getDocumentRaw: vi.fn(async () => docOf([pageOf([sliceDepth(container, 1)])]) as never),
      getNodesRaw: vi.fn(async (_f: string, ids: string[], depth: number) =>
        ({ nodes: { [ids[0]]: { document: sliceDepth(container, depth) } } })),
    });
    const out = await run({ file: 'abc', query: 'needle', depth: 6 });
    expect(out.total).toBe(0);
    expect(out.coverage.hidden_cut).toBe(1);
    expect(out.coverage.note).toMatch(/NOT proof of absence/);
  });

  it('no cuts anywhere -> the file-level coverage keeps exactly the historical shape', async () => {
    const container: N = { id: '1:1', name: 'Home', type: 'FRAME', children: [
      { id: '1:2', name: 'label', type: 'TEXT', characters: 'needle' },
    ] };
    const run = harness({
      getDocumentRaw: vi.fn(async () => docOf([pageOf([sliceDepth(container, 1)])]) as never),
      getNodesRaw: vi.fn(async (_f: string, ids: string[], depth: number) =>
        ({ nodes: { [ids[0]]: { document: sliceDepth(container, depth) } } })),
    });
    const out = await run({ file: 'abc', query: 'needle', depth: 6 });
    expect(out.coverage).toEqual({ searched: 1, total: 1, skipped: [], skippedTotal: 0 });
  });
});

describe('D: the type-value guard (the live total-0 was a type miss, not a search defect)', () => {
  const canvasTree: N = { id: '9:0', name: 'root', type: 'FRAME', children: [
    { id: '9:1', name: 'shelf', type: 'FRAME' },
  ] };

  it('type PAGE -> type_note naming CANVAS; matching itself is unchanged (total 0)', async () => {
    const run = harness(depthApi(canvasTree));
    const out = await run({ file: 'abc', node_id: '9:0', query: 'shelf', type: 'PAGE', depth: 4 });
    expect(out.total).toBe(0);
    expect(out.type_note).toMatch(/CANVAS/);
    expect(out.type_note).toMatch(/PAGE/);
  });

  it('known types (any case) carry no note', async () => {
    const run = harness(depthApi(canvasTree));
    const upper = await run({ file: 'abc', node_id: '9:0', query: 'shelf', type: 'FRAME', depth: 4 });
    expect(upper.type_note).toBeUndefined();
    const lower = await run({ file: 'abc', node_id: '9:0', query: 'shelf', type: 'frame', depth: 4 });
    expect(lower.type_note).toBeUndefined();
  });

  it('an unknown (possibly future) type gets the hedged note - conditional, never an absolute "can only miss"', async () => {
    const run = harness(depthApi(canvasTree));
    const out = await run({ file: 'abc', node_id: '9:0', query: 'shelf', type: 'FOO', depth: 4 });
    expect(out.type_note).toMatch(/not a known Figma node type/);
    expect(out.type_note).toMatch(/if the type name is wrong/);
    expect(out.type_note).not.toMatch(/can only miss/);
  });

  it('REST-spelled and repo-touched types are known: REGULAR_POLYGON and TABLE_CELL carry no note, POLYGON (a name Figma never emits) does', async () => {
    const run = harness(depthApi(canvasTree));
    expect((await run({ file: 'abc', node_id: '9:0', query: 'shelf', type: 'REGULAR_POLYGON', depth: 4 })).type_note).toBeUndefined();
    expect((await run({ file: 'abc', node_id: '9:0', query: 'shelf', type: 'TABLE_CELL', depth: 4 })).type_note).toBeUndefined();
    expect((await run({ file: 'abc', node_id: '9:0', query: 'shelf', type: 'POLYGON', depth: 4 })).type_note).toMatch(/not a known/);
  });

  it('the file-level branch carries the same note', async () => {
    const run = harness({});
    const out = await run({ file: 'abc', query: 'shelf', type: 'PAGE' });
    expect(out.type_note).toMatch(/CANVAS/);
  });
});
