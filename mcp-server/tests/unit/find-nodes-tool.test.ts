import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFindNodesTool } from '../../src/adapters/driving/tools/find-nodes-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';

const logger = createLogger({ level: 'silent' });

function harness(api: Partial<FigmaApi>, extraDeps: Partial<ToolDeps> = {}) {
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server = { tool: (n: string, _d: string, _s: unknown, h: (a: any) => Promise<any>) => { handlers[n] = h; } } as unknown as McpServer;
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
  return handlers.find_nodes;
}

const subtree = { id: '1:0', name: 'desktop', type: 'FRAME', children: [
  { id: '1:2', name: 'tabs', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 40 }, children: [
    { id: '1:3', name: 'Tab one', type: 'TEXT' },
  ] },
] };

describe('find_nodes tool — scoped (node_id)', () => {
  it('scopes to node_id and returns matches with path + size', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:0': { document: subtree } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', node_id: '1-0', query: 'tabs', depth: 6, limit: 20 });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:0'], 6);
    const out = JSON.parse(res.content[0].text);
    const hit = out.matches.find((m: any) => m.node_id === '1:2');
    expect(hit).toBeTruthy();
    expect(hit.path).toBe('desktop');
    expect(hit.size).toEqual({ w: 200, h: 40 });
  });

  it('returns an error when neither query nor type is provided', async () => {
    const run = harness({});
    const res = await run({ file: 'abc' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/provide query or type/i);
  });
});

// --- whole-file (no node_id): budgeted chunked search ------------------------------------
// Skeleton fetch is always getDocumentRaw(file, 2) — depth-2 gives page -> top-level-container,
// which is exactly the unit we chunk over. Per-container fetches use args.depth (the caller's
// requested search depth), one getNodesRaw([container.id]) call per top-level container.

function page(name: string, containers: { id: string; name: string }[]) {
  return {
    id: `page:${name}`, name, type: 'CANVAS',
    children: containers.map((c) => ({ id: c.id, name: c.name, type: 'FRAME' })),
  };
}

function skeletonOf(...pages: ReturnType<typeof page>[]) {
  return { name: 'F', lastModified: 'X', version: '1', document: { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: pages } };
}

