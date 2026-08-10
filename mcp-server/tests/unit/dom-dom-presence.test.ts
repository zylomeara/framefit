// Presence symmetry in dom-dom mode (panel locks 3 and 5). The engine's style/text axes are
// gated by presence on the SPEC side - correct for Figma (a frame always declares its fills),
// false-green for dom-dom: a transparent reference container vs a gray candidate skeleton
// produced TOTAL SILENCE on fill, and a text-bearing candidate slot vs a bare reference slot
// produced silence on typography. Both directions must be visible, naming the side.
import { describe, it, expect } from 'vitest';
import { diffDomPair } from '../../src/domain/layout-spec/dom-dom.js';
import type { DomSnapshotOk, DomChild } from '../../src/domain/layout-spec/types.js';

const snap = (over: Partial<DomSnapshotOk> = {}, children: DomChild[] = []): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.x', innerWidth: 768,
  rect: { x: 0, y: 0, w: 400, h: 200 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 400, clientHeight: 200, scrollHeight: 200,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', borderRadius: 0, opacity: 1 },
  children, ...over,
});

describe('dom-dom presence symmetry', () => {
  it('candidate has a background the reference lacks -> gating REVIEW naming the sides', () => {
    const reference = snap();                                             // transparent container
    const candidate = snap({ styles: { display: 'flex', backgroundColor: '#808080', borderRadius: 0, opacity: 1 } });
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const fill = rows.find((r) => r.prop === 'fill');
    expect(fill?.status).toBe('review');   // wave finding 5: a warn is advisory - the done-gate stayed green
    expect(fill?.note).toMatch(/REFERENCE/);
  });
  it('unparseable reference background (oklch) -> symmetric info, not silence, not presence-warn, no token action', () => {
    const reference = snap({ styles: { display: 'flex', backgroundColor: 'oklch(0.7 0.1 200)', borderRadius: 0, opacity: 1 } });
    const candidate = snap({ styles: { display: 'flex', backgroundColor: '#808080', borderRadius: 0, opacity: 1 } });
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const fill = rows.find((r) => r.prop === 'fill');
    expect(fill?.status).toBe('info');
    expect(fill?.note).toMatch(/not checked on either side|verify visually/);
    expect(JSON.stringify(rows)).not.toMatch(/confirm_token/);
  });
  it('candidate root carries text the reference does not -> visible warn', () => {
    const reference = snap();
    const candidate = snap({}, [{ kind: 'text', text: 'Loaded label', rect: { x: 0, y: 0, w: 100, h: 20 },
      styles: { fontSize: 14, fontWeight: 400 } } as DomChild]);
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const t = rows.find((r) => r.prop.startsWith('typography'));
    expect(t?.status).toBe('review');   // wave finding 5
    expect(t?.note).toMatch(/REFERENCE/);
  });
  it('candidate CHILD slot carries text the reference slot does not -> visible warn', () => {
    const kidRef: DomChild = { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 400, h: 40 } };
    const kidRef2: DomChild = { kind: 'element', tag: 'div', rect: { x: 0, y: 60, w: 400, h: 40 } };
    const kidCand: DomChild = { kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 400, h: 40 },
      children: [{ kind: 'text', text: 'Sneaky', rect: { x: 4, y: 4, w: 80, h: 16 }, styles: { fontSize: 13 } }] };
    const kidCand2: DomChild = { kind: 'element', tag: 'div', rect: { x: 0, y: 60, w: 400, h: 40 } };
    const rows = diffDomPair(snap({}, [kidRef, kidRef2]), snap({}, [kidCand, kidCand2]), { tolerancePx: 1 });
    const t = rows.find((r) => r.prop.startsWith('typography['));
    expect(t?.status).toBe('review');   // wave finding 5
    expect(t?.note).toMatch(/REFERENCE/);
  });
});
