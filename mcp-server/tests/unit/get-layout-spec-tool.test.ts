import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetLayoutSpecTool } from '../../src/adapters/driving/tools/get-layout-spec-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { FETCH_DEPTH } from '../../src/domain/layout-spec/projector.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
function harness(api: Partial<FigmaApi>, depsOverrides: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000, ...depsOverrides };
  registerGetLayoutSpecTool(server, deps);
  return (a: any): Promise<any> => call('get_layout_spec', a);
}

const doc: RawSceneNode = {
  id: '1:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 800 },
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [{ id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: { x: 16, y: 0, width: 300, height: 24 } }],
};

describe('get_layout_spec tool', () => {
  it('normalizes ids, fetches FETCH_DEPTH in one batch, returns specs', async () => {
    expect(FETCH_DEPTH).toBe(5); // 4→5 (peek headroom): projection stays L4, raw fetch peeks L5
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 5);
    const out = JSON.parse(res.content[0].text);
    expect(out.snapshot_schema).toBe(5);
    expect(out.specs[0].spec.rect.w).toBe(375);
    expect(out.specs[0].spec.children[0].name).toBe('title');
    expect(out.extractor_js).toBeUndefined();
  });

  it('include_extractor returns the canonical script', async () => {
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc } } })) });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
    expect(out.extractor_js).toContain('const SCHEMA = 5;');
  });

  it('include_extractor script slices text at SNIPPET_CAP 120, not the old 40', async () => {
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc } } })) });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
    expect(out.extractor_js).toContain('slice(0, 120)');
    expect(out.extractor_js).not.toContain('slice(0, 40)');
  });

  it('missing node → per-id error, others survive', async () => {
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc }, '9:9': null } })) });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1', '9:9'] })).content[0].text);
    expect(out.specs).toHaveLength(2);
    expect(out.specs[1]).toEqual({ node_id: '9:9', error: 'not found' });
  });

  it('resolves component set names via getComponent + getFileComponentSets (best-effort)', async () => {
    const instanceDoc = { ...doc, id: '2:1', children: [], componentId: '5:1' };
    const getNodesRaw = vi.fn(async () => ({ nodes: { '2:1': {
      document: instanceDoc, components: { '5:1': { key: 'pubkey', name: 'Type=Basic', componentSetId: '4:1' } },
    } } }));
    const getComponent = vi.fn(async () => ({ key: 'pubkey', file_key: 'libfile', node_id: '5:1', name: 'Type=Basic' }));
    const getFileComponentSets = vi.fn(async () => ([{ key: 'sk', file_key: 'libfile', node_id: '4:1', name: 'listItem', description: '' }]));
    const run = harness({ getNodesRaw, getComponent, getFileComponentSets });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['2:1'] })).content[0].text);
    expect(out.specs[0].spec.component).toMatchObject({ name: 'Type=Basic', setName: 'listItem' });
  });

  // MUTATION LOCK on the meta-first path buildSetNames(api, entry, …). The componentSets meta
  // of the /nodes response already carries the set name → setName resolves FROM IT, the REST cascade (getComponent→
  // getFileComponentSets) is NOT called. Fixture: components '5:1' with componentSetId+key (which would make
  // legacy resolveSetNames(api, entry.components) call getComponent), BUT componentSets '4:1' covers the
  // setId via the meta. The mutation "revert to resolveSetNames(api, entry.components, …)" → getComponent('pubkey')
  // called + setName lost → RED on both asserts. Mirror of compare :201.
  it('setName from the componentSets meta → spec.component.setName from the meta, getComponent NOT called (meta-first buildSetNames)', async () => {
    const instanceDoc = { ...doc, id: '2:1', children: [], componentId: '5:1' };
    const getNodesRaw = vi.fn(async () => ({ nodes: { '2:1': {
      document: instanceDoc,
      components: { '5:1': { key: 'pubkey', name: 'Type=Basic', remote: true, componentSetId: '4:1' } },
      componentSets: { '4:1': { key: 'sk1', name: 'listItem', remote: true } },
    } } }));
    const getComponent = vi.fn();
    const run = harness({ getNodesRaw, getComponent });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['2:1'] })).content[0].text);
    expect(out.specs[0].spec.component).toMatchObject({ name: 'Type=Basic', setName: 'listItem' });
    expect(getComponent).not.toHaveBeenCalled(); // meta-resolve: zero /v1/components fetches
  });

  describe('upload_url minting', () => {
    function mockStore(capToken = 'cap-token-abc') {
      return { mint: vi.fn(() => capToken) } as unknown as ToolDeps['snapshotStore'];
    }
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));

    it('include_extractor + snapshotStore + publicBaseUrl → mints upload_url with tenantId, plus upload_hint', async () => {
      const snapshotStore = mockStore('cap-token-abc');
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test', tenantId: 'user-42' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      // (a') mint-meta (viewport-ergonomics T3, a DELIBERATE UPDATE): mint is now two-argument —
      // the fixture `doc` gives rect.w 375, so expectedWidths is non-empty. toHaveBeenCalledWith matches
      // the FULL argument list, so the old single-argument lock would break (RED) without this update.
      expect(snapshotStore!.mint).toHaveBeenCalledWith('user-42', { expectedWidths: [375] });
      expect(out.upload_url).toBe('https://figma.test/api/dom-snapshots/cap-token-abc');
      expect(typeof out.upload_hint).toBe('string');
      expect(out.upload_hint.length).toBeGreaterThan(0);
    });

    it('defaults tenantId to "local" when deps.tenantId is undefined', async () => {
      const snapshotStore = mockStore();
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true });
      expect(snapshotStore!.mint).toHaveBeenCalledWith('local', { expectedWidths: [375] });
    });

    it("(a') mint-meta: expectedWidths = the rounded rect.w of ALL successful nodes, deduped by width, error nodes excluded", async () => {
      const dup = { ...doc, id: '1:3' }; // the same width 375 as doc — should collapse into a single element
      const wideDoc = { ...doc, id: '2:2', absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 800 } };
      const snapshotStore = mockStore('cap-token-multi');
      const getNodesRawMulti = vi.fn(async () => ({ nodes: {
        '1:1': { document: doc }, '1:3': { document: dup }, '2:2': { document: wideDoc }, '9:9': null,
      } }));
      const run = harness({ getNodesRaw: getNodesRawMulti }, { snapshotStore, publicBaseUrl: 'https://figma.test', tenantId: 'user-42' });
      await run({ file: 'abc', node_ids: ['1:1', '1:3', '2:2', '9:9'], include_extractor: true });
      expect(snapshotStore!.mint).toHaveBeenCalledWith('user-42', { expectedWidths: [375, 1920] });
    });

    it("(a') no successful nodes (all error) → mint is called WITHOUT meta (undefined, not {expectedWidths:[]})", async () => {
      const snapshotStore = mockStore('cap-token-empty');
      const getNodesRawNone = vi.fn(async () => ({ nodes: { '9:9': null } }));
      const run = harness({ getNodesRaw: getNodesRawNone }, { snapshotStore, publicBaseUrl: 'https://figma.test', tenantId: 'user-42' });
      await run({ file: 'abc', node_ids: ['9:9'], include_extractor: true });
      expect(snapshotStore!.mint).toHaveBeenCalledWith('user-42', undefined);
    });

    it('without include_extractor → no upload_url even with store+baseUrl', async () => {
      const snapshotStore = mockStore();
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: false })).content[0].text);
      expect(out.upload_url).toBeUndefined();
      expect(out.upload_hint).toBeUndefined();
      expect(snapshotStore!.mint).not.toHaveBeenCalled();
    });

    it('without publicBaseUrl → no upload_url even with include_extractor + store', async () => {
      const snapshotStore = mockStore();
      const run = harness({ getNodesRaw }, { snapshotStore });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.upload_url).toBeUndefined();
      expect(out.upload_hint).toBeUndefined();
      expect(snapshotStore!.mint).not.toHaveBeenCalled();
    });

    it('without snapshotStore → no upload_url even with include_extractor + publicBaseUrl', async () => {
      const run = harness({ getNodesRaw }, { publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.upload_url).toBeUndefined();
      expect(out.upload_hint).toBeUndefined();
    });
  });

  describe('extractor_mode (loader/inline)', () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));

    it('default mode (loader) + publicBaseUrl → thunk pointing at /api/dom-snapshots/extractor.js, not the full script', async () => {
      const run = harness({ getNodesRaw }, { publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.extractor_js).toContain('__figmaDomDiff');
      expect(out.extractor_js).toContain('/api/dom-snapshots/extractor.js');
      expect(out.extractor_js).not.toContain('pruneToBudget');
      expect(out.extractor_note).toBeUndefined();
    });

    it('extractor_mode: "inline" → full canonical script even when publicBaseUrl is set', async () => {
      const run = harness({ getNodesRaw }, { publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true, extractor_mode: 'inline' })).content[0].text);
      expect(out.extractor_js).toContain('pruneToBudget');
      expect(out.extractor_note).toBeUndefined();
    });

    it('loader mode without publicBaseUrl → falls back to the full script + an honest extractor_note', async () => {
      const run = harness({ getNodesRaw }); // no publicBaseUrl
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.extractor_js).toContain('pruneToBudget');
      expect(out.extractor_note).toBe('loader unavailable without public base URL — inline returned');
    });
  });

  describe('max_depth (drill-down)', () => {
    it('default (no max_depth) still fetches FETCH_DEPTH (5) — backward-compat', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false });
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 5);
    });

    it('max_depth:6 fetches max_depth+1 = 7', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false, max_depth: 6 });
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 7);
    });

    it('without max_depth: output is byte-for-byte the same as explicit max_depth:4 (backward-compat)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      const withoutField = JSON.parse((await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false })).content[0].text);
      const withDefault = JSON.parse((await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false, max_depth: 4 })).content[0].text);
      expect(withDefault).toEqual(withoutField);
    });

    it('upload_hint shows the 4-arg extractor call (depthLeft, budget) when max_depth is given', async () => {
      const snapshotStore = { mint: vi.fn(() => 'cap-token') } as unknown as ToolDeps['snapshotStore'];
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true, max_depth: 6 })).content[0].text);
      expect(out.upload_hint).toContain('"<upload_url>", 5, 180');
    });

    it('upload_hint stays the prior 2-arg call when max_depth is absent (backward-compat)', async () => {
      const snapshotStore = { mint: vi.fn(() => 'cap-token') } as unknown as ToolDeps['snapshotStore'];
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.upload_hint).toContain('"<upload_url>"); }');
      expect(out.upload_hint).not.toMatch(/"<upload_url>",\s*\d/);
    });
  });

  describe('result budget clamp (design-QA payload)', () => {
    it('honest-clamps the aggregate result and lists omitted node_ids', async () => {
      // Build a node whose projected spec is large, requested many times so the aggregate
      // blows the 1MB budget. SIZE DRIVER IS `name` ONLY — the projector caps children at
      // MAX_SPEC_CHILDREN=30 (so 40 → 30 survive) and slices textSnippet to 40 chars, so
      // `characters` does NOT contribute to serialized size. Verified: name repeat=600 →
      // aggregate ~1.9MB (×1.83 over 1MB) → clamp keeps ~11, omits ~9. (repeat≤320 is vacuous:
      // aggregate < 1MB, clamp keeps all, result_truncated never set → the test would false-green.)
      const big: RawSceneNode = { id: 'n', name: 'n', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 9, height: 9 },
        children: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: 'Item '.repeat(600) + i, type: 'TEXT',
          absoluteBoundingBox: { x: 0, y: i, width: 9, height: 1 }, characters: 'text '.repeat(80),
          style: { fontFamily: 'Inter', fontSize: 12 } })) };
      const ids = Array.from({ length: 20 }, (_, i) => `${i}:1`);
      const nodes: Record<string, { document: RawSceneNode }> = {};
      for (const id of ids) nodes[id] = { document: { ...big, id } };
      const getNodesRaw = vi.fn(async () => ({ nodes }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ids })).content[0].text);
      expect(out.result_truncated).toBe(true);
      expect(out.omitted_node_ids.length).toBeGreaterThan(0);
      expect(out.specs.length).toBeLessThan(ids.length);
      // kept ++ omitted == all requested, contiguous
      expect(out.specs.map((s: any) => s.node_id).concat(out.omitted_node_ids)).toEqual(ids);
    });

    it('does NOT flag when the result fits (default small call unchanged)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: { id: '1:1', name: 'f', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } } } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
      expect(out.result_truncated).toBeUndefined();
      expect(out.specs).toHaveLength(1);
    });
  });

  describe('🅰️-2: text_leaves', () => {
    // card→list→item→label(TEXT '1:4'), label at L4 (reachable at max_depth:6, cut at max_depth:2)
    const deep = {
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
      layoutMode: 'VERTICAL',
      children: [
        { id: '1:2', name: 'list', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 }, layoutMode: 'VERTICAL',
          children: [
            { id: '1:3', name: 'item', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 }, layoutMode: 'VERTICAL',
              children: [
                { id: '1:4', name: 'label', type: 'TEXT', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
                  characters: 'Настройки', style: { fontFamily: 'Inter', fontWeight: 450, fontSize: 14 } },
              ] },
          ] },
      ],
    } as any;
    it('text_leaves:true — spec REPLACED by text_leaves, spec absent', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: deep } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], text_leaves: true, max_depth: 6 })).content[0].text);
      expect(out.specs[0].spec).toBeUndefined();
      expect(out.specs[0].text_leaves.some((l: any) => l.id === '1:4')).toBe(true);
      expect(out.specs[0].text_leaves_truncated).toBeUndefined();
    });
    it('depth mirror: max_depth:2 → leaf absent + text_leaves_truncated', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: deep } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], text_leaves: true, max_depth: 2 })).content[0].text);
      expect(out.specs[0].text_leaves_truncated).toBe(true);
    });
    it('backward-compat: without the flag — spec as before, text_leaves absent', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: deep } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
      expect(out.specs[0].spec).toBeDefined();
      expect(out.specs[0].text_leaves).toBeUndefined();
    });
  });
});

