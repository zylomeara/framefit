import { describe, it, expect, vi, afterEach } from 'vitest';
import { Jimp } from 'jimp';
import { registerGetPinDetailTool } from '../../src/adapters/driving/tools/get-pin-detail-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

afterEach(() => vi.unstubAllGlobals());

function install(doc: RawSceneNode) {
  const { server, call } = makeFakeMcpServer();
  const api = {
    getNodesRaw: async (_k: string, ids: string[]) => ({ nodes: { [ids[0]]: { document: doc } } }),
    getImages: async (_k: string, ids: string[], opts: any) => ({ images: Object.fromEntries(ids.map((i) => [i, `https://s3/${opts.format}-${opts.scale}.png`])) }),
  };
  const deps = { buildApi: () => api as never, defaultToken: 't', logger: { warn() {} } as never, maxResultChars: 40000 };
  registerGetPinDetailTool(server, deps as never);
  return (a: Record<string, unknown>) => call('get_pin_detail', a);
}

// A minimal review board: prod RECTANGLE (image fill) + numbered pin INSTANCE + aligned reference FRAME.
function board(pinNumber = 1): RawSceneNode {
  const t = (id: string, chars: string): RawSceneNode => ({
    id, name: chars, type: 'TEXT', characters: chars,
    absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
  } as unknown as RawSceneNode);
  return {
    id: '12:1', name: 'sec', type: 'SECTION',
    absoluteBoundingBox: { x: 0, y: 0, width: 4000, height: 2000 },
    children: [
      { id: 'prod', name: 'image 1', type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
        fills: [{ type: 'IMAGE', imageRef: 'r' }] } as unknown as RawSceneNode,
      { id: 'pin', name: 'Цифровой пин', type: 'INSTANCE',
        absoluteBoundingBox: { x: 400, y: 400, width: 74, height: 106 },
        children: [t('pin-n', String(pinNumber))] } as unknown as RawSceneNode,
      { id: 'ref', name: 'Макет', type: 'FRAME',
        absoluteBoundingBox: { x: 2000, y: 0, width: 1000, height: 1000 },
        children: [
          { id: 'card', name: 'card', type: 'FRAME',
            absoluteBoundingBox: { x: 2000, y: 0, width: 1000, height: 1000 }, children: [] } as unknown as RawSceneNode,
        ] } as unknown as RawSceneNode,
    ],
  } as unknown as RawSceneNode;
}

// Variant of board() where the pin tip falls outside the prod screenshot → null coordinate.
// Pin bbox x=5000 puts tip at x=5037, which is > prod right edge (x+w = 0+1000 = 1000),
// so buildReviewBoard assigns screenshotNodeId=null / atPercent=null.
function boardNoCoord(): RawSceneNode {
  const t = (id: string, chars: string): RawSceneNode => ({
    id, name: chars, type: 'TEXT', characters: chars,
    absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
  } as unknown as RawSceneNode);
  return {
    id: '12:1', name: 'sec', type: 'SECTION',
    absoluteBoundingBox: { x: 0, y: 0, width: 6000, height: 2000 },
    children: [
      { id: 'prod', name: 'image 1', type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
        fills: [{ type: 'IMAGE', imageRef: 'r' }] } as unknown as RawSceneNode,
      // Pin placed far outside prod screenshot — tip x≈5037 > prod right edge 1000
      { id: 'pin', name: 'Цифровой пин', type: 'INSTANCE',
        absoluteBoundingBox: { x: 5000, y: 400, width: 74, height: 106 },
        children: [t('pin-n', '1')] } as unknown as RawSceneNode,
      { id: 'ref', name: 'Макет', type: 'FRAME',
        absoluteBoundingBox: { x: 2000, y: 0, width: 1000, height: 1000 },
        children: [
          { id: 'card', name: 'card', type: 'FRAME',
            absoluteBoundingBox: { x: 2000, y: 0, width: 1000, height: 1000 }, children: [] } as unknown as RawSceneNode,
        ] } as unknown as RawSceneNode,
    ],
  } as unknown as RawSceneNode;
}

