// compare_dom_to_dom domain core (feedback item 16): two DOM states of one screen, REFERENCE
// (what geometry should hold - e.g. the loaded page) vs CANDIDATE (what is checked - e.g. the
// skeleton). The reference is PROJECTED into the spec shape and the existing geometry engine
// runs in an explicit dom-dom mode. Panel-locked corrections, each CONFIRMED with a worked
// example before this file existed:
//  - PADDING-BOX normalization: the engine's content-edge math subtracts border+padding on the
//    candidate side only; the projection therefore emits the reference's PADDING box as rect
//    and carries reference.paddings as autoLayout.padding - the ONE deliberate exception to
//    never-fabricate (it is the only root-padding slot the engine reads). Without it two
//    byte-identical states fail every edge row by the root's whole inset.
//  - REFERENCE PREFLIGHT: the engine's environment gates read the candidate only; the
//    reference's transform / scroll / degenerate rect / unloaded fonts are gated HERE, before
//    projection, because diffPair structurally cannot see them.
//  - frameWidth = reference.innerWidth: unequal capture widths become the existing loud
//    viewport row instead of thirty confident false deltas.
//  - CONDITIONAL typography projection: the extractor puts a typo bundle on EVERY element;
//    mapping styles->text unconditionally would run the text-carrier machinery on every node.
//    Only children that genuinely carry text project a text.
import type { DomSnapshotOk, DomChild, DomColorToken, LayoutSpec, SpecChild, DiffRow, Edges, SpecRect } from './types.js';
import { diffPair, type DiffOptions } from './diff.js';

const ZERO: Edges = { top: 0, right: 0, bottom: 0, left: 0 };

// Dominant single-file direction from the reference children's geometry (neither snapshot
// declares flexDirection - the extractor never captured it). Ambiguous -> undefined -> the
// engine's own no-axis path (inter-element metrics skipped with its visible note).
export function inferAxis(children: { rect: { x: number; y: number; w: number; h: number } }[]): 'row' | 'col' | undefined {
  if (children.length < 2) return children.length === 1 ? 'col' : undefined;
  let col = true, row = true;
  for (let i = 1; i < children.length; i++) {
    const a = children[i - 1].rect, b = children[i].rect;
    if (b.y < a.y + a.h / 2) col = false;   // next child does not progress downward
    if (b.x < a.x + a.w / 2) row = false;   // next child does not progress rightward
  }
  if (col === row) return undefined;        // both (diagonal) or neither (grid/overlap) - ambiguous
  return col ? 'col' : 'row';
}

const carriesText = (c: DomChild): boolean =>
  c.kind === 'text' || (typeof c.text === 'string' && c.text.length > 0)
  || (c.children ?? []).some((k) => k.kind === 'text' && typeof k.text === 'string' && k.text.length > 0);

function childToSpec(c: DomChild, i: number): SpecChild {
  const out: SpecChild = {
    id: `ref:${i}`,
    name: c.kind === 'text' ? 'text' : [c.tag, ...(c.classList ?? []).slice(0, 1)].filter(Boolean).join('.') || 'element',
    type: carriesText(c) ? 'TEXT' : 'FRAME',
    rect: { x: c.rect.x, y: c.rect.y, w: c.rect.w, h: c.rect.h },
  } as SpecChild;
  const text = c.kind === 'text' ? c.text : (c.children ?? []).find((k) => k.kind === 'text')?.text ?? c.text;
  if (carriesText(c) && typeof text === 'string' && text.length > 0) out.textSnippet = text;
  // CONDITIONAL typography (panel lock 4): only where text genuinely lives.
  if (carriesText(c) && c.styles) {
    const st = c.styles as Record<string, unknown>;
    out.text = {
      ...(st.fontFamily !== undefined ? { fontFamily: st.fontFamily as string } : {}),
      ...(st.fontWeight !== undefined ? { fontWeight: st.fontWeight as number } : {}),
      ...(st.fontSize !== undefined ? { fontSize: st.fontSize as number } : {}),
      ...(typeof st.lineHeight === 'number' ? { lineHeightPx: st.lineHeight as number, lineHeightUnit: 'PIXELS' } : {}),
      ...(typeof st.letterSpacing === 'number' ? { letterSpacing: st.letterSpacing as number } : {}),
      ...(typeof st.color === 'string' && (st.color as string).startsWith('#') ? { colorHex: st.color as string } : {}),
    };
  }
  const kids = (c.children ?? []).filter((k) => k.kind === 'element');
  if (kids.length) (out as { children?: SpecChild[] }).children = kids.map((k, j) => childToSpec(k, i * 100 + j));
  if (c.outOfFlow !== undefined) (out as { outOfFlow?: number }).outOfFlow = c.outOfFlow;
  return out;
}

