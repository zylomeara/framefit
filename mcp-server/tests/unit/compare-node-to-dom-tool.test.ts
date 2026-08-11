import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCompareNodeToDomTool, PairSchema } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import { createLogger, type Logger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode, RawVariablesResponse, RawFileResponse, RawNodesResponse } from '../../src/domain/figma-raw.js';
import type { DomSnapshotOk } from '../../src/domain/layout-spec/types.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import { buildGraph, resolveKeyInMode } from '../../src/domain/variable-graph.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
function harness(api: Partial<FigmaApi>, maxResultChars = 40000, extra: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars, ...extra };
  registerCompareNodeToDomTool(server, deps);
  return (a: any): Promise<any> => call('compare_node_to_dom', a);
}

// records logger.info calls so a test can assert an event was (or was NOT)
// emitted — mirrors the pattern in get-design-context-ancestor.test.ts's recordingLogger().
function recordingLogger(): { logger: Logger; logs: { obj: unknown; msg: string }[] } {
  const logs: { obj: unknown; msg: string }[] = [];
  const rec = (obj: unknown, msg?: string) => { logs.push({ obj, msg: msg ?? '' }); };
  const l = { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec, child: () => l } as unknown as Logger;
  return { logger: l, logs };
}

const card: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 },
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [
    { id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: { x: 16, y: 12, width: 200, height: 24 } },
    { id: '1:3', name: 'list', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 40 } },
  ],
};
const frameNode: RawSceneNode = { id: '9:1', name: 'mobile', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 } };

// "coverage manifest": the same card, but the title carries real typography
// (characters+style on the Figma side, styles on the DOM side) — font-size is actually measured.
const cardWithText: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 },
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [
    {
      id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: { x: 16, y: 12, width: 200, height: 24 },
      characters: 'Hello', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14 },
    },
    { id: '1:3', name: 'list', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 40 } },
  ],
};
const okDomWithText = {
  schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false,
  children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 }, styles: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14 },
      // p.7 migration: the carrier routing compares wrappers no more - the title owns its text
      children: [{ kind: 'text', rect: { x: 16, y: 12, w: 200, h: 24 }, text: 'Title' }] },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 84, w: 311, h: 40 } },
  ],
};

const okDom = {
  schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false,
  children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 84, w: 311, h: 40 } },
  ],
};

// budget-cascade: a fixture with MANY bulk-pass rows per pair. 12 TEXT children, each with
// matching typography → 36 pass rows of font-size/font-weight/font-family (no note, outside
// COVERAGE_META) = bulk, which condenseBulkPass collapses into ONE passes_condensed. The geometry
// does NOT match on purpose (offset-cross → 12 fail: dom x=30 ≠ figma x=16) — this yields signal
// rows (fail) that MUST SURVIVE the collapse. cardWithText carries too little bulk to
// demonstrate the cascade — hence a special fixture here with 36 TEXT axes.
// match-profiles: dom-x REALLY diverges (30≠16). Previously the geometry matched (x=16 on both sides)
// and the "signal fails" held only on a harness artifact (zod bypassed → tolerancePx=undefined →
// delta<=undefined falsely fails even on equal numbers). Now the tool resolves omitted→1 in CODE (like
// prod), so equal geometry would give a pass — the signal must be a REAL divergence.
const MANY_TEXT_N = 12;
const manyTextCard: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 600 },
  layoutMode: 'VERTICAL', itemSpacing: 8,
  children: Array.from({ length: MANY_TEXT_N }, (_, i) => ({
    id: `1:${i + 2}`, name: `t${i}`, type: 'TEXT',
    absoluteBoundingBox: { x: 16, y: 12 + i * 48, width: 200, height: 24 },
    characters: `Line ${i}`, style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14 },
  })),
};
const manyTextDom = {
  schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 600 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false,
  children: Array.from({ length: MANY_TEXT_N }, (_, i) => ({
    kind: 'element', tag: 'p', rect: { x: 30, y: 12 + i * 48, w: 200, h: 24 }, // x 30≠16 → offset-cross fail (a real signal)
    styles: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14 },
  })),
};

// a FRAME whose SOLID fill is bound to a variable — the tool must fetch
// variables + ancestor modes and resolve the color token mode-correctly into the projected spec.
const cardBoundFill: RawSceneNode = {
  id: '1:1', name: 'Card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' } } }],
};
const varsBoundFill: RawVariablesResponse = {
  meta: {
    variables: { 'VariableID:9:9': { id: 'VariableID:9:9', name: 'neutral/bg/base', resolvedType: 'COLOR', variableCollectionId: 'C', valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } } } },
    variableCollections: { C: { id: 'C', name: 'Color', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Solar' }] } },
  },
};

// EXTERNAL bound-SOLID fill (published-library id, 40-hex key) — the fixture the
// graph/snapshot-fallback discovery gate tests bind their color to. hasExternalBoundPaintColor
// (cardExtBoundFill) === true, unlike cardBoundFill's LOCAL 'VariableID:9:9' (extractLibraryKey
// rejects the non-40-hex id → null → hasExternalBoundPaintColor(cardBoundFill) === false).
const EXT_ALIAS_ID = 'VariableID:abcdef0123456789abcdef0123456789abcdef01/1:2';
const cardExtBoundFill: RawSceneNode = {
  id: '1:1', name: 'Card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: EXT_ALIAS_ID } } }],
};

// DOM for cardBoundFill (100×40, no children) — the #ffffff background matches the
// resolved token, BUT authored as a hardcoded literal (backgroundColorToken {literal:true}).
// colorVerdict group D → fail "tokenize" (never-false-green).
const okDomLiteralFill = {
  schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 100, h: 40 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false,
  styles: { display: 'block', backgroundColor: '#ffffff', backgroundColorToken: { literal: true } },
  children: [],
};

// discovery fixtures ────────────────────────────────────────────────────────────────
const FILE = 'abc';

// domFor: minimal OK DOM snapshot geometry-matched to `node`'s absoluteBoundingBox. backgroundColor
// is ALWAYS present (never undefined) so diff.ts's token-hex verdict branch runs instead of the
// "no background" warn branch (diff.ts :955) — the gate tests below don't assert on the fill row,
// but the fixture must still route through the real branch to be honest about its contract.
function domFor(node: RawSceneNode): DomSnapshotOk {
  const box = node.absoluteBoundingBox!;
  return {
    schema: 6, innerWidth: 375,
    rect: { x: box.x, y: box.y, w: box.width, h: box.height },
    borders: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 },
    children: [],
    styles: { backgroundColor: '#ffffff' },
  };
}

// docWithNode: RawFileResponse-shape for getDocumentRaw mocks — DOCUMENT -> CANVAS -> [node], the
// minimal tree buildFileStructure needs to locate `node` and reach a top-level CANVAS (so
// discoverAncestorModes' coverageComplete can go true when it actually locates the node).
function docWithNode(node: RawSceneNode): RawFileResponse {
  return {
    name: 'f', lastModified: '', version: 'v1',
    document: {
      id: '0:0', name: 'D', type: 'DOCUMENT',
      children: [{ id: '0:1', name: 'P', type: 'CANVAS', children: [node] }],
    } as unknown as RawSceneNode,
  };
}

const emptyVars: RawVariablesResponse = { meta: { variables: {}, variableCollections: {} } };
// boundVars is used directly as `getVariablesLocal` (not re-wrapped per test), so it must be
// function-shaped itself — a plain closure (not vi.fn) avoids accumulating call-count state across
// the two tests below that share it.
const boundVars = async (): Promise<RawVariablesResponse> => varsBoundFill;

