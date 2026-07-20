import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetTextStylesTool } from '../../src/adapters/driving/tools/get-text-styles-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';

const logger = createLogger({ level: 'silent' });
function harness(api: Partial<FigmaApi>, maxResultChars = 40000) {
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server = { tool: (n: string, _d: string, _s: unknown, h: (a: any) => Promise<any>) => { handlers[n] = h; } } as unknown as McpServer;
  const deps: ToolDeps = { buildApi: () => api as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars };
  registerGetTextStylesTool(server, deps);
  return handlers.get_text_styles;
}

const doc = { id: '1:0', name: 'tabs', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 40 }, children: [
  { id: '1:1', name: 'Tab', type: 'TEXT', characters: 'Books', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 40, lineHeightPx: 42 } },
] };

describe('get_text_styles tool', () => {
  it('returns the typography of text descendants', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:0': { document: doc } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', node_id: '1-0', include_color: true, dedupe: true, depth: 8 });
    const out = JSON.parse(res.content[0].text);
    const style = out.styles[0];
    expect(style.textStyle.fontSize).toBe(40);
    expect(style.textStyle.lineHeightPx).toBe(42);
    expect(style.nodes[0].node_id).toBe('1:1');
  });

  // budget-guard invariant: clampToBudget must measure the SAME serialization jsonResult
  // delivers (compact envelope via serializeForDelivery), not a pretty-printed naked array —
  // mirrors the find_nodes/get_review_board lock (anti-desync invariant).
  function manyTexts(n: number, distinctSizes: number) {
    return { id: '1:0', name: 'root', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 2000 },
      children: Array.from({ length: n }, (_, i) => ({
        id: `1:${i + 1}`, name: `Label ${i}`, type: 'TEXT', characters: `Label text content number ${i}`,
        style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 12 + (i % distinctSizes), lineHeightPx: 20 },
      })) };
  }

  it('budget (dedupe=true): measured == delivered (compact envelope), not a pretty array', async () => {
    const big5 = manyTexts(15, 5);
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:0': { document: big5 } } }));
    const runBig = harness({ getNodesRaw }, 400000);
    const big = await runBig({ file: 'abc', node_id: '1-0', include_color: true, dedupe: true, depth: 8 });
    const deliveredLen = big.content[0].text.length;
    expect(JSON.parse(big.content[0].text).clamped).toBeUndefined();

    const runTight = harness({ getNodesRaw: vi.fn(getNodesRaw) }, deliveredLen + 100);
    const tight = await runTight({ file: 'abc', node_id: '1-0', include_color: true, dedupe: true, depth: 8 });
    const out = JSON.parse(tight.content[0].text);
    expect(out.clamped).toBeUndefined();
    expect(out.returned).toBe(out.total);
    expect(out.styles.length).toBe(out.returned);
    expect(tight.content[0].text.length).toBeLessThanOrEqual(deliveredLen + 100);

    // run 3: budget just BELOW the delivered length — forces a real truncation decision.
    // deliveredLen+100 above can't tell "measure envelope" from "measure bare styles array"
    // apart (both under-budget slack decide "fits" either way); only a budget BELOW the true
    // size catches an envelope under-estimate (query/total overhead) via a silent overflow.
    const runEdge = harness({ getNodesRaw: vi.fn(getNodesRaw) }, deliveredLen - 1);
    const edge = await runEdge({ file: 'abc', node_id: '1-0', include_color: true, dedupe: true, depth: 8 });
    expect(edge.content[0].text.length).toBeLessThanOrEqual(deliveredLen - 1);
  });

  it('budget (dedupe=false): measured == delivered (compact envelope), not a pretty array', async () => {
    const big15 = manyTexts(15, 15); // every node its own style → no grouping to shrink hits
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:0': { document: big15 } } }));
    const runBig = harness({ getNodesRaw }, 400000);
    const big = await runBig({ file: 'abc', node_id: '1-0', include_color: true, dedupe: false, depth: 8 });
    const deliveredLen = big.content[0].text.length;
    expect(JSON.parse(big.content[0].text).clamped).toBeUndefined();

    const runTight = harness({ getNodesRaw: vi.fn(getNodesRaw) }, deliveredLen + 100);
    const tight = await runTight({ file: 'abc', node_id: '1-0', include_color: true, dedupe: false, depth: 8 });
    const out = JSON.parse(tight.content[0].text);
    expect(out.clamped).toBeUndefined();
    expect(out.returned).toBe(out.total);
    expect(out.styles.length).toBe(out.returned);
    expect(tight.content[0].text.length).toBeLessThanOrEqual(deliveredLen + 100);

    // run 3: see the comment in dedupe=true — a budget just BELOW the delivered length catches
    // the envelope under-estimate that deliveredLen+100 structurally cannot.
    const runEdge = harness({ getNodesRaw: vi.fn(getNodesRaw) }, deliveredLen - 1);
    const edge = await runEdge({ file: 'abc', node_id: '1-0', include_color: true, dedupe: false, depth: 8 });
    expect(edge.content[0].text.length).toBeLessThanOrEqual(deliveredLen - 1);
  });
});