/** The reference snapshot projected into the spec shape the engine reads. */
export function domToSpecShape(reference: DomSnapshotOk): LayoutSpec {
  const b = reference.borders ?? ZERO;
  const p = reference.paddings ?? ZERO;
  // The reference's OWN scrollbar (wave finding 8): the candidate side subtracts a scrollbar
  // computed from the candidate, so a reference that scrolls must shed its own - two identical
  // scrolling states otherwise fail size.w by the scrollbar width, and the reverse case (only
  // the reference scrolls) is a false green on a real usable-width difference.
  const sbW = reference.clientWidth !== undefined
    ? Math.max(0, reference.rect.w - b.left - b.right - reference.clientWidth) : 0;
  const sbH = reference.clientHeight !== undefined
    ? Math.max(0, reference.rect.h - b.top - b.bottom - reference.clientHeight) : 0;
  // PADDING-BOX rect (panel lock 1), minus the reference scrollbar.
  const rect: SpecRect = {
    x: reference.rect.x + b.left, y: reference.rect.y + b.top,
    w: reference.rect.w - b.left - b.right - sbW, h: reference.rect.h - b.top - b.bottom - sbH,
  };
  const children = (reference.children ?? []).filter((c) => c.kind === 'element' || carriesText(c));
  const axis = inferAxis(children.map((c) => ({ rect: c.rect })));
  const spec: LayoutSpec = {
    node: { id: 'reference', name: reference.selector ?? 'reference', type: 'FRAME' },
    rect,
    children: children.map((c, i) => childToSpec(c, i)),
  } as LayoutSpec;
  // The padding slot is NOT gated on the axis (wave findings 6/7): the engine's size rows read
  // spec.autoLayout independently of spec.axis, so a grid root (axis not inferable) that lost its
  // paddings failed every size row on byte-identical states - and compared the reference's
  // padding box against the candidate's content box on real differences.
  spec.autoLayout = { padding: { ...p } };   // the deliberate exception (see header)
  if (axis) spec.axis = axis;
  // Root text (wave finding 10): without this, the dom-dom presence warn fired on EVERY root
  // that owns text - !spec.text was a tautology. Same conditional rule as children: only when
  // the reference root genuinely owns a direct text child.
  const rootText = (reference.children ?? []).find((k) => k.kind === 'text' && typeof k.text === 'string' && k.text.trim() !== '');
  const st = (reference.styles ?? {}) as Record<string, unknown>;
  if (rootText) {
    spec.text = {
      ...(st.fontFamily !== undefined ? { fontFamily: st.fontFamily as string } : {}),
      ...(st.fontWeight !== undefined ? { fontWeight: st.fontWeight as number } : {}),
      ...(st.fontSize !== undefined ? { fontSize: st.fontSize as number } : {}),
      ...(typeof st.lineHeight === 'number' ? { lineHeightPx: st.lineHeight as number, lineHeightUnit: 'PIXELS' as const } : {}),
      ...(typeof st.letterSpacing === 'number' ? { letterSpacing: st.letterSpacing as number } : {}),
      ...(typeof st.color === 'string' && (st.color as string).startsWith('#') ? { colorHex: st.color as string } : {}),
    };
    (spec as { textSnippet?: string }).textSnippet = rootText.text as string;
  }
  // UNPARSEABLE reference colors (oklch/color()) stay OUT of the axis entirely (panel lock 5):
  // a non-#hex backgroundColor projects nothing, and the presence row logic handles the rest.
  if (typeof st.backgroundColor === 'string' && (st.backgroundColor as string).startsWith('#')) {
    spec.fillHex = st.backgroundColor as string;
  } else if (typeof st.backgroundColor === 'string' && (st.backgroundColor as string).length > 0
      && st.backgroundColor !== 'transparent' && st.backgroundColor !== 'none') {
    spec.fillUnparseable = true;
  }
  if (typeof st.borderRadius === 'number' && !(st as { borderRadiusUncomparable?: boolean }).borderRadiusUncomparable) {
    spec.cornerRadius = st.borderRadius as number;
  }
  // Unconditional (wave finding 0): the engine's opacity gate needs BOTH sides, so a reference
  // at the normal 1 that projected nothing made ANY candidate opacity - 0.3, 0 - total silence.
  if (typeof st.opacity === 'number') spec.opacity = st.opacity as number;
  // Border axis (wave findings 1/11/17): the engine's border gate is two-sided but reads
  // spec.strokeHex - never projected, it was vacuously one-sided: border changes invisible and
  // every bordered candidate carried a permanent bogus warn. A uniform reference border projects
  // as the stroke; non-uniform/unparsed references are handled with an honest info row in
  // diffDomPair (the Figma stroke model cannot express them).
  {
    const act = (['top', 'right', 'bottom', 'left'] as const).filter((s) => b[s] > 0);
    if (act.length === 4) {
      const cols = act.map((s) => reference.borderColors?.[s]);
      const uniformC = cols.every((c) => c !== undefined) && cols.every((c) => c!.toLowerCase() === cols[0]!.toLowerCase());
      const uniformW = act.every((s) => b[s] === b.top);
      if (uniformC && uniformW) {
        spec.strokeHex = cols[0] as string;
        spec.strokeWeight = b.top;
      } else {
        spec.strokeUnprojectable = true;
      }
    } else if (act.length > 0) {
      spec.strokeUnprojectable = true;
    }
  }
  if (reference.shadow) {
    spec.shadow = { inner: !!reference.shadow.inset, x: reference.shadow.x, y: reference.shadow.y,
      blur: reference.shadow.blur, spread: reference.shadow.spread, count: reference.shadow.count ?? 1,
      ...(reference.shadow.colorHex ? { colorHex: reference.shadow.colorHex } : {}) };
  }
  if (reference.childrenTruncated) (spec as { childrenTruncated?: boolean }).childrenTruncated = true;
  // The reference extractor drops out-of-flow children the same way the candidate one does; the
  // count feeds the symmetric structure hint (a deeper capture will never reveal them).
  if (reference.outOfFlow) (spec as { outOfFlow?: number }).outOfFlow = reference.outOfFlow;
  return spec;
}

