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
const shelfComponent = { id: 'comp:1', name: 'scroll shelf', type: 'COMPONENT', absoluteBoundingBox: bb(1920, 86),
  children: [] };
const subSection = { id: 'sub:1', name: 'Adaptiv', type: 'SECTION', children: [shelfComponent] };
const promoSection = { id: 'sec:1', name: 'Promo', type: 'SECTION', children: [subSection] };
const page = (children: any[]) => ({ id: 'p:1', name: 'Page 1', type: 'CANVAS', children });
const doc = (children: any[]) => ({ id: '0:0', name: 'Document', type: 'DOCUMENT', children: [page(children)] });

describe('reach: the live-repro shape', () => {
  it('finds a name-matched COMPONENT at document depth 4 (canvas > section > sub-section > component)', async () => {
    const run = harness(depthApi(doc([promoSection])));
    const out = await run({ file: 'abc', query: 'scroll shelf', render_width: 1920 });
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
    const set = { id: 'set:1', name: 'scroll shelf', type: 'COMPONENT_SET', absoluteBoundingBox: bb(2300),
      children: [
        { id: 'var:d', name: 'Breakpoint=Desktop', type: 'COMPONENT', absoluteBoundingBox: bb(1920, 86), children: [] },
        { id: 'var:m', name: 'Breakpoint=Mobile', type: 'COMPONENT', absoluteBoundingBox: bb(360, 64), children: [] },
      ] };
    const run = harness(depthApi(doc([{ id: 'sec:2', name: 'Components', type: 'SECTION', children: [set] }])));
    const out = await run({ file: 'abc', query: 'scroll shelf', render_width: 360 });
    expect(out.variants.map((v: any) => v.node_id)).toContain('set:1');
    expect(out.match?.node_id).toBe('var:m');
  });
});

describe('ranking before the cap (panel findings 1/12/19)', () => {
  it('a deep NAME-match survives 12 shallow container-only matches instead of being sliced off', async () => {
    const bait = { id: 'bait:1', name: 'scroll shelf zone', type: 'SECTION',
      children: Array.from({ length: 12 }, (_, i) => frame(`b:${i}`, `banner ${i}`, 1280)) };
    const run = harness(depthApi(doc([bait, promoSection])));
    const out = await run({ file: 'abc', query: 'scroll shelf', render_width: 1920 });
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
    const out = await run({ file: 'abc', query: 'scroll shelf', render_width: 1920 });
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
    const out = await run({ file: 'abc', query: 'scroll shelf', render_width: 1920, parent_node_id: 'anc:1' });
    expect(out.variants.map((v: any) => v.node_id)).toContain('comp:1');
    expect(out.coverage.total).toBe(1);
  });
});
