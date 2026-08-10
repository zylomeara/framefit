// The placeholder-frame signal (feedback item 17): a consumer compared a rendered page against
// a SKELETON design frame and reported two size deltas as defects - both false, the placeholder
// frame's sizes are conditional. Panel-locked design (77 findings): detection is ONE walk over
// the RAW node trees at the tool layer (the projection is pruned by branch caps and drops
// out-of-flow nodes); the signal is FRAME-scoped when frame_node_id is given (the hazard is
// frame-wide - an ordinary DS button inside a skeleton frame is just as conditional) and
// pair-scoped with scope-honest wording otherwise; the verdict protection is NOT a gate: an
// advisory service row (COVERAGE_META) + a `caveat` on every extent FAIL row (travels into
// fix_plan's edits - the machine surface stops prescribing unqualified edits) + a
// verification.notes[] line that renders in BOTH complete branches. All-pass + detection stays
// complete:true WITH the visible note - skeleton-render-vs-skeleton-frame is a legitimate flow.
// Fixtures use INVENTED placeholder names only - no customer DS spelling.
import { describe, it, expect, vi } from 'vitest';
import { registerCompareNodeToDomTool, scanPlaceholders } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function harness(api: Partial<FigmaApi>) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 };
  registerCompareNodeToDomTool(server, deps);
  return (a: unknown): Promise<any> => call('compare_node_to_dom', a);
}

const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
const ghost = (id: string, name: string, over: Partial<RawSceneNode> = {}): RawSceneNode =>
  ({ id, name, type: 'INSTANCE', absoluteBoundingBox: box(16, 56, 100, 16), ...over } as RawSceneNode);

// The pair target: a card whose subtree carries one invented placeholder instance.
const cardWithGhost: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 343, 120),
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [
    { id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: box(16, 12, 200, 24) },
    ghost('1:3', 'SkeletonPill / Ghost'),
  ],
};
// A clean card - no placeholder anywhere.
const cardClean: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: box(0, 0, 343, 120),
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [
    { id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: box(16, 12, 200, 24) },
    { id: '1:3', name: 'list', type: 'FRAME', absoluteBoundingBox: box(16, 56, 311, 40) },
  ],
};
// The button repro: the FRAME carries a placeholder, the paired subtree does not.
const frameWithGhostOutside: RawSceneNode = {
  id: '9:1', name: 'desk', type: 'FRAME', absoluteBoundingBox: box(0, 0, 375, 812),
  children: [
    ghost('9:2', 'loaderSkeletonRow', { absoluteBoundingBox: box(0, 200, 375, 40) }),
    cardClean,
  ],
};
const matchingDom = {
  schema: 6, status: 'ok', selector: '.card', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  children: [
    { kind: 'element', tag: 'h2', rect: { x: 16, y: 12, w: 200, h: 24 } },
    { kind: 'element', tag: 'div', rect: { x: 16, y: 56, w: 100, h: 16 } },
  ],
};
const widerDom = { ...matchingDom, rect: { x: 0, y: 0, w: 360, h: 120 }, clientWidth: 360 };

