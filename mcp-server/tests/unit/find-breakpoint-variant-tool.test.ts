import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFindBreakpointVariantTool } from '../../src/adapters/driving/tools/find-breakpoint-variant-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';

const logger = createLogger({ level: 'silent' });

function harness(api: Partial<FigmaApi>) {
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server = { tool: (n: string, _d: string, _s: unknown, h: (a: any) => Promise<any>) => { handlers[n] = h; } } as unknown as McpServer;
  const deps: ToolDeps = { buildApi: () => api as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 };
  registerFindBreakpointVariantTool(server, deps);
  return handlers.find_breakpoint_variant;
}

// regression-like fixture: a section with two variant frames, neither of which
// contains "отмена" in its OWN name — they only match via the section (container) name.
//   "Другое": frame w464, content w464 (single content child, same width as the frame)
//   "desktop": frame w1280, content w420 (a narrower drawer content frame)
const otherContent = { id: 'c1:1', name: 'content', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 464, height: 800 } };
const otherFrame = { id: 'v1:1', name: 'Другое', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 464, height: 900 }, children: [otherContent] };

const desktopContent = { id: 'c2:1', name: 'content', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 420, height: 800 } };
const desktopFrame = { id: 'v2:1', name: 'desktop', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 900 }, children: [desktopContent] };

const section = { id: 's1:1', name: 'Отмена подписки', type: 'SECTION', children: [otherFrame, desktopFrame] };
const page = { id: 'p1:1', name: 'Page 1', type: 'CANVAS', children: [section] };
const documentRoot = { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [page] };

const nodesById: Record<string, any> = { 's1:1': section, 'v1:1': otherFrame, 'v2:1': desktopFrame };

function makeApi() {
  const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({
    nodes: Object.fromEntries(ids.map((id) => [id, nodesById[id] ? { document: nodesById[id] } : null])),
  }));
  const getDocumentRaw = vi.fn(async () => ({
    name: 'F', lastModified: 'X', version: '1', document: documentRoot,
  }));
  return { getNodesRaw, getDocumentRaw };
}

describe('find_breakpoint_variant tool', () => {
  it('matches by container (section) name, ranks by content width, and marks only the winning content node', async () => {
    const api = makeApi();
    const run = harness(api);
    const res = await run({ file: 'abc', query: 'отмена', render_width: 420 });
    const out = JSON.parse(res.content[0].text);

    expect(out.query).toBe('отмена');
    expect(out.render_width).toBe(420);
    expect(out.variants).toHaveLength(2);

    const desktop = out.variants.find((v: any) => v.node_id === 'v2:1');
    const other = out.variants.find((v: any) => v.node_id === 'v1:1');
    // neither variant's own name contains "отмена" — both only matched via the section container
    expect(desktop.name).toBe('desktop');
    expect(other.name).toBe('Другое');
    expect(desktop.container).toBe('Отмена подписки');
    expect(other.container).toBe('Отмена подписки');
    expect(desktop.frame_w).toBe(1280);
    expect(other.frame_w).toBe(464);

    const desktopHit = desktop.content.find((c: any) => c.node_id === 'c2:1');
    expect(desktopHit.w).toBe(420);
    expect(desktopHit.isBestMatch).toBe(true);
    expect(other.content.every((c: any) => !c.isBestMatch)).toBe(true);

    expect(out.match).toEqual({ node_id: 'c2:1', w: 420, variant_node_id: 'v2:1' });
    expect(api.getDocumentRaw).toHaveBeenCalledWith('abc', 3);
    expect(api.getNodesRaw).toHaveBeenCalledWith('abc', ['v1:1', 'v2:1'], 2);
  });

  it('scopes the walk to parent_node_id and never calls getDocumentRaw', async () => {
    const api = makeApi();
    const run = harness(api);
    const res = await run({ file: 'abc', query: 'отмена', render_width: 420, parent_node_id: 's1-1' });
    const out = JSON.parse(res.content[0].text);

    expect(api.getDocumentRaw).not.toHaveBeenCalled();
    expect(api.getNodesRaw).toHaveBeenCalledWith('abc', ['s1:1'], 3);
    expect(out.match).toEqual({ node_id: 'c2:1', w: 420, variant_node_id: 'v2:1' });
  });

  it('returns match:null with an honest note when no content width is within tolerance', async () => {
    const api = makeApi();
    const run = harness(api);
    const res = await run({ file: 'abc', query: 'отмена', render_width: 900 });
    const out = JSON.parse(res.content[0].text);

    expect(out.match).toBeNull();
    expect(out.note).toBeTruthy();
    expect(out.note).toMatch(/tolerance/i);
    // variants are still reported so the caller can eyeball candidates
    expect(out.variants).toHaveLength(2);
  });

  it('caps at 10 variant matches in document order and notes the truncation', async () => {
    const manyFrames = Array.from({ length: 12 }, (_, i) => ({
      id: `m1:${i}`, name: `Вариант ${i}`, type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 300 + i, height: 500 },
      children: [],
    }));
    const manySection = { id: 'sM:1', name: 'Отмена подписки', type: 'SECTION', children: manyFrames };
    const manyPage = { id: 'pM:1', name: 'Page', type: 'CANVAS', children: [manySection] };
    const manyDoc = { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: [manyPage] };
    const manyById: Record<string, any> = Object.fromEntries(manyFrames.map((f) => [f.id, f]));

    const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({
      nodes: Object.fromEntries(ids.map((id) => [id, manyById[id] ? { document: manyById[id] } : null])),
    }));
    const getDocumentRaw = vi.fn(async () => ({ name: 'F', lastModified: 'X', version: '1', document: manyDoc }));

    const run = harness({ getNodesRaw, getDocumentRaw });
    const res = await run({ file: 'abc', query: 'отмена', render_width: 400 });
    const out = JSON.parse(res.content[0].text);

    expect(out.variants).toHaveLength(10);
    expect(out.variants.map((v: any) => v.node_id)).toEqual(manyFrames.slice(0, 10).map((f) => f.id));
    expect(out.note).toBeTruthy();
    expect(out.note).toMatch(/parent_node_id/);
  });
});
