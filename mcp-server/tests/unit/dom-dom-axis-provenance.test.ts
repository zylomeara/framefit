// Axis inference honesty + the provenance-silence spy (the 0.19.0 producer-census lesson: a
// new producer's FULL row-prop population is asserted against an allowlist, so a Figma-only
// axis leaking into dom-dom - component identity, token/mode machinery, hug/gutter demotes,
// style_anchor - fails the census, not a reader's eye).
import { describe, it, expect } from 'vitest';
import { diffDomPair, inferAxis } from '../../src/domain/layout-spec/dom-dom.js';
import type { DomSnapshotOk, DomChild } from '../../src/domain/layout-spec/types.js';

const el = (x: number, y: number, w: number, h: number, extra: Partial<DomChild> = {}): DomChild =>
  ({ kind: 'element', tag: 'div', rect: { x, y, w, h }, ...extra });
const snap = (children: DomChild[], over: Partial<DomSnapshotOk> = {}): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.x', innerWidth: 768,
  rect: { x: 0, y: 0, w: 600, h: 600 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 600, clientHeight: 600, scrollHeight: 600,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', backgroundColor: '#ffffff', borderRadius: 8, opacity: 1 },
  children, ...over,
});

describe('axis inference', () => {
  it('column, row, and ambiguous-grid verdicts from geometry', () => {
    expect(inferAxis([el(0, 0, 100, 40), el(0, 60, 100, 40), el(0, 120, 100, 40)].map((c) => ({ rect: c.rect })))).toBe('col');
    expect(inferAxis([el(0, 0, 40, 100), el(60, 0, 40, 100), el(120, 0, 40, 100)].map((c) => ({ rect: c.rect })))).toBe('row');
    expect(inferAxis([el(0, 0, 40, 40), el(60, 0, 40, 40), el(0, 60, 40, 40), el(60, 60, 40, 40)].map((c) => ({ rect: c.rect })))).toBeUndefined();
  });
  it('ambiguous grid -> ONE visible skip row in dom-dom vocabulary; sizes/styles still compared', () => {
    const grid = [el(0, 0, 40, 40), el(60, 0, 40, 40), el(0, 60, 40, 40), el(60, 60, 40, 40)];
    const rows = diffDomPair(snap(grid), snap(grid), { tolerancePx: 1 });
    const skip = rows.find((r) => r.prop === 'children' && r.status === 'skip');
    expect(skip?.note).toMatch(/axis not inferable/);
    expect(skip?.note ?? '').not.toMatch(/auto-layout/);
    expect(rows.some((r) => r.prop === 'size.w')).toBe(true);
    expect(rows.some((r) => r.prop === 'fill')).toBe(true);
  });
});

describe('provenance silence (row-prop census)', () => {
  it('a rich dom-dom pair emits ONLY the allowlisted row classes - no Figma-only producer fires', () => {
    const kids = (label: string): DomChild[] => [
      el(0, 0, 600, 90, { children: [{ kind: 'text', text: `Title ${label}`, rect: { x: 8, y: 8, w: 200, h: 20 }, styles: { fontSize: 16, fontWeight: 600, color: '#111111' } }] }),
      el(0, 110, 600, 90),
      el(0, 220, 600, 90),
    ];
    const reference = snap(kids('ref'), { shadow: { x: 0, y: 2, blur: 8, spread: 0, colorHex: '#00000033', count: 1 },
      styles: { display: 'flex', backgroundColor: '#ffffff', backgroundColorToken: { token: '--bg' }, borderRadius: 8, opacity: 1 } });
    const candidate = snap(kids('cand'), { shadow: { x: 0, y: 2, blur: 8, spread: 0, colorHex: '#00000033', count: 1 },
      styles: { display: 'flex', backgroundColor: '#ffffff', backgroundColorToken: { literal: true }, borderRadius: 8, opacity: 1 } });
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const ALLOW = /^(viewport|size\.[wh]|fill|fill-token-drift|corner-radius|opacity|box-shadow|border.*|gap.*|offset-cross.*|padding-(top|right|bottom|left|start|end).*|typography.*|font-.*|line-height.*|letter-spacing.*|text-color.*|children.*|structure_mismatch|reference_.*|snapshot.*|extractor_outdated|justify.*)$/;
    const outside = rows.map((r) => r.prop).filter((p) => !ALLOW.test(p));
    expect(outside).toEqual([]);
    const FORBIDDEN = /^(component|style_anchor|unwrapped|hug|token|mode_)/;
    expect(rows.map((r) => r.prop).filter((p) => FORBIDDEN.test(p))).toEqual([]);
  });
});
