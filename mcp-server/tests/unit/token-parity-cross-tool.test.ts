// Token-value parity across get_layout_spec and get_design_context (feedback 15/15.1).
//
// "One source of truth" is scoped, not absolute, and this file pins the SCOPE, not a slogan:
//  - parity where both tools can see the pin (same name, same hex, same mode_source);
//  - the documented asymmetry when the pin sits ABOVE the requested node (same name;
//    design_context says mode_source:'node', get_layout_spec honestly says 'default' - it
//    deliberately does not pay for whole-file ancestor discovery);
//  - the documented NAMING ceiling: a SINGLE-mode variable bound at the PAINT level is named
//    by the shared resolver (get_layout_spec/compare) and NOT by get_design_context, whose
//    legacy single-mode name path reads node-level boundVariables only. Adversarial wave
//    finding, probe-confirmed. Pinned so a future design_context fix flips this test
//    CONSCIOUSLY instead of the docs drifting.
// A future change that silently widens or narrows any side goes red here.
import { describe, it, expect, vi } from 'vitest';
import { registerGetDesignContextTool } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { registerGetLayoutSpecTool } from '../../src/adapters/driving/tools/get-layout-spec-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

const VARS = {
  meta: {
    variableCollections: { 'VC:1': { id: 'VC:1', name: 'Theme', defaultModeId: 'm1',
      modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] } },
    variables: { 'V:1': { id: 'V:1', name: 'bg/level 2', resolvedType: 'COLOR', variableCollectionId: 'VC:1',
      valuesByMode: { m1: { r: 0.482, g: 0.380, b: 0.965 }, m2: { r: 0.6, g: 0.5, b: 1 } } } },
  },
};
const HEX_M1 = '#7b61f6';
const HEX_M2 = '#9980ff';

const rootNode = (pinned: boolean): RawSceneNode => ({
  id: 'ROOT', name: 'Header', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }],
  ...(pinned ? { explicitVariableModes: { 'VC:1': 'm2' } } : {}),
} as RawSceneNode);

// Whole-file tree for design-context's ancestor discovery: the pin lives on ANC, ABOVE ROOT.
const fullDoc = {
  id: 'DOC', name: 'Document', type: 'DOCUMENT', children: [
    { id: 'PAGE', name: 'Page 1', type: 'CANVAS', children: [
      { id: 'ANC', name: 'Themed', type: 'FRAME', explicitVariableModes: { 'VC:1': 'm2' }, children: [
        { id: 'ROOT', name: 'Header', type: 'FRAME', children: [] },
      ] },
    ] },
  ],
};
const ancestorNodes: Record<string, { document: unknown }> = {
  DOC: { document: { id: 'DOC', name: 'Document', type: 'DOCUMENT' } },
  PAGE: { document: { id: 'PAGE', name: 'Page 1', type: 'CANVAS' } },
  ANC: { document: { id: 'ANC', name: 'Themed', type: 'FRAME', explicitVariableModes: { 'VC:1': 'm2' } } },
};

// get_design_context validates node_id against ^\d+[:\-]\d+$ — 'ROOT' does not pass. Use a
// numeric id for the request root instead; the tree keeps the same shape.
const NUM = (n: RawSceneNode): RawSceneNode => ({ ...n, id: '1:1' } as RawSceneNode);
const fullDocNum = JSON.parse(JSON.stringify(fullDoc).replace('"ROOT"', '"1:1"'));
const fillTokenOf = (specOut: any) => specOut.specs[0].spec.fillToken;
const dcFillOf = (dcOut: any) => {
  const fillRef = dcOut.node.fill;
  return typeof fillRef === 'string' && dcOut.globalVars?.[fillRef] ? dcOut.globalVars[fillRef] : fillRef;
};

function harness(doc: RawSceneNode) {
  const api = {
    getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
    getDocumentRaw: async () => ({ document: fullDocNum } as any),
    getImages: async () => ({ images: {} }),
    getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
    getNodesRaw: vi.fn(async (_f: string, ids: string[]) =>
      ({ nodes: Object.fromEntries(ids.map((id) => [id, id === '1:1' ? { document: doc } : ancestorNodes[id] ?? null])) })),
    getVariablesLocal: async () => VARS,
  } as unknown as FigmaApi;
  const deps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 } as ToolDeps;
  const dc = makeFakeMcpServer(); registerGetDesignContextTool(dc.server, deps);
  const ls = makeFakeMcpServer(); registerGetLayoutSpecTool(ls.server, deps);
  return {
    designContext: async () => JSON.parse((await dc.call('get_design_context', { file: 'abc', node_id: '1-1', depth: 2 })).content[0].text as string),
    layoutSpec: async () => JSON.parse((await ls.call('get_layout_spec', { file: 'abc', node_ids: ['1:1'] })).content[0].text as string),
  };
}