describe('compare_node_to_dom tool', () => {
  it('resolves a bound fill token mode-correctly into the spec (fetches variables + ancestor modes)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
    const getVariablesLocal = vi.fn(async () => varsBoundFill);
    const getDocumentRaw = vi.fn(async () => ({
      name: 'f', lastModified: '', version: '1',
      document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [] } as unknown as RawSceneNode,
    }));
    const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw });
    const res = await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }] });
    const out = JSON.parse(res.content[0].text);
    // spec token surfaces in the color row note downstream; here assert the tool didn't throw and
    // variables were fetched (the resolver is now real, not a no-op).
    expect(out.pairs[0]).toBeDefined();
    expect(getVariablesLocal).toHaveBeenCalled();
  });

  // e2e header lock: the literal-catch verdict must reach the TOP-LEVEL receipt,
  // not just the row. A bound Figma fill token resolving to #ffffff + a DOM element whose bg is the
  // same #ffffff BUT authored as a hardcoded literal → colorVerdict group-D → fill row `fail`
  // "tokenize", which MUST propagate to verification.complete===false AND suppress the green
  // headline. Locks the whole pipe (projector token-resolve → diff verdict → summary → verification →
  // report) end-to-end in the never-false-green direction — a silent green here is the exact defect
  // this workstream exists to catch.
  it('e2e: bound token vs DOM literal + matching hex → headline not green, complete=false', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
    const getVariablesLocal = vi.fn(async () => varsBoundFill);
    const getDocumentRaw = vi.fn(async () => ({
      name: 'f', lastModified: '', version: '1',
      document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [] } as unknown as RawSceneNode,
    }));
    const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw });
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDomLiteralFill }] })).content[0].text);

    expect(out.verification.complete).toBe(false);
    expect(out.report_markdown).not.toContain('нет расхождений выше tolerance');
    // strengthen: prove it is the literal-catch axis driving the red, not an incidental geometry fail
    const fillRow = out.pairs[0].rows.find((r: any) => r.prop === 'fill');
    expect(fillRow).toMatchObject({ status: 'fail' });
    expect(fillRow.note).toMatch(/literal|tokenize/);
  });

  it('discovery gate: a pair WITHOUT bound colors → discovery NOT called (no getDocumentRaw), output as before', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
    const getDocumentRaw = vi.fn();                       // must not be called at all
    const getVariablesLocal = vi.fn(async () => emptyVars); // variables fixture as in the neighboring tests
    const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw });
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(card) }] });
    expect(getDocumentRaw).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text).pairs[0].summary).toBeDefined(); // the diff went through
  });

  // component-set-meta: the componentSets meta from /nodes already carries the set name
  // (buildSetNames) — the tool must resolve setName FROM IT, not fall into the REST cascade
  // (getComponent→getFileComponentSets), even when componentSetId isn't covered by the meta.
  it('component setName from the componentSets meta of the nodes response → figLabel with the set name, REST cascade NOT called', async () => {
    const variant: RawSceneNode = {
      id: '1:1', name: 'type=active, size=Big', type: 'INSTANCE',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 }, componentId: '5:1',
    };
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': {
      document: variant,
      components: { '5:1': { key: 'k1', name: 'type=active, size=Big', remote: true, componentSetId: '12:380' } },
      componentSets: { '12:380': { key: 'sk1', name: 'promo banner', remote: true } },
    } } } as RawNodesResponse));
    const getComponent = vi.fn();
    const getVariablesLocal = vi.fn(async () => emptyVars); // file fixture, modeled on the neighbor :189
    const run = harness({ getNodesRaw, getComponent, getVariablesLocal });
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: {
      ...domFor(variant), componentHints: { tag: 'div', classList: ['promo-banner'], data: {} },
    } }] });
    const rows = JSON.parse(res.content[0].text).pairs[0].rows;
    const row = rows.find((r: any) => r.prop === 'component');
    expect(row.figma).toBe('promo banner/type=active, size=Big');
    expect(getComponent).not.toHaveBeenCalled(); // meta-resolve: zero /v1/components fetches
  });

  // Gate finalization: the same gate pair WITHOUT bound colors, but NOW with frame_node_id
  // (the small frame fixture `frameNode`, id 9:1, no children) — so the main loop actually REACHES
  // branch C (frameId !== undefined && bestFrameRaw !== undefined are true). canvasChainFor is a
  // lazy memo (:202 `canvasChainMemo ??=`), initialized synchronously ONLY INSIDE gate A
  // (:267 `if (variableIndex && hasBoundPaintColor(...))`). card without fills/boundVariables →
  // hasBoundPaintColor(card)===false → the gate never enters its body → canvasChainFor is NEVER
  // called → getDocumentRaw(...,2) (the skeleton) is NOT fetched, and thus neither is the deadline-capped whole-file
  // discoverAncestorModes (also inside the same gate). A byte-lock on laziness: without THIS
  // test the mutation "canvasChainFor(frameId) is called unconditionally (outside gate A)" would stay invisible
  // — test A (:177) without frame_node_id never passes through branch C (frameId===undefined).
  it('latency: a pair WITHOUT bound colors + frame_node_id → canvas-memo is lazy, getDocumentRaw NOT called at all (neither depth-2 skeleton nor whole-file)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card }, '9:1': { document: frameNode } } }));
    const getDocumentRaw = vi.fn();                       // must not be called at all — neither the skeleton nor whole-file
    const getVariablesLocal = vi.fn(async () => emptyVars);
    const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw });
    const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(card) }] });
    expect(getDocumentRaw).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text).pairs[0].summary).toBeDefined(); // the diff went through
  });

  it('discovery gate: an invisible root with a bound-fill → discovery IS called (self-gate forbidden). MUTATION LOCK (green BEFORE the implementation — discovery is currently unconditional; goes red ONLY under a self-gate mutation) — NOT TDD-RED', async () => {
    const inv = { ...cardBoundFill, visible: false } as RawSceneNode;
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: inv } } }));
    const getDocumentRaw = vi.fn(async () => docWithNode(inv)); // fixture as in the bound-fill tests :100-103
    const run = harness({ getNodesRaw, getVariablesLocal: boundVars, getDocumentRaw });
    await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(inv) }] });
    expect(getDocumentRaw).toHaveBeenCalled();
  });

  it('discovery gate: variableIndex unavailable (getVariablesLocal threw) + a bound-paint node (LOCAL, WITHOUT graph/snapshot deps) → discovery NOT called — a mutation lock on the variableIndex half of the gate', async () => {
    // Lock: variableIndex is absent, hasBoundPaintColor(cardBoundFill) === true
    // (would be true for the first disjunct IF variableIndex existed), but the harness provides NEITHER
    // variableGraph NOR variableSnapshot — the second disjunct (graphOrSnapshotAvailable) is also false.
    // Skip, since NEITHER an index NOR graph/snapshot deps: discovery would be pure latency with no consumer
    // (resolveColorToken without variableIndex is always undefined, and deps-less graph/snapshot have no one
    // to resolve with). Stays green byte-for-byte — harness() without extra deps.
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
    const getDocumentRaw = vi.fn(async () => docWithNode(cardBoundFill));
    const getVariablesLocal = vi.fn(async () => { throw new Error('x'); });
    const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw });
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
    expect(getDocumentRaw).not.toHaveBeenCalled();        // discovery skipped despite the bound-paint
    expect(res.isError).toBeFalsy();                      // honest degradation (variables_unavailable), not a crash
    expect(JSON.parse(res.content[0].text).pairs[0].summary).toBeDefined();
  });

  it('a variables fetch that fails is REPORTED to the caller, not only logged: degraded_stages + a report line', async () => {
    // The defect: on a giant file this endpoint can burn ~90s of a ~124s call and then degrade
    // honestly into review rows and a confirm_token blocker — with the reason on STDERR, which no
    // MCP caller reads. The tool told the truth about the measurement and nothing about the wait,
    // so the caller could not tell waiting from hanging. Both channels a caller actually sees are
    // asserted here: the structured key and the markdown a reader pastes.
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
    const getVariablesLocal = vi.fn(async () => { throw new Error('Figma API timeout after 90000ms'); });
    const run = harness({ getNodesRaw, getVariablesLocal });
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
    expect(res.isError).toBeFalsy();                      // still a verdict, never a failure
    const out = JSON.parse(res.content[0].text);
    expect(out.degraded_stages).toEqual([
      { stage: 'variables', reason: 'error', ms: expect.any(Number), detail: 'Figma API timeout after 90000ms' },
    ]);
    expect(out.report_markdown).toContain('Figma API timeout after 90000ms');
  });

  it('a variables fetch that SUCCEEDS carries no degraded_stages key at all', async () => {
    // The other direction, because a key that is always present says nothing: an honest flag has to
    // be absent on the healthy path, or every reader learns to ignore it.
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
    const run = harness({ getNodesRaw, getVariablesLocal: boundVars });
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
    expect(JSON.parse(res.content[0].text).degraded_stages).toBeUndefined();
  });

  // needsModes second disjunct — the graph/snapshot fallback also needs discovery,
  // but ONLY when (1) variableIndex is unavailable, (2) at least one of the graph/snapshot deps is wired,
  // (3) the subtree has an EXTERNAL bound color (graph/snapshot can only resolve published-key
  // aliases, not local ones). The three tests below cover all three conditions separately.
  describe('needsModes graph need (second disjunct)', () => {
    it('(a) TRUE RED: variableIndex unavailable + variableGraph wired + a node with an EXTERNAL bound color → discovery IS called (getDocumentRaw called) — previously the gate cut on variableIndex unconditionally', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardExtBoundFill } } }));
      const getDocumentRaw = vi.fn(async () => docWithNode(cardExtBoundFill));
      const getVariablesLocal = vi.fn(async () => { throw new Error('x'); });
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
        variableGraph: { resolve: () => undefined },
      });
      const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardExtBoundFill) }] });
      expect(getDocumentRaw).toHaveBeenCalled();
      expect(res.isError).toBeFalsy();
    });

    it('(b) MUTATION LOCK (green before and after the fix; NOT TDD-RED): variableIndex unavailable + variableGraph wired, but a node with a LOCAL bound color (cardBoundFill) → discovery NOT called — graph/snapshot cannot resolve local-only ids without an index. Goes red ONLY under mutation m1 (hasBoundPaintColor instead of hasExternalBoundPaintColor in the 2nd disjunct) — validated live', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
      const getDocumentRaw = vi.fn();
      const getVariablesLocal = vi.fn(async () => { throw new Error('x'); });
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
        variableGraph: { resolve: () => undefined },
      });
      const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(getDocumentRaw).not.toHaveBeenCalled();
      expect(res.isError).toBeFalsy();
    });

    it('(c) DIRECT lock on graphOrSnapshotAvailable: variableIndex unavailable + a node with an EXTERNAL bound color, but the harness WITHOUT variableGraph/variableSnapshot → discovery NOT called — the graph need is unsatisfiable without deps. The ONLY test that reds mutation m2 (removing `graphOrSnapshotAvailable &&`) — validated live', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardExtBoundFill } } }));
      const getDocumentRaw = vi.fn();
      const getVariablesLocal = vi.fn(async () => { throw new Error('x'); });
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }); // without extra deps
      const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardExtBoundFill) }] });
      expect(getDocumentRaw).not.toHaveBeenCalled();
      expect(res.isError).toBeFalsy();
    });
  });

  // Prefetch (snapshot batch before buildLayoutSpec) + resolveColorToken's shared
  // graph/snapshot fallback tail + graphStackFor (library-key-folded, nearest-wins ancestor stack
  // for the GRAPH resolver — never the plain exact-id stackFor, which cannot dedupe two subscribed-
  // instance suffixes of the SAME library collection).
  describe('prefetch + fallback-chain + graphStackFor', () => {
    const EXT_KEY = 'abcdef0123456789abcdef0123456789abcdef01'; // embedded in EXT_ALIAS_ID (cardExtBoundFill)

    it("local priority: variableIndex resolves LOCALLY (cardBoundFill) → the graph's resolveInMode spy is NOT called", async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
      const getDocumentRaw = vi.fn(async () => docWithNode(cardBoundFill));
      const resolveInMode = vi.fn();
      const run = harness({ getNodesRaw, getVariablesLocal: boundVars, getDocumentRaw }, 40000, {
        variableGraph: { resolve: () => undefined, resolveInMode },
      });
      const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(res.isError).toBeFalsy();
      expect(resolveInMode).not.toHaveBeenCalled();
    });

    it('graph miss + snapshot hit → a fill review row with a snapshot note, snapshot.lookup called EXACTLY once (union batch for the whole call)', async () => {
      const SNAP_HEX = '#123456';
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardExtBoundFill } } }));
      const getDocumentRaw = vi.fn(async () => docWithNode(cardExtBoundFill));
      const getVariablesLocal = vi.fn(async () => { throw new Error('x'); });
      const lookup = vi.fn(async () => new Map([[EXT_KEY, { value: SNAP_HEX, name: 'brand/snap', resolved_type: 'COLOR' }]]));
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
        variableGraph: { resolve: () => undefined },
        variableSnapshot: { lookup },
      });
      const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardExtBoundFill) }] });
      const out = JSON.parse(res.content[0].text);
      const colorRow = out.pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.status).toBe('review');
      expect(colorRow.note).toMatch(/via the default-mode snapshot/);
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    // Hoist fix: prefetch is ONE union batch BEFORE the pair loop — the data of every
    // pair is already in res.nodes from the single batched fetch, so N pairs must cost exactly ONE
    // snapshot.lookup round-trip, not N. Mutation lock: moving the prefetch back inside the
    // Promise.all map (per-pair) → lookup fires once PER external pair → calledTimes(1) RED.
    it('union batch: 2 external pairs with DIFFERENT keys → snapshot.lookup called EXACTLY once and received BOTH keys in one array', async () => {
      const EXT_KEY2 = '1234567890abcdef1234567890abcdef12345678';
      const cardExt2: RawSceneNode = {
        id: '2:2', name: 'Card2', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
        fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: `VariableID:${EXT_KEY2}/2:1` } } }],
      };
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardExtBoundFill }, '2:2': { document: cardExt2 } } }));
      const getDocumentRaw = vi.fn(async (): Promise<RawFileResponse> => ({
        name: 'f', lastModified: '', version: 'v1',
        document: { id: '0:0', name: 'D', type: 'DOCUMENT',
          children: [{ id: '0:1', name: 'P', type: 'CANVAS', children: [cardExtBoundFill, cardExt2] }] } as unknown as RawSceneNode,
      }));
      const getVariablesLocal = vi.fn(async () => { throw new Error('x'); });
      const lookup = vi.fn(async (_keys: string[]) => new Map([
        [EXT_KEY, { value: '#123456', name: 'brand/a', resolved_type: 'COLOR' }],
        [EXT_KEY2, { value: '#654321', name: 'brand/b', resolved_type: 'COLOR' }],
      ]));
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
        variableGraph: { resolve: () => undefined },
        variableSnapshot: { lookup },
      });
      const res = await run({ file: FILE, pairs: [
        { node_id: '1:1', dom: domFor(cardExtBoundFill) },
        { node_id: '2:2', dom: domFor(cardExt2) },
      ] });
      expect(res.isError).toBeFalsy();
      expect(lookup).toHaveBeenCalledTimes(1);                                  // ONE batch for the whole call, not per-pair
      expect([...lookup.mock.calls[0][0]].sort()).toEqual([EXT_KEY, EXT_KEY2].sort()); // union of both keys in one array
      // Both rows are actually resolved from ONE batch (not just the call shape):
      const rows = JSON.parse(res.content[0].text).pairs.map((p: any) => p.rows.find((r: any) => r.prop === 'fill'));
      expect(rows[0].figma).toBe('#123456');
      expect(rows[1].figma).toBe('#654321');
    });

    it('union batch dedup: 2 pairs with the SAME key → lookup receives an array of EXACTLY one key', async () => {
      const cardExtDup: RawSceneNode = { ...cardExtBoundFill, id: '3:3', name: 'CardDup' };
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardExtBoundFill }, '3:3': { document: cardExtDup } } }));
      const getDocumentRaw = vi.fn(async (): Promise<RawFileResponse> => ({
        name: 'f', lastModified: '', version: 'v1',
        document: { id: '0:0', name: 'D', type: 'DOCUMENT',
          children: [{ id: '0:1', name: 'P', type: 'CANVAS', children: [cardExtBoundFill, cardExtDup] }] } as unknown as RawSceneNode,
      }));
      const getVariablesLocal = vi.fn(async () => { throw new Error('x'); });
      const lookup = vi.fn(async (_keys: string[]) => new Map([[EXT_KEY, { value: '#123456', name: 'brand/a', resolved_type: 'COLOR' }]]));
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
        variableGraph: { resolve: () => undefined },
        variableSnapshot: { lookup },
      });
      const res = await run({ file: FILE, pairs: [
        { node_id: '1:1', dom: domFor(cardExtBoundFill) },
        { node_id: '3:3', dom: domFor(cardExtDup) },
      ] });
      expect(res.isError).toBeFalsy();
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup.mock.calls[0][0]).toEqual([EXT_KEY]);                       // Set-dedup: one key, not two duplicates
    });

    it('invariant: a pair with a LOCAL binding (cardBoundFill) + variableGraph injected → JSON byte-for-byte with a run WITHOUT graph', async () => {
      const getNodesRawA = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
      const getDocumentRawA = vi.fn(async () => docWithNode(cardBoundFill));
      const getNodesRawB = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
      const getDocumentRawB = vi.fn(async () => docWithNode(cardBoundFill));
      const withoutGraph = harness({ getNodesRaw: getNodesRawA, getVariablesLocal: boundVars, getDocumentRaw: getDocumentRawA });
      const withGraph = harness({ getNodesRaw: getNodesRawB, getVariablesLocal: boundVars, getDocumentRaw: getDocumentRawB }, 40000, {
        // Deliberately WRONG values — if this ever got consulted for a purely-local binding, the
        // byte-identity assert below would catch it immediately.
        variableGraph: {
          resolve: () => ({ value: '#000000' }),
          resolveInMode: () => ({ token: 'wrong', value: '#000000', mode_dependent: false, mode_source: 'default', pinned_axis_used: false, unconfirmed_default_used: false }),
        },
      });
      const a = (await withoutGraph({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] })).content[0].text;
      const b = (await withGraph({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] })).content[0].text;
      expect(b).toBe(a);
    });

    it('a healthy file + a cross-lib token (variableIndex IS present, but a byId miss on cardExtBoundFill) → resolve THROUGH THE GRAPH (a deliberate behavior change — previously an A2-review)', async () => {
      const GRAPH_HEX = '#abcdef';
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardExtBoundFill } } }));
      const getDocumentRaw = vi.fn(async () => docWithNode(cardExtBoundFill));
      const getVariablesLocal = vi.fn(async () => emptyVars); // index PRESENT (defined), just doesn't know this id
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
        variableGraph: {
          resolve: (k: string) => (k === EXT_KEY ? { value: GRAPH_HEX } : undefined),
          resolveInMode: (k: string) => (k === EXT_KEY
            ? { token: 'brand/accent', value: GRAPH_HEX, mode_dependent: false, mode_source: 'default', pinned_axis_used: false, unconfirmed_default_used: false }
            : undefined),
        },
      });
      const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardExtBoundFill) }] });
      const out = JSON.parse(res.content[0].text);
      const colorRow = out.pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.figma).toBe(GRAPH_HEX);
      expect(colorRow.note ?? '').not.toMatch(/токен не разрезолвлен/); // the prior A2 path for this id is closed
    });

    it('rate_limited from snapshot.lookup → rethrow, the whole tool isError (429 backoff is NOT swallowed)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardExtBoundFill } } }));
      const getDocumentRaw = vi.fn(async () => docWithNode(cardExtBoundFill));
      const getVariablesLocal = vi.fn(async () => { throw new Error('x'); });
      const lookup = vi.fn(async () => { throw new FigmaApiError('rate_limited', 429, 'slow down', 5); });
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
        variableGraph: { resolve: () => undefined },
        variableSnapshot: { lookup },
      });
      const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardExtBoundFill) }] });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/rate_limited/i);
    });

    // Flagship (dual-suffix, mutation lock L1-crit-2): the SAME published library collection is
    // pinned TWICE on the documented ancestor chain — once on a FARTHER ancestor (subscribed-instance
    // suffix "/a") and once on the PAIR ROOT ITSELF (suffix "/b", nearest). graphStackFor must fold
    // both into ONE nearest-wins entry (buildModeByCollection, library-key de-dupe) — a plain exact-id
    // stackFor merge would let BOTH survive as distinct map keys, with the FARTHER "/a" entry sitting
    // FIRST in insertion order and winning the graph resolver's first-match library-key scan. Runs the
    // REAL resolveKeyInMode over a mini Graph built with buildGraph (not a hand-rolled stub) so the
    // lock catches genuine map-order semantics.
    describe('flagship dual-suffix (L1-crit-2)', () => {
      const K = (h: string) => h.padEnd(40, '0');
      const LIB_KEY = K('f04'); // 40-hex published key
      const HEX_A = '#336699'; // farther ancestor pin (modeA) — must LOSE
      const HEX_B = '#0000ff'; // nearest pin, on the pair root itself (modeB) — must WIN
      const ALIAS_ID = 'VariableID:' + LIB_KEY + '/9:9';

      const g = buildGraph([{
        fileKey: 'LIB',
        colls: [{ collection_id: 'C', default_mode: 'default', key: LIB_KEY, name: 'Theme',
          modes: [{ modeId: 'default', name: 'Default' }, { modeId: 'modeA', name: 'A' }, { modeId: 'modeB', name: 'B' }] }],
        vars: [{ library_key: LIB_KEY, local_id: 'VariableID:1:1', collection_id: 'C', resolved_type: 'COLOR', code_syntax_web: '',
          name: 'brand/accent',
          values_by_mode: {
            default: { r: 1, g: 1, b: 1, a: 1 },      // '#ffffff' — ANTI-VACUUM: neither HEX_A nor HEX_B
            modeA: { r: 0.2, g: 0.4, b: 0.6, a: 1 },  // HEX_A
            modeB: { r: 0, g: 0, b: 1, a: 1 },        // HEX_B
          } }],
      }]);

      // Farther ancestor (CANVAS): pins the collection under suffix "/a" -> modeA.
      const cardDualSuffix: RawSceneNode = {
        id: '1:1', name: 'Card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
        // Nearest pin: the PAIR ROOT ITSELF, under a DIFFERENT suffix "/b" -> modeB.
        explicitVariableModes: { ['VariableCollectionId:' + LIB_KEY + '/b']: 'modeB' },
        // ANTI-VACUUM: raw RawPaint.color literal is a THIRD distinct value (≠ HEX_A, ≠ HEX_B) — a
        // pre-implementation run (figma = raw fillHex) can never accidentally match either assert.
        fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: ALIAS_ID } } }],
      };
      const canvasPinA: RawSceneNode = {
        id: '0:1', name: 'P', type: 'CANVAS',
        explicitVariableModes: { ['VariableCollectionId:' + LIB_KEY + '/a']: 'modeA' },
        children: [cardDualSuffix],
      };
      const docDualSuffix: RawFileResponse = {
        name: 'f', lastModified: '', version: 'v1',
        document: { id: '0:0', name: 'D', type: 'DOCUMENT', children: [canvasPinA] } as unknown as RawSceneNode,
      };

      it('the nearer node (pair root) beats the farther ancestor — graphStackFor nearest-wins by library key', async () => {
        // discoverAncestorModes harvests the ancestor chain's explicitVariableModes via a SEPARATE
        // trailing `getNodesRaw(fileKey, chainIds, 1)` call (raw, unstripped — buildFileStructure at
        // the getDocumentRaw stage strips explicitVariableModes) — this mock MUST serve that lookup
        // (ids includes the CANVAS ancestor '0:1'), or ancestorStack/ancestorNodes come back empty
        // and the mutation this test locks has nothing to corrupt (verified live — see report).
        const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> =>
          ids.includes('0:1')
            ? { nodes: { '0:0': { document: { id: '0:0', name: 'D', type: 'DOCUMENT' } as RawSceneNode }, '0:1': { document: canvasPinA } } }
            : { nodes: { '1:1': { document: cardDualSuffix } } });
        const getDocumentRaw = vi.fn(async () => docDualSuffix);
        const getVariablesLocal = vi.fn(async () => { throw new Error('index-less'); });
        const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
          variableGraph: {
            resolve: (k: string) => (k === LIB_KEY ? { value: HEX_B, modesByName: { Default: '#ffffff', A: HEX_A, B: HEX_B } } : undefined),
            resolveInMode: (k: string, mbc: Map<string, string>, cc?: boolean) => resolveKeyInMode(g, k, mbc, cc),
          },
        });
        const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardDualSuffix) }] });
        const out = JSON.parse(res.content[0].text);
        const colorRow = out.pairs[0].rows.find((r: any) => r.prop === 'fill');
        expect(colorRow.figma).toBe(HEX_B);           // nearest pin wins
        expect(colorRow.figma).not.toBe(HEX_A);        // NOT the farther ancestor
        expect(colorRow.figma).not.toBe('#ff0000');    // NOT the raw literal fillHex (anti-vacuum)
        // Mutation: swap `graphStackFor(n)` for `stackFor(n)` in resolveColorToken's fallback tail →
        // ancestorStack ('/a' → modeA) and the subtree's own explicit modes ('/b' → modeB) survive as
        // TWO DISTINCT map entries (different exact keys) with '/a' inserted FIRST → the graph
        // resolver's first-match library-key scan picks modeA → figma becomes HEX_A → RED here.
      });
    });
  });

  it('discovery deadline: discovery receives deadlineAt (cfg NOT empty) — mutation lock', async () => {
    // Spying on the get-design-context-tool module: vi.spyOn won't work on a direct import binding —
    // instead the lock is BEHAVIORAL: toolTimeBudgetMs: 1 (deadline already expired) → discovery must
    // instantly degrade (time_budget), NOT call getDocumentRaw(4+) — we count the calls.
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } }));
    const getDocumentRaw = vi.fn(async () => docWithNode(cardBoundFill));
    const run = harness({ getNodesRaw, getVariablesLocal: boundVars, getDocumentRaw }, 40000, { toolTimeBudgetMs: 1 });
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
    expect(getDocumentRaw).not.toHaveBeenCalled();        // the discovery floor-gate fired BEFORE the fetch
    expect(res.content[0].text).toContain('"pairs"');     // the call did NOT fail — honest degradation
  });

  // document-chain: the document ancestor chain from bestFrameRaw (the frame's deep-raw, already in memory from
  // the hydration above) + the fallback matrix (a)-(d) to deadline-capped discovery. Local fixtures: frame
  // 9:1 with pair 1:1 at depth 2 (page -> frame -> card), the page carries an explicit mode for a MULTI-MODE
  // collection 'VariableCollectionId:7:7' -> '7:1' (the value under this mode ≠ the value of the default
  // mode — otherwise the page pin changes nothing and the canvas-mode lock is vacuously green).
  describe('document-chain: document ancestor chain from bestFrameRaw + fallback matrix', () => {
    const HEX_71 = '#336699';                              // valuesByMode['7:1'] — r:.2 g:.4 b:.6
    const HEX_DEFAULT = '#ffffff';                         // valuesByMode.m0 (default mode)
    const varsMultiMode: RawVariablesResponse = {
      meta: {
        variables: {
          'VariableID:9:9': {
            id: 'VariableID:9:9', name: 'neutral/bg/base', resolvedType: 'COLOR',
            variableCollectionId: 'VariableCollectionId:7:7',
            // default-mode value (#ffffff) ≠ mode '7:1' value (HEX_71) — the page pin below MUST
            // change the resolved hex, or the canvas-mode lock below would be vacuously green.
            valuesByMode: { m0: { r: 1, g: 1, b: 1, a: 1 }, '7:1': { r: 0.2, g: 0.4, b: 0.6, a: 1 } },
          },
        },
        variableCollections: {
          'VariableCollectionId:7:7': {
            id: 'VariableCollectionId:7:7', name: 'Theme', defaultModeId: 'm0',
            modes: [{ modeId: 'm0', name: 'Default' }, { modeId: '7:1', name: 'Solar' }],
          },
        },
      },
    };
    // function-shaped (mirrors boundVars above) — a plain closure, not vi.fn, so it doesn't
    // accumulate call-count state across the 4 tests below that share it.
    const multiModeVars = async (): Promise<RawVariablesResponse> => varsMultiMode;

    const pageWithMode: RawSceneNode = {
      id: '0:1', name: 'Page', type: 'CANVAS',
      explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
      children: [{
        id: '9:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        children: [cardBoundFill],
      } as RawSceneNode],
    } as RawSceneNode;
    const docRaw: RawFileResponse = {
      name: 'f', lastModified: '', version: 'v1',
      document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [pageWithMode] } as unknown as RawSceneNode,
    };

    it("document-chain: a pair in the frame's deep-raw → chain WITHOUT whole-file (getDocumentRaw only depth-2) + CANVAS mode applied", async () => {
      const frameDeep = pageWithMode.children![0];          // the frame with cardBoundFill inside
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], _depth?: number): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
                            : { nodes: { '1:1': { document: cardBoundFill } } });
      const getDocumentRaw = vi.fn(async (_f: string, depth?: number): Promise<RawFileResponse> => { expect(depth).toBe(2); return docRaw; });
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(getDocumentRaw).toHaveBeenCalledTimes(1);       // ONLY the depth-2 skeleton, ZERO whole-file deepening
      const out = JSON.parse(res.content[0].text);
      const colorRow = out.pairs[0].rows.find((r: any) => r.prop === 'fill');
      // MUTATION LOCK L3-imp-1 (flagship): the assert pins EXACTLY the figma side (diff.ts:955
      // figma = fillToken.hex) — the DOM side carries its own #ffffff literal (domFor) and cannot
      // keep this assert green under a mutation of the canvas part.
      expect(colorRow.figma).toBe(HEX_71);                   // hex of mode 7:1, NOT default
      // Mutation m1 "the canvas part strips explicitVariableModes" → figma === '#ffffff' → RED here.
      // probe-invariant: the frame is FOUND in the depth-2 slice directly (ancestorChainFromSubtree
      // direct path) — the targeted probe-descent must not run at all, not a single depth-1 call.
      expect(getNodesRaw.mock.calls.some((c) => c[2] === 1)).toBe(false);
    });

    it("document-chain fallback (b): a pair DEEPER than deep-raw → deadline-capped whole-file (ONLY depth-4; no depth-2 skeleton — an undefined frameChain short-circuits canvasChainFor). MUTATION LOCK on the undefined-frameChain branch, green even before the fix (the fallback already yields depth-4) — NOT TDD-RED", async () => {
      const shallowFrame = { id: '9:1', name: 'frame', type: 'FRAME', children: [] } as RawSceneNode; // no pair inside
      const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: shallowFrame }, '1:1': { document: cardBoundFill } } }
                            : { nodes: { '1:1': { document: cardBoundFill } } });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docRaw); // serves both the skeleton and the whole-file slot
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toContain(4);                           // whole-file deepening started (ANCESTOR_START_DEPTH)
    });

    it('document-chain fallback (d): located, but the frame is NOT in the depth-2 skeleton (nested in a section) → discovery recovered the mode', async () => {
      // skeleton: DOCUMENT→CANVAS→section (frame 9:1 absent at depth-2)
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
          children: [{ id: '5:5', type: 'SECTION', name: 'S' }] }] }, version: 'v1' } as unknown as RawFileResponse;
      // bbox-absence on frameDeep — LOAD-BEARING: routes into (d) past the probe-descent
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME', children: [cardBoundFill] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
                            : { nodes: { '1:1': { document: cardBoundFill } } });
      // whole-file deepening (depth 4) FINDS the node: return the full doc with section→frame→card
      const fullDoc = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
          children: [{ id: '5:5', type: 'SECTION', name: 'S', children: [frameDeep] }] }] }, version: 'v1' } as unknown as RawFileResponse;
      const getDocumentRaw = vi.fn(async (_f: string, depth?: number): Promise<RawFileResponse> => (depth === 2 ? docNoFrame : fullDoc));
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toEqual(expect.arrayContaining([2, 4])); // skeleton + B-recovery
      expect(JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill')).toBeDefined();
      // MUTATION LOCK L1-imp: the mutation "no (d) condition — partial chain immediately" → no depth-4 call → RED
    });

    it('the canvas skeleton is fetched ONCE per call with 2+ color pairs (memo)', async () => {
      const frameDeep = pageWithMode.children![0];
      const second = { ...cardBoundFill, id: '1:9' } as RawSceneNode;
      (frameDeep.children as RawSceneNode[]).push(second);
      const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill }, '1:9': { document: second } } }
                            : { nodes: { '1:1': { document: cardBoundFill }, '1:9': { document: second } } });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docRaw);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      await run({ file: FILE, frame_node_id: '9:1', pairs: [
        { node_id: '1:1', dom: domFor(cardBoundFill) }, { node_id: '1:9', dom: domFor(second) }] });
      expect(getDocumentRaw).toHaveBeenCalledTimes(1);
    });

    it('(d)-partial mutation-lock: discovery CUT SHORT (depth_cap) → a partial frame-only chain = honest default-hex + review "mode not confirmed", NEVER "hex matched under the mode"', async () => {
      // The skeleton AND ALL whole-file depths WITHOUT the frame/pair (the page-mode 7:1 lives on the CANVAS above):
      // canvasChainFor(depth 2) doesn't find the frame → branch (d); discovery deepens 4→8, doesn't find the pair
      // → droppedReason:'depth_cap' (deterministic) → a partial intra-frame chain.
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
          children: [{ id: '5:5', type: 'SECTION', name: 'S' }] }] }, version: 'v1' } as unknown as RawFileResponse;
      // bbox-absence on frameDeep — LOAD-BEARING: routes into (d) past the probe-descent
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME', children: [cardBoundFill] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
                            : { nodes: { '1:1': { document: cardBoundFill } } });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docNoFrame);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toEqual(expect.arrayContaining([2, 4, 8])); // skeleton + discovery-first up to depth_cap
      const colorRow = JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill');
      // THE HEART of never-false-green: the page-mode 7:1 is lost to the cut-short discovery;
      // the partial chain MUST resolve the default-hex UNDER coverageComplete=false → mode_source:'default'
      // → verdict group B "node mode not confirmed" (mode_source isn't serialized into the row — its
      // only observable surface here is exactly this note, diff.ts:924). Status 'review' for both
      // groups B and D — the lock rests EXACTLY on the note: the mutation "coverageComplete=true on a partial chain" yields
      // mode_source:'node' → group D "hex matched under the mode" (a confident lie) → RED on the toMatch below.
      expect(colorRow.figma).toBe(HEX_DEFAULT);              // honest default-hex, NOT HEX_71
      expect(colorRow.status).toBe('review');
      expect(colorRow.note).toMatch(/mode is not confirmed/);
    });

    // Predictive byte-gate e2e: compare ALWAYS passes predictiveByteGate:true into cappedCfg (the cfg lives
    // ONCE for both discoverAncestorModes call-sites — see the cappedCfg literal above). On the
    // giant-file (d) route (bbox-absent frameDeep — the same load-bearing trick as in the
    // (d)-partial lock above, routing PAST the probe-descent) the depth-4 whole-file already
    // weighs ~13MB (with no target pair inside — discovery doesn't locate at depth 4): the predictive gate
    // must stop AFTER this fetch and NOT try depth 8 (which would be ~26MB+,
    // a measured 88s stream abort on a large prod page). 13MB < 24MB (ANCESTOR_BYTE_BUDGET) — the reactive
    // gate BY ITSELF would NOT fire here, so a green test proves exactly the predictive
    // branch, not a coincidence with the reactive threshold.
    it('predictive byte-gate e2e: the (d) route (bbox-absent) + depth-4 = 13MB → predictive drop, depth-8 not attempted', async () => {
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
          children: [{ id: '5:5', type: 'SECTION', name: 'S' }] }] }, version: 'v1' } as unknown as RawFileResponse;
      // bbox-absence on frameDeep — LOAD-BEARING: routes into (d) past the probe-descent
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME', children: [cardBoundFill] } as RawSceneNode;
      // depth-4 whole-file: 13MB name-padding, no target pair ('1:1') inside — discovery doesn't
      // locate at depth 4, which makes byte-gate the SOLE reason for stopping (not located).
      const giantDoc = { document: { id: '0:0', type: 'DOCUMENT', name: 'x'.repeat(13_000_000), children: [] },
        version: 'v1' } as unknown as RawFileResponse;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
                            : { nodes: { '1:1': { document: cardBoundFill } } });
      const getDocumentRaw = vi.fn(async (_f: string, depth?: number): Promise<RawFileResponse> => (depth === 2 ? docNoFrame : giantDoc));
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toEqual([2, 4]);                        // skeleton + ONE whole-file — NEVER depth 8
      // The mutation "compare doesn't pass predictiveByteGate" → the reactive gate (13MB < 24MB) does NOT
      // stop discovery → depth doubles to 8 → depths contains 8 → RED here.
    });

    // predictive byte-gate e2e (a) route (a regression-net lock): cappedCfg
    // (predictiveByteGate:true) is ONE literal, living for BOTH discoverAncestorModes call-sites
    // (:400 and :415, see the comment at cappedCfg above). The e2e test above routes through the FIRST
    // (:400, the (d) path — frame_node_id given, frame located inside bestFrameRaw, but canvasChain
    // unavailable). The SECOND call-site (:415, fallback matrix (a)(b)(c)) was NOT separately locked: a live
    // mutation ONLY there (`{...cappedCfg, predictiveByteGate: false}` substituted exclusively into
    // the :415 call, :400 untouched) passed the whole suite 89/89 green — no existing scenario
    // routes into :415 WITHOUT frame_node_id at all (the (a) path: `frameId` undefined ⟹ the :385-411 block
    // is skipped entirely, `done` stays false from the start). Here — WITHOUT frame_node_id: needsModes
    // fires via a LOCAL bound color (multiModeVars → variableIndex defined, the first disjunct of
    // needsModes — hasBoundPaintColor(cardBoundFill), NOT hasExternalBoundPaintColor — external isn't
    // needed here, variableIndex already covers the local alias). discoverAncestorModes is called EXACTLY
    // ONCE — at :415. The same 13MB trick: depth-4 whole-file with no target node inside (discovery doesn't
    // locate, byte-gate is the SOLE reason for stopping), 13MB×2 ≥ 24MB (ANCESTOR_BYTE_BUDGET) —
    // the predictive gate must stop, depth-8 is never attempted.
    it('predictive byte-gate e2e (a) route: WITHOUT frame_node_id at all → the SECOND discoverAncestorModes call-site (:415) also predictively drops 13MB×2 ≥ 24MB, depth-8 not attempted', async () => {
      // depth-4 whole-file: 13MB name-padding, WITHOUT '1:1' inside — discovery doesn't locate the node at
      // depth 4 (located===false), which makes byte-gate the SOLE reason for stopping.
      const giantDoc = { document: { id: '0:0', name: 'x'.repeat(13_000_000), type: 'DOCUMENT', children: [] },
        version: 'v1' } as unknown as RawFileResponse;
      const getNodesRaw = vi.fn(async (_f: string, _ids: string[]): Promise<RawNodesResponse> =>
        ({ nodes: { '1:1': { document: cardBoundFill } } }));
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => giantDoc);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      // WITHOUT frame_node_id at all — the (a) path: frameId===undefined ⟹ :385-411 skipped entirely ⟹
      // the single discoverAncestorModes call falls exactly on :415.
      await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toContain(4);
      expect(depths).not.toContain(8);
      // A live mutation "the :415 call receives {...cappedCfg, predictiveByteGate: false}" → the reactive
      // gate (13MB < 24MB) does NOT stop discovery → depth doubles to 8 → depths contains 8 →
      // RED here.
    });

    it('document-chain: CANVAS-guard mutation-lock — the frame is located in the depth-2 skeleton, but the chain WITHOUT CANVAS → we do NOT trust the skeleton, discovery recovers the page-mode', async () => {
      // the depth-2 skeleton returns the frame DIRECTLY under DOCUMENT (malformed/truncated without a page): chain=[DOCUMENT]
      // located, but canvasChain.some(CANVAS)===false → the guard must reject it and go into discovery.
      const docFrameUnderDoc = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '9:1', name: 'frame', type: 'FRAME' }] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME', children: [cardBoundFill] } as RawSceneNode;
      // whole-file (depth 4) — the REAL structure: a page with mode 7:1 above the frame
      const fullDoc = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
          children: [frameDeep] }] }, version: 'v1' } as unknown as RawFileResponse;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> => {
        if (ids.includes('0:1')) {                          // trailing chain-fetch of discovery (depth 1)
          return { nodes: {
            '0:0': { document: { id: '0:0', name: 'D', type: 'DOCUMENT' } as RawSceneNode },
            '0:1': { document: { id: '0:1', name: 'P', type: 'CANVAS', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' } } as RawSceneNode },
            '9:1': { document: { id: '9:1', name: 'frame', type: 'FRAME' } as RawSceneNode },
          } };
        }
        return ids.includes('9:1') ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
                                   : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, depth?: number): Promise<RawFileResponse> => (depth === 2 ? docFrameUnderDoc : fullDoc));
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toContain(4);                          // the guard rejected the chain without CANVAS → discovery started
      const colorRow = JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill');
      // The mutation "remove canvasChain.some(CANVAS)" → chain=[DOCUMENT] accepted as complete → discovery is NOT
      // called (no depth-4) + ancestorStack empty → figma=HEX_DEFAULT under coverageComplete=true
      // (a confidently-wrong mode) → RED on BOTH asserts. The fixture is deliberately orthogonal to
      // the (d)-partial lock above: there canvasChain is undefined (the guard isn't reached), here it is reached.
      expect(colorRow.figma).toBe(HEX_71);                  // page-mode recovered by discovery, NOT lost
    });

    // Edge case (ancestor-latency): the same collection 'VariableCollectionId:7:7'
    // is pinned TWICE on the document chain — on the CANVAS (mode '7:1') AND on the FRAME itself (mode 'B:1',
    // explicitVariableModes DIRECTLY on frameWithModeB). The bound-color pair is INSIDE the frame (pair≠frame).
    // Local fixtures (do NOT reuse varsMultiMode/docRaw/pageWithMode — those are mutated in the
    // "memo" test above via a push onto .children, sharing risks a flaky execution order).
    it('document-chain nearest-wins: the collection is pinned BOTH on the CANVAS (7:1) AND on the frame itself (mode B) → figma resolves to mode B (the frame is CLOSER on the document chain), NOT to the CANVAS mode and NOT default. Mutation lock on the ancestorStack concat order (:290) — validated live', async () => {
      const HEX_B = '#0000ff';                              // valuesByMode['B:1'] — r:0 g:0 b:1 (the pin on the FRAME itself)
      const varsNearestWins: RawVariablesResponse = {
        meta: {
          variables: {
            'VariableID:9:9': {
              id: 'VariableID:9:9', name: 'neutral/bg/base', resolvedType: 'COLOR',
              variableCollectionId: 'VariableCollectionId:7:7',
              // 3 DIFFERENT values — HEX_71 ≠ HEX_B ≠ HEX_DEFAULT — otherwise a near/far mix-up would be
              // vacuously green (any source would give the same hex).
              valuesByMode: {
                m0: { r: 1, g: 1, b: 1, a: 1 },              // HEX_DEFAULT '#ffffff'
                '7:1': { r: 0.2, g: 0.4, b: 0.6, a: 1 },     // HEX_71 '#336699' — CANVAS pin (farther)
                'B:1': { r: 0, g: 0, b: 1, a: 1 },            // HEX_B '#0000ff' — FRAME pin (closer)
              },
            },
          },
          variableCollections: {
            'VariableCollectionId:7:7': {
              id: 'VariableCollectionId:7:7', name: 'Theme', defaultModeId: 'm0',
              modes: [{ modeId: 'm0', name: 'Default' }, { modeId: '7:1', name: 'Solar' }, { modeId: 'B:1', name: 'Alt' }],
            },
          },
        },
      };
      const nearestWinsVars = async (): Promise<RawVariablesResponse> => varsNearestWins;

      // The frame itself carries an explicit pin (mode B) — the pair (cardBoundFill) is INSIDE it (pair≠frame). This
      // is exactly frameChain[0] (the bestFrameRaw document chain starts WITH THE FRAME) — the lock also
      // confirms frameChain's contribution at the tool level (not only canvasChain).
      const frameWithModeB: RawSceneNode = {
        id: '9:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        explicitVariableModes: { 'VariableCollectionId:7:7': 'B:1' },
        children: [cardBoundFill],
      };
      // The CANVAS higher on the document chain pins the SAME collection under a DIFFERENT mode (7:1) — farther from the pair.
      const pageWithModeLocal: RawSceneNode = {
        id: '0:1', name: 'Page', type: 'CANVAS',
        explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
        children: [frameWithModeB],
      } as RawSceneNode;
      const docRawLocal: RawFileResponse = {
        name: 'f', lastModified: '', version: 'v1',
        document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [pageWithModeLocal] } as unknown as RawSceneNode,
      };

      const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameWithModeB }, '1:1': { document: cardBoundFill } } }
                            : { nodes: { '1:1': { document: cardBoundFill } } });
      const getDocumentRaw = vi.fn(async (_f: string, depth?: number): Promise<RawFileResponse> => { expect(depth).toBe(2); return docRawLocal; });
      const run = harness({ getNodesRaw, getVariablesLocal: nearestWinsVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(getDocumentRaw).toHaveBeenCalledTimes(1);        // ONLY the depth-2 skeleton — both pins are already in memory, discovery isn't needed
      const out = JSON.parse(res.content[0].text);
      const colorRow = out.pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.figma).toBe(HEX_B);                     // the FRAME is closer — nearest-wins
      expect(colorRow.figma).not.toBe(HEX_71);                // NOT the CANVAS mode (farther)
      expect(colorRow.figma).not.toBe(HEX_DEFAULT);            // NOT default
      // The mutation "[...canvasChain, ...frameChain]" → "[...frameChain, ...canvasChain]" (:290) puts
      // the CANVAS pin earlier in buildModeByCollection's internal nearest→farthest scan → the CANVAS
      // "wins" instead of the frame → figma becomes HEX_71 → RED on toBe(HEX_B) above.
    });

    // Edge case (ancestor-latency): the main fetch returns the frame TRUNCATED
    // (childrenTruncated by depth — no pair inside), the cov-fetch@8 (tier 3, tool :169) returns
    // a DEEP frame where the pair IS present — bestFrameRaw MUST reuse the cov result (:172
    // `bestFrameRaw = cd`), otherwise frameChain isn't localized from the main frame (no pair there) and the tool
    // falls into deadline-capped whole-file discovery (depth 4+) — the reuse must avoid exactly this.
    // Local fixtures (do not reuse the shared docRaw/pageWithMode/multiModeVars — the same reason for
    // isolation from the "memo" mutation as in the nearest-wins test above).
    it("deep-pair reuse: the frame's main fetch is truncated (no pair inside), the cov-fetch@8 contains the pair → bestFrameRaw reuses cov (:172), whole-file discovery does NOT start", async () => {
      const varsLocal: RawVariablesResponse = {
        meta: {
          variables: {
            'VariableID:9:9': {
              id: 'VariableID:9:9', name: 'neutral/bg/base', resolvedType: 'COLOR',
              variableCollectionId: 'VariableCollectionId:7:7',
              valuesByMode: { m0: { r: 1, g: 1, b: 1, a: 1 }, '7:1': { r: 0.2, g: 0.4, b: 0.6, a: 1 } },
            },
          },
          variableCollections: {
            'VariableCollectionId:7:7': {
              id: 'VariableCollectionId:7:7', name: 'Theme', defaultModeId: 'm0',
              modes: [{ modeId: 'm0', name: 'Default' }, { modeId: '7:1', name: 'Solar' }],
            },
          },
        },
      };
      const varsLocalFn = async (): Promise<RawVariablesResponse> => varsLocal;

      // depth-2 canvas skeleton: the CANVAS pins the collection (mode 7:1) — as in the existing C-test above.
      const pageWithModeLocal: RawSceneNode = {
        id: '0:1', name: 'Page', type: 'CANVAS',
        explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
        children: [{ id: '9:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 } } as RawSceneNode],
      } as RawSceneNode;
      const docRawLocal: RawFileResponse = {
        name: 'f', lastModified: '', version: 'v1',
        document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [pageWithModeLocal] } as unknown as RawSceneNode,
      };

      // main fetch: the frame's OWN — a deep plain-FRAME chain (6 levels, the deepFrame pattern from
      // the coverage describe :994) — no pair INSIDE, honestly triggers anyTruncatedSpec at the depth-4 default.
      const mkLevel = (id: string, child?: RawSceneNode): RawSceneNode =>
        ({ id, name: id, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 8 }, ...(child ? { children: [child] } : {}) });
      let deep = mkLevel('D6');
      for (let i = 5; i >= 1; i -= 1) deep = mkLevel(`D${i}`, deep);
      const shallowTruncatedFrame: RawSceneNode = {
        id: '9:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        layoutMode: 'VERTICAL', children: [deep],
      };
      // cov-fetch (depth 8): a DEEP frame WITH the bound-color pair INSIDE — what bestFrameRaw MUST
      // take from cov (:172), rather than staying on the main-frame variant without the pair.
      const deepFrameWithPair: RawSceneNode = {
        id: '9:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        layoutMode: 'VERTICAL', children: [cardBoundFill],
      };
      const getFrameRaw = vi.fn(async (_file: string, ids: string[], requestedMaxDepth: number) => {
        if (ids.length > 1) {                                 // main: [pairId, frameId]
          const nodes: Record<string, { document: RawSceneNode }> = { '1:1': { document: cardBoundFill }, '9:1': { document: shallowTruncatedFrame } };
          return { raw: { nodes }, heldDepth: requestedMaxDepth + 1, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
        }
        expect(ids).toEqual(['9:1']);                         // cov: ONLY [frameId]
        expect(requestedMaxDepth).toBe(8);
        const nodes: Record<string, { document: RawSceneNode }> = { '9:1': { document: deepFrameWithPair } };
        return { raw: { nodes }, heldDepth: 9, hydrated: false, effectiveMaxDepth: 8 };
      });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docRawLocal);
      const run = harness({ getFrameRaw, getVariablesLocal: varsLocalFn, getDocumentRaw } as unknown as Partial<FigmaApi>);
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });

      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toEqual([2]);                            // ONLY the canvas skeleton — whole-file discovery (depth 4+) did NOT start
      const colorRow = JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.figma).toBe(HEX_71);                    // the chain is localized FROM the cov-fetch (bestFrameRaw=cd), not from main
      // The mutation "comment out `bestFrameRaw = cd;` (:172)" → bestFrameRaw stays the main frame
      // WITHOUT the pair → frameChain undefined → fallback (!done) → deadline-capped whole-file discovery
      // starts (depth 4+) → depths contains 4 → toEqual([2]) RED.
    });

    // Mutation-net-gap lock: a mirror of the flagship "dual-suffix"
    // (:443 above, the real resolveKeyInMode over a mini Graph via buildGraph), BUT with frame_node_id —
    // the ancestorNodes chain for the GRAPH resolver is assembled HERE, in the full-chain branch
    // (:339 `ancestorNodes = [...canvasChain, ...frameChain]`), not via a separate trailing
    // chain-fetch of discoverAncestorModes (the flagship path, without frame_node_id). The pair is an EXTERNAL bound
    // color (published-library key) INSIDE the frame; getVariablesLocal throws (index-less) — the path
    // MUST go through the shared graph-fallback tail of resolveColorToken (:415 graphStackFor), not
    // through the local variableIndex/stackFor. The only pin is on the CANVAS ancestor (the frame itself does NOT
    // pin anything): isolates exactly the full-chain CONCAT ([...canvasChain, ...frameChain]) from
    // the nearest-wins order (already locked by a separate test above, :703).
    it("full-chain × graphStackFor: an EXTERNAL bound-color pair inside the frame + a CANVAS ancestor pins the collection (real resolveKeyInMode/buildGraph) → figma resolves to the ancestor's mode hex, NOT default", async () => {
      const K = (h: string) => h.padEnd(40, '0');
      const LIB_KEY = K('f05'); // 40-hex published key, different from the flagship 'f04' (fixture isolation)
      const HEX_ANCESTOR = '#336699'; // the CANVAS ancestor pins modeA — must WIN
      const HEX_DEFAULT_G = '#ffffff'; // default mode — must LOSE
      const ALIAS_ID = 'VariableID:' + LIB_KEY + '/9:9';

      const g = buildGraph([{
        fileKey: 'LIB',
        colls: [{ collection_id: 'C', default_mode: 'default', key: LIB_KEY, name: 'Theme',
          modes: [{ modeId: 'default', name: 'Default' }, { modeId: 'modeA', name: 'A' }] }],
        vars: [{ library_key: LIB_KEY, local_id: 'VariableID:1:1', collection_id: 'C', resolved_type: 'COLOR', code_syntax_web: '',
          name: 'brand/accent',
          values_by_mode: {
            default: { r: 1, g: 1, b: 1, a: 1 },      // HEX_DEFAULT_G — must lose
            modeA: { r: 0.2, g: 0.4, b: 0.6, a: 1 },  // HEX_ANCESTOR — must win
          } }],
      }]);

      // The pair is INSIDE the frame (depth 2: frame -> card), the frame itself carries NO explicitVariableModes.
      const cardExtInFrame: RawSceneNode = {
        id: '1:1', name: 'Card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
        // ANTI-VACUUM: the raw paint literal is a THIRD distinct value (≠ default, ≠ the ancestor's mode).
        fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: ALIAS_ID } } }],
      };
      const frameWithNoPin: RawSceneNode = {
        id: '9:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        children: [cardExtInFrame],
      };
      // The CANVAS ancestor (depth-2 skeleton) pins the same collection under modeA — the ONLY pin in the chain.
      const canvasPinAncestor: RawSceneNode = {
        id: '0:1', name: 'P', type: 'CANVAS',
        explicitVariableModes: { ['VariableCollectionId:' + LIB_KEY + '/a']: 'modeA' },
        children: [frameWithNoPin],
      };
      const docSkeleton: RawFileResponse = {
        name: 'f', lastModified: '', version: 'v1',
        document: { id: '0:0', name: 'D', type: 'DOCUMENT', children: [canvasPinAncestor] } as unknown as RawSceneNode,
      };

      const getNodesRaw = vi.fn(async (_f: string, ids: string[]): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameWithNoPin }, '1:1': { document: cardExtInFrame } } }
                            : { nodes: { '1:1': { document: cardExtInFrame } } });
      const getDocumentRaw = vi.fn(async (_f: string, depth?: number): Promise<RawFileResponse> => { expect(depth).toBe(2); return docSkeleton; });
      const getVariablesLocal = vi.fn(async () => { throw new Error('index-less'); });
      const run = harness({ getNodesRaw, getVariablesLocal, getDocumentRaw }, 40000, {
        variableGraph: {
          resolve: (k: string) => (k === LIB_KEY ? { value: HEX_ANCESTOR, modesByName: { Default: HEX_DEFAULT_G, A: HEX_ANCESTOR } } : undefined),
          resolveInMode: (k: string, mbc: Map<string, string>, cc?: boolean) => resolveKeyInMode(g, k, mbc, cc),
        },
      });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardExtInFrame) }] });
      const out = JSON.parse(res.content[0].text);
      const colorRow = out.pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.figma).toBe(HEX_ANCESTOR);              // the CANVAS ancestor won
      expect(colorRow.figma).not.toBe(HEX_DEFAULT_G);         // NOT default
      expect(colorRow.figma).not.toBe('#ff0000');             // NOT the raw paint literal (anti-vacuum)
      // Mutation lock (m1, low mutation-net-gap): `ancestorNodes = [...canvasChain, ...frameChain]`
      // (:339) → `[]` in this full-chain branch → graphStackFor loses the CANVAS pin entirely →
      // resolveInMode falls back to the default mode → figma becomes HEX_DEFAULT_G → RED on the first
      // assert above. (m2 — `ancestorNodes = frameChain` → `[]` in the (d)-partial branch, :349 — THIS test
      // goes through full-chain, not through (d); the (d) arm for the GRAPH resolver remains a follow-up, see
      // not a blocker, degrades to an honest review, not to a confidently-wrong color.)
    });

    // A targeted probe-descent in canvasChainFor — the frame is NOT in the depth-2 slice (nested in
    // a section), but the section and the frame HAVE a bbox → the geometry pre-filter (pickDescentCandidates) picks
    // WHOM to probe, while membership is proven documentarily (children-id of the probe RESPONSE ROOT) — NEVER
    // by bbox directly. Replaces the expensive (d)-deadline-capped whole-file discovery with a single getNodesRaw depth-1.
    it('probe-descent: a frame in a SECTION + bbox → probe-descent (getNodesRaw depth-1) instead of whole-file; CANVAS mode applied; coverageComplete=true', async () => {
      // depth-2 skeleton: DOCUMENT→CANVAS→SECTION (no frame 9:1); the section and the frame HAVE a bbox → probe route
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
          children: [
            { id: '5:5', type: 'SECTION', name: 'S', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 } },
            { id: '5:6', type: 'SECTION', name: 'far', absoluteBoundingBox: { x: 9000, y: 9000, width: 10, height: 10 } },
          ] }] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 10, y: 10, width: 375, height: 812 }, children: [cardBoundFill] } as RawSceneNode;
      const probeSection = { id: '5:5', type: 'SECTION', name: 'S',
        absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 },
        children: [{ id: '9:1', type: 'FRAME', name: 'frame' }] } as RawSceneNode; // probe RESPONSE ROOT
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number): Promise<RawNodesResponse> => {
        if (ids.includes('5:5')) { expect(depth).toBe(1); return { nodes: { '5:5': { document: probeSection } } }; }
        return ids.includes('9:1')
          ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
          : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docNoFrame);
      //   ↑ WITHOUT an inner expect in the mock (an AssertionError is swallowed by the catch :363 — RED must
      //     be DIRECT, via the external depths assert below)
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(getDocumentRaw.mock.calls.map((c) => c[1])).toEqual([2]); // ZERO whole-file deepening — the heart of the probe-descent
      const probeCall = getNodesRaw.mock.calls.find((c) => (c[1] as string[]).includes('5:5'));
      expect(probeCall![1]).not.toContain('5:6');                     // the bbox pre-filter cut off the far section
      const colorRow = JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.figma).toBe(HEX_71);                             // the CANVAS mode arrived via the descent
      // Invariant (blocker): status 'pass' is UNREACHABLE here — domFor gives DOM #ffffff ≠ HEX_71, the row
      // mismatches by design (the sibling test :570 also asserts only the figma side). The observable signal of
      // coverageComplete=true is the ABSENCE of the unconfirmed-mode note (an inversion of the lock :661):
      expect(colorRow.note ?? '').not.toMatch(/mode is not confirmed/);
      // Mutation m2 "descent disabled" → discovery deepening (depth 4 in getDocumentRaw) → RED on toEqual([2]).
      // Mutation m1 "membership by bbox" is caught by the adversarial test below.
    });

    it('probe-descent adversarial: a branching 2-level descent — the mode lives ONLY on the intermediate section of the true path; a sibling with the SAME collection on a DIFFERENT mode does NOT enter the chain', async () => {
      // A(5:5, pin 7:2 via the probe RESPONSE ROOT) ⊃ B(6:6, WITHOUT a pin) ⊃ frame; sibling A'(5:9, pin
      // 7:1) also bbox-intersects frameBox, but is documentarily EMPTY (probeAprime.children===[]). The correct
      // hex = HEX_72 (the pin of the intermediate A). varsAB is a copy of varsMultiMode with a third mode '7:2'.
      const HEX_72 = '#993366'; // valuesByMode['7:2'] — r:.6 g:.2 b:.4
      const varsAB: RawVariablesResponse = {
        meta: {
          variables: {
            'VariableID:9:9': {
              id: 'VariableID:9:9', name: 'neutral/bg/base', resolvedType: 'COLOR',
              variableCollectionId: 'VariableCollectionId:7:7',
              valuesByMode: { m0: { r: 1, g: 1, b: 1, a: 1 }, '7:1': { r: 0.2, g: 0.4, b: 0.6, a: 1 }, '7:2': { r: 0.6, g: 0.2, b: 0.4, a: 1 } },
            },
          },
          variableCollections: {
            'VariableCollectionId:7:7': {
              id: 'VariableCollectionId:7:7', name: 'Theme', defaultModeId: 'm0',
              modes: [{ modeId: 'm0', name: 'Default' }, { modeId: '7:1', name: 'Solar' }, { modeId: '7:2', name: 'Alt' }],
            },
          },
        },
      };
      const varsABFn = async (): Promise<RawVariablesResponse> => varsAB;

      const docSkel = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', children: [
          { id: '5:5', type: 'SECTION', name: 'A', absoluteBoundingBox: { x: 0, y: 0, width: 3000, height: 3000 } },
          //   ↑ the skeleton copy of A DELIBERATELY WITHOUT explicitVariableModes — the mode must come from the probe RESPONSE ROOT
          { id: '5:9', type: 'SECTION', name: 'Aprime', absoluteBoundingBox: { x: 0, y: 0, width: 3000, height: 3000 },
            explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' } },
        ] }] }, version: 'v1' } as unknown as RawFileResponse;
      const probeA = { id: '5:5', type: 'SECTION', name: 'A', explicitVariableModes: { 'VariableCollectionId:7:7': '7:2' },
        children: [{ id: '6:6', type: 'SECTION', name: 'B', absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 } }] } as RawSceneNode;
      const probeAprime = { id: '5:9', type: 'SECTION', name: 'Aprime', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
        children: [] } as RawSceneNode;                                  // documentarily does NOT contain the frame
      const probeB = { id: '6:6', type: 'SECTION', name: 'B',
        children: [{ id: '9:1', type: 'FRAME', name: 'frame' }] } as RawSceneNode;   // WITHOUT a pin
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 100, y: 100, width: 50, height: 50 }, children: [cardBoundFill] } as RawSceneNode;

      const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number): Promise<RawNodesResponse> => {
        if (ids.includes('5:5') || ids.includes('5:9')) {
          expect(depth).toBe(1);
          const nodes: Record<string, { document: RawSceneNode }> = {};
          if (ids.includes('5:5')) nodes['5:5'] = { document: probeA };
          if (ids.includes('5:9')) nodes['5:9'] = { document: probeAprime };
          return { nodes };
        }
        if (ids.includes('6:6')) { expect(depth).toBe(1); return { nodes: { '6:6': { document: probeB } } }; }
        return ids.includes('9:1')
          ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
          : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docSkel);
      const run = harness({ getNodesRaw, getVariablesLocal: varsABFn, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });

      const colorRow = JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.figma).toBe(HEX_72);              // the pin of the intermediate A (true path), NOT default
      expect(colorRow.figma).not.toBe(HEX_71);           // NOT the sibling Aprime — a flat bbox-merge would have caught it
      expect(colorRow.figma).not.toBe('#ffffff');         // the level is NOT lost (a partial chain didn't slip in the default)
      const probeCalls = getNodesRaw.mock.calls.filter((c) => c[2] === 1);
      expect(probeCalls.length).toBe(2);                  // exactly 2 rounds: [5:5,5:9] → [6:6]
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toEqual([2]);                        // the probe-descent found the chain — whole-file discovery did NOT start
      // The mutation "flat branch merge / membership by bbox" (m1, sceneIdEquals→boxIntersects) → A' also
      // matches as "containing" the frame (its bbox intersects frameBox) → HEX_71 → RED on toBe(HEX_72).
      // The mutation "loss of the intermediate level" (m3, next.push WITHOUT accumulating chain) → probeA drops
      // out of the chain → default hex → RED on not.toBe('#ffffff').
    });

    it('probe-descent: the cap of 64 counts pre-filter SURVIVORS — 100 top-level frames, 1 intersects → descent lives', async () => {
      const farFrames: RawSceneNode[] = Array.from({ length: 99 }, (_, i) => ({
        id: `9:${200 + i}`, type: 'FRAME', name: `far${i}`,
        absoluteBoundingBox: { x: 100000 + i, y: 100000, width: 10, height: 10 },
      }));
      const nearFrame: RawSceneNode = { id: '5:5', type: 'FRAME', name: 'near', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 } };
      const docSkel = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', children: [...farFrames, nearFrame] },
      ] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 10, y: 10, width: 375, height: 812 }, children: [cardBoundFill] } as RawSceneNode;
      const probeNear = { id: '5:5', type: 'FRAME', name: 'near', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 },
        explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
        children: [{ id: '9:1', type: 'FRAME', name: 'frame' }] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number): Promise<RawNodesResponse> => {
        if (depth === 1) { expect(ids).toEqual(['5:5']); return { nodes: { '5:5': { document: probeNear } } }; }
        return ids.includes('9:1')
          ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
          : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docSkel);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const probeCall = getNodesRaw.mock.calls.find((c) => c[2] === 1);
      expect(probeCall![1]).toEqual(['5:5']);            // exactly 1 survivor — 99 far ones filtered out by the pre-filter
      const colorRow = JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow).toBeDefined();
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toEqual([2]);                        // the descent found the chain in 1 round — whole-file did NOT start
    });

    it('probe-descent (d) cap: >64 pre-filter survivors → probe NOT called, honest discovery deepening', async () => {
      const nearSections: RawSceneNode[] = Array.from({ length: 70 }, (_, i) => ({
        id: `5:${i}`, type: 'SECTION', name: `S${i}`,
        absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 },
      }));
      const docSkel = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', children: nearSections },
      ] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 10, y: 10, width: 375, height: 812 }, children: [cardBoundFill] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], _depth?: number): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
                            : { nodes: { '1:1': { document: cardBoundFill } } });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docSkel);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(getNodesRaw.mock.calls.some((c) => c[2] === 1)).toBe(false); // the cap cut off BEFORE the probe — not a single depth-1 call
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toContain(4);                        // whole-file discovery started honestly
      expect(JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill')).toBeDefined();
    });

    it('probe-descent (d) rounds exhausted: A⊃B⊃C⊃D (3 rounds — all containers without the frame) → honest discovery after the 3rd round', async () => {
      const docSkel = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', children: [
          { id: '5:1', type: 'SECTION', name: 'A', absoluteBoundingBox: { x: 0, y: 0, width: 3000, height: 3000 } },
        ] }] }, version: 'v1' } as unknown as RawFileResponse;
      const probeA = { id: '5:1', type: 'SECTION', name: 'A', children: [
        { id: '5:2', type: 'SECTION', name: 'B', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 } },
      ] } as RawSceneNode;
      const probeB = { id: '5:2', type: 'SECTION', name: 'B', children: [
        { id: '5:3', type: 'SECTION', name: 'C', absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 } },
      ] } as RawSceneNode;
      const probeC = { id: '5:3', type: 'SECTION', name: 'C', children: [
        { id: '5:4', type: 'SECTION', name: 'D', absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 500 } },
      ] } as RawSceneNode;                                // the 3rd round yields ANOTHER container, NOT the frame — rounds exhausted
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 }, children: [cardBoundFill] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number): Promise<RawNodesResponse> => {
        if (depth === 1) {
          if (ids.includes('5:1')) return { nodes: { '5:1': { document: probeA } } };
          if (ids.includes('5:2')) return { nodes: { '5:2': { document: probeB } } };
          if (ids.includes('5:3')) return { nodes: { '5:3': { document: probeC } } };
        }
        return ids.includes('9:1')
          ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
          : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docSkel);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const probeCalls = getNodesRaw.mock.calls.filter((c) => c[2] === 1);
      expect(probeCalls.length).toBe(3);                  // exactly DESCENT_MAX_ROUNDS rounds, none found the frame
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toContain(4);                        // rounds exhausted → honest discovery fallback
      expect(JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill')).toBeDefined();
    });

    it('probe-descent (d) probe error: getNodesRaw throws → honest (d), logs compare.canvas_chain_unavailable', async () => {
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', children: [
          { id: '5:5', type: 'SECTION', name: 'S', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 } },
        ] }] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 10, y: 10, width: 375, height: 812 }, children: [cardBoundFill] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number): Promise<RawNodesResponse> => {
        if (depth === 1) throw new Error('boom');
        return ids.includes('9:1')
          ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
          : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docNoFrame);
      const { logger: recLogger, logs } = recordingLogger();
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw }, 40000, { logger: recLogger });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(logs.some((l) => l.msg === 'compare.canvas_chain_unavailable')).toBe(true);
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill')).toBeDefined();
    });

    it('probe-descent (d) probe timeout: FigmaApiError network "timed out" → honest (d) without hanging', async () => {
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', children: [
          { id: '5:5', type: 'SECTION', name: 'S', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 } },
        ] }] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 10, y: 10, width: 375, height: 812 }, children: [cardBoundFill] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number): Promise<RawNodesResponse> => {
        if (depth === 1) throw new FigmaApiError('network', 0, 'Figma request timed out after 20000ms');
        return ids.includes('9:1')
          ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
          : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docNoFrame);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill')).toBeDefined();
    });

    it('probe-descent (d) deadline BEFORE probe: an expired budget → the descent enters, but the pre-probe remaining<=0 guard cuts off BEFORE the probe call', async () => {
      // toolTimeBudgetMs:1 (the pattern from the :520 area) DISTINGUISHES discoverAncestorModes' floor-gate (Date.
      // now()+15000>deadlineAt — the floor dominates, true regardless of the real elapsed time),
      // but the probe-descent's pre-probe gate is a BARE `remaining<=0` WITHOUT a floor: under a JIT-warm full-suite run
      // the synchronous path BEFORE this check (the mock's main fetch + resolveSetNames early-return + etc.)
      // fits in <1ms of real wall-clock — Date.now() doesn't manage to advance past
      // deadlineAt=+1ms → RED was discovered LIVE (flaky: green in isolation, red in the full
      // run). The fix is a negative budget: deadlineAt is already IN THE PAST at capture time (:189, BEFORE
      // the probe-descent), remaining<=0 holds DETERMINISTICALLY regardless of machine/JIT speed.
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', children: [
          { id: '5:5', type: 'SECTION', name: 'S', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 } },
        ] }] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 10, y: 10, width: 375, height: 812 }, children: [cardBoundFill] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], _depth?: number): Promise<RawNodesResponse> =>
        ids.includes('9:1') ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
                            : { nodes: { '1:1': { document: cardBoundFill } } });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docNoFrame);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw }, 40000, { toolTimeBudgetMs: -60_000 });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(getNodesRaw.mock.calls.some((c) => c[2] === 1)).toBe(false); // probe NOT called — the deadline expired earlier
      expect(res.content[0].text).toContain('"pairs"');                  // honest degradation, the call did NOT fail
      // The mutation "remove the pre-probe remaining<=0 guard" → probe is called despite the expired deadline → RED
    });

    it('probe-descent: rate_limited from the probe — rethrow (isError), NOT swallowed into (d)', async () => {
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', children: [
          { id: '5:5', type: 'SECTION', name: 'S', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 } },
        ] }] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: '9:1', name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 10, y: 10, width: 375, height: 812 }, children: [cardBoundFill] } as RawSceneNode;
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number): Promise<RawNodesResponse> => {
        if (depth === 1) throw new FigmaApiError('rate_limited', 429, 'slow down', 5);
        return ids.includes('9:1')
          ? { nodes: { '9:1': { document: frameDeep }, '1:1': { document: cardBoundFill } } }
          : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, _depth?: number): Promise<RawFileResponse> => docNoFrame);
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/rate_limited/i);
    });

    it("probe-descent: I-prefix membership — the frame-instance part I9:1;3:3 is found in the section's children", async () => {
      const FRAME_ID = 'I9:1;3:3';
      const docNoFrame = { document: { id: '0:0', type: 'DOCUMENT', name: 'D', children: [
        { id: '0:1', type: 'CANVAS', name: 'P', explicitVariableModes: { 'VariableCollectionId:7:7': '7:1' },
          children: [
            { id: '5:5', type: 'SECTION', name: 'S', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 } },
          ] }] }, version: 'v1' } as unknown as RawFileResponse;
      const frameDeep = { id: FRAME_ID, name: 'frame', type: 'FRAME',
        absoluteBoundingBox: { x: 10, y: 10, width: 375, height: 812 }, children: [cardBoundFill] } as RawSceneNode;
      const probeSection = { id: '5:5', type: 'SECTION', name: 'S',
        absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 },
        children: [{ id: '9:1;3:3', type: 'FRAME', name: 'frame' }] } as RawSceneNode; // WITHOUT the leading I
      const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number): Promise<RawNodesResponse> => {
        if (ids.includes('5:5')) { expect(depth).toBe(1); return { nodes: { '5:5': { document: probeSection } } }; }
        return ids.includes(FRAME_ID)
          ? { nodes: { [FRAME_ID]: { document: frameDeep }, '1:1': { document: cardBoundFill } } }
          : { nodes: { '1:1': { document: cardBoundFill } } };
      });
      const getDocumentRaw = vi.fn(async (_f: string, depth?: number): Promise<RawFileResponse> => { expect(depth).toBe(2); return docNoFrame; });
      const run = harness({ getNodesRaw, getVariablesLocal: multiModeVars, getDocumentRaw });
      const res = await run({ file: FILE, frame_node_id: FRAME_ID, pairs: [{ node_id: '1:1', dom: domFor(cardBoundFill) }] });
      const colorRow = JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.figma).toBe(HEX_71);
      const depths = getDocumentRaw.mock.calls.map((c) => c[1]);
      expect(depths).toEqual([2]);                        // the probe-descent found the chain without whole-file discovery
    });
  });

  it('batches all ids (+frame) into ONE fetch when frame enumeration complete at effDepth, diffs and renders the report', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card }, '9:1': { document: frameNode } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', pairs: [{ node_id: '1-1', dom: okDom, label: 'card' }], frame_node_id: '9-1', tolerance_px: 1 });
    expect(getNodesRaw).toHaveBeenCalledTimes(1);
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1', '9:1'], 5); // FETCH_DEPTH 4→5 (peek headroom)
    const out = JSON.parse(res.content[0].text);
    expect(out.frame).toEqual({ node_id: '9:1', width: 375 });
    const gap = out.pairs[0].rows.find((r: any) => r.prop.startsWith('gap[0]'));
    expect(gap).toMatchObject({ figma: 20, dom: 48, status: 'fail' });
    expect(out.summary.fail).toBeGreaterThanOrEqual(1);
    expect(out.report_markdown).toContain('Verified against Figma');
    expect(out.report_markdown).toContain('❌ gap[0] title↔list');
    // tier 2: frameNode is projected without truncation (a leaf, no children) → no deep-fetch needed, honest source pair_fetch@effDepth
    expect(out.verification.frame_coverage.enumeration_source).toBe('pair_fetch');
    expect(out.verification.frame_coverage.enumeration_depth).toBe(4);
  });

  // A byte-lock on compare's output WITHOUT frame_node_id. opts.frame/opts.frameRequested are both
  // absent in buildVerification → scope stays 'pairs', frame_coverage/spacing_audit are entirely
  // undefined (not merely empty {}) — which means ALL the enumeration_*/uncovered_capped/partial_capped
  // fields (which live ONLY inside frame_coverage) physically cannot leak into the JSON. An exact
  // enumeration of keys — if anyone ever starts emitting frame_coverage:{} by default
  // (instead of an honest undefined), this test will catch it first.
  it('compare WITHOUT frame_node_id: verification.scope==="pairs", NO frame_coverage/spacing_audit/enumeration fields (byte-lock)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom, label: 'card' }] })).content[0].text);

    expect(out.verification.scope).toBe('pairs');
    expect(out.verification.frame_coverage).toBeUndefined();
    expect(out.verification.spacing_audit).toBeUndefined();

    // an exact enumeration of the absent keys — we check the serialized JSON as a whole (not only
    // verification), so the lock doesn't depend on where exactly these fields might hypothetically surface.
    const json = JSON.stringify(out);
    for (const key of [
      'frame_coverage', 'spacing_audit', 'enumeration_depth', 'enumeration_source',
      'enumeration_causes', 'enumeration_note', 'uncovered_capped', 'partial_capped',
    ]) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  it('coverage manifest: pairs[].coverage.measured + not_covered_by_tool + footer', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardWithText } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDomWithText, label: 'card' }] });
    const out = JSON.parse(res.content[0].text);
    expect(out.pairs[0].coverage.measured).toEqual(expect.arrayContaining(['size', 'font-size']));
    expect(out.pairs[0].coverage.skipped).toEqual([]);
    expect(out.not_covered_by_tool).toEqual([
      'icon-glyph (shape/path geometry - verify visually or by screenshot crop)',
      'icon-font/mask-image icons (the color is visible but not compared)',
    ]);
    expect(out.report_markdown).toContain('NOT covered by this tool');
    expect(out.report_markdown).toContain('typography checked to 4 nesting levels'); // depth-ceiling note (nit 1)
  });

  it('frame_node_id missing from batch → warn row per pair, guard off', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card }, '9:1': null } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], frame_node_id: '9:1' })).content[0].text);
    const frameRow = out.pairs[0].rows.find((r: any) => r.prop === 'frame');
    expect(frameRow).toMatchObject({ status: 'warn' });
    expect(frameRow.note).toContain('viewport');
    expect(out.pairs[0].rows.find((r: any) => r.prop === 'viewport')).toBeUndefined();
  });

  it('node not found → warn pair, others processed', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card }, '7:7': null } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'abc', pairs: [
      { node_id: '7:7', dom: okDom }, { node_id: '1:1', dom: okDom },
    ] })).content[0].text);
    expect(out.pairs[0].rows[0]).toMatchObject({ prop: 'node', status: 'warn' });
    expect(out.pairs[1].rows.length).toBeGreaterThan(1);
  });

  it('schema mismatch → actionable warn row, not a zod failure', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: { ...okDom, schema: 99 } }] })).content[0].text);
    expect(out.pairs[0].rows[0].prop).toBe('snapshot_schema');
    expect(out.pairs[0].rows[0].note).toContain('include_extractor');
  });

  it('failed snapshot union member is accepted and surfaces as warn', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: { status: 'not_found', selector: '.gone' } }] })).content[0].text);
    expect(out.pairs[0].rows[0]).toMatchObject({ prop: 'snapshot', status: 'warn' });
  });

  it('clamps pairs to budget with omitted_pairs marker', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
    const run = harness({ getNodesRaw }, 1200); // tiny budget
    const pairs = Array.from({ length: 5 }, (_, i) => ({ node_id: '1:1', dom: okDom, label: `p${i}` }));
    const out = JSON.parse((await run({ file: 'abc', pairs })).content[0].text);
    expect(out.pairs.length).toBeLessThan(5);
    expect(out.omitted_pairs).toBe(5 - out.pairs.length);
  });

  describe('budget: measure == delivery (compact), not pretty', () => {
    it('a budget between the compact and pretty lengths → pairs are NOT trimmed (the "pretty measurement" mutation → RED)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card }, '9:1': { document: frameNode } } }));
      const getVariablesLocal = vi.fn(async () => emptyVars);
      // run-1: a large budget → the actual DELIVERED length (compact)
      const runBig = harness({ getNodesRaw, getVariablesLocal }, 400000);
      const pairs = [
        { node_id: '1:1', dom: domFor(card) },
        { node_id: '1:1', dom: domFor(card) },
        { node_id: '1:1', dom: domFor(card) },
      ];
      const big = await runBig({ file: FILE, pairs });
      const deliveredLen = big.content[0].text.length;
      expect(JSON.parse(big.content[0].text).omitted_pairs).toBeUndefined();
      // run-2: a budget just above the delivered length (but DEFINITELY below pretty ≈ ×1.9+)
      const runTight = harness({ getNodesRaw: vi.fn(getNodesRaw), getVariablesLocal: vi.fn(async () => emptyVars) }, deliveredLen + 200);
      const tight = await runTight({ file: FILE, pairs });
      const out = JSON.parse(tight.content[0].text);
      expect(out.omitted_pairs).toBeUndefined();   // the compact measurement fits; a pretty measurement would have trimmed
      expect(out.pairs).toHaveLength(3);
      expect(tight.content[0].text.length).toBeLessThanOrEqual(deliveredLen + 200); // delivered ≤ budget
    });
  });

  // budget-cascade: the cascade "full → bulk-pass compression → omitted_pairs". Both tests
  // SELF-CALIBRATE (meta-lesson #69: budget boundaries are measured by a run, NOT guessed) — not a single
  // baked byte constant. Measured reference points (for a future reader, verified by a calibration run):
  // full(4 pairs, manyText) ≈ 27333 chars; condensed(4) ≈ 20.5K (saving ~6.8K, 36 pass rows/pair → 1);
  // full(6) ≈ 40561.
  describe('budget cascade: bulk-pass condensation before omission', () => {
    it("cascade B: full doesn't fit, condensed fits → all pairs delivered with passes_condensed, no omitted", async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: manyTextCard } } }));
      const getVariablesLocal = vi.fn(async () => emptyVars);
      const pairs = Array.from({ length: 4 }, () => ({ node_id: '1:1', dom: manyTextDom }));
      // calibration: a large budget → the actual delivered full length (measured, not a constant).
      const runBig = harness({ getNodesRaw, getVariablesLocal }, 400000);
      const big = await runBig({ file: FILE, pairs });
      const fullLen = big.content[0].text.length;
      const bigOut = JSON.parse(big.content[0].text);
      expect(bigOut.omitted_pairs).toBeUndefined(); // sanity: at a large budget the full response actually fits
      const bigFails = bigOut.pairs[0].rows.filter((r: any) => r.status === 'fail').length;
      expect(bigFails).toBeGreaterThan(0); // sanity: the fixture carries signal rows
      // budget = fullLen-1: guaranteed < full (the cascade enters), but the condensed form (36 pass rows
      // per pair → 1 passes_condensed, saving ~thousands of bytes/pair) fits with huge headroom → B.
      const runMid = harness({ getNodesRaw: vi.fn(getNodesRaw), getVariablesLocal: vi.fn(async () => emptyVars) }, fullLen - 1);
      const mid = await runMid({ file: FILE, pairs });
      const out = JSON.parse(mid.content[0].text);
      expect(out.omitted_pairs).toBeUndefined();
      expect(out.pairs).toHaveLength(4);
      const cond = out.pairs[0].rows.find((r: any) => r.prop === 'passes_condensed');
      expect(cond).toBeDefined();
      // signal rows (fail) are preserved EXACTLY by count — the collapse touches ONLY bulk-pass.
      expect(out.pairs[0].rows.filter((r: any) => r.status === 'fail').length).toBe(bigFails);
      expect(out.pairs[0].rows.some((r: any) => ['fail', 'warn', 'demoted', 'unchecked'].includes(r.status))).toBe(true);
      expect(mid.content[0].text.length).toBeLessThanOrEqual(fullLen - 1);
    });
    it("cascade C: even condensed doesn't fit → omitted_pairs, kept pairs in condensed form, delivery ≤ budget", async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: manyTextCard } } }));
      const getVariablesLocal = vi.fn(async () => emptyVars);
      const pairs = Array.from({ length: 6 }, () => ({ node_id: '1:1', dom: manyTextDom }));
      // calibration of cascade C's FLOOR: budget=1 → clampToBudget keeps ≥1 pair (the floor), delivery = floorLen
      // (the condensed 1 pair out of 6 + the omitted marker). Measured, not guessed.
      const runFloor = harness({ getNodesRaw, getVariablesLocal }, 1);
      const floor = await runFloor({ file: FILE, pairs });
      const floorLen = floor.content[0].text.length;
      const floorOut = JSON.parse(floor.content[0].text);
      expect(floorOut.omitted_pairs).toBeGreaterThan(0);
      expect(floorOut.pairs.length).toBeGreaterThanOrEqual(1);
      expect(floorOut.pairs[0].rows.find((r: any) => r.prop === 'passes_condensed')).toBeDefined();
      // budget = floorLen (exactly the floor): still omitted>0 (6 condensed pairs don't fit), but now
      // delivery ≤ budget — unlike budget=1, where the floor honestly overflows.
      const runTiny = harness({ getNodesRaw: vi.fn(getNodesRaw), getVariablesLocal: vi.fn(async () => emptyVars) }, floorLen);
      const tiny = await runTiny({ file: FILE, pairs });
      const out = JSON.parse(tiny.content[0].text);
      expect(out.omitted_pairs).toBeGreaterThan(0);
      expect(tiny.content[0].text.length).toBeLessThanOrEqual(floorLen);
    });
  });

  // fix-plan: the budget TIER of fix_plan stripping BETWEEN condense and omitted_pairs. fix_plan is
  // pure duplication of rows: if it doesn't fit after condense, we FIRST strip fix_plan from all pairs
  // (+fix_plan_stripped:true), and only then does the clamp drop whole pairs. All three tests SELF-CALIBRATE
  // (meta-lesson #69). tolerance_px:1 is MANDATORY: the harness bypasses zod → without it tol=undefined and delta>tol
  // is false → srcChannel isn't set → fix_plan is empty (a harness artifact, not prod). Fixture: matched
  // typography (bulk-pass, condensable) + mismatched size (fail root/layout → the null group of fix_plan).
  describe('budget: fix_plan strip tier (between condense and omitted)', () => {
    // size mismatch (rect) + cross-offset mismatch (x 30 vs figma 16) on all 12 children → >10 fail-edits
    // → fix_plan_capped is present (the lock "stripping removes fix_plan AND fix_plan_capped together"). Typography
    // matched → bulk-pass (condensable).
    const manyTextDomNarrow = {
      schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
      rect: { x: 0, y: 0, w: 300, h: 555 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
      scroll: { top: 0, left: 0 }, transformed: false,
      children: Array.from({ length: MANY_TEXT_N }, (_, i) => ({
        kind: 'element', tag: 'p', rect: { x: 30, y: 12 + i * 48, w: 200, h: 24 }, // x 30≠16 → offset-cross fail
        styles: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14 },
      })),
    };
    it("condensed doesn't fit → fix_plan stripped from ALL pairs (fix_plan_stripped) BEFORE dropping pairs; the \"drop before strip\" mutation → RED", async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: manyTextCard } } }));
      const getVariablesLocal = vi.fn(async () => emptyVars);
      const N = 4;
      const pairs = Array.from({ length: N }, () => ({ node_id: '1:1', dom: manyTextDomNarrow }));

      // (1) a large budget → full length + sanity: fix_plan is REALLY present (otherwise the test is empty).
      const runBig = harness({ getNodesRaw, getVariablesLocal }, 400000);
      const big = await runBig({ file: FILE, pairs, tolerance_px: 1 });
      const fullLen = big.content[0].text.length;
      const bigOut = JSON.parse(big.content[0].text);
      expect(bigOut.omitted_pairs).toBeUndefined();
      expect(bigOut.fix_plan_stripped).toBeUndefined();          // full fits → no stripping
      expect(bigOut.pairs[0].fix_plan).toBeDefined();            // sanity: fix_plan is present (size-fail → null group)
      expect(bigOut.pairs[0].fix_plan[0].channel).toBe('unknown'); // without classList no address is derived
      expect(bigOut.pairs[0].fix_plan[0].edits.some((e: any) => e.prop === 'size.w')).toBe(true);
      expect(bigOut.pairs[0].fix_plan_capped).toBeGreaterThan(0); // >10 fail-edits → trim (for the lock "both fields together")

      // (2) budget = fullLen-1 → condensed (WITH fix_plan) fits → all pairs, passes_condensed, fix_plan ALIVE.
      const runMid = harness({ getNodesRaw: vi.fn(getNodesRaw), getVariablesLocal: vi.fn(async () => emptyVars) }, fullLen - 1);
      const mid = await runMid({ file: FILE, pairs, tolerance_px: 1 });
      const condLen = mid.content[0].text.length;
      const midOut = JSON.parse(mid.content[0].text);
      expect(midOut.omitted_pairs).toBeUndefined();
      expect(midOut.fix_plan_stripped).toBeUndefined();          // condense was enough → there was NO stripping
      expect(midOut.pairs).toHaveLength(N);
      expect(midOut.pairs[0].rows.find((r: any) => r.prop === 'passes_condensed')).toBeDefined();
      expect(midOut.pairs[0].fix_plan).toBeDefined();            // fix_plan survived condense (spread)

      // (3) budget = condLen-1 → condensed does NOT fit, but condensed-WITHOUT-fix_plan (all pairs) fits →
      // the strip tier: fix_plan_stripped, ALL pairs delivered, NONE has fix_plan. The mutant
      // "clamp condensed WITH fix_plan (drop pairs before stripping)" → omitted>0 → RED on the omitted assert.
      const runStrip = harness({ getNodesRaw: vi.fn(getNodesRaw), getVariablesLocal: vi.fn(async () => emptyVars) }, condLen - 1);
      const strip = await runStrip({ file: FILE, pairs, tolerance_px: 1 });
      const stripOut = JSON.parse(strip.content[0].text);
      expect(stripOut.fix_plan_stripped).toBe(true);             // the tier fired
      expect(stripOut.omitted_pairs).toBeUndefined();            // stripping freed space → pairs NOT dropped
      expect(stripOut.pairs).toHaveLength(N);
      for (const p of stripOut.pairs) expect(p.fix_plan).toBeUndefined();       // fix_plan stripped from ALL
      for (const p of stripOut.pairs) expect(p.fix_plan_capped).toBeUndefined(); // and capped along with it
      expect(stripOut.pairs[0].rows.find((r: any) => r.prop === 'passes_condensed')).toBeDefined(); // rows intact
      expect(stripOut.pairs[0].rows.some((r: any) => r.prop === 'size.w' && r.status === 'fail')).toBe(true); // fail data intact
      expect(strip.content[0].text.length).toBeLessThanOrEqual(condLen - 1); // delivery ≤ budget
    });
  });

  describe('dom_ref', () => {
    it('resolves via deps.snapshotStore and diffs identically to the inline dom equivalent', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const resolve = vi.fn(() => ({ ok: true as const, snapshot: okDom }));
      const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];

      const inlineRun = harness({ getNodesRaw });
      const refRun = harness({ getNodesRaw }, 40000, { snapshotStore, tenantId: 'user-1' });

      const inlineOut = JSON.parse((await inlineRun({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }] })).content[0].text);
      const refOut = JSON.parse((await refRun({ file: 'abc', pairs: [{ node_id: '1:1', dom_ref: { ref: 'ref-1', selector: '.card' } }] })).content[0].text);

      expect(refOut.pairs[0].rows).toEqual(inlineOut.pairs[0].rows);
      expect(refOut.pairs[0].selector).toBe('.card');
      expect(resolve).toHaveBeenCalledWith('ref-1', '.card', 'user-1');
    });

    it('expired ref → honest warn telling the caller to re-run the extractor, batch keeps processing other pairs', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const resolve = vi.fn(() => ({ ok: false as const, reason: 'expired' as const }));
      const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, 40000, { snapshotStore });

      const out = JSON.parse((await run({ file: 'abc', pairs: [
        { node_id: '1:1', dom_ref: { ref: 'stale-ref', selector: '.card' } },
        { node_id: '1:1', dom: okDom },
      ] })).content[0].text);

      expect(out.pairs[0].rows[0]).toMatchObject({ status: 'warn' });
      expect(out.pairs[0].rows[0].note).toContain('re-run the extractor');
      // the second (inline) pair in the SAME batch was still fully processed — a bad dom_ref must
      // not TypeError the whole Promise.all.
      expect(out.pairs[1].rows.length).toBeGreaterThan(1);
      expect(out.pairs[1].rows.some((r: any) => r.status === 'fail' || r.status === 'pass')).toBe(true);
    });

    it('unknown_selector → warn lists the selectors actually present in the ref (from resolve() response)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const resolve = vi.fn(() => ({ ok: false as const, reason: 'unknown_selector' as const, selectors: ['.title', '.list'] }));
      const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, 40000, { snapshotStore });

      const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom_ref: { ref: 'r1', selector: '.wrong' } }] })).content[0].text);

      expect(out.pairs[0].rows[0]).toMatchObject({ status: 'warn' });
      expect(out.pairs[0].rows[0].note).toContain('.title');
      expect(out.pairs[0].rows[0].note).toContain('.list');
    });

    it('owner_mismatch is masked under the SAME honest text as unknown_ref', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const mismatchRun = harness({ getNodesRaw }, 40000, {
        snapshotStore: { resolve: vi.fn(() => ({ ok: false as const, reason: 'owner_mismatch' as const })) } as unknown as ToolDeps['snapshotStore'],
      });
      const unknownRefRun = harness({ getNodesRaw }, 40000, {
        snapshotStore: { resolve: vi.fn(() => ({ ok: false as const, reason: 'unknown_ref' as const })) } as unknown as ToolDeps['snapshotStore'],
      });

      const pairs = [{ node_id: '1:1', dom_ref: { ref: 'r', selector: '.x' } }];
      const mismatchOut = JSON.parse((await mismatchRun({ file: 'abc', pairs })).content[0].text);
      const unknownRefOut = JSON.parse((await unknownRefRun({ file: 'abc', pairs })).content[0].text);

      expect(mismatchOut.pairs[0].rows[0].note).toBe(unknownRefOut.pairs[0].rows[0].note);
      expect(mismatchOut.pairs[0].rows[0].note).toContain('re-run the extractor');
    });

    it('dom_ref without a configured snapshotStore → honest warn, no throw', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const run = harness({ getNodesRaw }); // no snapshotStore in deps at all

      const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom_ref: { ref: 'r', selector: '.x' } }] })).content[0].text);

      expect(out.pairs[0].rows[0]).toMatchObject({ status: 'warn' });
      expect(out.pairs[0].rows[0].note).toContain('snapshot store unavailable');
    });

    it('stale snapshot_schema resolved THROUGH dom_ref → same actionable version warn as inline', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const resolve = vi.fn(() => ({ ok: true as const, snapshot: { ...okDom, schema: 99 } }));
      const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, 40000, { snapshotStore });

      const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom_ref: { ref: 'r', selector: '.card' } }] })).content[0].text);

      expect(out.pairs[0].rows[0].prop).toBe('snapshot_schema');
      expect(out.pairs[0].rows[0].note).toContain('include_extractor');
    });

    it('PairSchema rejects when BOTH dom and dom_ref are given', () => {
      const result = PairSchema.safeParse({ node_id: '1:1', dom: okDom, dom_ref: { ref: 'r', selector: '.x' } });
      expect(result.success).toBe(false);
    });

    it('PairSchema rejects when NEITHER dom nor dom_ref is given', () => {
      const result = PairSchema.safeParse({ node_id: '1:1' });
      expect(result.success).toBe(false);
    });

    it('PairSchema still accepts inline dom alone (no regression)', () => {
      const result = PairSchema.safeParse({ node_id: '1:1', dom: okDom });
      expect(result.success).toBe(true);
    });

    it('PairSchema still accepts dom_ref alone', () => {
      const result = PairSchema.safeParse({ node_id: '1:1', dom_ref: { ref: 'r', selector: '.x' } });
      expect(result.success).toBe(true);
    });

    it('unknown_selector note lists available selectors verbatim', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const resolve = vi.fn(() => ({ ok: false, reason: 'unknown_selector', selectors: ['.a', '.b'] }));
      const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, 40000, { snapshotStore });
      const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom_ref: { ref: 'r', selector: '.x' } }] })).content[0].text);
      const row = out.pairs[0].rows.find((r: any) => r.prop === 'snapshot_ref');
      expect(row.note).toContain('selector not found in snapshot_ref');
      expect(row.note).toContain('[.a, .b]');
    });
  });

  describe('dom_ref.index (positional, duplicate-selector-safe)', () => {
    it('resolves via deps.snapshotStore.resolveByIndex and diffs identically to the selector path; base.selector restored from the snapshot fallback', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const resolveByIndex = vi.fn(() => ({ ok: true as const, snapshot: okDom }));
      const indexStore = { resolveByIndex } as unknown as ToolDeps['snapshotStore'];
      const indexRun = harness({ getNodesRaw }, 40000, { snapshotStore: indexStore, tenantId: 'user-1' });

      const resolve = vi.fn(() => ({ ok: true as const, snapshot: okDom }));
      const selectorStore = { resolve } as unknown as ToolDeps['snapshotStore'];
      const selectorRun = harness({ getNodesRaw }, 40000, { snapshotStore: selectorStore, tenantId: 'user-1' });

      const indexOut = JSON.parse((await indexRun({ file: 'abc', pairs: [{ node_id: '1:1', dom_ref: { ref: 'ref-1', index: 2 } }] })).content[0].text);
      const selectorOut = JSON.parse((await selectorRun({ file: 'abc', pairs: [{ node_id: '1:1', dom_ref: { ref: 'ref-1', selector: '.card' } }] })).content[0].text);

      expect(indexOut.pairs[0].rows).toEqual(selectorOut.pairs[0].rows);
      expect(indexOut.pairs[0].selector).toBe('.card');
      expect(resolveByIndex).toHaveBeenCalledWith('ref-1', 2, 'user-1');
    });

    it('index out of range → warn with the index-specific "out of range" text listing the available selectors', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const resolveByIndex = vi.fn(() => ({ ok: false as const, reason: 'unknown_selector' as const, selectors: ['.title', '.list'] }));
      const snapshotStore = { resolveByIndex } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, 40000, { snapshotStore });

      const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom_ref: { ref: 'r1', index: 5 } }] })).content[0].text);

      expect(out.pairs[0].rows[0]).toMatchObject({ status: 'warn' });
      expect(out.pairs[0].rows[0].note).toContain('out of range');
      expect(out.pairs[0].rows[0].note).toContain('.title');
      expect(out.pairs[0].rows[0].note).toContain('.list');
    });

    it('PairSchema rejects dom_ref with BOTH selector and index', () => {
      const result = PairSchema.safeParse({ node_id: '1:1', dom_ref: { ref: 'r', selector: '.x', index: 0 } });
      expect(result.success).toBe(false);
    });

    it('PairSchema rejects dom_ref with NEITHER selector nor index', () => {
      const result = PairSchema.safeParse({ node_id: '1:1', dom_ref: { ref: 'r' } });
      expect(result.success).toBe(false);
    });

    it('PairSchema accepts dom_ref with index alone', () => {
      const result = PairSchema.safeParse({ node_id: '1:1', dom_ref: { ref: 'r', index: 0 } });
      expect(result.success).toBe(true);
    });

    it('PairSchema rejects a negative or non-integer index', () => {
      expect(PairSchema.safeParse({ node_id: '1:1', dom_ref: { ref: 'r', index: -1 } }).success).toBe(false);
      expect(PairSchema.safeParse({ node_id: '1:1', dom_ref: { ref: 'r', index: 1.5 } }).success).toBe(false);
    });
  });

  describe('expected_overlay_width + preflight (fix-overlay width policy)', () => {
    // A minimal figma node WITHOUT children — geometryRows returns only size.w/size.h
    // (structure_mismatch/gap/offset-cross don't participate), so that "exactly one signal" in
    // the tests below checks exactly the target rows, not side effects of the fixture.
    const drawerCard: RawSceneNode = {
      id: '1:1', name: 'drawer', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 420, height: 120 },
      layoutMode: 'VERTICAL', itemSpacing: 20,
    };
    const frame420: RawSceneNode = { id: '9:1', name: 'f420', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 420, height: 812 } };
    const frame464: RawSceneNode = { id: '9:2', name: 'f464', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 464, height: 900 } };

    const overlayDom = (innerWidth: number, rectW: number) => ({
      schema: 6, status: 'ok', selector: '.drawer', innerWidth,
      rect: { x: 0, y: 0, w: rectW, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: rectW, clientHeight: 120, scrollHeight: 120,
      scroll: { top: 0, left: 0 }, transformed: false, children: [],
    });

    it('frame 420 + overlay 420, innerWidth 409 → size.w info + overlay_width info Δ11, no preflight, geometry not skipped', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: drawerCard }, '9:1': { document: frame420 } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({
        file: 'abc', pairs: [{ node_id: '1:1', dom: overlayDom(409, 409), label: 'drawer' }],
        frame_node_id: '9:1', expected_overlay_width: 420, tolerance_px: 1,
      })).content[0].text);

      const rows = out.pairs[0].rows;
      expect(rows.find((r: any) => r.prop === 'geometry')).toBeUndefined();
      expect(rows.find((r: any) => r.prop === 'size.w')).toMatchObject({ figma: 420, dom: 409, delta: 11, status: 'demoted' });
      expect(rows.find((r: any) => r.prop === 'overlay_width')).toMatchObject({ figma: 420, dom: 409, delta: 11, status: 'info' });
      expect(out.preflight).toBeUndefined();
      expect(out.summary.demoted).toBeGreaterThanOrEqual(1); // size.w demote
      expect(out.summary.info).toBeGreaterThanOrEqual(1);    // overlay_width diagnostic
      expect(out.report_markdown).toContain('ℹ️');
      expect(out.report_markdown).toContain('🟰');
    });

    it('frame 464 + overlay 420 → preflight warn exactly once, viewport suppressed, size.w downgraded to info (no duplicate signal)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: drawerCard }, '9:2': { document: frame464 } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({
        file: 'abc', pairs: [{ node_id: '1:1', dom: overlayDom(420, 409), label: 'drawer' }],
        frame_node_id: '9:2', expected_overlay_width: 420, tolerance_px: 1,
      })).content[0].text);

      expect(out.preflight).toContain('frame w464');
      expect(out.preflight).toContain('overlay 420');
      expect(out.preflight).toContain('find_breakpoint_variant');
      const rows = out.pairs[0].rows;
      expect(rows.find((r: any) => r.prop === 'geometry')).toBeUndefined(); // viewport reason suppressed
      expect(rows.find((r: any) => r.prop === 'size.w')?.status).toBe('demoted'); // not a duplicate fail/warn
      expect(out.report_markdown).toContain('find_breakpoint_variant');
    });

    it('frame 464 WITHOUT expected_overlay_width, innerWidth 420 → exactly one signal (enriched viewport-skip), no preflight', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: drawerCard }, '9:2': { document: frame464 } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({
        file: 'abc', pairs: [{ node_id: '1:1', dom: overlayDom(420, 409), label: 'drawer' }],
        frame_node_id: '9:2', tolerance_px: 1,
      })).content[0].text);

      expect(out.preflight).toBeUndefined();
      const rows = out.pairs[0].rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ prop: 'geometry', status: 'unchecked' });
      expect(rows[0].note).toContain('expected_overlay_width');
      expect(rows[0].note).toContain('find_breakpoint_variant');
      expect(out.summary.unchecked).toBeGreaterThanOrEqual(1); // geometry-env reclassified into unchecked
    });

    it('overlay WITHOUT frame_node_id → overlay_width row present, no preflight', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: drawerCard } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({
        file: 'abc', pairs: [{ node_id: '1:1', dom: overlayDom(409, 409), label: 'drawer' }],
        expected_overlay_width: 420, tolerance_px: 1,
      })).content[0].text);

      expect(out.frame).toBeUndefined();
      expect(out.preflight).toBeUndefined();
      expect(out.pairs[0].rows.find((r: any) => r.prop === 'overlay_width')).toMatchObject({ figma: 420, dom: 409, status: 'info' });
    });
  });

  describe("(c) dominant_blocker replaces the report's preflight slot", () => {
    const wideFrame: RawSceneNode = { id: '9:9', name: 'desktop', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 } };
    const cardA: RawSceneNode = { id: '1:1', name: 'cardA', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 } };
    const cardB: RawSceneNode = { id: '1:2', name: 'cardB', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 } };
    const narrowDom = (selector: string) => ({
      schema: 6, status: 'ok', selector, innerWidth: 1429,
      rect: { x: 0, y: 0, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 120, scrollHeight: 120,
      scroll: { top: 0, left: 0 }, transformed: false, children: [],
    });

    it('2 pairs with innerWidth 1429 at frame 1920 → report_markdown "⚠️ WINDOW WIDTH: 2 of 2" right after the heading (the first ⚠️ line)', async () => {
      const getNodesRaw = vi.fn(async () => ({
        nodes: { '1:1': { document: cardA }, '1:2': { document: cardB }, '9:9': { document: wideFrame } },
      }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({
        file: 'abc',
        pairs: [{ node_id: '1:1', dom: narrowDom('.a'), label: 'A' }, { node_id: '1:2', dom: narrowDom('.b'), label: 'B' }],
        frame_node_id: '9:9', tolerance_px: 1,
      })).content[0].text);

      expect(out.verification.dominant_blocker).toEqual({ kind: 'viewport', pairs: 2, window: 1429, frame: 1920 });

      const lines: string[] = out.report_markdown.split('\n');
      const headingIdx = lines.findIndex((l) => l.startsWith('Verified against Figma'));
      const firstWarnIdx = lines.findIndex((l) => l.startsWith('⚠️'));
      expect(headingIdx).toBeGreaterThanOrEqual(0);
      expect(firstWarnIdx).toBe(headingIdx + 2); // heading, '', the first ⚠️ line — RIGHT after the heading
      expect(lines[firstWarnIdx]).toContain('WINDOW WIDTH: 2 of 2');
      expect(lines[firstWarnIdx]).toContain('1429');
      expect(lines[firstWarnIdx]).toContain('1920');
      expect(out.preflight).toContain('WINDOW WIDTH: 2 of 2'); // effPreflight replaces the generic preflight slot
    });

    // A viewport-ergonomics edge case: a byte-lock on the seam between the serialize closure
    // (the clampToBudget measurement, :541) and the actual return (:546) — BOTH must read effPreflight,
    // NOT the old short `preflight`. With 3 narrow pairs at the default budget (40000) the banner doesn't even
    // approach the boundary — here maxResultChars is TIGHTENED so the banner (~150 chars in JSON:
    // the "preflight" field + again inside the report_markdown ⚠️ line) itself decides how many pairs fit.
    // Re-calibrated on the budget-guard invariant (compare clamp now measures serializeForDelivery = COMPACT, not
    // pretty), and AGAIN after the budget drop trace (the clamped-response bytes now include the
    // notes[] drop line + omitted_pair_ids — both measured by the closure): at N=3 narrow pairs
    // (banner "3 of 3") the compact boundary kept 2→3 in the CORRECT code (measures effPreflight) is
    // budget 6170 (serialize(kept=2, +trace)=5665, serialize(kept=3, no trace)=6170), whereas in the
    // MUTANT (serialize measures the bare preflight — absent/undefined in this scenario, the
    // "preflight" field drops out of the measurement) the boundary shifts EARLIER, to budget 5842.
    // The window [5842;6169] makes 6000 a live discriminator: verified live — the mutation
    // "serialize → bare preflight" at this budget delivers kept=3 (a real 6170 bytes) — OVERFLOWING
    // the promised budget of 6000 → RED on the assert text.length<=TIGHT_BUDGET (not only on the pair count).
    it('byte-lock: the serialize closure MUST measure effPreflight (the banner), not the bare preflight — a tight budget catches the kept discrepancy', async () => {
      const cardC: RawSceneNode = { id: '1:3', name: 'cardC', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 120 } };
      const getNodesRaw = vi.fn(async () => ({
        nodes: { '1:1': { document: cardA }, '1:2': { document: cardB }, '1:3': { document: cardC }, '9:9': { document: wideFrame } },
      }));
      // budget=6000: measured by a run between the compact boundaries of the correct (6170) and mutant
      // (5842) code — see the comment above. The constant is fixed AFTER measurement, not guessed.
      const TIGHT_BUDGET = 6000;
      const run = harness({ getNodesRaw }, TIGHT_BUDGET);
      const res = await run({
        file: 'abc',
        pairs: [
          { node_id: '1:1', dom: narrowDom('.a'), label: 'A' },
          { node_id: '1:2', dom: narrowDom('.b'), label: 'B' },
          { node_id: '1:3', dom: narrowDom('.c'), label: 'C' },
        ],
        frame_node_id: '9:9', tolerance_px: 1,
      });
      const text = res.content[0].text as string;
      const out = JSON.parse(text);

      // sanity: the scenario actually carries the banner (dominant_blocker on 3 narrow pairs) — otherwise the test
      // proves nothing about the serialize/effPreflight seam.
      expect(out.verification.dominant_blocker).toEqual({ kind: 'viewport', pairs: 3, window: 1429, frame: 1920 });
      expect(out.preflight).toContain('WINDOW WIDTH: 3 of 3');

      // The DELIVERED text must fit the budget — this is what the size-guard promises the caller.
      // The mutant ("serialize → bare preflight") breaks EXACTLY this assert: the under-count gives kept=3
      // (5760 bytes) > TIGHT_BUDGET(5600) — a delivery overflow, not merely a different kept count.
      expect(text.length).toBeLessThanOrEqual(TIGHT_BUDGET);
      // kept/omitted must match the WITH-BANNER measurement (verified live under compact: a bare
      // preflight in serialize gives kept=3/omitted=0 here — diverging from what actually fits).
      expect(out.pairs).toHaveLength(2);
      expect(out.omitted_pairs).toBe(1);
    });
  });

  describe('FETCH_DEPTH is the third depth mirror — depth-aware getNodesRaw mock', () => {
    // Mirrors real REST behaviour: at depth=3 the raw L3 node ("item") has NO children key at all
    // (Figma simply doesn't return grandchildren beyond the requested depth) — NOT an empty array,
    // genuinely absent, indistinguishable server-side from "item has no children". At depth>=4 the
    // real L4 TEXT node is present. The mock is depth-aware so this ONE test file exercises both
    // the pre-fix (FETCH_DEPTH=3) and post-fix (FETCH_DEPTH=4) worlds without editing the test —
    // it reads whatever depth the tool actually requests.
    const l4TextFull: RawSceneNode = {
      id: '1:5', name: 'value', type: 'TEXT', absoluteBoundingBox: { x: 20, y: 60, width: 80, height: 16 },
      characters: '99 ₽', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 12 },
    };
    const l3ItemFull: RawSceneNode = { id: '1:4', name: 'item', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [l4TextFull] };
    const l3ItemTruncated: RawSceneNode = { id: '1:4', name: 'item', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 } }; // no `children` key — real REST depth=3 cutoff
    const l2Row = (item: RawSceneNode): RawSceneNode => ({ id: '1:3', name: 'row', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [item] });
    const l1Wrap = (row: RawSceneNode): RawSceneNode => ({ id: '1:2', name: 'wrap', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [row] });
    const cardFor = (item: RawSceneNode): RawSceneNode => ({
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 90 },
      layoutMode: 'VERTICAL', children: [l1Wrap(l2Row(item))],
    });
    const cardDepth4 = cardFor(l3ItemFull);
    const cardDepth3 = cardFor(l3ItemTruncated);

    const domL4 = {
      schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
      rect: { x: 0, y: 0, w: 343, h: 90 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
      paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 90, scrollHeight: 90,
      scroll: { top: 0, left: 0 }, transformed: false,
      children: [
        { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [
          { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [
            { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [
              { kind: 'text', rect: { x: 20, y: 60, w: 80, h: 16 }, text: '99 ₽', styles: { fontSize: 20 } },
            ] },
          ] },
        ] },
      ],
    };

    it('depth-aware mock proves the L4 font-size bug is measured once FETCH_DEPTH actually covers L4 — not silently dropped', async () => {
      const getNodesRaw = vi.fn(async (_file: string, _ids: string[], depth?: number) =>
        ({ nodes: { '1:1': { document: (depth ?? 0) >= 4 ? cardDepth4 : cardDepth3 } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: domL4, label: 'card' }] })).content[0].text);
      const fsRow = out.pairs[0].rows.find((r: any) => r.prop === 'font-size[wrap→"99 ₽"]');
      expect(fsRow).toMatchObject({ figma: 12, dom: 20, status: 'fail' });
    });
  });

  describe('max_depth (drill-down)', () => {
    it('fetch depth: default 5, max_depth:6 → 7 (=max_depth+1, symmetric with get_layout_spec)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const run = harness({ getNodesRaw });
      await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }] });
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 5);
      getNodesRaw.mockClear();
      await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], max_depth: 6 });
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 7);
    });

    it('footer depthLevels: default stays 4 levels (backward-compat); max_depth:6 → 6 levels', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
      const run = harness({ getNodesRaw });
      const outDefault = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }] })).content[0].text);
      expect(outDefault.report_markdown).toContain('typography checked to 4 nesting levels');
      const outDeep = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], max_depth: 6 })).content[0].text);
      expect(outDeep.report_markdown).toContain('typography checked to 6 nesting levels');
    });

    it('backoff-clamp: report footer names the EFFECTIVE (clamped) depth, not the raw requested depth', async () => {
      // Custom getFrameRaw (NOT withFrameRaw) simulating a backoff-clamp: requested max_depth is 8,
      // but the Figma side actually got hydrated/held at effectiveMaxDepth 4 — the footer (and the
      // depthLevels fed into verification's blocking-action logic) must name 4, not the raw 8, or it
      // overstates how deep typography was actually verified (soft false-green).
      const clampedApi = {
        getFrameRaw: async (_file: string, _ids: string[], _requestedMaxDepth: number) => ({
          raw: { nodes: { '1:1': { document: card } } }, heldDepth: 5, hydrated: true, effectiveMaxDepth: 4,
        }),
      } as unknown as FigmaApi;
      const { server, call } = makeFakeMcpServer();
      registerCompareNodeToDomTool(server, { buildApi: () => clampedApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 } as any);
      const run = (a: any): Promise<any> => call('compare_node_to_dom', a);

      const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], max_depth: 8 })).content[0].text);
      // NB: VerificationReceipt has no `depthLevels` field (it's an internal buildVerification input,
      // used only to pick the blocking-action for unchecked rows) — the effective depth is observable
      // here via the report footer, which is exactly what Fix 1 makes honest.
      expect(out.report_markdown).toContain('typography checked to 4 nesting levels');
      expect(out.report_markdown).not.toContain('to 8 nesting levels');
    });

    // B (symmetric fix): buildLayoutSpec for the FIGMA side must receive the SAME max_depth as the
    // DOM-side extractor capture — otherwise the Figma projection stays shallow (default depth 4)
    // even when the caller explicitly asked for a deeper drill-down, and collectFigTexts stops
    // BEFORE collectDomTexts: a childrenTruncated branch never actually gets "sverified deeper",
    // silently defeating the whole point of max_depth on this tool.
    describe('symmetric Figma+DOM depth — an L5 TEXT beyond the default cut', () => {
      const deepText: RawSceneNode = {
        id: '1:6', name: 'deep', type: 'TEXT', absoluteBoundingBox: { x: 20, y: 60, width: 80, height: 16 },
        characters: 'Deep sample', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 12 },
      };
      const midWrap: RawSceneNode = { id: '1:5', name: 'mid', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [deepText] };
      const itemWrap: RawSceneNode = { id: '1:4', name: 'item', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [midWrap] };
      const rowWrap: RawSceneNode = { id: '1:3', name: 'row', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [itemWrap] };
      const l1Wrap: RawSceneNode = { id: '1:2', name: 'wrap', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 56, width: 311, height: 24 }, children: [rowWrap] };
      const deepCard: RawSceneNode = {
        id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 90 },
        layoutMode: 'VERTICAL', children: [l1Wrap],
      };
      const domDeep = {
        schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
        rect: { x: 0, y: 0, w: 343, h: 90 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
        paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 90, scrollHeight: 90,
        scroll: { top: 0, left: 0 }, transformed: false,
        children: [
          { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [ // wrap
            { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [ // row
              { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [ // item
                { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 311, h: 24 }, children: [ // mid
                  { kind: 'text', rect: { x: 20, y: 60, w: 80, h: 16 }, text: 'Deep sample', styles: { fontFamily: 'Inter', fontWeight: 400, fontSize: 12 } },
                ] },
              ] },
            ] },
          ] },
        ],
      };

      it('default (no max_depth): L5 TEXT is beyond the projection cut — honest skip, no font-size row for it', async () => {
        const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: deepCard } } }));
        const run = harness({ getNodesRaw });
        const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: domDeep, label: 'card' }] })).content[0].text);
        const rows = out.pairs[0].rows;
        expect(rows.find((r: any) => typeof r.prop === 'string' && r.prop.startsWith('font-size[wrap'))).toBeUndefined();
        expect(rows.find((r: any) => r.prop === 'typography[wrap]' && r.status === 'unchecked')).toBeDefined();
      });

      it('max_depth:6: Figma projection is threaded deep enough to reach the L5 TEXT — real font-size row appears', async () => {
        const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: deepCard } } }));
        const run = harness({ getNodesRaw });
        const out = JSON.parse((await run({
          file: 'abc', pairs: [{ node_id: '1:1', dom: domDeep, label: 'card' }], max_depth: 6,
        })).content[0].text);
        const rows = out.pairs[0].rows;
        const fsRow = rows.find((r: any) => typeof r.prop === 'string' && r.prop.includes('font-size') && r.prop.includes('Deep sample'));
        expect(fsRow).toMatchObject({ figma: 12, dom: 12, status: 'pass' });
        expect(rows.find((r: any) => r.prop === 'typography[wrap]')).toBeUndefined();
      });
    });

    // LAST unlocked mirror: the compare→diffPair `maxDepth` forward drives descentFor's
    // auto-descend TEXT-DFS cap (15 @ depth≤4, 30 @ 5-8). Dropping that one forward stays green
    // across the ENTIRE suite (only 3 of 4 compare forwards were incidentally covered) — the exact
    // silent-desync depth-mirrors.test exists to prevent. This locks it: >15 nested TEXT under one
    // child, indices 16-20 carrying a font-size mismatch, reachable by projection at BOTH depths so
    // the ONLY differentiator is the descent cap. Depth 6 (descent 30) scans them → deep mismatch
    // surfaces as fail; drop the forward → descentFor(4)=15 → those TEXT go unscanned → fail vanishes.
    describe('descent-cap forward — deep TEXT mismatch (>15) surfaces only at max_depth 5-8', () => {
      const figText = (n: number): RawSceneNode => ({
        id: `1:${100 + n}`, name: `txt${n}`, type: 'TEXT',
        absoluteBoundingBox: { x: 20, y: 8 + n * 16, width: 200, height: 14 },
        characters: `Item ${n}`, style: { fontFamily: 'Inter', fontWeight: 400, fontSize: n <= 15 ? 12 : 16 },
      });
      const domText = (n: number) => ({
        kind: 'text' as const, rect: { x: 20, y: 8 + n * 16, w: 200, h: 14 },
        text: `Item ${n}`, styles: { fontFamily: 'Inter', fontWeight: 400, fontSize: 12 },
      });
      const nums = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
      const subWrap: RawSceneNode = {
        id: '1:60', name: 'sub', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 170, width: 311, height: 170 },
        layoutMode: 'VERTICAL', children: nums.filter((n) => n > 10).map(figText),
      };
      const listWrap: RawSceneNode = {
        id: '1:2', name: 'list', type: 'FRAME', absoluteBoundingBox: { x: 16, y: 8, width: 311, height: 380 },
        layoutMode: 'VERTICAL', children: [...nums.filter((n) => n <= 10).map(figText), subWrap],
      };
      const wideCard: RawSceneNode = {
        id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 343, height: 400 },
        layoutMode: 'VERTICAL', children: [listWrap],
      };
      const domSub = { kind: 'element' as const, tag: 'div', rect: { x: 16, y: 170, w: 311, h: 170 }, children: nums.filter((n) => n > 10).map(domText) };
      const domList = { kind: 'element' as const, tag: 'div', rect: { x: 16, y: 8, w: 311, h: 380 }, children: [...nums.filter((n) => n <= 10).map(domText), domSub] };
      const wideDom = {
        schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
        rect: { x: 0, y: 0, w: 343, h: 400 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
        paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 400, scrollHeight: 400,
        scroll: { top: 0, left: 0 }, transformed: false,
        children: [domList],
      };
      const deepFail = (rows: any[]) => rows.some((r: any) => typeof r.prop === 'string' && r.prop.includes('font-size')
        && /Item (16|17|18|19|20)/.test(r.prop) && r.status === 'fail');
      const truncated = (rows: any[]) => rows.find((r: any) => typeof r.prop === 'string' && r.prop.startsWith('typography_descent'));

      it('max_depth:6 (descent 30): TEXT beyond the 15-cap are scanned → deep font-size mismatch surfaces as fail, no truncation', async () => {
        const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: wideCard } } }));
        const run = harness({ getNodesRaw });
        const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: wideDom, label: 'card' }], max_depth: 6 })).content[0].text);
        const rows = out.pairs[0].rows;
        expect(deepFail(rows)).toBe(true); // ← drops to false if the diffPair maxDepth forward regresses
        expect(truncated(rows)).toBeUndefined();
      });

      it('default (descent 15, backward-compat): the same TEXT are cut at the cap → deep mismatch NOT scanned, honest typography_descent instead', async () => {
        const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: wideCard } } }));
        const run = harness({ getNodesRaw });
        const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: wideDom, label: 'card' }] })).content[0].text);
        const rows = out.pairs[0].rows;
        expect(deepFail(rows)).toBe(false);
        expect(truncated(rows)).toBeDefined();
      });
    });
  });

  // The 3-tier source of frame coverage enumeration over the frame hydration
  // store. Tier 1 (reqDepth=8 → reuse the main fetch) / tier 2 (main-spec untruncated →
  // enumeration already complete) are covered above; here — tier 3 (deep best-effort getFrameRaw) + its
  // rate_limited/fallback edges + isolation of the pair path (branch cap) from the coverage projection (ENUM_CAPS).
  describe('coverage enumeration (M1): the 3-tier deep source', () => {
    // A chain deeper than effDepth (4 by default): D1→D2→...→D6 under the frame root — at maxDepth=4
    // the projection is truncated at D4 with truncationCause 'depth' (the raw REALLY has deeper children — the peek
    // FETCH=projection+1 honestly sees it), anyTruncatedSpec(mainSpec) === true → triggers tier 3.
    const deepFrame = (frameId: string, levels: number): RawSceneNode => {
      const mk = (id: string, kids?: RawSceneNode[]): RawSceneNode =>
        ({ id, name: id, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 8 }, ...(kids ? { children: kids } : {}) });
      let cur = mk(`D${levels}`);
      for (let i = levels - 1; i >= 1; i -= 1) cur = mk(`D${i}`, [cur]);
      return { id: frameId, name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 }, layoutMode: 'VERTICAL', children: [cur] };
    };
    const deep6 = deepFrame('9:1', 6);
    // A separate 10-level fixture for the tier-1 mutation lock below. deep6 (6
    // levels) at the maxDepth=8 projection fits ENTIRELY (isn't truncated) — anyTruncatedSpec(mainSpec)
    // with it is already false by itself, so the test couldn't distinguish "the tier-1 gate (reqDepth<8) blocked the second
    // fetch" from "tier 2 (anyTruncatedSpec) found nothing itself" (a hollow mutation lock). deep10 (10
    // levels) is truncated even at depth 8 → anyTruncatedSpec(mainSpec) is true regardless of reqDepth,
    // so the ONLY thing that can prevent the second fetch is exactly the reqDepth<8 gate.
    const deep10 = deepFrame('9:1', 10);

    it('deep frame + reqDepth<8 → second fetch getFrameRaw([frameId], 8): enumeration_source deep, depth 8', async () => {
      const getFrameRaw = vi.fn(async (_file: string, ids: string[], requestedMaxDepth: number) => {
        const nodes: Record<string, { document: RawSceneNode }> = {};
        if (ids.includes('1:1')) nodes['1:1'] = { document: card };
        if (ids.includes('9:1')) nodes['9:1'] = { document: deep6 };
        return { raw: { nodes }, heldDepth: requestedMaxDepth + 1, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
      });
      const run = harness({ getFrameRaw } as unknown as Partial<FigmaApi>);
      const res = await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], frame_node_id: '9:1' });

      expect(getFrameRaw).toHaveBeenCalledTimes(2);
      expect(getFrameRaw).toHaveBeenNthCalledWith(1, 'abc', ['1:1', '9:1'], 4);
      expect(getFrameRaw).toHaveBeenNthCalledWith(2, 'abc', ['9:1'], 8);
      const out = JSON.parse(res.content[0].text);
      expect(out.verification.frame_coverage.enumeration_source).toBe('deep');
      expect(out.verification.frame_coverage.enumeration_depth).toBe(8);
    });

    it('reqDepth=8 → ONE fetch, source pair_fetch@8 (tier-1 mutation lock)', async () => {
      const getFrameRaw = vi.fn(async (_file: string, ids: string[], requestedMaxDepth: number) => {
        const nodes: Record<string, { document: RawSceneNode }> = {};
        if (ids.includes('1:1')) nodes['1:1'] = { document: card };
        if (ids.includes('9:1')) nodes['9:1'] = { document: deep10 };
        return { raw: { nodes }, heldDepth: requestedMaxDepth + 1, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
      });
      const run = harness({ getFrameRaw } as unknown as Partial<FigmaApi>);
      const res = await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], frame_node_id: '9:1', max_depth: 8 });

      expect(getFrameRaw).toHaveBeenCalledTimes(1);
      const out = JSON.parse(res.content[0].text);
      expect(out.verification.frame_coverage.enumeration_source).toBe('pair_fetch');
      expect(out.verification.frame_coverage.enumeration_depth).toBe(8);
      // deep10 (10 levels) is truncated at the depth=8 projection → the honest truncation is VISIBLE in the receipt (this
      // is expected and deliberate — the fixture was chosen deeper than 8 specifically for the mutation lock above). BUT
      // the raise_max_depth advice is NOT valid here: source pair_fetch@depth=8 is already the cap (`max_depth`
      // hits the schema maximum 8), there's nowhere higher to go → a caveat WITHOUT blocking (rule A1,
      // the verification.ts branch enumMeta.depth>=8, locked separately in the verification tests).
      expect(out.verification.frame_coverage.enumeration_truncated).toBe(true);
      expect(out.verification.blocking.some((b: { action: string }) => b.action === 'raise_max_depth')).toBe(false);
    });

    // Mutation lock: reqDepth=8 (the caller is already at the schema
    // ceiling), BUT the main fetch falls under a too_large backoff-clamp down to effectiveMaxDepth 6. With
    // the old gate `reqDepth < 8` (8 < 8 === false) tier 3 NEVER entered — frameSpec stayed the
    // clamped mainSpec, enumMeta stood at pair_fetch@6(truncated), and the verification.ts advice matrix
    // emitted raise_max_depth — unexecutable (max_depth is ALREADY at the ceiling 8), a dead-end fix→verify loop.
    // The new gate reads effDepth (6 < 8 === true) → tier 3 fires: the second fetch requests
    // ONLY [frameId] (without the accompanying pair ids) at depth 8 and — in this fixture — lands entirely
    // (deep6 fits in 8), giving an honest FULL deep source instead of the clamped pair_fetch dead-end.
    it('backoff-clamp@8 (effDepth<8 despite reqDepth=8): the effDepth gate avoids a dead-end raise_max_depth — the second fetch [frameId]@8 happened, source deep', async () => {
      const getFrameRaw = vi.fn(async (_file: string, ids: string[], requestedMaxDepth: number) => {
        if (ids.length > 1) {
          // the main combined fetch (pairs + frame) — reqDepth=8, but too_large clamps
          // effectiveMaxDepth to 6; the raw (deep10, 10 levels) at the maxDepth=6 projection is truncated
          // (anyTruncatedSpec(mainSpec) === true) — this is exactly the trigger for entering tier 3.
          expect(requestedMaxDepth).toBe(8);
          const nodes: Record<string, { document: RawSceneNode }> = { '1:1': { document: card }, '9:1': { document: deep10 } };
          return { raw: { nodes }, heldDepth: 7, hydrated: true, effectiveMaxDepth: 6 };
        }
        // the second fetch — ONLY [frameId], depth 8 (tier-3 hardcode). The smaller request (without pairs)
        // lands entirely — deep6 (6 levels) fits in maxDepth 8 without truncation.
        expect(ids).toEqual(['9:1']);
        expect(requestedMaxDepth).toBe(8);
        const nodes: Record<string, { document: RawSceneNode }> = { '9:1': { document: deep6 } };
        return { raw: { nodes }, heldDepth: 9, hydrated: false, effectiveMaxDepth: 8 };
      });
      const run = harness({ getFrameRaw } as unknown as Partial<FigmaApi>);
      const res = await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], frame_node_id: '9:1', max_depth: 8 });

      // The old gate `reqDepth < 8` would be false here → exactly 1 call, not 2. This is the main mutation signal.
      expect(getFrameRaw).toHaveBeenCalledTimes(2);
      expect(getFrameRaw).toHaveBeenNthCalledWith(1, 'abc', ['1:1', '9:1'], 8);
      expect(getFrameRaw).toHaveBeenNthCalledWith(2, 'abc', ['9:1'], 8);
      const out = JSON.parse(res.content[0].text);
      expect(out.verification.frame_coverage.enumeration_source).toBe('deep');
      expect(out.verification.blocking.some((b: { action: string }) => b.action === 'raise_max_depth')).toBe(false);
    });

    it('rate_limited from the cov-fetch → the tool returns isError [rate_limited] (429 backoff is NOT swallowed)', async () => {
      let call = 0;
      const getFrameRaw = vi.fn(async (_file: string, ids: string[], requestedMaxDepth: number) => {
        call += 1;
        if (call === 1) {
          const nodes: Record<string, { document: RawSceneNode }> = { '1:1': { document: card }, '9:1': { document: deep6 } };
          return { raw: { nodes }, heldDepth: requestedMaxDepth + 1, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
        }
        throw new FigmaApiError('rate_limited', 429, 'slow down', 5);
      });
      const run = harness({ getFrameRaw } as unknown as Partial<FigmaApi>);
      const res = await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], frame_node_id: '9:1' });

      expect(getFrameRaw).toHaveBeenCalledTimes(2);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/rate_limited/i);
    });

    it('cov-fetch network failure → fallback: source pair_fetch, behavior == pre-M1', async () => {
      let call = 0;
      const getFrameRaw = vi.fn(async (_file: string, ids: string[], requestedMaxDepth: number) => {
        call += 1;
        if (call === 1) {
          const nodes: Record<string, { document: RawSceneNode }> = { '1:1': { document: card }, '9:1': { document: deep6 } };
          return { raw: { nodes }, heldDepth: requestedMaxDepth + 1, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
        }
        throw new Error('ECONNRESET');
      });
      const run = harness({ getFrameRaw } as unknown as Partial<FigmaApi>);
      const res = await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], frame_node_id: '9:1' });

      expect(res.isError).toBeFalsy();
      expect(getFrameRaw).toHaveBeenCalledTimes(2);
      const out = JSON.parse(res.content[0].text);
      expect(out.verification.frame_coverage.enumeration_source).toBe('pair_fetch');
      expect(out.verification.frame_coverage.enumeration_depth).toBe(4);
    });

    it('cov response without the frame node (nodes:{}) → fallback, compare does NOT crash', async () => {
      let call = 0;
      const getFrameRaw = vi.fn(async (_file: string, ids: string[], requestedMaxDepth: number) => {
        call += 1;
        if (call === 1) {
          const nodes: Record<string, { document: RawSceneNode }> = { '1:1': { document: card }, '9:1': { document: deep6 } };
          return { raw: { nodes }, heldDepth: requestedMaxDepth + 1, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
        }
        return { raw: { nodes: {} }, heldDepth: 9, hydrated: false, effectiveMaxDepth: 8 };
      });
      const { logger: recLogger, logs } = recordingLogger();
      const run = harness({ getFrameRaw } as unknown as Partial<FigmaApi>, undefined, { logger: recLogger });
      const res = await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: okDom }], frame_node_id: '9:1' });

      expect(res.isError).toBeFalsy();
      expect(getFrameRaw).toHaveBeenCalledTimes(2);
      const out = JSON.parse(res.content[0].text);
      expect(out.verification.frame_coverage.enumeration_source).toBe('pair_fetch');
      expect(out.verification.frame_coverage.enumeration_depth).toBe(4);
      // nodes:{} is a CLEAN miss (frame simply absent from the response), not a thrown error — the
      // `?.` guard at tool.ts:244 (`covRes.raw.nodes[frameId]?.document`) must fall back SILENTLY,
      // with no 'compare.coverage_fetch_unavailable' log. A mutation that drops the `?.` and reads
      // `.document` directly on `undefined` throws a TypeError, which the catch below DOES log —
      // observationally identical fallback output, but the log line tells them apart.
      expect(logs.some((l) => l.msg === 'compare.coverage_fetch_unavailable')).toBe(false);
    });

    // An isolation lock THROUGH THE TOOL (not proxying the projector directly). The pair path
    // (tool.ts :209, buildLayoutSpec for a SPECIFIC pair) must stay on the branch cap
    // (maxSpecChildren=30) — the coverage projections (ENUM_CAPS=200) must NOT leak into the pair path.
    // The mutation "the pair path receives caps: ENUM_CAPS" silences this row (31 < 200 → no truncation).
    it('pair-path breadth cap (branch=30) isolated from coverage ENUM_CAPS: 31 worthy children in a pair → children_truncated row', async () => {
      const manyChildren = (n: number): RawSceneNode[] => Array.from({ length: n }, (_, i) => ({
        id: `1:${200 + i}`, name: `c${i}`, type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: i * 10, width: 100, height: 8 },
      }));
      const bigNode: RawSceneNode = {
        id: '1:1', name: 'big', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 320 },
        layoutMode: 'VERTICAL', children: manyChildren(31),
      };
      const domManyChildren = (n: number) => Array.from({ length: n }, (_, i) => ({
        kind: 'element' as const, tag: 'div', rect: { x: 0, y: i * 10, w: 100, h: 8 },
      }));
      const bigDom = {
        schema: 6, status: 'ok' as const, selector: '.big', innerWidth: 375,
        rect: { x: 0, y: 0, w: 400, h: 320 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
        scroll: { top: 0, left: 0 }, transformed: false,
        children: domManyChildren(30), // the same count as the truncated 30 figma children — avoids the structure_mismatch salvage branch
      };
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: bigNode } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: bigDom }] })).content[0].text);

      const row = out.pairs[0].rows.find((r: any) => r.prop === 'children_truncated');
      expect(row).toBeDefined();
    });
  });
});

