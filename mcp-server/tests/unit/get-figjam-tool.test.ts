import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetFigjamTool } from '../../src/adapters/driving/tools/get-figjam-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';

const logger = createLogger({ level: 'silent' });
const canvas = { id: '0:1', name: 'Page', type: 'CANVAS', children: [
  { id: '1:1', name: 'Note', type: 'STICKY', characters: 'Hi' },
  { id: '1:2', name: 'Edge', type: 'CONNECTOR', connectorStart: { endpointNodeId: '1:1' }, connectorEnd: { endpointNodeId: '1:3' } },
] };

function harness(over: Partial<FigmaApi> = {}, maxResultChars = 40000) {
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server = { tool: (n: string, _d: string, _s: unknown, h: (a: any) => Promise<any>) => { handlers[n] = h; } } as unknown as McpServer;
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({ name: 'F', lastModified: 'X', version: '1', document: canvas }),
      getNodesRaw: async () => ({ nodes: {} }), getImages: async () => ({ images: {} }),
      getVariablesLocal: async () => ({}), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      ...over,
    } as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars,
  };
  registerGetFigjamTool(server, deps);
  return handlers.get_figjam;
}

describe('get_figjam tool', () => {
  it('returns the whole board via getDocumentRaw', async () => {
    const run = harness();
    const res = await run({ file: 'https://www.figma.com/board/KEY/Name', depth: 4 });
    const body = JSON.parse(res.content[0].text);
    expect(body.stickies[0]).toMatchObject({ text: 'Hi' });
    expect(body.connectors[0]).toMatchObject({ from: '1:1', to: '1:3' });
  });

  it('node_id scopes the board to a subtree via getNodesRaw', async () => {
    let askedIds: string[] = [];
    const run = harness({
      getNodesRaw: async (_f: string, ids: string[]) => {
        askedIds = ids;
        return { nodes: { '1:4': { document: { id: '1:4', name: 'Sec', type: 'SECTION', children: [{ id: '1:5', name: 'N', type: 'STICKY', characters: 'inside' }] } } } };
      },
    });
    const res = await run({ file: 'KEY', node_id: '1-4', depth: 4 });
    const body = JSON.parse(res.content[0].text);
    expect(askedIds).toEqual(['1:4']);
    expect(body.stickies[0].text).toBe('inside');
  });

  it('errors when the scoped node is not found', async () => {
    const run = harness({ getNodesRaw: async () => ({ nodes: {} }) });
    const res = await run({ file: 'KEY', node_id: '9-9', depth: 4 });
    expect(res.isError).toBe(true);
  });

  it('errors on a bad file', async () => {
    const run = harness();
    const res = await run({ file: '@@@', depth: 4 });
    expect(res.isError).toBe(true);
  });
});

describe('get_figjam size budget — the gate measures the DELIVERED (compact) serialization (final F2)', () => {
  // Two-run scheme: the big run reads deliveredLen off the REAL delivery, the tight anchor
  // is set just ABOVE it, and the edge probe deliveredLen-1 is the only catcher of an under-estimate.
  // Live measures of the fixture (20 stickies + 1 connector): compact (delivered) = 2077,
  // pretty (old gate) = 2801 — a board in the window (2077, 2801] USED TO be refused though it fit.
  const bigCanvas = { id: '0:1', name: 'Page', type: 'CANVAS', children: [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `1:${i}`, name: `Note${i}`, type: 'STICKY',
      characters: `sticky note text number ${i} with some payload to bulk it up`,
    })),
    { id: '2:1', name: 'Edge', type: 'CONNECTOR', connectorStart: { endpointNodeId: '1:0' }, connectorEnd: { endpointNodeId: '1:1' } },
  ] };
  const bigDoc = { getDocumentRaw: async () => ({ name: 'F', lastModified: 'X', version: '1', document: bigCanvas }) } as Partial<FigmaApi>;

  it('a board with pretty > budget ≥ compact IS DELIVERED (not a refusal stub) — RED on the pretty gate', async () => {
    // Run 1 (big): a huge budget → deliveredLen of the real delivery.
    const res1 = await harness(bigDoc)({ file: 'KEY', depth: 4 });
    const deliveredLen = (res1.content[0].text as string).length;
    const body1 = JSON.parse(res1.content[0].text);
    expect(body1.stickies?.length).toBe(20);                       // co-lock: this is a board, not a stub
    // Run 2 (tight): budget just ABOVE the delivered size, but BELOW pretty of the same shape —
    // the pretty gate would refuse here (mutation "bring back the pretty gate" → RED).
    const budget = deliveredLen + 50;
    expect(budget).toBeLessThan(JSON.stringify(body1, null, 2).length); // guard that discriminates the mutation
    const res2 = await harness(bigDoc, budget)({ file: 'KEY', depth: 4 });
    const body2 = JSON.parse(res2.content[0].text);
    expect(body2.warning).toBeUndefined();                         // NOT a refusal stub
    expect(body2.stickies?.length).toBe(20);                       // co-lock on content
    expect(body2.stickies[19].text).toContain('number 19');
    expect((res2.content[0].text as string).length).toBeLessThanOrEqual(budget);
  });

  it('edge deliveredLen-1: an honest refusal stub, delivery does not exceed the budget', async () => {
    const res1 = await harness(bigDoc)({ file: 'KEY', depth: 4 });
    const deliveredLen = (res1.content[0].text as string).length;
    const budget = deliveredLen - 1;                               // catcher of a measure under-estimate
    const res2 = await harness(bigDoc, budget)({ file: 'KEY', depth: 4 });
    const body2 = JSON.parse(res2.content[0].text);
    expect(body2.warning).toMatch(/over the \d+ budget/);          // the refusal stub is unchanged
    expect(body2.counts).toMatchObject({ stickies: 20, connectors: 1 }); // co-lock: counts are honest
    expect((res2.content[0].text as string).length).toBeLessThanOrEqual(budget);
  });
});
