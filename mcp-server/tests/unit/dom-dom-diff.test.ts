// compare_dom_to_dom domain core (feedback item 16). The two load-bearing locks come straight
// from the panel's CONFIRMED worked examples:
//  1. BYTE-IDENTICAL states on a padded, bordered root produce a CLEAN report - the naive
//     projection failed every edge row and size.w by the root's whole border+padding, because
//     content-edge math subtracts them on the candidate side only. The projection normalizes
//     the reference to its PADDING BOX and carries reference.paddings as autoLayout.padding
//     (the one deliberate exception to never-fabricate: it is the only root-padding slot the
//     engine reads).
//  2. The vault acceptance (skeleton first card at y=306 vs loaded 366) surfaces as the
//     padding-top row (offset-cross on a column axis measures X) with delta 60 - and the
//     printed numbers match ONLY under that same normalization.
import { describe, it, expect } from 'vitest';
import { diffDomPair } from '../../src/domain/layout-spec/dom-dom.js';
import type { DomSnapshotOk } from '../../src/domain/layout-spec/types.js';

// A padded, bordered list root with card children - the shape that broke the naive projection.
const state = (firstCardY: number, opts: { bg?: string } = {}): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.shelf', innerWidth: 768,
  rect: { x: 0, y: 0, w: 768, h: 900 },
  borders: { top: 1, right: 1, bottom: 1, left: 1 },
  paddings: { top: 24, right: 16, bottom: 24, left: 16 },
  clientWidth: 766, clientHeight: 898, scrollHeight: 898,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', backgroundColor: opts.bg ?? '#ffffff', borderRadius: 0, opacity: 1 },
  children: [
    { kind: 'element', tag: 'div', rect: { x: 17, y: firstCardY, w: 734, h: 140 } },
    { kind: 'element', tag: 'div', rect: { x: 17, y: firstCardY + 156, w: 734, h: 140 } },
    { kind: 'element', tag: 'div', rect: { x: 17, y: firstCardY + 312, w: 734, h: 140 } },
  ],
});

describe('diffDomPair - the two panel locks', () => {
  it('LOCK 1: byte-identical padded+bordered states -> zero fails, zero warns on geometry', () => {
    const a = state(366), b = state(366);
    const rows = diffDomPair(a, b, { tolerancePx: 1 });
    const bad = rows.filter((r) => r.status === 'fail' || (r.status === 'warn' && !/border/.test(r.note ?? '')));
    expect(bad).toEqual([]);
  });
  it('LOCK 2 (vault acceptance): skeleton 306 vs loaded 366 -> padding-top row, delta 60, FAIL', () => {
    const reference = state(366);   // loaded state = the reference
    const candidate = state(306);   // skeleton = the candidate
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const pt = rows.find((r) => r.prop === 'padding-top');
    expect(pt?.status).toBe('fail');
    expect(pt?.figma).toBe(341);    // 366 - (border 1 + padding 24): the reference prints its content-edge inset
    expect(pt?.dom).toBe(281);      // 306 - 25, same content-edge math on the candidate
    expect(Math.abs((pt?.figma as number) - (pt?.dom as number))).toBe(60); // the Δ60 the vault names
  });
  it('LOCK 2b: after the fix (both at 366) the padding-top row passes', () => {
    const rows = diffDomPair(state(366), state(366), { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'padding-top')?.status).toBe('pass');
  });
});
