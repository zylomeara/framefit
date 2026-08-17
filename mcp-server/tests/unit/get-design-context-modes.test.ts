import { describe, it, expect } from 'vitest';
import { registerGetDesignContextTool } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { buildGraph, resolveKey, resolveKeyInMode, keyIsMultiMode } from '../../src/domain/variable-graph.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

// Node 'F' sets explicit mode m2 for local collection C; the stroke of leaf L binds V:1.
const doc = {
  id: 'F', name: 'Header', type: 'FRAME', explicitVariableModes: { C: 'm2' },
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  children: [{ id: 'L', name: '24/Stroke/menu', type: 'VECTOR',
    strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
    boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:1' }] } }],
};
const variables = { meta: {
  variableCollections: { 'C': { id: 'C', name: 'Theme', defaultModeId: 'm1',
    modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dusk' }] } },
  variables: { 'V:1': { id: 'V:1', name: 'text color/accent', resolvedType: 'COLOR', variableCollectionId: 'C',
    valuesByMode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } } } },
} };

// Local SINGLE-MODE collection D; frame G binds fills to V:2 at node level. Option B: this stays
// an inline token NAME (legacy resolveToken path), NOT an interned {token,value} object.
const singleDoc = {
  id: 'G', name: 'Card', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
  boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'V:2' }] },
};
const singleVars = { meta: {
  variableCollections: { 'D': { id: 'D', name: 'Brand', defaultModeId: 'd1',
    modes: [{ modeId: 'd1', name: 'Default' }] } },
  variables: { 'V:2': { id: 'V:2', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'D',
    valuesByMode: { d1: { r: 0.1, g: 0.2, b: 0.3, a: 1 } } } },
} };

// withDiscovery (C2 positive controls): wires a coverage-capable getDocumentRaw so
// discoverAncestorModes can locate the request node under a DOCUMENT -> CANVAS chain and reach
// a top-level CANVAS, making coverageComplete true. Backward-compatible — defaults to the bare
// (no getDocumentRaw) api that the suppression tests rely on to make discovery fail/skip.
function handlerFor(docArg: unknown, varsArg: unknown, rootId: string, extraDeps: Partial<ToolDeps> = {}, withDiscovery = false) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getNodesRaw: async () => ({ nodes: { [rootId]: { document: docArg } } }),
      getVariablesLocal: async () => varsArg,
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
      ...(withDiscovery ? {
        getDocumentRaw: async () => ({ document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '99:1', type: 'CANVAS', children: [docArg] }] } }),
      } : {}),
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars: 40000,
    ...extraDeps,
  };
  registerGetDesignContextTool(server, deps);
  return (a: any): Promise<any> => call('get_design_context', a);
}

const run = () => handlerFor(doc, variables, 'F');

