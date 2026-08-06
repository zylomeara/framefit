import { describe, it, expect, vi } from 'vitest';
import { registerSuggestPairsTool, InputSchema, domSelector } from '../../src/adapters/driving/tools/suggest-pairs-tool.js';
import { DOM_SNAPSHOT_SCHEMA_VERSION } from '../../src/adapters/driving/tools/dom-snapshot-schema.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
function harness(api: Partial<FigmaApi>, depsOverrides: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => api as FigmaApi, defaultToken: 'figd_x', logger, ...depsOverrides };
  registerSuggestPairsTool(server, deps);
  return (a: any): Promise<any> => call('suggest_pairs', a);
}

// compound (nested-instance) id, colon form — Figma keys /nodes children this way for
// instance-internal nodes (see get-code-connect-map-tool.test.ts).
const COMPOUND_ID = 'I12:340;56:7890';

const doc: RawSceneNode = {
  id: '1:1', name: 'card', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 100 },
  layoutMode: 'VERTICAL', itemSpacing: 8,
  children: [
    {
      id: '1:2', name: 'title', type: 'TEXT',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 24 },
      characters: 'Buy now', style: { fontFamily: 'Inter', fontSize: 16 },
    },
    {
      id: COMPOUND_ID, name: 'Button', type: 'INSTANCE',
      absoluteBoundingBox: { x: 0, y: 32, width: 300, height: 40 },
    },
  ],
};

const okDomSnapshot = {
  schema: DOM_SNAPSHOT_SCHEMA_VERSION, status: 'ok' as const,
  innerWidth: 300,
  rect: { x: 0, y: 0, w: 300, h: 100 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 },
  children: [
    { kind: 'element' as const, tag: 'span', path: '> :nth-child(1)', rect: { x: 0, y: 0, w: 300, h: 24 }, text: 'Buy now' },
    { kind: 'element' as const, tag: 'button', path: '> :nth-child(2)', rect: { x: 0, y: 32, w: 300, h: 40 } },
  ],
};

// A two-level tree (row → a/b) — to verify the pass-through of summary.depth_truncated (Thread 1).
const nestedDoc: RawSceneNode = {
  id: '2:1', name: 'group', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  children: [
    {
      id: '2:2', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
      children: [
        { id: '2:3', name: 'a', type: 'TEXT', absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 }, characters: 'A', style: { fontFamily: 'Inter', fontSize: 12 } },
        { id: '2:4', name: 'b', type: 'TEXT', absoluteBoundingBox: { x: 50, y: 0, width: 50, height: 50 }, characters: 'B', style: { fontFamily: 'Inter', fontSize: 12 } },
      ],
    },
  ],
};
const nestedDomSnapshot = {
  schema: DOM_SNAPSHOT_SCHEMA_VERSION, status: 'ok' as const,
  innerWidth: 100,
  rect: { x: 0, y: 0, w: 100, h: 100 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 },
  children: [
    { kind: 'element' as const, tag: 'div', path: '> :nth-child(1)', rect: { x: 0, y: 0, w: 100, h: 50 },
      children: [
        { kind: 'element' as const, tag: 'span', path: '> :nth-child(1) > :nth-child(1)', rect: { x: 0, y: 0, w: 50, h: 50 }, text: 'A' },
        { kind: 'element' as const, tag: 'span', path: '> :nth-child(1) > :nth-child(2)', rect: { x: 50, y: 0, w: 50, h: 50 }, text: 'B' },
      ] },
  ],
};

