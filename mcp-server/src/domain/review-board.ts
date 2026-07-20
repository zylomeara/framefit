// Pure logic for extracting design-review-board annotations from a raw Figma subtree.
// A "review board" packs, per screen/state ("lane"): a prod screenshot (raster RECTANGLE)
// with numbered pin markers on top, a "comment field" frame of numbered rows, and a
// reference frame. Pins link to comment rows BY NUMBER (board-wide sequential).
// Geometry is used only for lane grouping and pin→screenshot targeting.
import type { RawSceneNode } from './figma-raw.js';
import { pickReferenceFrame, resolveReferenceNode, type ReferenceNode } from './resolve-target.js';

export interface Box { x: number; y: number; w: number; h: number }
export interface Pin { number: number; pinNodeId: string; tip: { x: number; y: number }; bbox: Box }
export interface CommentRow { number: number; text: string; commentNodeId: string; bbox: Box; commentFieldId: string }
export interface DetectOpts { pinName?: string; commentFieldName?: string; referenceName?: string; includeBounds?: boolean }

const DEFAULT_PIN_NAME = /пин|pin/i;
const DEFAULT_COMMENT_FIELD_NAME = /коммент|comment|note|замеч/i;

function box(n: RawSceneNode): Box | null {
  const b = n.absoluteBoundingBox;
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
}

function walk(n: RawSceneNode, fn: (n: RawSceneNode) => void): void {
  fn(n);
  for (const c of n.children ?? []) walk(c, fn);
}

// Like walk, but carries an `insideCommentField` flag that flips true once we descend
// into a frame whose name matches the comment-field pattern (and stays true for all
// descendants). Lets detectPins exclude candidates that live inside a comment field.
function walkWithCommentField(
  n: RawSceneNode,
  re: RegExp,
  insideCommentField: boolean,
  fn: (n: RawSceneNode, insideCommentField: boolean) => void,
): void {
  const inside = insideCommentField || re.test(n.name);
  fn(n, inside);
  for (const c of n.children ?? []) walkWithCommentField(c, re, inside, fn);
}

// The first short-numeric TEXT descendant's characters → integer, else null.
function numericText(n: RawSceneNode): number | null {
  let found: number | null = null;
  walk(n, (d) => {
    if (found !== null) return;
    if (d.type === 'TEXT' && typeof d.characters === 'string' && /^\d{1,3}$/.test(d.characters.trim())) {
      found = parseInt(d.characters.trim(), 10);
    }
  });
  return found;
}

export function detectPins(root: RawSceneNode, opts: DetectOpts): Pin[] {
  const re = opts.pinName ? new RegExp(opts.pinName, 'i') : DEFAULT_PIN_NAME;
  const commentFieldRe = opts.commentFieldName ? new RegExp(opts.commentFieldName, 'i') : DEFAULT_COMMENT_FIELD_NAME;
  const pins: Pin[] = [];
  walkWithCommentField(root, commentFieldRe, false, (n, insideCommentField) => {
    if (n.type !== 'INSTANCE') return;
    // Structural guard: a comment row is also an INSTANCE carrying a numeric chip, and a
    // narrow one would pass the size-only marker heuristic. Anything inside a comment-field
    // frame is a comment row, never a pin — exclude it regardless of name/size.
    if (insideCommentField) return;
    const nameHit = re.test(n.name);
    const num = numericText(n);
    // pin = instance whose name matches OR which is a small marker carrying a number
    const b = box(n);
    if (!b || num === null) return;
    // pin markers are ~74×106 px on real boards; 200 is a safe upper bound for the size-only fallback.
    const looksLikeMarker = b.w < 200 && b.h < 200;
    if (!nameHit && !looksLikeMarker) return;
    pins.push({ number: num, pinNodeId: n.id, bbox: b, tip: { x: b.x + b.w / 2, y: b.y + b.h } });
  });
  return pins;
}

