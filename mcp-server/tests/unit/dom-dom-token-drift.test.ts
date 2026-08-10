// Token-provenance drift (spec D4 + panel lock 8): both sides carry the extractor's
// DomColorToken; a var()-anchored reference vs a literal candidate (or vice versa, or two
// different var names) is a REVIEW - the value row can pass on equal hexes while the
// tokenization silently changed between states. The row's figma/dom fields carry PROVENANCE
// STRINGS (the gradient tokOf precedent), never hexes: a review row whose figma/dom happen to
// be equal self-demotes via rowValuesMatched, so equal hexes must never be the row's values.
import { describe, it, expect } from 'vitest';
import { diffDomPair } from '../../src/domain/layout-spec/dom-dom.js';
import type { DomSnapshotOk, DomColorToken } from '../../src/domain/layout-spec/types.js';

const snap = (bgToken?: DomColorToken): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.x', innerWidth: 768,
  rect: { x: 0, y: 0, w: 400, h: 200 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 400, clientHeight: 200, scrollHeight: 200,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', backgroundColor: '#333333', borderRadius: 0, opacity: 1,
    ...(bgToken ? { backgroundColorToken: bgToken } : {}) },
  children: [],
});
const drift = (a?: DomColorToken, b?: DomColorToken) =>
  diffDomPair(snap(a), snap(b), { tolerancePx: 1 }).find((r) => r.prop === 'fill-token-drift');

describe('fill token-provenance drift', () => {
  it('reference var-anchored, candidate literal -> review with provenance strings', () => {
    const r = drift({ token: '--brand-bg' }, { literal: true });
    expect(r?.status).toBe('review');
    expect(r?.figma).toBe('var(--brand-bg)');
    expect(r?.dom).toBe('literal');
    expect(r?.note).toMatch(/tokenization changed/);
  });
  it('literal reference, var candidate -> review (symmetric)', () => {
    expect(drift({ literal: true }, { token: '--brand-bg' })?.status).toBe('review');
  });
  it('same var name both sides -> pass', () => {
    const r = drift({ token: '--brand-bg' }, { token: '--brand-bg' });
    expect(r?.status).toBe('pass');
  });
  it('different var names -> review', () => {
    const r = drift({ token: '--brand-bg' }, { token: '--other-bg' });
    expect(r?.status).toBe('review');
    expect(r?.figma).toBe('var(--brand-bg)');
    expect(r?.dom).toBe('var(--other-bg)');
  });
  it('both literal -> no row; missing or unknown on either side -> no row', () => {
    expect(drift({ literal: true }, { literal: true })).toBeUndefined();
    expect(drift(undefined, { token: '--x' })).toBeUndefined();
    expect(drift({ unknown: 'color-mix(...)' }, { token: '--x' })).toBeUndefined();
  });
});