describe('suggest_pairs tool', () => {
  it('fetches the frame, matches pairs, and digs the compound node_id out of spec.children', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: okDomSnapshot });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 5); // FETCH_DEPTH 4→5 (peek headroom)

    const out = JSON.parse(res.content[0].text);
    expect(out.file).toBe('abc');
    expect(out.frame).toEqual({ id: '1:1', name: 'card', type: 'FRAME' });
    expect(out).toHaveProperty('pairs');
    expect(out).toHaveProperty('unmatched_figma');
    expect(out).toHaveProperty('unmatched_dom');
    expect(out).toHaveProperty('summary');

    const titlePair = out.pairs.find((p: any) => p.node_id === '1:2');
    expect(titlePair).toMatchObject({ dom_path: '> :nth-child(1)', confidence: 'high' });

    // Compound id (nested-instance path) is preserved as-is — it comes straight out of
    // spec.children (projector copies raw.id verbatim), no extra unwrapping logic needed.
    const buttonPair = out.pairs.find((p: any) => p.node_id === COMPOUND_ID);
    expect(buttonPair).toBeDefined();
    expect(buttonPair.dom_path).toBe('> :nth-child(2)');
    expect(['high', 'medium', 'low']).toContain(buttonPair.confidence);

    expect(out.unmatched_figma).toEqual([]);
    expect(out.unmatched_dom).toEqual([]);
    expect(out.summary).toEqual({ paired: 2, ambiguous: 0, unmatched_figma: 0, unmatched_dom: 0 });
  });

  // MUTATION LOCK on the meta-first path buildSetNames(api, entry, …) in suggest_pairs.
  // setName is not serialized into the pairs output, so the lock rests on assert (a): getComponent NOT called.
  // Fixture: components '5:1' with componentSetId+key (which would make legacy resolveSetNames(api,
  // entry.components) call getComponent('pubkey')), BUT componentSets '4:1' covers the setId via the meta →
  // meta-resolve, REST is not touched. The mutation "revert to resolveSetNames(api, entry.components, …)" →
  // getComponent called → RED. The tool still runs without error (the meta covered the name).
  it('setName from the componentSets meta → getComponent NOT called (meta-first buildSetNames)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': {
      document: doc,
      components: { '5:1': { key: 'pubkey', name: 'Button', remote: true, componentSetId: '4:1' } },
      componentSets: { '4:1': { key: 'sk1', name: 'listItem', remote: true } },
    } } }));
    const getComponent = vi.fn();
    const run = harness({ getNodesRaw, getComponent });
    const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: okDomSnapshot });
    expect(res.isError).toBeFalsy();
    expect(getComponent).not.toHaveBeenCalled(); // meta-resolve: zero /v1/components fetches
  });

  it('honest-errors on a failed dom_snapshot instead of crashing on missing .children (I5)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: { status: 'not_found', selector: '.gone' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not_found');
  });

  it('max_depth truncates a non-empty subtree → summary.depth_truncated:true (Thread 1)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '2:1': { document: nestedDoc } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', frame_node_id: '2-1', dom_snapshot: nestedDomSnapshot, max_depth: 0 });

    const out = JSON.parse(res.content[0].text);
    expect(out.pairs.some((p: any) => p.node_id === '2:2')).toBe(true); // 'row'
    expect(out.pairs.some((p: any) => p.node_id === '2:3')).toBe(false); // 'a' — cut off by the guard
    expect(out.summary.depth_truncated).toBe(true);
  });

  it('without max_depth — full recursion, summary.depth_truncated absent', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '2:1': { document: nestedDoc } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', frame_node_id: '2-1', dom_snapshot: nestedDomSnapshot });

    const out = JSON.parse(res.content[0].text);
    expect(out.pairs.some((p: any) => p.node_id === '2:3')).toBe(true); // 'a' — now matches
    expect('depth_truncated' in out.summary).toBe(false);
  });

  // summary.snapshot_truncated — an honest signal "the input DOM snapshot was truncated
  // by the extractor somewhere in the tree; matching small nodes below the cut may be incomplete".
  describe('summary.snapshot_truncated (#4 — honest signal on truncated DOM input)', () => {
    it('childrenTruncated DEEP in the tree (not at the root, not on a direct child) → snapshot_truncated:true', async () => {
      const deepTruncatedDomSnapshot = {
        schema: DOM_SNAPSHOT_SCHEMA_VERSION, status: 'ok' as const,
        innerWidth: 300,
        rect: { x: 0, y: 0, w: 300, h: 100 },
        borders: { top: 0, right: 0, bottom: 0, left: 0 },
        scroll: { top: 0, left: 0 },
        children: [
          {
            kind: 'element' as const, tag: 'div', path: '> :nth-child(1)', rect: { x: 0, y: 0, w: 300, h: 100 },
            children: [
              {
                kind: 'element' as const, tag: 'span', path: '> :nth-child(1) > :nth-child(1)', rect: { x: 0, y: 0, w: 150, h: 100 },
                children: [
                  { kind: 'element' as const, tag: 'b', path: '> :nth-child(1) > :nth-child(1) > :nth-child(1)', rect: { x: 0, y: 0, w: 50, h: 50 }, childrenTruncated: true },
                ],
              },
            ],
          },
        ],
      };
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: deepTruncatedDomSnapshot });
      const out = JSON.parse(res.content[0].text);
      expect(out.summary.snapshot_truncated).toBe(true);
    });

    it('I1 — childrenTruncated AT THE VERY ROOT of the snapshot (>30 direct children), nested ones not truncated → also snapshot_truncated:true', async () => {
      const rootTruncatedDomSnapshot = {
        schema: DOM_SNAPSHOT_SCHEMA_VERSION, status: 'ok' as const,
        innerWidth: 300,
        rect: { x: 0, y: 0, w: 300, h: 100 },
        borders: { top: 0, right: 0, bottom: 0, left: 0 },
        scroll: { top: 0, left: 0 },
        childrenTruncated: true, // root flag — dom-extractor.ts:131, >30 direct visible children
        children: [
          { kind: 'element' as const, tag: 'span', path: '> :nth-child(1)', rect: { x: 0, y: 0, w: 300, h: 24 }, text: 'Buy now' },
          { kind: 'element' as const, tag: 'button', path: '> :nth-child(2)', rect: { x: 0, y: 32, w: 300, h: 40 } },
        ],
      };
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: rootTruncatedDomSnapshot });
      const out = JSON.parse(res.content[0].text);
      expect(out.summary.snapshot_truncated).toBe(true);
    });

    it('without a single childrenTruncated in the snapshot (neither root nor children) → the summary.snapshot_truncated field is absent', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: okDomSnapshot });
      const out = JSON.parse(res.content[0].text);
      expect('snapshot_truncated' in out.summary).toBe(false);
    });

    // The DOM side was already folded in (tests above) — here it's the Figma side. The projector
    // (buildLayoutSpec, honest depth-flag) sets childrenTruncated on a terminal
    // node of the spec tree (deep, not at the frame root and not on a direct child) — the same honest signal
    // as on the DOM side must fold into summary.snapshot_truncated, even when the DOM snapshot
    // is entirely clean. The tree is built from a real RawSceneNode → buildLayoutSpec (not a mock), to
    // verify the end-to-end path rather than an invariant detached from the projector.
    it('Figma-side childrenTruncated (real projector, deep in spec.children) WITHOUT DOM truncation → summary.snapshot_truncated:true', async () => {
      const l5: RawSceneNode = { id: '3:6', name: 'l5', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } };
      const l4: RawSceneNode = { id: '3:5', name: 'l4', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 }, children: [l5] };
      const l3: RawSceneNode = { id: '3:4', name: 'l3', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 }, children: [l4] };
      const l2: RawSceneNode = { id: '3:3', name: 'l2', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 }, children: [l3] };
      const l1: RawSceneNode = { id: '3:2', name: 'l1', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 }, children: [l2] };
      const deepDoc: RawSceneNode = {
        id: '3:1', name: 'card', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 },
        children: [l1],
      };
      // Clean DOM side: neither the root nor the single child carries childrenTruncated —
      // isolates the signal entirely on the Figma side (without this the dom-fold from the tests above would mask the regression).
      const cleanDomSnapshot = {
        schema: DOM_SNAPSHOT_SCHEMA_VERSION, status: 'ok' as const,
        innerWidth: 50,
        rect: { x: 0, y: 0, w: 50, h: 50 },
        borders: { top: 0, right: 0, bottom: 0, left: 0 },
        scroll: { top: 0, left: 0 },
        children: [
          { kind: 'element' as const, tag: 'div', path: '> :nth-child(1)', rect: { x: 0, y: 0, w: 40, h: 40 } },
        ],
      };
      const getNodesRaw = vi.fn(async () => ({ nodes: { '3:1': { document: deepDoc } } }));
      const run = harness({ getNodesRaw });
      const res = await run({ file: 'abc', frame_node_id: '3-1', dom_snapshot: cleanDomSnapshot });
      const out = JSON.parse(res.content[0].text);
      expect(out.summary.snapshot_truncated).toBe(true);
    });
  });

  // suggest_pairs is the SECOND input to the matcher (compare_node_to_dom
  // is the first, gated at :338) — without an explicit version-gate, an old extractor silently slicing text at 40
  // (no flag) is indistinguishable from a full snippet under the server's SNIPPET_CAP=120 threshold → canonical
  // mis-anchor (a hidden tail could carry the disambiguating suffix). The Zod schema field accepts any int, so the
  // gate must be explicit in the handler. Surface differs from compare's warn-row: suggest_pairs has no
  // rows-structure, so a stale schema throws (isError) instead.
  describe('dom_snapshot schema gate (second matcher input)', () => {
    it('schema gate: a v3 snapshot (old extractor, 40-char cuts) → actionable rejection, matchPairs NOT called', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      const staleDomSnapshot = { ...okDomSnapshot, schema: 3 };
      const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: staleDomSnapshot });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('schema');
      expect(res.content[0].text).toContain('get_layout_spec');
      // An actionable rejection, NOT a normal JSON matcher result — no pairs in the response.
      expect(res.content[0].text).not.toContain('"pairs"');
    });

    // Positive bump regression: the canonical mis-anchor (a 51-60-char title, the old extractor cuts
    // DOM text at 40 WITHOUT a flag — before the SNIPPET_CAP bump this was patched with a separate longtext guard at 40, below which
    // 51-60-char text passed as "full"). Here the schema gate must cut the snapshot EARLIER than it even
    // reaches anchoring — no matter which pair the old scan would have pulled the truncated text toward.
    it('positive bump regression: a 51-60-char title truncated by the OLD extractor at 40 (schema:3) does NOT reach anchoring', async () => {
      const title55 = 'Book Title Nr.'.padEnd(55, 'X'); // exactly 55 chars — in the 51-60 range
      expect(title55.length).toBe(55);
      const longTitleDoc: RawSceneNode = {
        id: '4:1', name: 'card', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 100 },
        children: [
          {
            id: '4:2', name: 'title', type: 'TEXT',
            absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 24 },
            characters: title55, style: { fontFamily: 'Inter', fontSize: 16 },
          },
        ],
      };
      const staleDomSnapshotOldCut = {
        schema: 3, status: 'ok' as const,
        innerWidth: 300,
        rect: { x: 0, y: 0, w: 300, h: 100 },
        borders: { top: 0, right: 0, bottom: 0, left: 0 },
        scroll: { top: 0, left: 0 },
        children: [
          // The old extractor (pre-bump) cut text.slice(0, 40) without a flag — this is that cut.
          { kind: 'element' as const, tag: 'span', path: '> :nth-child(1)', rect: { x: 0, y: 0, w: 300, h: 24 }, text: title55.slice(0, 40) },
        ],
      };
      const getNodesRaw = vi.fn(async () => ({ nodes: { '4:1': { document: longTitleDoc } } }));
      const run = harness({ getNodesRaw });
      const res = await run({ file: 'abc', frame_node_id: '4-1', dom_snapshot: staleDomSnapshotOldCut });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('schema');
      expect(res.content[0].text).not.toContain('"pairs"');
    });

    // Parity with compare_node_to_dom-tool.test.ts:1482 ('stale snapshot_schema resolved THROUGH
    // dom_ref'): both tests above drive the stale schema through an inline dom_snapshot — this one drives it
    // THROUGH dom_ref (snapshotStore.resolve), proving the gate sits on the shared `dom` AFTER the
    // dom_snapshot|dom_ref fork, not only on the inline arm.
    it('dom_ref arm: stale snapshot_schema resolved THROUGH dom_ref → the same actionable rejection as inline', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const resolve = vi.fn(() => ({ ok: true as const, snapshot: { ...okDomSnapshot, schema: 3 } }));
      const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, { snapshotStore });
      const res = await run({ file: 'abc', frame_node_id: '1-1', dom_ref: { ref: 'r1', selector: '.card' } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('schema');
      expect(res.content[0].text).toContain('get_layout_spec');
      expect(res.content[0].text).not.toContain('"pairs"');
    });
  });

  // Wire-contract guards. The handler tests above pass dom_snapshot as an object DIRECTLY, so they
  // NEVER exercised the MCP inputSchema → connector coercion layer where the real blocker lived:
  // z.unknown() advertised an untyped field, the claude_ai_Figma connector coerced the object to a
  // string, and the server rejected every call. These pin the field's schema shape instead.
  describe('dom_snapshot inputSchema contract (mirror of compare_node_to_dom.dom)', () => {
    it('is a typed object schema — a stringified snapshot is REJECTED (connector must not coerce to string)', () => {
      expect(InputSchema.dom_snapshot.safeParse(JSON.stringify(okDomSnapshot)).success).toBe(false);
      expect(InputSchema.dom_snapshot.safeParse(okDomSnapshot).success).toBe(true);
    });
    // dom_snapshot is now OPTIONAL — dom_ref is the alternative (exactly-one enforced by
    // the handler XOR guard, not the schema). Updated from the earlier "is required" contract
    // test, which asserted the opposite (isOptional()===false); that assertion is now intentionally
    // false, so it's rewritten rather than left to rot as a false-red guard.
    it('is optional — isOptional()=true and undefined is accepted at the schema level (XOR enforced by the handler)', () => {
      expect(InputSchema.dom_snapshot.isOptional()).toBe(true);
      expect(InputSchema.dom_snapshot.safeParse(undefined).success).toBe(true);
    });
  });

  it('frame not found in file → per-call error', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': null } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: okDomSnapshot });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  describe('dom_ref', () => {
    it('resolves via snapshotStore → identical pairs to inline dom_snapshot', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const resolve = vi.fn(() => ({ ok: true, snapshot: okDomSnapshot }));
      const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];
      const inlineRun = harness({ getNodesRaw });
      const refRun = harness({ getNodesRaw }, { snapshotStore, tenantId: 'u1' });
      const inlineOut = JSON.parse((await inlineRun({ file: 'abc', frame_node_id: '1-1', dom_snapshot: okDomSnapshot })).content[0].text);
      const refOut = JSON.parse((await refRun({ file: 'abc', frame_node_id: '1-1', dom_ref: { ref: 'r1', selector: '.card' } })).content[0].text);
      expect(resolve).toHaveBeenCalledWith('r1', '.card', 'u1');
      expect(refOut.pairs).toEqual(inlineOut.pairs);
    });

    // NOTE (deviation from brief): the brief's Step-1 snippet asserted these four cases via
    // `.rejects.toThrow(...)`. This tool's handler body runs inside shared-error-handler.ts'
    // runTool(), which try/catches every thrown Error and resolves { isError: true, content }
    // instead of rejecting the promise (see the pre-existing I5 test above, "honest-errors on a
    // failed dom_snapshot instead of crashing" — same isError:true pattern). A `.rejects` assertion
    // here would never pass regardless of implementation correctness, so these check isError +
    // content text instead, matching the file's existing convention.
    it('throws on both dom_snapshot AND dom_ref', async () => {
      const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: {} })) });
      const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: okDomSnapshot, dom_ref: { ref: 'r', selector: '.card' } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/exactly one/);
    });

    it('throws on neither dom_snapshot NOR dom_ref', async () => {
      const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: {} })) });
      const res = await run({ file: 'abc', frame_node_id: '1-1' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/exactly one/);
    });

    it('throws a resolve failure as an honest note', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const resolve = vi.fn(() => ({ ok: false, reason: 'expired' }));
      const snapshotStore = { resolve } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, { snapshotStore });
      const res = await run({ file: 'abc', frame_node_id: '1-1', dom_ref: { ref: 'stale', selector: '.card' } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/expired\/unknown/);
    });

    it('throws when snapshotStore is absent', async () => {
      const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: {} })) });
      const res = await run({ file: 'abc', frame_node_id: '1-1', dom_ref: { ref: 'r', selector: '.card' } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/snapshot store unavailable/);
    });
  });
});

