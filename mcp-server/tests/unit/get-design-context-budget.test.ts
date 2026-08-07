import { describe, it, expect } from 'vitest';
import { registerGetDesignContextTool } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

// Fixtures: docNoPins/variables analogues copied from get-design-context-modes.test.ts
// (small local doc — no explicitVariableModes anywhere; binding resolves locally via defaults).
const docNoPins = {
  id: 'F', name: 'Header', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  children: [{ id: 'L', name: 'accent', type: 'VECTOR',
    strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 1.5,
    boundVariables: { strokes: [{ type: 'VARIABLE_ALIAS', id: 'V:1' }] } }],
};
const variables = { meta: {
  variableCollections: { 'C': { id: 'C', name: 'Theme', defaultModeId: 'm1',
    modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dusk' }] } },
  variables: { 'V:1': { id: 'V:1', name: 'text color/accent', resolvedType: 'COLOR', variableCollectionId: 'C',
    valuesByMode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } } } },
} };

// handlerFor: copied from get-design-context-modes.test.ts — accepts extraDeps (incl.
// toolTimeBudgetMs) and an optional coverage-capable getDocumentRaw (withDiscovery).
// get_design_context's handler takes the MCP `extra` (progressToken + sendNotification) as a
// SECOND argument, for its heartbeat notifications. The shared fake's call() models args only, so
// this harness reaches the recorded registration directly rather than widening the shared fake
// into a configuration surface for its one caller.
type HandlerWithExtra = (a: any, extra?: any) => Promise<any>;

function handlerFor(docArg: unknown, varsArg: unknown, rootId: string, extraDeps: Partial<ToolDeps> = {}, withDiscovery = false) {
  const { server, get } = makeFakeMcpServer();
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
  return get('get_design_context')!.handler as unknown as HandlerWithExtra;
}

// handlerForApi — small variant of handlerFor taking a raw fake api object.
function handlerForApi(apiObj: Record<string, unknown>, extraDeps: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => apiObj as unknown as FigmaApi,
    defaultToken: 'figd_x', logger, maxResultChars: 40000,
    ...extraDeps,
  };
  registerGetDesignContextTool(server, deps);
  return (a: any): Promise<any> => call('get_design_context', a);
}

