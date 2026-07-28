// mcp-server/tests/unit/depth-mirrors.test.ts
// Projector drill-down symmetry: a regression lock on the invariant "the depth
// mirrors move TOGETHER" — a learned lesson (a desync between the REST fetch, the Figma projection and
// the emitted DOM extractor is invisible to the unit suite piece by piece: each mirror on its own
// passes its local tests, but a trio "fetch X / projection Y / extractor Z" with X≠Y+1 or Z≠Y-1
// silently breaks drill-down in prod — the snapshot either doesn't reach here honestly truncated, or is
// projected shallower than the caller asked). This file does NOT mutate prod logic: it pins
// PROPERTIES (not the concrete numbers of one module) that break if an edit unsettled one
// node of the registry independently of the others.
//
// Registry of mirrors:
//   - depth from max_depth D: fetch=D+1, the projection reaches D (depthLeft=D-1), extractor emitted
//     depthLeft=D-1, footer=D.
//   - budgetFor(d) = min(300, 90*ceil(d/4)) → 4→90, 5-8→180.
//   - descentFor(d) = min(60, 15*ceil(d/4)) → 4→15, 5-8→30.
import { describe, it, expect, vi } from 'vitest';
import { registerGetLayoutSpecTool } from '../../src/adapters/driving/tools/get-layout-spec-tool.js';
import { registerCompareNodeToDomTool } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { SpecChild } from '../../src/domain/layout-spec/types.js';
import { budgetFor, FETCH_DEPTH, MAX_TOTAL_NODES } from '../../src/domain/layout-spec/projector.js';
import { descentFor, MAX_TEXT_DESCENT } from '../../src/domain/layout-spec/diff.js';
import { MAX_SPEC_CHILDREN, MAX_NESTED_CHILDREN } from '../../src/domain/layout-spec/projector.js';
import { EXTRACTOR_JS } from '../../src/adapters/driving/tools/dom-extractor.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
function harness(api: Partial<FigmaApi>, depsOverrides: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000, ...depsOverrides };
  registerGetLayoutSpecTool(server, deps);
  return (a: any): Promise<any> => call('get_layout_spec', a);
}
function compareHarness(api: Partial<FigmaApi>, depsOverrides: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000, ...depsOverrides };
  registerCompareNodeToDomTool(server, deps);
  return (a: any): Promise<any> => call('compare_node_to_dom', a);
}

const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
const child = (id: string, name: string, x: number, y: number, w = 20, h = 20, extra: Partial<RawSceneNode> = {}): RawSceneNode =>
  ({ id, name, type: 'FRAME', absoluteBoundingBox: box(x, y, w, h), ...extra } as RawSceneNode);

// Single-child chain L1→L2→…→L(levels): built deep enough (levels > any D under test) that
// projecting to D ALWAYS leaves real in-flow content below the cut — the terminal node must
// honestly flag childrenTruncated, not just happen to have no more children to find.
const buildChain = (levels: number): RawSceneNode => {
  let node = child(`dd:${levels}`, `l${levels}`, 0, 0, 40, 8);
  for (let i = levels - 1; i >= 1; i -= 1) node = child(`dd:${i}`, `l${i}`, 0, 0, 40, 8, { children: [node] });
  return node;
};
const rootWith = (levels: number): RawSceneNode => ({
  id: 'dd:0', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
  absoluteBoundingBox: box(0, 0, 300, 100), children: [buildChain(levels)],
} as RawSceneNode);
// spec.children[0] is L1; k-1 further .children[0] hops reach L_k.
const nthLevel = (spec: { children: SpecChild[] }, k: number): SpecChild | undefined => {
  let cur: SpecChild | undefined = spec.children[0];
  for (let i = 1; i < k; i += 1) cur = cur?.children?.[0];
  return cur;
};

