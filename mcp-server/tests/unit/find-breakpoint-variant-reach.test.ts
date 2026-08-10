// Reach + honest emptiness for find_breakpoint_variant (feedback item 10). The live defect:
// a COMPONENT whose name matches the query byte-for-byte sits at document depth 4 (canvas >
// SECTION > sub-SECTION > component) and the depth-3 whole-document walk cannot see it, while
// the empty answer asserts "no FRAME/COMPONENT matched" with no coverage marker - the
// confident-absence-over-partial-scan class find_nodes was already taught to avoid.
// v2 (panel-locked): the find_nodes architecture verbatim - depth-2 skeleton, ONE deep fetch
// per top-level container under a deadline with per-container error containment, the exact
// find_nodes ledger vocabulary, name-matches ranked above container-only matches BEFORE the
// MAX_VARIANTS cap, and COMPONENT_SET as a first-class candidate.
import { describe, it, expect, vi } from 'vitest';
import { registerFindBreakpointVariantTool } from '../../src/adapters/driving/tools/find-breakpoint-variant-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function harness(api: Partial<FigmaApi>, extra: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => api as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000, ...extra };
  registerFindBreakpointVariantTool(server, deps);
  return async (a: Record<string, unknown>): Promise<any> => {
    const res = await call('find_breakpoint_variant', a);
    return res.isError ? { isError: true, text: String(res.content[0]?.text ?? '') } : JSON.parse(String(res.content[0]?.text));
  };
}

// A fake api that HONORS depth - the old suite's fake returned full trees regardless, which is
// exactly how the depth cliff stayed invisible to the tests.
const slice = (node: any, depth: number): any =>
  depth <= 0
    ? { ...node, children: undefined }
    : { ...node, children: (node.children ?? []).map((c: any) => slice(c, depth - 1)) };

function depthApi(documentRoot: any) {
  const index: Record<string, any> = {};
  const walk = (n: any): void => { index[n.id] = n; (n.children ?? []).forEach(walk); };
  walk(documentRoot);
  const getDocumentRaw = vi.fn(async (_f: string, depth: number) => ({
    name: 'F', lastModified: 'X', version: '1', document: slice(documentRoot, depth),
  }));
  const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number) => ({
    nodes: Object.fromEntries(ids.map((id) => [id, index[id] ? { document: slice(index[id], depth ?? 99) } : null])),
  }));
  return { getDocumentRaw, getNodesRaw };
}

const bb = (w: number, h = 900) => ({ x: 0, y: 0, width: w, height: h });
const frame = (id: string, name: string, w: number, children: any[] = []) =>
  ({ id, name, type: 'FRAME', absoluteBoundingBox: bb(w), children });

// THE live-repro shape: the component sits under a SUB-section, document depth 4.
const shelfComponent = { id: 'comp:1', name: 'promo rail', type: 'COMPONENT', absoluteBoundingBox: bb(1920, 86),
  children: [] };
const subSection = { id: 'sub:1', name: 'Adaptiv', type: 'SECTION', children: [shelfComponent] };
const promoSection = { id: 'sec:1', name: 'Promo', type: 'SECTION', children: [subSection] };
const page = (children: any[]) => ({ id: 'p:1', name: 'Page 1', type: 'CANVAS', children });
const doc = (children: any[]) => ({ id: '0:0', name: 'Document', type: 'DOCUMENT', children: [page(children)] });

describe('reach: the live-repro shape', () => {
  it('finds a name-matched COMPONENT at document depth 4 (canvas > section > sub-section > component)', async () => {
    const run = harness(depthApi(doc([promoSection])));
    const out = await run({ file: 'abc', query: 'promo rail', render_width: 1920 });
    expect(out.variants.map((v: any) => v.node_id)).toContain('comp:1');
    expect(out.match).not.toBeNull();
  });
  it('the depth-honoring fake proves the OLD walk could not see it (skeleton alone has no component)', async () => {
    const api = depthApi(doc([promoSection]));
    const skeleton = (await api.getDocumentRaw('abc', 3)).document;
    const flat: string[] = [];
    const walk = (n: any): void => { flat.push(n.id); (n.children ?? []).forEach(walk); };
    walk(skeleton);
    expect(flat).not.toContain('comp:1');
  });
});

