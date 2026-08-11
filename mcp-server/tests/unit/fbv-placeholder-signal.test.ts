// fbv phase 2 of feedback item 17: find_breakpoint_variant surfaces skeleton-ness. The
// upstream root cause - the consumer landed on the SKELETON design frame because the width
// race resolved a skeleton-vs-loaded choice with no signal (insertion order breaks exact
// ties; a skeleton variant can also win OUTRIGHT). Panel-locked (45 findings, 12 blockers):
// the unit is the CANDIDATE (a COMPONENT_SET is ONE variants[] entry whose competitors are
// CONTENT - variant-level counting cannot tell them apart); the shared detector learns
// Figma's negative variant-name assignments ('Skeleton=False' must not fire); the scan is
// the #51 union convention over BOTH in-memory trees; NO absence claim anywhere (the
// CONTENT_FETCH_DEPTH blindness is pinned as a named ceiling); the carriers are
// match.placeholders + ONE presence-triggered leading note firing in all three returning
// branches; match itself is never re-ranked. Fixture names are INVENTED around the verbatim
// detector token.
import { describe, it, expect, vi } from 'vitest';
import { registerFindBreakpointVariantTool } from '../../src/adapters/driving/tools/find-breakpoint-variant-tool.js';
import { scanPlaceholders } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function harness(api: Partial<FigmaApi>) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => api as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 };
  registerFindBreakpointVariantTool(server, deps);
  return async (a: Record<string, unknown>): Promise<any> => {
    const res = await call('find_breakpoint_variant', a);
    return res.isError ? { isError: true, text: String(res.content[0]?.text ?? '') } : JSON.parse(String(res.content[0]?.text));
  };
}

const slice = (node: any, depth: number): any =>
  depth <= 0
    ? { ...node, children: undefined }
    : { ...node, children: (node.children ?? []).map((c: any) => slice(c, depth - 1)) };

function depthApi(documentRoot: any, opts: { contentFetchFails?: boolean } = {}) {
  const index: Record<string, any> = {};
  const walk = (n: any): void => { index[n.id] = n; (n.children ?? []).forEach(walk); };
  walk(documentRoot);
  const getDocumentRaw = vi.fn(async (_f: string, depth: number, _o?: unknown) => ({
    name: 'F', lastModified: 'X', version: '1', document: slice(documentRoot, depth),
  }));
  const getNodesRaw = vi.fn(async (_f: string, ids: string[], depth?: number) => {
    if (opts.contentFetchFails) throw new FigmaApiError('too_large', 413, 'too big');
    return { nodes: Object.fromEntries(ids.map((id) => [id, index[id] ? { document: slice(index[id], depth ?? 99) } : null])) };
  });
  return { getDocumentRaw, getNodesRaw };
}

const bb = (w: number, h = 900) => ({ x: 0, y: 0, width: w, height: h });
const ghost = (id: string, name: string) =>
  ({ id, name, type: 'INSTANCE', absoluteBoundingBox: bb(120, 20), children: [] });
const frame = (id: string, name: string, w: number, children: any[] = []) =>
  ({ id, name, type: 'FRAME', absoluteBoundingBox: bb(w), children });
const page = (children: any[]) => ({ id: 'p:1', name: 'Page 1', type: 'CANVAS', children });
const doc = (children: any[]) => ({ id: '0:0', name: 'Document', type: 'DOCUMENT', children: [page(children)] });

