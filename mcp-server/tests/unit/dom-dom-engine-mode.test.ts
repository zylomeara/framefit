// The dom-dom ENGINE MODE consumers beyond size math (panel lock 7): producers whose semantics
// assume "spec side = Figma" must switch or turn off. Each case here is a semantic lie without
// the mode: the gutter demote excuses a REAL width difference between two browser captures; the
// styleAnchor descent reads the candidate's nested carrier while the reference was projected
// flat; the salvage matcher's high-confidence gate is reachable ONLY via text (+100 vs max ~45
// for size+order), so textless skeletons - the primary dom-dom subject - could never salvage;
// and structure notes naming "figma" mislead on a pair with no Figma side at all.
import { describe, it, expect } from 'vitest';
import { diffDomPair } from '../../src/domain/layout-spec/dom-dom.js';
import type { DomSnapshotOk, DomChild } from '../../src/domain/layout-spec/types.js';

const base = (over: Partial<DomSnapshotOk> = {}, children: DomChild[] = []): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.x', innerWidth: 1280,
  rect: { x: 0, y: 0, w: 1280, h: 400 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 },
  clientWidth: 1280, clientHeight: 400, scrollHeight: 400,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', borderRadius: 0, opacity: 1 },
  children, ...over,
});

describe('dom-dom engine mode', () => {
  it('page-gutter demote OFF: a real width difference equal to the gutter stays FAIL', () => {
    const reference = base();
    // Candidate lost 15px to a classic scrollbar gutter - between two BROWSER captures that is
    // a real layout difference (the reference capture had its own gutter conditions), not an excuse.
    const candidate = base({ rect: { x: 15, y: 0, w: 1265, h: 400 }, clientWidth: 1265,
      layoutViewportWidth: 1265, reservedGutter: 0, reservedGutterLeft: 15 });
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const w = rows.find((r) => r.prop === 'size.w');
    expect(w?.status).toBe('fail');
  });
  it('styleAnchor descent OFF: candidate root transparent with a painted full-size child != reference painted root', () => {
    const reference = base({ styles: { display: 'flex', backgroundColor: '#333333', borderRadius: 0, opacity: 1 } });
    const candidate = base({}, [{ kind: 'element', tag: 'div', rect: { x: 0, y: 0, w: 1280, h: 400 },
      styles: { backgroundColor: '#333333' } }]);
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const fill = rows.find((r) => r.prop === 'fill');
    // Without the mode gate the anchor descends to the child and answers pass; two DOM captures
    // are compared role-for-role - the candidate ROOT paints nothing, which must stay visible.
    expect(fill?.status).not.toBe('pass');
  });
  it('salvage without text: textless count mismatch with clean geometry still salvages (medium)', () => {
    const kid = (y: number): DomChild => ({ kind: 'element', tag: 'div', rect: { x: 0, y, w: 1280, h: 100 } });
    const reference = base({}, [kid(0), kid(120), kid(240)]);
    const candidate = base({}, [kid(0), kid(120)]);
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.status).toBe('warn');
    // The salvage note (not the total-skip note): matched pairs' metrics survive below, and the
    // pairing's real confidence is said out loud - no text anchors exist, so this is rank-zip.
    expect(sm?.note).toMatch(/metrics below/);
    expect(sm?.note).toMatch(/LOW confidence/);
    expect(rows.some((r) => r.prop.startsWith('gap'))).toBe(true);
  });
  it('structure notes name reference/candidate, never figma', () => {
    const kid = (y: number, tag = 'div'): DomChild => ({ kind: 'element', tag, rect: { x: 0, y, w: 1280, h: 100 } });
    const reference = base({ outOfFlow: 1 }, [kid(0), kid(120), kid(240)]);
    const candidate = base({}, [kid(0), kid(120)]);
    const rows = diffDomPair(reference, candidate, { tolerancePx: 1 });
    const sm = rows.find((r) => r.prop === 'structure_mismatch');
    expect(sm?.note ?? '').not.toMatch(/[Ff]igma/);
    expect(sm?.note ?? '').toMatch(/REFERENCE|reference/);
  });
});
