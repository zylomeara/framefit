import type { GradientModel, DiffRow } from './types.js';
const eqHex = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
type TS = { token: string } | { literal: true } | { unknown: string };
const isTok = (t: TS) => 'token' in t;
function provenance(fig: TS, dom: TS, label: string): { status: DiffRow['status']; note?: string; token?: string; tokenReason?: string } {
  if (isTok(fig) && 'literal' in dom) return { status: 'fail', note: `${label}: Figma from a token, DOM hardcoded a literal — tokenize it` };
  if (isTok(fig) && isTok(dom)) return { status: 'review', note: `${label}: both from a token — confirm the semantics`, token: (fig as { token: string }).token, tokenReason: 'semantic-confirm' };
  if (isTok(fig) && 'unknown' in dom) return { status: 'review', note: `${label}: DOM provenance not read (${(dom as { unknown: string }).unknown}) — confirm`, token: (fig as { token: string }).token, tokenReason: (dom as { unknown: string }).unknown };
  // branch-4 (fall-through pass). NB cross-module invariant: a per-stop {unknown}(fig) × anything(dom)
  // lands here as `pass` and its `gradient-stop-N-token` row is SUPPRESSED (see caller). This does NOT
  // lose never-false-green ONLY because projector.ts figmaGradient atomically sets `anyBound →
  // whole={token:'(paint)'}` — so the WHOLE `gradient-token` row still fails against a DOM literal. That
  // backstop is mutation-locked in gradient-verdict.test.ts; severing the projector's atomic whole
  // would turn this suppressed pass into a real false-green.
  return { status: 'pass' };
}
export function gradientVerdict(figG: GradientModel | undefined, domG: GradientModel | undefined, domBgHex: string | undefined): DiffRow[] {
  const rows: DiffRow[] = [];
  if (!figG && !domG) return rows;
  if (figG && !domG) {
    rows.push(domBgHex
      ? { prop: 'gradient', figma: 'gradient', dom: domBgHex, status: 'fail', note: 'Figma gradient, DOM is a solid color' }
      : { prop: 'gradient', figma: 'gradient', dom: null, status: 'warn', note: 'background may be on a different element' });
    return rows;
  }
  if (!figG && domG) { rows.push({ prop: 'gradient', figma: null, dom: 'gradient', status: 'warn', note: 'DOM gradient where Figma is flat' }); return rows; }
  const f = figG!, d = domG!;
  // kind
  if (f.kind === 'unknown' || d.kind === 'unknown') rows.push({ prop: 'gradient-kind', figma: f.kind, dom: d.kind, status: 'info', note: 'gradient kind not matched — verify visually' });
  else if (f.kind !== d.kind) rows.push({ prop: 'gradient-kind', figma: f.kind, dom: d.kind, status: 'fail', note: 'gradient kind does not match' });
  // stops
  if (f.stops.length !== d.stops.length) {
    rows.push({ prop: 'gradient-stops', figma: `${f.stops.length} stops`, dom: `${d.stops.length} stops`, status: 'warn', note: 'stop count differs — no matching done' });
  } else {
    for (let i = 0; i < f.stops.length; i++) {
      const fs = f.stops[i], ds = d.stops[i];
      if (ds.hex === undefined) {
        // DOM stop color unverifiable — oklch OR empty-color transition-hint phantom (e.g.
        // `linear-gradient(red, 20%, blue)` → phantom stop {hex:undefined, position:0.2}). Flag the WHOLE
        // stop for manual review with ONE info and SKIP the position axis. A hint carries a hint-percentage,
        // not a real stop position; diffing it against a Figma stop position is a false-RED "mismatch",
        // which is forbidden. The color-info marks the stop unchecked, so skipping position is honest
        // "verify by eye" — never a silent false-green.
        rows.push({ prop: `gradient-stop-${i}-color`, figma: fs.hex ?? null, dom: null, status: 'info', note: `stop ${i}: DOM color not recognized (oklch/hint) — verify the whole stop` });
        continue;
      }
      if (!eqHex(fs.hex, ds.hex)) rows.push({ prop: `gradient-stop-${i}-color`, figma: fs.hex ?? null, dom: ds.hex, status: 'fail', note: `stop ${i}: color does not match` });
      if (Math.abs(fs.position - ds.position) > 0.02) rows.push({ prop: `gradient-stop-${i}-position`, figma: fs.position, dom: ds.position, status: 'fail', note: `stop ${i}: position does not match` });
    }
  }
  const angDelta = (a: number, b: number) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return Math.min(d, 360 - d); };
  if (f.kind === 'linear' && d.kind === 'linear' && f.angleDeg !== undefined && d.angleDeg !== undefined) {
    rows.push(angDelta(f.angleDeg, d.angleDeg) > 3
      ? { prop: 'gradient-angle', figma: f.angleDeg, dom: d.angleDeg, status: 'fail', note: 'angle does not match (direction is compared)' }
      : { prop: 'gradient-angle', figma: f.angleDeg, dom: d.angleDeg, status: 'pass' });
  } else if (f.kind === 'linear' && d.kind === 'linear') {
    // both linear but an angle is unreadable on a side — keep the existing info on gradient-angle (it IS linear;
    // geometry hedge is for radial/conic only). Pre-existing case, out of this hedge's scope.
    rows.push({ prop: 'gradient-angle', figma: f.angleDeg ?? null, dom: d.angleDeg ?? null, status: 'info', note: 'angle not read — verify direction visually' });
  } else {
    // radial/conic/unknown (or a kind mismatch): center/radius/shape/from-angle are captured on NEITHER side.
    // Dedicated unchecked row → deriveCoverage lists it as a hole, so the pair cannot report terminal-green on
    // unverified geometry. NEVER a difference → cannot create a false-red. FULL geometry capture is deferred.
    rows.push({ prop: 'gradient-geometry', figma: f.kind, dom: d.kind, status: 'unchecked', note: 'radial/conic: center/radius/shape/rotation not compared — verify visually' });
  }
  // figma/dom carry the COMPARED provenance (the token name per side, null where a side has none) —
  // never a placeholder. The advisory demotion (rowValuesMatched) reads exactly figma/dom, and the
  // literals 'whole'/'stop' that used to sit here read as "matched" by construction: every gradient
  // token review became advisory, complete:true over gradients wired to DIFFERENT tokens and over a
  // DOM side that was never read. Null for an unread side keeps the null-guard gating honest.
  const tokOf = (t: TS): string | null => ('token' in t ? t.token : null);
  { const v = provenance(f.whole as TS, d.whole as TS, 'gradient'); rows.push({ prop: 'gradient-token', figma: tokOf(f.whole as TS), dom: tokOf(d.whole as TS), status: v.status, ...(v.note ? { note: v.note } : {}), ...(v.token ? { token: v.token } : {}), ...(v.tokenReason ? { tokenReason: v.tokenReason } : {}) }); }
  if (f.stops.length === d.stops.length) {
    for (let i = 0; i < f.stops.length; i++) {
      const v = provenance(f.stops[i].token as TS, d.stops[i].token as TS, `stop ${i}`);
      if (v.status !== 'pass') rows.push({ prop: `gradient-stop-${i}-token`, figma: tokOf(f.stops[i].token as TS), dom: tokOf(d.stops[i].token as TS), status: v.status, ...(v.note ? { note: v.note } : {}), ...(v.token ? { token: v.token } : {}), ...(v.tokenReason ? { tokenReason: v.tokenReason } : {}) });
    }
  }
  return rows;
}