describe('compare_node_to_dom hydration receipt (Phase 1, Figma-side only)', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
  const chain = (levels: number): any => {
    const mk = (id: string, kids?: any[]): any =>
      ({ id, name: id, type: 'FRAME', absoluteBoundingBox: box(0, 0, 40, 8), ...(kids ? { children: kids } : {}) });
    let cur = mk('L' + levels);
    for (let i = levels - 1; i >= 1; i -= 1) cur = mk('L' + i, [cur]);
    return { id: '1:1', name: 'card', type: 'FRAME', layoutMode: 'VERTICAL', absoluteBoundingBox: box(0, 0, 100, 100), children: [cur] };
  };
  const dom = { schema: 6, status: 'ok' as const, selector: '.card', innerWidth: 375,
    rect: { x: 0, y: 0, w: 100, h: 100 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 }, transformed: false, children: [] as unknown[] };

  it('emits a per-pair hydration receipt keyed by node_id', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: chain(6) } } }));
    // self-contained harness (McpServer, registerCompareNodeToDomTool, logger, FigmaApi already
    // imported at the top of this test file):
    const { server, call } = makeFakeMcpServer();
    registerCompareNodeToDomTool(server, { buildApi: () => withFrameRaw({ getNodesRaw }) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 } as any);
    const run = (a: any): Promise<any> => call('compare_node_to_dom', a);
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom }], max_depth: 4 })).content[0].text);
    expect(Array.isArray(out.hydration)).toBe(true);
    expect(out.hydration.find((h: any) => h.node_id === '1:1')).toBeTruthy();
  });
});