/** Environment gates for the REFERENCE side - the engine gates the candidate only. */
export function referencePreflight(reference: DomSnapshotOk): DiffRow[] {
  const rows: DiffRow[] = [];
  // Every refusing gate uses prop 'snapshot' - buildVerification maps it to a re_extract_dom
  // blocking item (wave finding 14: custom reference_* props were ADVISORY warns, so a corrupt
  // baseline was refused numbers but still verified complete:true).
  if (reference.transformed) rows.push({ prop: 'snapshot', status: 'warn',
    note: 'reference: captured under a CSS transform - its geometry is not a trustworthy baseline; re-capture without animation/transform' });
  if (reference.scroll && (reference.scroll.top !== 0 || reference.scroll.left !== 0)) rows.push({ prop: 'snapshot', status: 'warn',
    note: `reference: captured scrolled (top ${reference.scroll.top}, left ${reference.scroll.left}) - offsets are shifted; re-capture at scroll 0` });
  if (reference.rect.w < 1 || reference.rect.h < 1) rows.push({ prop: 'snapshot', status: 'warn',
    note: 'reference: degenerate rect - nothing to compare against' });
  if (reference.fontsLoaded === false) rows.push({ prop: 'reference_fonts', status: 'info',
    note: 'reference fonts were not loaded at capture - typography numbers may not match the settled render' });
  if (reference.paddings === undefined) rows.push({ prop: 'snapshot', status: 'warn',
    note: 'reference: no paddings in the snapshot - captured by an outdated extractor, every content-edge number would be silently wrong; re-capture with the current extractor' });
  return rows;
}