describe('COMPONENT_SET as a candidate (panel finding 5)', () => {
  it('a set whose NAME matches yields its variant COMPONENT children as ranked content', async () => {
    const set = { id: 'set:1', name: 'promo rail', type: 'COMPONENT_SET', absoluteBoundingBox: bb(2300),
      children: [
        { id: 'var:d', name: 'Breakpoint=Desktop', type: 'COMPONENT', absoluteBoundingBox: bb(1920, 86), children: [] },
        { id: 'var:m', name: 'Breakpoint=Mobile', type: 'COMPONENT', absoluteBoundingBox: bb(360, 64), children: [] },
      ] };
    const run = harness(depthApi(doc([{ id: 'sec:2', name: 'Components', type: 'SECTION', children: [set] }])));
    const out = await run({ file: 'abc', query: 'promo rail', render_width: 360 });
    expect(out.variants.map((v: any) => v.node_id)).toContain('set:1');
    expect(out.match?.node_id).toBe('var:m');
  });
});

describe('ranking before the cap (panel findings 1/12/19)', () => {
  it('a deep NAME-match survives 12 shallow container-only matches instead of being sliced off', async () => {
    const bait = { id: 'bait:1', name: 'promo rail zone', type: 'SECTION',
      children: Array.from({ length: 12 }, (_, i) => frame(`b:${i}`, `banner ${i}`, 1280)) };
    const run = harness(depthApi(doc([bait, promoSection])));
    const out = await run({ file: 'abc', query: 'promo rail', render_width: 1920 });
    expect(out.variants.length).toBeLessThanOrEqual(10);
    expect(out.variants.map((v: any) => v.node_id)).toContain('comp:1');
  });
});

describe('the coverage ledger (find_nodes vocabulary, panel findings 6/15/16/23)', () => {
  it('deadline expiry -> partial ledger: searched < total, the rest named in skipped, call succeeds', async () => {
    const sections = Array.from({ length: 5 }, (_, i) =>
      ({ id: `s:${i}`, name: `Section ${i}`, type: 'SECTION', children: [frame(`f:${i}`, `inner ${i}`, 100)] }));
    const run = harness(depthApi(doc(sections)), { toolTimeBudgetMs: 0 });
    const out = await run({ file: 'abc', query: 'nothing-matches-this', render_width: 360 });
    expect(out.coverage.total).toBe(5);
    expect(out.coverage.searched).toBeLessThan(5);
    expect(out.coverage.skippedTotal).toBeGreaterThan(0);
    expect(out.note).toMatch(/[Ss]earched \d+ of 5/);
  });
  it('429 on the second container -> loop stops, first results kept, call SUCCEEDS with the rest skipped', async () => {
    const sections = Array.from({ length: 4 }, (_, i) =>
      ({ id: `s:${i}`, name: `Zone ${i}`, type: 'SECTION', children: [frame(`f:${i}`, `shelf ${i}`, 360)] }));
    const api = depthApi(doc(sections));
    let calls = 0;
    const orig = api.getNodesRaw.getMockImplementation()!;
    api.getNodesRaw.mockImplementation(async (f: string, ids: string[], depth?: number) => {
      calls += 1;
      if (calls === 2) throw new FigmaApiError('rate_limited', 429, 'too fast');
      return orig(f, ids, depth);
    });
    const run = harness(api);
    const out = await run({ file: 'abc', query: 'shelf', render_width: 360 });
    expect(out.isError).toBeUndefined();
    expect(out.variants.map((v: any) => v.node_id)).toContain('f:0');
    expect(out.coverage.searched).toBe(1);
    expect(out.coverage.skippedTotal).toBe(3);
  });
  it('auth error fails the WHOLE call (a dead token must not produce a quiet partial)', async () => {
    const api = depthApi(doc([promoSection]));
    api.getNodesRaw.mockRejectedValue(new FigmaApiError('auth', 401, 'token dead'));
    const run = harness(api);
    const out = await run({ file: 'abc', query: 'promo rail', render_width: 1920 });
    expect(out.isError).toBe(true);
  });
  it('full coverage -> the empty answer keeps a strong absence claim (no searched-slice hedge)', async () => {
    const run = harness(depthApi(doc([promoSection])));
    const out = await run({ file: 'abc', query: 'zzz-no-such-variant', render_width: 360 });
    expect(out.variants).toEqual([]);
    expect(out.coverage.searched).toBe(out.coverage.total);
    expect(out.note ?? '').not.toMatch(/searched slice/i);
  });
  it('nodes AT the per-container depth boundary are counted as depth_cut and reach the note', async () => {
    // container(0) > l1 > l2 > l3(boundary, has children beyond) - the walk is cut BY
    // CONSTRUCTION at the per-container depth; the residual must be counted, not silent.
    const deep = { id: 'd:0', name: 'Deep', type: 'SECTION', children: [
      { id: 'd:1', name: 'L1', type: 'SECTION', children: [
        { id: 'd:2', name: 'L2', type: 'SECTION', children: [
          { id: 'd:3', name: 'L3', type: 'SECTION', children: [frame('d:4', 'buried', 360)] },
        ] },
      ] },
    ] };
    const run = harness(depthApi(doc([deep])));
    const out = await run({ file: 'abc', query: 'buried', render_width: 360 });
    expect(out.variants).toEqual([]);
    expect(out.coverage.depth_cut).toBeGreaterThan(0);
    expect(out.note ?? '').toMatch(/depth/i);
  });
  it('a non-empty answer over a partial scan carries the hedge in the NOTE, not only a sibling key', async () => {
    const sections = [
      { id: 's:0', name: 'Zone 0', type: 'SECTION', children: [frame('f:0', 'shelf here', 360)] },
      ...Array.from({ length: 3 }, (_, i) =>
        ({ id: `sx:${i}`, name: `Later ${i}`, type: 'SECTION', children: [frame(`fx:${i}`, `later ${i}`, 100)] })),
    ];
    const api = depthApi(doc(sections));
    let calls = 0;
    const orig = api.getNodesRaw.getMockImplementation()!;
    api.getNodesRaw.mockImplementation(async (f: string, ids: string[], depth?: number) => {
      calls += 1;
      if (calls > 1) throw new FigmaApiError('rate_limited', 429, 'stop');
      return orig(f, ids, depth);
    });
    const run = harness(api);
    const out = await run({ file: 'abc', query: 'shelf', render_width: 360 });
    expect(out.variants.length).toBeGreaterThan(0);
    expect(out.note ?? '').toMatch(/unsearched|of 4/i);
  });
});

