// mcp-server/src/domain/design-context/simplify.ts
// Walks a raw Figma node tree into a descriptive SimplifiedNode tree, interning
// repeated style values into a GlobalVarStore. Descriptive (not prescriptive):
// we report what is drawn, not how to build it — the agent maps it to its own
// code conventions. Variable-name resolution for bound props is layered on top
// by the design-context tool, not here.
import type { RawSceneNode, RawPaint } from '../figma-raw.js';
import { rgbaToHex, parseGradient, type Gradient } from './color.js';
import { GlobalVarStore } from './global-vars.js';
import type { SimplifiedNode } from './types.js';
import type { ResolvedToken } from './resolved-token.js';

const LAYOUT_MODE: Record<string, 'row' | 'col'> = { HORIZONTAL: 'row', VERTICAL: 'col' };

export interface SimplifyOptions {
  // Given a node's boundVariables and a property key, return a token name to use
  // instead of the interned raw value (e.g. 'color/brand/primary' for fills).
  resolveToken?: (boundVariables: RawSceneNode['boundVariables'], key: string) => string | null;
  // Cross-library fallback (multi-tenant): when resolveToken cannot name the bound
  // variable (it lives in an external library, absent from the local index), return
  // its snapshotted hex value. Consulted only after resolveToken returns null, and
  // still preferred over the raw paint hex. Synchronous: the tool pre-fetches the
  // snapshot and passes a plain map lookup here so the walk stays sync.
  resolveSnapshot?: (boundVariables: RawSceneNode['boundVariables'], key: string) => string | null;
  // Mode-aware resolver (local + cross-library). Gets the whole node (node- AND paint-level
  // bindings + node.id for the mode stack); returns a ResolvedToken to intern, or null.
  resolveTokenMode?: (node: RawSceneNode, key: 'fills' | 'strokes') => ResolvedToken | null;
  // nodeId -> count of visible children that existed one level below the depth the caller actually
  // wants rendered. The caller (get_design_context) fetches one level deeper than requested SO IT
  // CAN tell a depth-cut container from a genuinely empty one, then prunes that extra level away and
  // records the cut count here BEFORE calling simplify — so `raw` passed to simplify is already at
  // the requested depth (every boundary node has no `children` of its own). A node present in this
  // map is marked truncated + childCount from the recorded count; simplify never re-derives the
  // count from raw.children (there isn't one to derive from — it was pruned by the caller).
  truncatedChildCounts?: Map<string, number>;
}

export function paintValue(paints: RawPaint[] | undefined): string | Gradient | null {
  if (!paints) return null;
  const solid = paints.find((x) => x.visible !== false && x.type === 'SOLID' && x.color);
  if (solid?.color) return rgbaToHex({ ...solid.color, a: (solid.color.a ?? 1) * (solid.opacity ?? 1) });
  const any = paints.find((x) => x.visible !== false);
  if (!any) return null;
  return parseGradient(any) ?? any.type;
}