describe('get_layout_spec hydration receipt (Phase 1)', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
  const chain = (levels: number): any => {
    const mk = (id: string, kids?: any[]): any =>
      ({ id, name: id, type: 'FRAME', absoluteBoundingBox: box(0, 0, 40, 8), ...(kids ? { children: kids } : {}) });
    let cur = mk('L' + levels);
    for (let i = levels - 1; i >= 1; i -= 1) cur = mk('L' + i, [cur]);
    return { id: 'dd:0', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL', absoluteBoundingBox: box(0, 0, 300, 100), children: [cur] };
  };

  it('emits a per-node hydration receipt; a cold depth cut is an honest hedge, not backed', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { 'dd:0': { document: chain(6) } } }));
    // self-contained harness (McpServer, registerGetLayoutSpecTool, logger, FigmaApi are already
    // imported at the top of this test file); wrap the api with withFrameRaw so the tool's
    // getFrameRaw call resolves through the getNodesRaw mock:
    const { server, call } = makeFakeMcpServer();
    registerGetLayoutSpecTool(server, { buildApi: () => withFrameRaw({ getNodesRaw }) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 } as any);
    const run = (a: any): Promise<any> => call('get_layout_spec', a);
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['dd:0'], max_depth: 4 })).content[0].text);
    expect(Array.isArray(out.hydration)).toBe(true);
    const rec = out.hydration.find((h: any) => h.node_id === 'dd:0');
    expect(rec.cause_breakdown.depth).toBeGreaterThan(0);
    expect(rec.hydrated).toBe(false); // withFrameRaw passthrough → not held
    expect(rec.note).not.toMatch(/already held|уже держ/i);
  });
});