// ── the tool's spacing_audit wiring — captures from the pair loop → auditContainer ──
describe('compare_node_to_dom spacing_audit wiring', () => {
  // We reuse `card` (1:1 layoutMode VERTICAL itemSpacing 20, children 1:2 title y:12 h:24, 1:3 list
  // y:56 h:40 → figma gap = 56-(12+24) = 20). The pairs are PLACED on children 1:2/1:3, NOT on 1:1 — the container
  // itself has no pair → touchedTop=2 + axis(col from VERTICAL) + !paired(1:1) → frame-root partial (the corresponding
  // scenario in verification.ts) with frame_node_id:'1:1'. innerWidth:343 == frameWidth (card width) —
  // we avoid the viewport-mismatch reason (geometry:unchecked) 24px/5% tolerance trap.
  const titleDom = {
    schema: 6, status: 'ok' as const, selector: '.title', innerWidth: 343,
    rect: { x: 16, y: 12, w: 200, h: 24 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 }, transformed: false, children: [],
  };
  const listDom = {
    schema: 6, status: 'ok' as const, selector: '.list', innerWidth: 343,
    rect: { x: 16, y: 56, w: 311, h: 40 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    paddings: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 }, transformed: false, children: [],
  };
  const getNodesRaw = vi.fn(async () => ({
    nodes: { '1:1': { document: card }, '1:2': { document: card.children![0] }, '1:3': { document: card.children![1] } },
  }));

  it('two dom_ref pairs of the SAME ref + frame_node_id on an unpaired container → spacing_audit in the output (pass), unchecked_spacing suppressed', async () => {
    const resolve = vi.fn((_ref: string, selector: string) => {
      if (selector === '.title') return { ok: true as const, snapshot: titleDom };
      if (selector === '.list') return { ok: true as const, snapshot: listDom };
      return { ok: false as const, reason: 'unknown_selector' as const, selectors: ['.title', '.list'] };
    });
    const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];
    const run = harness({ getNodesRaw }, 40000, { snapshotStore });

    const out = JSON.parse((await run({
      file: 'abc',
      pairs: [
        { node_id: '1:2', dom_ref: { ref: 'batch1', selector: '.title' } },
        { node_id: '1:3', dom_ref: { ref: 'batch1', selector: '.list' } },
      ],
      frame_node_id: '1:1',
    })).content[0].text);

    expect(out.verification.frame_coverage.partial).toEqual(['1:1']);
    const entry = out.verification.spacing_audit?.find((e: any) => e.container_id === '1:1');
    expect(entry).toBeDefined();
    expect(entry.gaps[0]).toMatchObject({ status: 'pass', figma: 20, dom: 20, delta: 0 });
    expect(out.verification.blocking.some((b: any) => b.node_id === '1:1')).toBe(false); // suppressed
    expect(out.report_markdown).toContain('⚖ spacing-audit 1:1');
  });

  it('inline pairs (without dom_ref) → spacing_audit gap unchecked (ref unproven), unchecked_spacing on the container remains', async () => {
    const run = harness({ getNodesRaw });

    const out = JSON.parse((await run({
      file: 'abc',
      pairs: [
        { node_id: '1:2', dom: titleDom },
        { node_id: '1:3', dom: listDom },
      ],
      frame_node_id: '1:1',
    })).content[0].text);

    const entry = out.verification.spacing_audit?.find((e: any) => e.container_id === '1:1');
    expect(entry).toBeDefined();
    expect(entry.gaps[0].status).toBe('unchecked');
    expect(entry.gaps[0].dom).toBeUndefined();
    const item = out.verification.blocking.find((b: any) => b.node_id === '1:1');
    expect(item).toMatchObject({ kind: 'unchecked_spacing' });
  });
});