describe('depth-mirror synchronization (drill-down regression lock)', () => {
  describe('registry constants — each formula/constant checked against its OWN literal, not a sibling formula (avoids self-referential masking)', () => {
    it('FETCH_DEPTH === projection reach (default maxDepth 4) + 1 peek headroom', () => {
      expect(FETCH_DEPTH).toBe(5);
    });

    it('budgetFor(4) === 90 === historical MAX_TOTAL_NODES', () => {
      expect(budgetFor(4)).toBe(90);
      expect(budgetFor(4)).toBe(MAX_TOTAL_NODES);
    });

    it('descentFor(4) === 15 === historical MAX_TEXT_DESCENT', () => {
      expect(descentFor(4)).toBe(15);
      expect(descentFor(4)).toBe(MAX_TEXT_DESCENT);
    });

    it('budgetFor/descentFor sibling formulas agree at 5-8 (180/30) — literal, not cross-derived', () => {
      for (const d of [5, 6, 7, 8]) {
        expect(budgetFor(d)).toBe(180);
        expect(descentFor(d)).toBe(30);
      }
    });
  });

  // Literal expected budget per D — deliberately NOT computed by calling budgetFor(D) inside the
  // assertion (that would let a mutated budgetFor mask itself: SUT and expectation would agree by
  // construction). This table is the independent oracle.
  const EXPECTED_BUDGET: Record<number, number> = { 4: 90, 6: 180, 8: 180 };

  describe.each([4, 6, 8])('D=%i: fetch / projection / extractor-emit hint move together for the SAME max_depth', (D) => {
    it(`fetches D+1=${D + 1}; projects to D (L${D - 1} has children, L${D} terminal+honestly truncated); upload_hint carries depthLeft=${D - 1} and budget=${EXPECTED_BUDGET[D]}`, async () => {
      const raw = rootWith(D + 3); // real content survives well past the D-cut for every D under test
      const getNodesRaw = vi.fn(async () => ({ nodes: { 'dd:0': { document: raw } } }));
      const snapshotStore = { mint: vi.fn(() => 'cap-token') } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });

      const out = JSON.parse((await run({
        file: 'abc', node_ids: ['dd:0'], include_extractor: true, max_depth: D,
      })).content[0].text);

      // Mirror 1 (REST fetch peek): D+1, not D and not D+2.
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['dd:0'], D + 1);

      // Mirror 2 (Figma-side projection reach): L(D-1) still has .children, L(D) is terminal but
      // honestly flags childrenTruncated (real content exists below — a desynced/shallower
      // projection would either stop before D-1 or fail to flag truncation here).
      const spec = out.specs[0].spec;
      const lastWithChildren = nthLevel(spec, D - 1);
      expect(lastWithChildren?.children).toBeDefined();
      const terminal = nthLevel(spec, D);
      expect(terminal?.children).toBeUndefined();
      expect(terminal?.childrenTruncated).toBe(true);
      // one level further must NOT be reachable at all (projection didn't silently go deeper than D)
      const oneBeyond = nthLevel(spec, D + 1);
      expect(oneBeyond).toBeUndefined();

      // Mirror 3 (extractor-emit hint, pasted VERBATIM by the caller): depthLeft=D-1, budget from
      // the independent literal table above — a tool-side desync (e.g. forgetting to bump
      // depthArgsSuffix's `maxDepth - 1` or its budgetFor call) shows up here even though Mirrors
      // 1/2 could still be individually correct.
      expect(out.upload_hint).toContain(`"<upload_url>", ${D - 1}, ${EXPECTED_BUDGET[D]}`);
    });
  });
});

// --- compare_node_to_dom mirrors (fetch=D+1, footer=D) -------------------------------------------
// compare_node_to_dom's projection/descent mirrors (buildLayoutSpec({ maxDepth }), diffPair's
// descentFor(maxDepth)) are direct pass-throughs of the SAME maxDepth already locked above for
// get_layout_spec — no independent formula there to desync. What COULD silently desync on THIS
// tool specifically is the REST fetch peek (`(maxDepth ?? 4) + 1`, compare-node-to-dom-tool.ts)
// and the report footer's depthLevels (`maxDepth ?? 4`, plumbed into renderReport) — both are
// tool-local plumbing, not shared projector/diff code, so a future edit touching only ONE of them
// would desync silently (the mirror-desync lesson) while every EXISTING compare test still passes green
// (none of them sweep D — they only check the D=6/default pair, see compare-node-to-dom-tool.test.ts).
const compareCard: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 343, 120),
};
const compareDom = {
  schema: 1, status: 'ok' as const, selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false, children: [] as unknown[],
};

describe('compare_node_to_dom depth mirrors (drill-down regression lock)', () => {
  describe.each([4, 5, 6, 7, 8])('D=%i: REST fetch peek and report footer move together for the SAME max_depth', (D) => {
    it(`fetches D+1=${D + 1} (not D, not D+2); footer names exactly ${D} nesting levels`, async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: compareCard } } }));
      const run = compareHarness({ getNodesRaw });

      const out = JSON.parse((await run({
        file: 'abc', pairs: [{ node_id: '1:1', dom: compareDom }], max_depth: D,
      })).content[0].text);

      // Mirror 1 (REST fetch peek): D+1, not D and not D+2.
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], D + 1);

      // Mirror 2 (report footer depthLevels): names the SAME D the caller asked for — a tool-side
      // desync (e.g. the fetch bumping to D+1 while depthLevels stays hardcoded at 4, or off by
      // one) shows up here even though Mirror 1 above could still be individually correct.
      expect(out.report_markdown).toContain(`typography checked to ${D} nesting levels`);
    });
  });
});

describe('three-mirror breadth/total caps re-lock (Phase 0 — guards the Phase-2 VIEW_CAPS refactor)', () => {
  it('projector literals are the historical branch-view caps (independent oracle, not cross-derived)', () => {
    expect(MAX_SPEC_CHILDREN).toBe(30);
    expect(MAX_NESTED_CHILDREN).toBe(15);
    expect(MAX_TOTAL_NODES).toBe(90);
  });
  it('dom-extractor emits slice(0, MAX_SPEC_CHILDREN) — mirror 2 moves with mirror 1', () => {
    expect(EXTRACTOR_JS).toContain(`slice(0, ${MAX_SPEC_CHILDREN})`);
  });
});
