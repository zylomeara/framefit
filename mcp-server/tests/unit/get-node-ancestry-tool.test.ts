import { describe, it, expect, vi } from 'vitest';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { AncestryResult } from '../../src/application/node-ancestry.js';

// This file tests the TOOL's formatting layer (breadcrumbs/children/sort/cap/query_hits/ambiguous),
// not the ancestry descent itself (that's node-ancestry.test.ts). Mocking resolveAncestry
// directly — rather than a lower-level fake api — is the honest split here: this file controls the
// exact `path`/`confirmed`/`note` the engine hands back and asserts what the tool does with it.
//
// NOTE: vi.mock at a module boundary is a DELIBERATE deviation from the repo's tool-test convention
// (every other tool test injects a fake api via deps.buildApi; this is the only tool test in the
// suite that module-mocks). Rationale: driving the formatting layer through a fake api would force
// re-simulating the engine's descent (probe-first, grandchild-skip, budget) just to produce a given
// `path` — duplicating node-ancestry.test.ts fixtures while testing nothing new about the descent. The trade-off
// is that this boundary can't catch argument swaps by type alone, so the wiring test below pins the
// EXACT resolveAncestry call arguments (fileKey and normalized node id are both strings — TS won't
// flag a swap).
const resolveAncestryMock = vi.fn();
vi.mock('../../src/application/node-ancestry.js', () => ({
  resolveAncestry: (...args: unknown[]) => resolveAncestryMock(...args),
}));

import {
  registerGetNodeAncestryTool,
  ANCESTRY_CHILDREN_CAP,
} from '../../src/adapters/driving/tools/get-node-ancestry-tool.js';
import { makeFakeMcpServer, type ToolHandler, type ToolResult } from '../helpers/fake-mcp-server.js';

function install(): ToolHandler {
  const { server, call } = makeFakeMcpServer();
  const api = {};
  const deps = {
    buildApi: () => api as never,
    defaultToken: 't',
    logger: { warn() {}, info() {} } as never,
  };
  registerGetNodeAncestryTool(server, deps as never);
  return (a: Record<string, unknown>) => call('get_node_ancestry', a);
}

function n(
  id: string,
  type: string,
  box: { x: number; y: number; w: number; h: number } | null,
  children: RawSceneNode[] = [],
  extra: Partial<RawSceneNode> = {},
): RawSceneNode {
  return {
    id,
    name: id,
    type,
    absoluteBoundingBox: box ? { x: box.x, y: box.y, width: box.w, height: box.h } : null,
    children,
    ...extra,
  } as RawSceneNode;
}

function named(id: string, name: string, type: string, box: { x: number; y: number; w: number; h: number } | null, extra: Partial<RawSceneNode> = {}): RawSceneNode {
  return { ...n(id, type, box, [], extra), name };
}

