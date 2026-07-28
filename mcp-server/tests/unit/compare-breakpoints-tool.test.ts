import { describe, it, expect, vi } from 'vitest';
import { registerCompareBreakpointsTool } from '../../src/adapters/driving/tools/compare-breakpoints-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
function harness(api: Partial<FigmaApi>) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => api as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 };
  registerCompareBreakpointsTool(server, deps);
  return (a: any): Promise<any> => call('compare_breakpoints', a);
}

const frame = (id: string, name: string, w: number, fontSize: number) => ({
  id, name, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: w, height: 100 }, children: [
    { id: `${id}:t`, name: 'tabs', type: 'TEXT', characters: 'Books', style: { fontFamily: 'Inter', fontWeight: 400, fontSize, lineHeightPx: fontSize + 2 } },
  ],
});

describe('compare_breakpoints tool', () => {
  it('returns match:null with frame_name+width when element name is absent in a frame', async () => {
    // desktop has `tabs`, mob frame returns a different element name — simulates a misspelled name for mob
    const mobFrameNoTabs = (id: string, name: string, w: number) => ({
      id, name, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: w, height: 100 }, children: [
        { id: `${id}:t`, name: 'button', type: 'TEXT', characters: 'Go', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 16, lineHeightPx: 18 } },
      ],
    });
    const getNodesRaw = vi.fn(async (_k: string, ids: string[]) => ({
      nodes: { '27997:221404': { document: frame('27997:221404', 'desktop', 1280, 40) },
               '27997:221765': { document: mobFrameNoTabs('27997:221765', 'mob', 360) } },
    }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', node_ids: ['27997-221404', '27997-221765'], name: 'tabs', depth: 8 });
    const out = JSON.parse(res.content[0].text);
    const desktop = out.breakpoints.find((b: any) => b.frame_name === 'desktop');
    const mob = out.breakpoints.find((b: any) => b.frame_name === 'mob');
    // desktop matched — has textStyle
    expect(desktop.textStyle.fontSize).toBe(40);
    expect(desktop.match).toBeUndefined();
    // mob did not match — has match:null, frame_name, width but no textStyle
    expect(mob.match).toBeNull();
    expect(mob.frame_name).toBe('mob');
    expect(mob.width).toBe(360);
    expect(mob.textStyle).toBeUndefined();
  });

  it('returns the element style per breakpoint in one batched fetch', async () => {
    const getNodesRaw = vi.fn(async (_k: string, ids: string[]) => ({
      nodes: { '27997:221404': { document: frame('27997:221404', 'desktop', 1280, 40) },
               '27997:221765': { document: frame('27997:221765', 'mob', 360, 24) } },
    }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', node_ids: ['27997-221404', '27997-221765'], name: 'tabs', depth: 8 });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['27997:221404', '27997:221765'], 8);
    const out = JSON.parse(res.content[0].text);
    expect(out.element).toBe('tabs');
    const desktop = out.breakpoints.find((b: any) => b.frame_name === 'desktop');
    const mob = out.breakpoints.find((b: any) => b.frame_name === 'mob');
    expect(desktop.width).toBe(1280);
    expect(desktop.textStyle.fontSize).toBe(40);
    expect(mob.width).toBe(360);
    expect(mob.textStyle.fontSize).toBe(24);
  });
});
