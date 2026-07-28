// Search a Figma node tree by name (token-AND substring or fuzzy) with an optional
// type filter. Generic over any node carrying id/name/type/children — RawSceneNode
// (find_nodes tool) and SimplifiedNode (compare_breakpoints) both qualify.
import Fuse from 'fuse.js';

export interface FindOptions {
  query?: string;
  type?: string;          // exact node type, case-insensitive (e.g. "TEXT")
  fuzzy?: boolean;        // typo-tolerant matching instead of substring
  limit: number;
  includeHidden?: boolean; // include nodes with visible === false
}

export type MatchedOn = 'name' | 'text' | 'type' | 'property';

export interface NodeMatch<T> {
  node: T;
  path: string[];         // ancestor names, root → parent (excludes the node itself)
  score: number;          // 0..1, higher = better
  matchedOn: MatchedOn;
}

type Node = {
  id: string; name: string; type: string;
  visible?: boolean; children?: Node[];
  characters?: string;    // RawSceneNode text content
  text?: string;          // SimplifiedNode text content
  componentProperties?: Record<string, { type: string; value: unknown }>; // instance overrides
};

function textOf(n: Node): string | undefined {
  return n.characters ?? n.text;
}

// Visible text of DS components (headers, labels, buttons) lives in instance
// property-overrides, not in characters. We index only TEXT-typed values.
function textOverrides(n: Node): string[] {
  const props = n.componentProperties;
  if (!props) return [];
  const out: string[] = [];
  for (const v of Object.values(props)) {
    if (v && v.type === 'TEXT' && typeof v.value === 'string') out.push(v.value);
  }
  return out;
}

// Whether every term is a substring of haystack (case handled by the caller).
const isFullMatch = (haystack: string, terms: string[]): boolean =>
  terms.every((t) => haystack.includes(t));

// The override value that matches every query term (for the tool's text preview), or undefined.
export function matchedOverrideText(
  node: { componentProperties?: Record<string, { type: string; value: unknown }> },
  query: string | undefined,
): string | undefined {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return undefined;
  for (const ov of textOverrides(node as Node)) {
    const lower = ov.toLowerCase();
    if (isFullMatch(lower, terms)) return ov;
  }
  return undefined;
}

// Preview value for a property match: the override matching every query term if present,
// otherwise the first TEXT override — so a fuzzy/typo property hit still surfaces a value.
export function overridePreview(
  node: { componentProperties?: Record<string, { type: string; value: unknown }> },
  query: string | undefined,
): string | undefined {
  return matchedOverrideText(node, query) ?? textOverrides(node as Node)[0];
}

// A purely-numeric query term skips text-content matching to avoid noise (e.g. "29" matching
// "- 29 items"); only the node name is checked for it. Short ALPHA terms ("OK") still match text.
function isNumericTerm(t: string): boolean {
  return /^\d+$/.test(t);
}

// Returns the best match for a node, or null. Full name match outranks full text match.
function scoreNode(n: Node, terms: string[]): { score: number; matchedOn: MatchedOn } | null {
  const name = n.name.toLowerCase();
  const nameHits = terms.filter((t) => name.includes(t)).length;
  if (nameHits === terms.length) return { score: 1, matchedOn: 'name' }; // full name → 1.0

  // Purely-numeric terms skip text matching entirely to avoid noise (e.g. "29" in "- 29 items")
  const hasNumericTerm = terms.some(isNumericTerm);
  if (!hasNumericTerm) {
    const body = textOf(n);
    if (body) {
      const lower = body.toLowerCase();
      // full text → 0.8; intentional: a full text match outranks a partial name match
      // ("name ranks above text" applies only when comparing full-name vs full-text)
      if (isFullMatch(lower, terms)) return { score: 0.8, matchedOn: 'text' };
    }

    // Instance TEXT overrides — same tier as full text (0.8). Skipped for numeric terms above.
    for (const ov of textOverrides(n)) {
      const lower = ov.toLowerCase();
      if (isFullMatch(lower, terms)) return { score: 0.8, matchedOn: 'property' };
    }
  }

  if (nameHits > 0) return { score: 0.5 * (nameHits / terms.length), matchedOn: 'name' }; // partial name → 0.5×fraction
  return null;
}

export function findNodes<T extends Node>(root: T, opts: FindOptions): NodeMatch<T>[] {
  const terms = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const typeFilter = opts.type?.toUpperCase();
  if (terms.length === 0 && !typeFilter) return []; // nothing to match on

  const candidates: { node: T; path: string[] }[] = [];
  const walk = (n: T, path: string[]): void => {
    if (n.visible === false && !opts.includeHidden) return;
    if (!typeFilter || n.type.toUpperCase() === typeFilter) candidates.push({ node: n, path });
    for (const c of (n.children ?? []) as T[]) walk(c, [...path, n.name]);
  };
  walk(root, []);

  // Type-only / scope-only search: no query terms → every type-passing node is a match.
  if (terms.length === 0) {
    return candidates
      .map((c) => ({ node: c.node, path: c.path, score: 1, matchedOn: 'type' as MatchedOn }))
      .sort((a, b) => a.node.id.localeCompare(b.node.id))
      .slice(0, opts.limit);
  }

  if (opts.fuzzy) {
    const fuse = new Fuse(candidates, {
      keys: [
        'node.name', 'node.characters', 'node.text',
        { name: 'overrideText', getFn: (c) => textOverrides((c as { node: Node }).node) },
      ],
      includeScore: true, includeMatches: true, threshold: 0.4, ignoreLocation: true,
    });
    return fuse.search(opts.query!)
      .map((r) => {
        // Attribute via Fuse's matched-key metadata (robust to typos, unlike a substring check).
        // Name outranks override outranks text when several keys matched.
        const keys = new Set((r.matches ?? []).map((mm) => mm.key));
        const matchedOn: MatchedOn =
          keys.has('node.name') ? 'name' : keys.has('overrideText') ? 'property' : 'text';
        return {
          node: r.item.node, path: r.item.path,
          score: Math.max(0, Math.min(1, 1 - (r.score ?? 1))),
          matchedOn,
        };
      })
      .slice(0, opts.limit);
  }

  const scored: NodeMatch<T>[] = [];
  for (const c of candidates) {
    const s = scoreNode(c.node, terms);
    if (s) scored.push({ node: c.node, path: c.path, score: s.score, matchedOn: s.matchedOn });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, opts.limit);
}