describe('find_nodes tool — whole-file (chunked, budgeted)', () => {
  it('searches every container, aggregates matches, and reports complete coverage; a match on the container itself has no dangling breadcrumb arrow', async () => {
    const skeleton = skeletonOf(page('Board', [
      { id: '2:1', name: 'Alpha' },
      { id: '2:2', name: 'widget' },
      { id: '2:3', name: 'Gamma' },
    ]));
    const docs: Record<string, any> = {
      '2:1': { id: '2:1', name: 'Alpha', type: 'FRAME' },
      '2:2': { id: '2:2', name: 'widget', type: 'FRAME', children: [
        { id: '2:2:1', name: 'widget-detail', type: 'FRAME' },
      ] },
      '2:3': { id: '2:3', name: 'Gamma', type: 'FRAME' },
    };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: docs[ids[0]] } } }));
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'widget', depth: 6, limit: 20 });
    expect(getDocumentRaw).toHaveBeenCalledWith('abc', 2);
    expect(getNodesRaw).toHaveBeenCalledTimes(3);

    const out = JSON.parse(res.content[0].text);
    const self = out.matches.find((m: any) => m.node_id === '2:2');
    const nested = out.matches.find((m: any) => m.node_id === '2:2:1');
    expect(self).toBeTruthy();
    expect(self.path).toBe('Board'); // container itself matched — no trailing " › "
    expect(nested).toBeTruthy();
    expect(nested.path).toBe('Board › widget');

    expect(out.coverage).toEqual({ searched: 3, total: 3, skipped: [], skippedTotal: 0 });
  });

  it('skeleton-level matches: a query hitting a PAGE (CANVAS) name is found — chunks only search inside containers, but coverage claims completeness, so skeleton nodes must match too', async () => {
    const skeleton = skeletonOf(page('Checkout Flow', [
      { id: '10:1', name: 'Frame A' },
      { id: '10:2', name: 'Frame B' },
    ]));
    const docs: Record<string, any> = {
      '10:1': { id: '10:1', name: 'Frame A', type: 'FRAME' },
      '10:2': { id: '10:2', name: 'Frame B', type: 'FRAME' },
    };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: docs[ids[0]] } } }));
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'checkout', depth: 6, limit: 20 });
    const out = JSON.parse(res.content[0].text);
    const pageHit = out.matches.find((m: any) => m.node_id === 'page:Checkout Flow');
    expect(pageHit).toBeTruthy();
    expect(pageHit.type).toBe('CANVAS');
    expect(pageHit.path).toBe('Doc'); // skeleton paths are m.path as-is, rooted at the document
    // Full coverage stays truthful: every container was ALSO searched.
    expect(out.coverage).toEqual({ searched: 2, total: 2, skipped: [], skippedTotal: 0 });
  });

  it('skeleton-level matches: a query hitting a top-level container name yields exactly ONE match (skeleton hit and chunk-root hit dedupe by node_id)', async () => {
    const skeleton = skeletonOf(page('Board', [
      { id: '11:1', name: 'widget' },
      { id: '11:2', name: 'Other' },
    ]));
    const docs: Record<string, any> = {
      '11:1': { id: '11:1', name: 'widget', type: 'FRAME' },
      '11:2': { id: '11:2', name: 'Other', type: 'FRAME' },
    };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: docs[ids[0]] } } }));
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'widget', depth: 6, limit: 20 });
    const out = JSON.parse(res.content[0].text);
    expect(out.matches.filter((m: any) => m.node_id === '11:1')).toHaveLength(1);
    expect(out.matches[0].path).toBe('Board'); // the chunk-format path survives the dedupe
  });

  it('global ranking: an exact match in the 3rd container outranks noise from the 1st, even under a small limit — and the loop does not exit early before reaching it', async () => {
    // Matches live in CHILDREN (invisible to the depth-2 skeleton pass) — this test is about the
    // chunk loop's ranking. 2-term AND query so container 1's child is only a PARTIAL hit
    // (score < 1, "noise"), while container 3's child is a FULL hit (score === 1, "exact").
    const skeleton = skeletonOf(page('Page1', [
      { id: '3:1', name: 'C1' },
      { id: '3:2', name: 'C2' },
      { id: '3:3', name: 'C3' },
    ]));
    const docs: Record<string, any> = {
      '3:1': { id: '3:1', name: 'C1', type: 'FRAME', children: [
        { id: '3:1:1', name: 'blue box', type: 'FRAME' },   // noise: only 'blue' matches
      ] },
      '3:2': { id: '3:2', name: 'C2', type: 'FRAME' },      // no match at all
      '3:3': { id: '3:3', name: 'C3', type: 'FRAME', children: [
        { id: '3:9', name: 'blue card', type: 'FRAME' },    // exact: both terms match
      ] },
    };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: docs[ids[0]] } } }));
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'blue card', depth: 6, limit: 1 });
    // All 3 containers were fetched — the noise match in container 1 (score < 1) must NOT have
    // triggered the early-exit guard (that only fires on score===1 exact matches).
    expect(getNodesRaw).toHaveBeenCalledTimes(3);

    const out = JSON.parse(res.content[0].text);
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].node_id).toBe('3:9');
    expect(out.matches[0].score).toBe(1);
  });

  it('early exit: enough exact matches in the 1st container stop the loop — remaining containers are skipped, not searched', async () => {
    const skeleton = skeletonOf(page('Page1', [
      { id: '4:1', name: 'target' },
      { id: '4:2', name: 'Other2' },
      { id: '4:3', name: 'Other3' },
    ]));
    const docs: Record<string, any> = {
      '4:1': { id: '4:1', name: 'target', type: 'FRAME' },
      '4:2': { id: '4:2', name: 'Other2', type: 'FRAME' },
      '4:3': { id: '4:3', name: 'Other3', type: 'FRAME' },
    };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: docs[ids[0]] } } }));
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'target', depth: 6, limit: 1 });
    expect(getNodesRaw).toHaveBeenCalledTimes(1); // 2nd/3rd never fetched

    const out = JSON.parse(res.content[0].text);
    expect(out.coverage.searched).toBe(1);
    expect(out.coverage.total).toBe(3);
    expect(out.coverage.skipped.sort()).toEqual(['Other2', 'Other3']);
    expect(out.coverage.skippedTotal).toBe(2);
    expect(out.coverage.note).toMatch(/searched 1 of 3/i);
    expect(out.coverage.note).toMatch(/skipped/i);
  });

  it('true global top-K: a per-chunk limit shrunk by matches banked from OTHER containers would lose rows INSIDE a container — every chunk searches with the full args.limit', async () => {
    // limit=2; container A banks one exact ("9:99"); container B holds TWO exacts ("9:10","9:20").
    // A shrunk per-chunk limit (2−1=1) would drop "9:20" inside container B and yield
    // ["9:10","9:99"] — the true global top-2 by the comparator (score desc, id asc) is
    // ["9:10","9:20"].
    const skeleton = skeletonOf(page('Page1', [
      { id: '9:1', name: 'A' },
      { id: '9:2', name: 'B' },
    ]));
    const docs: Record<string, any> = {
      '9:1': { id: '9:1', name: 'A', type: 'FRAME', children: [
        { id: '9:99', name: 'dup', type: 'FRAME' },
      ] },
      '9:2': { id: '9:2', name: 'B', type: 'FRAME', children: [
        { id: '9:10', name: 'dup', type: 'FRAME' },
        { id: '9:20', name: 'dup', type: 'FRAME' },
      ] },
    };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: docs[ids[0]] } } }));
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'dup', depth: 6, limit: 2 });
    expect(getNodesRaw).toHaveBeenCalledTimes(2); // 1 exact after A < limit 2 → no early exit

    const out = JSON.parse(res.content[0].text);
    expect(out.matches.map((m: any) => m.node_id)).toEqual(['9:10', '9:20']);
  });

  it('deadline loop-guard: a zero time budget stops the loop before the 2nd container — NOTE this only exercises our own ' +
    'i>0 && Date.now()>=deadlineAt JS guard; the mock ignores deadlineAt entirely (a real adapter would instead abort the ' +
    'very first fetch too, honestly failing the whole call — that path is exercised in figma-rest-deadline.test.ts, not here)',
    async () => {
      const skeleton = skeletonOf(page('Page1', [
        { id: '5:1', name: 'C1' },
        { id: '5:2', name: 'C2' },
        { id: '5:3', name: 'C3' },
      ]));
      const docs: Record<string, any> = {
        '5:1': { id: '5:1', name: 'C1', type: 'FRAME' },
        '5:2': { id: '5:2', name: 'C2', type: 'FRAME' },
        '5:3': { id: '5:3', name: 'C3', type: 'FRAME' },
      };
      const getDocumentRaw = vi.fn(async () => skeleton);
      const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: docs[ids[0]] } } }));
      const run = harness({ getDocumentRaw, getNodesRaw }, { toolTimeBudgetMs: 0 });

      const res = await run({ file: 'abc', query: 'C1', depth: 6, limit: 20 });
      expect(getNodesRaw).toHaveBeenCalledTimes(1); // container 0 always attempted; guard trips before container 1

      const out = JSON.parse(res.content[0].text);
      expect(out.coverage.searched).toBe(1);
      expect(out.coverage.total).toBe(3);
      expect(out.coverage.skippedTotal).toBe(2);
      expect(out.coverage.note).toMatch(/budget/i);
    });

  it('a container fetch that REJECTS with a network error is skipped (with a reason) — the search continues past it', async () => {
    const skeleton = skeletonOf(page('Page1', [
      { id: '6:1', name: 'Flaky' },
      { id: '6:2', name: 'find-me' },
      { id: '6:3', name: 'Other' },
    ]));
    const docs: Record<string, any> = {
      '6:2': { id: '6:2', name: 'find-me', type: 'FRAME' },
      '6:3': { id: '6:3', name: 'Other', type: 'FRAME' },
    };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => {
      if (ids[0] === '6:1') throw new FigmaApiError('network', 0, 'ECONNRESET');
      return { nodes: { [ids[0]]: { document: docs[ids[0]] } } };
    });
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'find', depth: 6, limit: 20 });
    expect(getNodesRaw).toHaveBeenCalledTimes(3); // the network error on container 1 didn't abort the loop

    const out = JSON.parse(res.content[0].text);
    expect(out.matches.some((m: any) => m.node_id === '6:2')).toBe(true);
    expect(out.coverage.searched).toBe(2);
    expect(out.coverage.skipped).toEqual(['Flaky']);
    expect(out.coverage.skippedTotal).toBe(1);
  });

  it('rate_limited (429) on the 2nd container aborts the loop — the 3rd container is never requested', async () => {
    const skeleton = skeletonOf(page('Page1', [
      { id: '7:1', name: 'First' },
      { id: '7:2', name: 'Second' },
      { id: '7:3', name: 'Third' },
    ]));
    const docs: Record<string, any> = { '7:1': { id: '7:1', name: 'First', type: 'FRAME' } };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => {
      if (ids[0] === '7:1') return { nodes: { [ids[0]]: { document: docs[ids[0]] } } };
      if (ids[0] === '7:2') throw new FigmaApiError('rate_limited', 429, 'slow down', 5);
      throw new Error('should never be requested — 3rd container after a 429');
    });
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'anything', depth: 6, limit: 20 });
    expect(getNodesRaw).toHaveBeenCalledTimes(2); // container 3 never requested

    const out = JSON.parse(res.content[0].text);
    expect(out.coverage.searched).toBe(1);
    expect(out.coverage.total).toBe(3);
    expect(out.coverage.skipped.sort()).toEqual(['Second', 'Third']);
    expect(out.coverage.skippedTotal).toBe(2);
    expect(out.coverage.note).toMatch(/429/);
  });

  it('an auth/forbidden failure on a container fetch fails the whole call (token is dead for every chunk)', async () => {
    const skeleton = skeletonOf(page('Page1', [
      { id: '8:1', name: 'First' },
      { id: '8:2', name: 'Second' },
    ]));
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async () => { throw new FigmaApiError('forbidden', 403, 'nope'); });
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'anything', depth: 6, limit: 20 });
    expect(res.isError).toBe(true);
    expect(getNodesRaw).toHaveBeenCalledTimes(1); // did not keep trying other containers
  });

  it("kind='auth' rethrows too (same dead-token rule as forbidden)", async () => {
    const skeleton = skeletonOf(page('Page1', [
      { id: '8:1', name: 'First' },
      { id: '8:2', name: 'Second' },
    ]));
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async () => { throw new FigmaApiError('auth', 401, 'bad token'); });
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'anything', depth: 6, limit: 20 });
    expect(res.isError).toBe(true);
    expect(getNodesRaw).toHaveBeenCalledTimes(1);
  });

  it('falls back to whole-file when no node_id: skeleton fetch at depth 2, per-container search at args.depth', async () => {
    const skeleton = skeletonOf(page('Page', [{ id: '1:1', name: 'desktop' }]));
    const containerDoc = { id: '1:1', name: 'desktop', type: 'FRAME', children: [
      { id: '1:2', name: 'tabs', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 40 }, children: [
        { id: '1:3', name: 'Tab one', type: 'TEXT' },
      ] },
    ] };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[], depth?: number) => {
      expect(ids).toEqual(['1:1']);
      expect(depth).toBe(6); // args.depth, NOT the skeleton's depth-2
      return { nodes: { '1:1': { document: containerDoc } } };
    });
    const run = harness({ getDocumentRaw, getNodesRaw });

    const res = await run({ file: 'abc', query: 'tab', depth: 6, limit: 20 });
    expect(getDocumentRaw).toHaveBeenCalledWith('abc', 2); // NOT (…, 6) — the old whole-file behavior
    const out = JSON.parse(res.content[0].text);
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.coverage).toEqual({ searched: 1, total: 1, skipped: [], skippedTotal: 0 });
  });

  it('clamping (maxResultChars budget) is compatible with coverage: a clamped response still carries full coverage', async () => {
    const skeleton = skeletonOf(page('Board', [
      { id: '2:1', name: 'Alpha' },
      { id: '2:2', name: 'widget' },
      { id: '2:3', name: 'Gamma' },
    ]));
    const docs: Record<string, any> = {
      '2:1': { id: '2:1', name: 'Alpha', type: 'FRAME' },
      '2:2': { id: '2:2', name: 'widget', type: 'FRAME', children: [
        { id: '2:2:1', name: 'widget-detail', type: 'FRAME' },
      ] },
      '2:3': { id: '2:3', name: 'Gamma', type: 'FRAME' },
    };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: docs[ids[0]] } } }));
    const run = harness({ getDocumentRaw, getNodesRaw }, { maxResultChars: 10 });

    const res = await run({ file: 'abc', query: 'widget', depth: 6, limit: 20 });
    const out = JSON.parse(res.content[0].text);
    expect(out.clamped).toBe(true);
    expect(out.matches.length).toBeLessThan(2);
    expect(out.coverage).toEqual({ searched: 3, total: 3, skipped: [], skippedTotal: 0 });
  });

  // budget-guard invariant: the budget guard must measure the SAME serialization jsonResult
  // delivers (compact envelope via serializeForDelivery) — not a pretty-printed naked array.
  // Before the fix, clampToBudget's serialize closure ran JSON.stringify(rows, null, 2): pretty
  // (≈+indentation/newlines) AND missing the query/total/returned/coverage envelope overhead.
  // A budget sized just above the real delivered length would then over-clamp under the old
  // measure, or under-clamp (deliver more than budget) if envelope overhead dominated.
  //
  // Whole-file (coverage-bearing) scope on purpose, not node_id-scoped: the deadline-guard
  // path attaches a `coverage.note` (well over 100 chars) to the envelope, so envelope-vs-bare
  // difference is large and unambiguous. NB: an UNDER-estimate mutation ("bare
  // array, no envelope") is mathematically invisible to any budget ABOVE the true delivered
  // size — under-measuring only ever says "fits". It is caught ONLY by the edge probe below
  // (budget = deliveredLen - 1, forcing a genuine clamp); the tight (+100) probe catches the
  // OVER-estimate (pretty) mutation. Verified live: bare-array RED fires on the edge assert.
  it('budget: measure == delivery (compact envelope), not a pretty array, not a bare array', async () => {
    const skeleton = skeletonOf(page('Page1', [
      { id: 'c0', name: 'C0' }, { id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' },
    ]));
    const c0Doc = { id: 'c0', name: 'C0', type: 'FRAME', children: Array.from({ length: 15 }, (_, i) => ({
      id: `c0:${i}`, name: `card ${i}`, type: 'TEXT', characters: `card ${i} content preview text`,
    })) };
    const getDocumentRaw = vi.fn(async () => skeleton);
    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: c0Doc } } }));
    const runBig = harness({ getDocumentRaw, getNodesRaw }, { maxResultChars: 400000, toolTimeBudgetMs: 0 });
    const big = await runBig({ file: 'abc', query: 'card', depth: 6, limit: 20 });
    const deliveredLen = big.content[0].text.length;
    const bigOut = JSON.parse(big.content[0].text);
    expect(bigOut.clamped).toBeUndefined();
    expect(bigOut.coverage.note).toBeTruthy(); // sanity: envelope overhead includes the note text

    const runTight = harness({ getDocumentRaw: vi.fn(getDocumentRaw), getNodesRaw: vi.fn(getNodesRaw) },
      { maxResultChars: deliveredLen + 100, toolTimeBudgetMs: 0 });
    const tight = await runTight({ file: 'abc', query: 'card', depth: 6, limit: 20 });
    const out = JSON.parse(tight.content[0].text);
    expect(out.clamped).toBeUndefined();          // the compact measurement fits; a pretty measurement would have trimmed
    expect(out.returned).toBe(out.total);          // co-lock on content
    expect(tight.content[0].text.length).toBeLessThanOrEqual(deliveredLen + 100);

    // run-3: a budget JUST BELOW the real delivered length — the full envelope definitely does NOT
    // fit, a clamp is mandatory. Catches "measuring the bare array (no envelope)": if the measurement doesn't
    // account for the envelope overhead (query/total/coverage.note/…), it decides "it fit" on a definitely
    // insufficient budget and actually delivers deliveredLen bytes > budget — a silent budget
    // overflow. deliveredLen+100 above CANNOT catch the under-estimate (see the comment above);
    // only a budget BELOW the true size forces a genuine trim decision.
    const runEdge = harness({ getDocumentRaw: vi.fn(getDocumentRaw), getNodesRaw: vi.fn(getNodesRaw) },
      { maxResultChars: deliveredLen - 1, toolTimeBudgetMs: 0 });
    const edge = await runEdge({ file: 'abc', query: 'card', depth: 6, limit: 20 });
    expect(edge.content[0].text.length).toBeLessThanOrEqual(deliveredLen - 1); // budget is never exceeded
  });
});
