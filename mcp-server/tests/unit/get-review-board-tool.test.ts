import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fixture from '../fixtures/review-board-profile.json';
import { registerGetReviewBoardTool } from '../../src/adapters/driving/tools/get-review-board-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

function install(doc: RawSceneNode, maxResultChars = 40000) {
  let handler: ((a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined;
  const server = { tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => { handler = h; } } as unknown as McpServer;
  const api = {
    getNodesRaw: async (_k: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: doc } } }),
    getImages: async (_k: string, ids: string[]) => ({ images: Object.fromEntries(ids.map((i) => [i, `https://signed/${i}`])) }),
  };
  const deps = { buildApi: () => api as never, defaultToken: 't', logger: { warn() {} } as never, maxResultChars };
  registerGetReviewBoardTool(server, deps as never);
  return (a: Record<string, unknown>) => handler!(a);
}

describe('get_review_board tool', () => {
  it('returns grouped items with pin↔text↔target', async () => {
    const call = install(fixture as unknown as RawSceneNode);
    const res = await call({ file: 'k', node_id: '12:100' });
    const out = JSON.parse(res.content[0].text);
    const items = out.groups.flatMap((g: { items: unknown[] }) => g.items);
    expect(items).toHaveLength(3);
    const i1 = items.find((i: { number: number }) => i.number === 1);
    expect(i1.commentText).toContain('Кнопку выровнять по сетке');
    expect(i1.target.screenshotNodeId).toBe('12:101');
    expect(out.unmatched.pinsWithoutComment).toContain(9);
  });

  it('surfaces target.referenceNode and plumbs include_bounds through the tool', async () => {
    const t = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
    } as unknown as RawSceneNode);
    const doc: RawSceneNode = {
      id: '12:1', name: 'sec', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 4000, height: 2000 },
      children: [
        { id: 'prod', name: 'image 1', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
          fills: [{ type: 'IMAGE', imageRef: 'r' }] } as unknown as RawSceneNode,
        { id: 'pin', name: 'Цифровой пин', type: 'INSTANCE',
          absoluteBoundingBox: { x: 400, y: 400, width: 74, height: 106 },
          children: [t('pin-n', '1')] } as unknown as RawSceneNode,
        { id: 'ref', name: 'Макет', type: 'FRAME',
          absoluteBoundingBox: { x: 2000, y: 0, width: 1000, height: 1000 },
          children: [
            { id: 'card', name: 'card', type: 'FRAME',
              absoluteBoundingBox: { x: 2000, y: 0, width: 1000, height: 1000 }, children: [] } as unknown as RawSceneNode,
          ] } as unknown as RawSceneNode,
      ],
    } as unknown as RawSceneNode;

    const call = install(doc);
    const res = await call({ file: 'k', node_id: '12:1' });
    const out = JSON.parse(res.content[0].text);
    const lane = out.groups.find((g: any) => g.screenshots.prod?.node_id === 'prod');
    expect(lane.screenshots.reference).toEqual({ node_id: 'ref' });
    const item = lane.items.find((i: any) => i.number === 1);
    expect(item.target.referenceNode.suggested.nodeId).toBe('card');
    expect(item.target.nearestTargetNodeId).toBe('card');

    // include_bounds must reach buildReviewBoard → path nodes carry w/h. FAILS while bounds are not threaded through.
    const res2 = await call({ file: 'k', node_id: '12:1', include_bounds: true });
    const out2 = JSON.parse(res2.content[0].text);
    const item2 = out2.groups.find((g: any) => g.screenshots.prod?.node_id === 'prod').items[0];
    expect(item2.target.referenceNode.path[0].w).toBe(1000);
  });

  // Many-lane synthetic board — big enough that pretty-vs-compact (and envelope-vs-naked)
  // size deltas are well over any small fixed slack, so the lock below actually falsifies.
  // (The small review-board-profile.json fixture is too tiny for this — pretty overhead on
  // 3 items sits well inside a +100 slack, so it can't tell compact from pretty.)
  function buildLanes(n: number): RawSceneNode {
    const t = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
    } as unknown as RawSceneNode);
    const children: RawSceneNode[] = [];
    for (let i = 0; i < n; i++) {
      const y = i * 1200;
      children.push({
        id: `prod-${i}`, name: `image ${i}`, type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y, width: 1000, height: 1000 },
        fills: [{ type: 'IMAGE', imageRef: `r${i}` }],
      } as unknown as RawSceneNode);
      children.push({
        id: `pin-${i}`, name: 'Цифровой пин', type: 'INSTANCE',
        absoluteBoundingBox: { x: 400, y: y + 400, width: 74, height: 106 },
        children: [t(`pin-n-${i}`, String(i + 1))],
      } as unknown as RawSceneNode);
      children.push({
        id: `ref-${i}`, name: 'Макет', type: 'FRAME',
        absoluteBoundingBox: { x: 2000, y, width: 1000, height: 1000 },
        children: [
          { id: `card-${i}`, name: `card ${i}`, type: 'FRAME',
            absoluteBoundingBox: { x: 2000, y, width: 1000, height: 1000 }, children: [] } as unknown as RawSceneNode,
        ],
      } as unknown as RawSceneNode);
    }
    return {
      id: '9000:1', name: 'board', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 4000, height: n * 1200 + 1000 },
      children,
    } as unknown as RawSceneNode;
  }

  // budget-guard invariant: clampToBudget must measure the SAME serialization jsonResult
  // delivers (compact envelope via serializeForDelivery, warnings conservatively including
  // 'auto_clamped' in the MEASURED closure) — not a pretty-printed envelope missing that
  // reserve. Mirrors the find_nodes/get_text_styles lock.
  it('budget: measured == delivered (compact envelope, warnings incl. auto_clamped reserve), not pretty', async () => {
    const doc = buildLanes(20);
    const runBig = install(doc, 400000);
    const big = await runBig({ file: 'k', node_id: '9000:1' });
    const deliveredLen = big.content[0].text.length;
    const bigOut = JSON.parse(big.content[0].text);
    expect(bigOut.warnings).not.toContain('auto_clamped');
    expect(bigOut.groups.length).toBe(20); // sanity: all 20 lanes present at a generous budget

    const runTight = install(doc, deliveredLen + 100);
    const tight = await runTight({ file: 'k', node_id: '9000:1' });
    const out = JSON.parse(tight.content[0].text);
    expect(out.warnings).not.toContain('auto_clamped');  // the compact measure fits; a pretty measure would have cut
    expect(out.groups.length).toBe(bigOut.groups.length); // co-lock on content
    expect(tight.content[0].text.length).toBeLessThanOrEqual(deliveredLen + 100);

    // run 3: budget just BELOW the delivered length — forces a real truncation. Catches
    // "measure the bare lanes array (without file/node_id/unmatched/warnings)": deliveredLen+100 above
    // structurally can't tell that mutation apart (an under-estimate always "fits" under a
    // budget already above the true size) — only a budget BELOW the true size catches
    // the silent budget overflow.
    const runEdge = install(doc, deliveredLen - 1);
    const edge = await runEdge({ file: 'k', node_id: '9000:1' });
    expect(edge.content[0].text.length).toBeLessThanOrEqual(deliveredLen - 1);
  });
});