export function detectCommentRows(root: RawSceneNode, opts: DetectOpts): CommentRow[] {
  const re = opts.commentFieldName ? new RegExp(opts.commentFieldName, 'i') : DEFAULT_COMMENT_FIELD_NAME;
  const rows: CommentRow[] = [];
  walk(root, (frame) => {
    if (!re.test(frame.name)) return;
    for (const row of frame.children ?? []) {
      // Skip nested comment-field frames — the DFS walk will process them on their own visit.
      // Without this guard, a nested frame would produce a bogus row (from the outer) AND
      // a duplicate correct row (from its own DFS visit).
      if (re.test(row.name)) continue;
      const num = numericText(row);
      if (num === null) continue;
      // longest TEXT descendant that is NOT the number chip = the comment body
      let bestText: string | null = null;
      let bestLen = 0;
      walk(row, (d) => {
        if (d.type === 'TEXT' && typeof d.characters === 'string' && !/^\d{1,3}$/.test(d.characters.trim())) {
          const len = d.characters.length;
          if (len > bestLen) { bestText = d.characters; bestLen = len; }
        }
      });
      const b = box(row);
      if (bestText !== null && b) rows.push({ number: num, text: bestText, commentNodeId: row.id, bbox: b, commentFieldId: frame.id });
    }
  });
  return rows;
}

export interface Target {
  screenshotNodeId: string | null;
  atPercent: { x: number; y: number } | null;
  atAbsolute: { x: number; y: number };
  nearestTargetNodeId: string | null;
  referenceNode: ReferenceNode | null;
  referenceReason?: string; // when referenceNode is null: 'no_reference_frame' | 'no_screenshot_coordinate' | 'point_outside_reference'
}
export interface ReviewItem {
  number: number; commentText: string | null;
  pinNodeId: string; commentNodeId: string | null; target: Target;
}
export interface Lane {
  group: string; bounds: Box;
  screenshots: { prod: { node_id: string; url?: string } | null; reference: { node_id: string } | null };
  items: ReviewItem[];
}
export interface ReviewBoard {
  groups: Lane[];
  unmatched: { pinsWithoutComment: number[]; commentsWithoutPin: number[] };
  warnings: string[];
}

// Raster screenshots are RECTANGLEs (image fill) named like "Снимок экрана …", "IMG_…", "image …".
function isProdScreenshot(n: RawSceneNode): boolean {
  return n.type === 'RECTANGLE' && (n.fills ?? []).some((f) => f.type === 'IMAGE');
}
function contains(b: Box, p: { x: number; y: number }): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}
function unionBox(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bot = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bot - y };
}