// Variables cap: short variables-fetch budget (MT-only, gated on graphOrSnapshotAvailable) + a
// single compare.done observability log at the end of the handler. Part of the giant-file
// latency-polish behavior for large-file fetches.
describe('compare_node_to_dom variables cap 20s (MT-only) + compare.done', () => {
  // These two pin WHICH api instance the variables fetch is routed through. The index is only
  // fetched when some pair binds a colour to a variable, so the fixture has to bind one - with the
  // plain `card` the fetch never happens and both tests would assert about a call nobody makes.
  const cardBoundCap: RawSceneNode = {
    id: '1:1', name: 'Card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
    fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 1, a: 1 },
      boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:cap0/1:1' } } }],
  };
  // Note (minor): the lock is NOT positional — buildApi TAGS instances (a capped/uncapped ROUTER
  // keyed on the capMs argument) and binds each consumer to its own instance, instead of asserting
  // "the Nth buildApi call got capMs=20000" (positional, brittle to call-order refactors).
  it('variables cap: graph wired → variables through the buildApi(token, 20000) instance; main fetch — through the UNcapped one', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundCap } } }));
    const uncappedGetVars = vi.fn(async () => emptyVars);
    const cappedGetVars = vi.fn(async () => emptyVars);
    const uncapped = withFrameRaw({ getNodesRaw, getVariablesLocal: uncappedGetVars }) as FigmaApi;
    const capped = { ...uncapped, getVariablesLocal: cappedGetVars } as FigmaApi;
    const buildApi = vi.fn((_t: string, capMs?: number) => (capMs === 20000 ? capped : uncapped));
    const run = harness({}, 40000, { buildApi, variableGraph: { resolve: () => undefined } });
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundCap) }] });
    expect(res.isError).toBeFalsy();
    expect(buildApi.mock.calls.filter((c: unknown[]) => c[1] === 20000).length).toBe(1);
    expect(cappedGetVars).toHaveBeenCalledTimes(1);     // variables went through the capped instance
    expect(uncappedGetVars).toHaveBeenCalledTimes(0);   // main fetches — through the uncapped one, variables doesn't touch it
  });

  it('variables cap: no graph/snapshot → variables through the main api WITHOUT a cap (single-tenant untouched)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundCap } } }));
    const getVariablesLocal = vi.fn(async () => emptyVars);
    const buildApi = vi.fn(() => withFrameRaw({ getNodesRaw, getVariablesLocal }) as FigmaApi);
    const run = harness({}, 40000, { buildApi }); // extra WITHOUT variableGraph/variableSnapshot
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardBoundCap) }] });
    expect(res.isError).toBeFalsy();
    expect(buildApi.mock.calls.some((c: unknown[]) => c[1] === 20000)).toBe(false); // NOT a single capped call
    expect(getVariablesLocal).toHaveBeenCalledTimes(1); // variables still went — through the single (uncapped) instance
  });

  describe('e2e: capped variables timeout → variables_unavailable → graph fallback alive', () => {
    const K = (h: string) => h.padEnd(40, '0');
    const LIB_KEY = K('de17f3'); // 40-hex published key, distinct from 'f04'/'f05' (fixture isolation)
    const HEX = '#224466';
    const ALIAS_ID = 'VariableID:' + LIB_KEY + '/9:9';
    const cardExtCapped: RawSceneNode = {
      id: '1:1', name: 'Card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      // ANTI-VACUUM: the raw paint literal is a THIRD distinct value (≠ HEX, ≠ default) — a
      // pre-fallback run (figma = raw fillHex) can never accidentally match the assert below.
      fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: ALIAS_ID } } }],
    };

    it('variables cap e2e: a capped variables timeout → variables_unavailable → the graph fallback resolves the external bound color', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardExtCapped } } }));
      const getDocumentRaw = vi.fn(async () => docWithNode(cardExtCapped));
      // Note (minor): the capped instance's getVariablesLocal throws — mirrors prod exactly what
      // caching-figma-api.ts's cap-aware WRITE guard caches under capMs=20000.
      const cappedGetVars = vi.fn(async () => {
        throw new FigmaApiError('network', 0, 'Figma request timed out after 20000ms');
      });
      const uncapped = withFrameRaw({ getNodesRaw, getDocumentRaw }) as FigmaApi;
      const capped = { ...uncapped, getVariablesLocal: cappedGetVars } as FigmaApi;
      const buildApi = vi.fn((_t: string, capMs?: number) => (capMs === 20000 ? capped : uncapped));
      const { logger: recLogger, logs } = recordingLogger();
      const run = harness({}, 40000, {
        buildApi, logger: recLogger,
        variableGraph: {
          resolve: (k: string) => (k === LIB_KEY ? { value: HEX } : undefined),
          resolveInMode: (k: string) => (k === LIB_KEY
            ? { token: 'brand/t3cap', value: HEX, mode_dependent: false, mode_source: 'default', pinned_axis_used: false, unconfirmed_default_used: false }
            : undefined),
        },
      });
      const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(cardExtCapped) }] });
      expect(res.isError).toBeFalsy();
      expect(logs.some((l) => l.msg === 'compare.variables_unavailable')).toBe(true);
      const colorRow = JSON.parse(res.content[0].text).pairs[0].rows.find((r: any) => r.prop === 'fill');
      expect(colorRow.figma).toBe(HEX);           // the external-bound color row is resolved through the graph
      expect(colorRow.figma).not.toBe('#ff0000');  // NOT the raw paint literal (anti-vacuum)
    });
  });

  it('telemetry: compare.done with total_ms and pairs is emitted at the end of the call', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
    const getVariablesLocal = vi.fn(async () => emptyVars);
    const { logger: recLogger, logs } = recordingLogger();
    const run = harness({ getNodesRaw, getVariablesLocal }, 40000, { logger: recLogger });
    await run({ file: FILE, pairs: [{ node_id: '1:1', dom: domFor(card) }] });
    expect(logs.some((l) => l.msg === 'compare.done'
      && typeof (l.obj as { total_ms?: unknown }).total_ms === 'number'
      && (l.obj as { pairs?: unknown }).pairs === 1)).toBe(true);
  });
});