// dom_selector: the address a reader can paste, assembled — not invented. Uniqueness is a property of
// the document, and the server only sees the captured subtree, so the ONLY thing here that can be wrong
// is the join: a capture root that is a selector LIST ('.a, .b') read as '.a' OR '.b > path'.
describe('dom_selector (capture root + nth-child path, :is()-scoped)', () => {
  const withSelector = (selector: string) => ({ ...okDomSnapshot, selector });

  it('emits root + path on pairs, candidates and unmatched_dom; a comma-carrying root stays one scope', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
    const run = harness({ getNodesRaw });
    // A third dom element the same size as the button, one index further out: the Button instance now has
    // a runner-up 3.75 behind (45 vs 41.25) — inside AMBIGUOUS_MARGIN — so the row carries candidates[].
    // Without it this fixture has no ambiguity at all and the candidates arm below would quantify over an
    // empty array, i.e. pass whether or not the tool ever addresses a candidate.
    const twoWay = { ...withSelector('.a, .b'), children: [...okDomSnapshot.children,
      { kind: 'element' as const, tag: 'div', path: '> :nth-child(3)', rect: { x: 0, y: 32, w: 300, h: 40 } }] };
    const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: twoWay });
    const out = JSON.parse(res.content[0].text);
    const titlePair = out.pairs.find((p: any) => p.node_id === '1:2');
    // NOT '.a, .b > :nth-child(1)', which parses as '.a' OR '.b > :nth-child(1)' and silently resolves
    // to the capture root itself.
    expect(titlePair.dom_selector).toBe(':is(.a, .b) > :nth-child(1)');
    const btn = out.pairs.find((p: any) => p.node_id === COMPOUND_ID);
    expect(btn.ambiguous).toBe(true);
    expect(btn.candidates.map((c: any) => c.dom_path)).toEqual(['> :nth-child(2)', '> :nth-child(3)']); // PRESENCE
    expect(btn.candidates.map((c: any) => c.dom_selector))
      .toEqual([':is(.a, .b) > :nth-child(2)', ':is(.a, .b) > :nth-child(3)']);
  });

  it('the guards: nothing to scope, or nothing to scope it to, yields NO address rather than a bad one', () => {
    // Measured in Chrome: dropping the path guard emits ':is(.a) ' which is 1 match - the capture ROOT
    // itself, i.e. a wrong address answering status ok. `path` is optional in the snapshot schema, so
    // this is reachable input, not a hypothetical.
    expect(domSelector(undefined, '> :nth-child(1)')).toBeUndefined();
    expect(domSelector('', '> :nth-child(1)')).toBeUndefined();
    expect(domSelector('.a', '')).toBeUndefined();
    expect(domSelector('.a', '> :nth-child(1)')).toBe(':is(.a) > :nth-child(1)');
    // The trade :is() makes, recorded rather than discovered later: it is a FORGIVING selector list, so
    // a syntactically bad root stops throwing and silently matches nothing - unreachable from a snapshot
    // the extractor produced (it refuses a root that does not match exactly one element), and the price
    // of closing the real defect, a comma-carrying root silently resolving to the wrong element.
    expect(domSelector('.a::before', '> :nth-child(1)')).toBe(':is(.a::before) > :nth-child(1)');
  });

  it('no root selector in the snapshot -> NO dom_selector field (an address is never synthesized)', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', frame_node_id: '1-1', dom_snapshot: okDomSnapshot }); // no .selector
    const out = JSON.parse(res.content[0].text);
    expect(out.pairs.length).toBe(2);   // an empty pairs array satisfies both `every`s below
    expect(out.pairs.every((p: any) => !('dom_selector' in p))).toBe(true);
    expect(out.pairs.every((p: any) => typeof p.dom_path === 'string')).toBe(true); // dom_path still there
  });

  it('unmatched_dom rows are pasteable too — that is the list a mis-pair is retargeted from', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '2:1': { document: nestedDoc } } }));
    const run = harness({ getNodesRaw });
    const snap = { ...nestedDomSnapshot, selector: 'main.app',
      children: [...nestedDomSnapshot.children, { kind: 'element' as const, tag: 'footer', path: '> :nth-child(2)', rect: { x: 0, y: 900, w: 100, h: 20 } }] };
    const res = await run({ file: 'abc', frame_node_id: '2-1', dom_snapshot: snap });
    const out = JSON.parse(res.content[0].text);
    expect(out.unmatched_dom).toContainEqual({ dom_path: '> :nth-child(2)', tag: 'footer', rect: { w: 100, h: 20 }, dom_selector: ':is(main.app) > :nth-child(2)' });
  });
});

