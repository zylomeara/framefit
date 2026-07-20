import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/review-board-profile.json';
import { detectPins, detectCommentRows, buildReviewBoard } from '../../src/domain/review-board.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const root = fixture as unknown as RawSceneNode;

describe('review-board detection', () => {
  it('detects digital pins with number from characters and tip at bottom-center', () => {
    const pins = detectPins(root, {});
    expect(pins.map((p) => p.number).sort((a, b) => a - b)).toEqual([1, 2, 9]);
    const p1 = pins.find((p) => p.number === 1)!;
    expect(p1.pinNodeId).toBe('12:107');
    expect(p1.tip).toEqual({ x: 219 + 74 / 2, y: 12 + 106 }); // bottom-center
  });

  it('detects comment rows with number + text', () => {
    const rows = detectCommentRows(root, {});
    expect(rows.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2]);
    const r1 = rows.find((r) => r.number === 1)!;
    expect(r1.commentNodeId).toBe('12:105');
    expect(r1.text).toContain('Кнопку выровнять по сетке');
  });

  it('skips nested comment-field frames — no bogus row and no duplicate', () => {
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
    } as unknown as RawSceneNode);

    const innerRow: RawSceneNode = {
      id: 'inner-row-1', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 },
      children: [makeText('inner-num', '2'), makeText('inner-body', 'Inner comment text')],
    } as unknown as RawSceneNode;

    const innerField: RawSceneNode = {
      id: 'inner-field', name: 'Поле комментариев inner', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 80 },
      children: [innerRow],
    } as unknown as RawSceneNode;

    const outerRow: RawSceneNode = {
      id: 'outer-row-1', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 },
      children: [makeText('outer-num', '1'), makeText('outer-body', 'Outer comment text')],
    } as unknown as RawSceneNode;

    const outerField: RawSceneNode = {
      id: 'outer-field', name: 'Поле комментариев outer', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 160 },
      // children: one real row + one nested comment-field frame (should be skipped as a row)
      children: [outerRow, innerField],
    } as unknown as RawSceneNode;

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 200 },
      children: [outerField],
    } as unknown as RawSceneNode;

    const rows = detectCommentRows(testRoot, {});
    // Expect exactly two rows: one from outer (#1) and one from inner (#2) — no duplicates, no bogus row
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(rows.find((r) => r.number === 1)!.commentNodeId).toBe('outer-row-1');
    expect(rows.find((r) => r.number === 2)!.commentNodeId).toBe('inner-row-1');
  });

  it('does NOT misdetect a narrow comment-row INSTANCE (numeric chip) inside a comment field as a pin', () => {
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
    } as unknown as RawSceneNode);

    // A narrow comment-row INSTANCE (width < 200) that carries a numeric chip.
    // Size-only marker heuristic would mistake it for a pin; the structural guard
    // (lives inside a comment-field frame) must exclude it.
    const narrowRow: RawSceneNode = {
      id: 'narrow-row', name: 'text', type: 'INSTANCE',
      absoluteBoundingBox: { x: 100, y: 100, width: 150, height: 60 },
      children: [makeText('nr-num', '1'), makeText('nr-body', 'A comment that wrapped narrow')],
    } as unknown as RawSceneNode;

    const commentField: RawSceneNode = {
      id: 'cf', name: 'Поле комментариев', type: 'FRAME',
      absoluteBoundingBox: { x: 80, y: 80, width: 200, height: 200 },
      children: [narrowRow],
    } as unknown as RawSceneNode;

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 400 },
      children: [commentField],
    } as unknown as RawSceneNode;

    expect(detectPins(testRoot, {})).toEqual([]);
  });
});