// style-anchor: an integration lock THROUGH THE HANDLER — not only the unit diffPair
// (layout-spec-diff.test.ts), but the full path (schema gate :338 → buildLayoutSpec → diffPair →
// serialize). The live case proves style_anchor actually surfaces from a real compare call;
// the v4 handler test proves the :338 hard-reject is NOT weakened by the bump (belt-and-suspenders to styleAnchor's
// own `d.schema < 5` gate — v4 never even reaches diffPair).
describe('style-anchor v5 through the handler (integration lock) + v4 hard-reject held (:338)', () => {
  it('style-anchor v5 through the handler: the wrapper is transparent → radius/component from the child, style_anchor row', async () => {
    const banner: RawSceneNode = {
      id: '1:1', name: 'banner_recs', type: 'INSTANCE',
      absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 148 }, cornerRadius: 24, componentId: 'c1',
    };
    // componentId + the components meta are added to the fixture: without
    // them spec.component isn't projected at all (projector.ts :495 `if (raw.componentId)`) — the scenario's 'component'
    // pass-assert wouldn't get a row. Meta without componentSetId (no set) → buildSetNames
    // makes NOT A SINGLE REST call (resolveSetNames withSet.length===0), so a harness without getComponent is ok.
    const getNodesRaw = vi.fn(async () => ({
      nodes: { '1:1': { document: banner, components: { c1: { key: 'k1', name: 'banner_recs' } } } },
    }));
    const getVariablesLocal = vi.fn(async () => emptyVars);
    const run = harness({ getNodesRaw, getVariablesLocal });
    // tolerance_px explicit (a detail from the file's existing tests): the harness's fake McpServer stub
    // doesn't run the SDK zod defaults (server.tool(...) here just intercepts the handler) — without an explicit
    // value args.tolerance_px===undefined → numRow's `delta <= tol` compares against undefined →
    // always false → an artifactual fail even at 0-delta. The only deviation from the base fixture.
    const res = await run({ file: FILE, tolerance_px: 1, pairs: [{ node_id: '1:1', dom: {
      schema: 6, innerWidth: 1920, rect: { x: 0, y: 0, w: 1280, h: 148 },
      borders: { top: 0, right: 0, bottom: 0, left: 0 }, scroll: { top: 0, left: 0 },
      children: [{ kind: 'element', tag: 'div', classList: ['preference-questionnaire-banner'],
        rect: { x: 0, y: 0, w: 1280, h: 148 }, styles: { borderRadius: 24 }, children: [] }],
    } }] });
    const rows = JSON.parse(res.content[0].text).pairs[0].rows;
    expect(rows.find((r: any) => r.prop === 'corner-radius')?.status).toBe('pass');
    expect(rows.find((r: any) => r.prop === 'style_anchor')?.dom).toContain('preference-questionnaire-banner');
    expect(rows.find((r: any) => r.prop === 'component')?.status).toBe('pass'); // 'banner' token
  });

  it('a v4 snapshot through the handler → a single snapshot_schema row with "re-capture", no metrics (:338 not weakened)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: card } } }));
    const getVariablesLocal = vi.fn(async () => emptyVars);
    const run = harness({ getNodesRaw, getVariablesLocal });
    const res = await run({ file: FILE, pairs: [{ node_id: '1:1', dom: { ...domFor(card), schema: 4 } }] });
    const rows = JSON.parse(res.content[0].text).pairs[0].rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].prop).toBe('snapshot_schema');
  });
});

