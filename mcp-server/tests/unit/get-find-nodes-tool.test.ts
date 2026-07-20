import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFindNodesTool } from '../../src/adapters/driving/tools/find-nodes-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

// Minimal harness: capture the tool handler the registration installs.
function install(rootDoc: RawSceneNode) {
  let handler: ((args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined;
  const server = { tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => { handler = h; } } as unknown as McpServer;
  const api = {
    getNodesRaw: async (_k: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: rootDoc } } }),
  };
  const deps = {
    buildApi: () => api as never, defaultToken: 't', logger: { warn() {} } as never, maxResultChars: 40000,
  };
  registerFindNodesTool(server, deps as never);
  return (args: Record<string, unknown>) => handler!(args);
}

const board: RawSceneNode = {
  id: '1:0', name: 'Профиль', type: 'SECTION', children: [
    { id: '1:1', name: 'Все жанры', type: 'TEXT', characters: 'Корзина' },
  ],
};

describe('find_nodes tool', () => {
  it('returns matched_on and a text preview when matching by characters', async () => {
    const call = install(board);
    const res = await call({ file: 'k', node_id: '1:1', query: 'Корзина' });
    const out = JSON.parse(res.content[0].text);
    expect(out.total).toBe(1);
    expect(out.matches[0].matched_on).toBe('text');
    expect(out.matches[0].text).toBe('Корзина');
  });

  it('returns matched_on:property and previews the override value', async () => {
    const drawer: RawSceneNode = {
      id: '1:0', name: 'drawer', type: 'FRAME', children: [
        { id: '1:9', name: 'sectionHeader', type: 'INSTANCE',
          componentProperties: { 'Title#9:0': { type: 'TEXT', value: 'Как привязать карту' } } } as RawSceneNode,
      ],
    };
    const call = install(drawer);
    const res = await call({ file: 'k', node_id: '1:0', query: 'привязать карту' });
    const out = JSON.parse(res.content[0].text);
    const hit = out.matches.find((m: any) => m.node_id === '1:9');
    expect(hit.matched_on).toBe('property');
    expect(hit.text).toBe('Как привязать карту');
  });
});