describe('the shared detector learns negative variant-name assignments', () => {
  const named = (name: string): any => ({ id: 'x:1', name, type: 'COMPONENT', absoluteBoundingBox: bb(360), children: [] });
  it('a k=v segment whose key is the token uses the positive list', () => {
    expect(scanPlaceholders(named('Skeleton=False, Breakpoint=Desktop')).count).toBe(0);
    expect(scanPlaceholders(named('State=Loaded, Skeleton=No')).count).toBe(0);
    expect(scanPlaceholders(named('Skeleton=True, Breakpoint=Desktop')).count).toBe(1);
    expect(scanPlaceholders(named('Skeleton=yes')).count).toBe(1);
  });
  it('the plain name rule still fires on token-bearing segments', () => {
    expect(scanPlaceholders(named('ghostSkeletonRow, State=Loaded')).count).toBe(1);
    expect(scanPlaceholders(named('State=Loaded, plain tile')).count).toBe(0);
  });
  it('the wave regression locks: value-side and free-text-with-equals fire; only the explicit negative is suppressed', () => {
    // the positive-list variant blinded the detector to all of these (each counts 1 on main)
    expect(scanPlaceholders(named('State=Skeleton')).count).toBe(1);
    expect(scanPlaceholders(named('State=Skeleton, Breakpoint=Desktop')).count).toBe(1);
    expect(scanPlaceholders(named('Skeleton=Card')).count).toBe(1);
    expect(scanPlaceholders(named('skeleton (w=320)')).count).toBe(1);
    expect(scanPlaceholders(named('skeleton row = ghost')).count).toBe(1);
    // and the discrimination the fix exists for still holds
    expect(scanPlaceholders(named('Skeleton=False')).count).toBe(0);
    expect(scanPlaceholders(named('State=Loaded')).count).toBe(0);
  });
  it('componentProperties: the value-side channel is VARIANT-typed; TEXT copy never counts', () => {
    const withProp = (key: string, v: unknown, type = 'VARIANT'): any =>
      ({ id: '3:1', name: 'tile', type: 'INSTANCE', absoluteBoundingBox: bb(360),
        componentProperties: { [key]: { type, value: v } } });
    expect(scanPlaceholders(withProp('State#1:0', 'Skeleton')).count).toBe(1);
    expect(scanPlaceholders(withProp('State#1:0', 'Loaded')).count).toBe(0);
    expect(scanPlaceholders(withProp('skeleton#1:0', 'Card')).count).toBe(1);
    // a TEXT prop whose COPY reads the token is content, not a state (the blast measured the
    // caveat excusing a genuine delta over a nav label)
    expect(scanPlaceholders(withProp('Label#9:0', 'Skeleton', 'TEXT')).count).toBe(0);
  });
  it('hidden wrappers exclude their candidates from the race and the scan', async () => {
    const hiddenWrap = { ...frame('f:2', 'wrap', 360, [frame('f:3', 'rowSkeletonBar', 360, [])]), visible: false };
    const cart = frame('f:1', 'Cart drawer', 1280, [hiddenWrap, frame('f:9', 'Summary', 900, [])]);
    const run = harness(depthApi(doc([cart])));
    const out = await run({ file: 'abc', query: 'Cart', render_width: 360 });
    const v = out.variants.find((x: any) => x.node_id === 'f:1');
    expect(v?.placeholders).toBeUndefined();
    expect((v?.content ?? []).some((c: any) => c.node_id === 'f:3')).toBe(false);
    expect(out.note ?? '').not.toMatch(/placeholder \(skeleton\)/);
  });
  it('a set GRANDCHILD under the flagged component is never the escape route', async () => {
    const set = {
      id: 'set:1', name: 'promo tile', type: 'COMPONENT_SET', absoluteBoundingBox: bb(760),
      children: [
        { id: 'cmp:sk', name: 'State=Skeleton', type: 'COMPONENT', absoluteBoundingBox: bb(360),
          children: [frame('g:1', 'ghost rows', 360, [ghost('g:2', 'pillSkeletonBar')])] },
        { id: 'cmp:ld', name: 'State=Loaded', type: 'COMPONENT', absoluteBoundingBox: bb(900), children: [] },
      ],
    };
    const run = harness(depthApi(doc([set])));
    const out = await run({ file: 'abc', query: 'promo tile', render_width: 360 });
    expect(out.note ?? '').not.toMatch(/alternative[^—]*ghost rows/);
  });
});