// The variables index is fetched only when some pair binds a colour to a variable. That is a latency
// change on the stdio path - where no fallback exists, the fetch keeps the full request budget, and a
// large file spends up to 90s on an enrichment nothing in the call consumes. It is also a change that
// CAN make a row read differently if the gate ever under-triggers, so the three assertions below run
// in this order on purpose: the skip case alone quantifies over the situation where nothing could
// change, and would pass just as happily if the gate had broken the other two.
describe('the variables index is fetched on demand, not on principle', () => {
  const divergentDom = { ...domFor(cardBoundFill), styles: { backgroundColor: '#ff0000' } };

  it('1. a bound colour still fetches, still resolves, and still calls a wrong colour wrong', async () => {
    const getVariablesLocal = vi.fn(async () => varsBoundFill);
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } })), getVariablesLocal });
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: divergentDom }] })).content[0].text);
    expect(getVariablesLocal).toHaveBeenCalledTimes(1);
    expect(out.pairs[0].rows.find((r: any) => r.prop === 'fill')?.status).toBe('fail');
    expect(out.summary.fail).toBeGreaterThan(0);
  });

  it('2. and when that fetch times out the call is degraded, NOT complete', async () => {
    const getVariablesLocal = vi.fn(async () => { throw new FigmaApiError('network', 0, 'Figma request timed out after 90000ms'); });
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: cardBoundFill } } })), getVariablesLocal });
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: divergentDom }] })).content[0].text);
    expect(getVariablesLocal).toHaveBeenCalledTimes(1);
    expect(out.verification.complete).toBe(false);
    expect(out.degraded_stages?.[0]?.stage).toBe('variables');
  });

  it('3. only THEN: a pair that binds no colour does not pay for the index at all', async () => {
    const getVariablesLocal = vi.fn(async () => emptyVars);
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: card } } })), getVariablesLocal });
    const out = JSON.parse((await run({ file: 'abc', pairs: [{ node_id: '1:1', dom: domFor(card) }] })).content[0].text);
    expect(getVariablesLocal).not.toHaveBeenCalled();
    expect(out.degraded_stages).toBeUndefined();  // nothing degraded - the payload is the successful shape
    expect(out.pairs[0].rows.length).toBeGreaterThan(0);
  });
});