function parseOutput(res: ToolResult): Record<string, unknown> {
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

function mockResult(result: AncestryResult): void {
  resolveAncestryMock.mockReset();
  resolveAncestryMock.mockResolvedValue(result);
}

describe('get_node_ancestry tool', () => {
  it('happy path: breadcrumbs for every path node, each with its own children; last breadcrumb marks target isTarget', async () => {
    const target = named('30:1', 'Target', 'TEXT', { x: 100, y: 100, w: 10, h: 10 });
    const sibling = named('30:2', 'Sibling', 'FRAME', { x: 200, y: 100, w: 10, h: 10 });
    const frame = named('20:1', 'Frame', 'FRAME', { x: 0, y: 0, w: 500, h: 500 }, { children: [target, sibling] });
    const section = named('10:1', 'Section', 'SECTION', { x: 0, y: 0, w: 1000, h: 1000 }, { children: [frame] });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [section] });

    mockResult({
      target: { id: '30:1', name: 'Target', type: 'TEXT', w: 10, h: 10 },
      path: [page, section, frame],
      confirmed: true,
      callsUsed: 3,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC123', node_id: '30:1' }));

    expect(out.confirmed).toBe(true);
    expect(out.ambiguous).toBeUndefined();
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    expect(breadcrumbs.map((b) => b.id)).toEqual(['0:1', '10:1', '20:1']);

    // page (CANVAS) has no bbox -> w/h omitted
    expect(breadcrumbs[0].w).toBeUndefined();
    expect(breadcrumbs[0].h).toBeUndefined();
    expect((breadcrumbs[0].children as unknown[]).map((c: any) => c.id)).toEqual(['10:1']);
    expect((breadcrumbs[0].children as any[])[0].onPath).toBe(true);

    // section's children include frame (onPath) — document order (no auto-layout)
    expect((breadcrumbs[1].children as any[]).map((c: any) => c.id)).toEqual(['20:1']);
    expect((breadcrumbs[1].children as any[])[0].onPath).toBe(true);

    // frame's children: target (isTarget) + sibling, both listed with w/h
    const frameChildren = breadcrumbs[2].children as any[];
    expect(frameChildren.map((c) => c.id)).toEqual(['30:1', '30:2']);
    expect(frameChildren[0].isTarget).toBe(true);
    expect(frameChildren[0].onPath).toBeUndefined();
    expect(frameChildren[1].isTarget).toBeUndefined();
    expect(frameChildren[0]).toMatchObject({ w: 10, h: 10 });
  });

  it('auto-layout ancestor (HORIZONTAL) sorts children by x; a child with no bbox falls to the tail in document order', async () => {
    const target = named('t', 'Target', 'FRAME', { x: 500, y: 0, w: 5, h: 5 });
    const right = named('right', 'Right', 'FRAME', { x: 300, y: 0, w: 5, h: 5 });
    const left = named('left', 'Left', 'FRAME', { x: 10, y: 0, w: 5, h: 5 });
    const noBox = named('nobox', 'NoBox', 'FRAME', null);
    const row = named('row', 'Row', 'FRAME', { x: 0, y: 0, w: 1000, h: 100 }, {
      layoutMode: 'HORIZONTAL',
      children: [right, noBox, left, target], // deliberately out of x-order, noBox in the middle
    });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [row] });

    mockResult({
      target: { id: 't', name: 'Target', type: 'FRAME', w: 5, h: 5 },
      path: [page, row],
      confirmed: true,
      callsUsed: 2,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 't' }));
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    const rowChildren = breadcrumbs[1].children as any[];
    // sorted by x: left(10), right(300), target(500) — noBox (no bbox) tails in ORIGINAL doc order
    expect(rowChildren.map((c) => c.id)).toEqual(['left', 'right', 't', 'nobox']);
  });

  it('auto-layout ancestor (VERTICAL) sorts children by y', async () => {
    const target = named('t', 'Target', 'FRAME', { x: 0, y: 500, w: 5, h: 5 });
    const bottom = named('bottom', 'Bottom', 'FRAME', { x: 0, y: 300, w: 5, h: 5 });
    const top = named('top', 'Top', 'FRAME', { x: 0, y: 10, w: 5, h: 5 });
    const col = named('col', 'Col', 'FRAME', { x: 0, y: 0, w: 100, h: 1000 }, {
      layoutMode: 'VERTICAL',
      children: [bottom, target, top], // deliberately out of y-order
    });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [col] });

    mockResult({
      target: { id: 't', name: 'Target', type: 'FRAME', w: 5, h: 5 },
      path: [page, col],
      confirmed: true,
      callsUsed: 2,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 't' }));
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    const colChildren = breadcrumbs[1].children as any[];
    expect(colChildren.map((c) => c.id)).toEqual(['top', 'bottom', 't']); // by y: 10, 300, 500
  });

  it('non-auto-layout ancestor (layoutMode NONE/absent): strict document order regardless of x/y', async () => {
    const target = named('t', 'Target', 'FRAME', { x: 0, y: 0, w: 5, h: 5 });
    const a = named('a', 'A', 'FRAME', { x: 900, y: 900, w: 5, h: 5 }); // geometrically "last"
    const b = named('b', 'B', 'FRAME', { x: 1, y: 1, w: 5, h: 5 });
    const plain = named('plain', 'Plain', 'FRAME', { x: 0, y: 0, w: 1000, h: 1000 }, {
      children: [a, b, target], // document order: a, b, target — no layoutMode set
    });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [plain] });

    mockResult({
      target: { id: 't', name: 'Target', type: 'FRAME', w: 5, h: 5 },
      path: [page, plain],
      confirmed: true,
      callsUsed: 2,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 't' }));
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    const children = breadcrumbs[1].children as any[];
    expect(children.map((c) => c.id)).toEqual(['a', 'b', 't']); // untouched document order
  });

  it('hidden / absolute-positioned / zero-size children are PRESENT in children (no inFlowChildren filter)', async () => {
    const target = named('zero', 'ZeroTarget', 'FRAME', { x: 0, y: 0, w: 0, h: 0 }); // zero-size target
    const hidden = named('hidden', 'Hidden', 'FRAME', { x: 10, y: 10, w: 5, h: 5 }, { visible: false });
    const abs = named('abs', 'Abs', 'FRAME', { x: 20, y: 20, w: 5, h: 5 }, { layoutPositioning: 'ABSOLUTE' });
    const parent = named('parent', 'Parent', 'FRAME', { x: 0, y: 0, w: 100, h: 100 }, {
      children: [target, hidden, abs],
    });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [parent] });

    mockResult({
      target: { id: 'zero', name: 'ZeroTarget', type: 'FRAME', w: 0, h: 0 },
      path: [page, parent],
      confirmed: true,
      callsUsed: 2,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 'zero' }));
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    const children = breadcrumbs[1].children as any[];
    expect(children.map((c) => c.id)).toEqual(['zero', 'hidden', 'abs']);
    expect(children[0].isTarget).toBe(true);
    expect(children[0]).toMatchObject({ w: 0, h: 0 }); // zero-size target IS visible with its real box
  });

  it('cap: an ancestor with >15 children is truncated, and childrenTotal/childrenTruncated report the overflow honestly', async () => {
    const kids = Array.from({ length: 20 }, (_, i) => named(`k${i}`, `Kid${i}`, 'FRAME', { x: i, y: 0, w: 1, h: 1 }));
    const parent = named('parent', 'Parent', 'FRAME', { x: 0, y: 0, w: 100, h: 100 }, {
      layoutMode: 'HORIZONTAL',
      children: kids,
    });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [parent] });

    mockResult({
      target: { id: 'k0', name: 'Kid0', type: 'FRAME', w: 1, h: 1 },
      path: [page, parent],
      confirmed: true,
      callsUsed: 2,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 'k0' }));
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    expect(breadcrumbs[1].childrenTruncated).toBe(true);
    expect(breadcrumbs[1].childrenTotal).toBe(20);
    expect((breadcrumbs[1].children as any[]).length).toBe(ANCESTRY_CHILDREN_CAP);
  });

  it('reserved slot: target beyond the cap position STILL appears in its parent\'s children (isTarget survives the slice)', async () => {
    // 20 children in document order, target at index 17 — a plain slice(0, 15) would drop it.
    const kids = Array.from({ length: 20 }, (_, i) =>
      i === 17
        ? named('t', 'Target', 'FRAME', { x: 17, y: 0, w: 1, h: 1 })
        : named(`k${i}`, `Kid${i}`, 'FRAME', { x: i, y: 0, w: 1, h: 1 }));
    const parent = named('parent', 'Parent', 'FRAME', { x: 0, y: 0, w: 100, h: 100 }, { children: kids });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [parent] });

    mockResult({
      target: { id: 't', name: 'Target', type: 'FRAME', w: 1, h: 1 },
      path: [page, parent],
      confirmed: true,
      callsUsed: 2,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 't' }));
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    const children = breadcrumbs[1].children as any[];
    expect(children.length).toBe(ANCESTRY_CHILDREN_CAP); // reserve does not inflate the cap
    const targetRow = children.find((c) => c.isTarget);
    expect(targetRow).toBeDefined();
    expect(targetRow.id).toBe('t');
    expect(children[children.length - 1].id).toBe('t'); // sort order kept: reserved row stays where it sorts (after k0..k13)
    expect(breadcrumbs[1].childrenTruncated).toBe(true);
    expect(breadcrumbs[1].childrenTotal).toBe(20);
  });

  it('reserved slot: the onPath child beyond the cap survives on a NON-terminal breadcrumb (the chain link never disappears)', async () => {
    // Section with 20 children; the path continues via `card` at index 17.
    const card = named('card', 'Card', 'FRAME', { x: 17, y: 0, w: 10, h: 10 }, {
      children: [named('t', 'Target', 'TEXT', { x: 18, y: 1, w: 1, h: 1 })],
    });
    const kids = Array.from({ length: 20 }, (_, i) =>
      i === 17 ? card : named(`k${i}`, `Kid${i}`, 'FRAME', { x: i, y: 0, w: 1, h: 1 }));
    const section = named('sec', 'Section', 'SECTION', { x: 0, y: 0, w: 100, h: 100 }, { children: kids });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [section] });

    mockResult({
      target: { id: 't', name: 'Target', type: 'TEXT', w: 1, h: 1 },
      path: [page, section, card],
      confirmed: true,
      callsUsed: 3,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 't' }));
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    const sectionChildren = breadcrumbs[1].children as any[];
    expect(sectionChildren.length).toBe(ANCESTRY_CHILDREN_CAP);
    const cardRow = sectionChildren.find((c) => c.onPath);
    expect(cardRow).toBeDefined();
    expect(cardRow.id).toBe('card');
    expect(breadcrumbs[1].childrenTruncated).toBe(true);
    expect(breadcrumbs[1].childrenTotal).toBe(20);
  });

  it('query: substring case-insensitive across ALL breadcrumbs\' children (including beyond the cap), reports ancestor_id', async () => {
    const button = named('btn', 'Primary Button', 'FRAME', { x: 0, y: 0, w: 5, h: 5 });
    const target = named('t', 'Target', 'FRAME', { x: 10, y: 0, w: 5, h: 5 });
    const section = named('sec', 'Section', 'SECTION', { x: 0, y: 0, w: 100, h: 100 }, {
      children: [button, target],
    });
    const badge = named('badge', 'Notification Badge', 'FRAME', { x: 0, y: 0, w: 5, h: 5 });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [section, badge] });

    mockResult({
      target: { id: 't', name: 'Target', type: 'FRAME', w: 5, h: 5 },
      path: [page, section],
      confirmed: true,
      callsUsed: 2,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 't', query: 'button' }));
    expect(out.query_hits).toEqual([{ id: 'btn', name: 'Primary Button', ancestor_id: 'sec' }]);

    const out2 = parseOutput(await call({ file: 'ABC', node_id: 't', query: 'badge' }));
    // "badge" is a sibling PAGE-level node — page IS in the path, so it's searched too.
    expect(out2.query_hits).toEqual([{ id: 'badge', name: 'Notification Badge', ancestor_id: '0:1' }]);

    const out3 = parseOutput(await call({ file: 'ABC', node_id: 't', query: 'zzz-no-match' }));
    expect(out3.query_hits).toEqual([]);
  });

  it('ambiguous passthrough: confirmed:false surfaces ambiguous:true + the engine note, breadcrumbs built from the partial path', async () => {
    const child = named('c', 'Child', 'FRAME', { x: 0, y: 0, w: 5, h: 5 });
    const cand = named('cand', 'Cand', 'FRAME', { x: 0, y: 0, w: 100, h: 100 }, { children: [child] });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [cand] });

    mockResult({
      target: { id: 'missing', name: 'Missing', type: 'FRAME', w: 1, h: 1 },
      path: [page, cand],
      confirmed: false,
      callsUsed: 5,
      note: 'call budget exhausted (overlays/depth) — verify against the last ancestor\'s children',
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 'missing' }));
    expect(out.confirmed).toBe(false);
    expect(out.ambiguous).toBe(true);
    expect(out.note).toMatch(/call budget/);
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    expect(breadcrumbs.map((b) => b.id)).toEqual(['0:1', 'cand']);
  });

  it('path=[] (no first-tier candidate) -> breadcrumbs:[] and ambiguous:true', async () => {
    mockResult({
      target: { id: 'lost', name: 'Lost', type: 'FRAME', w: 1, h: 1 },
      path: [],
      confirmed: false,
      callsUsed: 2,
      note: 'the target center falls into no top-level container — non-standard layout or a stale bbox',
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 'lost' }));
    expect(out.breadcrumbs).toEqual([]);
    expect(out.ambiguous).toBe(true);
  });

  it('header-case killer: target inside card, section also has a headerFrame sibling — headerFrame is visible in the section breadcrumb\'s children', async () => {
    const target = named('cardtext', 'CardText', 'TEXT', { x: 10, y: 200, w: 50, h: 20 });
    const card = named('card', 'Card', 'FRAME', { x: 0, y: 100, w: 300, h: 200 }, { children: [target] });
    const headerFrame = named('header', 'HeaderFrame', 'FRAME', { x: 0, y: 0, w: 300, h: 80 });
    const section = named('section', 'Section', 'SECTION', { x: 0, y: 0, w: 300, h: 300 }, {
      children: [headerFrame, card], // headerFrame is NOT on the path to target, but IS a sibling of card
    });
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [section] });

    mockResult({
      target: { id: 'cardtext', name: 'CardText', type: 'TEXT', w: 50, h: 20 },
      path: [page, section, card],
      confirmed: true,
      callsUsed: 3,
    });

    const call = install();
    const out = parseOutput(await call({ file: 'ABC', node_id: 'cardtext' }));
    const breadcrumbs = out.breadcrumbs as Array<Record<string, unknown>>;
    const sectionBreadcrumb = breadcrumbs.find((b) => b.id === 'section')!;
    const sectionChildren = sectionBreadcrumb.children as any[];
    expect(sectionChildren.map((c) => c.id)).toContain('header');
    const headerEntry = sectionChildren.find((c) => c.id === 'header');
    expect(headerEntry).toMatchObject({ id: 'header', name: 'HeaderFrame', type: 'FRAME' });
    expect(headerEntry.isTarget).toBeUndefined();
    expect(headerEntry.onPath).toBeUndefined(); // header is a plain neighbor, not part of the chain
  });

  it('plumbs deadlineAt into buildApi and resolveAncestry using the toolTimeBudgetMs default/override', async () => {
    const page = named('0:1', 'Page', 'CANVAS', null, { children: [] });
    mockResult({
      target: { id: 't', name: 'T', type: 'FRAME', w: 1, h: 1 },
      path: [page],
      confirmed: true,
      callsUsed: 1,
    });

    const { server, call } = makeFakeMcpServer();
    const buildApi = vi.fn((_token: string, _timeoutMs?: number, _deadlineAt?: number) => ({}) as never);
    const deps = { buildApi, defaultToken: 'tok', logger: { warn() {}, info() {} } as never, toolTimeBudgetMs: 1234 };
    registerGetNodeAncestryTool(server, deps as never);

    const before = Date.now();
    await call('get_node_ancestry', { file: 'ABC123', node_id: '30-1' }); // dash-form id — normalization is part of the wiring
    expect(buildApi).toHaveBeenCalledTimes(1);
    const [token, timeoutMs, deadlineAt] = buildApi.mock.calls[0];
    expect(token).toBe('tok');
    expect(timeoutMs).toBeUndefined();
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 1234);

    // Exact-args assert: fileKey and node id are BOTH strings, so a positional swap would satisfy
    // the types — the vi.mock boundary only catches it if we pin every argument here.
    expect(resolveAncestryMock).toHaveBeenCalledTimes(1);
    expect(resolveAncestryMock).toHaveBeenCalledWith(
      expect.anything(),
      'ABC123',
      '30:1',
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    const [, , , opts] = resolveAncestryMock.mock.calls[0] as [unknown, string, string, { deadlineAt: number }];
    expect(opts.deadlineAt).toBe(deadlineAt);
  });
});
