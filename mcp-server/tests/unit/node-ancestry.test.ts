import { describe, it, expect, vi } from 'vitest';
import { resolveAncestry, MAX_ANCESTRY_CALLS } from '../../src/application/node-ancestry.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import { FigmaApiError } from '../../src/ports/errors.js';

type Api = Pick<FigmaApi, 'getNodesRaw' | 'getDocumentRaw'>;

// ---- fixture helpers -------------------------------------------------------------------------

function n(
  id: string,
  type: string,
  box: { x: number; y: number; w: number; h: number } | null,
  children: RawSceneNode[] = [],
  rotation?: number,
): RawSceneNode {
  return {
    id,
    name: id,
    type,
    absoluteBoundingBox: box ? { x: box.x, y: box.y, width: box.w, height: box.h } : null,
    children,
    ...(rotation !== undefined ? { rotation } : {}),
  };
}

// Mirrors what a real GET /v1/files/:key/nodes?ids=X&depth=2 (or ?depth=2 from the document root)
// returns rooted at `node`: node + its children + its grandchildren, with the grandchildren's own
// children stripped (never available at depth 2). Used both for getDocumentRaw's response and for
// every entry the getNodesRaw mock can look up — so the implementation can never "see" more of the
// tree than a real depth-2 fetch would actually deliver.
function slice2(node: RawSceneNode): RawSceneNode {
  const children = (node.children ?? []).map((c) => ({
    ...c,
    children: (c.children ?? []).map((gc) => ({ ...gc, children: undefined })),
  }));
  return { ...node, children };
}

function registerTree(nodesById: Map<string, RawSceneNode>, node: RawSceneNode): void {
  nodesById.set(node.id, slice2(node));
  for (const child of node.children ?? []) registerTree(nodesById, child);
}

// Truncates a tree to `depth` levels of descendants below `node`, mirroring GET /files/:key?depth=N
// (depth=1 -> node + its children only; depth=2 -> + grandchildren; deeper levels stripped). Used by
// the skeleton-scan test to build a getDocumentRaw mock that RESPECTS its depth argument — so the
// test genuinely exercises the depth-2 skeleton boundary instead of silently passing at any depth.
function sliceToDepth(node: RawSceneNode, depth: number): RawSceneNode {
  if (depth <= 0) return { ...node, children: undefined };
  return { ...node, children: (node.children ?? []).map((c) => sliceToDepth(c, depth - 1)) };
}

// Builds a fake Api whose getNodesRaw echoes back a depth-2 slice keyed by id (per the
// mock skeleton), and whose getDocumentRaw returns the same depth-2 slice rooted at the document.
// `failures` injects a per-id error thrown by getNodesRaw instead of returning data.
function buildApi(root: RawSceneNode, extra?: Map<string, RawSceneNode>, failures?: Map<string, Error>): Api {
  const nodesById = new Map<string, RawSceneNode>();
  registerTree(nodesById, root);
  if (extra) for (const [k, v] of extra) nodesById.set(k, v);
  const getNodesRaw = vi.fn(async (_f: string, ids: string[], _d?: number) => {
    const err = failures?.get(ids[0]);
    if (err) throw err;
    const doc = nodesById.get(ids[0]);
    return { nodes: doc ? { [ids[0]]: { document: doc } } : {} };
  });
  const getDocumentRaw = vi.fn(async (_f: string, _d?: number) => ({
    name: 'f', lastModified: '', version: '1', document: slice2(root),
  }));
  return { getNodesRaw, getDocumentRaw } as unknown as Api;
}

function doc(root: RawSceneNode): RawSceneNode {
  return n('0:0', 'DOCUMENT', null, [root]);
}

// Builds a linear single-child chain ids[0] -> ids[1] -> ... -> ids[last], every level sharing the
// SAME box (so containment is trivial throughout), with the innermost node getting `leafChildren`
// (a real target, or [] for a genuine dead end). Returns ids[0] (the chain's root).
function chain(
  ids: string[],
  box: { x: number; y: number; w: number; h: number },
  leafChildren: RawSceneNode[] = [],
): RawSceneNode {
  let node = n(ids[ids.length - 1], 'FRAME', box, leafChildren);
  for (let i = ids.length - 2; i >= 0; i--) node = n(ids[i], 'FRAME', box, [node]);
  return node;
}

// ---- scenarios --------------------------------------------------------------------------------

