import { describe, it, expect } from 'vitest';
import { gradientVerdict } from '../../src/domain/layout-spec/gradient-verdict.js';
import { buildLayoutSpec } from '../../src/domain/layout-spec/projector.js';
import type { GradientModel } from '../../src/domain/layout-spec/types.js';
const G = (o: Partial<GradientModel> = {}): GradientModel => ({ kind:'linear', angleDeg:90,
  stops:[{position:0,hex:'#000000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}],
  whole:{literal:true}, ...o });
const status = (rows: any[], p: string) => rows.find((r) => r.prop === p)?.status;
describe('gradientVerdict presence/kind/stops', () => {
  it('fig gradient, DOM solid → fail presence', () => {
    expect(status(gradientVerdict(G(), undefined, '#123456'), 'gradient')).toBe('fail');
  });
  it('fig gradient, DOM no bg → warn presence', () => {
    expect(status(gradientVerdict(G(), undefined, undefined), 'gradient')).toBe('warn');
  });
  it('kind mismatch → fail', () => {
    expect(status(gradientVerdict(G(), G({ kind:'radial' }), undefined), 'gradient-kind')).toBe('fail');
  });
  it('kind unknown → info', () => {
    expect(status(gradientVerdict(G({ kind:'unknown' }), G({ kind:'unknown' }), undefined), 'gradient-kind')).toBe('info');
  });
  it('stop count mismatch → warn (no per-stop compare)', () => {
    const dom = G({ stops:[{position:0,hex:'#000000',token:{literal:true}}] });
    expect(status(gradientVerdict(G(), dom, undefined), 'gradient-stops')).toBe('warn');
  });
  it('stop color diverges → fail', () => {
    const dom = G({ stops:[{position:0,hex:'#ff0000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}] });
    expect(status(gradientVerdict(G(), dom, undefined), 'gradient-stop-0-color')).toBe('fail');
  });
  it('dom stop hex undefined (oklch) → info not fail', () => {
    const dom = G({ stops:[{position:0,hex:undefined,token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}] });
    expect(status(gradientVerdict(G(), dom, undefined), 'gradient-stop-0-color')).toBe('info');
  });
  it('dom stop hex undefined AT diverging position → NO position fail (transition-hint phantom)', () => {
    // Figma stop-0 @0, DOM phantom @0.2 (empty-color transition-hint): |Δ|=0.2>0.02 would false-RED under naive code.
    const dom = G({ stops:[{position:0.2,hex:undefined,token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}] });
    const rows = gradientVerdict(G(), dom, undefined);
    expect(status(rows, 'gradient-stop-0-position')).toBeUndefined();
    expect(status(rows, 'gradient-stop-0-color')).toBe('info');
  });
  it('stop position diverges >2% → fail', () => {
    const dom = G({ stops:[{position:0.1,hex:'#000000',token:{literal:true}},{position:1,hex:'#ffffff',token:{literal:true}}] });
    expect(status(gradientVerdict(G(), dom, undefined), 'gradient-stop-0-position')).toBe('fail');
  });
  it('identical gradients → no fail rows', () => {
    const rows = gradientVerdict(G(), G(), undefined);
    expect(rows.every((r) => r.status !== 'fail')).toBe(true);
  });
});
describe('gradientVerdict angle', () => {
  it('linear angle within 3deg → pass', () => {
    expect(status(gradientVerdict(G({angleDeg:90}), G({angleDeg:92}), undefined), 'gradient-angle')).toBe('pass');
  });
  it('linear angle diverges >3deg → fail', () => {
    expect(status(gradientVerdict(G({angleDeg:90}), G({angleDeg:120}), undefined), 'gradient-angle')).toBe('fail');
  });
  it('360-wrap: 359 vs 1 → pass', () => {
    expect(status(gradientVerdict(G({angleDeg:359}), G({angleDeg:1}), undefined), 'gradient-angle')).toBe('pass');
  });
  it('angle undefined → info', () => {
    expect(status(gradientVerdict(G({angleDeg:undefined}), G({angleDeg:90}), undefined), 'gradient-angle')).toBe('info');
  });
  it('radial → geometry unchecked (previously reported gradient-angle info)', () => {
    const rows = gradientVerdict(G({kind:'radial',angleDeg:undefined}), G({kind:'radial',angleDeg:undefined}), undefined);
    expect(status(rows, 'gradient-geometry')).toBe('unchecked');
    expect(status(rows, 'gradient-angle')).toBeUndefined();
  });
});
const T = (whole: any, stops: any[] = [{literal:true},{literal:true}]): GradientModel =>
  ({ kind:'linear', angleDeg:90, whole, stops: stops.map((t, i) => ({ position: i, hex: i? '#ffffff':'#000000', token: t })) });
describe('gradientVerdict token axes', () => {
  it('fig token × dom literal → fail (tokenize)', () => {
    expect(status(gradientVerdict(T({token:'brand'}), T({literal:true}), undefined), 'gradient-token')).toBe('fail');
  });
  it('fig token × dom token → review', () => {
    expect(status(gradientVerdict(T({token:'brand'}), T({token:'--brand-gradient'}), undefined), 'gradient-token')).toBe('review');
  });
  it('fig token × dom unknown → review', () => {
    expect(status(gradientVerdict(T({token:'brand'}), T({unknown:'unattributed'}), undefined), 'gradient-token')).toBe('review');
  });
  it('fig literal × dom token → pass', () => {
    expect(status(gradientVerdict(T({literal:true}), T({token:'--g'}), undefined), 'gradient-token')).toBe('pass');
  });
  it('per-stop: fig token stop × dom literal stop → fail', () => {
    const fig = T({literal:true}, [{token:'brand/0'},{literal:true}]);
    const dom = T({literal:true}, [{literal:true},{literal:true}]);
    expect(status(gradientVerdict(fig, dom, undefined), 'gradient-stop-0-token')).toBe('fail');
  });
  it('provenance review branches carry token/tokenReason: semantic-confirm and the open unknown code', () => {
    const rows = gradientVerdict(
      { kind: 'linear', stops: [], whole: { token: 'grad/main' } } as any,
      { kind: 'linear', stops: [], whole: { token: '--grad-main' } } as any, undefined);
    const tok = rows.find((r) => r.prop === 'gradient-token')!;
    expect(tok.status).toBe('review');
    expect(tok.token).toBe('grad/main');
    expect(tok.tokenReason).toBe('semantic-confirm');
    const rows2 = gradientVerdict(
      { kind: 'linear', stops: [], whole: { token: 'grad/main' } } as any,
      { kind: 'linear', stops: [], whole: { unknown: 'layered-undecidable' } } as any, undefined);
    const tok2 = rows2.find((r) => r.prop === 'gradient-token')!;
    expect(tok2.tokenReason).toBe('layered-undecidable');
  });
  // Mutation-lock per-stop provenance spread (the class "the last unlocked mirror" — the display field is locked symmetrically across all rows):
  // the provenance consumer on the per-stop rows (gradient-verdict.ts, gradient-stop-N-token) must
  // spread token/tokenReason the same way the whole consumer does — otherwise the confirm_token aggregation
  // (verification.ts) sees per-stop review rows WITHOUT the structural markers → legacy branch → a flood
  // of single entries instead of a group. The mutation "per-stop spread removed" → token/tokenReason undefined → RED.
  it('lock per-stop spread: fig stop {token} × dom stop {unknown} → the row carries token/tokenReason', () => {
    const fig = T({literal:true}, [{token:'stop/tok'},{literal:true}]);
    const dom = T({literal:true}, [{unknown:'oklch'},{literal:true}]);
    const row = gradientVerdict(fig, dom, undefined).find((r) => r.prop === 'gradient-stop-0-token')!;
    expect(row.status).toBe('review');
    expect(row.token).toBe('stop/tok');
    expect(row.tokenReason).toBe('oklch');
  });
});

describe('gradient never-false-green mutation-locks', () => {
  // Lock oklch-guard : gradient-verdict.ts — the `ds.hex === undefined` info-branch.
  //   Revert (drop that branch / change to `if (false)`) → the unverifiable DOM stop falls to the
  //   `!eqHex` compare and false-REDs as `fail` → this test fails. An unreadable DOM stop color
  //   (oklch/lab/empty-color transition-hint) must stay `info` (verify-by-eye), never a fabricated fail.
  it('lock oklch-guard: DOM stop hex undefined → info, never fail', () => {
    const fig = G({ stops: [
      { position: 0, hex: '#ff0000', token: { literal: true } },
      { position: 1, hex: '#ffffff', token: { literal: true } },
    ] });
    const dom = G({ stops: [
      { position: 0, hex: undefined, token: { literal: true } },
      { position: 1, hex: '#ffffff', token: { literal: true } },
    ] });
    const rows = gradientVerdict(fig, dom, undefined);
    expect(status(rows, 'gradient-stop-0-color')).toBe('info');
    expect(rows.some((r) => r.prop === 'gradient-stop-0-color' && r.status === 'fail')).toBe(false);
  });

  // Lock stop-count guard : gradient-verdict.ts — the `f.stops.length !== d.stops.length` warn gate.
  //   Revert (always run the per-stop loop) → the loop indexes past the shorter side, `ds.hex` throws
  //   (out-of-bounds) OR a false per-stop compare fires → this test fails. Differing stop counts must
  //   degrade to ONE `warn`, never a per-stop compare on misaligned indices.
  it('lock stop-count: differing stop counts → warn, no per-stop rows', () => {
    const dom = G({ stops: [{ position: 0, hex: '#000000', token: { literal: true } }] }); // 1 stop
    const rows = gradientVerdict(G(), dom, undefined); // fig has 2 stops
    expect(status(rows, 'gradient-stops')).toBe('warn');
    expect(rows.some((r) => /^gradient-stop-\d/.test(r.prop))).toBe(false);
  });

  // Cross-module backstop (the never-false-green HEART) : the FIG model is built by the REAL
  //   projector. A bound Figma stop projects to per-stop {unknown:'bound-unresolved'} (name deferred)
  //   AND — atomically — whole={token:'(paint)'} (projector.ts figmaGradient `anyBound ? {token} : {literal}`).
  //   In the verdict: per-stop {unknown}(fig) × {literal}(dom) is NOT a token on the fig side → provenance
  //   returns pass → the `gradient-stop-N-token` row is SUPPRESSED. The WHOLE `gradient-token` row is what
  //   preserves never-false-green: {token:'(paint)'}(fig) × {literal}(dom) → FAIL.
  //   Mutation (projector.ts `whole: anyBound ? {token:'(paint)'} : {literal:true}` → `whole: {literal:true}`):
  //   the whole row no longer fails → the suppressed per-stop pass becomes a REAL false-green →
  //   gradient-token flips fail→pass → this test fails. Proves the cross-module coupling is load-bearing.
  it('cross-module backstop: fig bound-stop {unknown} suppresses per-stop row but whole gradient-token = fail', () => {
    const figBound = buildLayoutSpec({
      id: '1:1', name: 'btn', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
      fills: [{ type: 'GRADIENT_LINEAR', visible: true,
        gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }],
        gradientStops: [
          { position: 0, color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } } },
          { position: 1, color: { r: 1, g: 1, b: 1 } },
        ] }],
    } as never, {}).gradient!;
    // sanity: the projector really produced the backstop shape this lock depends on
    expect(figBound.stops[0].token).toEqual({ unknown: 'bound-unresolved' });
    expect(figBound.whole).toEqual({ token: '(paint)' });

    const dom = G(); // all-literal DOM gradient, identical hex/positions/angle
    const rows = gradientVerdict(figBound, dom, undefined);
    expect(status(rows, 'gradient-token')).toBe('fail');            // whole backstop fires
    expect(status(rows, 'gradient-stop-0-token')).toBeUndefined();  // per-stop row SUPPRESSED
  });
});

describe('gradientVerdict radial/conic geometry hedge', () => {
  it('radial both sides → gradient-geometry unchecked, NO gradient-angle', () => {
    const rows = gradientVerdict(G({ kind: 'radial', angleDeg: undefined }), G({ kind: 'radial', angleDeg: undefined }), undefined);
    expect(status(rows, 'gradient-geometry')).toBe('unchecked');
    expect(status(rows, 'gradient-angle')).toBeUndefined();
  });
  it('conic both sides → gradient-geometry unchecked', () => {
    const rows = gradientVerdict(G({ kind: 'conic', angleDeg: undefined }), G({ kind: 'conic', angleDeg: undefined }), undefined);
    expect(status(rows, 'gradient-geometry')).toBe('unchecked');
  });
  it('linear stays on gradient-angle pass, NO gradient-geometry row', () => {
    const rows = gradientVerdict(G({ angleDeg: 90 }), G({ angleDeg: 90 }), undefined);
    expect(status(rows, 'gradient-geometry')).toBeUndefined();
    expect(status(rows, 'gradient-angle')).toBe('pass');
  });
  it('linear-linear but an angle undefined → stays gradient-angle info, NOT geometry (edge)', () => {
    const rows = gradientVerdict(G({ kind: 'linear', angleDeg: undefined }), G({ kind: 'linear', angleDeg: 90 }), undefined);
    expect(status(rows, 'gradient-angle')).toBe('info');
    expect(status(rows, 'gradient-geometry')).toBeUndefined();
  });
});