// Same shape as `doc`, but WITHOUT the node-level explicitVariableModes — so the collection's
// mode is never confirmed on the stack and the resolver honestly falls back to the default mode.
const docNoExplicitMode = {
  id: 'F', name: 'Header', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  children: [{ id: 'L', name: '24/Stroke/menu', type: 'VECTOR',
    strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
    boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:1' }] } }],
};

describe('get_design_context node-mode resolution', () => {
  it('resolves a stroke token with ancestor-chain evidence', async () => {
    const res = await run()({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef]).toMatchObject({
      token: 'text color/accent', default_value: '#a73afd', effective_rendered_value: '#8b6afb', value: '#8b6afb',
      effective_mode_source: 'ancestor_chain',
      effective_modes: { Theme: { mode: 'Dusk', source: 'ancestor_chain', node_id: 'F' } },
    });
  });

  // mode_source:'node' is confirmed — no hint needed. The agent already knows the
  // on-screen value; pointing it at get_variables would just be noise inside the size budget.
  it('does NOT attach a hint when mode_source=node (confirmed)', async () => {
    const res = await run()({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef].hint).toBeUndefined();
  });

  // mode_source:'default' means the shown value may NOT be the on-screen color.
  // The tool must attach a terse pointer to get_variables so the agent can look up the real
  // per-mode value for its sub-brand/theme instead of trusting the collection default.
  it('keeps the default diagnostic-only when mode evidence is incomplete', async () => {
    const res = await handlerFor(docNoExplicitMode, variables, 'F')({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    const resolved = body.globalVars[strokeRef];
    expect(resolved).toMatchObject({
      default_value: '#a73afd', effective_rendered_value: null, value: null,
      effective_mode_source: 'unverifiable',
      hint: 'mode evidence incomplete - default_value is diagnostic only; do not use it as the rendered color',
    });
  });

  // Option B pin: a single-mode LOCAL binding reverts to the legacy inline token NAME — no
  // interned {token,value} object. (Fails against the pre-fix always-object code, where fill
  // would be a `fill_N` ref pointing at an interned object.)
  it('renders a single-mode local fill as the inline token name (no interned object)', async () => {
    const res = await handlerFor(singleDoc, singleVars, 'G')({ file: 'abc', node_id: 'G', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.node.fill).toBe('color/brand/primary');
    expect(String(body.node.fill)).not.toMatch(/^fill_/);            // not a globalVars ref
    const interned = Object.values(body.globalVars ?? {});
    expect(interned).not.toContainEqual(expect.objectContaining({ token: 'color/brand/primary' }));
    // Non-mode-dependent tokens are unaffected — no hint anywhere in globalVars.
    expect(interned.some((v) => typeof v === 'object' && v !== null && 'hint' in v)).toBe(false);
  });
});

// modes_applied surfaces at the tool boundary — local path end-to-end, graph path pass-through.
const docTwoAxes = {
  id: 'F', name: 'Header', type: 'FRAME', explicitVariableModes: { 'VC:A': 'a2', 'VC:B': 'b2' },
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  children: [{ id: 'L', name: 'accent', type: 'VECTOR',
    strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
    boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:src' }] } }],
};
const varsTwoAxes = { meta: {
  variableCollections: {
    'VC:A': { id: 'VC:A', name: 'Theme', defaultModeId: 'a1',
      modes: [{ modeId: 'a1', name: 'Default' }, { modeId: 'a2', name: 'Dark' }] },
    'VC:B': { id: 'VC:B', name: 'Palette', defaultModeId: 'b1',
      modes: [{ modeId: 'b1', name: 'Light' }, { modeId: 'b2', name: 'Night' }] },
  },
  variables: {
    'V:src': { id: 'V:src', name: 'src/accent', resolvedType: 'COLOR', variableCollectionId: 'VC:A',
      valuesByMode: { a1: { type: 'VARIABLE_ALIAS', id: 'V:tgt' }, a2: { type: 'VARIABLE_ALIAS', id: 'V:tgt' } } },
    'V:tgt': { id: 'V:tgt', name: 'tgt/base', resolvedType: 'COLOR', variableCollectionId: 'VC:B',
      valuesByMode: { b1: { r: 1, g: 1, b: 1, a: 1 }, b2: { r: 0, g: 0, b: 0, a: 1 } } },
  },
} };

describe('get_design_context modes_applied', () => {
  it('local cross-collection chain carries structured effective modes', async () => {
    const res = await handlerFor(docTwoAxes, varsTwoAxes, 'F')({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef]).toMatchObject({
      token: 'src/accent', default_value: '#ffffff', effective_rendered_value: '#000000', value: '#000000',
      effective_mode_source: 'ancestor_chain',
      effective_modes: {
        Theme: { mode: 'Dark', source: 'ancestor_chain', node_id: 'F' },
        Palette: { mode: 'Night', source: 'ancestor_chain', node_id: 'F' },
      },
    });
  });

  it('single-axis token carries its effective mode evidence', async () => {
    const res = await run()({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef].effective_modes).toEqual({
      Theme: { mode: 'Dusk', source: 'ancestor_chain', node_id: 'F' },
    });
  });

  it('graph path: resolveInMode modes_applied passes through, hint interplay intact', async () => {
    const crossLibId = 'VariableID:' + 'a'.repeat(40) + '/1:1';
    const docCross = {
      id: 'F', name: 'Header', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      children: [{ id: 'L', name: 'accent', type: 'VECTOR',
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
        boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: crossLibId }] } }],
    };
    const variableGraph: ToolDeps['variableGraph'] = {
      resolve: () => undefined,
      isMultiMode: () => true,
      resolveInMode: () => ({
        token: 'text color/accent', default_value: '#a73afd', effective_rendered_value: null, value: null,
        mode_dependent: true, effective_mode_source: 'unverifiable',
        effective_modes: {
          Theme: { mode: 'Light', source: 'unverifiable' },
          'sub-brand': { mode: 'Solar', source: 'ancestor_chain', node_id: 'FRAME' },
        },
        pinned_axis_used: true, unconfirmed_default_used: false,
      }),
    };
    const res = await handlerFor(docCross, { meta: { variableCollections: {}, variables: {} } }, 'F', { variableGraph })({
      file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    expect(body.globalVars[strokeRef]).toMatchObject({
      token: 'text color/accent', default_value: '#a73afd', effective_rendered_value: null, value: null,
      effective_mode_source: 'unverifiable',
      hint: 'mode evidence incomplete - default_value is diagnostic only; do not use it as the rendered color',
    });
  });

  // fu2 (post-whole-branch, finding-1 render-lock): END-TO-END through the REAL graph (not a stub) — a
  // single-mode-top cross-library token whose multi-mode downstream FELLS BACK now renders as the
  // mode-aware interned OBJECT + ⚠️ hint, NOT the legacy inline var()-name. Composes the variable-graph
  // MIRROR fix (resolveKeyInMode emits mode_dependent:true for single-top+fellback) with the tool's
  // Option-B render. Before the mirror fix resolveKeyInMode returned mode_dependent:false → the tool
  // returned null → legacy inline render (value silently mis-presented as a fixed color); the suite only
  // asserted response-level mode_context for this topology, never the node render (reviewer coverage-gap).
  it('fu2 render-lock: single-mode-top cross-lib token + downstream fellback → mode-aware object + hint (real graph)', async () => {
    const KA = 'a'.repeat(40), KB = 'b'.repeat(40);
    const g = buildGraph([
      { fileKey: 'L1', colls: [{ collection_id: 'C_sem', default_mode: 's1', modes: [{ modeId: 's1', name: 'Only' }] }],
        vars: [{ library_key: KA, local_id: 'VariableID:1:1', collection_id: 'C_sem',
          values_by_mode: { s1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + KB + '/9:9' } }, name: 'surface/card', resolved_type: 'COLOR', code_syntax_web: '' }] },
      { fileKey: 'L2', colls: [{ collection_id: 'C_pal', default_mode: 'pA', modes: [{ modeId: 'pA', name: 'Lunar' }, { modeId: 'pB', name: 'Solar' }] }],
        vars: [{ library_key: KB, local_id: 'VariableID:9:9', collection_id: 'C_pal',
          values_by_mode: { pA: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, pB: { r: 0.545, g: 0.416, b: 0.984, a: 1 } }, name: 'palette/accent', resolved_type: 'COLOR', code_syntax_web: '' }] },
    ]);
    const variableGraph: ToolDeps['variableGraph'] = {
      resolve: (key) => { const r = resolveKey(g, key); return r.value !== undefined ? { value: r.value, name: r.name } : undefined; },
      resolveInMode: (key, stack, cc, evidence) => resolveKeyInMode(g, key, stack, cc, evidence),
      isMultiMode: (key) => keyIsMultiMode(g, key),
    };
    const crossLibId = 'VariableID:' + KA + '/1:1';
    const docCross = {
      id: 'F', name: 'Header', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      children: [{ id: 'L', name: 'accent', type: 'VECTOR',
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
        boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: crossLibId }] } }],
    };
    const res = await handlerFor(docCross, { meta: { variableCollections: {}, variables: {} } }, 'F', { variableGraph })({
      file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    const strokeRef = body.node.children[0].stroke;
    // mode-aware interned object with default-mode hint — BEFORE the mirror fix this was a legacy inline
    // string (no token/mode_dependent/hint), so toMatchObject on these fields is the render-path lock.
    expect(body.globalVars[strokeRef]).toMatchObject({
      token: 'surface/card', default_value: '#a73afd', effective_rendered_value: null, value: null,
      mode_dependent: true, effective_mode_source: 'unverifiable',
      hint: 'mode evidence incomplete - default_value is diagnostic only; do not use it as the rendered color',
    });
  });
});

// mode_context: positive-evidence top-level marker (spec (P)+(1)+(2)).
// docNoPins: no explicitVariableModes anywhere; binding resolves locally via defaults.
const docNoPins = {
  id: 'F', name: 'Header', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  children: [{ id: 'L', name: 'accent', type: 'VECTOR',
    strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
    boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:1' }] } }],
};

describe('get_design_context mode_context', () => {
  it('library_default_modes: registry hit + all-default resolve + no pins in scope', async () => {
    const libraryFiles = { has: async () => true };
    const res = await handlerFor(docNoPins, variables, 'F', { libraryFiles }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.mode_context).toBe('library_default_modes');
  });

  it('default_modes when the file is not in the registry (or the dep is absent)', async () => {
    const notLib = { has: async () => false };
    const res1 = await handlerFor(docNoPins, variables, 'F', { libraryFiles: notLib }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res1.content[0].text).mode_context).toBe('default_modes');
    const res2 = await handlerFor(docNoPins, variables, 'F', {}, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res2.content[0].text).mode_context).toBe('default_modes');  // single-tenant degradation
  });

  it('absent when a pin exists in the fetched scope (even unconsumed-looking topologies)', async () => {
    const res = await handlerFor(docTwoAxes, varsTwoAxes, 'F', { libraryFiles: { has: async () => true } })({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.mode_context).toBeUndefined();   // explicitVariableModes on F + consumed pins
  });

  it('absent when idx failed to load (spec (P)): variables fetch error', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getNodesRaw: async () => ({ nodes: { F: { document: docNoPins } } }),
        getVariablesLocal: async () => { throw new Error('403 non-enterprise'); },
        getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
        getFileComponentSets: async () => [],
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger, maxResultChars: 40000,
      libraryFiles: { has: async () => true },
    };
    registerGetDesignContextTool(server, deps);
    const res = await call('get_design_context', { file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(textOf(res.content[0])).mode_context).toBeUndefined();
  });

  it('absent when a cross-library binding has no graph to track it (spec (P): untracked)', async () => {
    const crossLibId = 'VariableID:' + 'b'.repeat(40) + '/1:1';
    const docCross = { ...docNoPins,
      children: [{ ...docNoPins.children[0], boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: crossLibId }] } }] };
    const res = await handlerFor(docCross, { meta: { variableCollections: {}, variables: {} } }, 'F', { libraryFiles: { has: async () => true } })({
      file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('absent when a gradient-stop binding is present (structurally untracked)', async () => {
    const docGrad = { ...docNoPins,
      children: [{ id: 'G', name: 'grad', type: 'VECTOR',
        fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [
          { position: 0, color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:1' } } },
        ] }] }] };
    const res = await handlerFor(docGrad, variables, 'F', { libraryFiles: { has: async () => true } })({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('absent when a pin was CONSUMED via graph on a single-mode top (finding-4 topology)', async () => {
    const crossLibId = 'VariableID:' + 'c'.repeat(40) + '/1:1';
    const docCross = { ...docNoPins,
      children: [{ ...docNoPins.children[0], boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: crossLibId }] } }] };
    const variableGraph: ToolDeps['variableGraph'] = {
      resolve: () => ({ value: '#000000' }),
      isMultiMode: () => false,
      resolveInMode: () => ({ value: '#000000', pinned_axis_used: true, unconfirmed_default_used: false }),
    };
    const res = await handlerFor(docCross, { meta: { variableCollections: {}, variables: {} } }, 'F', { variableGraph, libraryFiles: { has: async () => true } })({
      file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('depth-cut truncation does NOT suppress the field', async () => {
    const deepDoc = { ...docNoPins,
      children: [{ id: 'M', name: 'mid', type: 'FRAME',
        children: [{ id: 'D', name: 'deep', type: 'FRAME', children: [{ id: 'D2', name: 'deeper', type: 'FRAME', children: [{ id: 'D3', name: 'deepest', type: 'FRAME', children: [{ id: 'D4', name: 'bottom', type: 'FRAME' }] }] }] }] }] };
    const res = await handlerFor(deepDoc, variables, 'F', { libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', depth: 2, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.mode_context).toBe('library_default_modes');
  });

  it('pinned_axis_used never serializes into the response', async () => {
    const res = await handlerFor(docNoPins, variables, 'F', { libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(res.content[0].text).not.toContain('pinned_axis_used');
  });

  it('absent when an effect (shadow) color is variable-bound (untracked path)', async () => {
    const docShadow = { ...docNoPins,
      children: [{ id: 'S', name: 'card', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4,
          boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }] }] };
    const res = await handlerFor(docShadow, variables, 'F', { libraryFiles: { has: async () => true } })({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('absent when a non-paint node property is variable-bound (cornerRadius etc.)', async () => {
    const docScalar = { ...docNoPins,
      children: [{ id: 'R', name: 'pill', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        cornerRadius: 8, boundVariables: { topLeftRadius: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }] };
    const res = await handlerFor(docScalar, variables, 'F', { libraryFiles: { has: async () => true } })({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('absent when ancestor discovery was needed but could not complete (C2)', async () => {
    // docNoPins carries an unpinned multi-mode binding -> needsAncestors() true; the default
    // handlerFor fake api has no getDocumentRaw -> discovery throws -> coverageComplete false.
    // NOTE: this is the OLD positive-control fixture — after C2 the marker must be ABSENT here.
    const res = await handlerFor(docNoPins, variables, 'F', { libraryFiles: { has: async () => true } })({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('absent when an effect binds a NON-color prop (radius) — R2', async () => {
    const docRadius = { ...docNoPins,
      children: [{ id: 'S', name: 'card', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4,
          boundVariables: { radius: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }] }] };
    const res = await handlerFor(docRadius, variables, 'F', { libraryFiles: { has: async () => true } })({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('absent for a single-mode top whose multi-mode hop defaulted without coverage — R1', async () => {
    // semantic (single-mode) -> palette (multi-mode) local chain; no pins anywhere in the subtree;
    // needsAncestors() is false for this topology so discovery never runs -> the palette default is
    // UNCONFIRMED and the marker must stay silent.
    const varsSemantic = { meta: {
      variableCollections: {
        'VC:S': { id: 'VC:S', name: 'Semantic', defaultModeId: 's1', modes: [{ modeId: 's1', name: 'Only' }] },
        'VC:P': { id: 'VC:P', name: 'Palette', defaultModeId: 'p1',
          modes: [{ modeId: 'p1', name: 'Light' }, { modeId: 'p2', name: 'Night' }] },
      },
      variables: {
        'V:sem': { id: 'V:sem', name: 'semantic/bg', resolvedType: 'COLOR', variableCollectionId: 'VC:S',
          valuesByMode: { s1: { type: 'VARIABLE_ALIAS', id: 'V:pal' } } },
        'V:pal': { id: 'V:pal', name: 'palette/bg', resolvedType: 'COLOR', variableCollectionId: 'VC:P',
          valuesByMode: { p1: { r: 1, g: 1, b: 1, a: 1 }, p2: { r: 0, g: 0, b: 0, a: 1 } } },
      },
    } };
    const docSem = { ...docNoPins,
      children: [{ ...docNoPins.children[0], boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:sem' }] } }] };
    const res = await handlerFor(docSem, varsSemantic, 'F', { libraryFiles: { has: async () => true } })({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('absent when a paint-level opacity is variable-bound (alpha bakes into the shown hex) — R3', async () => {
    const docOpacity = { ...docNoPins,
      children: [{ id: 'O', name: 'veil', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5,
          boundVariables: { opacity: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }] }] };
    const res = await handlerFor(docOpacity, variables, 'F', { libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  // Observability: a suppressed marker leaves ONE info line naming every gate input, so prod can
  // tell WHICH conjunct silenced it (registry-vs-scalars-vs-pins was undiagnosable at acceptance).
  it('suppression logs the gate-input vector (design_context.mode_context_suppressed)', async () => {
    const infos: [Record<string, unknown>, string][] = [];
    const spyLogger = {
      info: (obj: Record<string, unknown>, msg: string) => { infos.push([obj, msg]); },
      warn() {}, error() {}, debug() {}, child() { return spyLogger; },
    } as unknown as typeof logger;
    await handlerFor(docTwoAxes, varsTwoAxes, 'F', { logger: spyLogger, libraryFiles: { has: async () => true } })({
      file: 'abc', node_id: 'F', include_component_docs: false });
    const hit = infos.find(([, msg]) => msg === 'design_context.mode_context_suppressed');
    expect(hit).toBeDefined();
    expect(hit![0]).toMatchObject({
      pinned_axis_used: true, pins_in_scope: true,           // docTwoAxes pins + consumes both axes
      idx_ok: true, untracked_binding: false,
    });
    expect(hit![0]).toHaveProperty('ancestor_discovery_wanted');
    expect(hit![0]).toHaveProperty('coverage_complete');
    expect(hit![0]).toHaveProperty('unconfirmed_default_used');
  });

  it('emission does NOT log the suppression line', async () => {
    const infos: string[] = [];
    const spyLogger = {
      info: (_obj: Record<string, unknown>, msg: string) => { infos.push(msg); },
      warn() {}, error() {}, debug() {}, child() { return spyLogger; },
    } as unknown as typeof logger;
    const res = await handlerFor(docNoPins, variables, 'F', { logger: spyLogger, libraryFiles: { has: async () => true } }, true)({
      file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBe('library_default_modes');
    expect(infos).not.toContain('design_context.mode_context_suppressed');
  });

  // Granular (P+): single-mode bindings cannot vary by brand — they must NOT suppress the marker.
  const variablesWithScalar = { meta: {
    variableCollections: {
      ...variables.meta.variableCollections,
      'VC:R': { id: 'VC:R', name: 'Radius const', defaultModeId: 'r1', modes: [{ modeId: 'r1', name: 'Mode 1' }] },
    },
    variables: {
      ...variables.meta.variables,
      'V:rad': { id: 'V:rad', name: 'radius/m', resolvedType: 'FLOAT', variableCollectionId: 'VC:R',
        valuesByMode: { r1: 8 } },
    },
  } };

  it('single-mode node-scalar binding does NOT suppress (granular P+)', async () => {
    const docScalarSingle = { ...docNoPins,
      children: [{ id: 'R', name: 'pill', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        cornerRadius: 8, boundVariables: { topLeftRadius: { type: 'VARIABLE_ALIAS', id: 'V:rad' } } }] };
    const res = await handlerFor(docScalarSingle, variablesWithScalar, 'F', { libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBe('library_default_modes');
  });

  it('single-mode effect and paint-opacity bindings do NOT suppress', async () => {
    const docFx = { ...docNoPins,
      children: [{ id: 'S', name: 'card', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5,
          boundVariables: { opacity: { type: 'VARIABLE_ALIAS', id: 'V:rad' } } }],
        effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4,
          boundVariables: { radius: { type: 'VARIABLE_ALIAS', id: 'V:rad' } } }] }] };
    const res = await handlerFor(docFx, variablesWithScalar, 'F', { libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBe('library_default_modes');
  });

  it('single-mode gradient-stop binding does NOT suppress', async () => {
    const docGradS = { ...docNoPins,
      children: [{ id: 'G', name: 'grad', type: 'VECTOR',
        fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [
          { position: 0, color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:rad' } } },
        ] }] }] };
    const res = await handlerFor(docGradS, variablesWithScalar, 'F', { libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBe('library_default_modes');
  });

  it('DANGLING scalar binding id still suppresses (unresolvable)', async () => {
    const docGhost = { ...docNoPins,
      children: [{ id: 'R', name: 'pill', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        boundVariables: { topLeftRadius: { type: 'VARIABLE_ALIAS', id: 'V:ghost' } } }] };
    const res = await handlerFor(docGhost, variablesWithScalar, 'F', { libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res.content[0].text).mode_context).toBeUndefined();
  });

  it('cross-lib scalar binding: no graph → suppresses; graph says single-mode → does not', async () => {
    const xId = 'VariableID:' + 'd'.repeat(40) + '/7:7';
    const docX = { ...docNoPins,
      children: [{ id: 'R', name: 'pill', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        boundVariables: { topLeftRadius: { type: 'VARIABLE_ALIAS', id: xId } } }] };
    const res1 = await handlerFor(docX, variablesWithScalar, 'F', { libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res1.content[0].text).mode_context).toBeUndefined();          // no variableGraph
    const variableGraph: ToolDeps['variableGraph'] = {
      resolve: () => ({ value: '8' }),                                              // known key, no modesByName
      isMultiMode: () => false,
      resolveInMode: () => undefined,
    };
    const res2 = await handlerFor(docX, variablesWithScalar, 'F', { variableGraph, libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res2.content[0].text).mode_context).toBe('library_default_modes');
    const graphMiss: ToolDeps['variableGraph'] = { resolve: () => undefined, isMultiMode: () => false, resolveInMode: () => undefined };
    const res3 = await handlerFor(docX, variablesWithScalar, 'F', { variableGraph: graphMiss, libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(JSON.parse(res3.content[0].text).mode_context).toBeUndefined();          // key not in graph
  });

  it('suppression log names untracked_kinds', async () => {
    const infos: [Record<string, unknown>, string][] = [];
    const spyLogger = {
      info: (obj: Record<string, unknown>, msg: string) => { infos.push([obj, msg]); },
      warn() {}, error() {}, debug() {}, child() { return spyLogger; },
    } as unknown as typeof logger;
    const docMulti = { ...docNoPins,
      children: [{ id: 'R', name: 'pill', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        boundVariables: { topLeftRadius: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }] };   // V:1 = multi-mode
    await handlerFor(docMulti, variablesWithScalar, 'F', { logger: spyLogger, libraryFiles: { has: async () => true } }, true)({ file: 'abc', node_id: 'F', include_component_docs: false });
    const hit = infos.find(([, msg]) => msg === 'design_context.mode_context_suppressed');
    expect(hit![0]).toMatchObject({ untracked_binding: true, untracked_kinds: ['node-scalar'] });
  });
});