// Board with TWO pin instances both carrying number "1" → duplicate_pin_numbers warning.
// Both pins sit inside the prod screenshot so they both appear in items, making count=2.
// Node IDs use Figma colon-form ('300:1', '400:1') so they are stable under normalizeNodeId.
// Pin '300:1' tip: {x:137, y:506} → atPercent ~{x:0.137, y:0.506}
// Pin '400:1' tip: {x:337, y:706} → atPercent ~{x:0.337, y:0.706}  ← distinguishable
function boardDupPins(): RawSceneNode {
  const t = (id: string, chars: string): RawSceneNode => ({
    id, name: chars, type: 'TEXT', characters: chars,
    absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
  } as unknown as RawSceneNode);
  return {
    id: '12:1', name: 'sec', type: 'SECTION',
    absoluteBoundingBox: { x: 0, y: 0, width: 4000, height: 2000 },
    children: [
      { id: 'prod', name: 'image 1', type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
        fills: [{ type: 'IMAGE', imageRef: 'r' }] } as unknown as RawSceneNode,
      { id: '300:1', name: 'Цифровой пин', type: 'INSTANCE',
        absoluteBoundingBox: { x: 100, y: 400, width: 74, height: 106 },
        children: [t('300:2', '1')] } as unknown as RawSceneNode,
      { id: '400:1', name: 'Цифровой пин', type: 'INSTANCE',
        absoluteBoundingBox: { x: 300, y: 600, width: 74, height: 106 },
        children: [t('400:2', '1')] } as unknown as RawSceneNode,
      { id: 'ref', name: 'Макет', type: 'FRAME',
        absoluteBoundingBox: { x: 2000, y: 0, width: 1000, height: 1000 },
        children: [
          { id: 'card', name: 'card', type: 'FRAME',
            absoluteBoundingBox: { x: 2000, y: 0, width: 1000, height: 1000 }, children: [] } as unknown as RawSceneNode,
        ] } as unknown as RawSceneNode,
    ],
  } as unknown as RawSceneNode;
}

// Board with TWO prod screenshots (two lanes), each containing a pin numbered 7.
// Lane 1 pin (500:1) has a >50-char comment attached via the comment field.
// Lane 2 pin (600:1) has NO comment (no comment field overlaps that lane's Y range).
// The two screenshots sit at different Y ranges so field binding is unambiguous.
function boardDupCrossLane(): RawSceneNode {
  const t = (id: string, chars: string, x = 0, y = 0): RawSceneNode => ({
    id, name: chars, type: 'TEXT', characters: chars,
    absoluteBoundingBox: { x, y, width: 30, height: 20 },
  } as unknown as RawSceneNode);

  // >50-char comment: 78 chars → snippet = first 49 chars + '…'
  const longComment = 'This is a very long comment that exceeds the fifty character limit for snippets';

  // Comment row for pin 7 in lane 1. Row name must NOT match comment-field regex.
  const commentRow7: RawSceneNode = {
    id: 'cr7', name: 'pin-7-entry', type: 'FRAME',
    absoluteBoundingBox: { x: 1100, y: 100, width: 200, height: 50 },
    children: [
      t('cr7-n', '7', 1100, 100),
      { id: 'cr7-t', name: 'body', type: 'TEXT', characters: longComment,
        absoluteBoundingBox: { x: 1120, y: 110, width: 180, height: 30 } } as unknown as RawSceneNode,
    ],
  } as unknown as RawSceneNode;

  // Comment field overlapping lane 1's Y range (y=0..1000) but NOT lane 2's (y=1200..2200).
  const commentField1: RawSceneNode = {
    id: 'cf1', name: 'Comments', type: 'FRAME',
    absoluteBoundingBox: { x: 1100, y: 0, width: 200, height: 1000 },
    children: [commentRow7],
  } as unknown as RawSceneNode;

  return {
    id: '12:1', name: 'sec', type: 'SECTION',
    absoluteBoundingBox: { x: 0, y: 0, width: 4000, height: 3000 },
    children: [
      // Lane 1: prod screenshot at y=0..1000, pin A at y=400
      { id: 'prod1', name: 'image 1', type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
        fills: [{ type: 'IMAGE', imageRef: 'r1' }] } as unknown as RawSceneNode,
      { id: '500:1', name: 'Цифровой пин', type: 'INSTANCE',
        absoluteBoundingBox: { x: 400, y: 400, width: 74, height: 106 },
        children: [t('500:2', '7')] } as unknown as RawSceneNode,
      commentField1,
      // Lane 2: prod screenshot at y=1200..2200, pin B at y=1600 (tip y=1706 ∈ [1200,2200])
      { id: 'prod2', name: 'image 2', type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 1200, width: 1000, height: 1000 },
        fills: [{ type: 'IMAGE', imageRef: 'r2' }] } as unknown as RawSceneNode,
      { id: '600:1', name: 'Цифровой пин', type: 'INSTANCE',
        absoluteBoundingBox: { x: 400, y: 1600, width: 74, height: 106 },
        children: [t('600:2', '7')] } as unknown as RawSceneNode,
    ],
  } as unknown as RawSceneNode;
}

