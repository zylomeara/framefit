// The MT userGraph port factory: EVERY method wired, including cssEvidence — the wave caught
// this exact branch shipping without it (tsc green, all tests building deps directly).
import { describe, it, expect } from 'vitest';
import { userGraphPort } from '../../src/infrastructure/user-graph-port.js';
import { buildGraph } from '../../src/domain/variable-graph.js';

const K = 'f'.repeat(40);
const g = buildGraph([{ fileKey: 'LIB', vars: [
  { library_key: K, local_id: 'V:1', collection_id: 'C', name: 'bg/x', resolved_type: 'COLOR',
    values_by_mode: { m: { r: 1, g: 0, b: 0 } }, code_syntax_web: '--ds-x' }],
  colls: [{ collection_id: 'C', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] }]);

describe('userGraphPort', () => {
  const port = userGraphPort(g);
  it('resolve / resolveInMode / isMultiMode work over the graph', () => {
    expect(port.resolve(K)?.value).toBe('#ff0000');
    expect(port.resolveInMode?.(K, new Map())?.value).toBe('#ff0000');
    expect(port.isMultiMode?.(K)).toBe(false);
  });
  it('cssEvidence is WIRED and scoped (the wave-caught blocker class)', () => {
    const view = port.cssEvidence?.([K]);
    expect(view).toBeDefined();
    expect(view!.authoredNameOf(K)).toBe('--ds-x');
    expect(view!.idsByCssName('--ds-x')).toEqual([K]);
    expect(port.cssEvidence?.([K], 'LIB')!.idsByCssName('--ds-x')).toEqual([]); // self-file exclusion
  });
});

// ── Tool-level MT lock: compare_node_to_dom through the MT-shaped port. The port unit test
// alone cannot catch a half-wired MT branch at the tool layer — this is the smallest thing
// that goes red if it ever ships dead again.
import { registerCompareNodeToDomTool } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';
import { withFrameRaw } from './helpers/frame-raw.js';

const logger = createLogger({ level: 'silent' });
const KP = '1'.repeat(40), KQ = '2'.repeat(40);
const mtGraph = buildGraph([{ fileKey: 'LIBMT', vars: [
  { library_key: KP, local_id: 'V:1', collection_id: 'C', name: 'ds/primary', resolved_type: 'COLOR',
    values_by_mode: { m: { r: 1, g: 0, b: 0 } }, code_syntax_web: 'var(--ds-primary)' },
  { library_key: KQ, local_id: 'V:2', collection_id: 'C', name: 'ds/other', resolved_type: 'COLOR',
    values_by_mode: { m: { r: 0, g: 1, b: 0 } }, code_syntax_web: '--ds-other' }],
  colls: [{ collection_id: 'C', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] }]);

function mtHarness() {
  const { server, call } = makeFakeMcpServer();
  const api = withFrameRaw({
    getNodesRaw: async () => ({ nodes: { '1:1': { document: {
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: `VariableID:${KP}/1:1` } } }],
    } } } }),
    getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
  } as Partial<FigmaApi>);
  const deps = { buildApi: () => api as FigmaApi, defaultToken: 'figd_x', logger,
    maxResultChars: 400000, variableGraph: userGraphPort(mtGraph) } as unknown as ToolDeps;
  registerCompareNodeToDomTool(server, deps);
  const dom = (domVar: string) => ({ schema: 7, status: 'ok', selector: '.card', innerWidth: 375,
    rect: { x: 0, y: 0, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 }, transformed: false,
    styles: { backgroundColor: '#ff0000', backgroundColorToken: { token: domVar } }, children: [] });
  return { run: (v: string) => call('compare_node_to_dom', { file: 'consumer', pairs: [{ node_id: '1:1', dom: dom(v) }] }) };
}

describe('compare_node_to_dom through the MT userGraphPort', () => {
  it('divergent DOM var → semantic-diverged + blocking (red if the MT branch is half-wired)', async () => {
    const res = await mtHarness().run('--ds-other');
    const body = JSON.parse(res.content[0].text as string);
    const fill = body.pairs[0].rows.find((r: any) => r.prop === 'fill');
    expect(fill?.tokenReason).toBe('semantic-diverged');
    expect(body.verification.blocking.some((b: any) => b.kind === 'unconfirmed_token')).toBe(true);
  });
  it('matching DOM var → pass with the codeSyntax note', async () => {
    const res = await mtHarness().run('--ds-primary');
    const body = JSON.parse(res.content[0].text as string);
    const fill = body.pairs[0].rows.find((r: any) => r.prop === 'fill');
    expect(fill?.status).toBe('pass');
    expect(fill?.note).toMatch(/codeSyntax/);
  });
});
