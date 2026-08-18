// mcp-server/tests/unit/layout-spec-diff-descriptive.test.ts
import { describe, it, expect } from 'vitest';
import { diffPair, summarize, deriveCoverage } from '../../src/domain/layout-spec/diff.js';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';
import type { LayoutSpec, DomSnapshotOk } from '../../src/domain/layout-spec/types.js';
import { makeColorTokenResolver } from '../../src/adapters/driving/tools/color-token-resolver.js';
import { buildVariableIndex } from '../../src/domain/variables.js';

const baseSpec = (): LayoutSpec => ({
  node: { id: '1:1', name: 'item', type: 'INSTANCE' },
  rect: { x: 0, y: 0, w: 343, h: 56 }, axis: 'row',
  fillHex: '#ffffff', cornerRadius: 16,
  component: { id: '5:1', name: 'Type=Basic', setName: 'listItem', props: { Size: 'medium' } },
  children: [
    { id: '1:2', name: 'radio', type: 'INSTANCE', rect: { x: 16, y: 18, w: 20, h: 20 } },
    { id: '1:3', name: 'label', type: 'TEXT', rect: { x: 52, y: 16, w: 200, h: 24 },
      text: { fontFamily: 'Inter', fontWeight: 650, fontSize: 19, lineHeightPx: 24, lineHeightUnit: 'PIXELS', letterSpacing: 0, colorHex: '#141414' } },
  ],
});

const baseSnap = (): DomSnapshotOk => ({
  schema: 1, status: 'ok', selector: '.item', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 56 },
  borders: { top: 2, right: 2, bottom: 2, left: 2 }, scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 339, clientHeight: 52, scrollHeight: 52,
  styles: { display: 'flex', backgroundColor: '#ffffff', borderRadius: 16, opacity: 1 },
  componentHints: { tag: 'label', classList: ['ds-list-item', 'ds-list-item_basic'], data: {} },
  children: [
    { kind: 'element', tag: 'input', rect: { x: 18, y: 20, w: 20, h: 20 } },
    // w:196 — a historical end-edge tuning; padding-right for a trailing text child is now suppressed (intrinsic width)
    { kind: 'text', rect: { x: 54, y: 18, w: 196, h: 24 }, text: 'Причина',
      styles: { fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: 18, lineHeight: 24, letterSpacing: 'normal', color: '#141414' } },
  ],
});

const row = (rows: ReturnType<typeof diffPair>, prefix: string) => rows.find((r) => r.prop.startsWith(prefix));