// Board without a 'Макет' reference frame — pin sits inside the prod screenshot so
// atPercent + screenshotNodeId ARE resolved (coordinate path), but there is no reference
// frame candidate, so buildReviewBoard sets referenceNode=null + referenceReason='no_reference_frame'.
function boardNoRef(): RawSceneNode {
  return {
    id: '12:1', name: 'sec', type: 'SECTION',
    absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 2000 },
    children: [
      { id: 'prod', name: 'image 1', type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
        fills: [{ type: 'IMAGE', imageRef: 'r' }] } as unknown as RawSceneNode,
      { id: 'pin', name: 'Цифровой пин', type: 'INSTANCE',
        absoluteBoundingBox: { x: 400, y: 400, width: 74, height: 106 },
        children: [{ id: 'pin-n', name: '1', type: 'TEXT', characters: '1',
          absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 } } as unknown as RawSceneNode] } as unknown as RawSceneNode,
      // No 'Макет' frame → pickReferenceFrame returns null → referenceReason='no_reference_frame'
    ],
  } as unknown as RawSceneNode;
}

describe('get_pin_detail tool', () => {
  it('returns a focus crop + referenceNode context for a pin', async () => {
    const png = await new Jimp({ width: 200, height: 200, color: 0x3366ccff }).getBuffer('image/png');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })));
    const call = install(board(1));
    const res = await call({ file: 'k', board_node_id: '12:1', pin_number: 1 });
    const img = res.content.find((c) => c.type === 'image')!;
    const meta = JSON.parse(textOf(res.content.find((c) => c.type === 'text')));
    expect(img.mimeType).toBe('image/png');
    expect(meta.pin_number).toBe(1);
    expect(meta.referenceFrameNodeId).toBe('ref');
    expect(meta.target.screenshotNodeId).toBe('prod');
    expect(meta.region).toBeTruthy();
    expect(meta.source_scale).toBeGreaterThan(0);
  });

  it('errors when the pin number is not on the board', async () => {
    const call = install(board(1));
    const res = await call({ file: 'k', board_node_id: '12:1', pin_number: 99 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
  });

  it('returns text-only partial (no image block, isError falsy) when pin has no screenshot coordinate', async () => {
    // boardNoCoord() places pin tip at x≈5037 which is outside the prod screenshot (0..1000),
    // so buildReviewBoard gives atPercent=null / screenshotNodeId=null → tool takes the early
    // jsonResult path without calling renderFocusCrop (no fetch stub needed).
    const call = install(boardNoCoord());
    const res = await call({ file: 'k', board_node_id: '12:1', pin_number: 1 });
    expect(res.isError).toBeFalsy();
    expect(res.content.find((c) => c.type === 'image')).toBeUndefined();
    const meta = JSON.parse(res.content.find((c) => c.type === 'text')!.text);
    expect(meta.note).toMatch(/no screenshot coordinate/i);
    // referenceReason is set to 'no_reference_frame' because the pin fell into the no-shot
    // lane (no prodId → refFrame = null); the key must be present in the payload.
    expect('referenceReason' in meta).toBe(true);
  });

  it('errors with ambiguous message when pin number is duplicated on the board', async () => {
    // boardDupPins() has two INSTANCE nodes both carrying text "1"; both sit inside the prod
    // screenshot so buildReviewBoard detects two pins with the same number → emits the
    // duplicate_pin_numbers warning.  The tool counts occurrences (2 > 1) and throws.
    // The error must enumerate the candidate pinNodeIds so the caller can recover via pin_node_id.
    // Both pins share the SAME prod screenshot → same lane (lane 1), neither has a comment.
    const call = install(boardDupPins());
    const res = await call({ file: 'k', board_node_id: '12:1', pin_number: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/ambiguous/i);
    expect(res.content[0].text).toMatch(/pass pin_node_id/i);
    // the message lists each duplicated pin's node id
    expect(res.content[0].text).toContain('300:1');
    expect(res.content[0].text).toContain('400:1');
    // new format: lane index present, bare screenshot annotation removed
    expect(res.content[0].text).not.toMatch(/screenshot /); // bare screenshot annotation removed
    expect(res.content[0].text).toMatch(/lane \d+/);        // lane index present for candidates
  });

  it('annotates ambiguous candidates with lane index + comment snippet (cross-lane)', async () => {
    const call = install(boardDupCrossLane());
    const res = await call({ file: 'k', board_node_id: '12:1', pin_number: 7 });
    const msg = res.content[0].text;
    expect(res.isError).toBe(true);
    expect(msg).toMatch(/ambiguous/i);
    expect(msg).toMatch(/lane 1/);                 // first lane's candidate
    expect(msg).toMatch(/lane 2/);                 // second lane's candidate — lane index discriminates
    expect(msg).toMatch(/…/);                       // pin A's >50-char comment was truncated
    expect(msg).toContain('(no comment)');          // pin B has no linked comment
    expect(msg).not.toMatch(/screenshot /);         // bare screenshot annotation gone
  });

  it('addresses a duplicated pin number directly by pin_node_id (no ambiguous throw)', async () => {
    // boardDupPins has two pins numbered 1 with pinNodeIds '300:1' and '400:1'.
    // Selecting the second one ('400:1') by pin_node_id must succeed (no throw) and
    // return THAT pin's data, not the first pin's — proven by atPercent.x ≈ 0.337 (vs 0.137).
    const png = await new Jimp({ width: 200, height: 200, color: 0x3366ccff }).getBuffer('image/png');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })));
    const call = install(boardDupPins());
    const res = await call({ file: 'k', board_node_id: '12:1', pin_node_id: '400:1' });
    const img = res.content.find((c) => c.type === 'image')!;
    const meta = JSON.parse(textOf(res.content.find((c) => c.type === 'text')));
    expect(res.isError).toBeFalsy();
    expect(img).toBeTruthy();
    // Proves '400:1' was selected (not '300:1'): pin '400:1' tip x=337 → atPercent.x ≈ 0.337
    expect(meta.target.atPercent.x).toBeCloseTo(0.337, 2);
  });

  it('errors when pin_node_id is not on the board', async () => {
    const call = install(board(1));
    const res = await call({ file: 'k', board_node_id: '12:1', pin_node_id: '9999:1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
  });

  it('errors when both pin_number and pin_node_id are given', async () => {
    const call = install(board(1));
    const res = await call({ file: 'k', board_node_id: '12:1', pin_number: 1, pin_node_id: '999:1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/exactly one of pin_number or pin_node_id/i);
  });

  it('errors when neither pin_number nor pin_node_id is given', async () => {
    const call = install(board(1));
    const res = await call({ file: 'k', board_node_id: '12:1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/exactly one of pin_number or pin_node_id/i);
  });

  it('includes referenceReason in happy-path meta when pin has a coordinate but no reference frame', async () => {
    // boardNoRef() has a pin inside the prod screenshot (→ screenshotNodeId + atPercent ARE
    // resolved) but no 'Макет' frame at all. buildReviewBoard sets referenceNode=null and
    // referenceReason='no_reference_frame'. The tool MUST still take the image (happy) path
    // because the coordinate guard passes, and the meta MUST expose referenceReason so the
    // caller understands why referenceNode is null (the "honest-null" invariant).
    const png = await new Jimp({ width: 200, height: 200, color: 0x3366ccff }).getBuffer('image/png');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })));
    const call = install(boardNoRef());
    const res = await call({ file: 'k', board_node_id: '12:1', pin_number: 1 });
    // Must take the image path (coordinate existed → renderFocusCrop was invoked).
    const img = res.content.find((c) => c.type === 'image')!;
    expect(img).toBeDefined();
    expect(img.mimeType).toBe('image/png');
    const meta = JSON.parse(textOf(res.content.find((c) => c.type === 'text')));
    // referenceNode must be null (no reference frame → resolution failed).
    expect(meta.referenceNode).toBeNull();
    // referenceReason must be a non-null string explaining why (honest-null invariant).
    expect(typeof meta.referenceReason).toBe('string');
    expect(meta.referenceReason).toBeTruthy();
  });
});