describe('scanPlaceholders (the raw walk)', () => {
  it('an invented placeholder NAME is detected, any casing', () => {
    expect(scanPlaceholders(cardWithGhost).count).toBe(1);
    expect(scanPlaceholders(ghost('2:1', 'SKELETONBLOCK')).count).toBe(1);
  });
  it('a componentProperties KEY fires only on positive values (the live "no" must not)', () => {
    const withProp = (v: unknown): RawSceneNode =>
      ({ id: '3:1', name: 'tile', type: 'INSTANCE', absoluteBoundingBox: box(0, 0, 40, 40),
        componentProperties: { 'skeleton#12:0': { value: v } } } as never);
    expect(scanPlaceholders(withProp('yes')).count).toBe(1);
    expect(scanPlaceholders(withProp(true)).count).toBe(1);
    expect(scanPlaceholders(withProp('on')).count).toBe(1);
    expect(scanPlaceholders(withProp('no')).count).toBe(0);
    expect(scanPlaceholders(withProp(false)).count).toBe(0);
    expect(scanPlaceholders(withProp('off')).count).toBe(0);
  });
  it('counts aggregate across the subtree', () => {
    const three: RawSceneNode = { ...cardWithGhost,
      children: [...(cardWithGhost.children ?? []), ghost('1:4', 'skeleton-line'), ghost('1:5', 'GhostSkeletonDot')] };
    expect(scanPlaceholders(three).count).toBe(3);
  });
  it('invisible layers do not count (they do not render)', () => {
    const hidden: RawSceneNode = { ...cardWithGhost,
      children: [{ ...ghost('1:3', 'SkeletonPill / Ghost'), visible: false } as RawSceneNode] };
    expect(scanPlaceholders(hidden).count).toBe(0);
  });
  it('the absence lock is non-vacuous: the clean walk really visited the population', () => {
    const res = scanPlaceholders(cardClean);
    expect(res.count).toBe(0);
    expect(res.visited).toBeGreaterThanOrEqual(3);
  });
});

describe('the signal through the tool', () => {
  it('pair-scoped (no frame_node_id): the row fires with the count, all-pass stays complete:true WITH the note', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardWithGhost } } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'F', pairs: [{ node_id: '1:1', dom: matchingDom }] })).content[0].text);
    const row = out.pairs[0].rows.find((r: any) => r.prop === 'placeholder_frame');
    expect(row?.status).toBe('warn');
    expect(row?.figma).toMatch(/1 placeholder/);
    expect(row?.note).toMatch(/paired subtree/);
    expect(out.verification.complete).toBe(true);
    expect((out.verification.notes ?? []).join(' ')).toMatch(/placeholder/);
    expect(out.report_markdown).toMatch(/placeholder/);
  });
  it('frame-scoped: a placeholder OUTSIDE the paired subtree still marks the pair (the button repro)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: {
      '1:1': { document: cardClean }, '9:1': { document: frameWithGhostOutside } } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'F', frame_node_id: '9:1', pairs: [{ node_id: '1:1', dom: matchingDom }] })).content[0].text);
    const row = out.pairs[0].rows.find((r: any) => r.prop === 'placeholder_frame');
    expect(row?.status).toBe('warn');
    expect(row?.note).not.toMatch(/paired subtree/);
    expect((out.verification.notes ?? []).join(' ')).toMatch(/placeholder/);
  });
  it('an extent FAIL in a detected pair carries the caveat, and fix_plan copies it onto the edit', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardWithGhost } } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'F', pairs: [{ node_id: '1:1', dom: widerDom }] })).content[0].text);
    const fail = out.pairs[0].rows.find((r: any) => r.prop === 'size.w' && r.status === 'fail');
    expect(fail?.caveat).toMatch(/placeholder/);
    const edits = (out.pairs[0].fix_plan ?? []).flatMap((g: any) => g.edits ?? []);
    const sizeEdit = edits.find((e: any) => e.prop === 'size.w');
    expect(sizeEdit?.caveat).toMatch(/placeholder/);
  });
  it('a clean frame emits NO row and NO note', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardClean } } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'F', pairs: [{ node_id: '1:1', dom: matchingDom }] })).content[0].text);
    expect(out.pairs[0].rows.some((r: any) => r.prop === 'placeholder_frame')).toBe(false);
    expect((out.verification.notes ?? []).join(' ')).not.toMatch(/placeholder/);
  });
  it('the row is COVERAGE_META: coverage.measured is not polluted and the pair can be clean', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: cardWithGhost } } }));
    const run = harness({ getNodesRaw });
    const out = JSON.parse((await run({ file: 'F', pairs: [{ node_id: '1:1', dom: matchingDom }] })).content[0].text);
    expect(out.pairs[0].coverage.measured).not.toContain('placeholder_frame');
    expect(out.verification.pairs.clean).toBe(1);
  });
});