describe('resolveAncestry', () => {
  it('happy path, 3 levels (page→section→frame→target): confirms on call 3, path is verified', async () => {
    const target = n('30:1', 'FRAME', { x: 100, y: 100, w: 10, h: 10 });
    const frame = n('20:1', 'FRAME', { x: 0, y: 0, w: 500, h: 500 }, [target]);
    const section = n('10:1', 'SECTION', { x: 0, y: 0, w: 1000, h: 1000 }, [frame]);
    const page = n('0:1', 'CANVAS', null, [section]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', '30:1');
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBe(3);
    expect(res.path.map((p) => p.id)).toEqual(['0:1', '10:1', '20:1']);
    expect(res.target).toEqual({ id: '30:1', name: '30:1', type: 'FRAME', w: 10, h: 10 });
  });

  it('target is a top-level frame: confirmed by skeleton alone, callsUsed=2, path=[page], target NOT in path', async () => {
    const target = n('10:1', 'FRAME', { x: 0, y: 0, w: 100, h: 100 });
    const page = n('0:1', 'CANVAS', null, [target]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', '10:1');
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBe(2);
    expect(res.path.map((p) => p.id)).toEqual(['0:1']);
    expect(res.path.some((p) => p.id === '10:1')).toBe(false);
  });

  it('target is a grandchild: confirmed via the intermediate child, which is added to path for free', async () => {
    const target = n('40:9', 'TEXT', { x: 205, y: 205, w: 5, h: 5 });
    const decoySibling = n('40:1', 'FRAME', { x: 0, y: 0, w: 50, h: 50 });
    const childWithTarget = n('40:2', 'FRAME', { x: 200, y: 200, w: 20, h: 20 }, [target]);
    const candidate = n('30:5', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [decoySibling, childWithTarget]);
    const page = n('0:1', 'CANVAS', null, [candidate]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', '40:9');
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBe(3); // call1 + call2 + one probe fetch of `candidate`
    expect(res.path.map((p) => p.id)).toEqual(['0:1', '30:5', '40:2']);
    expect(res.path.some((p) => p.id === '40:1')).toBe(false); // decoy sibling never enters the path
  });

  it('grandchild-containing step lets a deep chain skip a level: callsUsed is well under the naive per-level bound', async () => {
    const box = { x: 0, y: 0, w: 1000, h: 1000 };
    const target = n('99:9', 'FRAME', { x: 500, y: 500, w: 2, h: 2 });
    const l7 = n('90:7', 'FRAME', box, [target]);
    const l6 = n('90:6', 'FRAME', box, [l7]);
    const l5 = n('90:5', 'FRAME', box, [l6]);
    const l4 = n('90:4', 'FRAME', box, [l5]);
    const l3 = n('90:3', 'FRAME', box, [l4]);
    const l2 = n('90:2', 'FRAME', box, [l3]);
    const l1 = n('90:1', 'FRAME', box, [l2]);
    const l0 = n('90:0', 'FRAME', box, [l1]); // tier-0 candidate
    const page = n('0:1', 'CANVAS', null, [l0]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', '99:9');
    expect(res.confirmed).toBe(true);
    // 8 hops from l0 to target; naive one-level-at-a-time descent needs call1+call2+8 = 10.
    // Grandchild-skipping covers 2 levels per fetch: call1+call2+probe(l0)+fetch(l2)+fetch(l4)+fetch(l6) = 6.
    expect(res.callsUsed).toBe(6);
    expect(res.callsUsed).toBeLessThan(10);
    expect(res.path.map((p) => p.id)).toEqual(['0:1', '90:0', '90:1', '90:2', '90:3', '90:4', '90:5', '90:6', '90:7']);
  });

  it('overlay: 2 containing top-level candidates on one page, target in the second — probe-first confirms it', async () => {
    const target = n('ov:target', 'TEXT', { x: 600, y: 10, w: 4, h: 4 });
    const cand1 = n('ov:cand1', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }); // decoy, contains the point, no children
    const cand2 = n('ov:cand2', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [target]);
    const page = n('0:1', 'CANVAS', null, [cand1, cand2]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', 'ov:target');
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBe(4); // call1 + call2 + probe(cand1) + probe(cand2)
    expect(res.path.map((p) => p.id)).toEqual(['0:1', 'ov:cand2']);
  });

  it('cross-page clash: page1 has a deep false branch, target is shallow on page2 — probe-first is the only way the budget suffices', async () => {
    const target = n('P2:target', 'TEXT', { x: 10, y: 10, w: 2, h: 2 });
    const p2cand = n('P2:cand', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [target]);
    const page2 = n('page2', 'CANVAS', null, [p2cand]);

    const box = { x: 0, y: 0, w: 1000, h: 1000 };
    const d5 = n('P1:5', 'FRAME', box);
    const d4 = n('P1:4', 'FRAME', box, [d5]);
    const d3 = n('P1:3', 'FRAME', box, [d4]);
    const d2 = n('P1:2', 'FRAME', box, [d3]);
    const d1 = n('P1:1', 'FRAME', box, [d2]);
    const p1cand = n('P1:cand', 'FRAME', box, [d1]);
    const page1 = n('page1', 'CANVAS', null, [p1cand]);

    const root = n('0:0', 'DOCUMENT', null, [page1, page2]); // page1 first in document order
    const api = buildApi(root);

    const res = await resolveAncestry(api, 'FILE', 'P2:target', { maxCalls: 4 });
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBe(4); // call1 + call2 + probe(P1:cand) + probe(P2:cand) — never descends into P1's decoy
    expect(res.path.map((p) => p.id)).toEqual(['page2', 'P2:cand']);
  });

  it('budget=3 outcome (a): best path excludes grandchildren from the tail, note explains the call budget', async () => {
    const target = n('bud:target', 'FRAME', { x: 10, y: 10, w: 2, h: 2 });
    const grandchild = n('bud:gc', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [target]);
    const child = n('bud:child', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [grandchild]);
    const candidate = n('bud:cand', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [child]);
    const page = n('0:1', 'CANVAS', null, [candidate]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', 'bud:target', { maxCalls: 3 });
    expect(res.confirmed).toBe(false);
    expect(res.callsUsed).toBe(3);
    expect(res.path.map((p) => p.id)).toEqual(['0:1', 'bud:cand', 'bud:child']);
    expect(res.path.some((p) => p.id === 'bud:gc')).toBe(false); // no grandchild in the tail
    expect(res.note).toMatch(/call budget/);
  });

  it('DFS exhausted while the budget is still alive (outcome b): containment chain breaks', async () => {
    const target = n('dead:target', 'FRAME', { x: 900, y: 900, w: 2, h: 2 });
    const child1 = n('dead:c1', 'FRAME', { x: 0, y: 0, w: 100, h: 100 });
    const child2 = n('dead:c2', 'FRAME', { x: 0, y: 100, w: 100, h: 100 });
    const candidate = n('dead:cand', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [child1, child2]);
    const page = n('0:1', 'CANVAS', null, [candidate]);
    // `target` is a real, individually-fetchable node (call 1 always succeeds by id) that is simply
    // unreachable via containment from any discovered descendant — e.g. clipped/overflowed content.
    const api = buildApi(doc(page), new Map([[target.id, target]]));

    const res = await resolveAncestry(api, 'FILE', 'dead:target', { maxCalls: MAX_ANCESTRY_CALLS });
    expect(res.confirmed).toBe(false);
    expect(res.callsUsed).toBeLessThan(MAX_ANCESTRY_CALLS);
    expect(res.note).toMatch(/containment chain broke/);
  });

  it('no first-tier candidate contains the target center (outcome c): path=[]', async () => {
    const target = n('nc:target', 'FRAME', { x: 5000, y: 5000, w: 2, h: 2 });
    const candidate = n('nc:cand', 'FRAME', { x: 0, y: 0, w: 100, h: 100 });
    const page = n('0:1', 'CANVAS', null, [candidate]);
    const api = buildApi(doc(page), new Map([[target.id, target]]));

    const res = await resolveAncestry(api, 'FILE', 'nc:target');
    expect(res.confirmed).toBe(false);
    expect(res.callsUsed).toBe(2);
    expect(res.path).toEqual([]);
    expect(res.note).toMatch(/falls into no top-level container/);
  });

  it('deadlineAt already in the past (now-injection): an honest time-budget note, not a call-budget one', async () => {
    const target = n('t:target', 'FRAME', { x: 0, y: 0, w: 1, h: 1 });
    const page = n('0:1', 'CANVAS', null, []);
    const api = buildApi(doc(page), new Map([[target.id, target]]));

    const res = await resolveAncestry(api, 'FILE', 't:target', { now: () => 1_000_000, deadlineAt: 999_000 });
    expect(res.confirmed).toBe(false);
    expect(res.callsUsed).toBe(1); // call1 (target id) happened; call2 was refused by the deadline
    expect(res.note).toMatch(/time budget/);
    expect((api.getDocumentRaw as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('target has no absoluteBoundingBox: throws an honest Error', async () => {
    const target: RawSceneNode = { id: 'nb:target', name: 'X', type: 'FRAME', absoluteBoundingBox: null, children: [] };
    const nodesById = new Map<string, RawSceneNode>([['nb:target', target]]);
    const api: Api = {
      getNodesRaw: vi.fn(async (_f: string, ids: string[]) => {
        const d = nodesById.get(ids[0]);
        return { nodes: d ? { [ids[0]]: { document: d } } : {} };
      }),
      getDocumentRaw: vi.fn(async () => { throw new Error('should not be reached'); }),
    } as unknown as Api;

    await expect(resolveAncestry(api, 'FILE', 'nb:target')).rejects.toThrow(/absoluteBoundingBox/);
  });

  it('compound targetId (semicolon and dash forms) — all comparisons use resolvedId, never the raw compound string', async () => {
    const resolvedPlainId = '56:7890';
    const compoundSemicolon = 'I12:340;56:7890';
    const compoundDash = 'I12-340;56-7890';
    const normalizedKey = 'I12:340;56:7890';

    // The mock deliberately returns document.id = plain, never an echo of the compound request id —
    // matching what the real REST API does.
    const targetDocForCompound: RawSceneNode = {
      id: resolvedPlainId, name: 'Instance target', type: 'INSTANCE',
      absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 }, children: [],
    };

    const topFrame = n(resolvedPlainId, 'FRAME', { x: 0, y: 0, w: 50, h: 50 });
    const page = n('0:1', 'CANVAS', null, [topFrame]);

    for (const targetId of [compoundSemicolon, compoundDash]) {
      const extra = new Map<string, RawSceneNode>([[normalizedKey, targetDocForCompound]]);
      const api = buildApi(doc(page), extra);
      const res = await resolveAncestry(api, 'FILE', targetId);
      expect(res.confirmed).toBe(true);
      expect(res.callsUsed).toBe(2); // caught by the skeleton step-0, same as a plain top-level frame
      expect(res.path.map((p) => p.id)).toEqual(['0:1']);
      expect(res.target.id).toBe(resolvedPlainId);
    }
  });

  it('rotated target and a rotated ancestor on the path both surface an honest note', async () => {
    const target = n('rot:target', 'FRAME', { x: 10, y: 10, w: 5, h: 5 }, [], 0.3);
    const frame = n('rot:frame', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [target], 0.5);
    const candidate = n('rot:cand', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [frame]);
    const page = n('0:1', 'CANVAS', null, [candidate]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', 'rot:target');
    expect(res.confirmed).toBe(true);
    expect(res.note).toMatch(/target is rotated/);
    expect(res.note).toMatch(/rotated container/);
  });

  it('backtracking after a dead grandchild branch does not re-fetch already-fetched nodes', async () => {
    // P (tier-0) → C (child, contains) → G (grandchild, contains) → no containing children.
    // descend(P) tries G first (grandchild-skip), it dies; backtracks to C — fetching C is NEW
    // info (reveals G's siblings' children), but from inside descend(C) the containing child G
    // must be skipped: its subtree is already known dead. Without dedupe G is fetched twice.
    const target = n('dd:target', 'FRAME', { x: 500, y: 500, w: 2, h: 2 });
    const g = n('dd:G', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 });
    const c = n('dd:C', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [g]);
    const p = n('dd:P', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [c]);
    const page = n('0:1', 'CANVAS', null, [p]);
    const api = buildApi(doc(page), new Map([[target.id, target]]));

    const res = await resolveAncestry(api, 'FILE', 'dd:target');
    expect(res.confirmed).toBe(false);
    expect(res.note).toMatch(/containment chain broke/);
    // call1 + call2 + probe(P) + fetch(G) + fetch(C); a 6th call (re-fetch of G) must not happen.
    expect(res.callsUsed).toBe(5);
    const gFetches = (api.getNodesRaw as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => (call[1] as string[])[0] === 'dd:G');
    expect(gFetches).toHaveLength(1);
  });

  it('probe fetch throws a network error: the sibling is still probed, outcome is honest-ambiguous with an unavailable-branches note', async () => {
    // Target actually lives under cand1 whose probe fails; cand2 is a containing decoy that leads
    // nowhere. The failure must kill only cand1's BRANCH — cand2 still gets probed — and the final
    // unconfirmed note must carry the network/time caveat on top of the geometric one.
    const target = n('nf:target', 'FRAME', { x: 500, y: 500, w: 2, h: 2 });
    const cand1 = n('nf:cand1', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [target]);
    const cand2 = n('nf:cand2', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 });
    const page = n('0:1', 'CANVAS', null, [cand1, cand2]);
    const failures = new Map<string, Error>([['nf:cand1', new FigmaApiError('network', 0, 'fetch failed')]]);
    const api = buildApi(doc(page), undefined, failures);

    const res = await resolveAncestry(api, 'FILE', 'nf:target');
    expect(res.confirmed).toBe(false);
    expect(res.callsUsed).toBe(4); // call1 + call2 + probe(cand1, failed but counted) + probe(cand2)
    expect(res.note).toMatch(/containment chain broke/);
    expect(res.note).toMatch(/some branches unavailable/);
    const probedIds = (api.getNodesRaw as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as string[])[0]);
    expect(probedIds).toContain('nf:cand2'); // the sibling was searched despite cand1's failure
  });

  it('descend fetch throws a timeout: backtracks to the sibling candidate and still confirms (no unavailable note on a proven path)', async () => {
    // P → C1 (containing decoy, empty), C2 → E → target. Descend order tries the containing
    // grandchild E first; its fetch times out. Backtracking must reach C1, then C2 — whose depth-2
    // fetch reveals E's children, confirming the target WITHOUT ever re-fetching the failed E.
    const target = n('tf:target', 'FRAME', { x: 500, y: 500, w: 2, h: 2 });
    const e = n('tf:E', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [target]);
    const c2 = n('tf:C2', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [e]);
    const c1 = n('tf:C1', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 });
    const p = n('tf:P', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [c1, c2]);
    const page = n('0:1', 'CANVAS', null, [p]);
    const failures = new Map<string, Error>([['tf:E', new FigmaApiError('network', 0, 'Figma API request timed out')]]);
    const api = buildApi(doc(page), undefined, failures);

    const res = await resolveAncestry(api, 'FILE', 'tf:target');
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBe(6); // call1 + call2 + probe(P) + E(failed) + C1 + C2
    expect(res.path.map((x) => x.id)).toEqual(['0:1', 'tf:P', 'tf:C2', 'tf:E']);
    expect(res.note).toBeUndefined(); // id-proven path — a lost branch cannot have made it wrong
    const eFetches = (api.getNodesRaw as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => (c[1] as string[])[0] === 'tf:E');
    expect(eFetches).toHaveLength(1); // the failed branch is never retried
  });

  it('auth error mid-descent rethrows: the token is dead for the whole call', async () => {
    const target = n('af:target', 'FRAME', { x: 500, y: 500, w: 2, h: 2 });
    const cand = n('af:cand', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [target]);
    const page = n('0:1', 'CANVAS', null, [cand]);
    const failures = new Map<string, Error>([['af:cand', new FigmaApiError('auth', 401, 'invalid token')]]);
    const api = buildApi(doc(page), undefined, failures);

    await expect(resolveAncestry(api, 'FILE', 'af:target')).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  // ---- overlay bbox-clash: area-ranked candidates, per-branch budget caps, skeleton scan --

  it('overlay-clash repro (real geometry): a tiny true section on another page beats 3 document-earlier giants, one of which hides a bottomless false column', async () => {
    // Page A: 3 giant sections, all coincidentally containing the target's center (x≈39000). The
    // middle giant hides a LINEAR false column 8 levels deep — every level also contains the
    // center — mirroring the live-acceptance bug where document order sent the descent down this
    // column and it ate the entire 12-call budget before page B was even glanced at.
    const giant1 = n('A:giant1', 'FRAME', { x: 0, y: 0, w: 56448, h: 6844 }); // area ~386M
    const falseColumnBox = { x: 0, y: 0, w: 47837, h: 5652 }; // area ~270M
    const falseColumn = chain(
      ['A:gc1', 'A:gc2', 'A:gc3', 'A:gc4', 'A:gc5', 'A:gc6', 'A:gc7', 'A:gc8'],
      falseColumnBox,
    ); // 8 levels deep, gc8 a genuine dead end — no target anywhere in this subtree
    const giant2 = n('A:giant2', 'SECTION', falseColumnBox, [falseColumn]);
    const giant3 = n('A:giant3', 'FRAME', { x: 35000, y: 0, w: 4277, h: 1549 }); // area ~6.6M
    const pageA = n('pageA', 'CANVAS', null, [giant1, giant2, giant3]);

    // Page B: the TRUE section — smallest area of all 4 containing candidates — 5 levels down to
    // the target (desktop → content → page → points → target).
    const trueBox = { x: 37000, y: 500, w: 4000, h: 1200 }; // area 4.8M — smaller than every giant
    const target = n('B:target', 'TEXT', { x: 38998, y: 998, w: 4, h: 4 }); // center (39000, 1000)
    const trueDescent = chain(['B:desktop', 'B:content', 'B:page', 'B:points'], trueBox, [target]);
    const trueSection = n('B:section', 'SECTION', trueBox, [trueDescent]);
    const pageB = n('pageB', 'CANVAS', null, [trueSection]);

    const root = n('0:0', 'DOCUMENT', null, [pageA, pageB]); // page A (the giants) declared FIRST
    const api = buildApi(root);

    const res = await resolveAncestry(api, 'FILE', 'B:target', { maxCalls: 12 });
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBeLessThanOrEqual(12);
    expect(res.path.map((p) => p.id)).toEqual([
      'pageB', 'B:section', 'B:desktop', 'B:content', 'B:page', 'B:points',
    ]);
    expect(res.path.some((p) => p.id.startsWith('A:'))).toBe(false); // never descends into page A's giants
  });

  it('per-branch budget cap: a bottomless false branch parks instead of eating the whole budget; the true branch (tried second) still confirms', async () => {
    const box = { x: 0, y: 0, w: 1000, h: 1000 };
    const falseIds = Array.from({ length: 20 }, (_, i) => `fb${i + 1}`);
    const falseBranch = chain(falseIds, box); // fb1 -> fb2 -> ... -> fb20, fb20 a genuine dead end
    const falseTier0 = n('false:tier0', 'FRAME', box, [falseBranch]);

    const target = n('true:target', 'TEXT', { x: 499, y: 499, w: 2, h: 2 });
    const t2 = n('true:t2', 'FRAME', box, [target]);
    const t1 = n('true:t1', 'FRAME', box, [t2]);
    const trueTier0 = n('true:tier0', 'FRAME', box, [t1]);

    const page = n('0:1', 'CANVAS', null, [falseTier0, trueTier0]); // false branch declared FIRST (same area — tie-break keeps it first, exercising the cap rather than area-ranking)
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', 'true:target', { maxCalls: 8 });
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBe(7);
    expect(res.path.map((p) => p.id)).toEqual(['0:1', 'true:tier0', 'true:t1', 'true:t2']);
    expect(res.path.some((p) => p.id.startsWith('fb'))).toBe(false); // the bottomless branch never makes it into the path
  });

  it('area-ranking: a small true tier-0 candidate descends BEFORE a document-earlier giant, even though the giant is declared first', async () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    const target = n('small:target', 'TEXT', { x: 49, y: 49, w: 2, h: 2 });
    const s2 = n('small:s2', 'FRAME', box, [target]);
    const s1 = n('small:s1', 'FRAME', box, [s2]);
    const smallTier0 = n('small:tier0', 'FRAME', box, [s1]);

    const giantBox = { x: 0, y: 0, w: 10000, h: 10000 };
    const g1 = n('giant:g1', 'FRAME', giantBox); // a short decoy — would still cost a call if ever explored
    const giantTier0 = n('giant:tier0', 'FRAME', giantBox, [g1]);

    const page = n('0:1', 'CANVAS', null, [giantTier0, smallTier0]); // giant declared FIRST (document order)
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', 'small:target');
    expect(res.confirmed).toBe(true);
    expect(res.path.map((p) => p.id)).toEqual(['0:1', 'small:tier0', 'small:s1', 'small:s2']);
    // call1 + call2 + probe(giant) + probe(small) + fetch(s2) = 5 — area-ranked descent never enters
    // the giant's own subtree at all (0 extra calls for it), which is exactly what a document-order
    // descent (giant tried first) would NOT have achieved for free.
    expect(res.callsUsed).toBe(5);
    expect(res.path.some((p) => p.id.startsWith('giant'))).toBe(false);
  });

  it('skeleton scan respects depth-2: a tier-0 target confirms from the skeleton alone (callsUsed=2, no descent); a level-3 target is NOT skeleton-confirmable and needs a probe', async () => {
    // A depth-FAITHFUL getDocumentRaw mock — it truncates the tree to the requested depth exactly
    // like the real /files?depth=N endpoint (depth=2 -> pages + tier-0, tier-0's children stripped).
    // The prior version of this test ignored the depth argument and returned the whole tree, so it
    // stayed green whether SKELETON_DEPTH was 2 or 4 — false confidence. This version fails loudly if
    // the skeleton ever silently deepens: at depth 4 the level-3 target below would be confirmed by
    // the id-scan at callsUsed=2, breaking the callsUsed=3 (probe) assertion.
    const child = n('sk:child', 'TEXT', { x: 500, y: 500, w: 2, h: 2 }); // tier-0's direct child (level 3)
    const topFrame = n('sk:top', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, [child]); // tier-0 (level 2)
    const page = n('0:1', 'CANVAS', null, [topFrame]);
    const root = doc(page);

    const nodesById = new Map<string, RawSceneNode>();
    registerTree(nodesById, root); // per-node getNodesRaw slices are depth-2, as everywhere else
    const getNodesRaw = vi.fn(async (_f: string, ids: string[]) => {
      const d = nodesById.get(ids[0]);
      return { nodes: d ? { [ids[0]]: { document: d } } : {} };
    });
    const getDocumentRaw = vi.fn(async (_f: string, depth = 2) => ({
      name: 'f', lastModified: '', version: '1', document: sliceToDepth(root, depth),
    }));
    const api: Api = { getNodesRaw, getDocumentRaw } as unknown as Api;

    // (a) tier-0 frame itself IS in the depth-2 skeleton -> the id-scan confirms it with NO descent.
    const top = await resolveAncestry(api, 'FILE', 'sk:top');
    expect(top.confirmed).toBe(true);
    expect(top.callsUsed).toBe(2);
    expect(top.path.map((p) => p.id)).toEqual(['0:1']);
    expect(getNodesRaw.mock.calls.length).toBe(1); // only call-1 (target id/bbox) — the scan needed no probe

    getNodesRaw.mockClear();
    getDocumentRaw.mockClear();

    // (b) tier-0's child is NOT in the depth-2 skeleton (its children are stripped), so the id-scan
    // cannot see it — it is reached by a probe of tier-0 instead: callsUsed=3, not a 2-call hit.
    const kid = await resolveAncestry(api, 'FILE', 'sk:child');
    expect(kid.confirmed).toBe(true);
    expect(kid.callsUsed).toBe(3); // call-1 + skeleton + probe(sk:top)
    expect(kid.path.map((p) => p.id)).toEqual(['0:1', 'sk:top']);
    const probedIds = getNodesRaw.mock.calls.map((c) => (c[1] as string[])[0]);
    expect(probedIds).toContain('sk:top'); // a real probe fetch happened — the confirm was not from the skeleton
  });

  it('second round: the true branch itself parks (needs more than one round-1 fair share) and a later round finishes it, while a persistent decoy never resolves', async () => {
    // 3 same-area tier-0 candidates, document order [decoyA, trueTier0, decoyB]:
    //  - decoyA: a 20-level dead-end chain — deep enough that it NEVER fully resolves within the
    //    rounds this test needs; per-branch caps mean it only ever nibbles at its own share.
    //  - trueTier0: an 11-level chain to the target (cost 5 fetches via grandchild-skip) — deeper
    //    than a single round's fair 3-way (then 2-way) share, so round 1 parks it partway and a
    //    later round finishes it off from the cached frontier (fetchedIds-cache makes that free).
    //  - decoyB: childless — resolves (dies) for 0 calls, so it never eats into anyone's share.
    // At maxCalls=15 this repro genuinely needs the round mechanism: the OLD (pre-fix) engine, which
    // explores branches to full completion in document order with no cap, sinks its ENTIRE budget
    // into decoyA's 20-level dead end and never even reaches trueTier0.
    const box = { x: 0, y: 0, w: 1000, h: 1000 };
    const decoyAIds = Array.from({ length: 20 }, (_, i) => `decoyA:${i + 1}`);
    const decoyABranch = chain(decoyAIds, box);
    const decoyA = n('decoyA:tier0', 'FRAME', box, [decoyABranch]);

    const target = n('true:target', 'TEXT', { x: 500, y: 500, w: 2, h: 2 });
    const trueIds = Array.from({ length: 11 }, (_, i) => `true:${i + 1}`); // true:11's child = target
    const trueBranch = chain(trueIds, box, [target]);
    const trueTier0 = n('true:tier0', 'FRAME', box, [trueBranch]);

    const decoyB = n('decoyB:tier0', 'FRAME', box); // childless — resolves for free

    const page = n('0:1', 'CANVAS', null, [decoyA, trueTier0, decoyB]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', 'true:target', { maxCalls: 15 });
    expect(res.confirmed).toBe(true);
    expect(res.callsUsed).toBeLessThanOrEqual(15);
    expect(res.path.map((p) => p.id)).toEqual([
      '0:1', 'true:tier0', 'true:1', 'true:2', 'true:3', 'true:4', 'true:5',
      'true:6', 'true:7', 'true:8', 'true:9', 'true:10', 'true:11',
    ]);
    expect(res.path.some((p) => p.id.startsWith('decoyA'))).toBe(false); // the persistent decoy never makes it into the path
  });

  it('deep node past the card level: probe-tax from many colliding giants starves the 12-budget but fits 16', async () => {
    // 8 giant tier-0 sections that all coincidentally contain the target's center (the overlay
    // coordinate-collision), plus the TRUE section on another page. Probe-first fetches all 9
    // containing tier-0 (calls 3..11) before any descent — the exact probe-tax that leaves only a
    // sliver of a 12-budget for a target six levels below its section.
    const center = { x: 39000, y: 1000 };
    const giants = Array.from({ length: 8 }, (_, i) =>
      n(`A:g${i}`, 'FRAME', { x: 0, y: 0, w: 60000, h: 6000 - i }), // all huge, all contain center, all dead
    );
    const pageA = n('pageA', 'CANVAS', null, giants);

    const trueBox = { x: 37000, y: 500, w: 4000, h: 1200 }; // area 4.8M — smaller than every giant → probed & descended first
    const target = n('T:target', 'TEXT', { x: center.x - 2, y: center.y - 2, w: 4, h: 4 });
    const trueDescent = chain(['T:section', 'T:1', 'T:2', 'T:3', 'T:4', 'T:5'], trueBox, [target]);
    const pageB = n('pageB', 'CANVAS', null, [trueDescent]);

    const root = n('0:0', 'DOCUMENT', null, [pageA, pageB]);
    const api = buildApi(root);

    // Explicit 12-budget: probe eats calls 3..11, the descent gets one fetch (T:2, call 12) and is then
    // cut off before the confirming fetch — an honest confirmed:false. This leg is the boundary anchor
    // and passes both before and after the constant change.
    const at12 = await resolveAncestry(api, 'FILE', 'T:target', { maxCalls: 12 });
    expect(at12.confirmed).toBe(false);

    // DEFAULT budget (no maxCalls): RED at the old default 12, GREEN at the new default 16 — the descent
    // now affords both grandchild-steps (T:2 call 12, T:4 call 13) and confirms.
    const atDefault = await resolveAncestry(api, 'FILE', 'T:target');
    expect(atDefault.confirmed).toBe(true);
    expect(atDefault.callsUsed).toBe(13);
    expect(atDefault.path.map((p) => p.id)).toEqual(['pageB', 'T:section', 'T:1', 'T:2', 'T:3', 'T:4', 'T:5']);
    expect(atDefault.path.some((p) => p.id.startsWith('A:'))).toBe(false);
  });

  it('fallback prefers the session-related branch over a longer unrelated one (bbox-collision)', async () => {
    // Target lives on the "30872" screen but is unreachable in the fetchable tree (buried past budget),
    // forcing the fallback. Two tier-0 both contain its center: a SHORT related branch (30872:*) and a
    // LONG unrelated one (26784:* — the "paper" collision). Length alone would return the long paper
    // chain; session-affinity must return the related tail instead.
    const box = { x: 0, y: 0, w: 1000, h: 1000 };
    const related = chain(['30872:s1', '30872:s2'], box); // affine, short, dead
    const paper = chain(['26784:p1', '26784:p2', '26784:p3', '26784:p4', '26784:p5', '26784:p6'], box); // disaffine, long, dead
    const page = n('0:1', 'CANVAS', null, [related, paper]);
    // Target resolvable at call-1 (has a bbox) but NOT part of either descent subtree → never confirmed.
    const extra = new Map<string, RawSceneNode>([
      ['30872:target', n('30872:target', 'TEXT', { x: 499, y: 499, w: 2, h: 2 })],
    ]);
    const api = buildApi(doc(page), extra);

    const res = await resolveAncestry(api, 'FILE', '30872:target', { maxCalls: 16 });
    expect(res.confirmed).toBe(false);
    expect(res.path.some((p) => p.id.startsWith('26784:'))).toBe(false); // NOT the long paper chain
    expect(res.path[res.path.length - 1].id.startsWith('30872:')).toBe(true); // the session-related tail
  });

  it('time-budget fallback also returns the session-related tail, not the longer unrelated one', async () => {
    const box = { x: 0, y: 0, w: 1000, h: 1000 };
    const related = chain(['30872:s1', '30872:s2'], box); // affine, short (area tie → document order: first)
    const paper = chain(['26784:p1', '26784:p2', '26784:p3', '26784:p4', '26784:p5'], box); // disaffine, long
    const page = n('0:1', 'CANVAS', null, [related, paper]);
    const extra = new Map<string, RawSceneNode>([
      ['30872:target', n('30872:target', 'TEXT', { x: 499, y: 499, w: 2, h: 2 })],
    ]);
    // Deadline keyed to the count of REAL getNodesRaw fetches — robust, independent of stopReason
    // bookkeeping (a blind tick counter mis-fires because cached-recursion skips the stopReason check).
    // It fires before the 6th fetch (target, s1, p1, s2, p3 done — 5 fetches): the related branch is
    // fully resolved (recorded, len 3) and paper has recorded a LONGER non-affine path (len 5), then
    // time cuts off.
    const base = buildApi(doc(page), extra);
    let fetches = 0;
    const api = {
      getDocumentRaw: base.getDocumentRaw,
      getNodesRaw: vi.fn(async (f: string, ids: string[], d?: number) => {
        fetches++;
        return (base.getNodesRaw as unknown as (f: string, ids: string[], d?: number) => Promise<unknown>)(f, ids, d);
      }),
    } as unknown as Api;
    const now = () => (fetches >= 5 ? 1000 : 0);

    const res = await resolveAncestry(api, 'FILE', '30872:target', { maxCalls: 16, deadlineAt: 1000, now });
    expect(res.confirmed).toBe(false);
    expect(res.note).toContain('time budget'); // NOTE_BUDGET_TIME ('time budget exhausted…') — the deadline genuinely fires
    expect(res.path.some((p) => p.id.startsWith('26784:'))).toBe(false);
    expect(res.path[res.path.length - 1].id.startsWith('30872:')).toBe(true);
  });

  it('compound ancestor id in the tail: session prefix strips the leading I (I30872:…;… clusters with the plain 30872 target)', async () => {
    // Realistic shape: resolvedId is PLAIN (the real REST API returns document.id plain even for a
    // compound REQUEST id — mirrored by the existing "compound targetId" test). So sessionPrefixOf's
    // I-stripping is exercised where it actually matters in prod — on an ANCESTOR node inside an
    // instance-override tree, whose id is compound — not on the target's own resolved id.
    const box = { x: 0, y: 0, w: 1000, h: 1000 };
    const relLeaf = n('I30872:96360;12798:99', 'FRAME', box); // compound-id ancestor tail — must strip 'I' → "30872"
    const related = n('30872:inst', 'INSTANCE', box, [relLeaf]);
    const paper = chain(['26784:p1', '26784:p2', '26784:p3', '26784:p4', '26784:p5', '26784:p6'], box); // longer, disaffine
    const page = n('0:1', 'CANVAS', null, [related, paper]);
    // Call-1 requests the compound id; the mock returns document.id = PLAIN '30872:96367' → resolvedId plain.
    const compoundReqId = 'I30872:96367;12798:75246';
    const extra = new Map<string, RawSceneNode>([
      [compoundReqId, n('30872:96367', 'FRAME', { x: 499, y: 499, w: 2, h: 2 })],
    ]);
    const api = buildApi(doc(page), extra);

    const res = await resolveAncestry(api, 'FILE', compoundReqId, { maxCalls: 16 });
    expect(res.confirmed).toBe(false);
    // Fallback returns the compound-id ancestor branch (strip-I clusters it with the '30872' target),
    // NOT the longer '26784' paper chain that raw length would have picked.
    expect(res.path.some((p) => p.id.startsWith('26784:'))).toBe(false);
    expect(res.path[res.path.length - 1].id).toBe('I30872:96360;12798:99');
  });

  it('no session-related branch: fallback degrades to the old longest-path behavior (no regression)', async () => {
    // Nothing shares the target's prefix → affinity is inert → the longest recorded path wins, exactly
    // as before this change.
    const box = { x: 0, y: 0, w: 1000, h: 1000 };
    const longBranch = chain(['99:1', '99:2', '99:3'], box); // disaffine (target is 30872:*); leaf 99:3
    const page = n('0:1', 'CANVAS', null, [longBranch]);
    const extra = new Map<string, RawSceneNode>([
      ['30872:target', n('30872:target', 'TEXT', { x: 499, y: 499, w: 2, h: 2 })],
    ]);
    const api = buildApi(doc(page), extra);

    const res = await resolveAncestry(api, 'FILE', '30872:target', { maxCalls: 16 });
    expect(res.confirmed).toBe(false);
    // deepest recorded wins (old length rule), unchanged — descend records up to the fetched leaf 99:3
    expect(res.path.map((p) => p.id)).toEqual(['0:1', '99:1', '99:2', '99:3']);
  });

  // ---- convergence-ordered branch scheduling (wave 3) ------------------------------------------

  it('time-abort records the converging (session-related) branch, not the wide collision branch', async () => {
    // The club tier-0 is NON-affine ("clubwrap:section") and LARGER in area than the paper tier-0, so
    // the OLD tier-0-area order descends paper first and a mid-descent deadline records the wide paper
    // branch. The club branch CONVERGES (its probed descendants are far tighter than paper's), so the
    // new convergence order descends it first — the deadline then records a club (30872) tail instead.
    const target = n('30872:target', 'TEXT', { x: 995, y: 995, w: 4, h: 4 }); // center (997,997)
    const points = n('30872:points', 'FRAME', { x: 800, y: 800, w: 400, h: 400 }, [target]);
    const dd = n('30872:d', 'FRAME', { x: 750, y: 750, w: 500, h: 500 }, [points]);
    const cc = n('30872:c', 'FRAME', { x: 700, y: 700, w: 600, h: 600 }, [dd]);
    const content = n('30872:content', 'FRAME', { x: 600, y: 600, w: 800, h: 800 }, [cc]);
    const clubSection = n('clubwrap:section', 'SECTION', { x: 0, y: 0, w: 2200, h: 2200 }, [content]); // non-affine, larger area
    const paperF2 = n('26784:f2', 'FRAME', { x: 0, y: 0, w: 1800, h: 1800 });
    const paperF1 = n('26784:f1', 'FRAME', { x: 0, y: 0, w: 1900, h: 1900 }, [paperF2]);
    const paperSection = n('26784:section', 'SECTION', { x: 0, y: 0, w: 2100, h: 2100 }, [paperF1]); // smaller area → OLD order descends it first
    const page = n('0:1', 'CANVAS', null, [clubSection, paperSection]);
    const base = buildApi(doc(page));
    let fetches = 0;
    const api = {
      getDocumentRaw: base.getDocumentRaw,
      getNodesRaw: vi.fn(async (f: string, ids: string[], dp?: number) => {
        fetches++;
        return (base.getNodesRaw as unknown as (f: string, ids: string[], dp?: number) => Promise<unknown>)(f, ids, dp);
      }),
    } as unknown as Api;
    // Fetches: target(1), probe paper(2), probe club(3), descend one club node(4) → deadline before the
    // 5th fetch, after a club tail is recorded but before confirm.
    const now = () => (fetches >= 4 ? 1000 : 0);
    const res = await resolveAncestry(api, 'FILE', '30872:target', { maxCalls: 16, deadlineAt: 1000, now });
    expect(res.confirmed).toBe(false);
    expect(res.note).toContain('time budget'); // NOTE_BUDGET_TIME
    expect(res.path.some((p) => p.id.startsWith('26784:'))).toBe(false); // never the wide paper branch
    expect(res.path[res.path.length - 1].id.startsWith('30872:')).toBe(true); // a converging club tail
  });

  it('convergence order descends the tight branch first even when its tier-0 is larger', async () => {
    // Club tier-0 (2000²) is LARGER than the decoy tier-0 (1500²), so the old area order descends the
    // decoy first and wastes calls. Club CONVERGES (points 400²) far tighter than any decoy node, so
    // convergence order dives club and confirms without ever descending the decoy.
    const target = n('30872:target', 'TEXT', { x: 995, y: 995, w: 4, h: 4 });
    const points = n('30872:points', 'FRAME', { x: 800, y: 800, w: 400, h: 400 }, [target]);
    const content = n('30872:content', 'FRAME', { x: 600, y: 600, w: 800, h: 800 }, [points]);
    const clubSection = n('30872:section', 'SECTION', { x: 0, y: 0, w: 2000, h: 2000 }, [content]);
    const dF2 = n('26784:f2', 'FRAME', { x: 0, y: 0, w: 1300, h: 1300 });
    const dF1 = n('26784:f1', 'FRAME', { x: 0, y: 0, w: 1400, h: 1400 }, [dF2]);
    const decoySection = n('26784:section', 'SECTION', { x: 0, y: 0, w: 1500, h: 1500 }, [dF1]);
    const page = n('0:1', 'CANVAS', null, [clubSection, decoySection]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', '30872:target', { maxCalls: 16 });
    expect(res.confirmed).toBe(true);
    expect(res.path.map((p) => p.id)).toEqual(['0:1', '30872:section', '30872:content', '30872:points']);
    expect(res.path.some((p) => p.id.startsWith('26784:'))).toBe(false);
    expect(res.callsUsed).toBe(5); // target+skeleton+probe(decoy)+probe(club)+fetch(points) — decoy never descended
  });

  it('a tight-but-false section is scheduled early, capped, and abandoned; the true branch still confirms', async () => {
    // A small false section (tightest convergence) sorts first, is descended, dead-ends, and the caps
    // move on to the true converging branch. Guard: correct on both old and new ordering.
    const target = n('30872:target', 'TEXT', { x: 995, y: 995, w: 4, h: 4 });
    const points = n('30872:points', 'FRAME', { x: 800, y: 800, w: 400, h: 400 }, [target]);
    const content = n('30872:content', 'FRAME', { x: 600, y: 600, w: 800, h: 800 }, [points]);
    const trueSection = n('30872:section', 'SECTION', { x: 0, y: 0, w: 2000, h: 2000 }, [content]);
    const falseChild = n('26784:fchild', 'FRAME', { x: 900, y: 900, w: 200, h: 200 });
    const falseSection = n('26784:section', 'SECTION', { x: 850, y: 850, w: 300, h: 300 }, [falseChild]);
    const page = n('0:1', 'CANVAS', null, [trueSection, falseSection]);
    const api = buildApi(doc(page));

    const res = await resolveAncestry(api, 'FILE', '30872:target', { maxCalls: 16 });
    expect(res.confirmed).toBe(true);
    expect(res.path.map((p) => p.id)).toEqual(['0:1', '30872:section', '30872:content', '30872:points']);
    expect(res.path.some((p) => p.id.startsWith('26784:'))).toBe(false);
  });
});
