// Collect typography from an already-simplified subtree. Routes through simplify()'s
// output (SimplifiedNode + globalVars) so the killer-feature textStyle shape and the
// token/hex resolution are preserved. Inlines the resolved style object (never a bare
// ref) so callers don't depend on globalVars.
import type { SimplifiedNode } from './design-context/types.js';
import { findNodes } from './find-nodes.js';

export interface TextStyleHit {
  node_id: string;
  name: string;
  path: string[];
  text?: string;
  textStyle: Record<string, unknown>;
  fill?: unknown; // inlined color (hex or token name) — present only when includeColor
}

export interface GroupedTextStyle {
  textStyle: Record<string, unknown>;
  fill?: unknown;
  nodes: { node_id: string; name: string; path: string[]; text?: string }[];
}

const TEXT_PREVIEW = 80;

function inline(ref: string | undefined, globalVars: Record<string, unknown>): unknown {
  if (ref === undefined) return undefined;
  // fill may be a globalVars ref (fill_0) OR already a token name / var() string.
  return ref in globalVars ? globalVars[ref] : ref;
}

export function collectTextStyles(
  root: SimplifiedNode,
  globalVars: Record<string, unknown>,
  opts: { includeColor?: boolean } = {},
): TextStyleHit[] {
  const hits: TextStyleHit[] = [];
  const walk = (n: SimplifiedNode, path: string[]): void => {
    if (n.textStyle) {
      const resolved = globalVars[n.textStyle];
      const text = n.text !== undefined
        ? (n.text.length > TEXT_PREVIEW ? n.text.slice(0, TEXT_PREVIEW) + '…' : n.text)
        : undefined;
      const hit: TextStyleHit = {
        node_id: n.id, name: n.name, path,
        textStyle: (resolved && typeof resolved === 'object' ? resolved : { ref: n.textStyle }) as Record<string, unknown>,
      };
      if (text !== undefined) hit.text = text;
      if (opts.includeColor && n.fill) {
        const c = inline(n.fill, globalVars);
        if (c !== undefined) hit.fill = c;
      }
      hits.push(hit);
    }
    for (const c of n.children ?? []) walk(c, [...path, n.name]);
  };
  walk(root, []);
  return hits;
}

export function dedupeTextStyles(hits: TextStyleHit[]): GroupedTextStyle[] {
  const groups = new Map<string, GroupedTextStyle>();
  for (const h of hits) {
    const key = JSON.stringify([h.textStyle, h.fill ?? null]);
    let g = groups.get(key);
    if (!g) {
      g = { textStyle: h.textStyle, nodes: [] };
      if (h.fill !== undefined) g.fill = h.fill;
      groups.set(key, g);
    }
    const node: GroupedTextStyle['nodes'][number] = { node_id: h.node_id, name: h.name, path: h.path };
    if (h.text !== undefined) node.text = h.text;
    g.nodes.push(node);
  }
  return [...groups.values()];
}

// For compare_breakpoints: the text-style of the first node matching `name` within a frame.
export function styleForName(
  frame: SimplifiedNode,
  globalVars: Record<string, unknown>,
  name: string,
  opts: { fuzzy?: boolean; includeColor?: boolean } = {},
): TextStyleHit | null {
  const matches = findNodes(frame, { query: name, fuzzy: opts.fuzzy ?? false, limit: 1 });
  if (!matches.length) return null;
  const within = collectTextStyles(matches[0].node, globalVars, { includeColor: opts.includeColor });
  return within[0] ?? null;
}