function simplifyNode(raw: RawSceneNode, gv: GlobalVarStore, opts: SimplifyOptions): SimplifiedNode {
  const node: SimplifiedNode = { id: raw.id, name: raw.name, type: raw.type };

  const box = raw.absoluteBoundingBox;
  if (box) node.size = { w: box.width, h: box.height };

  if (raw.layoutMode && raw.layoutMode !== 'NONE') {
    node.layout = { mode: LAYOUT_MODE[raw.layoutMode] };
    if (raw.itemSpacing !== undefined) node.layout.gap = raw.itemSpacing;
    const pads = [raw.paddingTop, raw.paddingRight, raw.paddingBottom, raw.paddingLeft];
    if (pads.some((p) => p !== undefined)) node.layout.padding = pads.map((p) => p ?? 0).join(' ');
    if (raw.primaryAxisAlignItems) node.layout.primaryAlign = raw.primaryAxisAlignItems;
    if (raw.counterAxisAlignItems) node.layout.counterAlign = raw.counterAxisAlignItems;
    if (raw.minWidth != null) node.layout.minW = raw.minWidth;
    if (raw.maxWidth != null) node.layout.maxW = raw.maxWidth;
    if (raw.minHeight != null) node.layout.minH = raw.minHeight;
    if (raw.maxHeight != null) node.layout.maxH = raw.maxHeight;
  }

  // Resolution order per property: mode-aware token OBJECT → local token NAME →
  // cross-library snapshot HEX → raw paint hex.
  const fillTok = opts.resolveTokenMode?.(raw, 'fills') ?? null;
  const fillName = fillTok ? null : (opts.resolveToken?.(raw.boundVariables, 'fills') ?? opts.resolveSnapshot?.(raw.boundVariables, 'fills'));
  const fill = paintValue(raw.fills);
  if (fillTok) node.fill = gv.intern('fill', fillTok);
  else if (fillName) node.fill = fillName;          // token name / snapshot hex wins over raw hex
  else if (fill) node.fill = gv.intern('fill', fill);

  const strokeTok = opts.resolveTokenMode?.(raw, 'strokes') ?? null;
  const strokeName = strokeTok ? null : (opts.resolveToken?.(raw.boundVariables, 'strokes') ?? opts.resolveSnapshot?.(raw.boundVariables, 'strokes'));
  const stroke = paintValue(raw.strokes);
  if (strokeTok) { node.stroke = gv.intern('fill', strokeTok); if (raw.strokeWeight) node.strokeWeight = raw.strokeWeight; }
  else if (strokeName) { node.stroke = strokeName; if (raw.strokeWeight) node.strokeWeight = raw.strokeWeight; }
  else if (stroke) { node.stroke = gv.intern('fill', stroke); if (raw.strokeWeight) node.strokeWeight = raw.strokeWeight; }

  if (raw.cornerRadius !== undefined) node.cornerRadius = raw.cornerRadius;
  if (raw.opacity !== undefined && raw.opacity < 1) node.opacity = raw.opacity;

  if (raw.effects && raw.effects.some((e) => e.visible !== false)) {
    node.effects = gv.intern('effect', raw.effects.filter((e) => e.visible !== false).map((e) => ({
      type: e.type, radius: e.radius, color: e.color ? rgbaToHex(e.color) : undefined, offset: e.offset,
    })));
  }

  if (typeof raw.characters === 'string') {
    node.text = raw.characters;
    if (raw.style) node.textStyle = gv.intern('text', {
      ...(raw.style.styleName ? { styleName: raw.style.styleName } : {}),
      fontFamily: raw.style.fontFamily, fontWeight: raw.style.fontWeight,
      fontSize: raw.style.fontSize, lineHeightPx: raw.style.lineHeightPx,
      letterSpacing: raw.style.letterSpacing, align: raw.style.textAlignHorizontal,
    });
  }

  if (raw.componentId) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.componentProperties ?? {})) {
      props[k.replace(/#[0-9:]*/g, '')] = (v as { value: unknown }).value;
    }
    node.component = { id: raw.componentId, ...(Object.keys(props).length ? { props } : {}) };
  }

  const kids = (raw.children ?? []).filter((c) => c.visible !== false);
  if (kids.length) node.children = kids.map((c) => simplifyNode(c, gv, opts));

  // Depth-boundary truncation signal: the caller already pruned this node's children away (if any
  // were cut) and recorded the visible count here, so this purely trusts the map — it never
  // re-derives the count from raw.children.
  const cutCount = opts.truncatedChildCounts?.get(raw.id);
  if (cutCount !== undefined) { node.truncated = true; node.childCount = cutCount; }

  return node;
}

export function simplify(raw: RawSceneNode, opts: SimplifyOptions = {}): { node: SimplifiedNode; globalVars: Record<string, unknown> } {
  const gv = new GlobalVarStore();
  const node = simplifyNode(raw, gv, opts);
  return { node, globalVars: gv.dump() };
}