describe('get_design_context time budget', () => {
  it('tiny budget: enrichment stages skip into degraded_stages, core subtree still renders', async () => {
    const res = await handlerFor(docNoPins, variables, 'F', { toolTimeBudgetMs: 1000, libraryFiles: { has: async () => true } })({
      file: 'abc', node_id: 'F', include_component_docs: true, include_screenshot: true });
    const body = JSON.parse(res.content[0].text);
    expect(body.node.children[0].stroke).toBeDefined();               // core rendering intact (raw hex)
    const stages = Object.fromEntries((body.degraded_stages ?? []).map((d: any) => [d.stage, d.reason]));
    expect(stages.variables).toBe('time_budget');                     // remaining < 5s floor
    expect(body.mode_context).toBeUndefined();                        // idx missing -> existing honesty
  });

  it('core subtree fetch over budget fail-fasts with an actionable depth suggestion', async () => {
    // The core fetch now runs on a REAL capped api (buildApi(token, capMs)): an over-budget fetch
    // aborts INSIDE the adapter as a settled FigmaApiError('network', '… timed out …'). No race, no
    // real sleeps — the fake throws that exact timeout error and the tool maps it to the depth hint.
    const timeoutApi = {
      getNodesRaw: async () => { throw new FigmaApiError('network', 0, 'Figma request timed out after 1000ms'); },
      getVariablesLocal: async () => variables,
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(timeoutApi, { toolTimeBudgetMs: 90_000 })({ file: 'abc', node_id: 'F', depth: 5, include_component_docs: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/depth <= 3/);                // 5 - 2
    // Honest about uncertainty: a timeout cannot prove the node is heavy —
    // Figma may just be slow or rate-limiting. The message must not assert a false cause.
    expect(res.content[0].text).toMatch(/may be too heavy, or Figma may be slow or rate-limiting/);
  });

  it('depth<=2 timeout: no degenerate depth suggestion — suggests child nodes / retry instead', async () => {
    const timeoutApi = {
      getNodesRaw: async () => { throw new FigmaApiError('network', 0, 'Figma request timed out after 1000ms'); },
      getVariablesLocal: async () => variables,
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(timeoutApi, { toolTimeBudgetMs: 90_000 })({ file: 'abc', node_id: 'F', depth: 1, include_component_docs: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain('depth <= 1');          // "retry with the same depth" is no advice
    expect(res.content[0].text).toMatch(/child nodes directly/);
    expect(res.content[0].text).toMatch(/retry shortly/);
  });

  it('R4-F2: a rate_limited from the core fetch errors the WHOLE call (invariant now holds for core too)', async () => {
    // The core fetch runs on a real capped api, so a 429 is a settled rejection here — it rethrows
    // FIRST (before the timeout-shaped branch) and surfaces as a back-off signal, never a fail-fast
    // "too heavy" message that would mislead the agent into lowering depth.
    const rateLimitedApi = {
      getNodesRaw: async () => { throw new FigmaApiError('rate_limited', 429, 'slow down', 5); },
      getVariablesLocal: async () => variables,
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(rateLimitedApi, { toolTimeBudgetMs: 90_000 })({ file: 'abc', node_id: 'F', depth: 5, include_component_docs: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/rate_limited|rate limit/i);
    expect(res.content[0].text).not.toMatch(/too heavy/);            // not misclassified as a heavy-node timeout
  });

  it("variables 'cached:' failure classifies as cached_error", async () => {
    const api = {
      getNodesRaw: async () => ({ nodes: { F: { document: docNoPins } } }),
      getVariablesLocal: async () => { throw new Error('cached: Figma request timed out after 90000ms'); },
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(api, {})({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.degraded_stages).toContainEqual({ stage: 'variables', reason: 'cached_error' });
  });

  it("a plain (non-cached, non-timeout) variables failure classifies as reason 'error'", async () => {
    const api = {
      getNodesRaw: async () => ({ nodes: { F: { document: docNoPins } } }),
      getVariablesLocal: async () => { throw new Error('boom'); },
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(api, {})({ file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.degraded_stages).toContainEqual({ stage: 'variables', reason: 'error' });
  });

  it('R2-F1 invariant: a rate_limited from getVariablesLocal errors the WHOLE call — never a quiet degrade', async () => {
    // Variables now run under a REAL per-call timeout (buildApi(token, cap)), not a race, so a
    // rate_limited rejection is a settled rejection here that rethrows and surfaces to the agent as
    // a back-off signal — it can NEVER be swallowed into an isError:false degraded_stages success.
    const api = {
      getNodesRaw: async () => ({ nodes: { F: { document: docNoPins } } }),
      getVariablesLocal: () => new Promise((_r, rej) =>
        setTimeout(() => rej(new FigmaApiError('rate_limited', 429, 'slow down', 5)), 100)),
      getImages: async () => ({ images: {} }), getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(api, { toolTimeBudgetMs: 90_000 })({ file: 'abc', node_id: 'F', include_component_docs: false });
    expect(res.isError).toBe(true);                                   // whole call fails — agent gets the back-off signal
    expect(res.content[0].text).toMatch(/rate_limited/);              // rate-limit info in the error text
    expect(() => JSON.parse(res.content[0].text)).toThrow();         // an error string, NOT a degraded JSON body
  });

  it('R3-F2: the minimal ultra-shed fallback still surfaces degraded_stages (diagnostic survives)', async () => {
    // Tiny toolTimeBudgetMs degrades the variables stage (time_budget); a tiny maxResultChars forces
    // the ultra-shed `note` path (even the `lean` literal exceeds the budget). The degraded_stages
    // diagnostic — most valuable exactly here, where nearly everything else was shed — must survive.
    const res = await handlerFor(docNoPins, variables, 'F',
      { toolTimeBudgetMs: 1000, maxResultChars: 40 })({
      file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.note).toMatch(/exceeded the size budget/);            // proves the ultra-shed path
    expect(body.degraded_stages).toContainEqual({ stage: 'variables', reason: 'time_budget' });
  });

  it('R4-F4: a screenshot fetch error records a degraded_stage (not just a log line)', async () => {
    const plainDoc = { id: 'F', name: 'Header', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 }, children: [] };
    const api = {
      getNodesRaw: async () => ({ nodes: { F: { document: plainDoc } } }),
      getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
      getImages: async () => { throw new Error('img boom'); },      // plain error (not rate_limited)
      getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(api, { toolTimeBudgetMs: 90_000 })({ file: 'abc', node_id: 'F', include_screenshot: true, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();                                 // screenshot is optional — call still succeeds
    expect(body.degraded_stages).toContainEqual({ stage: 'screenshot', reason: 'error' });
  });

  // R5-F1/F2 fixtures: a frame with an INSTANCE child so the docs/CC block actually fans out
  // into getComponent fetches (docNoPins has no instances → the block would no-op).
  const docWithInstance = { id: 'F', name: 'Card', type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
    children: [{ id: 'F:1', name: 'Btn', type: 'INSTANCE', componentId: 'C:1' }] };
  const timeoutErr = () => new FigmaApiError('network', 0, 'Figma request timed out after 1000ms');

  it('R5-F1: a timeout-shaped getComponent abort classifies docs AND code_connect as time_budget', async () => {
    const api = {
      getNodesRaw: async () => ({ nodes: { F: { document: docWithInstance, components: { 'C:1': { key: 'KEY1' } } } } }),
      getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
      getImages: async () => ({ images: {} }),
      getComponent: async () => { throw timeoutErr(); },              // capped enrichApi abort shape
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(api, { toolTimeBudgetMs: 90_000, codeConnect: { lookup: async () => new Map() } })({
      file: 'abc', node_id: 'F', include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();                                  // enrichment is optional
    expect(body.degraded_stages).toContainEqual({ stage: 'component_docs', reason: 'time_budget' });
    expect(body.degraded_stages).toContainEqual({ stage: 'code_connect', reason: 'time_budget' });
  });

  it('R5-F1: without a codeConnect dep, a timeout-shaped getComponent abort degrades ONLY component_docs', async () => {
    const api = {
      getNodesRaw: async () => ({ nodes: { F: { document: docWithInstance, components: { 'C:1': { key: 'KEY1' } } } } }),
      getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
      getImages: async () => ({ images: {} }),
      getComponent: async () => { throw timeoutErr(); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(api, { toolTimeBudgetMs: 90_000 })({ file: 'abc', node_id: 'F', include_component_docs: true });
    const body = JSON.parse(res.content[0].text);
    expect(body.degraded_stages).toContainEqual({ stage: 'component_docs', reason: 'time_budget' });
    expect((body.degraded_stages ?? []).some((d: any) => d.stage === 'code_connect')).toBe(false);
  });

  it('R5-F2: a timeout-shaped getImages abort classifies the screenshot stage as time_budget', async () => {
    const plainDoc = { id: 'F', name: 'Header', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 }, children: [] };
    const api = {
      getNodesRaw: async () => ({ nodes: { F: { document: plainDoc } } }),
      getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
      getImages: async () => { throw timeoutErr(); },                 // capped shotApi abort shape
      getComponent: async () => { throw new Error('none'); },
      getFileComponentSets: async () => [],
    };
    const res = await handlerForApi(api, { toolTimeBudgetMs: 90_000 })({ file: 'abc', node_id: 'F', include_screenshot: true, include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();                                  // screenshot is optional
    expect(body.degraded_stages).toContainEqual({ stage: 'screenshot', reason: 'time_budget' });
  });

  it('R5-F1/F2: docs/CC and screenshot fetches run on a CAPPED buildApi instance (never a plain api)', async () => {
    // Pin the fix itself, not just the catch classification: every buildApi call must carry a real
    // timeoutMs bound (1s..90s). core + variables + docs/CC + screenshot — the dead uncapped base
    // instance (previously built just to satisfy discoverAncestorModes' required `api` param) is
    // gone; the tool now passes the already-built, capped `coreApi` there instead (its no-deadline
    // fallback branch is unreachable from the tool since deadlineAt+makeCappedApi are always set).
    const caps: Array<number | undefined> = [];
    const apiObj = {
      getNodesRaw: async () => ({ nodes: { F: { document: docWithInstance, components: { 'C:1': { key: 'KEY1' } } } } }),
      getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
      getImages: async () => ({ images: { F: 'https://img' } }),
      getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button' }),
      getFileComponentSets: async () => [],
    };
    const { server, call } = makeFakeMcpServer();
    registerGetDesignContextTool(server, {
      buildApi: (_t: string, timeoutMs?: number) => { caps.push(timeoutMs); return apiObj as unknown as FigmaApi; },
      defaultToken: 'figd_x', logger, maxResultChars: 40000, toolTimeBudgetMs: 90_000,
    } as ToolDeps);
    const res = await call('get_design_context', { file: 'abc', node_id: 'F', include_component_docs: true, include_screenshot: true });
    expect(res.isError).toBeFalsy();
    expect(caps.length).toBe(4);                                      // core, variables, docs/CC, screenshot
    for (const c of caps) {
      expect(c).toBeGreaterThanOrEqual(1_000);
      expect(c).toBeLessThanOrEqual(90_000);
    }
  });

  it('generous budget on a light file: NO degraded_stages, response byte-identical shape', async () => {
    const res = await handlerFor(docNoPins, variables, 'F', { libraryFiles: { has: async () => true } }, true)({
      file: 'abc', node_id: 'F', include_component_docs: false });
    const body = JSON.parse(res.content[0].text);
    expect(body.degraded_stages).toBeUndefined();
    expect(body.mode_context).toBe('library_default_modes');          // regression pin
  });
});

describe('get_design_context size budget — all 5 measurements over the DELIVERED serialization (final F1)', () => {
  // Two-run scheme: the big run → deliveredLen from the real (compact) delivery; the tight anchor
  // just ABOVE it (but BELOW the pretty of the same shape — a guard inside the test); the edge probe deliveredLen-1 —
  // the only catcher of an under-estimate. Previously all 5 measurements (sizeOf for fitToBudget + 4 rungs of the
  // shed-ladder) ran pretty (×~2.2 on this fixture) while jsonResult delivered compact: a response in the
  // (compact, pretty] window lost the screenshot/depth/globalVars even though it fit whole.
  const kids = Array.from({ length: 6 }, (_, i) => ({
    id: `K:${i}`, name: `section-block-${i}`, type: 'FRAME',
    absoluteBoundingBox: { x: i * 10, y: 0, width: 120, height: 80 },
    children: [
      { id: `K:${i}a`, name: `label-${i}-a`, type: 'TEXT', characters: `Heading text ${i}a`, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 } },
      { id: `K:${i}b`, name: `label-${i}-b`, type: 'TEXT', characters: `Body copy line ${i}b`, absoluteBoundingBox: { x: 0, y: 24, width: 100, height: 20 } },
    ],
  }));
  const denseDoc = { id: 'F', name: 'Hero', type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 },
    children: [...kids, { id: 'F:9', name: 'CardBtn', type: 'INSTANCE', componentId: 'C:1',
      absoluteBoundingBox: { x: 0, y: 500, width: 120, height: 40 } }] };
  const shotUrl = 'https://figma-shots.example/abc123?sig=' + 'x'.repeat(120);
  // component docs in the fixture: the edge probe distinguishes the ladder rungs — components survive
  // the screenshot shed (:noShot), whereas a pretty mutation in the noShot/noDocs rungs would have dropped them.
  const denseApi = () => ({
    getNodesRaw: async () => ({ nodes: { F: { document: denseDoc, components: { 'C:1': { key: 'KEY1' } } } } }),
    getVariablesLocal: async () => ({ meta: { variables: {}, variableCollections: {} } }),
    getImages: async () => ({ images: { F: shotUrl } }),
    getComponent: async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'Button', description: 'Primary action button, use for main CTA.' }),
    getFileComponentSets: async () => [],
  });
  const callArgs = { file: 'abc', node_id: 'F', depth: 3, include_component_docs: true, include_screenshot: true };

  it('budget between compact and pretty: the FULL response, no screenshot shed and no depth-degrade', async () => {
    // Run 1 (big): the real deliveredLen of the full response with the screenshot.
    const res1 = await handlerForApi(denseApi(), { toolTimeBudgetMs: 90_000 })(callArgs);
    const text1 = res1.content[0].text as string;
    const body1 = JSON.parse(text1);
    expect(body1.screenshot).toBe(shotUrl);                          // co-lock: the screenshot is present in the big run
    expect(body1.components).toBeDefined();                          // co-lock: docs are present in the big run
    expect(body1.degraded).toBe(false);
    // Run 2 (tight): a budget ABOVE the delivered, BELOW pretty — the mutations "pretty in sizeOf"
    // (fitToBudget trims depth) and "pretty in the shed gate" (trims the screenshot) both → RED.
    const budget = text1.length + 100;
    expect(budget).toBeLessThan(JSON.stringify(body1, null, 2).length); // mutation-discrimination guard
    const res2 = await handlerForApi(denseApi(), { toolTimeBudgetMs: 90_000, maxResultChars: budget })(callArgs);
    const text2 = res2.content[0].text as string;
    expect(text2).toBe(text1);                                       // a byte-identical full response
    expect(text2.length).toBeLessThanOrEqual(budget);
  });

  it('edge deliveredLen-1: the shed-ladder trims EXACTLY the screenshot — node intact, globalVars alive, delivery ≤ budget', async () => {
    const res1 = await handlerForApi(denseApi(), { toolTimeBudgetMs: 90_000 })(callArgs);
    const deliveredLen = (res1.content[0].text as string).length;
    const budget = deliveredLen - 1;                                 // the under-estimate catcher of the measurement
    const res2 = await handlerForApi(denseApi(), { toolTimeBudgetMs: 90_000, maxResultChars: budget })(callArgs);
    const text2 = res2.content[0].text as string;
    const body2 = JSON.parse(text2);
    expect(body2.screenshot).toBeUndefined();                        // the first ladder rung fired
    expect(body2.degraded).toBe(true);                               // shed honestly flagged
    expect(body2.node.children[0].children.length).toBe(2);          // the node is NOT trimmed by depth
    expect(body2.components).toBeDefined();                          // docs survived the shed (a pretty in the noShot/noDocs rungs would have dropped them)
    expect(body2.globalVars).toBeDefined();                          // the bottom rung did NOT switch
    expect(body2.note).toBeUndefined();                              // (a pretty in the lean rung would have dropped down here)
    expect(text2.length).toBeLessThanOrEqual(budget);
  });
});

describe('get_design_context heartbeat (progress notifications)', () => {
  it('with a progressToken: sends >=3 notifications with strictly increasing progress', async () => {
    const calls: Array<{ progress: number; total?: number; message?: string; progressToken: unknown }> = [];
    const extra = {
      _meta: { progressToken: 't1' },
      sendNotification: async (n: any) => { calls.push(n.params); },
    };
    const handler = handlerFor(docNoPins, variables, 'F', { libraryFiles: { has: async () => true } }, true);
    const res = await handler({ file: 'abc', node_id: 'F', include_component_docs: true }, extra);

    expect(res.isError).toBeFalsy();                                  // heartbeat never affects the result
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c.progressToken).toBe('t1');
    const progresses = calls.map((c) => c.progress);
    for (let i = 1; i < progresses.length; i++) expect(progresses[i]).toBeGreaterThan(progresses[i - 1]);
  });

  it('without a progressToken: zero notifications sent', async () => {
    const calls: unknown[] = [];
    const extra = { sendNotification: async (n: unknown) => { calls.push(n); } };
    const handler = handlerFor(docNoPins, variables, 'F', { libraryFiles: { has: async () => true } }, true);
    const res = await handler({ file: 'abc', node_id: 'F', include_component_docs: true }, extra);

    expect(res.isError).toBeFalsy();
    expect(calls.length).toBe(0);
  });

  it('without an extra arg at all (pre-existing call shape): does not throw', async () => {
    const handler = handlerFor(docNoPins, variables, 'F', { libraryFiles: { has: async () => true } }, true);
    const res = await handler({ file: 'abc', node_id: 'F', include_component_docs: true });
    expect(res.isError).toBeFalsy();
  });

  it('a rejecting sendNotification is swallowed — the tool call still succeeds', async () => {
    const extra = {
      _meta: { progressToken: 't1' },
      sendNotification: async () => { throw new Error('client gone'); },
    };
    const handler = handlerFor(docNoPins, variables, 'F', { libraryFiles: { has: async () => true } }, true);
    const res = await handler({ file: 'abc', node_id: 'F', include_component_docs: true }, extra);
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.node).toBeDefined();
  });

  // R8-F2 (minor): progress() called `.catch()` on the promise RETURNED by extra.sendNotification —
  // but a non-async sendNotification that throws SYNCHRONOUSLY (before returning any promise at
  // all) propagates straight out of progress() and fails the whole tool call. A plain function
  // (not `async`) is the realistic shape: it throws immediately instead of returning a rejected
  // promise.
  it('a SYNCHRONOUSLY-throwing sendNotification does not fail the tool call', async () => {
    const extra = {
      _meta: { progressToken: 't1' },
      sendNotification: () => { throw new Error('sync boom'); },
    };
    const handler = handlerFor(docNoPins, variables, 'F', { libraryFiles: { has: async () => true } }, true);
    const res = await handler({ file: 'abc', node_id: 'F', include_component_docs: true }, extra);
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.node).toBeDefined();
  });
});
