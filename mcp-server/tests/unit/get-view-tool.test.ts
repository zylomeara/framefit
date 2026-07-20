import { describe, it, expect, vi } from 'vitest';
import { registerGetViewTool } from '../../src/adapters/driving/tools/get-view-tool.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { buildLayoutSpec, VIEW_CAPS } from '../../src/domain/layout-spec/projector.js';
import { buildSpacing, buildCoverage, buildSkeleton } from '../../src/domain/layout-spec/views.js';
import { serializeForDelivery } from '../../src/adapters/driving/tools/serialize.js';
import { RESULT_BUDGET_BYTES } from '../../src/adapters/driving/tools/clamp-specs.js';

// Skeleton fixtures: a VERTICAL list whose items share a NAME but may differ in child-shape.
const radio: any = { id: 'r', name: 'radio', type: 'INSTANCE', absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 }, children: [] };
const txt: any = { id: 't', name: 'txt', type: 'TEXT', characters: 'x', style: { fontSize: 12 }, absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 }, children: [] };
const listOf = (n: number, shapeChildren: (i: number) => any[]): any => ({
  id: 'list', name: 'list', type: 'FRAME', layoutMode: 'VERTICAL',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  children: Array.from({ length: n }, (_, i) => ({ id: `item${i}`, name: 'item', type: 'INSTANCE',
    absoluteBoundingBox: { x: 0, y: i * 20, width: 100, height: 20 }, children: shapeChildren(i) })),
});

// chain(levels): a nested single-branch FRAME tree N deep with a TEXT leaf (typed any to match fixtures)
const chain = (levels: number): any => {
  const leaf: any = { id: 'txt', name: 'txt', type: 'TEXT', characters: 'hello',
    style: { fontSize: 12 }, absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 }, children: [] };
  let node: any = leaf;
  for (let i = levels; i > 0; i--) node = { id: `n${i}`, name: `n${i}`, type: 'FRAME', layoutMode: 'VERTICAL',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, children: [node] };
  return node;
};

function harness(overrides: any = {}) {
  const captured: any[] = [];
  const server: any = { tool: (_n: string, _d: string, _s: any, h: any) => captured.push(h) };
  const getNodesRaw = vi.fn(async (_fk: string, ids: string[]) => ({
    nodes: Object.fromEntries(ids.map((id) => [id, { document: chain(8), components: {} }])) }));
  const api = withFrameRaw({ getNodesRaw } as any);
  const buildApi = vi.fn(() => api);
  const deps: any = { logger: { info() {}, warn() {}, error() {} }, buildApi, defaultToken: 't', ...overrides };
  registerGetViewTool(server, deps);
  return { handler: captured[0], getNodesRaw };
}