describe('diffPair — paddings, cross axis, typography, colors, component', () => {
  it('padding_effective subtracts DOM borders (row axis → left/right)', () => {
    // figma: first child x=16 → padding-left 16; dom: child x=18, content-edge = 0+2(border) → 16 → pass
    const rows = diffPair(baseSpec(), baseSnap(), { tolerancePx: 1 });
    expect(row(rows, 'padding-left')).toMatchObject({ figma: 16, dom: 16, status: 'pass' });
  });

  it('offset-cross per child (row → offset by y)', () => {
    // figma radio: y18 − y0 = 18; dom input: y20 − (0 + border-top 2) = 18 → pass
    const rows = diffPair(baseSpec(), baseSnap(), { tolerancePx: 1 });
    expect(row(rows, 'offset-cross[0] radio')).toMatchObject({ figma: 18, dom: 18, status: 'pass' });
  });

  it('regression Δ4: font-size 18 vs 19 and font-weight 700 vs 650 → two fails on the text child', () => {
    const rows = diffPair(baseSpec(), baseSnap(), { tolerancePx: 1 });
    expect(row(rows, 'font-size[label]')).toMatchObject({ figma: 19, dom: 18, status: 'fail' });
    expect(row(rows, 'font-weight[label]')).toMatchObject({ figma: 650, dom: 700, status: 'fail' });
    expect(row(rows, 'font-family[label]')?.status).toBe('pass'); // "Inter", sans-serif → inter
    expect(row(rows, 'color[label]')?.status).toBe('pass');
    expect(row(rows, 'line-height[label]')?.status).toBe('pass');
  });

  it('line-height: INTRINSIC_% vs normal → pass+note; px vs normal → warn with best-effort', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, lineHeightUnit: 'INTRINSIC_%', lineHeightPx: undefined };
    const d = baseSnap();
    d.children[1].styles = { ...d.children[1].styles!, lineHeight: 'normal' };
    let rows = diffPair(s, d, { tolerancePx: 1 });
    expect(row(rows, 'line-height[label]')?.status).toBe('pass');

    const s2 = baseSpec(); // px in figma
    rows = diffPair(s2, d, { tolerancePx: 1 });
    const lh = row(rows, 'line-height[label]');
    expect(lh?.status).toBe('warn');
    expect(lh?.note).toMatch(/best-effort|rect\.h/);
  });

  it('container fill + corner-radius compared; missing DOM background → warn', () => {
    const rows = diffPair(baseSpec(), baseSnap(), { tolerancePx: 1 });
    expect(row(rows, 'fill')?.status).toBe('pass');
    expect(row(rows, 'corner-radius')?.status).toBe('pass');
    const d = baseSnap();
    d.styles = { ...d.styles, backgroundColor: undefined };
    expect(row(diffPair(baseSpec(), d, { tolerancePx: 1 }), 'fill')?.status).toBe('warn');
  });

  it('component row: DS classList token overlap → pass; alien classes → warn (never fail)', () => {
    const rows = diffPair(baseSpec(), baseSnap(), { tolerancePx: 1 });
    // setName 'listItem' → base 'listitem' + derived ['list','item']; class 'ds-list-item(_basic)' → ['list','item',…]
    // → intersection on the derived pair list+item; the prop token basic is excluded from the match
    expect(row(rows, 'component')?.status).toBe('pass');
    expect(row(rows, 'component')?.note).not.toContain('"basic"');
    const d = baseSnap();
    d.componentHints = { tag: 'div', classList: ['custom-radio'], data: {} };
    const warn = row(diffPair(baseSpec(), d, { tolerancePx: 1 }), 'component');
    expect(warn?.status).toBe('warn');
    expect(String(warn?.figma)).toBe('listItem/Type=Basic');
    expect(String(warn?.dom)).toBe('div.custom-radio');
  });

  it('expected_component override drives the match', () => {
    const d = baseSnap();
    d.componentHints = { tag: 'div', classList: ['custom-radio'], data: {} };
    const rows = diffPair(baseSpec(), d, { tolerancePx: 1, expectedComponent: 'custom-radio' });
    expect(row(rows, 'component')?.status).toBe('pass');
  });

  it('fontsLoaded=false adds a note to typography rows', () => {
    const d = baseSnap();
    d.fontsLoaded = false;
    const rows = diffPair(baseSpec(), d, { tolerancePx: 1 });
    expect(row(rows, 'font-size[label]')?.note).toMatch(/fonts not loaded/);
  });

  it("component: 2-char token no longer matches ('ds' acceptance case); expected_component is a substring match", () => {
    const d = baseSnap();
    d.componentHints = { tag: 'label', classList: ['ds-radio'], data: {} };
    // Before: tokens('ds-list-item')∩tokens('label.ds-radio') = {'ds'} → a false pass
    const rows = diffPair(baseSpec(), d, { tolerancePx: 1, expectedComponent: 'ds-list-item' });
    expect(row(rows, 'component')?.status).toBe('warn');
    // Substring match → pass with a transparent note
    const d2 = baseSnap();
    d2.componentHints = { tag: 'label', classList: ['ds-list-item', 'ds-list-item_basic'], data: {} };
    const ok = row(diffPair(baseSpec(), d2, { tolerancePx: 1, expectedComponent: 'ds-list-item' }), 'component');
    expect(ok?.status).toBe('pass');
    expect(ok?.note).toContain('matched by');
  });

  it('component-note transparency: warn note names what was attempted (substring vs token) — 5.2', () => {
    const dExpected = baseSnap();
    dExpected.componentHints = { tag: 'label', classList: ['ds-radio'], data: {} };
    const withExpected = row(diffPair(baseSpec(), dExpected, { tolerancePx: 1, expectedComponent: 'ds-list-item' }), 'component');
    expect(withExpected?.status).toBe('warn');
    expect(withExpected?.note).toContain('substring "ds-list-item" not found');

    const dNoExpected = baseSnap();
    dNoExpected.componentHints = { tag: 'div', classList: ['custom-radio'], data: {} };
    const withoutExpected = row(diffPair(baseSpec(), dNoExpected, { tolerancePx: 1 }), 'component');
    expect(withoutExpected?.status).toBe('warn');
    expect(withoutExpected?.note).toContain('shared tokens');
  });

  // Mode-unconfirmed footgun (verdict-machine B branch, formerly boundColorNote): a mode-dependent color token,
  // resolved in the library default-mode (mode_source:'default'), = the node's mode is NOT confirmed →
  // the hex discrepancy is legitimate under a different mode. colorVerdict degrades ❌→review (gating,
  // not a silent pass and not a hard fail). The mechanism was switched from colorBoundVar-only to a mode-resolved
  // token: a bare *BoundVar without a token is now a raw literal (mismatch → an honest fail).
  it('fill: mode-unconfirmed token + hex mismatch → review "mode not confirmed"', () => {
    const s = baseSpec();
    s.fillHex = '#a73afd'; // resolved in the default-mode Lunar
    s.fillToken = { token: 'surface/accent', defaultHex: '#a73afd', effectiveHex: null, effectiveModeSource: 'unverifiable', all_modes: { Solar: '#ffffff', Lunar: '#a73afd' } };
    const f = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'fill'); // DOM bg #ffffff (Solar)
    expect(f?.status).toBe('review');
    expect(f?.note).toMatch(/mode is not confirmed/);
    expect(f?.note).toContain('surface/accent');
  });

  // Finding-1 (post-whole-branch): a SINGLE-MODE-top semantic token (surface/card) aliasing a
  // multi-mode downstream primitive whose hop fell back to the target default. The resolver now emits
  // mode_dependent:true / mode_source:'default' even though the TOP collection is single-mode — and
  // crucially there is NO all_modes (resolveAllModes is null for a single-mode top variable). group B
  // must still gate on mode_dependent+mode_source alone → review, NOT the group-C false-red that shipped
  // when the mode fields were silently dropped. Locks the colorVerdict side of the fix.
  it('fill: single-mode-top token, mode_source:default, NO all_modes + hex mismatch → review (group B), not group-C fail', () => {
    const s = baseSpec();
    s.fillHex = '#a73afd'; // downstream default-mode value
    s.fillToken = { token: 'surface/card', defaultHex: '#a73afd', effectiveHex: null, effectiveModeSource: 'unverifiable' }; // no all_modes / no mode
    const d = baseSnap();
    d.styles = { ...d.styles!, backgroundColor: '#8b6afb' }; // on-screen Solar — legitimate, another mode
    const f = row(diffPair(s, d, { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('review');            // group B, never the false-red fail
    expect(f?.note).toMatch(/mode is not confirmed/);
    expect(f?.note).toContain('surface/card');
  });

  // Mutation lock: a snapshot-resolved default-mode token — the snapshot
  // fundamentally does not know the node's modes, this is NOT a "pin on an unloaded ancestor" (the old gate-B note).
  // The snapshot-note branch must intercept BEFORE gate B, otherwise the snapshot token (which also carries
  // mode_dependent+mode_source:'default') would get a mis-attributing pin note.
  it('fill: snapshot_default token → review with the snapshot note, NOT "pin" (mutation lock)', () => {
    const s = baseSpec();
    s.fillHex = '#ff5722';
    s.fillToken = { token: 'brand/primary', defaultHex: '#ff5722', effectiveHex: null, effectiveModeSource: 'unverifiable', snapshot_default: true };
    const d = baseSnap();
    d.styles = { ...d.styles!, backgroundColor: '#ff5722' }; // hex matches the DOM
    const f = row(diffPair(s, d, { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.note).toMatch(/default-mode snapshot/);
    expect(f?.note).not.toMatch(/pin/); // mutation "keep only the gate-B note" → RED here
  });

  it('fill: an ordinary mode_dependent default (without snapshot_default) → the prior gate-B note byte-for-byte (regression lock)', () => {
    const s = baseSpec();
    s.fillHex = '#ff5722';
    s.fillToken = { token: 't', defaultHex: '#ff5722', effectiveHex: null, effectiveModeSource: 'unverifiable' };
    const d = baseSnap();
    d.styles = { ...d.styles!, backgroundColor: '#ff5722' };
    const f = row(diffPair(s, d, { tolerancePx: 1 }), 'fill');
    expect(f?.note).toBe("the node's effective mode is not confirmed; default #ff5722 is diagnostic only — token t");
  });

  it('duplicate Theme axes cannot leak a downstream default into an authored-token pass', () => {
    const variableIndex = buildVariableIndex({ meta: {
      variableCollections: {
        A: { id: 'A', name: 'Theme', defaultModeId: 'a1',
          modes: [{ modeId: 'a1', name: 'Light' }, { modeId: 'a2', name: 'Dark' }] },
        B: { id: 'B', name: 'Theme', defaultModeId: 'b1',
          modes: [{ modeId: 'b1', name: 'Light' }, { modeId: 'b2', name: 'Night' }] },
      },
      variables: {
        'V:src': { id: 'V:src', name: 'src/accent', resolvedType: 'COLOR', variableCollectionId: 'A',
          valuesByMode: { a1: { type: 'VARIABLE_ALIAS', id: 'V:tgt' }, a2: { type: 'VARIABLE_ALIAS', id: 'V:tgt' } },
          codeSyntax: { WEB: '--src-accent' } },
        'V:tgt': { id: 'V:tgt', name: 'target/base', resolvedType: 'COLOR', variableCollectionId: 'B',
          valuesByMode: { b1: { r: 1, g: 1, b: 1, a: 1 }, b2: { r: 0, g: 0, b: 0, a: 1 } } },
      },
    } } as never);
    const resolve = makeColorTokenResolver({
      variableIndex,
      stackFor: () => new Map([['A', 'a2']]),
      graphStackFor: () => new Map(),
      exactEvidenceFor: () => new Map([['A', { modeId: 'a2', source: 'explicit_node', nodeId: '1:1' }]]),
      graphEvidenceFor: () => new Map(),
      coverageComplete: false,
    });
    const boundNode = {
      id: '1:1', name: 'n', type: 'FRAME',
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 },
        boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:src' } } }],
    } as never;
    const s = baseSpec();
    s.fillBoundVar = 'V:src';
    s.fillToken = resolve(boundNode, 'fills')!;
    const d = baseSnap();
    (d.styles as Record<string, unknown>).backgroundColorToken = { token: '--src-accent' };
    const cssEvidence = {
      nameOf: (id: string) => id === 'V:src' ? '--src-accent' : undefined,
      idsByName: (name: string) => name === '--src-accent' ? ['V:src'] : [],
      aliasRelation: (a: string, b: string) => a === b ? 'related' as const : 'unrelated' as const,
    };
    const f = row(diffPair(s, d, { tolerancePx: 1, cssEvidence }), 'fill');
    expect(s.fillToken).toMatchObject({ defaultHex: '#ffffff', effectiveHex: null, effectiveModeSource: 'unverifiable' });
    expect(f).toMatchObject({ figma: null, status: 'review', tokenReason: 'mode-unconfirmed' });
  });

  it('fill: hex equal (no token) → pass without a note; unbound mismatch → fail as before', () => {
    const s = baseSpec(); // fillHex #ffffff matches the DOM backgroundColor, no token
    const eq = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'fill');
    expect(eq?.status).toBe('pass');
    expect(eq?.note).toBeUndefined();

    const sUn = baseSpec();
    sUn.fillHex = '#8f8fa3'; // diverges, without a token → an honest fail
    expect(row(diffPair(sUn, baseSnap(), { tolerancePx: 1 }), 'fill')?.status).toBe('fail');
  });

  it('color[child]: mode-unconfirmed token + mismatch → review; equal (no token) → pass; unbound mismatch → fail', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#a73afd',
      colorToken: { token: 'text color/accent', defaultHex: '#a73afd', effectiveHex: null, effectiveModeSource: 'unverifiable', all_modes: { Solar: '#141414', Lunar: '#a73afd' } } };
    const c = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'color[label]'); // DOM color #141414 (Solar)
    expect(c?.status).toBe('review');
    expect(c?.note).toMatch(/mode is not confirmed/);
    expect(c?.note).toContain('text color/accent');

    const sEq = baseSpec(); // colorHex #141414 matches the DOM color, no token → pass (not review)
    const cEq = row(diffPair(sEq, baseSnap(), { tolerancePx: 1 }), 'color[label]');
    expect(cEq?.status).toBe('pass');
    expect(cEq?.note).toBeUndefined();

    const sUn = baseSpec();
    sUn.children[1].text = { ...sUn.children[1].text!, colorHex: '#8f8fa3' };
    expect(row(diffPair(sUn, baseSnap(), { tolerancePx: 1 }), 'color[label]')?.status).toBe('fail');
  });

  it('line-height: figma auto × numeric DOM → numeric comparison capped at warn', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, lineHeightUnit: 'INTRINSIC_%', lineHeightPx: 24 };
    const d = baseSnap();
    d.children[1].styles = { ...d.children[1].styles!, lineHeight: 30 };
    const lh = row(diffPair(s, d, { tolerancePx: 1 }), 'line-height[label]');
    expect(lh).toMatchObject({ figma: 24, dom: 30, status: 'warn' });
    expect(lh?.note).toContain('Figma auto');
    // Match → pass
    d.children[1].styles = { ...d.children[1].styles!, lineHeight: 24 };
    expect(row(diffPair(s, d, { tolerancePx: 1 }), 'line-height[label]')?.status).toBe('pass');
  });

  // ── colorVerdict machine (groups A/B/C), interim dom.unknown ──
  // Precedence order: (A) domHex undefined → info (never fail); Figma unresolved → review;
  // (B) a mode-dependent token with an unconfirmed mode → review (never fail/green);
  // (C) hex diverged → mode-mismatch fail (if it matched a DIFFERENT mode) otherwise diverged fail;
  // (D) hex matched → token provenance (domToken=undefined → unknown → a bound token = review, not a silent pass).
  it('WS-D: mode-unconfirmed bound token → review (not-verified), never fail/green', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#8b6afb',
      colorToken: { token: 'text color/accent', defaultHex: '#a73afd', effectiveHex: null, effectiveModeSource: 'unverifiable', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } } };
    // DOM shows Solar #8b6afb; figma resolved to default #a73afd because mode unconfirmed
    const snap = baseSnap(); (snap.children[1] as any).styles.color = '#8b6afb';
    const c = row(diffPair(s, snap, { tolerancePx: 1 }), 'color[label]');
    expect(c?.status).toBe('review');            // gating, not green
    expect(c?.note).toMatch(/mode is not confirmed|mode.*unconfirmed/i);
  });

  it('WS-D: mode confirmed + hex diverges + matches ANOTHER mode → fail (wrong subbrand)', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#8b6afb',
      colorToken: { token: 'text color/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } } };
    const snap = baseSnap(); (snap.children[1] as any).styles.color = '#a73afd'; // Lunar applied
    const c = row(diffPair(s, snap, { tolerancePx: 1 }), 'color[label]');
    expect(c?.status).toBe('fail');
    expect(c?.note).toMatch(/Lunar/);
  });

  it('WS-D: unparseable DOM color (undefined) → info, never fail', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#8b6afb',
      colorToken: { token: 'text color/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node' } };
    const snap = baseSnap(); (snap.children[1] as any).styles.color = undefined; // oklch → toHex undefined
    const c = row(diffPair(s, snap, { tolerancePx: 1 }), 'color[label]');
    expect(c?.status).toBe('info');
  });

  it('WS-D: mode confirmed + hex matches + bound token, DOM token not captured → review (interim)', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#8b6afb',
      colorToken: { token: 'text color/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node' } };
    const snap = baseSnap(); (snap.children[1] as any).styles.color = '#8b6afb';
    expect(row(diffPair(s, snap, { tolerancePx: 1 }), 'color[label]')?.status).toBe('review');
  });

  it('WS-D: no bound token, hex matches → pass (unchanged); mismatch → fail', () => {
    const sEq = baseSpec(); // colorHex == DOM color, no token
    expect(row(diffPair(sEq, baseSnap(), { tolerancePx: 1 }), 'color[label]')?.status).toBe('pass');
  });

  // ── group D: the REAL DOM token from the snapshot (the 4th arg instead of interim undefined) ──
  it('WS-D: literal-catch — bound Figma token, DOM literal, hex matches → fail', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#8b6afb', colorToken: { token: 'text color/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node' } };
    const snap = baseSnap(); (snap.children[1] as any).styles.color = '#8b6afb'; (snap.children[1] as any).styles.colorToken = { literal: true };
    const c = row(diffPair(s, snap, { tolerancePx: 1 }), 'color[label]');
    expect(c?.status).toBe('fail'); expect(c?.note).toMatch(/literal|tokenize/i);
  });
  it('WS-D: both tokens, hex matches → review', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#8b6afb', colorToken: { token: 'text color/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node' } };
    const snap = baseSnap(); (snap.children[1] as any).styles.color = '#8b6afb'; (snap.children[1] as any).styles.colorToken = { token: '--ds-text-icon-accent' };
    const c = row(diffPair(s, snap, { tolerancePx: 1 }), 'color[label]');
    expect(c?.status).toBe('review');
    // note strengthening (T7 Minor C): a status-only lock is weak — we pin "both from a token" so that a rollback of the 4th
    // arg to undefined (→ "the DOM token was not read") breaks the test instead of slipping through as review≡review.
    expect(c?.note).toContain('both from a token');
  });
  it('WS-D: dom.unknown + hex matches → review (token unreadable); dom.unknown + !hex_match → fail', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#8b6afb', colorToken: { token: 'x', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb' } } };
    const eq = baseSnap(); (eq.children[1] as any).styles.color = '#8b6afb'; (eq.children[1] as any).styles.colorToken = { unknown: 'cross-origin' };
    const eqRow = row(diffPair(s, eq, { tolerancePx: 1 }), 'color[label]');
    expect(eqRow?.status).toBe('review');
    // note strengthening (T7 Minor C): the note is specifically about the unread DOM token + its cause (cross-origin),
    // not a generic review — otherwise a status-only lock would not distinguish this branch from the mode-unconfirmed review.
    expect(eqRow?.note).toContain('the DOM token was not read');
    expect(eqRow?.note).toContain('cross-origin');
    const ne = baseSnap(); (ne.children[1] as any).styles.color = '#123456'; (ne.children[1] as any).styles.colorToken = { unknown: 'cross-origin' };
    expect(row(diffPair(s, ne, { tolerancePx: 1 }), 'color[label]')?.status).toBe('fail');  // hex divergence not masked
  });
});

