import { describe, it, expect } from 'vitest';
import { registerGetScreenshotTool } from '../../src/adapters/driving/tools/get-screenshot-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

function install(doc: RawSceneNode) {
  const { server, call } = makeFakeMcpServer();
  const api = {
    getNodesRaw: async (_k: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: doc } } }),
    getImages: async (_k: string, ids: string[]) => ({ images: Object.fromEntries(ids.map((i) => [i, `https://signed/${i}`])) }),
  };
  const deps = { buildApi: () => api as never, defaultToken: 't', logger: { warn() {} } as never, maxResultChars: 40000 };
  registerGetScreenshotTool(server, deps as never);
  return (a: Record<string, unknown>) => call('get_screenshot', a);
}

const huge: RawSceneNode = {
  id: '1:0', name: 'Профиль', type: 'SECTION',
  absoluteBoundingBox: { x: 0, y: 0, width: 5473, height: 7173 },
  children: [
    { id: '1:1', name: 'lane1', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 5473, height: 1200 } },
    { id: '1:2', name: 'lane2', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 1389, width: 5473, height: 1200 } },
  ],
};

const small: RawSceneNode = {
  id: '2:0', name: 'SmallFrame', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 },
  children: [],
};

describe('get_screenshot lite-tiling', () => {
  it('adds a readability_hint for a very large frame', async () => {
    const call = install(huge);
    const res = await call({ file: 'k', node_id: '1:0', scale: 2 });
    const out = JSON.parse(res.content[0].text);
    expect(out.readability_hint).toBeDefined();
    expect(out.readability_hint.suggested_scale).toBeLessThan(1);
  });

  it('returns a children_map when tiles=true', async () => {
    const call = install(huge);
    const res = await call({ file: 'k', node_id: '1:0', tiles: true, scale: 2 });
    const out = JSON.parse(res.content[0].text);
    expect(out.children_map).toHaveLength(2);
    expect(out.children_map[0]).toMatchObject({ node_id: '1:1', name: 'lane1' });
    expect(out.children_map[0].url).toBe('https://signed/1:1');
  });

  it('suppresses readability_hint for a small node (below 4000px threshold)', async () => {
    const call = install(small);
    const res = await call({ file: 'k', node_id: '2:0', scale: 2 });
    const out = JSON.parse(res.content[0].text);
    expect(out.readability_hint).toBeUndefined();
  });

  it('omits children_map when tiles is not requested', async () => {
    const call = install(huge);
    const res = await call({ file: 'k', node_id: '1:0', scale: 2 });
    const out = JSON.parse(res.content[0].text);
    expect(out.children_map).toBeUndefined();
  });
});