export function buildReviewBoard(root: RawSceneNode, opts: DetectOpts): ReviewBoard {
  const pins = detectPins(root, opts);
  const rows = detectCommentRows(root, opts);
  const warnings: string[] = [];
  if (pins.length === 0) warnings.push('no_pins_detected');
  if (rows.length === 0) warnings.push('no_comment_fields_detected');

  // Collect prod screenshots and reference frames (top-level non-pin/non-comment frames).
  const screenshots: RawSceneNode[] = [];
  walk(root, (n) => { if (isProdScreenshot(n)) screenshots.push(n); });

  // Reference ("Макет") frames: top-level container columns that aren't screenshots, pins, or
  // comment fields. Detected structurally (the aligned non-screenshot column), not by name.
  const refPinRe = opts.pinName ? new RegExp(opts.pinName, 'i') : DEFAULT_PIN_NAME;
  const refCommentRe = opts.commentFieldName ? new RegExp(opts.commentFieldName, 'i') : DEFAULT_COMMENT_FIELD_NAME;
  const refNameRe = opts.referenceName ? new RegExp(opts.referenceName, 'i') : null;
  const REFERENCE_CONTAINER = new Set(['FRAME', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET']);
  const refCandidates = (root.children ?? []).filter((c) => {
    if (!REFERENCE_CONTAINER.has(c.type)) return false;
    if (!c.children || c.children.length === 0) return false;
    if (refPinRe.test(c.name) || refCommentRe.test(c.name)) return false;
    if (refNameRe && !refNameRe.test(c.name)) return false; // optional override narrows candidates
    return true;
  });
  const screenshotToReference = new Map<string, RawSceneNode>();
  const screenshotBoxById = new Map<string, Box>();
  for (const s of screenshots) {
    const sb = box(s);
    if (!sb) continue;
    screenshotBoxById.set(s.id, sb);
    const ref = pickReferenceFrame(sb, refCandidates);
    if (ref) screenshotToReference.set(s.id, ref);
  }

  // Fix #3 — duplicate-number safety. Board-wide sequential numbering is the verified
  // assumption; warn honestly when it doesn't hold (links would otherwise be ambiguous).
  const pinNumberList = pins.map((p) => p.number);
  const rowNumberList = rows.map((r) => r.number);
  const hasDup = (xs: number[]): boolean => new Set(xs).size !== xs.length;
  if (hasDup(pinNumberList) || hasDup(rowNumberList)) warnings.push('duplicate_pin_numbers');

  // Geometric disambiguation: index ALL rows per number (not first-wins).
  // When numbering restarts per screen, a pin's "best" row is the one whose vertical
  // centre is closest to the pin's lane — not whichever row happened to appear first
  // in DFS order. Dedup is enforced via a `usedRowIds` set so no row links twice.
  const rowsByNumber = new Map<number, CommentRow[]>();
  for (const r of rows) {
    const bucket = rowsByNumber.get(r.number);
    if (bucket) bucket.push(r); else rowsByNumber.set(r.number, [r]);
  }

  // Variant C: count how many pins carry each number so we can detect board-wide-unique pairs.
  const pinNumberCount = new Map<number, number>();
  for (const p of pins) pinNumberCount.set(p.number, (pinNumberCount.get(p.number) ?? 0) + 1);

  // Variant A pre-computation — bind each prod screenshot to the comment-field with maximum
  // vertical overlap, then index rows by (fieldId, number) for O(1) lookup during lane building.

  // Step 1: group rows by commentFieldId and compute each field's Y-interval.
  const fieldRowsMap = new Map<string, CommentRow[]>();
  for (const r of rows) {
    const bucket = fieldRowsMap.get(r.commentFieldId);
    if (bucket) bucket.push(r); else fieldRowsMap.set(r.commentFieldId, [r]);
  }
  const fieldYInterval = new Map<string, { yMin: number; yMax: number }>();
  for (const [fid, frows] of fieldRowsMap) {
    const yMin = Math.min(...frows.map((r) => r.bbox.y));
    const yMax = Math.max(...frows.map((r) => r.bbox.y + r.bbox.h));
    fieldYInterval.set(fid, { yMin, yMax });
  }

  // Step 2: for each prod screenshot, find the field with maximum vertical overlap.
  const screenshotToFieldId = new Map<string, string>();
  for (const s of screenshots) {
    const sb = box(s);
    if (!sb) continue;
    const sTop = sb.y;
    const sBot = sb.y + sb.h;
    let bestFieldId: string | null = null;
    let bestOverlap = 0;
    for (const [fid, interval] of fieldYInterval) {
      const overlap = Math.max(0, Math.min(sBot, interval.yMax) - Math.max(sTop, interval.yMin));
      // Strict `>` means equal overlap keeps the first field seen in traversal order — acceptable
      // because two distinct fields sharing identical vertical overlap with one screenshot is not
      // a realistic board layout.
      if (overlap > bestOverlap) { bestOverlap = overlap; bestFieldId = fid; }
    }
    if (bestFieldId !== null) screenshotToFieldId.set(s.id, bestFieldId);
  }

  // Step 3: index rows by (fieldId → (number → CommentRow[])) for fast variant A lookup.
  const rowsByFieldAndNumber = new Map<string, Map<number, CommentRow[]>>();
  for (const r of rows) {
    let byNum = rowsByFieldAndNumber.get(r.commentFieldId);
    if (!byNum) { byNum = new Map(); rowsByFieldAndNumber.set(r.commentFieldId, byNum); }
    const bucket = byNum.get(r.number);
    if (bucket) bucket.push(r); else byNum.set(r.number, [r]);
  }

  // Compute each pin's containing prod screenshot (the one whose bbox holds the pin tip).
  // This is the PRIMARY lane key (Fix #2): pins on the same screenshot form one lane.
  type Built = ReviewItem & { _laneY: number; _bbox: Box; _candidatePinNumber: number };
  const items: Built[] = pins.map((pin) => {
    const shot = screenshots.find((s) => { const b = box(s); return b !== null && contains(b, pin.tip); }) ?? null;
    const shotBox = shot ? box(shot) : null;
    const target: Target = {
      screenshotNodeId: shot?.id ?? null,
      atPercent: shotBox ? { x: (pin.tip.x - shotBox.x) / shotBox.w, y: (pin.tip.y - shotBox.y) / shotBox.h } : null,
      atAbsolute: pin.tip,
      nearestTargetNodeId: null,
      referenceNode: null,
    };
    // Defer comment linking until lanes are known — we only commit a link when the row
    // plausibly belongs to the pin's lane (Fix #3 cross-lane guard, now with geometry).
    return {
      number: pin.number,
      commentText: null,
      pinNodeId: pin.pinNodeId,
      commentNodeId: null,
      target,
      _laneY: pin.bbox.y,
      _bbox: pin.bbox,
      _candidatePinNumber: pin.number,
    };
  });

  // Fix #2 — group by the prod screenshot each pin sits on. Pins sharing a screenshot
  // form one lane; that screenshot IS the lane's prod (no "first non-null wins"). Pins
  // with no containing screenshot fall back to Y-gap clustering.
  const LANE_GAP = 400; // px; fallback lanes are separated by large vertical gaps
  const lanes: Lane[] = [];
  // Dedup set: a comment row may link to at most one pin board-wide.
  // Lanes are emitted in ascending-Y order so the geometrically nearer lane claims first.
  const usedRowIds = new Set<string>();
  const buildLane = (group: Built[], prodId: string | null): void => {
    if (!group.length) return;
    // Range of this lane's pins, expanded by a margin, used to vet candidate comment rows.
    const yMin = Math.min(...group.map((i) => i._bbox.y));
    const yMax = Math.max(...group.map((i) => i._bbox.y + i._bbox.h));
    const laneCenter = (yMin + yMax) / 2;
    const margin = Math.max(LANE_GAP, yMax - yMin); // generous: half-board span is "near"
    const refFrame = prodId ? screenshotToReference.get(prodId) ?? null : null;
    const prodBox = prodId ? screenshotBoxById.get(prodId) ?? null : null;
    const resolveTarget = (t: Target): void => {
      // refFrame implies the prod screenshot had a box, so prodBox is non-null here; the
      // combined guard keeps it type-safe and collapses both "no usable reference" cases.
      if (!refFrame || !prodBox) { t.referenceNode = null; t.referenceReason = 'no_reference_frame'; return; }
      if (!t.atPercent) { t.referenceNode = null; t.referenceReason = 'no_screenshot_coordinate'; return; }
      const r = resolveReferenceNode(refFrame, t.atPercent, prodBox, { includeBounds: opts.includeBounds });
      if (r.ok) { t.referenceNode = r.node; t.nearestTargetNodeId = r.node.nodeId; }
      else { t.referenceNode = null; t.referenceReason = r.reason; }
    };
    const items = group.map(({ _laneY, _bbox, _candidatePinNumber, ...rest }) => {
      resolveTarget(rest.target);
      // Variant A — field-binding: if the pin's screenshot is bound to a comment-field (by
      // maximum vertical overlap), look for an unused row with the same number inside THAT
      // field and pick the nearest by Y-centre — no distance window needed because the field
      // IS the pin's own screen's annotation field.
      const boundFieldId = rest.target.screenshotNodeId
        ? screenshotToFieldId.get(rest.target.screenshotNodeId)
        : undefined;
      if (boundFieldId !== undefined) {
        const fieldRows = rowsByFieldAndNumber.get(boundFieldId)?.get(_candidatePinNumber) ?? [];
        let bestFieldRow: CommentRow | null = null;
        let bestFieldDist = Infinity;
        const pinCenter = _bbox.y + _bbox.h / 2;
        for (const r of fieldRows) {
          if (usedRowIds.has(r.commentNodeId)) continue;
          const rowCenter = r.bbox.y + r.bbox.h / 2;
          const dist = Math.abs(rowCenter - pinCenter);
          if (dist < bestFieldDist) { bestFieldDist = dist; bestFieldRow = r; }
        }
        if (bestFieldRow !== null) {
          usedRowIds.add(bestFieldRow.commentNodeId);
          return { ...rest, commentText: bestFieldRow.text, commentNodeId: bestFieldRow.commentNodeId };
        }
      }

      // Variant C — direct-link when the number is board-wide-unique on BOTH sides:
      // exactly 1 pin carries this number AND exactly 1 row carries this number.
      // A false positive is impossible in that case, so skip the Y-window entirely.
      const candidates = rowsByNumber.get(_candidatePinNumber) ?? [];
      if (
        pinNumberCount.get(_candidatePinNumber) === 1 &&
        candidates.length === 1 &&
        // Defensive: a unique pin belongs to exactly one lane, so its row cannot have been
        // claimed by an earlier lane — this guard is theoretically unreachable but kept to
        // protect against future refactors that break the one-pin-per-lane invariant.
        !usedRowIds.has(candidates[0].commentNodeId)
      ) {
        const uniqueRow = candidates[0];
        usedRowIds.add(uniqueRow.commentNodeId);
        return { ...rest, commentText: uniqueRow.text, commentNodeId: uniqueRow.commentNodeId };
      }

      // Geometric disambiguation (Fix #3 + per-screen-numbering fix):
      // Among ALL rows sharing this pin's number, pick the unused one whose vertical centre
      // is nearest the lane's Y-range AND falls within the acceptance window (± margin).
      // This correctly handles per-screen pin numbering where the same number appears in
      // multiple lanes — each pin gets its own local row rather than the global-first one.
      let bestRow: CommentRow | null = null;
      let bestDist = Infinity;
      for (const r of candidates) {
        if (usedRowIds.has(r.commentNodeId)) continue;
        const rowInRange = r.bbox.y >= yMin - margin && r.bbox.y <= yMax + margin;
        if (!rowInRange) continue;
        const rowCenter = r.bbox.y + r.bbox.h / 2;
        const dist = Math.abs(rowCenter - laneCenter);
        if (dist < bestDist) { bestDist = dist; bestRow = r; }
      }
      if (bestRow !== null) {
        usedRowIds.add(bestRow.commentNodeId);
        return { ...rest, commentText: bestRow.text, commentNodeId: bestRow.commentNodeId };
      }
      return rest;
    });
    lanes.push({
      group: `lane-${lanes.length + 1}`,
      bounds: unionBox(group.map((i) => i._bbox)),
      screenshots: { prod: prodId ? { node_id: prodId } : null, reference: refFrame ? { node_id: refFrame.id } : null },
      items,
    });
  };

  // Primary grouping: bucket by containing screenshot id.
  const byScreenshot = new Map<string, Built[]>();
  const noShot: Built[] = [];
  for (const it of items) {
    const sid = it.target.screenshotNodeId;
    if (sid === null) { noShot.push(it); continue; }
    const bucket = byScreenshot.get(sid);
    if (bucket) bucket.push(it); else byScreenshot.set(sid, [it]);
  }

  // Order screenshot-backed lanes by ascending min pin-Y.
  const screenshotLanes = [...byScreenshot.entries()]
    .map(([sid, group]) => ({ sid, group, minY: Math.min(...group.map((i) => i._bbox.y)) }))
    .sort((a, b) => a.minY - b.minY);

  // Fallback: Y-gap clustering for pins with no containing screenshot.
  const noShotLanes: Built[][] = [];
  noShot.sort((a, b) => a._laneY - b._laneY);
  let current: Built[] = [];
  for (const it of noShot) {
    if (current.length && it._laneY - current[current.length - 1]._laneY > LANE_GAP) {
      noShotLanes.push(current); current = [];
    }
    current.push(it);
  }
  if (current.length) noShotLanes.push(current);

  // Emit all lanes ordered by ascending min Y (screenshot lanes + fallback lanes interleaved).
  const allLaneGroups: { minY: number; group: Built[]; prodId: string | null }[] = [
    ...screenshotLanes.map((l) => ({ minY: l.minY, group: l.group, prodId: l.sid })),
    ...noShotLanes.map((g) => ({ minY: Math.min(...g.map((i) => i._bbox.y)), group: g, prodId: null as string | null })),
  ].sort((a, b) => a.minY - b.minY);
  for (const l of allLaneGroups) buildLane(l.group, l.prodId);

  const matchedNumbers = new Set(
    lanes.flatMap((l) => l.items).filter((i) => i.commentNodeId).map((i) => i.number),
  );
  const pinNumbers = new Set(pinNumberList);
  return {
    groups: lanes,
    unmatched: {
      pinsWithoutComment: [...pinNumbers].filter((n) => !matchedNumbers.has(n)).sort((a, b) => a - b),
      commentsWithoutPin: rowNumberList.filter((n) => !pinNumbers.has(n)).sort((a, b) => a - b),
    },
    warnings,
  };
}