describe('get_view', () => {
  it('branch view returns a spec + hydration receipt', async () => {
    const { handler } = harness();
    const out = await handler({ file: 'k', node_id: '1:2', view: 'branch', max_depth: 4 });
    const body = JSON.parse(out.content[0].text);
    expect(body.view).toBe('branch');
    expect(body.branch.node.id).toBe('n1');
    expect(body.hydration.node_id).toBe('1:2');
  });

  // MUTATION LOCK on the meta-first path buildSetNames(api, entry, …) in get_view.
  // The branch view's root is an INSTANCE with componentId '5:1'; the components meta carries componentSetId+key
  // (which would make legacy resolveSetNames(api, entry.components) call getComponent), BUT
  // the componentSets meta covers the setId → setName resolves from the meta, REST is NOT touched. setName
  // is observed in the output as body.branch.component.setName (spec.component on the LayoutSpec root).
  // The mutation "revert to resolveSetNames(api, entry.components, …)" → getComponent called + setName
  // lost → RED on both asserts.
  it('branch: setName from the componentSets meta → body.branch.component.setName from the meta, getComponent NOT called', async () => {
    const instanceRoot: any = { id: '2:1', name: 'type=active', type: 'INSTANCE', componentId: '5:1',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 }, children: [] };
    const getComponent = vi.fn();
    const getNodesRaw = vi.fn(async (_f: string, ids: string[]) => ({
      nodes: Object.fromEntries(ids.map((id) => [id, {
        document: instanceRoot,
        components: { '5:1': { key: 'pubkey', name: 'type=active', remote: true, componentSetId: '4:1' } },
        componentSets: { '4:1': { key: 'sk1', name: 'listItem', remote: true } },
      }])) }));
    const { handler } = harness({ buildApi: () => withFrameRaw({ getNodesRaw, getComponent } as any) });
    const out = await handler({ file: 'k', node_id: '2:1', view: 'branch', max_depth: 4 });
    const body = JSON.parse(out.content[0].text);
    expect(body.branch.component.setName).toBe('listItem');
    expect(getComponent).not.toHaveBeenCalled(); // meta-resolve: zero REST fetches
  });

  it('two views of the same node → ONE getFrameRaw fetch (store re-slice)', async () => {
    // withFrameRaw answers each getFrameRaw by calling getNodesRaw; a real store would collapse the
    // second. Assert the tool asks getFrameRaw for the SAME id-set both times (store-key parity).
    const { handler, getNodesRaw } = harness();
    await handler({ file: 'k', node_id: '1:2', view: 'skeleton', max_depth: 4 });
    await handler({ file: 'k', node_id: '1:2', view: 'branch', max_depth: 2 });
    // same single id both calls → same store key ${file}|${version}|frame:1:2
    for (const call of getNodesRaw.mock.calls) expect(call[1]).toEqual(['1:2']);
  });

  it('typography view: single-root reaches deep text leaves', async () => {
    const { handler } = harness();
    const out = await handler({ file: 'k', node_id: '1:2', view: 'typography', max_depth: 8 });
    const body = JSON.parse(out.content[0].text);
    expect(body.view).toBe('typography');
    expect(body.typography.leaves.some((l: any) => l.typography?.fontSize === 12)).toBe(true);
  });

  it('spacing view: gaps + paddings per container', async () => {
    const { handler } = harness();
    const out = await handler({ file: 'k', node_id: '1:2', view: 'spacing', max_depth: 4 });
    const body = JSON.parse(out.content[0].text);
    expect(body.view).toBe('spacing');
    expect(Array.isArray(body.spacing.containers)).toBe(true);
    expect(body.spacing.containers[0]).toHaveProperty('axis');
  });

  // The chain(N) fixture is a single-child-per-level chain, so derivedGaps never runs with ≥2
  // children there (always []) — the gap math itself is unproven by the test above. This builds a
  // real multi-child container directly and asserts the derived edge-to-edge gaps.
  it('spacing view: derived_gaps computed from a 3-child VERTICAL container', () => {
    const raw: any = {
      id: 'root', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        { id: 'c1', name: 'c1', type: 'FRAME', children: [], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 } },
        { id: 'c2', name: 'c2', type: 'FRAME', children: [], absoluteBoundingBox: { x: 0, y: 30, width: 100, height: 20 } },
        { id: 'c3', name: 'c3', type: 'FRAME', children: [], absoluteBoundingBox: { x: 0, y: 60, width: 100, height: 20 } },
      ],
    };
    const spec = buildLayoutSpec(raw, { components: {}, setNames: new Map() }, { maxDepth: 4, caps: VIEW_CAPS.spacing });
    const view = buildSpacing(spec);
    expect(view.containers[0].axis).toBe('col');
    expect(view.containers[0].derived_gaps).toEqual([10, 10]);
  });

  it('coverage view: auto-layout container with ≥2 children is spacing_checkable', async () => {
    const { handler } = harness();
    const out = await handler({ file: 'k', node_id: '1:2', view: 'coverage', max_depth: 6 });
    const body = JSON.parse(out.content[0].text);
    expect(body.view).toBe('coverage');
    // chain(8) is single-child per level → NOT spacing_checkable (needs ≥2 in-flow children)
    expect(body.coverage.containers.every((c: any) => c.spacing_checkable === false || c.child_count >= 2)).toBe(true);
  });

  // chain(N) never exercises the ≥2 gate's true branch (always single-child) — build a real 2-child
  // auto-layout container directly and assert spacing_checkable flips to true.
  it('coverage view: VERTICAL container with 2 TEXT children → spacing_checkable:true', () => {
    const raw: any = {
      id: 'root', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        { id: 't1', name: 't1', type: 'TEXT', characters: 'hello', style: { fontSize: 12 },
          absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 }, children: [] },
        { id: 't2', name: 't2', type: 'TEXT', characters: 'world', style: { fontSize: 12 },
          absoluteBoundingBox: { x: 0, y: 30, width: 40, height: 20 }, children: [] },
      ],
    };
    const spec = buildLayoutSpec(raw, { components: {}, setNames: new Map() }, { maxDepth: 6, caps: VIEW_CAPS.coverage });
    const view = buildCoverage(spec);
    expect(view.containers[0].spacing_checkable).toBe(true);
    expect(view.containers[0].child_count).toBe(2);
    expect(view.containers[0].axis).toBe('col');
  });

  // Neither the coverage nor spacing tests above ever exercise a NON-auto-layout container — a
  // regression dropping the `!!axis` gate (leaving bare `kids.length >= 2`) would pass undetected,
  // falsely reporting a non-auto-layout container's gaps as checkable. Lock both views' axis gate
  // on the SAME raw tree: a FRAME root with NO layoutMode (no axis) holding 2 leaf children.
  it('coverage + spacing: container with NO layoutMode (no axis) is never spacing_checkable, never gapped', () => {
    const raw: any = {
      id: 'root', name: 'root', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        { id: 'k1', name: 'k1', type: 'FRAME', children: [], absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 } },
        { id: 'k2', name: 'k2', type: 'FRAME', children: [], absoluteBoundingBox: { x: 0, y: 30, width: 40, height: 20 } },
      ],
    };
    const spec = buildLayoutSpec(raw, { components: {}, setNames: new Map() }, { maxDepth: 6, caps: VIEW_CAPS.coverage });
    const coverage = buildCoverage(spec);
    const spacing = buildSpacing(spec);
    expect(coverage.containers[0].child_count).toBe(2);
    expect(coverage.containers[0].spacing_checkable).toBe(false);
    expect(spacing.containers[0].derived_gaps).toEqual([]);
  });

  it('skeleton: identical-shape siblings summarize to one repeated row', async () => {
    const { handler } = harness({ buildApi: () => withFrameRaw({ getNodesRaw: async (_f: string, ids: string[]) =>
      ({ nodes: Object.fromEntries(ids.map((id) => [id, { document: listOf(4, () => [radio, txt]), components: {} }])) }) } as any) });
    const out = await handler({ file: 'k', node_id: '1:2', view: 'skeleton', max_depth: 6 });
    const body = JSON.parse(out.content[0].text);
    const rep = body.skeleton.children.find((c: any) => c.repeated);
    expect(rep.repeated.count).toBe(4);
    expect(rep.repeated.variant_shapes).toBeUndefined();
  });

  it('skeleton: siblings with DIFFERENT child-shapes are NOT merged (never-false-green)', async () => {
    // items 0,1 have [radio,txt]; items 2,3 have [radio] only → 2 distinct signatures under the same name
    const doc = listOf(4, (i) => (i < 2 ? [radio, txt] : [radio]));
    const { handler } = harness({ buildApi: () => withFrameRaw({ getNodesRaw: async (_f: string, ids: string[]) =>
      ({ nodes: Object.fromEntries(ids.map((id) => [id, { document: doc, components: {} }])) }) } as any) });
    const out = await handler({ file: 'k', node_id: '1:2', view: 'skeleton', max_depth: 6 });
    const body = JSON.parse(out.content[0].text);
    const reps = body.skeleton.children.filter((c: any) => c.repeated);
    // must NOT be a single "4×" row; either two groups or a variant_shapes flag — never a lossy merge
    const merged4 = reps.find((r: any) => r.repeated.count === 4 && !r.repeated.variant_shapes);
    expect(merged4).toBeUndefined();
  });

  it('skeleton: same-name siblings of DIFFERENT shape → run stops at 3 + variant_shapes counts distinct', async () => {
    // items 0,1,2 = [radio,txt] (identical run of 3 comes FIRST); item 3 = [radio] only (breaks the run)
    const doc = listOf(4, (i) => (i < 3 ? [radio, txt] : [radio]));
    const { handler } = harness({ buildApi: () => withFrameRaw({ getNodesRaw: async (_f: string, ids: string[]) =>
      ({ nodes: Object.fromEntries(ids.map((id) => [id, { document: doc, components: {} }])) }) } as any) });
    const out = await handler({ file: 'k', node_id: '1:2', view: 'skeleton', max_depth: 6 });
    const body = JSON.parse(out.content[0].text);
    const reps = body.skeleton.children.filter((c: any) => c.repeated);
    expect(reps.length).toBe(1);
    expect(reps[0].repeated.count).toBe(3);            // the odd item3 is NOT summarized into the run
    expect(reps[0].repeated.variant_shapes).toBe(2);   // two distinct signatures share the name "item"
    expect(body.skeleton.children.every((c: any) => c.repeated?.count !== 4)).toBe(true);
  });

  it('skeleton: oversized view is delivered but honestly flagged result_oversized', async () => {
    // ~3000 DISTINCT-named leaf children → nothing summarizes away → serialized skeleton > 1MB budget.
    const children = Array.from({ length: 3000 }, (_, i) => ({
      id: 'n' + i, name: 'x'.repeat(400) + i, type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: i, width: 10, height: 10 }, children: [] }));
    const bigFrame: any = { id: 'root', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100000 }, children };
    const { handler } = harness({ buildApi: () => withFrameRaw({ getNodesRaw: async (_f: string, ids: string[]) =>
      ({ nodes: Object.fromEntries(ids.map((id) => [id, { document: bigFrame, components: {} }])) }) } as any) });
    const out = await handler({ file: 'k', node_id: '1:2', view: 'skeleton', max_depth: 6 });
    const body = JSON.parse(out.content[0].text);
    // confirm the fixture actually exceeds the delivered-byte budget (bump 400/3000 if this ever fails)
    const measured = serializeForDelivery({ node_id: '1:2', skeleton: body.skeleton }).length;
    expect(measured).toBeGreaterThan(RESULT_BUDGET_BYTES);
    expect(body.result_oversized).toBe(true);
    expect(body.result_oversized_note).toBeTruthy();
    // flag-not-drop: the oversized payload is still delivered in full
    expect(body.skeleton).toBeDefined();
    expect(body.skeleton.children.length).toBe(3000);
  });

  // FIX 1 (never-false-green): the single-child collapse loop MUST decrement depthLeft, so a wrapper
  // chain deeper than the depth budget stops AT the boundary and honestly flags `truncated` — instead
  // of walking the whole chain to a node whose children were never fetched (in prod that node's empty
  // inFlowSceneChildren is indistinguishable from a real leaf → a silent structural drop).
  it('skeleton: single-child chain deeper than depth budget stops at boundary + truncated (never silent drop)', () => {
    const deep = chain(10); // n1→…→n10→txt leaf, far beyond a depth-4 budget
    const skel = buildSkeleton(deep, 4);
    expect(skel.collapsed).toEqual(['n1', 'n2', 'n3', 'n4']); // exactly depthLeft wrappers walked
    expect(skel.node_id).toBe('n5');       // descent STOPPED at the depth boundary…
    expect(skel.node_id).not.toBe('txt');  // …did NOT silently reach the true leaf
    expect(skel.truncated).toBe(true);     // boundary node honestly flagged
    expect(skel.child_count).toBe(1);      // boundary node still has a (peeked) child
    expect(skel.children).toBeUndefined(); // no descent past the boundary
  });

  it('skeleton: single-child chain that truly ends in a leaf is NOT falsely truncated', () => {
    const shallow = chain(3); // n1→n2→n3→txt leaf, ends within a depth-8 budget
    const skel = buildSkeleton(shallow, 8);
    expect(skel.collapsed).toEqual(['n1', 'n2', 'n3']); // all wrappers collapsed
    expect(skel.node_id).toBe('txt');       // fully reached the real leaf
    expect(skel.truncated).toBeUndefined(); // a real leaf → honestly UNflagged
    expect(skel.child_count).toBe(0);       // genuine leaf, no children
  });

  // FIX 2 (never-false-green): the hydration receipt is ALWAYS built with branch caps, regardless of
  // the requested (wider) view — so it honestly reports the truncation a real branch-caps `compare`
  // would hit. Mutating the receipt line to `caps: VIEW_CAPS[view]` would under-report breadth
  // truncation of a wide view (a false-green); this locks it. 40 children: > branch's 30 cap (truncates),
  // < coverage's 80 cap (does NOT). The receipt must STILL show the branch-caps breadth cut.
  it('receipt uses BRANCH caps regardless of requested view (breadth honesty lock)', async () => {
    const children = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`, name: `c${i}`, type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: i * 20, width: 100, height: 20 }, children: [] }));
    const wide: any = { id: 'root', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 1000 }, children };
    const { handler } = harness({ buildApi: () => withFrameRaw({ getNodesRaw: async (_f: string, ids: string[]) =>
      ({ nodes: Object.fromEntries(ids.map((id) => [id, { document: wide, components: {} }])) }) } as any) });
    const out = await handler({ file: 'k', node_id: '1:2', view: 'coverage', max_depth: 6 });
    const body = JSON.parse(out.content[0].text);
    expect(body.view).toBe('coverage');
    // coverage's own 80-cap does NOT truncate 40 → the payload keeps all 40 (contrast with the receipt).
    expect(body.coverage.containers[0].child_count).toBe(40);
    // …but the hydration receipt (branch caps, 30) HONESTLY reports the breadth cut a compare would hit.
    expect(body.hydration.cause_breakdown.breadth).toBeGreaterThan(0);
  });
});