// A withheld subtree is in NEITHER unmatched list on purpose: an unmatched row asserts "no counterpart
// here", and we did not look. But then it was in no COUNT either, and a summary reading
// {paired: N, unmatched_figma: 0, unmatched_dom: 0} over a frame where whole nodes were never judged is
// a claim of complete coverage. This locks the count, and locks that it is ABSENT rather than 0.
describe('summary.children_skipped (the withheld subtrees are at least countable)', () => {
  const kidF = (id: string, x: number, y: number) =>
    ({ id, name: id, type: 'FRAME', absoluteBoundingBox: { x, y, width: 50, height: 50 } });
  const coinDoc = {
    id: '3:1', name: 'coin', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    children: [
      { id: '3:2', name: 'A', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [kidF('3:3', 0, 0), kidF('3:4', 50, 0)] },
      { id: '3:5', name: 'B', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 50, width: 100, height: 50 },
        children: [kidF('3:6', 0, 50), kidF('3:7', 50, 50)] },
    ],
  } as unknown as RawSceneNode;
  const kidD = (path: string, x: number, y: number) =>
    ({ kind: 'element' as const, tag: 'div', path, rect: { x, y, w: 50, h: 50 } });
  const coinSnap = {
    schema: DOM_SNAPSHOT_SCHEMA_VERSION, status: 'ok' as const, innerWidth: 100,
    rect: { x: 0, y: 0, w: 100, h: 100 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 },
    children: [
      { kind: 'element' as const, tag: 'section', path: '> :nth-child(1)', rect: { x: 0, y: 0, w: 100, h: 50 },
        children: [kidD('> :nth-child(1) > :nth-child(1)', 0, 0), kidD('> :nth-child(1) > :nth-child(2)', 50, 0)] },
      { kind: 'element' as const, tag: 'div', path: '> :nth-child(2)', rect: { x: 0, y: 50, w: 100, h: 50 },
        children: [kidD('> :nth-child(2) > :nth-child(1)', 0, 50), kidD('> :nth-child(2) > :nth-child(2)', 50, 50)] },
    ],
  };

  it('counts the pairs whose subtree it withheld, and omits the key entirely when it withheld none', async () => {
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '3:1': { document: coinDoc } } })) });
    const res = await run({ file: 'abc', frame_node_id: '3-1', dom_snapshot: coinSnap });
    const out = JSON.parse(res.content[0].text);
    const withheld = out.pairs.filter((p: any) => p.children_skipped);
    expect(withheld.length).toBeGreaterThan(0);              // PRESENCE: the count below is not a count of nothing
    expect(out.summary.children_skipped).toBe(withheld.length);
    // and this is why it had to exist: the withheld nodes are on neither honest-null list, so without
    // the count the summary reads as full coverage.
    expect(out.summary.unmatched_figma).toBe(0);
    expect(out.summary.unmatched_dom).toBe(0);

    const run2 = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc } } })) });
    const clean = JSON.parse((await run2({ file: 'abc', frame_node_id: '1-1', dom_snapshot: okDomSnapshot })).content[0].text);
    expect(clean.pairs.every((p: any) => !p.children_skipped)).toBe(true);
    expect('children_skipped' in clean.summary).toBe(false);  // absent, not 0 - same shape as depth_truncated
  });
});