describe('token parity across get_design_context and get_layout_spec', () => {
  it('pin visible to both (on the requested node): same name, same hex, both mode_source:node', async () => {
    const h = harness(NUM(rootNode(true)));
    const dcFill = dcFillOf(await h.designContext());
    const lsTok = fillTokenOf(await h.layoutSpec());
    expect(lsTok).toBeDefined();
    expect(dcFill.token).toBe('bg/level 2');
    expect(lsTok.token).toBe('bg/level 2');           // the NAME is the portable artifact — always equal
    expect(dcFill.value).toBe(HEX_M2);
    expect(lsTok.hex).toBe(HEX_M2);
    expect(dcFill.mode_source).toBe('node');
    expect(lsTok.mode_source).toBe('node');
  });

  it('pin ABOVE the requested node: same name; design_context discovers it (node), get_layout_spec honestly defaults', async () => {
    const h = harness(NUM(rootNode(false)));
    const dcFill = dcFillOf(await h.designContext());
    const lsTok = fillTokenOf(await h.layoutSpec());
    expect(dcFill.token).toBe('bg/level 2');
    expect(lsTok.token).toBe('bg/level 2');
    // design_context pays for whole-file ancestor discovery and confirms the ancestor pin:
    expect(dcFill.value).toBe(HEX_M2);
    expect(dcFill.mode_source).toBe('node');
    // get_layout_spec folds the fetched subtree only — the pin above is invisible, and the
    // honest answer is the default-mode value marked 'default', never a guessed 'node':
    expect(lsTok.hex).toBe(HEX_M1);
    expect(lsTok.mode_source).toBe('default');
  });
});

// ── The naming ceiling, pinned (see the header comment's third bullet). ──
const VARS_SINGLE = {
  meta: {
    variableCollections: { 'VC:2': { id: 'VC:2', name: 'Solid', defaultModeId: 's1',
      modes: [{ modeId: 's1', name: 'Only' }] } },
    variables: { 'V:2': { id: 'V:2', name: 'accent/solid', resolvedType: 'COLOR', variableCollectionId: 'VC:2',
      valuesByMode: { s1: { r: 0.482, g: 0.380, b: 0.965 } } } },
  },
};
const singleModePaintBound: RawSceneNode = {
  id: '1:1', name: 'Header', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  fills: [{ type: 'SOLID', color: { r: 0.482, g: 0.380, b: 0.965 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:2' } } }],
} as RawSceneNode;

function singleModeHarness() {
  const api = {
    getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
    getDocumentRaw: async () => ({ document: fullDocNum } as any),
    getImages: async () => ({ images: {} }),
    getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
    getNodesRaw: vi.fn(async (_f: string, ids: string[]) =>
      ({ nodes: Object.fromEntries(ids.map((id) => [id, id === '1:1' ? { document: singleModePaintBound } : ancestorNodes[id] ?? null])) })),
    getVariablesLocal: async () => VARS_SINGLE,
  } as unknown as FigmaApi;
  const deps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 } as ToolDeps;
  const dc = makeFakeMcpServer(); registerGetDesignContextTool(dc.server, deps);
  const ls = makeFakeMcpServer(); registerGetLayoutSpecTool(ls.server, deps);
  return {
    designContext: async () => (await dc.call('get_design_context', { file: 'abc', node_id: '1-1', depth: 2 })).content[0].text as string,
    layoutSpec: async () => JSON.parse((await ls.call('get_layout_spec', { file: 'abc', node_ids: ['1:1'] })).content[0].text as string),
  };
}

describe('the naming ceiling: single-mode paint-level binding', () => {
  it('get_layout_spec names it; get_design_context (legacy single-mode path) renders the raw hex nameless', async () => {
    const h = singleModeHarness();
    const lsTok = fillTokenOf(await h.layoutSpec());
    expect(lsTok?.token).toBe('accent/solid');
    expect(lsTok?.hex).toBe('#7b61f6');
    const dcText = await h.designContext();
    // The ceiling itself: no name in design_context's output for this shape TODAY. If a
    // design_context fix lands (its legacy resolveToken reads node-level boundVariables only),
    // this expectation flips - update docs/tools/design-qa.md's exception sentence with it.
    expect(dcText).not.toContain('accent/solid');
    expect(dcText).toContain('#7b61f6');
  });
});
