import { describe, it, expect } from 'vitest';
import { registerGetMetadataTool } from '../../src/adapters/driving/tools/get-metadata-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

function install(doc: RawSceneNode, maxResultChars = 40000) {
  const { server, call } = makeFakeMcpServer();
  // Mock returns the FULL tree regardless of depth; toSparseTree does the client-side
  // depth cut, so a node whose children exist beyond the requested depth gets childCount.
  const api = { getNodesRaw: async (_k: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: doc } } }) };
  const deps = { buildApi: () => api as never, defaultToken: 't', logger: { warn() {} } as never, maxResultChars };
  registerGetMetadataTool(server, deps as never);
  return (a: Record<string, unknown>) => call('get_metadata', a);
}

const doc: RawSceneNode = {
  id: '0:0', name: 'root', type: 'FRAME', children: [
    { id: '1:0', name: 'a', type: 'FRAME', children: [{ id: '1:1', name: 'a1', type: 'TEXT' }] },
  ],
};

describe('get_metadata truncation block', () => {
  it('reports requested vs effective depth and truncated branches', async () => {
    const call = install(doc);
    const res = await call({ file: 'k', node_id: '0:0', depth: 1 });
    const out = JSON.parse(textOf(res.content[0]));
    expect(out.truncation.requested_depth).toBe(1);
    expect(out.truncation.effective_depth).toBe(1);
    expect(out.truncation.reason).toBe('none');
    expect(out.truncation.truncated_branches).toBe(1);
    expect(out.children[0].childCount).toBe(1);
  });

  it('auto-reduces depth when tree at requested depth exceeds budget (reason=depth)', async () => {
    // A multi-level tree: root → 4 children → 3 grandchildren each → 2 great-grandchildren each.
    // Recalibration (final F3): previously budget=200 with STUB_LEN=205 gave a fit-budget of -5
    // (negative) → the frontier loop was structurally skipped and the test exercised the floor-clamp path under
    // the name of depth reduction. Live measures @900: fit-budget 900-205=695; the full depth-3 tree
    // sizeOf=2433 > 695 → the frontier REALLY runs: the depth-1 baseline fits (out+stub 536 ≤ 900),
    // one branch expanded to depth 2 → eff 2 / min 1, out+stub 763 ≤ 900 → floor-clamp is silent
    // (no omittedChildren) → a genuine PARTIAL depth reduction, reason='depth'.
    const makeLeaf = (id: string, name: string): RawSceneNode => ({ id, name, type: 'TEXT' });
    const makeGrandchild = (id: string, name: string): RawSceneNode => ({
      id, name, type: 'FRAME',
      children: [makeLeaf(`${id}.1`, `${name}-leaf1`), makeLeaf(`${id}.2`, `${name}-leaf2`)],
    });
    const makeChild = (id: string, name: string): RawSceneNode => ({
      id, name, type: 'FRAME',
      children: [
        makeGrandchild(`${id}.1`, `${name}-gc1`),
        makeGrandchild(`${id}.2`, `${name}-gc2`),
        makeGrandchild(`${id}.3`, `${name}-gc3`),
      ],
    });
    const deepDoc: RawSceneNode = {
      id: '0:0', name: 'root', type: 'FRAME',
      children: [
        makeChild('1:0', 'childA'),
        makeChild('2:0', 'childB'),
        makeChild('3:0', 'childC'),
        makeChild('4:0', 'childD'),
      ],
    };

    // Window 900: too small for depth-3 (2433), enough for depth-1 + one depth-2 branch.
    const BUDGET = 900;
    const call = install(deepDoc, BUDGET);
    const res = await call({ file: 'k', node_id: '0:0', depth: 3 });
    expect(textOf(res.content[0]).length).toBeLessThanOrEqual(BUDGET); // delivery ≤ budget
    const out = JSON.parse(textOf(res.content[0]));

    expect(out.truncation.requested_depth).toBe(3);
    expect(out.truncation.effective_depth).toBe(2);      // frontier expanded a branch — NOT floor (eff 1)
    expect(out.truncation.min_effective_depth).toBe(1);  // partial: the other branches at depth 1
    expect(out.truncation.reason).toBe('depth');         // depth reduction specifically, no width truncation
    expect(out.omittedChildren).toBeUndefined();         // floor-clamp did NOT fire (frontier path)
    expect(out.truncation.truncated_branches).toBeGreaterThanOrEqual(1);

    // At least one node in the tree should carry childCount (set by onTruncate callback)
    const hasChildCount = (node: { childCount?: number; children?: unknown[] }): boolean => {
      if (node.childCount !== undefined) return true;
      for (const c of node.children ?? []) {
        if (hasChildCount(c as { childCount?: number; children?: unknown[] })) return true;
      }
      return false;
    };
    expect(hasChildCount(out)).toBe(true);
  });

  it('keeps light branches deep while truncating heavy ones (per-branch)', async () => {
    const heavyKids: RawSceneNode[] = Array.from({ length: 40 }, (_, i) => ({ id: `9:${i}`, name: `heavyLeaf${i}`, type: 'TEXT' }));
    const doc2: RawSceneNode = {
      id: '0:0', name: 'root', type: 'FRAME', children: [
        { id: '1:0', name: 'light', type: 'FRAME', children: [
          { id: '1:1', name: 'l1', type: 'FRAME', children: [{ id: '1:2', name: 'l2', type: 'TEXT' }] },
        ] },
        { id: '2:0', name: 'heavy', type: 'FRAME', children: heavyKids },
      ],
    };
    // Budget admits the small light expansions but not the 40-wide heavy one.
    const call = install(doc2, 700);
    const res = await call({ file: 'k', node_id: '0:0', depth: 4 });
    const out = JSON.parse(textOf(res.content[0]));

    expect(out.truncation.min_effective_depth).toBe(1);          // heavy cut at depth 1
    expect(out.truncation.effective_depth).toBeGreaterThan(1);   // light deeper
    expect(out.truncation.reason).toBe('depth');                 // depth lever, no width omission
    const heavy = out.children.find((c: any) => c.id === '2:0');
    expect(heavy.truncated).toBe(true);
    expect(heavy.childCount).toBe(40);
  });

  it('compact measure: the delivered out (with the truncation field) ≤ budget — the pretty cushion is gone, the stub holds', async () => {
    // Wide tree (floor case): 30 direct children, each with a bbox + a text child. At depth 4
    // the per-branch fit has already collapsed everything to depth 1, and one top-level width exceeds the budget →
    // floor-clamp. The truncation block (~150 compact chars) is added to out AFTER all measures; without
    // a conservative stub it silently pushes delivery over the budget. Live measures @budget=1000:
    // compact-without-stub → delivered 1073 > 1000 (RED); compact+stub → 969 ≤ 1000 (GREEN); current
    // pretty → 657 ≤ 1000 (over-clamp to 4 children — the cushion MASKS the under-estimate, the lock is falsely green).
    const wide: RawSceneNode = { id: '0:0', name: 'root', type: 'FRAME', children: Array.from({ length: 30 }, (_, i) => ({
      id: `1:${i}`, name: `frame-${i}`, type: 'FRAME',
      absoluteBoundingBox: { x: i, y: i, width: 100, height: 50 },
      children: [{ id: `2:${i}`, name: `child-${i}`, type: 'TEXT', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } }],
    })) };
    const BUDGET = 1000;
    const call = install(wide, BUDGET);
    const res = await call({ file: 'k', node_id: '0:0', depth: 4 });
    // Delivery NEVER exceeds the budget — catches an under-estimate of the truncation block (RED on compact-without-stub).
    expect(textOf(res.content[0]).length).toBeLessThanOrEqual(BUDGET);
    const out = JSON.parse(textOf(res.content[0]));
    expect(out.truncation).toBeDefined();           // co-lock on content: the floor path was actually taken
    expect(out.omittedChildren).toBeGreaterThan(0);  // width truncated
    expect(out.truncation.reason).toBe('both');      // depth collapsed + width truncated
  });

  it('degrade path: subtracting STUB_LEN reserves room — all branches held (fine-grained degrade), not a coarse whole-branch clamp', async () => {
    // Covers SUBTRACTING STUB_LEN from the fit budget (floor-clamp is only a coarse backstop and delivered≤budget
    // holds on its own; the fine per-branch degrade is what the stub reserve protects). A branchy tree:
    // 6 children × 4 grandchildren × 2 leaves. At budget=900 WITHOUT the reserve the fit expands right up to the budget, and
    // the truncation block added AFTER pushes out+stub over the budget → the coarse floor-clamp fires,
    // dropping 2 WHOLE top branches (omitted=2, reason 'both'). With the reserve (budget - STUB_LEN) the fit
    // stops earlier: out+stub ≤ budget, the floor gate is silent, all 6 branches kept at a reduced
    // depth. Live measures @900: correct → delivered 664, kids 6, omitted 0, reason 'depth';
    // without the subtraction → delivered 828, kids 4, omitted 2, reason 'both'. (delivered ≤ 900 in BOTH — not
    // the discriminator; the discriminator is structural: omittedChildren / reason / branch count.)
    const mk = (id: string): RawSceneNode => ({
      id, name: `n${id}`, type: 'FRAME',
      children: Array.from({ length: 4 }, (_, i) => ({
        id: `${id}.${i}`, name: `n${id}.${i}`, type: 'FRAME',
        children: Array.from({ length: 2 }, (_, j) => ({ id: `${id}.${i}.${j}`, name: `leaf${id}.${i}.${j}`, type: 'TEXT' as const })),
      })),
    });
    const branchy: RawSceneNode = { id: '0:0', name: 'root', type: 'FRAME',
      children: Array.from({ length: 6 }, (_, i) => mk(`${i + 1}:0`)) };
    const call = install(branchy, 900);
    const res = await call({ file: 'k', node_id: '0:0', depth: 4 });
    expect(textOf(res.content[0]).length).toBeLessThanOrEqual(900); // delivery ≤ budget (incl. under the mutation — not the discriminator here)
    const out = JSON.parse(textOf(res.content[0]));
    expect(out.omittedChildren).toBeUndefined();  // reserve → NOT a coarse whole-branch clamp
    expect(out.children.length).toBe(6);          // all 6 branches kept
    expect(out.truncation.reason).toBe('depth');  // depth degrade only, not 'both'
  });

  it('compact sizeOf fits DEEPER than pretty — the fit removes a false alarm of depth reduction (measure == delivery)', async () => {
    // Covers COMPACT sizeOf in the per-branch fit. A binary tree of depth 5. sizeOf feeds the fit's
    // "expand this branch?" decision. A pretty measure (×~2-3.75) INFLATES a node's estimate → the fit UNDER-expands
    // (a false alarm of "doesn't fit") → shallower. A compact measure (== delivery) fits deeper — removing the
    // false-alarm. Live measures @budget=700: compact → eff 2, min 2, delivered 634; pretty (returning
    // JSON.stringify null,2) → eff 1, min 1, delivered 368. Pinning the depth catches a return to pretty sizeOf.
    const chain = (id: string, d: number): RawSceneNode =>
      d <= 0
        ? { id, name: `leaf-${id}`, type: 'TEXT' }
        : { id, name: `node-${id}`, type: 'FRAME', children: [chain(`${id}x`, d - 1), chain(`${id}y`, d - 1)] };
    const tree5: RawSceneNode = { id: '0:0', name: 'root', type: 'FRAME', children: [chain('a', 4), chain('b', 4)] };
    const call = install(tree5, 700);
    const res = await call({ file: 'k', node_id: '0:0', depth: 5 });
    expect(textOf(res.content[0]).length).toBeLessThanOrEqual(700);
    const out = JSON.parse(textOf(res.content[0]));
    expect(out.truncation.effective_depth).toBe(2);      // compact fits to depth 2 (pretty → 1)
    expect(out.truncation.min_effective_depth).toBe(2);  // all branches at depth 2 (pretty → 1)
  });

  it('floor boundary: the truncation stub IN the floor gate forces a clamp when the baseline fits WITHOUT the block but not WITH it', async () => {
    // Covers the STUB INSIDE the floor gate (the `if` condition). 12 child frames (each with 1 grandchild) →
    // the depth-1 baseline lands in the window (budget - STUB_LEN, budget]: it fits the budget ON ITS OWN,
    // but NOT together with the truncation block (~150 chars, added AFTER). Without the stub in the gate the condition
    // `serialize(out) > budget` is false → the clamp does NOT run → delivery = baseline + block > budget.
    // With the stub the gate sees baseline+stub > budget → forces the clamp. Live measures @budget=1060:
    // correct → delivered 1010 ≤ 1060, omitted 2, reason 'both'; without the stub in the gate → delivered
    // 1149 > 1060 (the gate is silent, omitted 0). (The 30-wide floor lock above does NOT catch this: there the baseline
    // ≫ budget, the gate fires under any measure — the gate stub decides only on this boundary.)
    const floorDoc: RawSceneNode = { id: '0:0', name: 'root', type: 'FRAME', children: Array.from({ length: 12 }, (_, i) => ({
      id: `1:${i}`, name: `frame-${i}`, type: 'FRAME',
      children: [{ id: `2:${i}`, name: `gc-${i}`, type: 'TEXT' }],
    })) };
    const call = install(floorDoc, 1060);
    const res = await call({ file: 'k', node_id: '0:0', depth: 2 });
    expect(textOf(res.content[0]).length).toBeLessThanOrEqual(1060); // delivery ≤ budget — RED without the stub in the gate (1149)
    const out = JSON.parse(textOf(res.content[0]));
    expect(out.omittedChildren).toBeGreaterThan(0); // the gate forced a clamp
    expect(out.truncation.reason).toBe('both');     // depth collapsed (2→1) + width truncated
  });
});