describe('the candidate is the unit', () => {
  // A COMPONENT_SET: ONE variants[] entry whose skeleton and loaded children are CONTENT.
  const set = {
    id: 'set:1', name: 'promo tile', type: 'COMPONENT_SET', absoluteBoundingBox: bb(760),
    children: [
      { id: 'cmp:sk', name: 'Skeleton=True', type: 'COMPONENT', absoluteBoundingBox: bb(360),
        children: [ghost('g:1', 'pillSkeletonBar')] },
      { id: 'cmp:ld', name: 'Skeleton=False', type: 'COMPONENT', absoluteBoundingBox: bb(360), children: [] },
    ],
  };
  it('counts land on content candidates; the variant row carries the max', async () => {
    const run = harness(depthApi(doc([set])));
    const out = await run({ file: 'abc', query: 'promo tile', render_width: 360 });
    const v = out.variants.find((x: any) => x.node_id === 'set:1');
    const sk = v.content.find((c: any) => c.node_id === 'cmp:sk');
    const ld = v.content.find((c: any) => c.node_id === 'cmp:ld');
    expect(sk?.placeholders).toBeGreaterThanOrEqual(1);
    expect(ld?.placeholders).toBeUndefined();
    expect(v.placeholders).toBe(sk.placeholders);
  });
  it('match.placeholders is the machine sibling when the matched candidate is a skeleton', async () => {
    // only the skeleton child sits at the render width - it wins outright
    const outright = {
      ...set,
      children: [
        { id: 'cmp:sk', name: 'Skeleton=True', type: 'COMPONENT', absoluteBoundingBox: bb(360),
          children: [ghost('g:1', 'pillSkeletonBar')] },
        { id: 'cmp:ld', name: 'Skeleton=False', type: 'COMPONENT', absoluteBoundingBox: bb(760), children: [] },
      ],
    };
    const run = harness(depthApi(doc([outright])));
    const out = await run({ file: 'abc', query: 'promo tile', render_width: 360 });
    expect(out.match?.node_id).toBe('cmp:sk');
    expect(out.match?.placeholders).toBeGreaterThanOrEqual(1);
    expect(out.note).toMatch(/placeholder \(skeleton\)/);
    expect(out.note).toMatch(/LOADED render/);
    // the note LEADS the joined string and names the closest alternative
    expect(out.note.startsWith('matched variant')).toBe(true);
    expect(out.note).toMatch(/cmp:ld|Skeleton=False/);
  });
  it('a clean match against a skeleton sibling within tolerance still surfaces the presence note', async () => {
    const run = harness(depthApi(doc([set])));
    const out = await run({ file: 'abc', query: 'promo tile', render_width: 360 });
    // both children at 360: insertion order picks the skeleton first - the note explains the
    // equal-distance pick with the existing lexis
    expect(out.match).not.toBeNull();
    expect(out.note).toMatch(/placeholder \(skeleton\)/);
  });
});

describe('match ancestry (the wave blockers)', () => {
  it('a clean matched child inside a placeholder-bearing FRAME variant carries variant_placeholders - never an all-clear', async () => {
    const cart = frame('f:1', 'Cart drawer', 1280, [
      frame('f:2', 'Summary', 360, []),
      frame('f:3', 'Order list', 900, [ghost('g:1', 'rowSkeletonBar')]),
    ]);
    const run = harness(depthApi(doc([cart])));
    const out = await run({ file: 'abc', query: 'Cart', render_width: 360 });
    expect(out.match?.node_id).toBe('f:2');
    expect(out.match?.placeholders).toBeUndefined();
    expect(out.match?.variant_placeholders).toBeGreaterThanOrEqual(1);
    expect(out.note).toMatch(/sits inside variant/);
    expect(out.note).not.toMatch(/not it/);
  });
  it('the named alternative never comes from inside the same skeleton FRAME (set children stay eligible)', async () => {
    const cart = frame('f:1', 'Cart', 1280, [
      { ...frame('f:2', 'panelSkeleton', 360, [frame('f:3', 'rows', 360, [])]) },
    ]);
    const run = harness(depthApi(doc([cart])));
    const out = await run({ file: 'abc', query: 'Cart', render_width: 360 });
    // f:3 is the flagged frame's own child - it must NOT be offered as the escape route
    expect(out.note).not.toMatch(/alternative[^—]*"rows"/);
  });
  it('a frame-itself match carries match.placeholders (the walk-slice half of the union is live)', async () => {
    const sk = frame('f:1', 'tileSkeleton', 360, [ghost('g:1', 'pillSkeletonBar')]);
    const run = harness(depthApi(doc([sk])));
    const out = await run({ file: 'abc', query: 'tileSkeleton', render_width: 360 });
    expect(out.match?.node_id).toBe('f:1');
    expect(out.match?.placeholders).toBeGreaterThanOrEqual(1);
  });
});

