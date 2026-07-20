// mcp-server/src/domain/design-system.ts
// Flattens a team's published library into a flat searchable index and does
// lexical (token-AND) search over name+description+page — mirroring Figma's own
// search_design_system, which the official guide describes as a name matcher, not
// semantic. pgvector embeddings are a future scale-up, not needed for MVP.
import type { RawTeamLibrary, PublishedComponent, PublishedStyle } from './figma-raw.js';

export type AssetKind = 'component' | 'component_set' | 'style';

export interface SearchableAsset {
  kind: AssetKind;
  key: string;
  name: string;
  description: string;
  style_type?: PublishedStyle['style_type'];
  page?: string;
  component_set?: string;
  library_file_key: string;
  node_id: string;
  thumbnail_url?: string;
  /** Source team id when assets are merged across multiple teams (mergeTeamLibraries). */
  team_id?: string;
}

function componentAsset(c: PublishedComponent, kind: AssetKind): SearchableAsset {
  return {
    kind,
    key: c.key,
    name: c.name,
    description: c.description ?? '',
    page: c.containing_frame?.pageName,
    component_set: c.containing_frame?.containingComponentSet?.name,
    library_file_key: c.file_key,
    node_id: c.node_id,
    ...(c.thumbnail_url !== undefined ? { thumbnail_url: c.thumbnail_url } : {}),
  };
}

export function toSearchableAssets(lib: RawTeamLibrary): SearchableAsset[] {
  return [
    ...lib.components.map((c) => componentAsset(c, 'component')),
    ...lib.componentSets.map((c) => componentAsset(c, 'component_set')),
    ...lib.styles.map((s) => ({
      kind: 'style' as const,
      key: s.key,
      name: s.name,
      description: s.description ?? '',
      style_type: s.style_type,
      library_file_key: s.file_key,
      node_id: s.node_id,
    })),
  ];
}

/** Flatten several teams' libraries into one searchable list, tagging each asset with its
 * source team_id and deduping identical assets (same kind+key) that appear in multiple teams. */
export function mergeTeamLibraries(libs: { teamId: string; lib: RawTeamLibrary }[]): SearchableAsset[] {
  const out: SearchableAsset[] = [];
  const seen = new Set<string>();
  for (const { teamId, lib } of libs) {
    for (const a of toSearchableAssets(lib)) {
      const k = `${a.kind}\0${a.key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...a, team_id: teamId });
    }
  }
  return out;
}

/** Narrow assets to those defined in the given library file keys. An empty set means "no
 * narrowing signal" (e.g. consumed-library detection found nothing) → return assets unchanged
 * rather than wiping the result. */
export function filterByLibraryFileKeys(assets: SearchableAsset[], fileKeys: Set<string>): SearchableAsset[] {
  if (fileKeys.size === 0) return assets;
  return assets.filter((a) => fileKeys.has(a.library_file_key));
}

function scoreAsset(asset: SearchableAsset, tokens: string[]): number {
  const name = asset.name.toLowerCase();
  const haystacks = [name, asset.description.toLowerCase(), (asset.page ?? '').toLowerCase(), (asset.component_set ?? '').toLowerCase()];
  let score = 0;
  for (const t of tokens) {
    if (!haystacks.some((h) => h.includes(t))) return -1; // AND: every token must match somewhere
    if (name.includes(t)) score += 3;
    else score += 1;
  }
  if (name === tokens.join(' ')) score += 5;        // exact full-name match (covers single-token too)
  return score;
}

const KIND_RANK: Record<AssetKind, number> = { component_set: 0, component: 1, style: 2 };

export function searchAssets(assets: SearchableAsset[], query: string, limit: number): SearchableAsset[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const seen = new Set<string>();
  return assets
    .map((a) => ({ a, s: scoreAsset(a, tokens) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s || KIND_RANK[x.a.kind] - KIND_RANK[y.a.kind] || x.a.name.length - y.a.name.length)
    .filter((x) => {
      const dedupeKey = `${x.a.kind}\0${x.a.name.toLowerCase()}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .slice(0, limit)
    .map((x) => x.a);
}