// The handler passes the captured root's real rect as matchOpts.rootDom. Delete that one field and the
// matcher falls back to a "tallest child" proxy for the DOM denominator while the Figma side keeps the
// true frame - the two sides of every relative-size comparison normalised by different numbers. On a
// real capture that flips a level-0 winner onto the wrong element and, because the wrong winner has no
// children, collapses the descent from 21 proposals to 9.
// It was guarded only by accident: deleting the field turned exactly ONE test of 3040 red, and that one
// is about selector pasteability - its message says nothing about normalisation, so the natural repair
// is to update the expected row, which re-opens the defect and consumes the accidental lock in the same
// commit. This is the deliberate lock.
describe('the captured root normalises the DOM side (matchOpts.rootDom)', () => {
  const tallDoc = {
    id: '4:1', name: 'page', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
    children: [
      { id: '4:2', name: 'head', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 70 } },
      { id: '4:3', name: 'foot', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 920, width: 1000, height: 80 } },
    ],
  } as unknown as RawSceneNode;
  // The property that makes the two denominators disagree: the root is 1000 tall and its tallest child
  // is 80, so the proxy is 12.5x off. Widths are equal everywhere, so only the height axis carries it.
  const tallSnap = {
    schema: DOM_SNAPSHOT_SCHEMA_VERSION, status: 'ok' as const, innerWidth: 1000,
    rect: { x: 0, y: 0, w: 1000, h: 1000 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 },
    children: [
      { kind: 'element' as const, tag: 'div', path: '> :nth-child(1)', rect: { x: 0, y: 0, w: 1000, h: 70 } },
      { kind: 'element' as const, tag: 'footer', path: '> :nth-child(2)', rect: { x: 0, y: 920, w: 1000, h: 80 } },
    ],
  };

  it('a root far taller than its tallest child still pairs on TRUE relative size', async () => {
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '4:1': { document: tallDoc } } })) });
    const out = JSON.parse((await run({ file: 'abc', frame_node_id: '4-1', dom_snapshot: tallSnap })).content[0].text);
    // PRESENCE first: under the proxy both nodes fall below MATCH_FLOOR and become honest-null, and
    // every `find` below would then return undefined and assert nothing.
    expect(out.pairs).toHaveLength(2);
    expect(out.summary.unmatched_figma).toBe(0);
    expect(out.pairs.find((p: any) => p.node_id === '4:3')?.dom_path).toBe('> :nth-child(2)'); // foot -> <footer>
    expect(out.pairs.find((p: any) => p.node_id === '4:2')?.dom_path).toBe('> :nth-child(1)'); // head -> the top div
  });
});