// Token-provenance drift (D4): the value row can pass on equal hexes while the tokenization
// silently changed between states (var()-anchored reference vs a literal candidate, or two
// different var names). Symmetric comparison of two DomColorTokens - NOT colorVerdict. The
// figma/dom fields carry PROVENANCE STRINGS (the gradient tokOf precedent), never hexes: a
// review row with equal figma/dom self-demotes via rowValuesMatched, and equal hexes would.
// Both-literal and any unknown/uncaptured side stay silent - drift is only claimable when both
// provenances are decisive.
function fillTokenDrift(ref: DomColorToken | undefined, cand: DomColorToken | undefined): DiffRow | undefined {
  const provOf = (t: DomColorToken | undefined): string | undefined =>
    t === undefined || 'unknown' in t ? undefined : 'token' in t ? `var(${t.token})` : 'literal';
  const a = provOf(ref), b = provOf(cand);
  if (a === undefined || b === undefined || (a === 'literal' && b === 'literal')) return undefined;
  if (a === b) return { prop: 'fill-token-drift', figma: a, dom: b, status: 'pass' };
  return { prop: 'fill-token-drift', figma: a, dom: b, status: 'review',
    note: 'the background tokenization changed between states - the rendered value may still match, but the CANDIDATE no longer resolves it the way the REFERENCE does; confirm the change is intended' };
}

/** The dom-dom differ: preflight + the existing engine in explicit dom-dom mode. */
export function diffDomPair(reference: DomSnapshotOk, candidate: DomSnapshotOk, opts: { tolerancePx: number; maxDepth?: number }): DiffRow[] {
  const preflight = referencePreflight(reference);
  if (preflight.some((r) => r.prop === 'snapshot')) {
    return preflight;   // numbers over a broken baseline are worse than no numbers
  }
  const projected = domToSpecShape(reference);
  const engineOpts: DiffOptions = {
    tolerancePx: opts.tolerancePx,
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    sides: 'dom-dom',
    ...(reference.innerWidth !== undefined ? { frameWidth: reference.innerWidth } : {}),
  };
  const extraRows: DiffRow[] = [];
  // Reference-side radius honesty (wave finding 4): the candidate direction emits 'unchecked'
  // via the engine; the reference direction dropped the axis silently.
  if ((reference.styles as { borderRadiusUncomparable?: boolean } | undefined)?.borderRadiusUncomparable) {
    extraRows.push({ prop: 'corner-radius', status: 'unchecked',
      note: 'the REFERENCE radius is not comparable (non-uniform corners) - verify visually' });
  }
  // Non-uniform / partially-unparsed reference border: the Figma stroke model (one hex, one
  // weight) cannot express it, so the projection left strokeHex empty - say so instead of
  // letting the border axis fall back to the presence branch.
  if (projected.strokeUnprojectable) {
    // UNCHECKED, not info (receipt-lens finding 1): an axis the note says was not compared must
    // hold the done-gate - the corner-radius precedent; a divider changing color was green.
    extraRows.push({ prop: 'border-color', status: 'unchecked',
      note: 'the REFERENCE border is partial, non-uniform, or in a color space the extractor cannot read - the border axis was not compared; verify visually' });
  }
  const drift = fillTokenDrift(
    (reference.styles as { backgroundColorToken?: DomColorToken } | undefined)?.backgroundColorToken,
    (candidate.styles as { backgroundColorToken?: DomColorToken } | undefined)?.backgroundColorToken);
  return [...preflight, ...diffPair(projected, candidate, engineOpts), ...extraRows, ...(drift ? [drift] : [])];
}