describe('parent_node_id path (panel finding 21)', () => {
  it('the anchored population is the node\'s DIRECT children, and a deep component under it is found', async () => {
    const anchor = { id: 'anc:1', name: 'Anchor', type: 'SECTION', children: [promoSection] };
    const run = harness(depthApi(doc([anchor])));
    const out = await run({ file: 'abc', query: 'promo rail', render_width: 1920, parent_node_id: 'anc:1' });
    expect(out.variants.map((v: any) => v.node_id)).toContain('comp:1');
    expect(out.coverage.total).toBe(1);
  });
});

// Wave-confirmed locks (14 CONFIRMED / 0 unclear over the first cut of this branch).
describe('wave locks', () => {
  it('a COMPONENT at the walk boundary counts as depth_cut - the strong absence claim must not fire over its unfetched subtree', async () => {
    const deepComp = { id: 'w:0', name: 'Zone', type: 'SECTION', children: [
      frame('w:1', 'l1', 500, [frame('w:2', 'l2', 500, [
        { id: 'w:3', name: 'Card', type: 'COMPONENT', absoluteBoundingBox: bb(500), children: [frame('w:4', 'promo rail', 1920)] },
      ])]),
    ] };
    const run = harness(depthApi(doc([deepComp])));
    const out = await run({ file: 'abc', query: 'promo rail', render_width: 1920 });
    expect(out.variants).toEqual([]);
    expect(out.coverage.depth_cut).toBeGreaterThan(0);
    expect(out.note).not.toMatch(/every container within reach was searched/);
  });
  it('no name-match early stop: 12 skeleton-level name matches do not abort the deep walk', async () => {
    const pageFrames = Array.from({ length: 12 }, (_, i) => frame(`pf:${i}`, `promo rail promo ${i}`, 1000));
    const run = harness(depthApi(doc([...pageFrames, promoSection])));
    const out = await run({ file: 'abc', query: 'promo rail', render_width: 1920 });
    // the deep walk ran despite 12 skeleton-banked name matches: the section was deep-fetched
    // (page-level frames are legitimately part of the container population too - they can hold
    // deeper candidates - so total counts them all)
    expect(out.coverage.searched).toBe(out.coverage.total);
    expect(out.variants.length).toBeLessThanOrEqual(10);
  });
  it('leaf TEXT/VECTOR page children are not containers: no fetch spent, no denominator inflation', async () => {
    const leaves = [
      { id: 't:1', name: 'loose text', type: 'TEXT', absoluteBoundingBox: bb(100), children: [] },
      { id: 'v:1', name: 'vector', type: 'VECTOR', absoluteBoundingBox: bb(50), children: [] },
    ];
    const api = depthApi(doc([...leaves, promoSection]));
    const run = harness(api);
    const out = await run({ file: 'abc', query: 'promo rail', render_width: 1920 });
    expect(out.coverage.total).toBe(1);
    const fetchedIds = api.getNodesRaw.mock.calls.map((c: any[]) => c[1][0]);
    expect(fetchedIds).not.toContain('t:1');
    expect(fetchedIds).not.toContain('v:1');
  });
  it('a COMPONENT child inside an ordinary FRAME variant does not enter the width race (unchanged files keep their match)', async () => {
    const variant = { id: 'vf:1', name: 'shelf desktop', type: 'FRAME', absoluteBoundingBox: bb(1280), children: [
      { id: 'ic:1', name: 'icon', type: 'COMPONENT', absoluteBoundingBox: bb(360, 24), children: [] },
      frame('ct:1', 'content', 1180),
    ] };
    const run = harness(depthApi(doc([{ id: 'zs:1', name: 'Shelves', type: 'SECTION', children: [variant] }])));
    const out = await run({ file: 'abc', query: 'shelf', render_width: 360 });
    const v = out.variants.find((x: any) => x.node_id === 'vf:1');
    expect(v.content.map((c: any) => c.node_id)).not.toContain('ic:1');
    expect(out.match?.node_id).not.toBe('ic:1');
  });
  it('skipped entries carry node_id beside name - the drill advice is actionable', async () => {
    const sections = Array.from({ length: 3 }, (_, i) =>
      ({ id: `sk:${i}`, name: `Area ${i}`, type: 'SECTION', children: [frame(`fk:${i}`, `inner ${i}`, 100)] }));
    const run = harness(depthApi(doc(sections)), { toolTimeBudgetMs: 0 });
    const out = await run({ file: 'abc', query: 'zzz', render_width: 360 });
    expect(out.coverage.skipped.length).toBeGreaterThan(0);
    expect(out.coverage.skipped[0]).toHaveProperty('node_id');
    expect(out.coverage.skipped[0]).toHaveProperty('name');
  });
  it('anchored path: ONE scoped fetch at depth 4, anchor name is the container context even for a FRAME anchor', async () => {
    const anchorFrame = { id: 'af:1', name: 'shelf zone', type: 'FRAME', absoluteBoundingBox: bb(1920), children: [
      frame('in:1', 'plain card', 360),
    ] };
    const api = depthApi(doc([anchorFrame]));
    const run = harness(api);
    const out = await run({ file: 'abc', query: 'shelf zone', render_width: 1920, parent_node_id: 'af:1' });
    // one anchored fetch (plus content) - not 1+N
    const walkCalls = api.getNodesRaw.mock.calls.filter((c: any[]) => c[1][0] === 'af:1' && c[2] === 4);
    expect(walkCalls).toHaveLength(1);
    // the FRAME anchor matches by its OWN name and stops at itself (matched-variant early stop)
    expect(out.variants.map((v: any) => v.node_id)).toEqual(['af:1']);
    expect(out.coverage).toMatchObject({ searched: 1, total: 1 });
  });
  it('content fetch is SKIPPED after a rate-limited walk (no hammering), widths from the walk slice', async () => {
    const sections = Array.from({ length: 3 }, (_, i) =>
      ({ id: `rl:${i}`, name: `Zone ${i}`, type: 'SECTION', children: [frame(`rf:${i}`, `shelf ${i}`, 360)] }));
    const api = depthApi(doc(sections));
    let calls = 0;
    const orig = api.getNodesRaw.getMockImplementation()!;
    api.getNodesRaw.mockImplementation(async (f: string, ids: string[], depth?: number) => {
      calls += 1;
      if (calls === 2) throw new FigmaApiError('rate_limited', 429, 'stop');
      return orig(f, ids, depth);
    });
    const run = harness(api);
    const out = await run({ file: 'abc', query: 'shelf', render_width: 360 });
    expect(out.isError).toBeUndefined();
    expect(out.note).toMatch(/rate-limited during the walk/);
    // exactly 2 getNodesRaw calls: container 0 (ok) + container 1 (429) - NO content fetch after
    expect(api.getNodesRaw.mock.calls.length).toBe(2);
  });
  it('the container loop uses the sub-capped client (a slow container cannot eat the whole budget)', async () => {
    const timeouts: (number | undefined)[] = [];
    const api = depthApi(doc([promoSection]));
    const { server, call } = await import('../helpers/fake-mcp-server.js').then((m) => m.makeFakeMcpServer());
    const deps: ToolDeps = {
      buildApi: (_t: string, timeoutMs?: number) => { timeouts.push(timeoutMs); return api as unknown as FigmaApi; },
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
    };
    registerFindBreakpointVariantTool(server, deps);
    await call('find_breakpoint_variant', { file: 'abc', query: 'promo rail', render_width: 1920 });
    expect(timeouts).toContain(20_000);
  });
});
