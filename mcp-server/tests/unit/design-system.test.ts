import { describe, it, expect } from 'vitest';
import { toSearchableAssets, searchAssets, mergeTeamLibraries, filterByLibraryFileKeys } from '../../src/domain/design-system.js';
import type { RawTeamLibrary } from '../../src/domain/figma-raw.js';
import type { SearchableAsset } from '../../src/domain/design-system.js';

const lib: RawTeamLibrary = {
  components: [
    { key: 'c1', file_key: 'F', node_id: '1:1', name: 'Button', description: 'Primary call to action', containing_frame: { pageName: 'Actions' } },
    { key: 'c2', file_key: 'F', node_id: '1:2', name: 'IconButton', description: 'Button with an icon only' },
  ],
  componentSets: [
    { key: 's1', file_key: 'F', node_id: '2:1', name: 'Toast', description: 'Notification toast' },
  ],
  styles: [
    { key: 'st1', file_key: 'F', node_id: '3:1', name: 'color/brand/primary', description: '', style_type: 'FILL' },
  ],
};

describe('toSearchableAssets', () => {
  it('flattens components, sets, styles with kind + library_file_key + page', () => {
    const assets = toSearchableAssets(lib);
    expect(assets).toHaveLength(4);
    const button = assets.find((a) => a.name === 'Button')!;
    expect(button.kind).toBe('component');
    expect(button.library_file_key).toBe('F');
    expect(button.page).toBe('Actions');
    expect(assets.find((a) => a.name === 'Toast')!.kind).toBe('component_set');
    expect(assets.find((a) => a.name === 'color/brand/primary')!.kind).toBe('style');
  });
});

describe('searchAssets', () => {
  const assets = toSearchableAssets(lib);
  it('matches by name token, ranks exact/name hits above description hits', () => {
    const res = searchAssets(assets, 'button', 10);
    expect(res[0].name).toBe('Button');
    expect(res.map((r) => r.name)).toContain('IconButton');
  });
  it('AND semantics: all space-separated tokens must match', () => {
    expect(searchAssets(assets, 'icon button', 10).map((r) => r.name)).toEqual(['IconButton']);
    expect(searchAssets(assets, 'button toast', 10)).toEqual([]);
  });
  it('matches description and is case-insensitive', () => {
    expect(searchAssets(assets, 'NOTIFICATION', 10).map((r) => r.name)).toEqual(['Toast']);
  });
  it('respects limit', () => {
    expect(searchAssets(assets, 'b', 1).length).toBeLessThanOrEqual(1);
  });
  it('returns [] for no match', () => {
    expect(searchAssets(assets, 'zzzznotfound', 10)).toEqual([]);
  });
});

describe('searchAssets priority, dedup, thumbnail', () => {
  it('component_set ranks above component at equal relevance', () => {
    const assets: SearchableAsset[] = [
      { kind: 'component',     key: 'c1', name: 'Toast', description: '', library_file_key: 'F', node_id: '1:1' },
      { kind: 'component_set', key: 's1', name: 'Toast', description: '', library_file_key: 'F', node_id: '2:1' },
    ];
    const res = searchAssets(assets, 'Toast', 10);
    expect(res[0].kind).toBe('component_set');
  });

  it('deduplicates by (kind, name) keeping first (highest-ranked)', () => {
    const assets: SearchableAsset[] = [
      { kind: 'component', key: 'c1', name: 'Button', description: '', library_file_key: 'F1', node_id: '1:1' },
      { kind: 'component', key: 'c2', name: 'Button', description: '', library_file_key: 'F2', node_id: '1:2' },
    ];
    const res = searchAssets(assets, 'Button', 10);
    expect(res).toHaveLength(1);
    expect(res[0].key).toBe('c1');
  });

  it('carries thumbnail_url into searchable assets', () => {
    const libWithThumbnail: RawTeamLibrary = {
      components: [{ key: 'c1', file_key: 'F', node_id: '1:1', name: 'Card', description: '', thumbnail_url: 'https://cdn.example.com/thumb.png' }],
      componentSets: [],
      styles: [],
    };
    const assets = toSearchableAssets(libWithThumbnail);
    expect(assets[0].thumbnail_url).toBe('https://cdn.example.com/thumb.png');
  });
});

describe('mergeTeamLibraries', () => {
  it('tags each asset with its source team_id and dedupes by (kind,key) across teams', () => {
    const libA: RawTeamLibrary = { components: [{ key: 'c1', file_key: 'L', node_id: '1:1', name: 'Button', description: '' }], componentSets: [], styles: [] };
    const libB: RawTeamLibrary = { components: [{ key: 'c1', file_key: 'L', node_id: '1:1', name: 'Button', description: '' }, { key: 'c2', file_key: 'L', node_id: '1:2', name: 'Card', description: '' }], componentSets: [], styles: [] };
    const merged = mergeTeamLibraries([{ teamId: 'T1', lib: libA }, { teamId: 'T2', lib: libB }]);
    expect(merged.filter((a) => a.key === 'c1')).toHaveLength(1); // c1 in both → deduped
    expect(merged.find((a) => a.key === 'c1')!.team_id).toBe('T1'); // first team wins
    expect(merged.find((a) => a.key === 'c2')!.team_id).toBe('T2');
  });
});

describe('filterByLibraryFileKeys', () => {
  const assets: SearchableAsset[] = [
    { kind: 'component', key: 'a', name: 'A', description: '', library_file_key: 'libX', node_id: '1:1' },
    { kind: 'component', key: 'b', name: 'B', description: '', library_file_key: 'libY', node_id: '2:1' },
  ];
  it('keeps only assets whose library_file_key is in the set', () => {
    expect(filterByLibraryFileKeys(assets, new Set(['libX'])).map((a) => a.name)).toEqual(['A']);
  });
  it('returns all assets unchanged when the set is empty (no narrowing signal)', () => {
    expect(filterByLibraryFileKeys(assets, new Set())).toHaveLength(2);
  });
});