// ── colorVerdict compares the RESOLVED-under-mode hex, not the default-mode snapshot ──
// The figHex fed into colorVerdict must be the value under the node's mode (figToken.hex), NOT the raw
// default-mode snapshot (spec.fillHex/…). The fixtures SET raw≠resolved (which no test above did) —
// this catches the bug: before the fix a confirmed token with raw≠resolved gave a false-red ("mode X, not X").
describe('colorVerdict — the resolved-under-mode hex is fed into eq, not the default-mode snapshot (raw≠resolved)', () => {
  // 1 (main). confirmed token, raw≠resolved, DOM=on-screen(resolved) → NOT fail (group D review).
  //    Before the fix: figHex=raw #a73afd ≠ DOM #8b6afb → group C all_modes→Solar → an absurd fail "mode Solar,
  //    not Solar" = a false-red on a CORRECT page. Mutation (rolling back the 1st arg to spec.fillHex) → fail.
  it('fill resolved-match: confirmed token, raw≠resolved, DOM=resolved → NOT fail', () => {
    const s = baseSpec();
    s.fillHex = '#a73afd'; // the raw default-mode snapshot (Lunar-default)
    s.fillToken = { token: 'surface/card', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } };
    const d = baseSnap(); d.styles!.backgroundColor = '#8b6afb'; // on-screen under the Solar mode
    const f = row(diffPair(s, d, { tolerancePx: 1 }), 'fill');
    expect(f?.status).not.toBe('fail');           // before the fix → fail (false-red)
    expect(f?.status).toBe('review');              // group D: hex matched under the mode, DOM token not read
    expect(f?.note).not.toMatch(/was applied/);    // no absurd self-contradicting note should appear
  });

  // 2. mode-mismatch preserved (the fix did NOT kill group C): the same spec, DOM=a DIFFERENT mode → fail with a Lunar note.
  it('fill mode-mismatch: same token, DOM=a different mode → fail "Lunar" (group C intact)', () => {
    const s = baseSpec();
    s.fillHex = '#a73afd';
    s.fillToken = { token: 'surface/card', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } };
    const d = baseSnap(); d.styles!.backgroundColor = '#a73afd'; // on screen Lunar was applied (the wrong mode)
    const f = row(diffPair(s, d, { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('fail');
    expect(f?.note).toMatch(/Lunar/);
  });

  // 3. second call site (text color[label]): confirmed token, raw≠resolved, DOM=resolved → NOT fail.
  it('text resolved-match: color[label] confirmed token, raw≠resolved, DOM=resolved → NOT fail', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#a73afd',
      colorToken: { token: 'text color/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } } };
    const d = baseSnap(); (d.children[1] as any).styles.color = '#8b6afb';
    const c = row(diffPair(s, d, { tolerancePx: 1 }), 'color[label]');
    expect(c?.status).not.toBe('fail');
    expect(c?.status).toBe('review');
  });

  // 4. control `?? rawHex`: a raw literal WITHOUT a token does not regress — matched→pass, diverged→fail.
  it('raw literal without a token: "?? rawHex" — matches → pass, diverges → fail', () => {
    const sEq = baseSpec(); // fillHex #ffffff, no fillToken; DOM bg #ffffff
    expect(row(diffPair(sEq, baseSnap(), { tolerancePx: 1 }), 'fill')?.status).toBe('pass');
    const sDiv = baseSpec();
    sDiv.fillHex = '#8f8fa3'; // no token; DOM bg #ffffff
    expect(row(diffPair(sDiv, baseSnap(), { tolerancePx: 1 }), 'fill')?.status).toBe('fail');
  });

  // 5 (border 1st arg mutation lock). The resolved-hex fix is locked by tests 1-3 on fill+text; the border tests above
  //    use raw==resolved (strokeHex==token.hex) → a rollback of the border 1st arg of colorVerdict
  //    `spec.strokeToken?.hex ?? spec.strokeHex` back to `spec.strokeHex` would pass the whole suite SILENTLY
  //    (the lesson of an unlocked mirror). border REALLY carries a resolved multi-mode strokeToken in prod
  //    (the projector resolves strokes) → the same false-red could quietly regress on the border.
  it('border resolved-match: confirmed strokeToken, raw≠resolved, DOM=resolved → NOT fail (1st arg mutation lock)', () => {
    const s = baseSpec();
    s.strokeHex = '#a73afd'; s.strokeWeight = 2; // the raw default-mode snapshot (Lunar-default)
    s.strokeToken = { token: 'border/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } };
    const d = baseSnap(); // borders 2 on all 4 sides → activeSides.length===4
    d.borderColors = { top: '#8b6afb', right: '#8b6afb', bottom: '#8b6afb', left: '#8b6afb' }; // on-screen Solar, uniform
    const c = row(diffPair(s, d, { tolerancePx: 1 }), 'border-color');
    expect(c?.status).not.toBe('fail'); // mutation (border 1st arg → spec.strokeHex): eq(#a73afd,#8b6afb)=false → C fail
    expect(c?.status).toBe('review');   // group D: hex matched under the mode, DOM token not read
  });

  // 6 (display↔verdict sync). colorVerdict compares the resolved figToken.hex, but the
  //    `figma:` field of the rendered row MUST show the same resolved value, not the raw default-mode hex —
  //    otherwise on a mode-mismatch the row is drawn "figma:#a73afd / dom:#a73afd / fail" (TWO IDENTICAL hex with
  //    a fail status) → a person glancing over it waves it off ("equal, tool glitch"), masking a real fail
  //    (a soft false-green AT THE EYE LEVEL). The expected on-screen target #8b6afb is otherwise hidden in display.
  it('display resolved: a mode-mismatch fail shows the resolved figma-hex (#8b6afb), not the raw (#a73afd)', () => {
    const s = baseSpec();
    s.fillHex = '#a73afd'; // the raw default-mode snapshot (Lunar)
    s.fillToken = { token: 'surface/card', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } };
    const d = baseSnap(); d.styles!.backgroundColor = '#a73afd'; // on screen Lunar was applied (the wrong mode)
    const f = row(diffPair(s, d, { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('fail');       // mode-mismatch (group C via all_modes)
    expect(f?.figma).toBe('#8b6afb');     // resolved under the node's mode — WITHOUT the display fix it would be the raw '#a73afd'
    expect(f?.figma).not.toBe('#a73afd'); // the raw default-mode hex must not leak into display
  });

  // 7+8 (the display mirror on text+border was NOT locked): test 6 locked
  //    the `.figma` display field ONLY on the fill row; the border/text locks (tests 3/5) asserted only `status`,
  //    so a rollback of the text/border display field (`figToken?.hex ?? rawHex` → rawHex) would pass the whole suite
  //    SILENTLY → on a mode-mismatch fail the row again draws "figma:#a73afd / dom:#a73afd" (two equal hex) =
  //    the very soft false-green at the eye level that the display lock closed (the doctrine of
  //    an unlocked mirror). We lock the display field on BOTH remaining colorVerdict rows, symmetric with test 6.
  it('display resolved (text): a mode-mismatch fail shows the resolved figma-hex (#8b6afb), not the raw (#a73afd)', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#a73afd', // the raw default-mode (Lunar)
      colorToken: { token: 'text color/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } } };
    const d = baseSnap(); (d.children[1] as any).styles.color = '#a73afd'; // on screen Lunar (the wrong mode)
    const c = row(diffPair(s, d, { tolerancePx: 1 }), 'color[label]');
    expect(c?.status).toBe('fail');       // mode-mismatch (group C)
    expect(c?.figma).toBe('#8b6afb');     // resolved — a rollback of the text display → raw '#a73afd' drops this
    expect(c?.figma).not.toBe('#a73afd');
  });
  it('display resolved (border): a mode-mismatch fail shows the resolved figma-hex (#8b6afb), not the raw (#a73afd)', () => {
    const s = baseSpec();
    s.strokeHex = '#a73afd'; s.strokeWeight = 2; // the raw default-mode snapshot (Lunar)
    s.strokeToken = { token: 'border/accent', effectiveHex: '#8b6afb', effectiveModeSource: 'explicit_node', all_modes: { Solar: '#8b6afb', Lunar: '#a73afd' } };
    const d = baseSnap(); // borders 2 on all 4 sides
    d.borderColors = { top: '#a73afd', right: '#a73afd', bottom: '#a73afd', left: '#a73afd' }; // Lunar, uniform
    const c = row(diffPair(s, d, { tolerancePx: 1 }), 'border-color');
    expect(c?.status).toBe('fail');       // mode-mismatch (group C via all_modes)
    expect(c?.figma).toBe('#8b6afb');     // resolved — a rollback of the border display → spec.strokeHex drops this
    expect(c?.figma).not.toBe('#a73afd');
  });
});

// ── group A2: bound-but-unresolved color → review BOTH ways ──
// The color is BOUND to a variable (*BoundVar present), but the token is NOT resolved (*Token undefined) —
// without the gate it's conflated with a raw literal: matched→pass (false-green), diverged→fail (false-red).
// A2 gates BEFORE the hex comparison → review regardless of eq (not a green pass, not a red fail).
// Each of the 4 color rows (fill/shadow-color/text/border-color) is locked in the bound-unresolved
// direction — otherwise a missing/wrong figBoundUnresolved arg at one call site would not be caught.
describe('colorVerdict A2 — bound-but-unresolved color → review (never false-green/false-red)', () => {
  // 1. fill bound-unresolved + bg MATCHES → review (NOT pass) — closes the false-green.
  it('A2 fill: *BoundVar set, *Token undefined, bg matches → review (not silent pass)', () => {
    const s = baseSpec(); // fillHex #ffffff == DOM backgroundColor #ffffff
    s.fillBoundVar = 'VariableID:1:2'; // bound to a variable, but fillToken is NOT set
    const f = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.note).toMatch(/bound to a variable, but the token is not resolved/);
  });

  // 2. fill bound-unresolved + bg DIVERGES → review (NOT fail) — closes the false-red regression.
  it('A2 fill: *BoundVar set, *Token undefined, bg diverges → review (not false-red fail)', () => {
    const s = baseSpec();
    s.fillHex = '#8f8fa3'; // diverges from DOM #ffffff
    s.fillBoundVar = 'VariableID:1:2';
    expect(row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'fill')?.status).toBe('review');
  });

  // 3. shadow-color colorBoundVar set + colorToken undefined + hex DIVERGES → review (NOT fail).
  //    A deliberate amendment of the original intent (which called for a fail here) (the shadow token is always deferred).
  it('A2 shadow-color: colorBoundVar set, colorToken undefined, hex diverges → review (not fail)', () => {
    const s = baseSpec();
    s.shadow = { inner: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#0000001a', colorBoundVar: 'VariableID:3:4', count: 1 };
    const d = baseSnap();
    d.shadow = { inset: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#000000ff', count: 1 };
    expect(row(diffPair(s, d, { tolerancePx: 1 }), 'shadow-color')?.status).toBe('review');
  });

  // 4. shadow-color bound-unresolved + hex MATCHES → review (NOT pass).
  it('A2 shadow-color: colorBoundVar set, colorToken undefined, hex matches → review (not silent pass)', () => {
    const s = baseSpec();
    s.shadow = { inner: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#0000001a', colorBoundVar: 'VariableID:3:4', count: 1 };
    const d = baseSnap();
    d.shadow = { inset: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#0000001a', count: 1 };
    expect(row(diffPair(s, d, { tolerancePx: 1 }), 'shadow-color')?.status).toBe('review');
  });

  // 5. text color[...]: colorBoundVar set + colorToken undefined + diverges → review.
  it('A2 text color: colorBoundVar set, colorToken undefined, diverges → review', () => {
    const s = baseSpec();
    s.children[1].text = { ...s.children[1].text!, colorHex: '#8f8fa3', colorBoundVar: 'VariableID:5:6' }; // DOM #141414
    expect(row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'color[label]')?.status).toBe('review');
  });

  // 6. border-color: strokeBoundVar set + strokeToken undefined + diverges → review.
  it('A2 border-color: strokeBoundVar set, strokeToken undefined, diverges → review', () => {
    const s = baseSpec();
    s.strokeHex = '#00ff00'; s.strokeWeight = 2; s.strokeBoundVar = 'VariableID:7:8';
    const d = baseSnap(); // borders 2 all sides
    d.borderColors = { top: '#ff0000', right: '#ff0000', bottom: '#ff0000', left: '#ff0000' };
    expect(row(diffPair(s, d, { tolerancePx: 1 }), 'border-color')?.status).toBe('review');
  });

  // CONTROL 7: raw-literal fill (NO fillBoundVar) — A2 does not re-fire: matched→pass, diverged→fail.
  it('A2 control: raw-literal fill (no fillBoundVar) unchanged — matches → pass, diverges → fail', () => {
    const sEq = baseSpec(); // fillHex #ffffff == DOM, no token/binding
    const eq = row(diffPair(sEq, baseSnap(), { tolerancePx: 1 }), 'fill');
    expect(eq?.status).toBe('pass');
    expect(eq?.note).toBeUndefined();
    const sDiv = baseSpec();
    sDiv.fillHex = '#8f8fa3'; // diverges, no binding → an honest fail
    expect(row(diffPair(sDiv, baseSnap(), { tolerancePx: 1 }), 'fill')?.status).toBe('fail');
  });

  // CONTROL 8: resolved-guard — fillToken IS SET (even with fillBoundVar set) → figBoundUnresolved
  // false (Token !== undefined) → A2 does NOT intercept, we go to group D (unknown domToken → review).
  // Proves the gate checks *Token === undefined, not just *BoundVar !== undefined.
  it('A2 control: fillToken resolved (even with fillBoundVar set) → group-D review, NOT A2-intercepted', () => {
    const s = baseSpec(); // fillHex #ffffff == DOM bg
    s.fillBoundVar = 'VariableID:1:2';
    s.fillToken = { token: 'bg/card', effectiveHex: '#ffffff', effectiveModeSource: 'explicit_node' };
    const f = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('review');
    // Group D (hex matched, DOM token not read) — NOT the A2 note
    expect(f?.note).toContain('the DOM token was not read');
    expect(f?.note).not.toMatch(/bound to a variable, but the token is not resolved/);
  });

  // CONTROL 8-text (twin): colorToken IS SET (with colorBoundVar set) → the text formula
  // figBoundUnresolved (colorBoundVar !== undefined && colorToken === undefined) is false → A2 does NOT
  // intercept, we go to group D. Locks `&& colorToken === undefined` at the TEXT call site.
  it('A2 control: text colorToken resolved (even with colorBoundVar set) → group-D review, NOT A2-intercepted', () => {
    const s = baseSpec(); // text colorHex #141414 == DOM color #141414
    s.children[1].text = { ...s.children[1].text!, colorBoundVar: 'VariableID:5:6',
      colorToken: { token: 'text color/accent', effectiveHex: '#141414', effectiveModeSource: 'explicit_node' } };
    const c = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'color[label]');
    expect(c?.status).toBe('review');
    expect(c?.note).toContain('the DOM token was not read');
    expect(c?.note).not.toMatch(/bound to a variable, but the token is not resolved/);
  });

  // CONTROL 8-border (twin): strokeToken IS SET (with strokeBoundVar set) → the border formula
  // figBoundUnresolved is false → A2 does NOT intercept, we go to group D. Locks `&& strokeToken === undefined`
  // at the BORDER call site.
  it('A2 control: border strokeToken resolved (even with strokeBoundVar set) → group-D review, NOT A2-intercepted', () => {
    const s = baseSpec();
    s.strokeHex = '#00ff00'; s.strokeWeight = 2; s.strokeBoundVar = 'VariableID:7:8';
    s.strokeToken = { token: 'border/default', effectiveHex: '#00ff00', effectiveModeSource: 'explicit_node' };
    const d = baseSnap(); // borders 2 all sides
    d.borderColors = { top: '#00ff00', right: '#00ff00', bottom: '#00ff00', left: '#00ff00' };
    const c = row(diffPair(s, d, { tolerancePx: 1 }), 'border-color');
    expect(c?.status).toBe('review');
    expect(c?.note).toContain('the DOM token was not read');
    expect(c?.note).not.toMatch(/bound to a variable, but the token is not resolved/);
  });
});

// ── end-to-end never-false-green locks ──
// (1) benign info-only guard: info does NOT gate the verdict (otherwise an honest "color not recognized" falsely reds).
// (2) fill/border/shadow threading locks: the REAL DOM token must reach colorVerdict as the 4th arg in
//     EACH of the four color rows. The text site is already locked by the group-D tests above; fill/border/shadow —
//     not (a rollback of the 4th arg to undefined left the suite green). Each lock below catches that mutation: with
//     correct forwarding = fail "tokenize it" (group-D literal), on a 4th-arg rollback → dt=not-captured →
//     review "the DOM token was not read" ≠ fail → the test fails (BOTH the status AND the note diverge).
describe('e2e never-false-green locks', () => {
  it('benign guard: an info-only pair keeps complete=true / headline green (info does NOT gate)', () => {
    const s = baseSpec();
    // Align the typography with the DOM (otherwise font-size/weight fails would gate), leaving the color info
    // as the ONLY non-pass axis (DOM color unrecognized — oklch/color()/transparent).
    s.children[1].text = { ...s.children[1].text!, fontSize: 18, fontWeight: 700, colorHex: '#141414',
      colorToken: { token: 't', effectiveHex: '#141414', effectiveModeSource: 'explicit_node' } };
    const snap = baseSnap(); (snap.children[1] as any).styles.color = undefined; // oklch → toHex undefined → info
    const rows = diffPair(s, snap, { tolerancePx: 1 });
    const summary = summarize(rows);
    // guardrail: info is present and it is the ONLY non-pass gating axis
    expect(summary.info).toBeGreaterThanOrEqual(1);
    expect(summary.fail).toBe(0);
    expect(summary.review).toBe(0);
    expect(summary.demoted).toBe(0);
    expect(summary.unchecked).toBe(0);
    const v = buildVerification([{ node_id: '1:1', rows, summary, coverage: deriveCoverage(rows) }], { depthLevels: 4 });
    expect(v.complete).toBe(true); // info does not downgrade the verdict
  });

  it('B fill threading-lock: figToken + DOM backgroundColorToken {literal} + hex matches → group-D fail "tokenize it"', () => {
    const s = baseSpec(); // fillHex #ffffff == DOM bg #ffffff (matched)
    s.fillToken = { token: 'neutral/bg/base', effectiveHex: '#ffffff', effectiveModeSource: 'explicit_node' };
    const d = baseSnap();
    (d.styles as any).backgroundColorToken = { literal: true };
    const f = row(diffPair(s, d, { tolerancePx: 1 }), 'fill');
    // a rollback of backgroundColorToken → undefined: dt=not-captured → review ("the DOM token was not read") ≠ fail
    expect(f?.status).toBe('fail');
    expect(f?.note).toMatch(/literal|tokenize/);
  });

  it('B border threading-lock: strokeToken + DOM borderColorsToken {literal} (uniform) + hex matches → group-D fail', () => {
    const s = baseSpec();
    s.strokeHex = '#00ff00'; s.strokeWeight = 2;
    s.strokeToken = { token: 'border/accent', effectiveHex: '#00ff00', effectiveModeSource: 'explicit_node' };
    const d = baseSnap(); // borders 2 on all 4 sides → activeSides.length===4
    d.borderColors = { top: '#00ff00', right: '#00ff00', bottom: '#00ff00', left: '#00ff00' }; // uniform, matched the stroke
    d.borderColorsToken = { top: { literal: true }, right: { literal: true }, bottom: { literal: true }, left: { literal: true } };
    const c = row(diffPair(s, d, { tolerancePx: 1 }), 'border-color');
    // a rollback of borderColorsToken[top] → undefined: dt=not-captured → review ≠ fail
    expect(c?.status).toBe('fail');
    expect(c?.note).toMatch(/literal|tokenize/);
  });

  it('B shadow threading-lock: fs.colorToken + DOM shadow.colorToken {literal} + hex matches → group-D fail (ds.colorToken set by hand)', () => {
    const s = baseSpec();
    s.shadow = { inner: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#000000',
      colorToken: { token: 'shadow/ambient', effectiveHex: '#000000', effectiveModeSource: 'explicit_node' }, count: 1 };
    const d = baseSnap();
    d.shadow = { inset: false, x: 0, y: 4, blur: 6, spread: 0, colorHex: '#000000', colorToken: { literal: true }, count: 1 };
    const c = row(diffPair(s, d, { tolerancePx: 1 }), 'shadow-color');
    // a rollback of ds.colorToken → undefined: dt=not-captured → review ≠ fail
    expect(c?.status).toBe('fail');
    expect(c?.note).toMatch(/literal|tokenize/);
  });
});

// ── C-branch fail rows carry the token NAME (feedback 15.1's literal ask: the name is what a
// developer writes into code, and the FAIL branch is exactly where they must act). Every other
// colorVerdict branch already sets token/tokenReason; verification groups blocking items by
// r.token — a nameless fail cannot be grouped or addressed.
describe('colorVerdict C — fail rows carry token + tokenReason color-diverged', () => {
  it('hex diverges, token resolved with a confirmed mode → fail carries token and tokenReason', () => {
    const s = baseSpec();
    s.fillHex = '#8f8fa3';
    s.fillBoundVar = 'VariableID:1:2';
    s.fillToken = { token: 'bg/level 2', effectiveHex: '#8f8fa3', effectiveModeSource: 'explicit_node' };
    const f = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('fail');
    expect(f?.token).toBe('bg/level 2');
    expect(f?.tokenReason).toBe('color-diverged');
  });
  it('mode-mismatch sub-branch (a DIFFERENT mode matches the DOM) → fail still carries the token', () => {
    const s = baseSpec();
    s.fillHex = '#8f8fa3';
    s.fillBoundVar = 'VariableID:1:2';
    s.fillToken = { token: 'bg/level 2', effectiveHex: '#8f8fa3', effectiveModeSource: 'explicit_node',
      all_modes: { Solar: '#8f8fa3', Lunar: '#ffffff' } };
    const f = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'fill'); // DOM bg #ffffff == Lunar
    expect(f?.status).toBe('fail');
    expect(f?.note).toMatch(/mode Lunar/);
    expect(f?.token).toBe('bg/level 2');
    expect(f?.tokenReason).toBe('color-diverged');
  });
  it('CONTROL: tokenless fail (raw literal diverges) stays nameless — no token field invented', () => {
    const s = baseSpec();
    s.fillHex = '#8f8fa3';
    const f = row(diffPair(s, baseSnap(), { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('fail');
    expect(f?.token).toBeUndefined();
    expect(f?.tokenReason).toBeUndefined();
  });
});

// ── semantic-confirm v3: gate on POSITIVE authored evidence (codeSyntax), never on inequality.
// Two panels' verdict: no lexical rule and no bare authored-mismatch separates true mis-wiring
// from alias-tier convention — the ONLY sound gate is a collision (the DOM var name is the
// authored codeSyntax name of a DIFFERENT, non-alias-related variable). Everything else lands
// byte-for-byte on the legacy value-based rule.
describe('colorVerdict D — codeSyntax evidence (positive collision only)', () => {
  const EV = (over: Partial<{ nameOf: any; idsByName: any; aliasRelation: any }> = {}) => ({
    nameOf: (id: string) => (id === 'V:1' ? '--ds-x' : undefined),
    idsByName: (n: string) => (n === '--ds-x' ? ['V:1'] : n === '--ds-other' ? ['V:9'] : []),
    aliasRelation: (a: string, b: string) => (a === b ? 'related' as const : 'unrelated' as const),
    ...over,
  });
  const evSpec = () => {
    const s = baseSpec();
    s.fillBoundVar = 'V:1';
    s.fillToken = { token: 'bg/x', effectiveHex: '#ffffff', effectiveModeSource: 'explicit_node' };
    return s;
  };
  const evSnap = (domVar: string) => {
    const d = baseSnap();
    (d.styles as Record<string, unknown>).backgroundColorToken = { token: domVar };
    return d;
  };

  it('authored MATCH (dom var === bound variable codeSyntax name, unique) → PASS, review noise gone', () => {
    const f = row(diffPair(evSpec(), evSnap('--ds-x'), { tolerancePx: 1, cssEvidence: EV() }), 'fill');
    expect(f?.status).toBe('pass');
    expect(f?.note).toMatch(/codeSyntax/);
  });

  it('COLLISION (dom var is the authored name of a DIFFERENT variable) → review semantic-diverged with domToken', () => {
    const f = row(diffPair(evSpec(), evSnap('--ds-other'), { tolerancePx: 1, cssEvidence: EV() }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.tokenReason).toBe('semantic-diverged');
    expect(f?.token).toBe('bg/x');
    expect(f?.domToken).toBe('--ds-other');
    expect(f?.note).toMatch(/--ds-other/);
  });

  it('dom var ABSENT from the authored map → legacy semantic-confirm (absence of evidence never gates)', () => {
    const f = row(diffPair(evSpec(), evSnap('--unknown'), { tolerancePx: 1, cssEvidence: EV() }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });

  it('ALIAS-RELATED collision → legacy (a component tier aliasing the bound token is correct wiring)', () => {
    const f = row(diffPair(evSpec(), evSnap('--ds-other'), { tolerancePx: 1, cssEvidence: EV({ aliasRelation: () => 'related' as const }) }), 'fill');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });

  it('AMBIGUOUS authored name (two variables mint it) → no PASS, legacy', () => {
    const f = row(diffPair(evSpec(), evSnap('--ds-x'), { tolerancePx: 1,
      cssEvidence: EV({ idsByName: (n: string) => (n === '--ds-x' ? ['V:1', 'V:2'] : []) }) }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });

  it('BRANCH ORDER LOCK: mode-unconfirmed outranks a matching codeSyntax — evidence must not skip gate B', () => {
    const s = evSpec();
    s.fillToken = { token: 'bg/x', defaultHex: '#ffffff', effectiveHex: null, effectiveModeSource: 'unverifiable' };
    const f = row(diffPair(s, evSnap('--ds-x'), { tolerancePx: 1, cssEvidence: EV() }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.tokenReason).toBe('mode-unconfirmed');
  });

  it('no evidence wired (opts.cssEvidence absent) → byte-for-byte legacy', () => {
    const f = row(diffPair(evSpec(), evSnap('--ds-x'), { tolerancePx: 1 }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });
});

// ── wave catches (both CONFIRMED with live repro): the producer census and the evidence symmetry ──
describe('colorVerdict D evidence — wave locks', () => {
  const EV2 = {
    nameOf: (id: string) => (id === 'V:1' ? '--ds-x' : undefined),
    idsByName: (n: string) => (n === '--ds-x' ? ['V:1'] : n === '--ds-other' ? ['V:9'] : []),
    aliasRelation: (a: string, b: string) => (a === b ? 'related' as const : 'unrelated' as const),
  };

  it('ROOT-is-TEXT pair: evidence reaches the root text color row (5th producer — the census miss)', () => {
    // The pair root is itself a Figma TEXT; its color row is produced by descriptiveRows' own
    // typographyRows call, which shipped WITHOUT the evidence argument — the collision silently
    // fell to legacy for the most common text pairing shape.
    const s: LayoutSpec = {
      node: { id: '2:1', name: 'label', type: 'TEXT' },
      rect: { x: 0, y: 0, w: 200, h: 24 },
      text: { fontFamily: 'Inter', fontWeight: 400, fontSize: 16, colorHex: '#141414',
        colorBoundVar: 'V:1', colorToken: { token: 'text/x', effectiveHex: '#141414', effectiveModeSource: 'explicit_node' } },
      children: [],
    };
    const d = baseSnap();
    d.rect = { x: 0, y: 0, w: 200, h: 24 };
    d.children = [{ kind: 'text', rect: { x: 0, y: 0, w: 200, h: 24 }, text: 'Причина',
      styles: { fontFamily: '"Inter", sans-serif', fontWeight: 400, fontSize: 16, lineHeight: 24, letterSpacing: 'normal', color: '#141414' } }];
    (d.styles as Record<string, unknown>).colorToken = { token: '--ds-other' };
    (d.styles as Record<string, unknown>).color = '#141414';
    const rows = diffPair(s, d, { tolerancePx: 1, cssEvidence: EV2 });
    const c = rows.find((r) => r.prop.startsWith('color'));
    expect(c?.tokenReason).toBe('semantic-diverged');
    expect(c?.domToken).toBe('--ds-other');
  });

  it('bound variable WITHOUT authored codeSyntax + DOM var minted by an unrelated variable → LEGACY (absence of evidence about the BOUND side never gates)', () => {
    const s = baseSpec();
    s.fillBoundVar = 'V:77'; // nameOf(V:77) === undefined — no authored mapping on the bound side
    s.fillToken = { token: 'bg/x', effectiveHex: '#ffffff', effectiveModeSource: 'explicit_node' };
    const d = baseSnap();
    (d.styles as Record<string, unknown>).backgroundColorToken = { token: '--ds-other' }; // authored by V:9
    const f = row(diffPair(s, d, { tolerancePx: 1, cssEvidence: EV2 }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });

  it('case typo lands LEGACY, not diverged (a case-variant name is absent from the exact-match map)', () => {
    const s = baseSpec();
    s.fillBoundVar = 'V:1'; // authored '--ds-x'
    s.fillToken = { token: 'bg/x', effectiveHex: '#ffffff', effectiveModeSource: 'explicit_node' };
    const d = baseSnap();
    (d.styles as Record<string, unknown>).backgroundColorToken = { token: '--DS-X' };
    const f = row(diffPair(s, d, { tolerancePx: 1, cssEvidence: EV2 }), 'fill');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });
});

// ── delta-wave locks: the quantifier gate has NO representative and no order dependence ──
describe('colorVerdict D evidence — quantifier gate (delta-wave locks)', () => {
  const spec = () => {
    const s = baseSpec();
    s.fillBoundVar = 'V:F';
    s.fillToken = { token: 'bg/f', effectiveHex: '#ffffff', effectiveModeSource: 'explicit_node' };
    return s;
  };
  const snapWith = (domVar: string) => {
    const d = baseSnap();
    (d.styles as Record<string, unknown>).backgroundColorToken = { token: domVar };
    return d;
  };

  it('HUB REPRO (was order-dependent semantic-diverged): bound related to ONE of several minters → legacy, never a gate', () => {
    // minters KD,KE,KC all mint --ds-x; bound V:F aliases KE (related to it, unrelated to KD/KC).
    const EV = {
      nameOf: (id: string) => (id === 'V:F' ? '--other-name' : undefined),
      idsByName: (n: string) => (n === '--ds-x' ? ['key:d', 'key:e', 'key:c'] : []),
      aliasRelation: (a: string, b: string) => (a === b || (new Set([a, b]).has('key:e') && new Set([a, b]).has('V:F')) ? 'related' as const : 'unrelated' as const),
    };
    const f = row(diffPair(spec(), snapWith('--ds-x'), { tolerancePx: 1, cssEvidence: EV }), 'fill');
    expect(f?.tokenReason).toBe('semantic-confirm'); // related to at least one minter → no gate
  });

  it('gate fires only when bound is provably unrelated to EVERY minter', () => {
    const EV = {
      nameOf: (id: string) => (id === 'V:F' ? '--other-name' : undefined),
      idsByName: (n: string) => (n === '--ds-x' ? ['key:d', 'key:e'] : []),
      aliasRelation: (a: string, b: string) => (a === b ? 'related' as const : 'unrelated' as const),
    };
    const f = row(diffPair(spec(), snapWith('--ds-x'), { tolerancePx: 1, cssEvidence: EV }), 'fill');
    expect(f?.tokenReason).toBe('semantic-diverged');
  });

  it('PASS through an alias twin: bound mints the name, the co-minter is related → pass', () => {
    const EV = {
      nameOf: (id: string) => (id === 'V:F' ? '--ds-x' : undefined),
      idsByName: (n: string) => (n === '--ds-x' ? ['V:F', 'key:twin'] : []),
      aliasRelation: (a: string, b: string) => (a === b || (new Set([a, b]).has('key:twin') && new Set([a, b]).has('V:F')) ? 'related' as const : 'unrelated' as const),
    };
    const f = row(diffPair(spec(), snapWith('--ds-x'), { tolerancePx: 1, cssEvidence: EV }), 'fill');
    expect(f?.status).toBe('pass');
  });

  it('NO pass when an UNRELATED co-minter exists (the name identifies no single mapping)', () => {
    const EV = {
      nameOf: (id: string) => (id === 'V:F' ? '--ds-x' : undefined),
      idsByName: (n: string) => (n === '--ds-x' ? ['V:F', 'key:stranger'] : []),
      aliasRelation: (a: string, b: string) => (a === b ? 'related' as const : 'unrelated' as const),
    };
    const f = row(diffPair(spec(), snapWith('--ds-x'), { tolerancePx: 1, cssEvidence: EV }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });
});

// ── release-verification catch (0.23.0): unknown must not buy a PASS. The boolean facade
// conflated 'proven related' with 'cannot exclude', and the PASS quantifier turned an
// UNWALKABLE co-minter into a green. Tri-state at the interface: PASS demands PROVEN
// relatedness of every co-minter; the gate demands PROVEN unrelatedness of every minter.
describe('colorVerdict D evidence — tri-state at the interface (no green through unknown)', () => {
  const spec = () => {
    const s = baseSpec();
    s.fillBoundVar = 'V:F';
    s.fillToken = { token: 'bg/f', effectiveHex: '#ffffff', effectiveModeSource: 'explicit_node' };
    return s;
  };
  const snapWith = (domVar: string) => {
    const d = baseSnap();
    (d.styles as Record<string, unknown>).backgroundColorToken = { token: domVar };
    return d;
  };
  it('an UNWALKABLE co-minter (unknown) downgrades PASS to legacy — never green through a hole', () => {
    const EV = {
      nameOf: (id: string) => (id === 'V:F' ? '--ds-x' : undefined),
      idsByName: (n: string) => (n === '--ds-x' ? ['V:F', 'key:behind-hole'] : []),
      aliasRelation: (a: string, b: string) => (a === b ? 'related' as const : 'unknown' as const),
    };
    const f = row(diffPair(spec(), snapWith('--ds-x'), { tolerancePx: 1, cssEvidence: EV }), 'fill');
    expect(f?.status).toBe('review');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });
  it('the gate still requires PROVEN unrelatedness (unknown minter → legacy, unchanged)', () => {
    const EV = {
      nameOf: (id: string) => (id === 'V:F' ? '--other' : undefined),
      idsByName: (n: string) => (n === '--ds-x' ? ['key:behind-hole'] : []),
      aliasRelation: () => 'unknown' as const,
    };
    const f = row(diffPair(spec(), snapWith('--ds-x'), { tolerancePx: 1, cssEvidence: EV }), 'fill');
    expect(f?.tokenReason).toBe('semantic-confirm');
  });
});