describe('the set suppression (release claim-verification)', () => {
  it('a clean DIRECT child of a set that wins is the CORRECT choice - never tainted', async () => {
    const set = {
      id: 'set:1', name: 'promo tile', type: 'COMPONENT_SET', absoluteBoundingBox: bb(760),
      children: [
        { id: 'cmp:sk', name: 'State=Skeleton', type: 'COMPONENT', absoluteBoundingBox: bb(900),
          children: [ghost('g:1', 'pillSkeletonBar')] },
        { id: 'cmp:ld', name: 'State=Loaded', type: 'COMPONENT', absoluteBoundingBox: bb(360), children: [] },
      ],
    };
    const run = harness(depthApi(doc([set])));
    const out = await run({ file: 'abc', query: 'promo tile', render_width: 360 });
    expect(out.match?.node_id).toBe('cmp:ld');
    expect(out.match?.variant_placeholders).toBeUndefined();
    expect(out.note ?? '').not.toMatch(/sits inside variant/);
    // the presence note still names the skeleton candidate - visibility without taint
    expect(out.note ?? '').toMatch(/placeholder \(skeleton\)/);
  });
});

describe('honesty at the edges', () => {
  it('match:null (over-tolerance) still names a skeleton-bearing candidate', async () => {
    const sk = frame('f:1', 'tileSkeletonWide', 900, [ghost('g:1', 'pillSkeletonBar')]);
    const run = harness(depthApi(doc([sk])));
    const out = await run({ file: 'abc', query: 'tile', render_width: 360 });
    expect(out.match).toBeNull();
    expect(out.note).toMatch(/placeholder \(skeleton\)/);
  });
  it('the named ceiling: a NESTED variant whose skeleton sits 3 levels down is invisible to both slices', async () => {
    // For a TOP-LEVEL container the walk slice is deeper than the content fetch and the union
    // legitimately sees level 3 (the panel's inverted-slice measurement). The ceiling lives on
    // NESTED variants: under a section, both the walk residual and the depth-2 content fetch
    // stop above the ghost. Pinned so silence is never read as a clean signal.
    const deep = { id: 'sec:1', name: 'Tiles', type: 'SECTION', children: [
      frame('f:1', 'tile', 360, [
        frame('f:2', 'wrap', 360, [
          frame('f:3', 'inner', 360, [ghost('g:1', 'pillSkeletonBar')]),
        ]),
      ]),
    ] };
    const run = harness(depthApi(doc([deep])));
    const out = await run({ file: 'abc', query: 'tile', render_width: 360 });
    const v = out.variants.find((x: any) => x.node_id === 'f:1');
    expect(v).toBeDefined();
    expect(v?.placeholders).toBeUndefined();
    expect(out.note ?? '').not.toMatch(/placeholder \(skeleton\)/);
  });
  it('degraded content fetch: the extended sentence covers the scan, and the walk slice still counts', async () => {
    const sk = frame('f:1', 'tileSkeleton', 360, [ghost('g:1', 'pillSkeletonBar')]);
    const run = harness(depthApi(doc([sk]), { contentFetchFails: true }));
    const out = await run({ file: 'abc', query: 'tileSkeleton', render_width: 360 });
    expect(out.note).toMatch(/placeholder scan/);
    expect(out.note).toMatch(/not an absence claim/);
    // root-inclusive: the variant's own token-carrying name counts even on the degraded path
    const v = out.variants.find((x: any) => x.node_id === 'f:1');
    expect(v?.placeholders).toBeGreaterThanOrEqual(1);
  });
  it('no skeleton anywhere: no fields, no presence note (non-vacuous - real content raced)', async () => {
    const clean = frame('f:1', 'tile', 360, [frame('f:2', 'inner', 360)]);
    const run = harness(depthApi(doc([clean])));
    const out = await run({ file: 'abc', query: 'tile', render_width: 360 });
    expect(out.match).not.toBeNull();
    const v = out.variants.find((x: any) => x.node_id === 'f:1');
    expect(v?.placeholders).toBeUndefined();
    expect((v?.content ?? []).some((c: any) => c.placeholders !== undefined)).toBe(false);
    expect(out.note ?? '').not.toMatch(/placeholder \(skeleton\)/);
  });
});