describe('review-board build', () => {
  it('links pins to comments by number and targets the prod screenshot', () => {
    const board = buildReviewBoard(root, {});
    const all = board.groups.flatMap((g) => g.items);
    const item1 = all.find((i) => i.number === 1)!;
    expect(item1.pinNodeId).toBe('12:107');
    expect(item1.commentNodeId).toBe('12:105');
    expect(item1.commentText).toContain('Кнопку выровнять по сетке');
    expect(item1.target.screenshotNodeId).toBe('12:101');
    // tip (256,118) inside screenshot (0,0,1526,877)
    expect(item1.target.atPercent!.x).toBeCloseTo(256 / 1526, 3);
    expect(item1.target.atPercent!.y).toBeCloseTo(118 / 877, 3);
  });

  it('reports pins with no matching comment as unmatched', () => {
    const board = buildReviewBoard(root, {});
    expect(board.unmatched.pinsWithoutComment).toContain(9);
  });

  it('warns when nothing is detected', () => {
    const empty = { id: 'x', name: 'x', type: 'FRAME', children: [] } as unknown as RawSceneNode;
    const board = buildReviewBoard(empty, {});
    expect(board.warnings).toContain('no_pins_detected');
    expect(board.warnings).toContain('no_comment_fields_detected');
  });

  it('reports commentsWithoutPin for rows whose number has no matching pin', () => {
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 60, height: 20 },
    } as unknown as RawSceneNode);

    // One pin numbered 1, small INSTANCE marker
    const pin1: RawSceneNode = {
      id: 'pin-1', name: 'pin 1', type: 'INSTANCE',
      absoluteBoundingBox: { x: 100, y: 100, width: 74, height: 106 },
      children: [makeText('pin-1-num', '1')],
    } as unknown as RawSceneNode;

    // Comment field with two rows: row 1 (has a pin) and row 5 (no matching pin)
    const row1: RawSceneNode = {
      id: 'row-1', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 400, y: 50, width: 300, height: 40 },
      children: [makeText('r1-num', '1'), makeText('r1-body', 'Comment for pin one')],
    } as unknown as RawSceneNode;

    const row5: RawSceneNode = {
      id: 'row-5', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 400, y: 100, width: 300, height: 40 },
      children: [makeText('r5-num', '5'), makeText('r5-body', 'Comment for missing pin five')],
    } as unknown as RawSceneNode;

    const commentField: RawSceneNode = {
      id: 'cf-1', name: 'Поле комментариев', type: 'FRAME',
      absoluteBoundingBox: { x: 400, y: 0, width: 300, height: 200 },
      children: [row1, row5],
    } as unknown as RawSceneNode;

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 400 },
      children: [pin1, commentField],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});
    expect(board.unmatched.commentsWithoutPin).toEqual([5]);
    expect(board.unmatched.pinsWithoutComment).toEqual([]);
  });

  it('groups by prod screenshot containment into two lanes, each pointing at its own screenshot', () => {
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
    } as unknown as RawSceneNode);
    const shot = (id: string, y: number): RawSceneNode => ({
      id, name: `Снимок экрана ${id}`, type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y, width: 1000, height: 600 },
      fills: [{ type: 'IMAGE', imageRef: 'ref' }],
    } as unknown as RawSceneNode);
    const pin = (id: string, num: string, x: number, y: number): RawSceneNode => ({
      id, name: 'Цифровой пин', type: 'INSTANCE',
      absoluteBoundingBox: { x, y, width: 74, height: 106 },
      children: [makeText(`${id}t`, num)],
    } as unknown as RawSceneNode);

    // Two prod screenshots at different Y; a pin sits on each (tip inside the shot's bbox).
    const shotA = shot('shot-A', 0);    // y 0..600
    const shotB = shot('shot-B', 1000); // y 1000..1600
    const pinA = pin('pin-A', '1', 100, 100);   // tip y ≈ 206 → inside shot-A
    const pinB = pin('pin-B', '2', 100, 1100);  // tip y ≈ 1206 → inside shot-B

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 1200, height: 1700 },
      children: [shotA, shotB, pinA, pinB],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});
    expect(board.groups).toHaveLength(2);
    // Lane ordered by ascending Y: lane 0 = shot-A, lane 1 = shot-B.
    const laneA = board.groups.find((g) => g.screenshots.prod?.node_id === 'shot-A')!;
    const laneB = board.groups.find((g) => g.screenshots.prod?.node_id === 'shot-B')!;
    expect(laneA).toBeTruthy();
    expect(laneB).toBeTruthy();
    expect(laneA.items.map((i) => i.number)).toEqual([1]);
    expect(laneB.items.map((i) => i.number)).toEqual([2]);
    expect(laneA.items[0].target.screenshotNodeId).toBe('shot-A');
    expect(laneB.items[0].target.screenshotNodeId).toBe('shot-B');
  });

  it('warns on duplicate pin numbers and does not cross-link a comment across lanes', () => {
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
    } as unknown as RawSceneNode);
    const shot = (id: string, y: number): RawSceneNode => ({
      id, name: `Снимок экрана ${id}`, type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y, width: 1000, height: 600 },
      fills: [{ type: 'IMAGE', imageRef: 'ref' }],
    } as unknown as RawSceneNode);
    const pin = (id: string, num: string, x: number, y: number): RawSceneNode => ({
      id, name: 'Цифровой пин', type: 'INSTANCE',
      absoluteBoundingBox: { x, y, width: 74, height: 106 },
      children: [makeText(`${id}t`, num)],
    } as unknown as RawSceneNode);

    // Two lanes (two screenshots). Both lanes have a pin numbered "1" (DUPLICATE).
    const shotA = shot('shot-A', 0);
    const shotB = shot('shot-B', 1000);
    const pinA = pin('pin-A', '1', 100, 100);   // lane A, tip inside shot-A
    const pinB = pin('pin-B', '1', 100, 1100);  // lane B, duplicate number 1

    // Comment row #1 sits in lane A's vertical range (y ≈ 50, near shot-A).
    const rowA: RawSceneNode = {
      id: 'row-A', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 50, width: 300, height: 40 },
      children: [makeText('rA-num', '1'), makeText('rA-body', 'Comment belonging to lane A')],
    } as unknown as RawSceneNode;
    const commentField: RawSceneNode = {
      id: 'cf-A', name: 'Поле комментариев', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 0, width: 300, height: 200 },
      children: [rowA],
    } as unknown as RawSceneNode;

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 1500, height: 1700 },
      children: [shotA, shotB, pinA, pinB, commentField],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});
    expect(board.warnings).toContain('duplicate_pin_numbers');
    expect(board.groups).toHaveLength(2);

    // Lane A's pin #1 gets the comment; lane B's pin #1 must NOT inherit lane A's text.
    const laneA = board.groups.find((g) => g.screenshots.prod?.node_id === 'shot-A')!;
    const laneB = board.groups.find((g) => g.screenshots.prod?.node_id === 'shot-B')!;
    const laneBItem = laneB.items.find((i) => i.number === 1)!;
    expect(laneBItem.commentText).toBeNull();
    expect(laneBItem.commentNodeId).toBeNull();
    // The comment that did match (lane A) keeps its text.
    const laneAItem = laneA.items.find((i) => i.number === 1)!;
    expect(laneAItem.commentText).toContain('lane A');
  });

  it('direct-links a board-wide-unique pin number to its single row even when placed far apart (variant C)', () => {
    // Reproduces the live bug: pin #6 on screenshot A, row #6 in a comment field ~611px away.
    // The Y-window (margin = max(LANE_GAP=400, pinHeight)) rejects the link → commentText: null.
    // Variant C: when exactly ONE pin carries number N AND exactly ONE row carries number N,
    // bypass the window entirely — false positive is impossible.
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 60, height: 20 },
    } as unknown as RawSceneNode);

    // Screenshot A at y=0..600, pin #6 sits on it (tip y ≈ 206, inside shot-A).
    const shotA: RawSceneNode = {
      id: 'shot-A', name: 'Снимок экрана A', type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 600 },
      fills: [{ type: 'IMAGE', imageRef: 'ref' }],
    } as unknown as RawSceneNode;

    const pin6: RawSceneNode = {
      id: 'pin-6', name: 'Цифровой пин', type: 'INSTANCE',
      absoluteBoundingBox: { x: 100, y: 100, width: 74, height: 106 },
      children: [makeText('pin-6-num', '6')],
    } as unknown as RawSceneNode;

    // Row #6 placed far below — 700px below the pin bbox bottom (100+106=206), well beyond
    // margin=max(400, 106)=400 → the window [100-400 .. 206+400] = [-300 .. 606] does NOT
    // reach y=817, so current code returns commentText: null.
    const row6: RawSceneNode = {
      id: 'row-6', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 817, width: 300, height: 40 },
      children: [makeText('r6-num', '6'), makeText('r6-body', 'QR code link must be absolute')],
    } as unknown as RawSceneNode;

    const commentField: RawSceneNode = {
      id: 'cf-main', name: 'Поле комментариев', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 800, width: 300, height: 200 },
      children: [row6],
    } as unknown as RawSceneNode;

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 1500, height: 1100 },
      children: [shotA, pin6, commentField],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});
    // No duplicate warning — numbers are unique board-wide.
    expect(board.warnings).not.toContain('duplicate_pin_numbers');
    expect(board.groups).toHaveLength(1);

    const item6 = board.groups[0].items.find((i) => i.number === 6)!;
    // KEY assertion: variant C must link pin #6 to row #6 despite the large Y gap.
    expect(item6.commentText).toBe('QR code link must be absolute');
    expect(item6.commentNodeId).toBe('row-6');

    // No unmatched entries.
    expect(board.unmatched.pinsWithoutComment).toEqual([]);
    expect(board.unmatched.commentsWithoutPin).toEqual([]);
  });

  it('variant C falls through when rows are not unique: unique pin #8 with TWO rows #8 → geom path picks near row', () => {
    // Verifies the strict two-sided gate: candidates.length === 2 so variant C does NOT fire.
    // The geometric path must then pick the near row (within window), not the far one.
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 60, height: 20 },
    } as unknown as RawSceneNode);

    // Screenshot at y=0..600; pin #8 sits on it (tip y ≈ 206, inside the shot).
    const shotA: RawSceneNode = {
      id: 'shot-A', name: 'Снимок экрана A', type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 600 },
      fills: [{ type: 'IMAGE', imageRef: 'ref' }],
    } as unknown as RawSceneNode;

    const pin8: RawSceneNode = {
      id: 'pin-8', name: 'Цифровой пин', type: 'INSTANCE',
      absoluteBoundingBox: { x: 100, y: 100, width: 74, height: 106 },
      children: [makeText('pin-8-num', '8')],
    } as unknown as RawSceneNode;

    // Near row #8: y=150, well inside the window [100-400 .. 206+400] = [-300 .. 606].
    const rowNear: RawSceneNode = {
      id: 'row-8-near', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 150, width: 300, height: 40 },
      children: [makeText('rn-num', '8'), makeText('rn-body', 'Near row text for pin eight')],
    } as unknown as RawSceneNode;

    // Far row #8: y=2000, outside the window → geom path skips it, should never be picked.
    const rowFar: RawSceneNode = {
      id: 'row-8-far', name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 2000, width: 300, height: 40 },
      children: [makeText('rf-num', '8'), makeText('rf-body', 'Far row text should not match')],
    } as unknown as RawSceneNode;

    const commentField: RawSceneNode = {
      id: 'cf-main', name: 'Поле комментариев', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 0, width: 300, height: 2100 },
      children: [rowNear, rowFar],
    } as unknown as RawSceneNode;

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 1500, height: 2200 },
      children: [shotA, pin8, commentField],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});
    // rows are NOT unique (two rows #8) → duplicate_pin_numbers NOT fired (only one pin #8),
    // but the duplicate_row side means variant C gate (candidates.length === 1) fails → fall-through.
    expect(board.groups).toHaveLength(1);

    const item8 = board.groups[0].items.find((i) => i.number === 8)!;
    // Geom path picks the NEAR row, not the far one.
    expect(item8.commentText).toBe('Near row text for pin eight');
    expect(item8.commentNodeId).toBe('row-8-near');
  });

  it('geometric disambiguation: per-screen-numbered boards link each pin to its nearest same-number row', () => {
    // Real-world boards often restart numbering per screen (screen A has pin #1, screen B has pin #1).
    // Under the old global-first-wins map, pin #1 on screen B would get screen A's row #1,
    // then the cross-lane guard would drop it → commentText: null. The fix must use proximity
    // so each pin gets ITS OWN local row.
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 60, height: 20 },
    } as unknown as RawSceneNode);
    const shot = (id: string, y: number): RawSceneNode => ({
      id, name: `Снимок экрана ${id}`, type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y, width: 1000, height: 600 },
      fills: [{ type: 'IMAGE', imageRef: 'ref' }],
    } as unknown as RawSceneNode);
    const pin = (id: string, num: string, x: number, y: number): RawSceneNode => ({
      id, name: 'Цифровой пин', type: 'INSTANCE',
      absoluteBoundingBox: { x, y, width: 74, height: 106 },
      children: [makeText(`${id}t`, num)],
    } as unknown as RawSceneNode);
    const makeRow = (id: string, num: string, body: string, y: number): RawSceneNode => ({
      id, name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y, width: 300, height: 40 },
      children: [makeText(`${id}-num`, num), makeText(`${id}-body`, body)],
    } as unknown as RawSceneNode);
    const makeField = (id: string, y: number, children: RawSceneNode[]): RawSceneNode => ({
      id, name: 'Поле комментариев', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y, width: 300, height: 200 },
      children,
    } as unknown as RawSceneNode);

    // Screen A: y=0..600, pin #1, comment field with row #1 "screen A note"
    const shotA = shot('shot-A', 0);
    const pinA = pin('pin-A', '1', 100, 100);   // tip y ≈ 206 inside shot-A
    const rowA1 = makeRow('row-A1', '1', 'screen A note', 50);
    const fieldA = makeField('field-A', 0, [rowA1]);

    // Screen B: y=1000..1600, pin #1 (numbering restarts!), comment field with row #1 "screen B note"
    const shotB = shot('shot-B', 1000);
    const pinB = pin('pin-B', '1', 100, 1100);  // tip y ≈ 1206 inside shot-B
    const rowB1 = makeRow('row-B1', '1', 'screen B note', 1050);
    const fieldB = makeField('field-B', 1000, [rowB1]);

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 1500, height: 1700 },
      children: [shotA, shotB, pinA, pinB, fieldA, fieldB],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});

    // Both pins are #1 → duplicate warning expected
    expect(board.warnings).toContain('duplicate_pin_numbers');
    expect(board.groups).toHaveLength(2);

    const laneA = board.groups.find((g) => g.screenshots.prod?.node_id === 'shot-A')!;
    const laneB = board.groups.find((g) => g.screenshots.prod?.node_id === 'shot-B')!;
    expect(laneA).toBeTruthy();
    expect(laneB).toBeTruthy();

    // KEY assertions: each pin gets ITS OWN local row, not the global-first one
    const itemA = laneA.items.find((i) => i.number === 1)!;
    const itemB = laneB.items.find((i) => i.number === 1)!;
    expect(itemA.commentText).toBe('screen A note');
    expect(itemA.commentNodeId).toBe('row-A1');
    expect(itemB.commentText).toBe('screen B note');
    expect(itemB.commentNodeId).toBe('row-B1');

    // No row is double-linked: the two links go to DIFFERENT nodes
    expect(itemA.commentNodeId).not.toBe(itemB.commentNodeId);

    // No orphaned comments
    expect(board.unmatched.commentsWithoutPin).toEqual([]);
  });

  it('variant A: shared comment-field across multiple screenshots links each pin to its field row by number, ignoring distance window', () => {
    // Scenario: shot-A (y=0..800) has its own field-A (y=0..200) with rows #1 and a decoy #2.
    // shot-B (y=2000..3000) has field-B (y=2000..2700) with row #2 at y=2650, which is OUTSIDE
    // the geometric window for shot-B's lane ([1600..2506]) so the geometric path returns null.
    // A decoy row #2 in field-A (also outside the window) defeats variant C's uniqueness gate.
    // Variant A binds shot-B to field-B by maximum vertical overlap (700px) and looks up row #2
    // directly inside that field — succeeding where geometry alone fails.
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 60, height: 20 },
    } as unknown as RawSceneNode);
    const makeShot = (id: string, y: number, h: number): RawSceneNode => ({
      id, name: `Снимок экрана ${id}`, type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y, width: 1000, height: h },
      fills: [{ type: 'IMAGE', imageRef: 'ref' }],
    } as unknown as RawSceneNode);
    const makePin = (id: string, num: string, x: number, y: number): RawSceneNode => ({
      id, name: 'Цифровой пин', type: 'INSTANCE',
      absoluteBoundingBox: { x, y, width: 74, height: 106 },
      children: [makeText(`${id}t`, num)],
    } as unknown as RawSceneNode);
    const makeRow = (id: string, num: string, body: string, y: number): RawSceneNode => ({
      id, name: 'row', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y, width: 300, height: 40 },
      children: [makeText(`${id}-num`, num), makeText(`${id}-body`, body)],
    } as unknown as RawSceneNode);

    // shot-A: y=0..800
    const shotA = makeShot('shot-A', 0, 800);
    // shot-B: y=2000..3000 (far below to create large gap)
    const shotB = makeShot('shot-B', 2000, 1000);

    // Pin #1 on shot-A (tip y = 100+106 = 206, inside shot-A y=0..800)
    const pinA1 = makePin('pin-A1', '1', 100, 100);
    // Pin #2 on shot-B (tip y = 2000+106 = 2106, inside shot-B y=2000..3000)
    const pinB2 = makePin('pin-B2', '2', 100, 2000);

    // field-A: y=0..200 — overlaps shot-A (200px overlap). Contains row #1 (close to pin-A1).
    const rowA1 = makeRow('row-A1', '1', 'note one on screen A', 50);
    // Also add a SECOND row #2 in field-A to make #2 non-unique (defeats variant C for pin #2).
    const rowA2_decoy = makeRow('row-A2-decoy', '2', 'decoy row two in field-A', 100);
    const fieldA: RawSceneNode = {
      id: 'field-A', name: 'Поле комментариев A', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 0, width: 300, height: 200 },
      children: [rowA1, rowA2_decoy],
    } as unknown as RawSceneNode;

    // field-B: y=2000..2700 — overlaps shot-B (700px overlap). Contains row #2 FAR from pin-B2's
    // bbox: row-B2 sits at y=2650 (outside window [2000-400..2106+400]=[1600..2506]).
    const rowB2 = makeRow('row-B2', '2', 'note two on screen B placed far', 2650);
    const fieldB: RawSceneNode = {
      id: 'field-B', name: 'Поле комментариев B', type: 'FRAME',
      absoluteBoundingBox: { x: 1100, y: 2000, width: 300, height: 700 },
      children: [rowB2],
    } as unknown as RawSceneNode;

    const testRoot: RawSceneNode = {
      id: 'root', name: 'root', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 1500, height: 3100 },
      children: [shotA, shotB, pinA1, pinB2, fieldA, fieldB],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});

    // #2 appears in two rows (rowA2_decoy + rowB2) → duplicate_pin_numbers warning fires
    // (hasDup checks rowNumberList which contains two #2s; pin numbers are unique — 1 and 2 — no dup there)
    // Actually hasDup checks BOTH pinNumberList and rowNumberList. pinNumberList=[1,2] (no dup),
    // rowNumberList=[1,2,2] → has dup → warning fires.
    expect(board.warnings).toContain('duplicate_pin_numbers');
    expect(board.groups).toHaveLength(2);

    const laneA = board.groups.find((g) => g.screenshots.prod?.node_id === 'shot-A')!;
    const laneB = board.groups.find((g) => g.screenshots.prod?.node_id === 'shot-B')!;
    expect(laneA).toBeTruthy();
    expect(laneB).toBeTruthy();

    const itemA1 = laneA.items.find((i) => i.number === 1)!;
    const itemB2 = laneB.items.find((i) => i.number === 2)!;

    // Pin #1 on shot-A: unique globally (#1 appears once) → variant C fires and links correctly.
    expect(itemA1.commentText).toBe('note one on screen A');
    expect(itemA1.commentNodeId).toBe('row-A1');

    // KEY assertion (variant A): pin #2 on shot-B should link to row-B2 "note two on screen B placed far"
    // even though row-B2 is at y=2650, OUTSIDE the geometric window [1600..2506] for shot-B's lane.
    // Without variant A, the geometric path returns null (both row-A2-decoy y=100 and row-B2 y=2650
    // are outside the window). Variant A binds shot-B to field-B by vertical overlap (700px),
    // then picks row #2 from field-B by number → links successfully.
    expect(itemB2.commentText).toBe('note two on screen B placed far');
    expect(itemB2.commentNodeId).toBe('row-B2');

    // No pins left unmatched.
    expect(board.unmatched.pinsWithoutComment).toEqual([]);
    // The decoy row (#2 in field-A) has no matching pin for IT specifically, but pin #2 exists →
    // commentsWithoutPin only lists numbers that have zero matching pins.
    // pin #2 exists → row #2 (even the decoy) is not "without pin".
    expect(board.unmatched.commentsWithoutPin).toEqual([]);
  });

  it('resolves a pin to the reference-frame node (real-page geometry)', () => {
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
    } as unknown as RawSceneNode);
    // Prod raster screenshot (lane), pin sits on it near the bottom (atPercent.y ≈ 0.857).
    const prod: RawSceneNode = {
      id: 'prod', name: 'image 16', type: 'RECTANGLE',
      absoluteBoundingBox: { x: 31423, y: -9979, width: 839, height: 1376 },
      fills: [{ type: 'IMAGE', imageRef: 'r' }],
    } as unknown as RawSceneNode;
    // tip at x=31862.9,y=-8799.6 → atPercent ≈ (0.524, 0.857) of prod.
    const pin: RawSceneNode = {
      id: 'pin', name: 'Цифровой пин', type: 'INSTANCE',
      absoluteBoundingBox: { x: 31826, y: -8906, width: 73.9, height: 106.4 },
      children: [makeText('pin-num', '1')],
    } as unknown as RawSceneNode;
    // Reference column (different X), vertically aligned; "bottom" band holds a "scroll card".
    const scrollCard: RawSceneNode = {
      id: 'scroll-card', name: 'scroll card', type: 'FRAME',
      absoluteBoundingBox: { x: 34330, y: -8823, width: 768, height: 194 },
      children: [],
    } as unknown as RawSceneNode;
    const bottom: RawSceneNode = {
      id: 'bottom', name: 'bottom', type: 'FRAME',
      absoluteBoundingBox: { x: 34330, y: -8823, width: 768, height: 194 },
      children: [scrollCard],
    } as unknown as RawSceneNode;
    const reference: RawSceneNode = {
      id: 'tablet', name: 'tablet', type: 'FRAME',
      absoluteBoundingBox: { x: 34330, y: -9979, width: 768, height: 1350 },
      children: [bottom],
    } as unknown as RawSceneNode;
    const testRoot: RawSceneNode = {
      id: 'sec', name: 'Корзина', type: 'SECTION',
      absoluteBoundingBox: { x: 31323, y: -13986, width: 7108, height: 7457 },
      children: [prod, pin, reference],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});
    const lane = board.groups.find((g) => g.screenshots.prod?.node_id === 'prod')!;
    expect(lane.screenshots.reference).toEqual({ node_id: 'tablet' });
    const item = lane.items.find((i) => i.number === 1)!;
    expect(item.target.referenceNode).not.toBeNull();
    expect(item.target.referenceNode!.suggested.name).toBe('scroll card');
    expect(item.target.nearestTargetNodeId).toBe('scroll-card'); // deepest leaf (scroll card has no children)
    // Real-page geometry: prod 839×1376 vs ref 768×1350 → scaleDiscrepancyPx ≈ 99 (ratio ≈ 0.073),
    // projected point lands ~1px from the "scroll card" band edge → margin ≈ 1 < 99 → honest low.
    const conf = item.target.referenceNode!.confidence!;
    expect(conf.level).toBe('low');
    expect(conf.scaleDiscrepancyPx).toBe(99);
    expect(conf.boundaryMarginPx).toBeLessThanOrEqual(2);
  });

  it('confidence discriminates per-pin within ONE lane (deep hit high, edge hit low)', () => {
    // Falsifies the old per-lane behaviour: two pins on the SAME prod screenshot share one
    // scaleDiscrepancyPx, yet must get DIFFERENT levels driven by their per-pin margin.
    const num = (id: string, n: string): RawSceneNode => ({
      id, name: n, type: 'TEXT', characters: n,
      absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 16 },
    } as unknown as RawSceneNode);
    // prod 800×900 raster. ref 768×1000 in a different column, vertically aligned → discrepancy 142.
    const prod: RawSceneNode = {
      id: 'prod', name: 'image', type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 900 },
      fills: [{ type: 'IMAGE', imageRef: 'r' }],
    } as unknown as RawSceneNode;
    // pin A tip (400,270) → atPercent (0.5,0.3) → ref (2384,300) = centre of big zone → margin 200 → high.
    const pinA: RawSceneNode = {
      id: 'pinA', name: 'пин', type: 'INSTANCE',
      absoluteBoundingBox: { x: 363, y: 164, width: 74, height: 106 },
      children: [num('pinA-n', '1')],
    } as unknown as RawSceneNode;
    // pin B tip (400,560) → atPercent (0.5,0.622) → ref (2384,622) = inside thin edge zone → margin 18 → low.
    const pinB: RawSceneNode = {
      id: 'pinB', name: 'пин', type: 'INSTANCE',
      absoluteBoundingBox: { x: 363, y: 454, width: 74, height: 106 },
      children: [num('pinB-n', '2')],
    } as unknown as RawSceneNode;
    const bigZone: RawSceneNode = {
      id: 'big', name: 'big zone', type: 'FRAME',
      absoluteBoundingBox: { x: 2000, y: 100, width: 768, height: 400 }, children: [],
    } as unknown as RawSceneNode;
    const edgeZone: RawSceneNode = {
      id: 'edge', name: 'edge zone', type: 'FRAME',
      absoluteBoundingBox: { x: 2000, y: 600, width: 768, height: 40 }, children: [],
    } as unknown as RawSceneNode;
    const reference: RawSceneNode = {
      id: 'maket', name: 'Макет', type: 'FRAME',
      absoluteBoundingBox: { x: 2000, y: 0, width: 768, height: 1000 },
      children: [bigZone, edgeZone],
    } as unknown as RawSceneNode;
    const testRoot: RawSceneNode = {
      id: 'sec', name: 'sec', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 3000, height: 1100 },
      children: [prod, pinA, pinB, reference],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});
    const lane = board.groups.find((g) => g.screenshots.prod?.node_id === 'prod')!;
    const a = lane.items.find((i) => i.number === 1)!;
    const b = lane.items.find((i) => i.number === 2)!;
    // Same lane ⇒ identical scaleDiscrepancyPx, but different per-pin level.
    expect(a.target.referenceNode!.confidence!.scaleDiscrepancyPx)
      .toBe(b.target.referenceNode!.confidence!.scaleDiscrepancyPx);
    expect(a.target.referenceNode!.suggested.name).toBe('big zone');
    expect(b.target.referenceNode!.suggested.name).toBe('edge zone');
    expect(a.target.referenceNode!.confidence!.level).toBe('high');
    expect(b.target.referenceNode!.confidence!.level).toBe('low');
  });

  it('emits referenceReason and null referenceNode when the lane has no aligned reference', () => {
    const makeText = (id: string, chars: string): RawSceneNode => ({
      id, name: chars, type: 'TEXT', characters: chars,
      absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 },
    } as unknown as RawSceneNode);
    const prod: RawSceneNode = {
      id: 'prod', name: 'Снимок экрана', type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 600 },
      fills: [{ type: 'IMAGE', imageRef: 'r' }],
    } as unknown as RawSceneNode;
    const pin: RawSceneNode = {
      id: 'pin', name: 'Цифровой пин', type: 'INSTANCE',
      absoluteBoundingBox: { x: 100, y: 100, width: 74, height: 106 },
      children: [makeText('pin-num', '1')],
    } as unknown as RawSceneNode;
    const testRoot: RawSceneNode = {
      id: 'sec', name: 'sec', type: 'SECTION',
      absoluteBoundingBox: { x: 0, y: 0, width: 1200, height: 800 },
      children: [prod, pin],
    } as unknown as RawSceneNode;

    const board = buildReviewBoard(testRoot, {});
    const item = board.groups[0].items.find((i) => i.number === 1)!;
    expect(item.target.referenceNode).toBeNull();
    expect(item.target.referenceReason).toBe('no_reference_frame');
    expect(item.target.nearestTargetNodeId).toBeNull();
  });
});
